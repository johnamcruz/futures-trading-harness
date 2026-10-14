'use strict';

// The strategies retired on 2026-10-13 (bos, keltner, ema_cross, supertrend; strategies/README.md, "Retired
// strategies"): old records, configs and verdicts that still name them never crash anything. An entry naming one
// is refused, saying it was retired; an exit or a protective stop for a position one opened still goes, and the
// runner still manages that position from its remembered exit plan.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadStrategies, checkStrategyForOrder, componentRefusal, validateStrategy, RETIRED, retiredNote, exitPlan } = require('../../scripts/lib/trading/strategies');
const { evaluateOrder } = require('../../scripts/lib/trading/order-gate');
const { loadConfig } = require('../../scripts/lib/trading/config');
const prop = require('../../scripts/lib/trading/prop-state');
const { createExitMemory } = require('../../scripts/lib/trading/exit-memory');
const { laneStrategyErrors, laneStrategies, signalLaneErrors, describeLane, retireLanes, startErrors } = require('../../scripts/lib/lanes');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { createRunner } = require('../../scripts/lib/runner');
const { runnerScan } = require('../../scripts/lib/runner-wiring');
const { loadAgents } = require('../../scripts/lib/harness-sync');
const { laneChecks } = require('../../scripts/lib/preflight');
const { liveRecord, readRecord, describeRecord } = require('../../scripts/lib/trading/track-record');
const { runBacktest } = require('../../scripts/lib/backtest/run');
const { tmpDir, trendHome, rootWithPolicies, NOW, CONTRACT, plan, entryOrder } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const NAMES = ['bos', 'keltner', 'ema_cross', 'supertrend'];
const SHIPPED = loadStrategies(ROOT, {}).strategies;
const RETIRED_RE = name => new RegExp(`${name} .*retired on 2026-10-13: strategies/README\\.md, "Retired strategies"`);

test('the four are retired: no folder ships them, the policies list none, and each is named with its date', () => {
  assert.deepStrictEqual(Object.keys(RETIRED).sort(), [...NAMES].sort());
  for (const n of NAMES) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'strategies', n)), `strategies/${n} is gone`);
    assert.ok(!SHIPPED.some(s => s.name === n), n);
    assert.match(retiredNote(n), /retired on 2026-10-13/);
  }
  assert.strictEqual(retiredNote('orb'), '', 'a shipped strategy is not retired');
  assert.strictEqual(retiredNote('toString'), '', 'no prototype name');
  for (const p of SHIPPED.filter(s => s.signal === 'policy')) {
    assert.ok(p.valid, `${p.name}: ${p.errors}`);
    assert.deepStrictEqual(p.strategies.filter(n => NAMES.includes(n)), [], p.name);
  }
  // The README's table names each with the date (the gate's message points there).
  const readme = fs.readFileSync(path.join(ROOT, 'strategies', 'README.md'), 'utf8');
  const section = readme.split('## Retired strategies')[1];
  assert.ok(section, 'strategies/README.md has a "Retired strategies" section');
  for (const n of NAMES) assert.match(section, new RegExp(`\\| \`${n}\` \\|.*2026-10-13`), n);
  // The table names exactly the code's list: one source each way.
  const rows = [...section.matchAll(/^\| `([a-z0-9_-]+)` \|/gm)].map(m => m[1]);
  assert.deepStrictEqual(rows.sort(), Object.keys(RETIRED).sort());
});

test('an entry tagged with a retired strategy is refused by the gate, saying it was retired; its exit and stop still go', () => {
  const config = { ...loadConfig({}), killSwitchFile: '/nonexistent/fth/STOP', home: trendHome(), mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9 };
  for (const n of NAMES) {
    assert.match(checkStrategyForOrder(SHIPPED, n, 'MNQ', NOW, 'buy'), /no new entries from it\. A position it opened is still exited and protected with \[exit\] or \[protect\]/);
    const r = evaluateOrder({ input: entryOrder({ rationale: `setup:${n} long, stop 21480` }), entries: [plan()], now: NOW, config, strategies: SHIPPED });
    assert.strictEqual(r.intent, 'entry');
    const v = r.violations.find(x => x.check === 'strategy');
    assert.ok(v, `${n}: ${JSON.stringify(r.violations)}`);
    assert.match(v.message, RETIRED_RE(n));
    // Risk-reducing orders never name a strategy: the position it opened is closed or protected as any other.
    const exit = evaluateOrder({ input: entryOrder({ side: 'sell', rationale: `[exit] close the ${n} long`, stopLossBracket: undefined }), entries: [], now: NOW, config, strategies: SHIPPED });
    assert.deepStrictEqual([exit.intent, exit.violations], ['risk-reducing', []]);
    const stop = evaluateOrder({ input: entryOrder({ side: 'sell', type: 'stop', stopPrice: 21480, rationale: `[protect] stop for the ${n} long`, stopLossBracket: undefined }), entries: [], now: NOW, config, strategies: SHIPPED });
    assert.deepStrictEqual(stop.violations, []);
  }
  // A strategy the user never had is refused as before (no retired note).
  assert.match(checkStrategyForOrder(SHIPPED, 'nope', 'MNQ', NOW, 'buy'), /setup:nope is not a known strategy\. Add strategies\/nope\/STRATEGY\.md/);
});

test('an old policy verdict whose setup came from a retired strategy is refused at the gate', () => {
  const policy = SHIPPED.find(s => s.name === 'prop_portfolio');
  for (const n of NAMES) assert.match(componentRefusal(policy, SHIPPED, n), new RegExp(`${n} is not one of prop_portfolio's strategies`));
  // A user policy that still lists one: its component is refused as retired, never traded.
  const old = { ...policy, strategies: ['bos', ...policy.strategies] };
  assert.match(componentRefusal(old, SHIPPED, 'bos'), RETIRED_RE('bos'));
  // Through the gate: a fresh verdict on file (from before the retirement) naming bos as its component.
  const account = { name: 'mini', valid: true, errors: [], starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod',
    daily_loss_limit: 1000, daily_loss_soft: 500, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50 }, fees_per_side: { MNQ: 0.37 } };
  const home = trendHome();
  prop.startAttempt(home, account, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, account, 50000, new Date(NOW.getTime() - 60000));
  prop.appendVerdict(home, {
    strategy: 'prop_portfolio', component: 'bos', contractId: CONTRACT, symbol: 'MNQ', contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40,
    maxSize: 3, bar: '2026-10-07T13:57:00Z', at: '2026-10-07T13:59:30Z', expiresAt: new Date(NOW.getTime() + 120000).toISOString(),
  });
  const registry = SHIPPED.map(s => (s.name === 'prop_portfolio' ? { ...s, account: 'mini' } : s));
  const config = { ...loadConfig({}), killSwitchFile: '/nonexistent/fth/STOP', home, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9 };
  const r = evaluateOrder({ input: entryOrder({ size: 3, rationale: 'setup:prop_portfolio bos long, stop 40 ticks' }), entries: [plan()], now: NOW, config, strategies: registry, accounts: [account] });
  assert.ok(r.violations.some(v => /the latest verdict's setup is from bos: bos is not one of prop_portfolio's strategies; no live entry from it/.test(v.message)), JSON.stringify(r.violations));
});

test('configs and documents naming a retired strategy are refused with the reason, never thrown at load', () => {
  // A user's policy strategy that still lists one: invalid (not traded), saying why.
  const dir = tmpDir();
  const doc = fs.readFileSync(path.join(ROOT, 'strategies', 'prop_portfolio', 'STRATEGY.md'), 'utf8')
    .replace(/^name: prop_portfolio$/m, 'name: prop_old').replace(/^strategies: \[/m, 'strategies: [keltner, ');
  fs.mkdirSync(path.join(dir, 'prop_old'));
  fs.writeFileSync(path.join(dir, 'prop_old', 'STRATEGY.md'), doc);
  // Listed in its account's rulebook (a plugin root with the accounts copied), so only its list can make it invalid.
  const loaded = loadStrategies(rootWithPolicies({ prop_old: SHIPPED.find(s => s.name === 'prop_portfolio').account }), { FTH_STRATEGIES_DIRS: dir }).strategies.find(s => s.name === 'prop_old');
  assert.strictEqual(loaded.valid, false);
  assert.ok(loaded.errors.some(e => /strategies: keltner is not a strategy \(retired on 2026-10-13/.test(e)), loaded.errors.join('; '));
  // A private copy under a retired name in the user's own folder is the user's strategy: it loads and is checked
  // as any other (the README says so), never mistaken for the retired one.
  const own = tmpDir();
  fs.mkdirSync(path.join(own, 'bos'));
  fs.writeFileSync(path.join(own, 'bos', 'STRATEGY.md'), fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'strategies-fx', 'fx_break', 'STRATEGY.md'), 'utf8').replace(/^name: fx_break$/m, 'name: bos'));
  const mine = loadStrategies(ROOT, { FTH_STRATEGIES_DIRS: own }).strategies;
  assert.ok(mine.find(s => s.name === 'bos').valid);
  assert.strictEqual(checkStrategyForOrder(mine, 'bos', 'MNQ', NOW, 'buy'), null);
  // An old detector signal: the hint points at the history, not a document that is gone.
  for (const n of NAMES) {
    const errs = validateStrategy({ name: 'x', description: 'x'.repeat(40), status: 'paper', instruments: ['MNQ'], timeframe: '3m', signal: n, risk: { stop: 'atr:0.5', min_rr: 2 } }, '## When to Use\n## How It Works\n## Examples', 'x');
    assert.ok(errs.some(e => new RegExp(`the ${n} strategy was retired on 2026-10-13`).test(e)), errs.join('; '));
  }
  // A backtest asked for one: refused, saying it was retired.
  assert.throws(() => runBacktest({ symbols: ['MNQ'], timeframe: 3, data: { MNQ: path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv') }, strategies: ['supertrend'], gate: false, outDir: dir }, { root: ROOT, outRoot: dir }),
    /unknown strategy "supertrend" \(retired on 2026-10-13/);
});

test('old journals, track records and exit plans naming a retired strategy still read; its open position keeps its trail', () => {
  const home = tmpDir();
  // The journal's reviewed trades: read as any setup's.
  const entries = [
    { ts: '2026-10-06T14:00:00Z', kind: 'review', tags: ['setup:bos', 'result:win'], r: 2, regime: 'trend-up', text: 'bos long' },
    { ts: '2026-10-06T15:00:00Z', kind: 'review', tags: ['setup:keltner', 'result:loss'], r: -1, text: 'keltner short' },
  ];
  assert.deepStrictEqual([liveRecord(entries, 'bos').trades, liveRecord(entries, 'bos').wins, liveRecord(entries, 'keltner').losses], [1, 1, 1]);
  // A cached backtest record of a retired strategy: still readable; with no strategy file it is described without one.
  fs.mkdirSync(path.join(home, 'track-record'), { recursive: true });
  fs.writeFileSync(path.join(home, 'track-record', 'bos.json'), '{oops');
  assert.strictEqual(readRecord(home, 'bos'), null);
  assert.match(describeRecord({ backtest: null, live: liveRecord(entries, 'bos'), file: null }), /no backtest recorded/);
  // The exit plan remembered while it loaded (an open position from before the retirement) still manages it.
  const file = path.join(home, 'exit-plans.json');
  fs.writeFileSync(file, JSON.stringify({ bos: { name: 'bos', timeframe: '3m', risk: { stop: 'atr:0.5', min_rr: 1.5 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } } }));
  const remembered = createExitMemory(file).strategyFor('bos', SHIPPED);
  assert.deepStrictEqual([remembered.valid, remembered.remembered], [false, true]);
  assert.deepStrictEqual([exitPlan(remembered).trailActivateR, exitPlan(remembered).trailGivebackR], [2, 0.5]);
  // Without a remembered plan: nothing to trail (the broker's stop stays), and nothing throws.
  assert.strictEqual(createExitMemory(path.join(home, 'none.json')).strategyFor('ema_cross', SHIPPED), null);
});

const cfgWith = lanes => validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', account: '7', symbols: ['MNQ'], lanes });

test('a lanes config naming a retired strategy: the runner starts, the lane enters nothing, and it is said loudly', () => {
  const agents = loadAgents(ROOT);
  const cfg = cfgWith([{ timeframe: 3, trigger: 'bar', strategies: ['bos', 'orb'] }, { timeframe: 1, trigger: 'signal', strategies: ['ofi'] }]);
  assert.deepStrictEqual(startErrors(cfg, SHIPPED, agents), [], 'no refusal at start');
  assert.deepStrictEqual(cfg.lanes[0].retired, ['bos']);
  assert.strictEqual(cfg.lanes[1].retired, undefined, 'the other lane trades as before');
  // The lane scans nothing (not even orb, listed beside it): no setup fires, no policy verdict.
  assert.deepStrictEqual(laneStrategies(SHIPPED, cfg.lanes[0]), []);
  assert.ok(laneStrategies(SHIPPED, cfg.lanes[1]).some(x => x.name === 'ofi'));
  assert.deepStrictEqual(laneStrategyErrors(cfg.lanes, SHIPPED), []);
  assert.match(describeLane(cfg.lanes[0], SHIPPED), /lists bos \(retired on 2026-10-13: strategies\/README\.md, "Retired strategies"\): this lane enters nothing .*open position's management go on/);
  // A retired policy-only signal lane is no refusal either (it cycles only to manage).
  const sig = cfgWith([{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'signal', strategies: ['supertrend'] }]);
  assert.deepStrictEqual(startErrors(sig, SHIPPED, agents), []);
  assert.deepStrictEqual(signalLaneErrors(sig.lanes, SHIPPED), []);
  // A name that never existed still fails closed at start, retired lane or not.
  const unknown = cfgWith([{ timeframe: 3, trigger: 'bar', strategies: ['bos', 'nope'] }]);
  assert.deepStrictEqual(startErrors(unknown, SHIPPED, agents), ['lanes[0].strategies: no strategy named nope']);
  assert.deepStrictEqual(retireLanes(cfgWith([{ timeframe: 3, strategies: ['nope'] }]), SHIPPED), []);
  // A user's own strategy under the name is theirs: the lane is not retired.
  const own = cfgWith([{ timeframe: 3, trigger: 'bar', strategies: ['bos'] }]);
  const mine = [...SHIPPED, { name: 'bos', valid: true, errors: [], signal: 'rules', status: 'active', timeframe: '3m', instruments: ['MNQ'] }];
  assert.deepStrictEqual(retireLanes(own, mine), []);
  assert.strictEqual(own.lanes[0].retired, undefined);
  // Preflight shows it as a failure, naming the lane and the strategy.
  const pre = laneChecks(cfgWith([{ timeframe: 3, trigger: 'bar', strategies: ['keltner', 'orb'] }]), SHIPPED);
  const row = pre.find(x => x.check === 'retired strategies in lanes');
  assert.ok(row && row.status === 'fail', JSON.stringify(pre));
  assert.match(row.detail, /lanes\[0\] \(3m\) lists keltner \(retired on 2026-10-13/);
});

test('an open position from a retired lane keeps trailing after an upgrade with the old config; nothing new is entered', async () => {
  const DAY = Date.UTC(2026, 9, 7);
  const et = (h, m, sec = 0) => DAY + ((h + 4) * 60 + m) * 60000 + sec * 1000;
  const iso = ms => new Date(ms).toISOString();
  const clockRef = { t: et(9, 59, 50) };
  // The config from before the retirement: one 3m lane listing bos. Long 1 MNQ from 21500 (a bos entry), stop 21490.
  const cfg = cfgWith([{ timeframe: 3, trigger: 'bar', strategies: ['bos'] }]);
  assert.deepStrictEqual(startErrors(cfg, SHIPPED, loadAgents(ROOT)), []);
  const home = tmpDir();
  const exitFile = path.join(home, 'exit-plans.json');
  fs.writeFileSync(exitFile, JSON.stringify({ bos: { name: 'bos', timeframe: '3m', risk: { stop: 'atr:0.5', min_rr: 1.5 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } } }));
  const memory = createExitMemory(exitFile);
  const modified = [];
  const events = [];
  const logs = [];
  const scans = [];
  const cycles = [];
  let stop = 21490;
  const client = {
    async activeContract() { return { id: 'MNQ', tickSize: 0.25 }; },
    async closedBars(contractId, { minutes, limit }) {
      const step = minutes * 60000;
      const lastOpen = Math.floor((clockRef.t - 1000) / step) * step - step;
      // From 10:00 the price holds near +4R (21538-21541): the trail moves the stop up and the price never goes through it.
      return Array.from({ length: Math.min(limit, 5) }, (_, k) => {
        const t = lastOpen - (4 - k) * step;
        const up = t >= et(10, 0);
        return { t: iso(t), o: up ? 21539 : 21500, h: up ? 21541 : 21501, l: up ? 21538 : 21499, c: up ? 21540 : 21500, v: 1 };
      });
    },
    async accountState() {
      return { positions: [{ id: 77, contractId: 'MNQ', type: 1, size: 1, averagePrice: 21500, creationTimestamp: iso(et(9, 59, 55)) }], orders: [{ id: 9, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: stop }] };
    },
    async modifyStop(acct, id, price) { modified.push(price); stop = price; },
    async closePosition() {},
    async cancelOrder() {},
    async netPosition() { return 1; },
    async workingOrders() { return 1; },
  };
  const runner = createRunner({
    cfg, root: '/r', client, clock: { now: () => new Date(clockRef.t) },
    runCycle: async action => { cycles.push(action); return { ok: true, timedOut: false }; },
    isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => null, saveState: () => {}, writeBars: () => '/b.json',
    // The runner's own scan of the lane: the shipped strategies, as the runner wiring scans them.
    scanFor: (symbol, bars, lane) => { const r = runnerScan(SHIPPED, cfg, symbol, bars, new Date(clockRef.t), lane || undefined); scans.push(r); return r; },
    entryOrders: () => [{ orderId: 5, contractId: 'MNQ', setup: 'bos', side: 'buy', stopTicks: 40, at: iso(et(9, 59, 54)) }],
    strategyNamed: name => SHIPPED.find(x => x.name === name && x.valid) || null,
    exitStrategy: (name, position) => memory.strategyFor(name, SHIPPED, position),
    event: e => events.push(e),
    log: (m, level) => logs.push({ m, level }),
  });
  while (clockRef.t < et(10, 12)) clockRef.t += await runner.step();
  // Said loudly at start.
  assert.ok(logs.some(l => l.level === 'error' && /lanes\[0\] \(3m\) lists bos \(retired on 2026-10-13.*this lane enters nothing/.test(l.m)), JSON.stringify(logs.slice(0, 5)));
  assert.ok(events.some(e => e.kind === 'lane_retired' && e.timeframe === '3m' && e.retired[0] === 'bos'));
  // The position is managed from its remembered exit plan, and the trail moved the stop up (past +2R: 21520).
  assert.ok(events.some(e => e.kind === 'position_managed' && e.setup === 'bos'), 'managed');
  assert.ok(modified.length >= 1 && modified.every(p => p > 21490), `the stop trailed: ${modified}`);
  // Nothing scanned on the lane: no setup could fire, so nothing new is entered (the gate refuses one on its timeframe).
  assert.ok(scans.every(r => r.length === 0), JSON.stringify(scans.slice(0, 2)));
});
