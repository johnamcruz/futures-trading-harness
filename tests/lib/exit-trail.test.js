'use strict';

// The target-then-trail exit (scripts/lib/trading/exit-trail.js): the swings a structure trail stands behind, causal;
// the per-bar rule (the hold to the target, the lock, the R and swing trails, the fallback, the ratchet, on and off); and the live
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

test('afterTargetStep: a swing whose stop is not on the protective side of the close is no swing: the lock and the R trail hold', () => {
  const s = AFTER({ trailBy: 'structure', swingMinutes: 15 });
  const at = (t, bar, swing) => afterTargetStep(t, bar, s, 0.25, swing);
  // A long past its target (lock 115) after a gap down: the latest 15m swing low (124) is a stale one above the price
  // (close 117). Before the fix its stop (123.75) sat over the market and closed the trade at once at 117.
  const long = LONG({ stop: 115, peakR: 2.2, armed: true });
  const gap = at(long, { h: 118, l: 116, c: 117 }, 124);
  assert.deepStrictEqual([gap.stop, gap.close, gap.fellBack, gap.wrongSide], [115, null, true, true], 'the lock holds; the R trail (112) is under it');
  // With no swing at all, a fallback that says it is not the wrong side's.
  assert.strictEqual(at(long, { h: 118, l: 116, c: 117 }, null).wrongSide, undefined);
  // A swing a tick over the close's tick puts the stop at the close: not under it, so no swing either.
  const even = at(long, { h: 118, l: 116, c: 117 }, 117.25);
  assert.deepStrictEqual([even.stop, even.fellBack], [115, true]);
  // At the close it counts: the stop a tick under it (116.75), under the close; a bar whose low reached it closes at the close.
  const thru = at(long, { h: 118, l: 116.75, c: 117 }, 117);
  assert.deepStrictEqual([thru.stop, thru.close, thru.fellBack], [116.75, { price: 117, reason: 'trail' }, false]);
  const held = at(long, { h: 118, l: 117, c: 117.5 }, 117);
  assert.deepStrictEqual([held.stop, held.close], [116.75, null]);
  // A stop already above the lock never moves back when the swing goes stale.
  assert.strictEqual(at({ ...long, stop: 116.5 }, { h: 118, l: 116.75, c: 117 }, 124).stop, 116.5);
  // The short mirror: entry 100, 1R 10, lock 85 after a gap up; a stale swing high at 76, under the close (83).
  const short = { sign: -1, entry: 100, risk: 10, stop: 85, peakR: 2.2, armed: true, target: 80 };
  const up = at(short, { h: 84, l: 82, c: 83 }, 76);
  assert.deepStrictEqual([up.stop, up.close, up.fellBack], [85, null, true]);
  // A short's normal swing high above the price: unchanged, a tick over it.
  const normal = at(short, { h: 79, l: 72, c: 74 }, 80);
  assert.deepStrictEqual([normal.stop, normal.close, normal.fellBack], [80.25, null, false]);
});

// The 2026-10-24 replay's MNQ short: entry 14530.5, 1R = 24.5 points (98 ticks), its own target at 2R (14481.5). A
// 15m swing high far above (14525: its stop a tick over, 14525.25) so the swing trail never binds and the ratchet shows.
const SHORT = (over = {}) => ({ sign: -1, entry: 14530.5, risk: 24.5, stop: 14555, peakR: 0, armed: false, target: 14481.5, ...over });
// The rulebook's giveback (1.5R), the ratchet on.
const ON = (over = {}) => AFTER({ lockGivebackR: 1.5, ratchet: true, ...over });
const RATCHET = ON({ trailBy: 'structure', swingMinutes: 15 });
const walkOf = (start, bars, plan, swing) => {
  let t = start;
  return bars.map(bar => { const r = afterTargetStep(t, bar, plan, 0.25, swing); t = { ...t, stop: r.stop, peakR: r.peakR, armed: r.armed }; return r; });
};

test('afterTargetStep, the ratchet: past the target the stop gives back at most the giveback (1.5R) from the best R reached', () => {
  // At the target (2R): +0.5R, 14530.5 - 12.25 = 14518.25 (49 ticks, $24.50 a micro), as before the ratchet.
  const [at] = walkOf(SHORT(), [{ h: 14490, l: 14481.5, c: 14485 }], RATCHET, 14525);
  assert.deepStrictEqual([at.stop, at.armed, at.close], [14518.25, true, null]);
  // On to 4.7R (14415.25: 115.25 points, 461 ticks): the stop at 4.7R - 1.5R = +3.2R, 78.5 points (314 ticks, $157 a
  // micro) under the entry: 14452. The replay's trade closed at +2.29R; this stop keeps +3.2R.
  const run = walkOf(SHORT(), [{ h: 14490, l: 14481.5, c: 14485 }, { h: 14440, l: 14415.25, c: 14420 }], RATCHET, 14525);
  assert.deepStrictEqual(run.map(r => r.stop), [14518.25, 14452]);
  assert.ok(Math.abs((14530.5 - run[1].stop) / 24.5 - (115.25 / 24.5 - 1.5)) < 1e-9, 'best R less 1.5R, exactly');
  // At 5R (14408: 122.5 points): +3.5R, 85.75 points (343 ticks) under the entry: 14444.75.
  assert.deepStrictEqual(walkOf(SHORT(), [{ h: 14490, l: 14481.5, c: 14485 }, { h: 14420, l: 14408, c: 14412 }], RATCHET, 14525).map(r => r.stop), [14518.25, 14444.75]);
  // A pullback from 3R (14457) to 2R (14481.5) keeps +1.5R (36.75 points: 14493.75) and stays open.
  const pb = walkOf(SHORT(), [{ h: 14490, l: 14481.5, c: 14485 }, { h: 14470, l: 14457, c: 14460 }, { h: 14481.5, l: 14465, c: 14480 }], RATCHET, 14525);
  assert.deepStrictEqual(pb.map(r => [r.stop, r.close]), [[14518.25, null], [14493.75, null], [14493.75, null]]);
  // A long mirrors it: entry 100, 1R 10, target 120; at 2R +0.5R (105), at 4.7R +3.2R (132), at 5R +3.5R (135); a
  // pullback from 3R to 2R keeps +1.5R (115).
  const L = ON({ trailBy: 'structure', swingMinutes: 15 });
  assert.deepStrictEqual(walkOf(LONG(), [{ h: 120, l: 115, c: 119 }, { h: 147, l: 135, c: 145 }], L, 101).map(r => r.stop), [105, 132]);
  assert.deepStrictEqual(walkOf(LONG(), [{ h: 120, l: 115, c: 119 }, { h: 150, l: 140, c: 148 }], L, 101).map(r => r.stop), [105, 135]);
  assert.deepStrictEqual(walkOf(LONG(), [{ h: 120, l: 115, c: 119 }, { h: 130, l: 125, c: 128 }, { h: 121, l: 120, c: 120.5 }], L, 101).map(r => [r.stop, r.close]), [[105, null], [115, null], [115, null]]);
  // A swing nearer the market than the ratchet still wins (the farther in profit of the two): a long's swing at 140.
  assert.strictEqual(walkOf(LONG(), [{ h: 120, l: 115, c: 119 }, { h: 147, l: 141, c: 145 }], L, 140)[1].stop, 139.75);
  // Under the target the ratchet is not armed: a 1.9R run moves nothing.
  assert.strictEqual(walkOf(SHORT(), [{ h: 14500, l: 14484, c: 14490 }], RATCHET, 14525)[0].stop, 14555);
});

test('afterTargetStep, the ratchet: already through the price on the bar that set it, out at that bar\'s close (as the swing and R trails)', () => {
  // A bar spiking to 4.7R (14415.25) and closing back at 14457 (3R): the ratchet (14452) is through its high (14460).
  const [, spike] = walkOf(SHORT(), [{ h: 14490, l: 14481.5, c: 14485 }, { h: 14460, l: 14415.25, c: 14457 }], RATCHET, 14525);
  assert.deepStrictEqual([spike.stop, spike.close], [14452, { price: 14457, reason: 'trail' }]);
});

test('afterTargetStep, the ratchet: on a random walk the stop never loosens, never gives back more than the giveback from the best, and stays on its side', () => {
  const r = rng(11);
  for (let n = 0; n < 200; n += 1) {
    const sign = r() < 0.5 ? 1 : -1;
    const entry = 15000;
    const risk = 0.25 * (8 + Math.floor(r() * 120));
    const g = [0.5, 1, 1.2, 1.5, 2][Math.floor(r() * 5)];
    const plan = ON({ lockGivebackR: g, trailR: 0.5 + r() * 4, trailBy: r() < 0.5 ? 'r' : 'structure', swingMinutes: 15 });
    let t = { sign, entry, risk, stop: entry - sign * risk, peakR: 0, armed: false, target: entry + sign * 2 * risk };
    let px = entry;
    for (let k = 0; k < 80; k += 1) {
      const o = px;
      const c = Math.round((px + sign * (r() - 0.35) * risk * 0.8) * 4) / 4;
      const bar = { h: Math.max(o, c) + 0.25 * Math.floor(r() * 8), l: Math.min(o, c) - 0.25 * Math.floor(r() * 8), c };
      const swing = r() < 0.3 ? null : Math.round((c - sign * r() * risk * 3) * 4) / 4;
      const s = afterTargetStep(t, bar, plan, 0.25, swing);
      assert.ok(sign * (s.stop - t.stop) >= 0, 'never loosened');
      if (s.armed) {
        const floor = entry + sign * Math.max(0, s.peakR - g) * risk;
        assert.ok(sign * (s.stop - floor) >= -0.25 + 1e-9, `at least best R less ${g}R, to the tick: ${s.stop} vs ${floor}`);
        assert.ok(Math.abs(s.stop * 4 - Math.round(s.stop * 4)) < 1e-9, 'on the tick');
      }
      if (!s.close) assert.ok(sign > 0 ? bar.l > s.stop || s.stop === t.stop : bar.h < s.stop || s.stop === t.stop, 'a stop it moved is on its side of the bar, else the bar closed it');
      t = { ...t, stop: s.stop, peakR: s.peakR, armed: s.armed };
      if (s.close || (sign > 0 ? bar.l <= t.stop : bar.h >= t.stop)) break;
      px = c;
    }
  }
});

test('afterTargetStep, the ratchet off (the rulebook\'s default): the lock stays at the target\'s R less the giveback, as before', () => {
  // The same 4.7R short: off, the stop locks once at +0.5R (14518.25) and only the trail moves it; on, +3.2R (14452).
  const bars = [{ h: 14490, l: 14481.5, c: 14485 }, { h: 14440, l: 14415.25, c: 14420 }];
  const off = AFTER({ lockGivebackR: 1.5, trailBy: 'structure', swingMinutes: 15 });
  assert.deepStrictEqual(walkOf(SHORT(), bars, off, 14525).map(r => r.stop), [14518.25, 14518.25]);
  assert.deepStrictEqual(walkOf(SHORT(), bars, { afterTarget: { ...off.afterTarget, ratchet: false } }, 14525).map(r => r.stop), [14518.25, 14518.25]);
  assert.deepStrictEqual(walkOf(SHORT(), bars, RATCHET, 14525).map(r => r.stop), [14518.25, 14452]);
  // Only true turns it on (the plan's flag, from the rulebook's `on`): anything else is off.
  for (const v of ['on', 1, 'true']) assert.deepStrictEqual(walkOf(SHORT(), bars, { afterTarget: { ...off.afterTarget, ratchet: v } }, 14525).map(r => r.stop), [14518.25, 14518.25], String(v));
  // On a random walk, off is step for step the plan without the key.
  const r = rng(5);
  for (let n = 0; n < 50; n += 1) {
    const bar = () => { const c = 14400 + Math.round(r() * 400) / 4 * 1; return { h: c + 2, l: c - 2, c }; };
    const seq = Array.from({ length: 40 }, bar);
    assert.deepStrictEqual(walkOf(SHORT(), seq, off, null), walkOf(SHORT(), seq, { afterTarget: { ...off.afterTarget, ratchet: false } }, null));
  }
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

test('liveTarget: a composed entry\'s target is its plan\'s price (the gate\'s stamp), not the fill-shifted bracket; the resting bracket limit is still cancelled', () => {
  // Planned: limit 21500, target 21520 (80 ticks); filled better at 21498, so the broker's target rests at 21518.
  const orders = [{ id: 10, contractId: 'MNQ', type: 1, side: 1, size: 1, limitPrice: 21518 }, { id: 9, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: 21488 }];
  const r = liveTarget({ rec: { targetTicks: 80, composed: { entry: 21500, stop: 21490, target: 21520 } }, entry: 21498, sign: 1, tick: 0.25, orders, contractId: 'MNQ' });
  assert.deepStrictEqual([r.price, r.cancel.map(o => o.id)], [21520, [10]]);
  // No stamped target: the bracket from the fill, as before.
  assert.strictEqual(liveTarget({ rec: { targetTicks: 80 }, entry: 21498, sign: 1, tick: 0.25, orders, contractId: 'MNQ' }).price, 21518);
  // A short mirrored.
  const s = liveTarget({ rec: { targetTicks: 78, composed: { entry: 14979.5, target: 14960 } }, entry: 14981.5, sign: -1, tick: 0.25, orders: [{ id: 11, contractId: 'MNQ', type: 1, side: 0, size: 1, limitPrice: 14962 }], contractId: 'MNQ' });
  assert.deepStrictEqual([s.price, s.cancel.map(o => o.id)], [14960, [11]]);
});

// The early lock (the rulebook's lock_at_r, lock_to_ticks; the entry/exit PR): once the best price reaches lockAtR the
// stop moves to the entry plus lockToTicks ticks (breakeven covered against the stop's slippage), before the target.
const LOCK = (over = {}) => AFTER({ lockGivebackR: 1.5, trailBy: 'structure', swingMinutes: 15, trailR: 1, lockAtR: 1, lockToTicks: 2, ...over });

test('afterTargetStep lock: at +lockAtR the stop moves to the entry plus lockToTicks ticks, before the target; never before', () => {
  // Short of +1R (peak 0.975R): nothing moves.
  const short = afterTargetStep(LONG(), { h: 109.75, l: 101, c: 108 }, LOCK(), 0.25);
  assert.deepStrictEqual([short.stop, short.locked, short.close], [90, false, null]);
  // The bar reaching +1R (110): the stop goes to 100 + 2 ticks = 100.5; not armed (the target is 120).
  const at = afterTargetStep(LONG(), { h: 110, l: 104, c: 109 }, LOCK(), 0.25);
  assert.deepStrictEqual([at.stop, at.locked, at.armed, at.close], [100.5, true, false, null]);
  // Locked stays locked from the peak (peakR carried): a later bar lower never loosens it, and it holds the lock.
  const later = afterTargetStep({ ...LONG(), stop: at.stop, peakR: at.peakR }, { h: 106, l: 101, c: 102 }, LOCK(), 0.25);
  assert.deepStrictEqual([later.stop, later.locked, later.close], [100.5, true, null]);
  // A stop already tighter than the lock (the model tightened it) is kept.
  assert.strictEqual(afterTargetStep(LONG({ stop: 103 }), { h: 110, l: 104, c: 109 }, LOCK(), 0.25).stop, 103);
  // The short mirror: entry 100, 1R 10; at 90 the stop is 100 - 0.5 = 99.5.
  const s = afterTargetStep({ sign: -1, entry: 100, risk: 10, stop: 110, peakR: 0, armed: false, target: 80 }, { h: 96, l: 90, c: 91 }, LOCK(), 0.25);
  assert.deepStrictEqual([s.stop, s.locked, s.close], [99.5, true, null]);
  // Lock off (no keys: today's plan): nothing before the target, as before.
  assert.strictEqual(afterTargetStep(LONG(), { h: 110, l: 104, c: 109 }, AFTER({ lockGivebackR: 1.5 }), 0.25).stop, 90);
  // No target known: the lock still applies (it doesn't need the target).
  assert.strictEqual(afterTargetStep(LONG({ target: null }), { h: 110, l: 104, c: 109 }, LOCK(), 0.25).stop, 100.5);
  // A lock on an off-tick entry is snapped to the tick on the safe side (a long's down, a short's up).
  assert.strictEqual(afterTargetStep(LONG({ entry: 100.1, stop: 90.1 }), { h: 110.1, l: 104, c: 109 }, LOCK(), 0.25).stop, 100.5);
  assert.strictEqual(afterTargetStep({ sign: -1, entry: 99.9, risk: 10, stop: 109.9, peakR: 0, armed: false, target: 80 }, { h: 96, l: 89.9, c: 91 }, LOCK(), 0.25).stop, 99.5);
});

test('afterTargetStep lock bar: the new lock stop RESTS when the bar closes beyond it (no market close); closes at the close only when the close is through it', () => {
  // The bar opened under the entry (98), touched +1R (110) and closed at +0.8R (108): the stop rests at 100.5, open.
  const rest = afterTargetStep(LONG(), { o: 98, h: 110, l: 97, c: 108 }, LOCK(), 0.25);
  assert.deepStrictEqual([rest.stop, rest.close], [100.5, null], 'no market close at the lock bar');
  // A close exactly at the lock stop is not beyond it: out at the close.
  const at = afterTargetStep(LONG(), { o: 98, h: 110, l: 97, c: 100.5 }, LOCK(), 0.25);
  assert.deepStrictEqual([at.stop, at.close], [100.5, { price: 100.5, reason: 'lock' }]);
  // A close through it (99): out at the close (a stop above the market can't rest).
  const thru = afterTargetStep(LONG(), { o: 98, h: 110, l: 97, c: 99 }, LOCK(), 0.25);
  assert.deepStrictEqual([thru.stop, thru.close], [100.5, { price: 99, reason: 'lock' }]);
  // Short mirror: rests above a close under 99.5; a close through it closes.
  const S = { sign: -1, entry: 100, risk: 10, stop: 110, peakR: 0, armed: false, target: 80 };
  assert.deepStrictEqual(afterTargetStep(S, { o: 102, h: 103, l: 90, c: 92 }, LOCK(), 0.25).close, null);
  assert.deepStrictEqual(afterTargetStep(S, { o: 102, h: 103, l: 90, c: 101 }, LOCK(), 0.25).close, { price: 101, reason: 'lock' });
  // Only the lock rests: a bar that arms the target too (+2R) and sets a stop past the lock (the 1R fallback, peak 2.1R:
  // 111) through its own low closes at its close, the trail's rule, unchanged.
  const both = afterTargetStep(LONG(), { o: 101, h: 121, l: 100, c: 118 }, LOCK(), 0.25);
  assert.deepStrictEqual([both.stop, both.armed, both.close], [111, true, { price: 118, reason: 'trail' }]);
  // Once rested, a later bar through it is no lock-bar move: the callers fill it as a resting stop (no close here).
  const next = afterTargetStep({ ...LONG(), stop: 100.5, peakR: 1 }, { o: 104, h: 105, l: 100, c: 101 }, LOCK(), 0.25);
  assert.deepStrictEqual([next.stop, next.close], [100.5, null]);
});

test('afterTargetStep lock with the target: the shipped +0.5R floor at 2R and the swing trail still apply above the lock', () => {
  let t = LONG();
  const step = bar => { const r = afterTargetStep(t, bar, LOCK(), 0.25, bar.swing ?? null); t = { ...t, stop: r.stop, peakR: r.peakR, armed: r.armed }; return r; };
  assert.strictEqual(step({ h: 111, l: 104, c: 110 }).stop, 100.5);
  // 2R reached: the target's lock (2R - 1.5R = +0.5R: 105) and, with no swing yet, the 1R fallback (peak 2R - 1R: 110).
  assert.strictEqual(step({ h: 120, l: 112, c: 119 }).stop, 110);
  // A swing low confirmed at 116: the stop a tick under it.
  assert.strictEqual(step({ h: 124, l: 118, c: 123, swing: 116 }).stop, 115.75);
});

test('afterTargetStep lock property: on random paths the stop never loosens; once locked every exit is at the lock or better but for a gap or the lock bar closing through it', () => {
  const r = rng(11);
  for (let n = 0; n < 400; n += 1) {
    const sign = r() < 0.5 ? 1 : -1;
    const risk = 2 + Math.floor(r() * 40) * 0.25;
    const entry = 20000;
    let t = { sign, entry, risk, stop: entry - sign * risk, peakR: 0, armed: false, target: entry + sign * 2 * risk };
    let px = entry;
    let locked = false;
    const lockStop = entry + sign * 0.5;
    for (let k = 0; k < 120; k += 1) {
      const o = Math.round((px + (r() - 0.5) * risk * 0.8) * 4) / 4;
      const c = Math.round((o + (r() - 0.5) * risk * 0.8) * 4) / 4;
      const bar = { o, h: Math.max(o, c) + Math.round(r() * risk) / 4, l: Math.min(o, c) - Math.round(r() * risk) / 4, c };
      // The resting stop first (as every caller fills it), at the stop or a worse open.
      if (sign > 0 ? bar.l <= t.stop : bar.h >= t.stop) {
        const fill = sign > 0 ? Math.min(bar.o, t.stop) : Math.max(bar.o, t.stop);
        if (locked) assert.ok(sign * (fill - lockStop) >= 0 || sign * (bar.o - t.stop) < 0, `locked: a stop fill ${fill} at or past the lock ${lockStop}, or a gap`);
        break;
      }
      const s = afterTargetStep(t, bar, LOCK({ trailBy: 'r' }), 0.25);
      assert.ok(sign * (s.stop - t.stop) >= 0, 'never looser');
      if (s.locked) assert.ok(sign * (s.stop - lockStop) >= 0, 'locked: the stop at the lock or tighter');
      if (s.close) {
        assert.ok(s.close.reason === 'trail' || sign * (bar.c - s.stop) <= 0, 'a lock-bar close only with the close through the stop');
        break;
      }
      locked = s.locked;
      t = { ...t, stop: s.stop, peakR: s.peakR, armed: s.armed };
      px = c;
    }
  }
});
