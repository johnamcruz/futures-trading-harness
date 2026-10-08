'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadBars, aggregate, barMinutes, epochMs, parseCsv } = require('../../scripts/lib/backtest/data');
const { excelSerialToMs } = require('../../scripts/lib/backtest/xlsx');
const { trailStep, snapStop } = require('../../scripts/lib/trading/trail');
const { runEngine } = require('../../scripts/lib/backtest/engine');
const { runBacktest, validateBacktestConfig } = require('../../scripts/lib/backtest/run');
const { stats, maxDrawdown } = require('../../scripts/lib/backtest/report');
const { compileRules } = require('../../scripts/lib/trading/rules');
const { loadConfig } = require('../../scripts/lib/trading/config');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(__dirname, '..', 'fixtures', 'data');

test('Parquet (pyarrow, pandas, polars, fastparquet; every codec and encoding) and Excel load the same bars as CSV', () => {
  const ref = loadBars(path.join(DATA, 'bars.csv'));
  assert.strictEqual(ref.length, 300);
  // ZSTD needs zlib.zstdDecompressSync (Node 22.15+): older Node says so instead of misreading the file.
  const zstd = typeof require('zlib').zstdDecompressSync === 'function';
  for (const f of fs.readdirSync(DATA).filter(x => x !== 'bars.csv')) {
    let bars;
    try {
      bars = loadBars(path.join(DATA, f));
    } catch (err) {
      if (!zstd && /ZSTD needs Node 22\.15\+/.test(err.message)) continue;
      throw err;
    }
    if (f === 'pyarrow-nulls.parquet') {
      assert.strictEqual(bars[5].v, 0, 'a missing volume reads as 0');
      assert.deepStrictEqual({ ...bars[5], v: ref[5].v }, ref[5]);
      continue;
    }
    assert.deepStrictEqual(bars, ref, f);
  }
});

test('times: ISO, naive UTC, epoch units, Excel serials; legacy .xls is refused', () => {
  assert.strictEqual(epochMs(1741611600), 1741611600000);
  assert.strictEqual(epochMs(1741611600000), 1741611600000);
  assert.strictEqual(epochMs(1741611600000000), 1741611600000);
  assert.strictEqual(epochMs(1741611600000000000), 1741611600000);
  assert.strictEqual(new Date(excelSerialToMs(45726.5625)).toISOString(), '2025-03-10T13:30:00.000Z');
  assert.strictEqual(parseCsv('Date,Open,High,Low,Close\n2025-03-10 13:30:00,1,2,0,1\n')[0].t, '2025-03-10T13:30:00.000Z');
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'old.xls'), 'x');
  assert.throws(() => loadBars(path.join(dir, 'old.xls')), /save it as .xlsx/);
});

test('aggregate builds closed N-minute bars from finer bars', () => {
  const t0 = Date.parse('2025-03-10T13:30:00Z');
  const one = [[1, 2, 0, 1], [1, 3, 1, 2], [2, 2, 1, 1.5], [1.5, 4, 1, 3]].map(([o, h, l, c], i) => ({ t: new Date(t0 + i * 60000).toISOString(), ms: t0 + i * 60000, o, h, l, c, v: 10 }));
  assert.strictEqual(barMinutes(one), 1);
  const three = aggregate(one, { unit: 2, unitNumber: 3, nowMs: t0 + 4 * 60000 });
  assert.deepStrictEqual(three, [{ t: new Date(t0).toISOString(), o: 1, h: 3, l: 0, c: 1.5, v: 30 }]);
});

test('trailing stop: holds until +2R, then 0.5R behind the best price, ratchet only, tick-snapped', () => {
  const plan = { trailActivateR: 2, trailGivebackR: 0.5 };
  const long = { sign: 1, entry: 100, risk: 2, stop: 98, peakR: 0 };
  let r = trailStep(long, { h: 103.9, l: 101, c: 103 }, plan, 0.25);
  assert.deepStrictEqual([r.stop, r.active, r.close], [98, false, null], '1.95R: not active yet');
  r = trailStep({ ...long, peakR: r.peakR }, { h: 106, l: 105.2, c: 105.5 }, plan, 0.25);
  assert.deepStrictEqual([r.stop, r.active, r.close], [105, true, null], 'peak 3R: stop at 2.5R = 105');
  r = trailStep({ ...long, stop: 105, peakR: 3 }, { h: 105.5, l: 105.1, c: 105.2 }, plan, 0.25);
  assert.strictEqual(r.stop, 105, 'never loosens');
  r = trailStep({ ...long, stop: 105, peakR: 3 }, { h: 107, l: 104, c: 104.5 }, plan, 0.25);
  assert.deepStrictEqual(r.close, { price: 104.5, reason: 'trail' }, 'the bar went through the new stop: out at its close');
  const short = { sign: -1, entry: 100, risk: 2, stop: 102, peakR: 0 };
  r = trailStep(short, { h: 99, l: 95.1, c: 95.5 }, plan, 0.25);
  assert.strictEqual(r.stop, 96.25, 'short: 95.1 + 1 = 96.1, rounded up to the tick');
  assert.strictEqual(snapStop(96.1, 1, 0.25), 96);
});

/** A rules strategy that goes long when the close crosses above 100.5 (fires once on our bars). */
function strategy(extra = {}) {
  const rules = { long: ['close crosses_above 100.5'] };
  return {
    name: 'test', valid: true, status: 'active', instruments: ['MNQ'], timeframe: '3m', signal: 'rules', rules,
    compiledRules: compileRules(rules).compiled, risk: { stop: 'atr:1', min_rr: 2 }, ...extra,
  };
}

/** 3m bars from 10:00 ET (14:00Z, EDT): flat at 100 (ATR 1), then the scripted path. */
function bars(path) {
  const t0 = Date.parse('2025-03-10T14:00:00Z');
  const flat = Array.from({ length: 520 }, () => [100, 100.5, 99.5, 100]);
  return [...flat, ...path].map(([o, h, l, c], i) => ({ t: new Date(t0 - 520 * 180000 + i * 180000).toISOString(), o, h, l, c, v: 1 }));
}

const run = (path, s = strategy(), opts = {}) => runEngine([{ symbol: 'MNQ', bars: bars(path), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [s], {
  // The fill mechanics as algoTraderBot: at the signal close, no slippage (the live-latency default has its own tests).
  timeframe: 3, gate: false, fill: 'close', slippageTicks: 0, ...opts,
}).trades;

test('engine: entry at the signal close, stop at 1R, fixed target at min_rr', () => {
  const trades = run([[100, 101, 99.9, 101], [101, 101.5, 100.5, 101.2], [101.2, 103.5, 101, 103]]);
  assert.strictEqual(trades.length, 1);
  const t = trades[0];
  assert.deepStrictEqual([t.entry, t.initialStop, t.reason, t.exit, t.r], [101, 100, 'target', 103, 2]);
  assert.strictEqual(t.net, 4, '8 ticks x $0.50');
});

test('engine: a bar touching both stop and target is a loss; a gap through the stop fills at the open', () => {
  assert.deepStrictEqual(run([[100, 101, 99.9, 101], [101, 104, 99.5, 101]]).map(t => [t.reason, t.r]), [['stop', -1]]);
  assert.deepStrictEqual(run([[100, 101, 99.9, 101], [99, 99.5, 98, 98.5]]).map(t => [t.reason, t.exit, t.r]), [['stop', 99, -2]]);
});

test('engine: trend setups trail from +2R, giving back 0.5R', () => {
  const s = strategy({ exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } });
  const trades = run([[100, 101, 99.9, 101], [101, 103.2, 102.8, 103], [103, 105, 104.6, 104.8], [104.8, 104.9, 104.4, 104.5]], s);
  assert.strictEqual(trades.length, 1);
  // Peak 105 (4R): stop 104.5 (3.5R), hit on the last bar.
  assert.deepStrictEqual([trades[0].reason, trades[0].exit, trades[0].r, trades[0].mfeR], ['trail', 104.5, 3.5, 4]);
});

test('engine: with harness rules, no entries outside sessions and a flatten at end of day', () => {
  const late = run([[100, 101, 99.9, 101], [101, 101.2, 100.8, 101]], strategy(), { gate: true, sessions: ['11:00-15:00@America/New_York'], gateConfig: loadConfig({ FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '' }) });
  assert.deepStrictEqual(late, [], '10:03 ET is outside the session');
  const eod = run([[100, 101, 99.9, 101], [101, 101.2, 100.8, 101.1], [101.1, 101.2, 100.9, 101]], strategy(), {
    gate: true, sessions: ['10:00-15:00@America/New_York'], eodAt: '10:06@America/New_York', gateConfig: loadConfig({ FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '' }),
  });
  assert.deepStrictEqual(eod.map(t => t.reason), ['eod']);
});

test('report: R stats as algoTraderBot reports them, plus dollars and drawdown', () => {
  const trades = [{ r: 2, mfeR: 2.5, net: 40, fees: 0.74 }, { r: -1, mfeR: 0.5, net: -20, fees: 0.74 }, { r: -1, mfeR: 0.2, net: -20, fees: 0.74 }];
  const s = stats(trades);
  assert.deepStrictEqual([s.trades, s.winRate, s.meanR, s.sumR, s.profitFactorR, s.capture, s.netPnL], [3, 0.333, 0, 0, 1, 0, 0]);
  assert.strictEqual(maxDrawdown(trades), 40);
});

test('config: data, symbols and limits are validated', () => {
  assert.throws(() => validateBacktestConfig({ symbols: ['MNQ'] }, ROOT), /data:/);
  assert.throws(() => validateBacktestConfig({ symbols: ['XYZ'], data: { XYZ: 'a.csv' } }, ROOT), /tickSize and tickValue/);
  assert.throws(() => validateBacktestConfig({ data: { MNQ: 'a.csv' }, start: '2025-02-01', end: '2025-01-01' }, ROOT), /end must be after start/);
  const ok = validateBacktestConfig({ data: { MNQ: 'a.csv' } }, ROOT);
  assert.deepStrictEqual([ok.markets[0].tickSize, ok.markets[0].tickValue], [0.25, 0.5]);
});

test('a backtest run on the parity data writes a report; trades match the live evaluator', () => {
  const dir = tmpDir();
  const { report, runDir } = runBacktest({
    symbols: ['MNQ'], timeframe: 3, data: { MNQ: path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv') },
    strategies: ['supertrend', 'bos'], gate: false, outDir: dir,
  }, { root: ROOT, outRoot: dir });
  assert.ok(report.summary.trades > 10);
  assert.ok(report.trades.every(t => ['supertrend', 'bos'].includes(t.strategy)));
  for (const f of ['report.md', 'report.json', 'trades.csv']) assert.ok(fs.existsSync(path.join(runDir, f)));
  // Every trade's R is consistent with its prices.
  for (const t of report.trades) assert.ok(Math.abs(t.r - (t.direction === 'long' ? 1 : -1) * (t.exit - t.entry) / t.risk) < 1e-3);
});

test('engine: a trade closed by the trail is not followed by an entry on the same bar', () => {
  // The rule would fire again on the bar that the trail closes the trade on.
  const s = strategy({ rules: undefined, compiledRules: compileRules({ long: ['close > open'] }).compiled, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } });
  const trades = run([[100, 101, 99.9, 101], [101, 103.2, 102.8, 103], [103, 105, 103.8, 104]], s);
  const closeBar = trades.find(t => t.reason === 'trail');
  assert.ok(closeBar);
  assert.ok(!trades.some(t => t.entryTime === closeBar.exitTime), JSON.stringify(trades.map(t => [t.entryTime, t.exitTime, t.reason])));
});

test('engine: stops and targets on a 0.1 tick are exact (no float misses)', () => {
  const t0 = Date.parse('2025-03-10T14:00:00Z');
  const flat = Array.from({ length: 520 }, () => [2045, 2045.2, 2044.8, 2045]);
  const path = [[2045, 2045.2, 2044.9, 2045.1], [2045.1, 2045.2, 2044.9, 2045.0]];
  const bars = [...flat, ...path].map(([o, h, l, c], i) => ({ t: new Date(t0 - 520 * 180000 + i * 180000).toISOString(), o, h, l, c, v: 1 }));
  const s = strategy({ compiledRules: compileRules({ long: ['close crosses_above 2045.05'] }).compiled, risk: { stop: 'atr:0.5', min_rr: 2 } });
  const trades = runEngine([{ symbol: 'MNQ', bars, tickSize: 0.1, tickValue: 0.5, feesPerSide: 0 }], [s], { timeframe: 3, gate: false, fill: 'close', slippageTicks: 0 }).trades;
  assert.strictEqual(trades[0].initialStop, 2044.9);
  assert.strictEqual(trades[0].reason, 'stop', 'the low touches 2044.9 exactly');
});

test('config: bad sessions or eodAt are refused, not ignored; sizing is one or the other', () => {
  assert.throws(() => validateBacktestConfig({ data: { MNQ: 'a.csv' }, sessions: ['9:35-15:00'] }, ROOT), /sessions:/);
  assert.throws(() => validateBacktestConfig({ data: { MNQ: 'a.csv' }, eodAt: '3:50pm ET' }, ROOT), /eodAt:/);
  assert.throws(() => validateBacktestConfig({ data: { MNQ: 'a.csv' }, size: 2, riskPerTrade: 100 }, ROOT), /use one/);
  const fees = validateBacktestConfig({ symbols: ['ES'], data: { ES: { file: 'a.csv', feesPerSide: 2.5 } }, feesPerSide: 0.37 }, ROOT);
  assert.strictEqual(fees.markets[0].feesPerSide, 2.5, 'the symbol\'s own fee wins');
});

test('data: empty price cells drop the row instead of reading as 0; epoch numbers in Excel-style columns', () => {
  const bars = parseCsv('time,open,high,low,close,volume\n2025-03-10T13:30:00Z,1,2,0.5,1.5,10\n2025-03-10T13:31:00Z,1,2,,,\n');
  const { normalizeBars } = require('../../scripts/lib/trading/indicators');
  assert.strictEqual(normalizeBars(bars).length, 1);
  const { tableToBars } = require('../../scripts/lib/backtest/data');
  assert.strictEqual(tableToBars(['time', 'open', 'high', 'low', 'close'], [[1741613400, 1, 2, 0, 1]], { excel: true })[0].t, '2025-03-10T13:30:00.000Z');
});

test('the gate limits come from the environment, as live', () => {
  const dir = tmpDir();
  const base = { symbols: ['MNQ'], timeframe: 3, data: { MNQ: path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv') }, strategies: ['bos'], outDir: dir };
  const loose = runBacktest(base, { root: ROOT, outRoot: dir, env: { FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '' } }).report.summary.trades;
  const capped = runBacktest(base, { root: ROOT, outRoot: dir, env: { FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_MAX_ENTRIES_PER_DAY: '1' } }).report.trades;
  const perDay = new Map();
  for (const t of capped) perDay.set(t.entryTime.slice(0, 10), (perDay.get(t.entryTime.slice(0, 10)) || 0) + 1);
  assert.ok(loose > capped.length);
  assert.ok([...perDay.values()].every(n => n <= 2), 'at most one entry per trading day (a calendar day spans two)');
});

test('engine: a fixed target is measured from the unrounded stop distance, as algoTraderBot', () => {
  // Stop 0.9 x ATR ~ 0.9045: 4 ticks of stop, but the 2R target is round(1.809 / 0.25) = 7 ticks.
  const trades = run([[100, 101, 99.9, 101], [101, 102.8, 100.8, 102.5]], strategy({ risk: { stop: 'atr:0.9', min_rr: 2 } }));
  assert.deepStrictEqual(trades.map(t => [t.initialStop, t.reason, t.exit]), [[100, 'target', 102.75]]);
});

test('engine: losses are counted from P&L before fees, as the live gate counts them', () => {
  const s = strategy({ exit: { target_r: 5, max_bars: 1 } });
  const path = [[100, 101, 99.9, 101], [101, 101.3, 100.9, 101.25], [101.25, 101.3, 99.9, 100], [100, 101, 99.9, 101], [101, 101.1, 100.9, 101]];
  const opts = { gate: true, sessions: ['09:30-16:00@America/New_York'], eodAt: '16:00@America/New_York', gateConfig: loadConfig({ FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_MAX_DAILY_LOSSES: '1' }) };
  const trades = runEngine([{ symbol: 'MNQ', bars: bars(path), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 }], [s], { timeframe: 3, fill: 'close', slippageTicks: 0, ...opts }).trades;
  assert.ok(trades[0].pnl > 0 && trades[0].net < 0, 'a 1-tick win that fees turn negative');
  assert.strictEqual(trades.length, 2, 'it is not a loss: the second entry is allowed');
});

test('config: gate must be a boolean', () => {
  assert.throws(() => validateBacktestConfig({ data: { MNQ: 'a.csv' }, gate: 'false' }, ROOT), /gate: true or false/);
});

test('market hours are a hard rule in backtests too: no entries outside them, no trade held overnight', () => {
  // gate: false drops the order-gate limits, never the market hours.
  const t0 = Date.parse('2025-03-10T19:57:00Z'); // 15:57 ET
  const flat = Array.from({ length: 520 }, () => [100, 100.5, 99.5, 100]);
  const path = [[100, 101, 99.9, 101], [101, 101.2, 100.8, 101.1]];
  const mk = (rows, start) => rows.map(([o, h, l, c], i) => ({ t: new Date(start + i * 180000).toISOString(), o, h, l, c, v: 1 }));
  const late = runEngine([{ symbol: 'MNQ', bars: mk([...flat, ...path], t0 - 520 * 180000), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [strategy()], { timeframe: 3, gate: false, fill: 'close', slippageTicks: 0 }).trades;
  assert.deepStrictEqual(late, [], 'a 16:00 ET close is after end of day: no entry');
  // An entry at 10:03 with no more bars until the next morning: closed at that day's last bar.
  const day = Date.parse('2025-03-10T14:00:00Z');
  const rows = mk([...flat, [100, 101, 99.9, 101]], day - 520 * 180000);
  rows.push({ t: new Date(Date.parse('2025-03-11T14:00:00Z')).toISOString(), o: 90, h: 91, l: 89, c: 90, v: 1 });
  const held = runEngine([{ symbol: 'MNQ', bars: rows, tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [strategy({ exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } })], { timeframe: 3, gate: false, fill: 'close', slippageTicks: 0 }).trades;
  assert.deepStrictEqual(held.map(t => [t.reason, t.exit]), [['eod', 101]], 'not carried into the next day');
  assert.throws(() => validateBacktestConfig({ data: { MNQ: 'a.csv' }, eodAt: null }, ROOT), /eodAt/);
  assert.throws(() => validateBacktestConfig({ data: { MNQ: 'a.csv' }, sessions: ['00:00-23:59@America/New_York'] }, ROOT), /market session/);
});

test('strategies whose stop is an expression (cisd_ote) are backtested', () => {
  const dir = tmpDir();
  const base = { symbols: ['MNQ'], timeframe: 3, data: { MNQ: path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv') }, strategies: ['cisd_ote'], outDir: dir, gate: false };
  const { report } = runBacktest(base, { root: ROOT, outRoot: dir, env: {} });
  assert.deepStrictEqual(report.skipped || {}, {});
  assert.ok(report.summary.trades > 0, 'cisd_ote trades');
});

test('a stop expression with no positive distance makes no candidate', () => {
  const { createEvaluator } = require('../../scripts/lib/trading/evaluator');
  const { compileExpression } = require('../../scripts/lib/trading/rules');
  const s = strategy({ risk: { stop: '-0.5 * atr(20)', min_rr: 2 }, compiledStop: compileExpression('-0.5 * atr(20)') });
  const b = bars([[100, 101, 99.9, 101]]).map(x => ({ ...x }));
  const r = createEvaluator(b).at(s, b.length - 1, { describe: false });
  assert.strictEqual(r.direction, 'long');
  assert.strictEqual(r.candidate, false);
  assert.match(r.filtersFailed.join(' '), /no positive distance/);
});

test('ticks round half to even, as algoTraderBot (Python round)', () => {
  const { roundHalfEven } = require('../../scripts/lib/backtest/engine');
  assert.deepStrictEqual([32.5, 33.5, 32.4999, 32.6, 8.125 / 0.25].map(roundHalfEven), [32, 34, 32, 33, 32]);
});

test('backtests follow the exchange calendar: no trading on holidays, early close at 13:00 ET', () => {
  // 2025-03-10 is a Monday trading day; mark it closed, then early.
  const s = strategy();
  const path = [[100, 101, 99.9, 101], [101, 101.2, 100.8, 101.1]];
  const closed = run(path, s, { closedDates: ['2025-03-10'] });
  assert.deepStrictEqual(closed, [], 'holiday: no entry');
  const t0 = Date.parse('2025-03-10T17:00:00Z'); // 13:00 ET
  const flat = Array.from({ length: 520 }, () => [100, 100.5, 99.5, 100]);
  const rows = [...flat, ...path].map(([o, h, l, c], i) => ({ t: new Date(t0 - 520 * 180000 + i * 180000).toISOString(), o, h, l, c, v: 1 }));
  const early = runEngine([{ symbol: 'MNQ', bars: rows, tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [s], { timeframe: 3, gate: false, fill: 'close', slippageTicks: 0, earlyCloseDates: ['2025-03-10'] }).trades;
  assert.deepStrictEqual(early, [], 'early close: no entry after 13:00 ET');
});

test('prop challenge mode: a policy strategy\'s attempts from each start, rules only and with a policy, reported by month', () => {
  const dir = tmpDir();
  const accounts = path.join(dir, 'accounts');
  fs.mkdirSync(path.join(accounts, 'tiny'), { recursive: true });
  const src = fs.readFileSync(path.join(ROOT, 'accounts', 'topstep_50k', 'ACCOUNT.md'), 'utf8')
    .replace('name: topstep_50k', 'name: tiny').replace(/sessions: 30 /, 'sessions: 2 ');
  fs.writeFileSync(path.join(accounts, 'tiny', 'ACCOUNT.md'), src);
  const strategiesDir = path.join(dir, 'strategies');
  fs.mkdirSync(path.join(strategiesDir, 'prop_bos'), { recursive: true });
  fs.writeFileSync(path.join(strategiesDir, 'prop_bos', 'STRATEGY.md'), fs.readFileSync(path.join(ROOT, 'strategies', 'prop_portfolio_3m', 'STRATEGY.md'), 'utf8')
    .replace('name: prop_portfolio_3m', 'name: prop_bos').replace(/^strategies: .*$/m, 'strategies: [bos]').replace('account: topstep_100k', 'account: tiny'));
  const env = { FTH_ACCOUNTS_DIRS: accounts, FTH_STRATEGIES_DIRS: strategiesDir };
  const base = { symbols: ['MNQ'], timeframe: 3, data: { MNQ: path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv') }, outDir: dir, gate: false, prop: 'prop_bos' };
  const { report, runDir } = runBacktest(base, { root: ROOT, outRoot: dir, env });
  assert.strictEqual(report.prop, 'prop_bos');
  assert.deepStrictEqual(report.strategies, ['bos']);
  assert.strictEqual(report.contracts, 'auto');
  assert.ok(report.baseline.attempts > 0);
  assert.strictEqual(report.baseline.passed + report.baseline.blown + report.baseline.timeout + report.baseline.unfinished, report.baseline.attempts);
  assert.ok(fs.existsSync(path.join(runDir, 'combine.md')));
  assert.throws(() => validateBacktestConfig({ data: { MNQ: 'a.csv' }, account: 'tiny' }, ROOT), /comes from a policy strategy/);
  assert.throws(() => validateBacktestConfig({ data: { MNQ: 'a.csv' }, bundle: 'p' }, ROOT), /bundle: .*needs prop/);
  assert.throws(() => runBacktest({ ...base, prop: 'bos' }, { root: ROOT, outRoot: dir, env }), /training needs a policy strategy|signal: rules/);
  assert.throws(() => runBacktest({ ...base, bundle: 'missing' }, { root: ROOT, outRoot: dir, env }), /not found/);
});

test('engine (default fills): an entry fills at the next bar\'s open plus a tick of slippage; a gap through the stop expires it', () => {
  const live = { fill: 'next-open', slippageTicks: 1 };
  // The signal bar closes at 101; the next bar opens at 101.25: filled at 101.50, the stop 1R (ATR 1) below the fill.
  const [t] = run([[100.5, 101.2, 100.4, 101], [101.25, 104.5, 101, 104], [104, 104.5, 103.5, 104]], strategy({ exit: { target_r: 2 } }), live);
  assert.strictEqual(t.entry, 101.5);
  assert.strictEqual(t.initialStop, 100.5);
  assert.strictEqual(t.target, 103.5, '2R from the fill');
  assert.strictEqual(t.reason, 'target');
  assert.strictEqual(t.entryTime, bars([[0, 0, 0, 0], [0, 0, 0, 0]])[521].t, 'entered at the fill bar\'s open');
  // The next bar opens at 99.75, through the signal's stop (100): the setup is gone.
  const r = runEngine([{ symbol: 'MNQ', bars: bars([[100.5, 101.2, 100.4, 101], [99.75, 100, 99, 99.5], [99.5, 99.6, 99.4, 99.5]]), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [strategy()], { timeframe: 3, gate: false, ...live });
  assert.deepStrictEqual([r.trades.length, r.expired], [0, 1]);
  // A signal on the last bar of the data has no fill bar: expired, not a trade.
  const end = runEngine([{ symbol: 'MNQ', bars: bars([[100.5, 101.2, 100.4, 101]]), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [strategy()], { timeframe: 3, gate: false, ...live });
  assert.deepStrictEqual([end.trades.length, end.expired], [0, 1]);
});

test('report: confidence interval, edge verdict, Sharpe, MAE, losing streak, and hour/weekday breakdowns', () => {
  const { buildReport, toMarkdown, sharpe } = require('../../scripts/lib/backtest/report');
  const mk = (i, r, net) => ({
    symbol: 'MNQ', strategy: 'x', reason: 'stop', entryTime: new Date(Date.UTC(2025, 2, 10 + (i % 5), 14, 0)).toISOString(),
    exitTime: new Date(Date.UTC(2025, 2, 10 + (i % 5), 15, 0) + i * 1000).toISOString(), r, mfeR: Math.max(r, 0.5), maeR: -0.5, net, fees: 0.74, barsHeld: 4,
  });
  const few = buildReport([mk(0, 2, 20), mk(1, -1, -10), mk(2, -1, -10)], { fill: 'next-open', slippageTicks: 1 });
  assert.match(few.summary.edge, /anecdotal/);
  assert.strictEqual(few.summary.longestLosingStreak, 2);
  assert.deepStrictEqual([few.summary.meanMaeR, few.summary.worstMaeR, few.summary.avgBarsHeld], [-0.5, -0.5, 4]);
  assert.deepStrictEqual(Object.keys(few.byHour), ['10:00 ET']);
  assert.ok(Object.keys(few.byWeekday)[0].endsWith('-Mon'));
  const many = buildReport(Array.from({ length: 40 }, (_, i) => mk(i, i % 4 === 0 ? -1 : 1.5, i % 4 === 0 ? -10 : 15 + i)), { fill: 'close', slippageTicks: 0 });
  assert.strictEqual(many.summary.edge, 'positive');
  assert.ok(many.summary.meanRCI95[0] > 0 && many.summary.meanRCI95[1] > many.summary.meanRCI95[0]);
  assert.ok(many.summary.sharpe > 0);
  assert.strictEqual(sharpe([mk(0, 1, 10)]), null, 'one day is no Sharpe');
  const md = toMarkdown({ ...many, meta: { runId: 'r', symbols: ['MNQ'], timeframe: 3, start: 'a', end: 'b', strategies: ['x'], gate: true, fill: 'next-open', slippageTicks: 1, expired: 2 } });
  assert.match(md, /Edge: positive; mean R 95% interval/);
  assert.match(md, /at the next bar's open \(live latency\), 1 tick\(s\) of slippage per market fill; 2 setup\(s\) expired/);
  assert.match(md, /## By entry hour \(ET\)/);
});

test('data audit: missing bars inside market hours, jumps from an unadjusted roll, and malformed bars; the daily break is not a gap', () => {
  const { auditBars } = require('../../scripts/lib/backtest/data');
  const t0 = Date.parse('2025-03-10T14:00:00Z'); // 10:00 ET
  const at = k => new Date(t0 + k * 180000).toISOString();
  const rows = [];
  for (let k = 0; k < 60; k += 1) rows.push({ t: at(k), o: 100, h: 100.5, l: 99.5, c: 100 });
  // 4 bars missing at 13:00 ET, then a 60-point open jump (ATR about 1), then a bad bar.
  rows.splice(20, 4);
  rows.push({ t: at(60), o: 160, h: 160.5, l: 159.5, c: 160 });
  rows.push({ t: at(61), o: 160, h: 159, l: 160, c: 160 });
  // 16:00 ET close to 18:00 ET open: the daily break, not missing data.
  rows.push({ t: new Date(Date.parse('2025-03-10T22:00:00Z')).toISOString(), o: 160, h: 160.5, l: 159.5, c: 160 });
  const a = auditBars(rows, 3);
  assert.strictEqual(a.missing, 4);
  assert.deepStrictEqual(a.gaps[0], { after: at(19), before: at(24), bars: 4 });
  assert.strictEqual(a.jumps.length, 1);
  assert.strictEqual(a.jumps[0].t, at(60));
  assert.strictEqual(a.invalid, 1);
  assert.strictEqual(a.warnings.length, 3);
  assert.match(a.warnings[1], /jump more than 8 x ATR .* unadjusted roll/);
});
