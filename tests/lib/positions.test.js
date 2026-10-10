'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { positionSize, signedSize, isOpen } = require('../../scripts/lib/trading/positions');

test('sizes: a whole number of contracts, 0 or more; anything else is unknown and throws', () => {
  assert.strictEqual(positionSize({ size: 2 }), 2);
  assert.strictEqual(positionSize({ size: '3' }), 3);
  assert.strictEqual(positionSize({ size: 0 }), 0);
  for (const size of [undefined, null, '', 'x', 1.5, -1, NaN, {}]) {
    assert.throws(() => positionSize({ contractId: 'MNQ', size }), /MNQ has no valid size/, JSON.stringify(size));
  }
  assert.throws(() => positionSize({ contractId: 'MNQ', quantity: 1 }), /no valid size/, 'another server\'s field name is no size');
});

test('signed: long +, short -; an unknown type or size throws', () => {
  assert.strictEqual(signedSize({ type: 1, size: 2 }), 2);
  assert.strictEqual(signedSize({ type: 2, size: 1 }), -1);
  assert.throws(() => signedSize({ type: 3, size: 1 }), /unknown type/);
  assert.throws(() => signedSize({ type: 1 }), /no valid size/);
});

test('isOpen: a position of unknown size counts as open, never as flat', () => {
  assert.strictEqual(isOpen({ size: 1 }), true);
  assert.strictEqual(isOpen({ size: 0 }), false);
  assert.strictEqual(isOpen({ quantity: 1 }), true);
  assert.strictEqual(isOpen({ size: -2 }), true);
});
