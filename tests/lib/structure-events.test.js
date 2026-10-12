'use strict';

// Structure events computed from closed bars (structure-events.js): confirmed swings, BOS and CHoCH, sweeps, and
// swings not traded back to.
const test = require('node:test');
const assert = require('node:assert');
const { pivots, lastBreaks, sweeps, untestedSwings } = require('../../scripts/lib/trading/structure-events');

// Bars from a list of [high, low, close]; times one minute apart.
const mk = rows => rows.map(([h, l, c], i) => ({ t: new Date(Date.UTC(2026, 5, 1, 14, i)).toISOString(), o: c, h, l, c, v: 1 }));

test('pivots: a fractal high (low) above (below) the k bars on each side, confirmed k bars later', () => {
  const bars = mk([[10, 8, 9], [11, 9, 10], [14, 10, 13], [12, 9, 11], [11, 7, 8], [12, 9, 10], [13, 10, 12]]);
  const p = pivots(bars, 2);
  assert.deepStrictEqual(p.map(x => [x.type, x.price, x.i, x.confirmedAt]), [['high', 14, 2, 4], ['low', 7, 4, 6]]);
  // The bar at index 4 (low 7) needs two bars on its right: it is confirmed at 6, within the data.
  assert.ok(!pivots(bars.slice(0, 6), 2).some(x => x.type === 'low'), 'not yet confirmed with one bar after it');
  assert.deepStrictEqual(pivots(bars, 2).filter(x => x.type === 'low').map(x => x.price), [7]);
});

test('lastBreaks: a close through the last confirmed swing; same direction BOS, reversal CHoCH', () => {
  // Up: swing high 14 confirmed, then a close at 15 breaks it (BOS up). Then a swing low 9 confirmed and a close at 8 (CHoCH down).
  const bars = mk([
    [10, 8, 9], [11, 9, 10], [14, 10, 13], [12, 10, 11], [12, 10, 11], [13, 11, 12], [16, 13, 15],
    [15, 12, 13], [14, 9, 11], [13, 10, 12], [13, 10, 12], [12, 7, 8],
  ]);
  const { last, previous } = lastBreaks(bars, 2);
  assert.deepStrictEqual([previous.kind, previous.direction, previous.level], ['BOS', 'up', 14]);
  assert.deepStrictEqual([last.kind, last.direction, last.level, last.at], ['CHoCH', 'down', 9, bars[11].t]);
  // A swing is broken once: later closes above 14 add no new break.
  assert.deepStrictEqual(lastBreaks(bars.slice(0, 8), 2), { last: { kind: 'BOS', direction: 'up', level: 14, swingAt: bars[2].t, at: bars[6].t }, previous: null });
  assert.deepStrictEqual(lastBreaks(mk([[10, 9, 9.5]]), 2), { last: null, previous: null });
});

test('sweeps: a high wicked above and closed back below, a low wicked below and closed back above, in the last n bars', () => {
  const bars = mk([[10, 8, 9], [10.5, 8.5, 9.5], [12, 9, 10], [10, 6, 8], [11, 9, 10]]);
  const s = sweeps(bars, [{ name: 'PDH', price: 11, side: 'high' }, { name: 'PDL', price: 7, side: 'low' }, { name: 'far', price: 20, side: 'high' }], 10);
  assert.deepStrictEqual(s.map(x => [x.name, x.side, x.at]), [['PDL', 'low', bars[3].t], ['PDH', 'high', bars[2].t]]);
  assert.deepStrictEqual(s[1].wick, 12);
  // A close beyond the level is a break, not a sweep; a level outside the window isn't reported.
  assert.deepStrictEqual(sweeps(mk([[12, 9, 11.5]]), [{ name: 'PDH', price: 11, side: 'high' }]), []);
  assert.deepStrictEqual(sweeps(bars, [{ name: 'PDH', price: 11, side: 'high' }], 2), []);
  // One per level even when named twice; a level without a side is ignored.
  assert.strictEqual(sweeps(bars, [{ name: 'a', price: 11, side: 'high' }, { name: 'b', price: 11, side: 'high' }, { name: 'c', price: 11 }]).length, 1);
});

test('untestedSwings: a swing high never reached again, a swing low never reached again', () => {
  const bars = mk([[10, 8, 9], [14, 9, 13], [12, 7, 8], [13, 9, 12], [12, 10, 11]]);
  const swings = [{ type: 'high', price: 14, t: bars[1].t }, { type: 'low', price: 7, t: bars[2].t }, { type: 'low', price: 9.5, t: bars[0].t }];
  assert.deepStrictEqual(untestedSwings(bars, swings).map(s => [s.type, s.price]), [['high', 14], ['low', 7]]);
});
