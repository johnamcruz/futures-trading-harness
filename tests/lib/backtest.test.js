'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SimBroker, marketOpen } = require('../../scripts/lib/backtest/broker');
const { aggregate, loadBars, parseCsv } = require('../../scripts/lib/backtest/data');
const { roundTrips, stats } = require('../../scripts/lib/backtest/report');
const { runBacktest, backtestEnv } = require('../../scripts/lib/backtest/run');
const { installSimClock } = require('../../scripts/lib/sim-clock');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const CONTRACT = 'CON.F.US.MNQ.H25';
// Monday 2025-03-10 09:00 ET (EDT, UTC-4).
const T0 = Date.parse('2025-03-10T13:00:00Z');

/** 1-minute bars from a list of [o, h, l, c] starting at `start`. */
function bars(rows, start = T0) {
  return rows.map(([o, h, l, c], i) => ({ t: new Date(start + i * 60000).toISOString(), ms: start + i * 60000, o, h, l, c, v: 10 }));
}

function broker(rows, opts = {}) {
  return new SimBroker({ instruments: [{ symbol: 'MNQ', contractId: CONTRACT, tickSize: 0.25, tickValue: 0.5, bars: bars(rows) }], startMs: T0 + 60000, slippageTicks: 0, feesPerSide: 0, ...opts });
}

const flat = (n, p = 100) => Array.from({ length: n }, () => [p, p, p, p]);

test('aggregate builds closed N-minute bars and hides the forming one', () => {
  const b = bars([[1, 2, 0, 1], [1, 3, 1, 2], [2, 2, 1, 1.5], [1.5, 4, 1, 3]]);
  const three = aggregate(b, { unit: 2, unitNumber: 3, nowMs: T0 + 4 * 60000 });
  assert.deepStrictEqual(three, [{ t: new Date(T0).toISOString(), o: 1, h: 3, l: 0, c: 1.5, v: 30 }]);
  assert.strictEqual(aggregate(b, { unit: 2, unitNumber: 3, nowMs: T0 + 4 * 60000, includePartial: true }).length, 2);
  assert.strictEqual(aggregate(b, { unit: 2, unitNumber: 1, nowMs: T0 + 2 * 60000 + 59999 }).length, 2, 'a 1-minute bar is visible only after it closes');
  assert.throws(() => aggregate(b, { unit: 5, unitNumber: 1, nowMs: T0 + 1e7 }), /not available in a backtest/);
});

test('CSV loading accepts common headers and rejects non-minute data', () => {
  const rows = parseCsv('timestamp,open,high,low,close,volume\n2025-03-10 13:00:00,1,2,0,1,5\n1741611660,1,2,0,1.5,6\n');
  assert.deepStrictEqual(rows.map(r => r.t), ['2025-03-10T13:00:00.000Z', '2025-03-10T13:01:00.000Z']);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.csv'), 'time,open,high,low,close\n2025-03-10T13:00:30Z,1,1,1,1\n');
  assert.throws(() => loadBars(path.join(dir, 'a.csv')), /minute boundary/);
});

test('market orders fill at the last close plus slippage; brackets become an OCO pair', () => {
  const b = broker([[100, 100, 100, 100], [100, 101, 99.5, 100.5], [100.5, 103, 100, 102.5], ...flat(3, 102.5)], { slippageTicks: 1 });
  const r = b.handle('/api/Order/place', { accountId: 1, contractId: CONTRACT, type: 2, side: 0, size: 1, stopLossBracket: { ticks: 8, type: 4 }, takeProfitBracket: { ticks: 8, type: 1 } });
  assert.strictEqual(r.success, true);
  assert.strictEqual(b.positionsView()[0].averagePrice, 100.25, 'close 100 + 1 tick');
  b.advanceTo(T0 + 3 * 60000);
  assert.deepStrictEqual(b.positionsView(), [], 'target 102.25 traded through on the third bar');
  assert.strictEqual(b.trades[1].profitAndLoss, 4, '8 ticks x $0.50');
  assert.ok(b.handle('/api/Order/searchOpen', { accountId: 1 }).orders.length === 0, 'the stop leg is cancelled');
});

test('a bar touching both bracket legs is scored as the stop (pessimistic)', () => {
  const b = broker([[100, 100, 100, 100], [100, 103, 97, 100], ...flat(2)]);
  b.handle('/api/Order/place', { accountId: 1, contractId: CONTRACT, type: 2, side: 0, size: 1, stopLossBracket: { ticks: 8, type: 4 }, takeProfitBracket: { ticks: 8, type: 1 } });
  b.advanceTo(T0 + 2 * 60000);
  assert.strictEqual(b.trades[1].price, 98);
  assert.ok(b.trades[1].profitAndLoss < 0);
});

test('stops fill at the worse of the stop and the open; limits need a trade through', () => {
  const b = broker([[100, 100, 100, 100], [95, 96, 94, 95], [95, 96, 94, 95], [94.5, 95, 93.5, 94], ...flat(2)]);
  b.handle('/api/Order/place', { accountId: 1, contractId: CONTRACT, type: 2, side: 0, size: 1 });
  b.handle('/api/Order/place', { accountId: 1, contractId: CONTRACT, type: 4, side: 1, size: 1, stopPrice: 98 });
  b.advanceTo(T0 + 2 * 60000);
  assert.strictEqual(b.trades[1].price, 95, 'gap through the stop fills at the open');
  const lim = b.handle('/api/Order/place', { accountId: 1, contractId: CONTRACT, type: 1, side: 0, size: 1, limitPrice: 94 });
  assert.ok(lim.success);
  b.advanceTo(T0 + 3 * 60000);
  assert.strictEqual(b.positionsView().length, 0, 'low 94 touches the limit but does not trade through');
  b.advanceTo(T0 + 4 * 60000);
  assert.strictEqual(b.positionsView()[0].averagePrice, 94, 'low 93.5 trades through');
});

test('wrong-side stops, closed market, and unknown accounts are refused like the API', () => {
  const b = broker(flat(5));
  assert.match(b.handle('/api/Order/place', { accountId: 1, contractId: CONTRACT, type: 4, side: 0, size: 1, stopPrice: 99 }).errorMessage, /above the market/);
  assert.strictEqual(b.handle('/api/Order/place', { accountId: 9, contractId: CONTRACT, type: 2, side: 0, size: 1 }).errorCode, 1);
  assert.strictEqual(marketOpen(Date.parse('2025-03-10T21:30:00Z')), false, '17:30 ET');
  assert.strictEqual(marketOpen(Date.parse('2025-03-09T21:59:00Z')), false, 'Sunday 17:59 ET');
  assert.strictEqual(marketOpen(Date.parse('2025-03-09T22:00:00Z')), true, 'Sunday 18:00 ET');
});

test('flips realize P&L on the closed part and open the rest at the fill price', () => {
  const b = broker([[100, 100, 100, 100], [110, 110, 110, 110], ...flat(2, 110)]);
  b.handle('/api/Order/place', { accountId: 1, contractId: CONTRACT, type: 2, side: 0, size: 1 });
  b.advanceTo(T0 + 2 * 60000);
  b.handle('/api/Order/place', { accountId: 1, contractId: CONTRACT, type: 2, side: 1, size: 2 });
  assert.strictEqual(b.trades[1].profitAndLoss, 20, '10 points x $2');
  assert.deepStrictEqual(b.positionsView().map(p => [p.type, p.size, p.averagePrice]), [[2, 1, 110]]);
});

test('daily loss limit flattens and locks the account until the next trading day', () => {
  const rows = [[100, 100, 100, 100], [100, 100, 80, 80], ...flat(3, 80)];
  const b = broker(rows, { dailyLossLimit: 30 });
  b.handle('/api/Order/place', { accountId: 1, contractId: CONTRACT, type: 2, side: 0, size: 1 });
  b.advanceTo(T0 + 3 * 60000);
  assert.deepStrictEqual(b.positionsView(), []);
  assert.strictEqual(b.accountView().canTrade, false);
  assert.strictEqual(b.handle('/api/Order/place', { accountId: 1, contractId: CONTRACT, type: 2, side: 0, size: 1 }).errorCode, 4);
});

test('round trips attribute P&L to the setup that opened them', () => {
  const trades = [
    { contractId: 'C', side: 0, size: 1, price: 100, profitAndLoss: null, fees: 0.37, orderId: 1, creationTimestamp: 'a' },
    { contractId: 'C', side: 1, size: 1, price: 104, profitAndLoss: 8, fees: 0.37, orderId: 2, creationTimestamp: 'b' },
    { contractId: 'C', side: 1, size: 1, price: 104, profitAndLoss: null, fees: 0.37, orderId: 3, creationTimestamp: 'c' },
    { contractId: 'C', side: 0, size: 1, price: 106, profitAndLoss: -4, fees: 0.37, orderId: 4, creationTimestamp: 'd' },
  ];
  const { closed } = roundTrips(trades, new Map([[1, 'orb'], [3, 'bos']]));
  assert.deepStrictEqual(closed.map(r => [r.setup, r.direction, r.netPnL]), [['orb', 'long', 7.26], ['bos', 'short', -4.74]]);
  assert.strictEqual(stats(closed).profitFactor, 1.53);
});

test('the simulated clock only installs in backtest mode with a loopback broker', () => {
  assert.strictEqual(installSimClock({ FTH_SIM_CLOCK_FILE: '/x' }), false);
  assert.strictEqual(installSimClock({ FTH_BACKTEST: '1', FTH_SIM_API_URL: 'https://api.topstepx.com', FTH_SIM_CLOCK_FILE: '/x' }), false);
  const env = backtestEnv({ PROJECTX_API_KEY: 'secret', PROJECTX_USERNAME: 'me', PROJECTX_MAX_ORDER_SIZE: '1' }, { url: 'http://127.0.0.1:1', home: '/h', clockFile: '/c' });
  assert.strictEqual(env.PROJECTX_API_KEY, 'backtest', 'real credentials never reach a backtest');
  assert.strictEqual(env.PROJECTX_MAX_ORDER_SIZE, '1', 'guardrails carry over');
});

test('a full replay drives the real runner on simulated time and reports the result', { timeout: 120000 }, async () => {
  const dir = tmpDir();
  // 08:00-12:00 ET of gently rising prices with a dip every 15 minutes.
  const start = Date.parse('2025-03-10T12:00:00Z');
  const rows = Array.from({ length: 240 }, (_, i) => {
    const c = 20000 + i * 0.5 - (i % 15 === 7 ? 6 : 0);
    return [c - 0.25, c + 1, c - 1.5, c];
  });
  fs.writeFileSync(path.join(dir, 'mnq.json'), JSON.stringify(bars(rows, start).map(({ ms: _ms, ...b }) => b)));
  const config = {
    harness: 'custom',
    command: ['node', path.join(ROOT, 'tests', 'fixtures', 'backtest-agent.js'), '{prompt}'],
    symbols: ['MNQ'],
    timeframe: 3,
    sessions: ['10:00-11:00@America/New_York'],
    premarketAt: '09:30@America/New_York',
    eodAt: '11:30@America/New_York',
    backtest: {
      start: '2025-03-10T13:20:00Z', end: '2025-03-10T15:45:00Z', latency: 'none', outDir: path.join(dir, 'run'),
      instruments: { MNQ: { data: 'mnq.json', contractId: CONTRACT } },
    },
  };
  const { report, runDir } = await runBacktest(config, { root: ROOT, baseDir: dir });
  const seen = fs.readFileSync(path.join(runDir, 'home', 'agent-seen.log'), 'utf8').trim().split('\n');
  const trades = seen.filter(l => l.endsWith(' trade'));
  assert.ok(trades.length >= 18 && trades.length <= 21, `one cycle per closed 3m bar in the hour, got ${trades.length}`);
  assert.ok(seen.every(l => l.startsWith('2025-03-10T1')), 'the agent saw simulated time');
  assert.match(trades[0], /^2025-03-10T14:00:0\d/, 'first cycle within seconds of the 10:00 ET open');
  assert.ok(seen.some(l => l.endsWith(' eod')));
  assert.ok(report.summary.trades > 0, 'the agent traded');
  assert.strictEqual(report.summary.openAtEnd, 0);
  assert.strictEqual(report.summary.cycles.failed, 0);
  assert.ok(fs.existsSync(path.join(runDir, 'report.md')));
  assert.deepStrictEqual(Object.keys(report.bySetup), ['fake']);
});

test('FTH_HOME moves all harness state; loopback detection', () => {
  const { harnessHome, isLoopbackUrl, backtestMode } = require('../../scripts/lib/paths');
  assert.strictEqual(harnessHome({}, '/h'), '/h/.futures-trading-harness');
  assert.strictEqual(harnessHome({ FTH_HOME: '~/bt' }, '/h'), '/h/bt');
  assert.strictEqual(isLoopbackUrl('http://127.0.0.1:5'), true);
  assert.strictEqual(isLoopbackUrl('http://127.0.0.1.evil.com'), false);
  assert.strictEqual(backtestMode({ FTH_BACKTEST: '1', FTH_SIM_API_URL: 'http://localhost:9' }), true);
  const { loadConfig } = require('../../scripts/lib/trading/config');
  assert.strictEqual(loadConfig({ FTH_HOME: '/tmp/x' }).killSwitchFile, '/tmp/x/STOP');
});

test('runHarness resolves when the run exits even if a detached process keeps its output open', { timeout: 20000 }, async () => {
  const { runHarness } = require('../../scripts/lib/harness-run');
  const t = Date.now();
  const r = await runHarness(['sh', '-c', 'setsid sleep 8 & echo hi; exit 0'], { cwd: ROOT, env: process.env, timeoutMs: 5000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.timedOut, false);
  assert.ok(Date.now() - t < 4000, `took ${Date.now() - t} ms`);
  assert.match(r.output, /hi/);
});
