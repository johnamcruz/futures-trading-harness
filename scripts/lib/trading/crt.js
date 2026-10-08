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
 * where no setup fires.
 */

const { htfCandles } = require('./indicators');

const DEFAULTS = { sweepBars: 10, shiftBars: 5, maxDepth: 0.5, minRangeAtr: 2, bufferAtr: 0.25, minRR: 2 };

function crtSeries(bars, minutes, atr, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = bars.length;
  const out = { dir: new Array(n).fill(0), risk: new Array(n).fill(NaN), target: new Array(n).fill(NaN), depth: new Array(n).fill(NaN) };
  const h = htfCandles(bars, minutes);
  let st = null;
  for (let i = 0; i < n; i += 1) {
    const b = bars[i];
    if (!st || st.key !== h.key[i]) st = { key: h.key[i], high: false, low: false, fired: false, hi: -Infinity, hiAt: -1, lo: Infinity, loAt: -1 };
    const c1h = h.prevH[i];
    const c1l = h.prevL[i];
    if (b.h > st.hi) { st.hi = b.h; st.hiAt = i; }
    if (b.l < st.lo) { st.lo = b.l; st.loAt = i; }
    if (!Number.isFinite(c1h) || !Number.isFinite(c1l)) continue;
    if (st.hi > c1h) st.high = true;
    if (st.lo < c1l) st.low = true;
    const a = atr[i];
    if (st.fired || st.high === st.low || !Number.isFinite(a) || a <= 0) continue;
    const range = c1h - c1l;
    if (!(range >= o.minRangeAtr * a)) continue;
    if (i < o.shiftBars) continue;
    let prevHigh = -Infinity;
    let prevLow = Infinity;
    for (let k = i - o.shiftBars; k < i; k += 1) { prevHigh = Math.max(prevHigh, bars[k].h); prevLow = Math.min(prevLow, bars[k].l); }
    const buffer = o.bufferAtr * a;
    if (st.low) {
      const depth = c1l - st.lo;
      const risk = b.c - st.lo + buffer;
      const target = c1h - b.c;
      if (depth <= o.maxDepth * range && i - st.loAt <= o.sweepBars && b.c > c1l && b.c > prevHigh && risk > 0 && target >= o.minRR * risk) {
        Object.assign(st, { fired: true });
        out.dir[i] = 1; out.risk[i] = risk; out.target[i] = target; out.depth[i] = depth;
      }
    } else {
      const depth = st.hi - c1h;
      const risk = st.hi - b.c + buffer;
      const target = b.c - c1l;
      if (depth <= o.maxDepth * range && i - st.hiAt <= o.sweepBars && b.c < c1h && b.c < prevLow && risk > 0 && target >= o.minRR * risk) {
        Object.assign(st, { fired: true });
        out.dir[i] = -1; out.risk[i] = risk; out.target[i] = target; out.depth[i] = depth;
      }
    }
  }
  return out;
}

module.exports = { DEFAULTS, crtSeries };
