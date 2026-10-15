'use strict';

// The target-then-trail exit (scripts/lib/trading/exit-trail.js): the swings a structure trail stands behind, causal;
// the per-bar rule (the hold to the target, the lock, the R and swing trails, the fallback, the ratchet); and the live
// target the runner trails past.

const test = require('node:test');
const assert = require('node:assert');
const { swingSeries, afterTargetStep, swingAtBar, liveTarget, SWING_TFS } = require('../../scripts/lib/trading/exit-trail');
const { rng } = require('../../scripts/lib/prop/stats');
const { candles } = require('../../scripts/lib/trading/mtf');
const { pivots } = require('../../scripts/lib/trading/structure-events');

/** 3-minute bars from Monday 2026-10-05 09:30 ET (13:30Z), a random walk on the tick grid. */
function walk(n, seed = 3) {
  const r = rng(seed);
  const out = [];
  let px = 21000;
  const t0 = Date.parse('2026-10-05T13:30:00Z');
  for (let k = 0; k < n; k += 1) {
    const o = px;
    const c = Math.round((px + (r() - 0.5) * 12) * 4) / 4;
    out.push({ t: new Date(t0 + k * 180000).toISOString(), o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 100 });
    px = c;
  }
  return out;
}

/** The oracle: the latest swing (k = 2) of the candles complete by bar i's close, from the bars up to it only. */
function swingsSoFar(bars, i, m) {
  const ps = pivots(candles(bars.slice(0, i + 1), m).filter(c => c.complete), 2);
  const last = type => { const x = ps.filter(p => p.type === type); return x.length ? x[x.length - 1].price : null; };
  return [last('low'), last('high')];
}

test('swingSeries: each bar\'s swing uses only the bars up to its close: the latest swing of the candles complete by then', () => {
  const bars = walk(400);
  for (const m of Object.values(SWING_TFS)) {
    const all = swingSeries(bars, m);
    for (let i = 0; i < bars.length; i += 1) assert.deepStrictEqual([all.low[i], all.high[i]], swingsSoFar(bars, i, m), `${m}m bar ${i}`);
    assert.ok(all.low.some(x => x !== null) && all.high.some(x => x !== null), `${m}m: swings found`);
    for (let i = 0; i < bars.length; i += 7) {
      const upTo = swingSeries(bars.slice(0, i + 1), m);
      assert.deepStrictEqual([upTo.low[i], upTo.high[i]], [all.low[i], all.high[i]], `${m}m bar ${i}`);
      assert.strictEqual(swingAtBar(bars.slice(0, i + 1), bars[i], m, 1), all.low[i]);
    }
  }
  // A swing low on 15m candles counts only once the second candle after it has closed (k = 2), never earlier.
  const s = swingSeries(bars, 15);
  const first = s.low.findIndex(x => x !== null);
  assert.ok(first >= 4 * 5 - 1, `the first swing low at bar ${first}: five 15m candles at least`);
  assert.deepStrictEqual(swingSeries([], 15), { low: [], high: [] });
});

const AFTER = (over = {}) => ({ afterTarget: { lockGivebackR: 0.5, trailBy: 'r', trailR: 1, swingMinutes: null, ...over } });
// A long from 100, 1R = 10, its own target at 2R (120); the stop at 90.
const LONG = (over = {}) => ({ sign: 1, entry: 100, risk: 10, stop: 90, peakR: 0, armed: false, target: 120, ...over });

test('afterTargetStep: the original stop holds until the trade\'s own target; then the lock, the R trail, the ratchet', () => {
  // Short of the target: nothing moves, however far it ran.
  const before = afterTargetStep(LONG(), { h: 119.75, l: 101, c: 118 }, AFTER(), 0.25);
  assert.deepStrictEqual([before.stop, before.armed, before.close], [90, false, null]);
  // The bar reaching the target arms it: the stop locks at 2R - 0.5R = 1.5R (115), the R trail (peak 2.2R - 1R = 112) below it.
  const at = afterTargetStep(LONG(), { h: 122, l: 117, c: 121 }, AFTER(), 0.25);
  assert.deepStrictEqual([at.stop, at.armed, at.close], [115, true, null], 'the lock holds');
  // Further up: the R trail (peak 3.5R - 1R = 2.5R: 125) takes over above the lock.
  const up = afterTargetStep({ ...LONG(), stop: at.stop, peakR: at.peakR, armed: true }, { h: 135, l: 126, c: 133 }, AFTER(), 0.25);
  assert.deepStrictEqual([up.stop, up.close], [125, null]);
  // A pullback never loosens it.
  const back = afterTargetStep({ ...LONG(), stop: up.stop, peakR: up.peakR, armed: true }, { h: 130, l: 126, c: 127 }, AFTER(), 0.25);
  assert.strictEqual(back.stop, 125);
  // A bar already through the new stop closes at its close (the stop wasn't resting there yet).
  const thru = afterTargetStep(LONG(), { h: 122, l: 110, c: 118 }, AFTER(), 0.25);
  assert.deepStrictEqual([thru.stop, thru.close], [115, { price: 118, reason: 'trail' }]);
  // The lock is never below the entry: a giveback larger than the target's R locks breakeven.
  assert.strictEqual(afterTargetStep(LONG(), { h: 122, l: 117, c: 121 }, AFTER({ lockGivebackR: 5, trailR: 10 }), 0.25).stop, 100);
  // No target known: it never arms.
  assert.deepStrictEqual(afterTargetStep(LONG({ target: null }), { h: 200, l: 150, c: 190 }, AFTER(), 0.25).stop, 90);
});

test('afterTargetStep: the structure trail stands a tick behind the last confirmed swing, never under the lock; no swing yet: the R trail (fallback)', () => {
  const armed = LONG({ stop: 115, peakR: 2.2, armed: true });
  const s = AFTER({ trailBy: 'structure', swingMinutes: 15 });
  // A swing low at 124: the stop a tick under it.
  assert.deepStrictEqual([afterTargetStep(armed, { h: 130, l: 125, c: 128 }, s, 0.25, 124).stop, afterTargetStep(armed, { h: 130, l: 125, c: 128 }, s, 0.25, 124).fellBack], [123.75, false]);
  // A later, lower swing never loosens it.
  assert.strictEqual(afterTargetStep(armed, { h: 130, l: 125, c: 128 }, s, 0.25, 124).stop, 123.75);
  assert.strictEqual(afterTargetStep({ ...armed, stop: 123.75 }, { h: 129, l: 124.5, c: 126 }, s, 0.25, 118).stop, 123.75);
  // A swing under the lock: the lock holds.
  assert.strictEqual(afterTargetStep(armed, { h: 130, l: 125, c: 128 }, s, 0.25, 104).stop, 115);
  // No swing confirmed: the R trail (peak 3R - 1R = 2R: 120), and it says so.
  const fb = afterTargetStep(armed, { h: 130, l: 125, c: 128 }, s, 0.25, null);
  assert.deepStrictEqual([fb.stop, fb.fellBack], [120, true]);
  // A short mirrors it: entry 100, 1R 10, target 80; a swing high at 76 puts the stop a tick above it.
  const short = { sign: -1, entry: 100, risk: 10, stop: 85, peakR: 2.2, armed: true, target: 80 };
  assert.strictEqual(afterTargetStep(short, { h: 75, l: 70, c: 72 }, s, 0.25, 76).stop, 76.25);
  assert.strictEqual(afterTargetStep({ ...short, stop: 110, armed: false, peakR: 0 }, { h: 84, l: 79, c: 81 }, AFTER(), 0.25).stop, 85, 'a short\'s lock: 1.5R under the entry');
});

test('liveTarget: the entry\'s own target from its bracket, and only the resting limit at it is cancelled (never a stop)', () => {
  const orders = [
    { id: 1, contractId: 'MNQ', type: 1, side: 1, limitPrice: 120 }, // the long's target
    { id: 2, contractId: 'MNQ', type: 4, side: 1, stopPrice: 90 }, // its stop
    { id: 3, contractId: 'MNQ', type: 1, side: 1, limitPrice: 130 }, // another exit limit
    { id: 4, contractId: 'MES', type: 1, side: 1, limitPrice: 120 },
  ];
  const r = liveTarget({ rec: { targetTicks: 80 }, entry: 100, sign: 1, tick: 0.25, orders, contractId: 'MNQ' });
  assert.deepStrictEqual([r.price, r.cancel.map(o => o.id)], [120, [1]]);
  // No bracket recorded: the one resting limit on the other side, if there is exactly one.
  assert.deepStrictEqual(liveTarget({ rec: {}, entry: 100, sign: 1, tick: 0.25, orders: orders.slice(0, 2), contractId: 'MNQ' }).price, 120);
  const none = liveTarget({ rec: {}, entry: 100, sign: 1, tick: 0.25, orders, contractId: 'MNQ' });
  assert.deepStrictEqual([none.price, none.cancel], [null, []]);
  assert.match(none.why, /several resting limit orders/);
  assert.strictEqual(liveTarget({ rec: null, entry: 100, sign: 1, tick: 0.25, orders: [], contractId: 'MNQ' }).price, null);
});
