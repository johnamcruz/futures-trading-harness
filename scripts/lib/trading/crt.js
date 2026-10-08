'use strict';

/**
 * Candle Range Theory (CRT) sweep detector, run causally on lower-timeframe
 * bars (e.g. 3-minute) against higher-timeframe candles of `minutes` (60, 240).
 *
 * C1 is the previous higher-timeframe candle: its high and low are the range.
 * C2 is the candle in progress. A setup is:
 *
 *   1. Sweep: C2 trades beyond exactly one side of C1 (beyond both voids the
 *      candle: an outside candle is expansion, not a raid).
 *   2. Depth: the sweep goes no further than `maxDepth` x C1's range past it
 *      (deeper is acceptance: a breakout).
 *   3. Range: C1's range is at least `minRangeAtr` x ATR (a tiny range has no
 *      room to the far side).
 *   4. Fresh: the sweep extreme was made within the last `sweepBars` bars; a
 *      deeper extreme restarts that clock.
 *   5. Reclaim and shift: the bar closes back inside C1's range and beyond the
 *      extreme of the `shiftBars` bars before it (a lower-timeframe market
 *      structure shift away from the sweep).
 *   6. Room: the far side of C1 (the CRT target) is at least `minRR` x the
 *      risk away, the risk being the distance to the sweep extreme plus
 *      `bufferAtr` x ATR.
 *
 * One setup per C2 candle: after it fires, that candle is done (a second
 * attempt after a stop-out is the raid failing, not a new raid).
 *
 * Returns per bar: dir (1 long, -1 short, 0), risk (stop distance), target
 * (distance to C1's far side), and depth (the sweep past C1, in price), NaN
 * where no setup fires; and explain(i), the detector's state on bar i and
 * why it did or didn't fire (for scan output, decision logs, and debugging).
 */

const { htfCandles } = require('./indicators');

const DEFAULTS = { sweepBars: 10, shiftBars: 5, maxDepth: 0.5, minRangeAtr: 2, bufferAtr: 0.25, minRR: 2 };

function crtSeries(bars, minutes, atr, opts = {}) {
  // An undefined option keeps its default (a missing param must not disable the detector).
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const n = bars.length;
  const out = { dir: new Array(n).fill(0), risk: new Array(n).fill(NaN), target: new Array(n).fill(NaN), depth: new Array(n).fill(NaN) };
  // Per bar, for explain(): why (a REASONS key) and the numbers behind it.
  const why = new Array(n);
  const info = new Array(n);
  const h = htfCandles(bars, minutes);
  let st = null;
  for (let i = 0; i < n; i += 1) {
    const b = bars[i];
    if (!st || st.key !== h.key[i]) st = { key: h.key[i], high: false, low: false, fired: false, firedAt: -1, hi: -Infinity, hiAt: -1, lo: Infinity, loAt: -1 };
    const c1h = h.prevH[i];
    const c1l = h.prevL[i];
    if (b.h > st.hi) { st.hi = b.h; st.hiAt = i; }
    if (b.l < st.lo) { st.lo = b.l; st.loAt = i; }
    // C1's open and close too: the skill rules read its body (one long body, closes mid-range).
    const done = (reason, extra = {}) => { why[i] = reason; info[i] = { c1Open: h.prevO[i], c1High: c1h, c1Low: c1l, c1Close: h.prevC[i], high: st.hi, low: st.lo, ...extra }; };
    if (!Number.isFinite(c1h) || !Number.isFinite(c1l)) { done('no_previous_candle'); continue; }
    if (st.hi > c1h) st.high = true;
    if (st.lo < c1l) st.low = true;
    const a = atr[i];
    if (st.fired) { done('fired_this_candle', { firedBarsAgo: i - st.firedAt }); continue; }
    if (st.high && st.low) { done('both_sides_swept'); continue; }
    if (!st.high && !st.low) { done('no_sweep'); continue; }
    if (!Number.isFinite(a) || a <= 0) { done('no_atr'); continue; }
    const range = c1h - c1l;
    const side = st.low ? 'long' : 'short';
    const extreme = st.low ? st.lo : st.hi;
    const depth = st.low ? c1l - st.lo : st.hi - c1h;
    const age = i - (st.low ? st.loAt : st.hiAt);
    const base = { side, extreme, depth, range, atr: a, barsSinceExtreme: age };
    if (!(range >= o.minRangeAtr * a)) { done('range_too_small', { ...base, minRange: o.minRangeAtr * a }); continue; }
    if (depth > o.maxDepth * range) { done('too_deep', { ...base, maxDepth: o.maxDepth * range }); continue; }
    if (age > o.sweepBars) { done('stale', { ...base, sweepBars: o.sweepBars }); continue; }
    if (i < o.shiftBars) { done('warming_up', base); continue; }
    let prevHigh = -Infinity;
    let prevLow = Infinity;
    for (let k = i - o.shiftBars; k < i; k += 1) { prevHigh = Math.max(prevHigh, bars[k].h); prevLow = Math.min(prevLow, bars[k].l); }
    const buffer = o.bufferAtr * a;
    const long = side === 'long';
    const risk = long ? b.c - st.lo + buffer : st.hi - b.c + buffer;
    const target = long ? c1h - b.c : b.c - c1l;
    const shiftLevel = long ? prevHigh : prevLow;
    const more = { ...base, close: b.c, shiftLevel, risk, target, rr: risk > 0 ? target / risk : null };
    if (long ? !(b.c > c1l) : !(b.c < c1h)) { done('not_reclaimed', more); continue; }
    if (long ? !(b.c > prevHigh) : !(b.c < prevLow)) { done('no_shift', more); continue; }
    if (!(risk > 0 && target >= o.minRR * risk)) { done('no_room', { ...more, minRR: o.minRR }); continue; }
    st.fired = true;
    st.firedAt = i;
    out.dir[i] = long ? 1 : -1; out.risk[i] = risk; out.target[i] = target; out.depth[i] = depth;
    done('fired', more);
  }
  const r = x => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);
  out.explain = i => {
    if (i < 0 || i >= n || !why[i]) return null;
    const x = Object.fromEntries(Object.entries(info[i]).map(([k, v]) => [k, r(v)]).filter(([, v]) => v !== -Infinity && v !== Infinity && !(typeof v === 'number' && Number.isNaN(v))));
    return { minutes, reason: why[i], why: REASONS[why[i]], ...x };
  };
  return out;
}

/** Why the detector did or didn't fire on a bar. */
const REASONS = {
  no_previous_candle: 'no complete previous candle in the bars yet',
  no_sweep: 'this candle has not traded beyond the previous candle\'s high or low',
  both_sides_swept: 'this candle took both sides of the previous candle (an outside candle): void',
  fired_this_candle: 'already fired once on this candle',
  no_atr: 'ATR not available yet',
  range_too_small: 'the previous candle\'s range is under crtMinRangeAtr x ATR',
  too_deep: 'the sweep went past crtMaxDepth x the range (acceptance, not a raid)',
  stale: 'the sweep extreme is older than crtSweepBars bars',
  warming_up: 'not enough bars before this one for the shift check',
  not_reclaimed: 'the close is not back inside the previous candle\'s range',
  no_shift: 'the close has not broken the extreme of the crtShiftBars bars before it',
  no_room: 'the far side of the range is under crtMinRR x the risk away',
  fired: 'a CRT setup: sweep, reclaim, shift, and room to the far side',
};

module.exports = { DEFAULTS, REASONS, crtSeries };
