'use strict';

// The goal regression's sizing check (scripts/lib/eval/goal-sizing.js): every tier 2 entry sized as the rulebook plans
// it, recomputed from the day's own facts, and the simulator agreeing.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const GS = require('../../scripts/lib/eval/goal-sizing');
const GT = require('../../scripts/lib/eval/goal-trades');
const { accountNamed } = require('../../scripts/lib/trading/accounts');

const ROOT = path.resolve(__dirname, '..', '..');
const P = GT.shippedOf(ROOT, {});
const ACCOUNT = accountNamed(ROOT, P.policy.account, {});
const DAY = '2022-09-01';
const ID = '017fe31d092aa60a';
const at = (hm, s = 2) => `${DAY}T${hm}:0${s}.000Z`;

/**
 * A tier 2 day's result as tests/goal/tier2-day.js writes it, trimmed to what the check reads: one short at market,
 * `size` MNQ with a `ticks` stop, filled and stopped (or open); `before`: a round trip closed earlier that day (its gross).
 */
function dayOf({ ticks = 167, size = 3, translated = size, approved = size, before = null, records = [], prior = [] } = {}) {
  const fills = [];
  const orders = [];
  if (before !== null) {
    fills.push({ id: 1, orderId: 1, creationTimestamp: at('13:36'), price: 15500, profitAndLoss: null, fees: 1.11, side: 1, size: 3 });
    fills.push({ id: 2, orderId: 2, creationTimestamp: at('13:42'), price: 15500, profitAndLoss: before, fees: 1.11, side: 0, size: 3 });
  }
  orders.push({ id: 100, contractId: 'fake:MNQ:Z26', creationTimestamp: at('13:51'), status: 2, type: 2, side: 1, size, filledPrice: 15484.5, customTag: 'fth-x', parentId: null, brackets: { stop: ticks, target: 2 * ticks } });
  orders.push({ id: 103, contractId: 'fake:MNQ:Z26', creationTimestamp: at('13:51'), status: 2, type: 4, side: 0, size, parentId: 100 });
  fills.push({ id: 101, orderId: 100, creationTimestamp: at('13:51'), price: 15484.5, profitAndLoss: null, fees: 0.37 * size, side: 1, size });
  fills.push({ id: 105, orderId: 103, creationTimestamp: at('14:00'), price: 15484.5 + ticks * 0.25, profitAndLoss: -ticks * 0.5 * size, fees: 0.37 * size, side: 0, size });
  const rationale = `setup:prop_portfolio short trade_lifecycle, ${size} MNQ, record ${ID}`;
  return {
    day: DAY, tick: 0.25,
    sizing: { symbol: 'MNQ', selected: ['MNQ'], orderMax: 50 },
    attempt: { days: prior },
    fills, orders,
    calls: [{ tool: 'place_order', args: { size, rationale, customTag: 'fth-x' } }],
    gate: [{ source: 'gateway', tool: 'place_order', decision: 'allowed', violations: [], rationale }],
    records: [{ id: ID, at: at('13:51'), ok: true, side: 'short', cycleBar: `${DAY}T13:48:00.000Z`, plan: { stop: { ticks }, target: { ticks: 2 * ticks } }, problems: [] }, ...records],
    cycles: [{ entry: { record: ID, size: { translated, approved, ordered: approved }, translated: { size: translated } } }],
    decisions: [], events: [],
  };
}
const ctx = d => GS.ctxOf(d, P, ACCOUNT);
const withSims = d => ({ ...d, simSizes: GS.simSizes(d, ctx(d)) });
const problems = d => GS.sizingChecks(d, ctx(d));

test('roundTrips and stateAt: the day\'s closed trades from its fills (gross, every fill\'s fee), the state just before a moment', () => {
  const d = dayOf({ before: -60 });
  assert.deepStrictEqual(GS.roundTrips(d).map(x => [x.gross, x.net]), [[-60, -62.22], [-250.5, -252.72]]);
  const s = GS.stateAt(d, ACCOUNT, Date.parse(at('13:51')));
  assert.deepStrictEqual([s.cs.balance, s.lossesToday], [ACCOUNT.starting_balance - 62.22, 1]);
  // A state day: the attempt's earlier closed day (its closing balance) is in the state.
  const prior = GS.stateAt(dayOf({ prior: [{ day: '2022-08-31', balance: ACCOUNT.starting_balance - 1500 }] }), ACCOUNT, Date.parse(at('13:51')));
  assert.deepStrictEqual([prior.cs.balance, prior.cs.days.length, prior.lossesToday], [ACCOUNT.starting_balance - 1500, 1, 0]);
});

test('sizingChecks: a fill at the rulebook\'s plan passes; another size, a translation off the plan, or no simulator size is a problem', () => {
  // 167 ticks: (167 + 1) x $0.50 + $0.74 = $84.74 a contract all in; the $300 cap fits 3, the floor.
  assert.deepStrictEqual(problems(withSims(dayOf())), []);
  assert.match(problems(withSims(dayOf({ size: 2, translated: 2 }))).join('\n'), /filled 2, the rulebook's plan at the 167-tick stop is 3 MNQ[\s\S]*under the floor of 3/);
  assert.match(problems(withSims(dayOf({ size: 4, translated: 4 }))).join('\n'), /4 MNQ risk \$338\.96 all in, over the \$300 cap and not exactly the floor/);
  assert.match(problems(withSims(dayOf({ translated: 4 }))).join('\n'), /the runner translated 4, the rulebook's plan is 3 MNQ/);
  assert.match(problems(dayOf()).join('\n'), /no simulator size recorded/);
  // Phase 2's recorded cut (approved under the translated size) is the fill: no size problem but the floor's.
  const cut = problems(withSims(dayOf({ ticks: 60, size: 4, translated: 9, approved: 4 })));
  assert.deepStrictEqual(cut, []);
});

test('sizingChecks: 30 points sizes 4 MNQ; the simulator\'s old no-fallback skip is named; a stretch only exactly the floor while healthy', () => {
  // 120 ticks: $61.24 a contract, the cap 4.
  assert.deepStrictEqual(problems(withSims(dayOf({ ticks: 120, size: 4 }))), []);
  const d = withSims(dayOf({ ticks: 120, size: 4 }));
  const old = { ...d, simSizes: { ...d.simSizes, [Object.keys(d.simSizes)[0]]: null } };
  assert.match(problems(old).join('\n'), /the simulator \(the policy's auto mode\) skips a trade live sizes at 4 MNQ/);
  // 60 points (240 ticks): 3 MNQ at $121.24 = $363.72 is the stretched floor, while healthy; after a loss the cap holds.
  assert.deepStrictEqual(problems(withSims(dayOf({ ticks: 240, size: 3 }))), []);
  const lost = problems(withSims(dayOf({ ticks: 240, size: 3, before: -60 })));
  assert.match(lost.join('\n'), /filled 3, but the rulebook plans no size at the 240-tick stop/);
});

test('sizingChecks: a skip must be a real no-fit: compose_check\'s no size fits where the plan sizes is a problem', () => {
  const rec = ticks => ({ id: `r${ticks}`, at: at('13:40'), ok: false, side: 'short', cycleBar: `${DAY}T13:39:00.000Z`, plan: { stop: { ticks } }, problems: ['no size fits: the floor of 3 MNQ ...'] });
  // 424 ticks: 3 x $213.24 = $639.72, over the stretch too: a real no-fit (live and the simulator alike).
  assert.deepStrictEqual(problems(withSims(dayOf({ records: [rec(424)] }))), []);
  // 120 ticks fits 4: a skip there is a problem.
  assert.match(problems(withSims(dayOf({ records: [rec(120)] }))).join('\n'), /skipped \(compose_check: no size fits\), but the rulebook plans 4 MNQ[\s\S]*the simulator sizes 4 MNQ where live finds no fit/);
});
