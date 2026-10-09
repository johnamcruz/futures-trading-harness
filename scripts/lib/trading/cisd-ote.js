'use strict';

/**
 * CISD + OTE detection, a faithful port of algoTraderBot
 * strategies/cisd_ote_detect.py (itself a verbatim port of the model's training
 * pipeline). Kept line-for-line close to the source on purpose, quirks
 * included; tests/lib/cisd-ote.test.js checks it against the source's output.
 *
 * A CISD displacement on 12-minute bars (from 3-minute bars) defines an OTE
 * fib zone (0.5-0.705 of the leg); a later 3-minute bar trading back into the
 * zone (entry mode "bot": a long needs the bar's low at or below the zone
 * bottom, a short its high at or above it) fires an entry at the next bar's
 * open, with the stop at the leg's origin (pivot).
 *
 * detect(bars) evaluates the last bar of a window like the source's
 * CisdOteStrategy.detect: a signal whose entry executes on the last bar.
 */

const PARAMS = {
  cisdTf: 12, swingPeriod: 3, tolerance: 0.5, expiryBars: 9, liquidityLookback: 5,
  fib1: 0.5, fib2: 0.705, dispBodyRatioMin: 0.3, dispCloseStrMin: 0.4,
  requireSweep: false, entryMode: 'bot', slMode: 'pivot',
};
const MIN_RISK_FRAC = 1e-4;
const ATR_P = 20;
const CTX = 128;
const MINUTE = 60000;

/** pandas df.resample('12min').agg(first/max/min/last/sum).dropna(close): bins at epoch multiples, labelled by start. */
function resample(bars, minutes) {
  const out = [];
  const step = minutes * MINUTE;
  for (const b of bars) {
    const start = Math.floor(b.ms / step) * step;
    const last = out[out.length - 1];
    if (last && last.ms === start) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
    } else {
      out.push({ ms: start, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
  }
  return out;
}

/** A bar is a pivot when it is the unique extreme of its (2p+1)-bar window. */
function detectPivots(h, l, p) {
  const ph = [];
  const pl = [];
  for (let s = 0; s + 2 * p < h.length; s += 1) {
    const ch = h[s + p];
    const cl = l[s + p];
    let maxH = -Infinity; let minL = Infinity; let eqH = 0; let eqL = 0;
    for (let k = s; k <= s + 2 * p; k += 1) {
      if (h[k] > maxH) maxH = h[k];
      if (l[k] < minL) minL = l[k];
    }
    for (let k = s; k <= s + 2 * p; k += 1) {
      if (h[k] === ch) eqH += 1;
      if (l[k] === cl) eqL += 1;
    }
    if (ch === maxH && eqH === 1) ph.push(s + p);
    if (cl === minL && eqL === 1) pl.push(s + p);
  }
  return { ph, pl };
}

function detectZoneSignals(z, p = PARAMS) {
  const o = z.map(b => b.o); const h = z.map(b => b.h); const l = z.map(b => b.l); const c = z.map(b => b.c);
  const n = c.length;
  const sw = p.swingPeriod; const tol = p.tolerance; const exp = p.expiryBars; const liq = p.liquidityLookback;
  const { ph, pl } = detectPivots(h, l, sw);
  const shByConf = new Map(); const slByConf = new Map();
  for (const b of ph) { const cf = b + sw; if (cf < n) (shByConf.get(cf) || shByConf.set(cf, []).get(cf)).push([h[b], b]); }
  for (const b of pl) { const cf = b + sw; if (cf < n) (slByConf.get(cf) || slByConf.set(cf, []).get(cf)).push([l[b], b]); }

  const sig = new Array(n).fill(0);
  const fibTop = new Array(n).fill(NaN); const fibBot = new Array(n).fill(NaN); const origin = new Array(n).fill(NaN);
  const hadSweep = new Array(n).fill(0); const disp = new Array(n).fill(0);
  let activeSh = []; let activeSl = [];
  let lastWickedHigh = -1e9; let lastWickedLow = -1e9;
  const bearPots = []; const bullPots = [];
  const maxRange = (arr, a, b) => { let m = -Infinity; for (let k = a; k <= b; k += 1) if (arr[k] > m) m = arr[k]; return m; };
  const minRange = (arr, a, b) => { let m = Infinity; for (let k = a; k <= b; k += 1) if (arr[k] < m) m = arr[k]; return m; };

  for (let bar = 1; bar < n; bar += 1) {
    for (const x of shByConf.get(bar) || []) activeSh.push(x);
    for (const x of slByConf.get(bar) || []) activeSl.push(x);
    activeSh = activeSh.filter(([pr, b]) => {
      if (bar - b >= exp) return false;
      if (h[bar] >= pr) { lastWickedHigh = bar; return false; }
      return true;
    });
    activeSl = activeSl.filter(([pr, b]) => {
      if (bar - b >= exp) return false;
      if (l[bar] <= pr) { lastWickedLow = bar; return false; }
      return true;
    });
    if (c[bar - 1] < o[bar - 1] && c[bar] > o[bar]) bearPots.push([o[bar], bar]);
    if (c[bar - 1] > o[bar - 1] && c[bar] < o[bar]) bullPots.push([o[bar], bar]);
    while (bearPots.length && bar - bearPots[0][1] >= exp) bearPots.shift();
    while (bullPots.length && bar - bullPots[0][1] >= exp) bullPots.shift();

    // Bearish CISD
    while (bearPots.length) {
      const [potPrice, potBar] = bearPots[0];
      if (!(c[bar] < potPrice)) break;
      const highestC = maxRange(c, potBar, bar);
      let topLevel = 0;
      let idx = potBar + 1;
      while (idx < bar && c[idx] < o[idx]) { topLevel = o[idx]; idx += 1; }
      if (topLevel > 0 && topLevel - potPrice > 0) {
        const ratio = (highestC - potPrice) / (topLevel - potPrice);
        if (ratio > tol) {
          const fr = h[bar] - l[bar];
          const br = fr > 0 ? Math.abs(c[bar] - o[bar]) / fr : 0;
          const cs = fr > 0 ? (h[bar] - c[bar]) / fr : 0;
          if (br >= p.dispBodyRatioMin && cs >= p.dispCloseStrMin) {
            sig[bar] = 1;
            disp[bar] = ratio;
            if (bar - lastWickedHigh <= liq) hadSweep[bar] = 1;
            const hMax = maxRange(h, potBar, bar);
            const diff = hMax - l[bar];
            fibTop[bar] = Math.max(hMax - diff * p.fib1, hMax - diff * p.fib2);
            fibBot[bar] = Math.min(hMax - diff * p.fib1, hMax - diff * p.fib2);
            origin[bar] = hMax;
            bearPots.length = 0;
            break;
          }
        }
      }
      bearPots.shift();
    }

    // Bullish CISD
    while (bullPots.length) {
      const [potPrice, potBar] = bullPots[0];
      if (!(c[bar] > potPrice)) break;
      const lowestC = minRange(c, potBar, bar);
      let bottomLevel = 0;
      let idx = potBar + 1;
      while (idx < bar && c[idx] > o[idx]) { bottomLevel = o[idx]; idx += 1; }
      if (bottomLevel > 0 && potPrice - bottomLevel > 0) {
        const ratio = (potPrice - lowestC) / (potPrice - bottomLevel);
        if (ratio > tol) {
          const fr = h[bar] - l[bar];
          const br = fr > 0 ? Math.abs(c[bar] - o[bar]) / fr : 0;
          const cs = fr > 0 ? (c[bar] - l[bar]) / fr : 0;
          if (br >= p.dispBodyRatioMin && cs >= p.dispCloseStrMin) {
            sig[bar] = 2;
            disp[bar] = ratio;
            if (bar - lastWickedLow <= liq) hadSweep[bar] = 1;
            const lMin = minRange(l, potBar, bar);
            const diff = h[bar] - lMin;
            fibTop[bar] = Math.max(lMin + diff * p.fib1, lMin + diff * p.fib2);
            fibBot[bar] = Math.min(lMin + diff * p.fib1, lMin + diff * p.fib2);
            origin[bar] = lMin;
            bullPots.length = 0;
            break;
          }
        }
      }
      bullPots.shift();
    }
  }
  return { sig, fibTop, fibBot, origin, hadSweep, disp };
}

/** First index with t[i] > x (numpy searchsorted side="right"). */
function searchRight(t, x) {
  let lo = 0; let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The source's entry loop: every signal that fired in the window. */
function extractSignals(bars, zone, zs, p = PARAMS) {
  const t3 = bars.map(b => b.ms);
  const n3 = bars.length;
  const t15 = zone.map(b => b.ms);
  const n15 = zone.length;
  const sw = p.swingPeriod;
  const zoneDt = p.cisdTf * MINUTE;
  const recs = [];
  const active = [];
  for (let i15 = sw * 3; i15 < n15; i15 += 1) {
    const s = zs.sig[i15];
    if ((s === 1 || s === 2) && !Number.isNaN(zs.fibTop[i15])) {
      active.unshift({
        fibTop: zs.fibTop[i15], fibBot: zs.fibBot[i15], origin: zs.origin[i15], created: i15,
        isBull: s === 2, fired: false, entered: false, hadSweep: Boolean(zs.hadSweep[i15]), disp: zs.disp[i15],
      });
      if (active.length > 20) active.pop();
    }
    const prevT = i15 > 0 ? t15[i15 - 1] : 0;
    const jStart = searchRight(t3, prevT);
    const jEnd = searchRight(t3, t15[i15]);
    const rm = [];
    active.forEach((z, zi) => {
      const invalid = (z.isBull && zone[i15].c < z.fibBot) || (!z.isBull && zone[i15].c > z.fibTop);
      if (zone[i15].l <= z.fibTop && zone[i15].h >= z.fibBot) z.entered = true;
      if (z.entered && !z.fired && !invalid && i15 > z.created) {
        if (p.requireSweep && !z.hadSweep) {
          if (invalid) rm.push(zi);
          return;
        }
        const isLong = z.isBull;
        const ce = 0.5 * (z.fibTop + z.fibBot);
        const limit = { top: z.fibTop, ce, bot: z.fibBot }[p.entryMode];
        const sl = p.slMode === 'pivot' && !Number.isNaN(z.origin) ? z.origin : (isLong ? z.fibBot : z.fibTop);
        for (let j3 = jStart; j3 < Math.min(jEnd, n3); j3 += 1) {
          if (t3[j3] < t15[z.created] + zoneDt) continue; // zone not yet confirmed
          if (!(bars[j3].l <= z.fibTop && bars[j3].h >= z.fibBot)) continue;
          if (isLong ? bars[j3].l > limit : bars[j3].h < limit) continue;
          if (j3 + 1 >= n3) continue;
          const entry = bars[j3 + 1].o;
          const execIdx = j3 + 1;
          const risk = isLong ? entry - sl : sl - entry;
          if (risk < MIN_RISK_FRAC * entry) continue;
          z.fired = true;
          recs.push({ sigBar: j3, execIdx, isLong, entry, sl, fibTop: z.fibTop, fibBot: z.fibBot, zoneAge: i15 - z.created, hadSweep: z.hadSweep, disp: z.disp });
          break;
        }
      }
      if (invalid) rm.push(zi);
    });
    for (let k = rm.length - 1; k >= 0; k -= 1) if (rm[k] < active.length) active.splice(rm[k], 1);
  }
  return recs;
}

/**
 * The signal executing on the last bar of `bars` ({ms,o,h,l,c,v}, oldest
 * first; the source's 500-bar window), or null: { direction, entry, stop, risk }.
 * `atr` is ATR(20) of the same window (the source requires a finite, positive
 * value at the signal bar).
 */
function detect(bars, atr, p = PARAMS) {
  if (bars.length < CTX + ATR_P + 5) return null;
  const zone = resample(bars, p.cisdTf);
  const recs = extractSignals(bars, zone, detectZoneSignals(zone, p), p);
  const last = bars.length - 1;
  let rec = null;
  for (let k = recs.length - 1; k >= 0; k -= 1) if (recs[k].execIdx === last) { rec = recs[k]; break; }
  if (!rec) return null;
  const a = atr[rec.sigBar];
  if (!(Number.isFinite(a) && a > 0)) return null;
  const risk = Math.abs(rec.entry - rec.sl);
  if (!(risk > 0)) return null;
  // hadSweep and disp: the body's skip rules ask whether a sweep preceded the displacement.
  return { direction: rec.isLong ? 'long' : 'short', entry: rec.entry, stop: rec.sl, risk, hadSweep: Boolean(rec.hadSweep), disp: rec.disp };
}

module.exports = { PARAMS, resample, detectPivots, detectZoneSignals, extractSignals, detect };
