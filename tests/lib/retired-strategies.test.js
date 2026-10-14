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
const { laneStrategyErrors } = require('../../scripts/lib/lanes');
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
  // A lanes config: refused at start, naming the retirement.
  const errors = laneStrategyErrors([{ timeframe: 3, strategies: ['bos', 'orb'] }], SHIPPED);
  assert.deepStrictEqual(errors, ['lanes[0].strategies: no strategy named bos (retired on 2026-10-13: strategies/README.md, "Retired strategies")']);
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
