'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { checkOrderSize, entryStopTicks, checkRiskLimit } = require('../../scripts/lib/trading/order-limits');

// The broker's specs (as recorded): MNQ 0.25 = $0.50, NQ 0.25 = $5.00.
const SPECS = { MNQ: { tickSize: 0.25, tickValue: 0.5 }, NQ: { tickSize: 0.25, tickValue: 5 } };
const specOf = root => SPECS[root] || null;
const order = (extra = {}) => ({ contractId: 'MNQ', side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40, type: 'stop' }, ...extra });
const strat = (cap, extra = {}) => ({ name: 'orb', signal: 'rules', risk: { stop: 'atr:0.5', min_rr: 2, ...(cap === undefined ? {} : { max_risk_usd: cap }) }, ...extra });

test('checkOrderSize: within the broker\'s max order size passes; over it is refused with the fix; never an invitation to split', () => {
  const limit = { maxOrderSize: 5, readAt: 'x' };
  assert.strictEqual(checkOrderSize(order({ size: 5 }), limit), null);
  assert.strictEqual(checkOrderSize(order({ size: 1 }), limit), null);
  assert.strictEqual(checkOrderSize(order({ size: '2' }), limit), null, 'a numeric string is the number');
  assert.strictEqual(checkOrderSize(order({ size: 27 }), limit),
    'size 27 over the broker\'s max order size 5 (get_server_config maxOrderSize): reduce the size to 5 or less. Never split an entry into several orders to get under it.');
  assert.match(checkOrderSize(order({ size: 6 }), limit), /^size 6 over the broker's max order size 5/);
});

test('checkOrderSize: a size that is no whole number of contracts, or no recorded limit, is refused (fail closed)', () => {
  const limit = { maxOrderSize: 5 };
  for (const size of [0, -1, 1.5, 'two', '', null, undefined, NaN, Infinity, [1], true]) {
    assert.match(checkOrderSize(order({ size }), limit), /is not a whole number of contracts, 1 or more\.$/, JSON.stringify(size));
  }
  assert.strictEqual(checkOrderSize(order(), { maxOrderSize: null, why: 'not recorded: call get_server_config' }), 'not recorded: call get_server_config.');
  assert.match(checkOrderSize(order(), null), /not recorded yet: call get_server_config/);
  assert.match(checkOrderSize(order(), { maxOrderSize: 2.5 }), /not recorded yet/);
  assert.match(checkOrderSize(order(), { maxOrderSize: 0 }), /not recorded yet/);
});

test('entryStopTicks: the bracket, or the rationale\'s stop from a limit or stop entry\'s price (rounded up), the larger of both', () => {
  const s = SPECS.MNQ;
  assert.deepStrictEqual(entryStopTicks(order(), null, s), { ticks: 40 });
  assert.deepStrictEqual(entryStopTicks(order({ stopLossBracket: { ticks: '12' } }), null, s), { ticks: 12 });
  // Limit buy 21500, stop 21480.25: 19.75 points = 79 ticks. Stop entry: from its stopPrice.
  const limit = order({ type: 'limit', limitPrice: 21500, stopLossBracket: undefined });
  assert.deepStrictEqual(entryStopTicks(limit, 21480.25, s), { ticks: 79 });
  assert.deepStrictEqual(entryStopTicks(order({ type: 'stop', stopPrice: 21510, stopLossBracket: undefined }), 21480.25, s), { ticks: 119 });
  assert.deepStrictEqual(entryStopTicks(order({ side: 'sell', type: 'limit', limitPrice: 21500, stopLossBracket: undefined }), 21510, s), { ticks: 40 });
  // Off the tick: 19.9 points is 79.6 ticks, counted as 80 (risk is never under-counted).
  assert.deepStrictEqual(entryStopTicks(limit, 21480.1, s), { ticks: 80 });
  // Both: the larger, whichever it is.
  assert.deepStrictEqual(entryStopTicks({ ...limit, stopLossBracket: { ticks: 78 } }, 21480.25, s), { ticks: 79 });
  assert.deepStrictEqual(entryStopTicks({ ...limit, stopLossBracket: { ticks: 90 } }, 21480.25, s), { ticks: 90 });
  // A market entry with a bracket: the bracket (the rationale's stop has no entry price to measure from).
  assert.deepStrictEqual(entryStopTicks(order(), 21000, s), { ticks: 40 });
  // A bracket with a wrong-side rationale stop: the bracket the broker places.
  assert.deepStrictEqual(entryStopTicks({ ...limit, stopLossBracket: { ticks: 20 } }, 21510, s), { ticks: 20 });
});

test('entryStopTicks: no computable stop says why and how to fix it', () => {
  const s = SPECS.MNQ;
  assert.match(entryStopTicks(order({ stopLossBracket: undefined }), 21480, s).why, /market entry with its stop only in the rationale has no entry price .*add stopLossBracket\.ticks/);
  assert.match(entryStopTicks(order({ stopLossBracket: undefined }), null, s).why, /no stop to measure its risk from: add stopLossBracket\.ticks/);
  assert.match(entryStopTicks(order({ type: 'limit', limitPrice: 21500, stopLossBracket: undefined }), 21510, s).why, /not on the losing side of the buy entry 21500/);
  assert.match(entryStopTicks(order({ type: 'limit', limitPrice: 21500, stopLossBracket: undefined }), 21500, s).why, /not on the losing side/);
  assert.match(entryStopTicks(order({ type: 'limit', limitPrice: 21500, side: undefined, stopLossBracket: undefined }), 21480, s).why, /not on the losing side/);
  assert.match(entryStopTicks(order({ type: 'limit', limitPrice: 'abc', stopLossBracket: undefined }), 21480, s).why, /is not a price/);
  for (const ticks of [0, -4, 2.5, 'x']) assert.match(entryStopTicks(order({ stopLossBracket: { ticks } }), null, s).why, /not a whole number of ticks above 0/, String(ticks));
  assert.match(entryStopTicks(order(), null, null).why, /no usable tick specs from the broker for MNQ/);
});

test('checkRiskLimit: no cap, no check; within or at the cap passes; over it is refused with the size and the stop that fit', () => {
  assert.strictEqual(checkRiskLimit({ input: order({ size: 99 }), strategy: strat(undefined), specOf }), null);
  assert.strictEqual(checkRiskLimit({ input: order({ size: 99 }), strategy: null, specOf }), null, 'no named strategy');
  // MNQ, 40 ticks at $0.50: $20 a contract. Cap $50: 2 fit ($40), 3 don't ($60).
  assert.strictEqual(checkRiskLimit({ input: order({ size: 2 }), strategy: strat(50), specOf }), null);
  assert.strictEqual(checkRiskLimit({ input: order({ size: 2 }), strategy: strat(40), specOf }), null, 'exactly at the cap');
  assert.strictEqual(checkRiskLimit({ input: order({ size: 3 }), strategy: strat(50), specOf }),
    'risk $60.00 (size 3 x 40-tick stop x $0.50 a tick on MNQ) over setup:orb\'s risk.max_risk_usd $50.00: reduce the size to 2 or less, or tighten to a stop of at most 33 ticks at size 3 (use order_plan: it gives the strategy\'s own stop, which is never moved just to fit).');
  // The 27-contract entry: $540.
  assert.match(checkRiskLimit({ input: order({ size: 27 }), strategy: strat(50), specOf }), /^risk \$540\.00 .*reduce the size to 2 or less/);
});

test('checkRiskLimit: MNQ vs NQ - the same ticks, ten times the dollars; a stop no size fits says so', () => {
  assert.strictEqual(checkRiskLimit({ input: order({ size: 1 }), strategy: strat(25), specOf }), null, 'one MNQ at 40 ticks: $20');
  assert.strictEqual(checkRiskLimit({ input: order({ contractId: 'NQ', size: 1 }), strategy: strat(25), specOf }),
    'risk $200.00 (size 1 x 40-tick stop x $5.00 a tick on NQ) over setup:orb\'s risk.max_risk_usd $25.00: no size fits at a 40-tick stop (one NQ risks $200.00), or tighten to a stop of at most 5 ticks at size 1 (use order_plan: it gives the strategy\'s own stop, which is never moved just to fit).');
  assert.match(checkRiskLimit({ input: order({ contractId: 'NQ', size: 1 }), strategy: strat(4), specOf }), /no size fits at a 40-tick stop \(one NQ risks \$200\.00\) \(use order_plan/, 'not even one tick fits');
  // A month name is its root's spec.
  assert.match(checkRiskLimit({ input: order({ contractId: 'NQ:2026-12', size: 1 }), strategy: strat(25), specOf }), /\$5\.00 a tick on NQ/);
});

test('checkRiskLimit: the stop only in the rationale - a limit entry\'s distance counts; a market entry\'s can\'t be measured (refused)', () => {
  const limit = order({ type: 'limit', limitPrice: 21500, stopLossBracket: undefined });
  // 79 ticks x $0.50 = $39.50.
  assert.strictEqual(checkRiskLimit({ input: limit, stopPrice: 21480.25, strategy: strat(40), specOf }), null);
  assert.match(checkRiskLimit({ input: { ...limit, size: 2 }, stopPrice: 21480.25, strategy: strat(40), specOf }), /^risk \$79\.00 \(size 2 x 79-tick stop/);
  // Off the tick: 80 ticks, $40.00 - at the cap, not under-counted to 79.
  assert.strictEqual(checkRiskLimit({ input: limit, stopPrice: 21480.1, strategy: strat(40), specOf }), null);
  assert.match(checkRiskLimit({ input: limit, stopPrice: 21480.1, strategy: strat(39.9), specOf }), /^risk \$40\.00 \(size 1 x 80-tick stop/);
  // The replayed 27-lot: a market entry, no bracket, the stop only in the rationale.
  assert.match(checkRiskLimit({ input: order({ size: 27, stopLossBracket: undefined }), stopPrice: 21480, strategy: strat(50), specOf }),
    /^setup:orb caps risk at \$50\.00 \(risk\.max_risk_usd\) but this entry's risk can't be computed: a market entry with its stop only in the rationale has no entry price .*add stopLossBracket\.ticks/);
});

test('checkRiskLimit: a cap set and the risk not computable is refused (fail closed)', () => {
  assert.match(checkRiskLimit({ input: order(), strategy: strat(50), specOf: () => null }), /can't be computed: no usable tick specs from the broker for MNQ/);
  assert.match(checkRiskLimit({ input: order(), strategy: strat(50) }), /can't be computed: no usable tick specs/);
  assert.match(checkRiskLimit({ input: order({ size: 0 }), strategy: strat(50), specOf }), /the size 0 is not a whole number of contracts, so the risk can't be computed/);
  assert.match(checkRiskLimit({ input: order({ stopLossBracket: { ticks: 0 } }), strategy: strat(50), specOf }), /stopLossBracket\.ticks 0 is not a whole number/);
  for (const cap of ['50', 0, -5, null, NaN]) {
    assert.match(checkRiskLimit({ input: order(), strategy: strat(cap), specOf }), /risk\.max_risk_usd \(.*\) is not a positive number, so the entry's risk can't be checked: fix its STRATEGY\.md/, String(cap));
  }
});

test('checkRiskLimit: a policy strategy\'s entry is checked against its own cap only', () => {
  const policy = cap => strat(cap, { name: 'prop_portfolio', signal: 'policy', strategies: ['orb'] });
  assert.strictEqual(checkRiskLimit({ input: order({ size: 10 }), strategy: policy(undefined), specOf }), null, 'no cap of its own: prop sizing alone sizes it');
  assert.match(checkRiskLimit({ input: order({ size: 10 }), strategy: policy(150), specOf }), /^risk \$200\.00 .* over setup:prop_portfolio's risk\.max_risk_usd \$150\.00: reduce the size to 7 or less/);
});
