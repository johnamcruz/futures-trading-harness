'use strict';

// Near-target sizing (owner-approved 2026-10-28): once the profit a pass still needs is at most the rulebook's
// sizing.near_target_usd, a prop trade is the floor (min_contracts), never more: combine.nearTarget, applied by the size
// translation (prop/size-translate.js translateSize, live and the gate) and limitPlan (the attempt simulator, the
// backtester); phase 2's `target` cut reads the same band (prop/phase2-cut.js).

const test = require('node:test');
const assert = require('node:assert');
const prop = require('../../scripts/lib/trading/prop-state');
const combine = require('../../scripts/lib/trading/combine');
const RB = require('../../scripts/lib/trading/rulebook');
const { translateSize, limitPlan } = require('../../scripts/lib/prop/size-translate');
const { trendHome, testSizing } = require('../helpers');

const NOW = new Date('2026-10-07T14:00:02Z');
// A $3,000 target, no consistency rule: the pass needs 3000 - profit.
const MINI = {
  name: 'mini', valid: true, errors: [], starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod',
  daily_loss_limit: 1000, daily_loss_soft: 500, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 },
};
const specOf = r => (r === 'MNQ' || r === 'NQ' ? { tickSize: 0.25, tickValue: r === 'NQ' ? 5 : 0.5 } : null);
const policy = (sizing = {}) => ({ name: 'prop_portfolio', valid: true, signal: 'policy', account: 'mini', contracts: 'micro', sizing: testSizing({ min_contracts: 3, near_target_usd: 500, ...sizing }), multipliers: [] });
const verdict = (extra = {}) => ({ strategy: 'prop_portfolio', action: 'full', multiplier: 1, contract: 'MNQ', stopTicks: 40, maxSize: 18, ...extra });
// Yesterday closed at `balance`, today flat: the profit is balance - 50000, the floor trails to balance - 2000 (a $2,000
// cushion, 0.2 x = $400 a trade, 18 MNQ at $21.24 all in).
function home(balance) {
  const h = trendHome();
  prop.startAttempt(h, MINI, new Date(NOW.getTime() - 2 * 86400000));
  prop.recordEndOfDay(h, MINI, balance, '2026-10-06');
  prop.snapshot(h, MINI, balance, new Date(NOW.getTime() - 60000));
  return h;
}
const T = (balance, o = {}) => translateSize({ suggested: 1, home: home(balance), root: o.root || 'MNQ', policy: o.policy || policy(), account: MINI, verdict: o.verdict || verdict(), capUsd: o.capUsd ?? 1000, perContract: o.perContract ?? 21.24, specOf, selected: [o.root || 'MNQ'] });

test('combine.nearTarget: at or under the band is near; over it, a band of 0 (off) or an unreadable state is not', () => {
  const s = needed => ({ ...combine.start(MINI), balance: 50000 + 3000 - needed, days: [3000 - needed], dayPnl: 0 });
  assert.deepStrictEqual([501, 500, 100, 0].map(n => combine.neededOf(s(n))), [501, 500, 100, 0]);
  assert.deepStrictEqual([501, 500.01, 500, 100].map(n => combine.nearTarget(s(n), { near_target_usd: 500 })), [false, false, true, true]);
  assert.strictEqual(combine.nearTarget(s(100), { near_target_usd: 0 }), false, 'off');
  for (const bad of [null, {}, { ...s(100), days: null }, { ...s(100), dayPnl: undefined }]) assert.strictEqual(combine.nearTarget(bad, { near_target_usd: 500 }), false);
});

test('translateSize near the target: needed 501 is full, 500 and 100 the floor; never above the verdict; a floor that doesn\'t fit the cap is a skip', () => {
  assert.strictEqual(T(52499).size, 18, 'needed 501: full');
  for (const b of [52500, 52900]) {
    const t = T(b);
    assert.deepStrictEqual([t.size, t.skip], [3, undefined], String(b));
    assert.match(t.reason, /3 MNQ \(near the target: the floor \(sizing\.near_target_usd \$500\.00\)\)/);
  }
  // Off: full to the target.
  assert.strictEqual(T(52900, { policy: policy({ near_target_usd: 0 }) }).size, 18);
  // Never above the verdict: a verdict of 3 stays 3; a verdict under the floor stays a skip, never sized up to it.
  assert.strictEqual(T(52900, { verdict: verdict({ maxSize: 3 }) }).size, 3);
  assert.ok(T(52900, { verdict: verdict({ maxSize: 2 }) }).skip);
  // The floor doesn't fit the cap ($50 at $21.24: 2): a skip, as today (the floor stretch off).
  const capped = T(52900, { capUsd: 50 });
  assert.ok(capped.skip, capped.reason);
  assert.match(capped.reason, /under the floor of 3 contracts/);
  // The mini: the floor in its own contracts (3 micro-equivalents: 1 NQ).
  assert.strictEqual(T(52900, { root: 'NQ', policy: { ...policy(), contracts: 'mini' }, verdict: verdict({ contract: 'NQ', maxSize: 2 }), perContract: 212.8 }).size, 1);
});

test('limitPlan (the attempt simulator, the backtester) near the target: the floor, never more; off or far: as before', () => {
  const st = needed => ({ ...combine.start(MINI), balance: 53000 - needed, days: [3000 - needed], dayPnl: 0, lossesToday: 0 });
  const plan = { size: 18, root: 'MNQ', riskPerContract: 21.24 };
  const lp = (needed, o = {}) => limitPlan(plan, { limits: o.limits === undefined ? { capUsd: 1000, orderMax: null } : o.limits, minContracts: 3, ratio: 10, miniRoot: 'NQ', stretchUsd: 0, state: st(needed), nearTargetUsd: o.band ?? 500 });
  assert.strictEqual(lp(501).size, 18);
  assert.strictEqual(lp(500).size, 3);
  assert.strictEqual(lp(100).size, 3);
  assert.strictEqual(lp(100, { limits: null }).size, 3, 'without live limits too');
  assert.strictEqual(lp(100, { band: 0 }).size, 18, 'off');
  assert.strictEqual(lp(100, { limits: { capUsd: 50, orderMax: null } }), null, 'the floor over the cap: a skip');
  const small = limitPlan({ ...plan, size: 2 }, { limits: null, minContracts: 1, ratio: 10, state: st(100), nearTargetUsd: 500 });
  assert.strictEqual(small.size, 1, 'a floor of 1: 1');
  assert.strictEqual(limitPlan({ ...plan, size: 3 }, { limits: null, minContracts: 3, ratio: 10, state: st(100), nearTargetUsd: 500 }).size, 3, 'never above the plan');
});

test('parity: the attempt simulator (prop/attempts.js defaultSize) sizes as the live translation, near the target and far from it', () => {
  const at = require('../../scripts/lib/prop/attempts');
  const pol = policy({ cap_usd: 0 });
  for (const balance of [50000, 52499, 52500, 52900]) {
    const h = home(balance);
    const r = prop.readAttempt(h, MINI.name);
    const cs = prop.stateFrom(MINI, r, r.snapshot.balance);
    const { legs, ratio } = at.legsFor(MINI, 'MNQ', { tickValue: 0.5 });
    const sim = at.defaultSize({ cs, trade: { stopTicks: 40 }, sizing: pol.sizing, legs, mode: 'micro', ratio, fraction: 1, limits: { capUsd: 1000, orderMax: null }, lossesToday: 0 });
    const live = translateSize({ suggested: 1, home: h, root: 'MNQ', policy: pol, account: MINI, verdict: verdict({ maxSize: 50 }), capUsd: 1000, perContract: 21.24, specOf, selected: ['MNQ'] });
    assert.strictEqual(sim ? sim.size : 0, live.skip ? 0 : live.size, `${balance}: ${live.reason}`);
    assert.strictEqual(sim.size === 3, balance >= 52500, String(balance));
  }
});

test('the rulebook states near_target_usd for every policy (dollars above 0, or off) and the loader refuses it missing or invalid', () => {
  assert.ok(combine.SIZING_KEYS.includes('near_target_usd'));
  assert.ok(RB.SIZING_RULES.near_target_usd[0](500) && RB.SIZING_RULES.near_target_usd[0]('off'));
  for (const bad of [0, -1, 'none', null, '500']) assert.ok(!RB.SIZING_RULES.near_target_usd[0](bad), JSON.stringify(bad));
  // The shipped rulebook: $500 on the account prop_portfolio trades.
  const ROOT = require('path').resolve(__dirname, '..', '..');
  const acct = require('../../scripts/lib/trading/strategies').loadStrategies(ROOT, {}).strategies.find(x => x.name === 'prop_portfolio').account;
  const book = RB.loadRulebookFile(require('path').join(ROOT, 'accounts', acct, RB.FILE));
  assert.ok(book.valid !== false, JSON.stringify(book.errors));
  assert.strictEqual(RB.policyEntry(book, 'prop_portfolio').sizing.near_target_usd, 500);
  // A missing or invalid key refuses the rulebook, naming it.
  const sizing = { ...book.policies.prop_portfolio.sizing };
  const errs = s => RB.validateRulebook({ ...book, policies: { prop_portfolio: { ...book.policies.prop_portfolio, sizing: s } } }, book.body || '## When to Use\n## How It Works\n## Examples', acct);
  const { near_target_usd: _drop, ...without } = sizing;
  assert.ok(errs(without).some(e => /policies\.prop_portfolio\.sizing\.near_target_usd: missing/.test(e)), errs(without).join('; '));
  assert.ok(errs({ ...sizing, near_target_usd: 0 }).some(e => /near_target_usd: 0 is not dollars above 0, or off/.test(e)));
  assert.ok(!errs(sizing).some(e => /near_target_usd/.test(e)));
});
