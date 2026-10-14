'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fib = require('../../scripts/lib/trading/fib');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
const BULL = { origin: 21478.25, extreme: 21530.25 }; // the cisd_ote example: d = 52.00
const BEAR = { origin: 21530.25, extreme: 21478.25 };

test('the ratios are the golden zone hypotheses the skills teach: 0.5, 0.618, 0.705, 0.79; OTE 0.62-0.79, mid 0.705', () => {
  assert.deepStrictEqual([...fib.LEVELS], [0.5, 0.618, 0.705, 0.79]);
  assert.deepStrictEqual({ ...fib.OTE }, { from: 0.62, to: 0.79, mid: 0.705 });
  assert.ok(Object.isFrozen(fib.LEVELS) && Object.isFrozen(fib.OTE));
});

test('a retracement is measured back from the extreme: 0 at the extreme, 1 at the origin, either direction', () => {
  close(fib.priceAt(BULL, 0), 21530.25);
  close(fib.priceAt(BULL, 1), 21478.25);
  close(fib.priceAt(BULL, 0.5), 21504.25);
  close(fib.priceAt(BEAR, 0.5), 21504.25);
  close(fib.priceAt(BEAR, 0.79), 21519.33); // 21478.25 + 0.79 x 52
  close(fib.retracementOf(BULL, 21504.25), 0.5);
  close(fib.retracementOf(BEAR, 21519.33), 0.79);
  assert.ok(fib.retracementOf(BULL, 21540) < 0, 'beyond the extreme');
  assert.ok(fib.retracementOf(BULL, 21470) > 1, 'beyond the origin');
  assert.strictEqual(fib.direction(BULL), 'bullish');
  assert.strictEqual(fib.direction(BEAR), 'bearish');
});

test('levels: each named ratio, keyed as text', () => {
  const l = fib.levels(BULL);
  assert.deepStrictEqual(Object.keys(l), ['0.5', '0.618', '0.705', '0.79']);
  close(l['0.618'], 21530.25 - 0.618 * 52);
});

test('the OTE zone of the cisd_ote example: 21489.17-21498.01, mid 21493.59; mirrored for a bearish leg', () => {
  const z = fib.zone(BULL);
  close(z.top, 21498.01);
  close(z.bottom, 21489.17);
  close(z.mid, 21493.59);
  const b = fib.zone(BEAR);
  close(b.bottom, 21478.25 + 0.62 * 52);
  close(b.top, 21478.25 + 0.79 * 52);
  close(b.mid, 21478.25 + 0.705 * 52);
  // A band between other ratios: its mid is halfway.
  close(fib.zone(BULL, 0.5, 0.618).mid, fib.priceAt(BULL, 0.559));
  assert.ok(fib.inZone(BULL, 21493.59) && fib.inZone(BULL, 21498.01) && fib.inZone(BULL, 21489.17));
  assert.ok(!fib.inZone(BULL, 21499) && !fib.inZone(BULL, 21489) && !fib.inZone(BULL, NaN));
});

test('premium above the leg\'s 50% level, discount below it, by price whichever way the leg runs', () => {
  assert.strictEqual(fib.halfOf(BULL, 21510), 'premium');
  assert.strictEqual(fib.halfOf(BULL, 21495), 'discount');
  assert.strictEqual(fib.halfOf(BEAR, 21510), 'premium');
  assert.strictEqual(fib.halfOf(BEAR, 21504.25), 'equilibrium');
});

test('a leg without two different finite prices is an error, never a zone', () => {
  assert.throws(() => fib.zone({ origin: 1, extreme: 1 }), /differ/);
  assert.throws(() => fib.priceAt({ origin: NaN, extreme: 1 }, 0.5), /finite/);
  assert.throws(() => fib.levels(null), /finite/);
});
