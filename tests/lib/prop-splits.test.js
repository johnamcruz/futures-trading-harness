'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SPLITS, windowMs, overlaps } = require('../../scripts/lib/prop/splits');

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

test('split windows: train, select and oos are real, ordered [from, to) date ranges', () => {
  assert.deepStrictEqual(Object.keys(SPLITS), ['train', 'select', 'oos']);
  for (const [name, w] of Object.entries(SPLITS)) {
    assert.ok(Array.isArray(w) && w.length === 2 && w.every(d => ISO_DAY.test(d)), `${name}: [from, to] ISO dates`);
    const { from, to } = windowMs(name);
    assert.ok(Number.isFinite(from) && Number.isFinite(to) && from < to, `${name}: from before to`);
  }
  assert.ok(windowMs('train').to <= windowMs('select').from, 'select after train');
  assert.ok(windowMs('select').to <= windowMs('oos').from, 'oos after select');
  assert.throws(() => windowMs('recent'), /no split window/);
});

test('split windows: out of sample never overlaps train or select, and never moves backward', () => {
  const oos = windowMs('oos');
  assert.ok(!overlaps(oos, windowMs('train')), 'oos overlaps train');
  assert.ok(!overlaps(oos, windowMs('select')), 'oos overlaps select');
  // The windows as first set: a window may move forward when the out-of-sample
  // one is retired, never back (raise these floors with it).
  assert.ok(SPLITS.oos[0] >= '2024-07-01' && SPLITS.oos[1] >= '2025-07-01', 'oos moved backward');
  assert.ok(SPLITS.select[0] >= '2023-07-01', 'select moved backward');
  assert.ok(Object.isFrozen(SPLITS) && Object.values(SPLITS).every(Object.isFrozen));
  // overlaps is half-open: touching windows don't overlap.
  assert.strictEqual(overlaps({ from: 0, to: 10 }, { from: 10, to: 20 }), false);
  assert.strictEqual(overlaps({ from: 0, to: 11 }, { from: 10, to: 20 }), true);
});
