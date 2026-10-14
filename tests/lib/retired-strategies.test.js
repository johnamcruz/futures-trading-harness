'use strict';

// The strategies retired on 2026-10-13 (bos, keltner, ema_cross, supertrend) and on 2026-10-14 (every other rules
// strategy, and prop_flow_1m; strategies/README.md, "Retired strategies"): old records, configs and verdicts that still name them never crash anything. An entry naming one
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
const { tmpDir, trendHome, rootWithPolicies, NOW, CONTRACT, plan, entryOrder, FX_STRATEGIES, FX_GOLDEN } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const OLD = ['bos', 'keltner', 'ema_cross', 'supertrend'];
// The eleven of 2026-10-14: the ten rules strategies and prop_flow_1m, the policy over the two order-flow ones.
const RULES14 = ['cisd_ote', 'crt_1h', 'crt_4h', 'ofi', 'ofi_absorption', 'orb', 'value_area', 'value_area_breakout', 'value_area_reentry', 'vwap_reclaim'];
const NEW = [...RULES14, 'prop_flow_1m'];
const NAMES = [...OLD, ...NEW];
const DATE = name => (OLD.includes(name) ? '2026-10-13' : '2026-10-14');
const SHIPPED = loadStrategies(ROOT, {}).strategies;
// The shipped tree with the fixture rules strategies (fx_break, fx_cross; fx_orb, fx_ofi, ...): live stand-ins where a
// test needs a strategy that is not retired (none ships since 2026-10-14).
const FX_ENV = { FTH_STRATEGIES_DIRS: [FX_STRATEGIES, FX_GOLDEN].join(',') };
const FX = loadStrategies(ROOT, FX_ENV).strategies;
const RETIRED_RE = name => new RegExp(`${name} .*retired on ${DATE(name)}: strategies/README\\.md, "Retired strategies"`);

test('the fifteen are retired: no folder ships them, the policies list none, and each is named with its date', () => {
  assert.deepStrictEqual(Object.keys(RETIRED).sort(), [...NAMES].sort());
  for (const n of NAMES) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'strategies', n)), `strategies/${n} is gone`);
    assert.ok(!SHIPPED.some(s => s.name === n), n);
    assert.match(retiredNote(n), new RegExp(`retired on ${DATE(n)}`), n);
    assert.strictEqual(RETIRED[n], DATE(n), n);
  }
  // prop_portfolio ships (active, valid, listing no strategy), and the trade lifecycle (signal: composed).
  assert.deepStrictEqual(SHIPPED.map(s => s.name), ['prop_portfolio', 'trade_lifecycle']);
  assert.strictEqual(retiredNote('prop_portfolio'), '', 'a shipped strategy is not retired');
  assert.strictEqual(retiredNote('fx_orb'), '', 'a fixture under another name is not retired');
  assert.strictEqual(retiredNote('toString'), '', 'no prototype name');
  for (const p of SHIPPED.filter(s => s.signal === 'policy')) {
    assert.ok(p.valid, `${p.name}: ${p.errors}`);
    assert.strictEqual(p.status, 'active', p.name);
    assert.deepStrictEqual(p.strategies, [], p.name);
  }
  // The README's table names each with the date (the gate's message points there).
  const readme = fs.readFileSync(path.join(ROOT, 'strategies', 'README.md'), 'utf8');
  const section = readme.split('## Retired strategies')[1];
  assert.ok(section, 'strategies/README.md has a "Retired strategies" section');
  for (const n of NAMES) assert.match(section, new RegExp(`\\| \`${n}\` \\|.*${DATE(n)}`), n);
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
  for (const n of NAMES) {
    const old = { ...policy, strategies: [n, ...policy.strategies] };
    assert.match(componentRefusal(old, SHIPPED, n), RETIRED_RE(n), n);
  }
  // Through the gate: a fresh verdict on file (from before the retirement) naming bos as its component.
  const account = { name: 'mini', valid: true, errors: [], starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod',
    daily_loss_limit: 1000, daily_loss_soft: 500, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50 }, fees_per_side: { MNQ: 0.37 } };
  const home = trendHome();
  prop.startAttempt(home, account, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, account, 50000, new Date(NOW.getTime() - 60000));
  const registry = SHIPPED.map(s => (s.name === 'prop_portfolio' ? { ...s, account: 'mini' } : s));
  const config = { ...loadConfig({}), killSwitchFile: '/nonexistent/fth/STOP', home, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9 };
  // One of each retirement: bos (2026-10-13), orb and ofi_absorption (2026-10-14), each the latest verdict in turn.
  for (const n of ['bos', 'orb', 'ofi_absorption']) {
    prop.appendVerdict(home, {
      strategy: 'prop_portfolio', component: n, contractId: CONTRACT, symbol: 'MNQ', contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40,
      maxSize: 3, bar: '2026-10-07T13:57:00Z', at: '2026-10-07T13:59:30Z', expiresAt: new Date(NOW.getTime() + 120000).toISOString(),
    });
    const r = evaluateOrder({ input: entryOrder({ size: 3, rationale: `setup:prop_portfolio ${n} long, stop 40 ticks` }), entries: [plan()], now: NOW, config, strategies: registry, accounts: [account] });
    assert.ok(r.violations.some(v => new RegExp(`the latest verdict's setup is from ${n}: ${n} is not one of prop_portfolio's strategies; no live entry from it`).test(v.message)), `${n}: ${JSON.stringify(r.violations)}`);
  }
});

test('configs and documents naming a retired strategy are refused with the reason, never thrown at load', () => {
  // A user's policy strategy that still lists one: invalid (not traded), saying why.
  const dir = tmpDir();
  const doc = fs.readFileSync(path.join(ROOT, 'strategies', 'prop_portfolio', 'STRATEGY.md'), 'utf8')
    .replace(/^name: prop_portfolio$/m, 'name: prop_old').replace(/^strategies: \[[^\]\n]*\]/m, `strategies: [${NAMES.join(', ')}]`);
  fs.mkdirSync(path.join(dir, 'prop_old'));
  fs.writeFileSync(path.join(dir, 'prop_old', 'STRATEGY.md'), doc);
  // Listed in its account's rulebook (a plugin root with the accounts copied), so only its list can make it invalid.
  const loaded = loadStrategies(rootWithPolicies({ prop_old: SHIPPED.find(s => s.name === 'prop_portfolio').account }), { FTH_STRATEGIES_DIRS: dir }).strategies.find(s => s.name === 'prop_old');
  assert.strictEqual(loaded.valid, false);
  for (const n of NAMES) assert.ok(loaded.errors.some(e => new RegExp(`strategies: ${n} is not a strategy \\(retired on ${DATE(n)}`).test(e)), `${n}: ${loaded.errors.join('; ')}`);
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
    assert.ok(errs.some(e => new RegExp(`the ${n} strategy was retired on ${DATE(n)}`).test(e)), errs.join('; '));
  }
  // A backtest asked for one: refused, saying it was retired.
  for (const n of NAMES) {
    assert.throws(() => runBacktest({ symbols: ['MNQ'], timeframe: 3, data: { MNQ: path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv') }, strategies: [n], gate: false, outDir: dir }, { root: ROOT, outRoot: dir }),
      new RegExp(`unknown strategy "${n}" \\(retired on ${DATE(n)}`), n);
  }
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
  // A fixture strategy (fx_orb, fx_ofi) stands in for one still live beside it.
  const cfg = cfgWith([{ timeframe: 3, trigger: 'bar', strategies: ['bos', 'fx_orb'] }, { timeframe: 1, trigger: 'signal', strategies: ['fx_ofi'] }]);
  assert.deepStrictEqual(startErrors(cfg, FX, agents), [], 'no refusal at start');
  assert.deepStrictEqual(cfg.lanes[0].retired, ['bos']);
  assert.strictEqual(cfg.lanes[1].retired, undefined, 'the other lane trades as before');
  // The lane scans nothing (not even fx_orb, listed beside it): no setup fires, no policy verdict.
  assert.deepStrictEqual(laneStrategies(FX, cfg.lanes[0]), []);
  assert.ok(laneStrategies(FX, cfg.lanes[1]).some(x => x.name === 'fx_ofi'));
  assert.deepStrictEqual(laneStrategyErrors(cfg.lanes, FX), []);
  assert.match(describeLane(cfg.lanes[0], FX), /lists bos \(retired on 2026-10-13: strategies\/README\.md, "Retired strategies"\): this lane enters nothing .*open position's management go on/);
  // Each name retired on 2026-10-14 retires its lane the same way, said with its date.
  for (const n of NEW) {
    const one = cfgWith([{ timeframe: 3, trigger: 'bar', strategies: [n, 'fx_orb'] }]);
    assert.deepStrictEqual(startErrors(one, FX, agents), [], n);
    assert.deepStrictEqual(one.lanes[0].retired, [n]);
    assert.deepStrictEqual(laneStrategies(FX, one.lanes[0]), [], n);
    assert.match(describeLane(one.lanes[0], FX), new RegExp(`lists ${n} \\(retired on 2026-10-14: strategies/README\\.md, "Retired strategies"\\): this lane enters nothing`), n);
  }
  // A retired policy-only signal lane is no refusal either (it cycles only to manage).
  for (const n of ['supertrend', 'ofi', 'prop_flow_1m']) {
    const sig = cfgWith([{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'signal', strategies: [n] }]);
    assert.deepStrictEqual(startErrors(sig, SHIPPED, agents), [], n);
    assert.deepStrictEqual(signalLaneErrors(sig.lanes, SHIPPED), [], n);
    assert.deepStrictEqual(sig.lanes[1].retired, [n]);
  }
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
  const pre = laneChecks(cfgWith([{ timeframe: 3, trigger: 'bar', strategies: ['keltner', 'fx_orb'] }]), FX);
  const row = pre.find(x => x.check === 'retired strategies in lanes');
  assert.ok(row && row.status === 'fail', JSON.stringify(pre));
  assert.match(row.detail, /lanes\[0\] \(3m\) lists keltner \(retired on 2026-10-13/);
  const pre14 = laneChecks(cfgWith([{ timeframe: 3, trigger: 'bar', strategies: ['orb', 'vwap_reclaim'] }]), FX).find(x => x.check === 'retired strategies in lanes');
  assert.ok(pre14 && pre14.status === 'fail');
  assert.match(pre14.detail, /lanes\[0\] \(3m\) lists orb \(retired on 2026-10-14: .*\), vwap_reclaim \(retired on 2026-10-14: /);
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

/** A runner over 10:00-10:12 ET on one 3m lane (`lanes`), its account `account` holding `positions`; what it did. */
async function runLane({ lanes, account = '7', positions = [] }) {
  const DAY = Date.UTC(2026, 9, 7);
  const et = (h, m, sec = 0) => DAY + ((h + 4) * 60 + m) * 60000 + sec * 1000;
  const iso = ms => new Date(ms).toISOString();
  const clockRef = { t: et(9, 59, 50) };
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', account, symbols: ['MNQ'], lanes });
  assert.deepStrictEqual(startErrors(cfg, FX, loadAgents(ROOT)), []);
  const cycles = [];
  const logs = [];
  const client = {
    async activeContract() { return { id: 'MNQ', tickSize: 0.25 }; },
    async closedBars(contractId, { minutes, limit }) {
      const step = minutes * 60000;
      const lastOpen = Math.floor((clockRef.t - 1000) / step) * step - step;
      return Array.from({ length: Math.min(limit, 5) }, (_, k) => ({ t: iso(lastOpen - (4 - k) * step), o: 21500, h: 21501, l: 21499, c: 21500, v: 1 }));
    },
    async accountState() { return { positions, orders: [] }; },
    async netPosition() { return positions.length; },
    async workingOrders() { return 0; },
    async modifyStop() {},
    async closePosition() {},
    async cancelOrder() {},
  };
  const runner = createRunner({
    cfg, root: '/r', client, clock: { now: () => new Date(clockRef.t) },
    runCycle: async action => { cycles.push(action); return { ok: true, timedOut: false }; },
    isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => null, saveState: () => {}, writeBars: () => '/b.json',
    scanFor: (symbol, bars, lane) => runnerScan(FX, cfg, symbol, bars, new Date(clockRef.t), lane || undefined),
    entryOrders: () => [], strategyNamed: () => null, event: () => {}, log: (m, level) => logs.push({ m, level }),
  });
  while (clockRef.t < et(10, 12)) clockRef.t += await runner.step();
  return { cycles, logs };
}

test('a retired lane runs no cycle per bar while flat (it enters nothing); the same lane without the retired name does', async () => {
  for (const n of ['bos', 'orb']) {
    const retired = await runLane({ lanes: [{ timeframe: 3, trigger: 'bar', strategies: [n, 'fx_orb'] }] });
    assert.strictEqual(retired.cycles.length, 0, `${n}: flat: nothing to manage, nothing to enter`);
  }
  const plain = await runLane({ lanes: [{ timeframe: 3, trigger: 'bar', strategies: ['fx_orb'] }] });
  assert.ok(plain.cycles.length >= 3, `a bar lane cycles every bar: ${plain.cycles.length}`);
});

test('an open position on a retired lane with no account configured gets a manage cycle every bar, said as such', async () => {
  const pos = [{ id: 77, contractId: 'MNQ', type: 1, size: 1, averagePrice: 21500, creationTimestamp: '2026-10-07T13:59:55.000Z' }];
  const r = await runLane({ lanes: [{ timeframe: 3, trigger: 'bar', strategies: ['bos'] }], account: '', positions: pos });
  const plain = await runLane({ lanes: [{ timeframe: 3, trigger: 'bar', strategies: ['fx_orb'] }], account: '', positions: pos });
  assert.ok(r.cycles.length >= 3 && r.cycles.length === plain.cycles.length, `retired ${r.cycles.length} vs plain ${plain.cycles.length}`);
  assert.ok(r.logs.some(l => /cycle \(manage only: this lane lists a retired strategy and enters nothing; no account is configured to see positions, so every bar\)/.test(l.m)), JSON.stringify(r.logs.map(l => l.m).slice(0, 8)));
  assert.ok(!r.logs.some(l => /cap reached/.test(l.m)), 'no misleading reason');
});

test('a retired lane listing policies is no refusal even where the policies list leaves out one with a running attempt', () => {
  const agents = loadAgents(ROOT);
  // A user's 1m policy (no 1m policy ships since prop_flow_1m retired) over the fixture fx_ofi, with a running attempt.
  const flow = { name: 'fx_flow', valid: true, errors: [], signal: 'policy', status: 'active', timeframe: '1m', instruments: ['MNQ'], account: 'mini', strategies: ['fx_ofi'] };
  const registry = [...FX, flow];
  const { omittedPolicyErrors } = require('../../scripts/lib/lanes');
  // A 1m lane listing only a retired name under policies (bos; prop_flow_1m itself): fx_flow is left out of it.
  for (const n of ['bos', 'prop_flow_1m']) {
    const cfg = cfgWith([{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'signal', policies: [n] }]);
    assert.deepStrictEqual(startErrors(cfg, registry, agents, () => true), [], n);
    assert.deepStrictEqual(cfg.lanes[1].retired, [n]);
    // The omission check itself still holds for a lane that isn't retired (its policies list leaving fx_flow out).
    const plain = cfgWith([{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'signal', policies: [n] }]);
    assert.match(omittedPolicyErrors(plain, registry, () => true).join(), /lanes\[1\]\.policies: leaves out fx_flow/, `${n}: before retireLanes marks it`);
  }
});

test('the gate refuses any entry, of any strategy kind, on a timeframe whose runner lane is retired; exits still go', () => {
  const { buildSignals, writeSignals } = require('../../scripts/lib/trading/signal-state');
  const { laneSignals } = require('../../scripts/lib/runner-wiring');
  const home = trendHome();
  const config = { ...loadConfig({}), killSwitchFile: '/nonexistent/fth/STOP', home, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9 };
  const manual = { name: 'disc', valid: true, errors: [], status: 'active', signal: 'manual', instruments: ['MNQ'], timeframe: '3m', sessions: [], compiledRules: null };
  const registry = [...FX, manual];
  const entry = tag => evaluateOrder({ input: entryOrder({ rationale: `setup:${tag} long, stop 21480` }), entries: [plan()], now: NOW, config, strategies: registry });
  const bar = { t: '2026-10-07T13:57:00.000Z' };
  // The runner's record of a retired lane's bar carries the mark (laneSignals: the wiring's record).
  assert.strictEqual(laneSignals(cfgWith([{ timeframe: 3, trigger: 'bar', strategies: ['fx_orb'] }]), { symbol: 'MNQ', bar, minutes: 3, lane: 0 }, [], NOW).retiredLane, undefined);
  assert.ok(!entry('disc').violations.some(x => x.check === 'retired-lane'), 'no mark yet: a manual entry is not refused for it');
  for (const n of ['bos', 'orb']) {
    const cfg = cfgWith([{ timeframe: 3, trigger: 'bar', strategies: [n] }]);
    retireLanes(cfg, registry);
    const rec = laneSignals(cfg, { symbol: 'MNQ', bar, minutes: 3, lane: 0 }, [], NOW);
    assert.deepStrictEqual(rec.retiredLane, [n]);
    writeSignals(home, rec);
    for (const tag of ['disc', 'fx_orb', 'prop_portfolio']) {
      const v = entry(tag).violations.find(x => x.check === 'retired-lane');
      assert.ok(v, `${n} ${tag}: ${JSON.stringify(entry(tag).violations)}`);
      assert.match(v.message, new RegExp(`the runner's 3m lane lists ${n} \\(retired on ${DATE(n)}.*that lane enters nothing, under any setup tag`));
    }
  }
  const exit = evaluateOrder({ input: entryOrder({ side: 'sell', rationale: '[exit] close the long', stopLossBracket: undefined }), entries: [], now: NOW, config, strategies: registry });
  assert.deepStrictEqual(exit.violations, []);
  // The lane's next record without the mark (the config fixed) clears it.
  writeSignals(home, buildSignals([], { symbol: 'MNQ', bar, stepMs: 180000, now: NOW }));
  assert.ok(!entry('disc').violations.some(x => x.check === 'retired-lane'));
});

test('a user\'s own strategy under a retired name is named at the runner\'s start and in preflight (a warning), and still loads', () => {
  const { wireRunner } = require('../../scripts/lib/runner-wiring');
  const own = tmpDir();
  fs.mkdirSync(path.join(own, 'ema_cross'));
  fs.writeFileSync(path.join(own, 'ema_cross', 'STRATEGY.md'), fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'strategies-fx', 'fx_cross', 'STRATEGY.md'), 'utf8').replace(/^name: fx_cross$/m, 'name: ema_cross'));
  const env = { FTH_STRATEGIES_DIRS: own };
  const mine = loadStrategies(ROOT, env).strategies;
  assert.ok(mine.find(s => s.name === 'ema_cross').valid, 'it loads');
  const file = path.join(own, 'ema_cross', 'STRATEGY.md');
  const row = laneChecks(cfgWith([{ timeframe: 3, trigger: 'bar' }]), mine).find(x => x.check === 'retired-name copies');
  assert.ok(row && row.status === 'warn', 'preflight warns');
  assert.ok(row.detail.includes(`ema_cross (${file}) is your own strategy under a name retired on 2026-10-13`), row.detail);
  assert.strictEqual(laneChecks(cfgWith([{ timeframe: 3, trigger: 'bar' }]), SHIPPED).find(x => x.check === 'retired-name copies'), undefined);
  const home = tmpDir();
  const logs = [];
  wireRunner({ cfg: cfgWith([{ timeframe: 3, trigger: 'bar' }]), root: ROOT, home, env: { ...env, FTH_HOME: home }, client: {}, dataDir: path.join(home, 'bars'), now: () => NOW,
    runCycle: async () => ({ ok: true }), loadState: () => null, saveState: () => {}, killSwitchFile: path.join(home, 'STOP'), log: (m, level) => logs.push({ m, level }), event: () => {} });
  assert.ok(logs.some(l => l.level === 'error' && l.m.includes(`ema_cross (${file}) is your own strategy under a name retired`)), JSON.stringify(logs));
});

/** The runner wired at start (runner-wiring.js wireRunner) on `home` with `lanes`: its log lines. */
function startRunner(home, lanes) {
  const { wireRunner } = require('../../scripts/lib/runner-wiring');
  const logs = [];
  wireRunner({ cfg: cfgWith(lanes), root: ROOT, home, env: { ...FX_ENV, FTH_HOME: home }, client: {}, dataDir: path.join(home, 'bars'), now: () => NOW,
    runCycle: async () => ({ ok: true }), loadState: () => null, saveState: () => {}, killSwitchFile: path.join(home, 'STOP'), log: (m, level) => logs.push({ m, level }), event: () => {} });
  return logs;
}

test('at the runner\'s start, before any cycle, a retired lane\'s timeframe is marked: an older unmarked record\'s fresh candidate can\'t pass', () => {
  const { buildSignals, writeSignals, readSignals } = require('../../scripts/lib/trading/signal-state');
  const home = trendHome();
  const config = { ...loadConfig({}), killSwitchFile: '/nonexistent/fth/STOP', home, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9 };
  // The record from before the upgrade: fx_orb fired long on the last 3m bar, no mark.
  writeSignals(home, buildSignals([{ name: 'fx_orb', direction: 'long', candidate: true, signal: 'rules', stopDistance: 5 }], { symbol: 'MNQ', bar: { t: '2026-10-07T13:57:00.000Z' }, stepMs: 180000, now: NOW }));
  const orb = () => evaluateOrder({ input: entryOrder({ rationale: 'setup:fx_orb long, stop 21480' }), entries: [plan()], now: NOW, config, strategies: FX }).violations;
  assert.ok(!orb().some(v => v.check === 'retired-lane'), 'no mark before the start');
  const logs = startRunner(home, [{ timeframe: 3, trigger: 'bar', strategies: ['bos', 'fx_orb'] }]);
  const rec = readSignals(home, 'MNQ', '3m');
  assert.deepStrictEqual([rec.retiredLane, rec.candidates], [['bos'], []]);
  const v = orb().find(x => x.check === 'retired-lane');
  assert.ok(v, JSON.stringify(orb()));
  assert.match(v.message, /To trade on 3m again, remove the retired name from the runner config's lanes \(or the lane\) and restart the runner: its start clears this mark\./);
  assert.ok(logs.some(l => l.level === 'error' && /signal record 3m: marked: its runner lane lists bos \(retired\), so no entry on 3m/.test(l.m)), JSON.stringify(logs));
  // No record yet on a retired timeframe: one is written with the mark.
  const fresh = trendHome();
  const before = readSignals(fresh, 'MNQ', '3m');
  assert.strictEqual(readSignals(fresh, 'MNQ', '1m'), null);
  startRunner(fresh, [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'signal', strategies: ['supertrend'] }]);
  assert.deepStrictEqual(readSignals(fresh, 'MNQ', '1m').retiredLane, ['supertrend']);
  assert.deepStrictEqual(readSignals(fresh, 'MNQ', '3m'), before, 'a timeframe with no retired lane is left alone');
});

test('a mark left by a lane since deleted or fixed is cleared at the runner\'s start; one the runner can\'t write turns the kill switch on', () => {
  const { buildSignals, writeSignals, readSignals } = require('../../scripts/lib/trading/signal-state');
  const home = trendHome();
  const config = { ...loadConfig({}), killSwitchFile: '/nonexistent/fth/STOP', home, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9 };
  writeSignals(home, buildSignals([], { symbol: 'MNQ', bar: { t: '2026-10-07T13:59:00.000Z' }, stepMs: 60000, now: NOW, retiredLane: ['keltner'] }));
  const manual = { name: 'disc1', valid: true, errors: [], status: 'active', signal: 'manual', instruments: ['MNQ'], timeframe: '1m', sessions: [], compiledRules: null };
  const entry = () => evaluateOrder({ input: entryOrder({ rationale: 'setup:disc1 long, stop 21480' }), entries: [plan()], now: NOW, config, strategies: [...SHIPPED, manual] }).violations;
  assert.ok(entry().some(v => v.check === 'retired-lane'), 'marked');
  // The 1m lane was deleted from the config: the start clears the mark.
  const logs = startRunner(home, [{ timeframe: 3, trigger: 'bar' }]);
  assert.strictEqual(readSignals(home, 'MNQ', '1m').retiredLane, undefined);
  assert.ok(!entry().some(v => v.check === 'retired-lane'), 'cleared');
  assert.ok(logs.some(l => /signal record 1m: retired-lane mark cleared/.test(l.m)));
  // Another family's records are not the runner's: left as they are.
  writeSignals(home, buildSignals([], { symbol: 'MES', bar: { t: '2026-10-07T13:59:00.000Z' }, stepMs: 60000, now: NOW, retiredLane: ['bos'] }));
  startRunner(home, [{ timeframe: 3, trigger: 'bar' }]);
  assert.deepStrictEqual(readSignals(home, 'MES', '1m').retiredLane, ['bos']);
  // The marks can't be written (signals/ is a file): the kill switch goes on, so no entry slips through.
  const broken = tmpDir();
  fs.writeFileSync(path.join(broken, 'signals'), 'not a folder');
  const bad = startRunner(broken, [{ timeframe: 3, trigger: 'bar', strategies: ['bos'] }]);
  assert.ok(bad.some(l => l.level === 'error' && /retired-lane signal marks could not be written .*kill switch on/.test(l.m)), JSON.stringify(bad));
  assert.match(fs.readFileSync(path.join(broken, 'STOP'), 'utf8'), /retired-lane signal marks not written/);
});

test('order_plan refuses each retired name, saying it was retired; a fixture under another name still plans', () => {
  const { plan: orderPlan } = require('../../scripts/lib/harness-tools/order-plan');
  const home = tmpDir();
  const ctx = { root: ROOT, env: { ...FX_ENV, FTH_HOME: home }, now: () => NOW, tool: true };
  for (const n of NAMES) {
    assert.throws(() => orderPlan({ file: path.join(home, 'none.json'), symbol: 'MNQ', strategy: n, side: 'long' }, ctx), new RegExp(`unknown strategy "${n}" \\(retired on ${DATE(n)}: strategies/README\\.md, "Retired strategies"\\)`), n);
  }
  // fx_orb (the orb rules under a fixture name) is a known strategy: refused only for the bars (none here), not as retired.
  assert.throws(() => orderPlan({ file: path.join(home, 'none.json'), symbol: 'MNQ', strategy: 'fx_orb', side: 'long' }, ctx), err => !/retired|unknown strategy/.test(err.message));
});

test('the shipped prop_portfolio is active with no components: the gate refuses its entry (no verdict, no setup); its exit and stop still go', () => {
  const policy = SHIPPED.find(s => s.name === 'prop_portfolio');
  assert.deepStrictEqual([policy.valid, policy.status, policy.signal, policy.strategies], [true, 'active', 'policy', []]);
  const { accounts } = require('../../scripts/lib/trading/accounts').loadAccounts(ROOT, {});
  const account = accounts.find(a => a.name === policy.account);
  assert.ok(account && account.valid, `its account loads: ${policy.account}`);
  const home = trendHome();
  const config = { ...loadConfig({}), killSwitchFile: '/nonexistent/fth/STOP', home, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9 };
  const order = rationale => evaluateOrder({ input: entryOrder({ rationale }), entries: [plan()], now: NOW, config, strategies: SHIPPED, accounts });
  const noVerdict = /setup:prop_portfolio: no verdict for MNQ \(it lists no strategies, so it has no setups and no verdicts: no entry\)/;
  const check = label => {
    const r = order('setup:prop_portfolio long, stop 40 ticks');
    assert.strictEqual(r.intent, 'entry');
    const v = r.violations.find(x => x.check === 'policy');
    assert.ok(v, `${label}: ${JSON.stringify(r.violations)}`);
    assert.match(v.message, noVerdict, label);
    // Naming a component in the rationale changes nothing: still no verdict.
    const named = order('setup:prop_portfolio fx_break long, stop 40 ticks');
    assert.ok(named.violations.some(x => x.check === 'policy' && noVerdict.test(x.message)), `${label}: ${JSON.stringify(named.violations)}`);
    // Risk-reducing orders go: the [exit] and the [protect] stop of a position it holds.
    const exit = evaluateOrder({ input: entryOrder({ side: 'sell', rationale: '[exit] close the prop_portfolio long', stopLossBracket: undefined }), entries: [], now: NOW, config, strategies: SHIPPED, accounts });
    assert.deepStrictEqual([exit.intent, exit.violations], ['risk-reducing', []], label);
    const stop = evaluateOrder({ input: entryOrder({ side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the prop_portfolio long', stopLossBracket: undefined }), entries: [], now: NOW, config, strategies: SHIPPED, accounts });
    assert.deepStrictEqual(stop.violations, [], label);
  };
  check('no attempt');
  // With its attempt running and the budget known: still refused for no verdict (it fails closed, never sizes a guess).
  prop.startAttempt(home, account, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, account, account.starting_balance, new Date(NOW.getTime() - 60000));
  check('attempt running');
  // A stale verdict on file from before the retirement (its component retired) is refused as well.
  prop.appendVerdict(home, {
    strategy: 'prop_portfolio', component: 'orb', contractId: CONTRACT, symbol: 'MNQ', contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40,
    maxSize: 1, bar: '2026-10-07T13:57:00Z', at: '2026-10-07T13:59:30Z', expiresAt: new Date(NOW.getTime() + 120000).toISOString(),
  });
  const stale = order('setup:prop_portfolio orb long, stop 40 ticks');
  assert.ok(stale.violations.some(v => /the latest verdict's setup is from orb: orb is not one of prop_portfolio's strategies/.test(v.message)), JSON.stringify(stale.violations));
});
