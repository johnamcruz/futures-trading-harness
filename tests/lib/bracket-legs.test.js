'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { legRole, isStopLeg, isTargetLeg, protectiveStops, coveredSize } = require('../../scripts/lib/trading/bracket-legs');

test('a leg\'s role: the server\'s bracket role when it gives one, else the order\'s type; absence is never "no bracket"', () => {
  assert.strictEqual(legRole({ type: 4, bracket: { role: 'stop' } }), 'stop');
  assert.strictEqual(legRole({ type: 4, bracket: { role: ' Target ' } }), 'target');
  for (const o of [{ type: 4 }, { type: 4, bracket: null }, { type: 4, bracket: {} }, { type: 4, bracket: { role: 'other' } }, { type: 4, bracket: 'stop' }]) {
    assert.strictEqual(legRole(o), null, JSON.stringify(o));
    assert.strictEqual(isStopLeg(o), true, `no role: by type ${JSON.stringify(o)}`);
  }
  for (const type of [3, 4, 5, '4']) assert.strictEqual(isStopLeg({ type }), true, String(type));
  for (const type of [1, 6, 7]) assert.deepStrictEqual([isStopLeg({ type }), isTargetLeg({ type })], [false, true], String(type));
  // The role decides over the type.
  assert.deepStrictEqual([isStopLeg({ type: 1, bracket: { role: 'stop' } }), isTargetLeg({ type: 1, bracket: { role: 'stop' } })], [true, false]);
  assert.deepStrictEqual([isStopLeg({ type: 4, bracket: { role: 'target' } }), isTargetLeg({ type: 4, bracket: { role: 'target' } })], [false, true]);
  assert.strictEqual(isStopLeg({ type: 2 }), false, 'a market order is no leg');
  assert.strictEqual(isStopLeg(null), false);
});

test('protective stops: the opposite side, exactly that contract month; covered is their size', () => {
  const orders = [
    { id: 1, contractId: 'MNQ', type: 4, side: 1, size: 2 },
    { id: 2, contractId: 'MNQ', type: 99, side: 1, size: 1, bracket: { role: 'stop' } },
    { id: 3, contractId: 'MNQ', type: 4, side: 0, size: 1 },
    { id: 4, contractId: 'MNQ:2027-03', type: 4, side: 1, size: 1 },
    { id: 5, contractId: 'MNQ', type: 1, side: 1, size: 3 },
  ];
  assert.deepStrictEqual(protectiveStops(orders, 'MNQ', 1).map(o => o.id), [1, 2], 'a long: its sell stops');
  assert.deepStrictEqual(protectiveStops(orders, 'MNQ', -1).map(o => o.id), [3], 'a short: its buy stops');
  assert.strictEqual(coveredSize(orders, 'MNQ', 1), 3);
  assert.strictEqual(coveredSize(orders, 'MNQ:2027-03', 1), 1);
  assert.strictEqual(coveredSize([], 'MNQ', 1), 0);
  assert.strictEqual(coveredSize(undefined, 'MNQ', 1), 0);
});
