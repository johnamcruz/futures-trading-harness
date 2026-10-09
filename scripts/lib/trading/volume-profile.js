'use strict';

/**
 * Volume profile from bars: how much volume traded at each price over a
 * window. Generic: any strategy, skill, the snapshot, and the RL observation
 * read it, over any window of closed bars.
 *
 * The method is the standard market-profile one (as in LuxAlgo's "Volume
 * Profile with Node Detection", re-implemented here, not copied):
 *   rows        the window's low..high split into `rows` equal rows (or rows of
 *               `rowSize` points on a grid anchored at 0, so levels sit on prices;
 *               a high on a row's lower edge belongs to the row below)
 *   volume      each bar's volume spread over the rows its low..high covers, in
 *               proportion to the overlap; up volume is a bar closing above its open
 *   POC         the row with the most volume (the lowest such row on a tie)
 *   value area  from the POC, add the bigger neighbouring row (above on a tie)
 *               until it holds `valueArea` (70%) of the volume: VAL..VAH
 *   HVN / LVN   a row with more (less) volume than each of the N rows on either
 *               side, N = rows x nodePct (troughPct), ignoring rows under
 *               `threshold` x the POC's volume; beyond the profile counts as no
 *               volume (peaks) or the POC's (troughs), so an edge row can be a node
 *
 * Bar-based: the profile is an approximation of a tick profile (a bar's
 * volume is assumed spread evenly over its range). Finer bars give a sharper
 * profile. Differences from that indicator: it splits lower-timeframe bars
 * when the chart has them (here: the bars given); it divides by zero on a bar
 * with no range, which voids that row in Pine (here: the bar's volume goes to
 * its row); and it draws only on the last bar, over the trailing window, so
 * history repaints (here: every bar gets its own window, see below).
 *
 * Causal: the series (profileSeries) give bar i the profile of bars that had
 * closed by bar i's close, never a later bar. Windows:
 *   prior_rth   the last complete RTH day (09:30-16:00 ET), from the first bar after it
 *   session     the Globex session in progress (from 18:00 ET), through bar i
 *   rolling n   the last n bars through bar i
 * A window the bars start in the middle of is partial: no profile, not a wrong one.
 */

const ind = require('./indicators');

const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;
const GLOBEX_OPEN = 18 * 60;
const MAX_ROWS = 2000;

const DEFAULTS = { rows: 100, rowSize: 0, valueArea: 0.7, nodePct: 0.09, troughPct: 0.07, threshold: 0.01 };

/** Options from a strategy's params (vpRows, vpRowSize, vpValueArea, vpNodePct, vpTroughPct, vpThreshold), in percent where the source uses percent. */
function optionsFromParams(p = {}) {
  const o = { ...DEFAULTS };
  if (Number.isFinite(p.vpRows)) o.rows = p.vpRows;
  if (Number.isFinite(p.vpRowSize)) o.rowSize = p.vpRowSize;
  if (Number.isFinite(p.vpValueArea)) o.valueArea = p.vpValueArea / 100;
  if (Number.isFinite(p.vpNodePct)) o.nodePct = p.vpNodePct / 100;
  if (Number.isFinite(p.vpTroughPct)) o.troughPct = p.vpTroughPct / 100;
  if (Number.isFinite(p.vpThreshold)) o.threshold = p.vpThreshold / 100;
  return o;
}

/** Rows strictly above (peak) or below (trough) each of their n neighbours on both sides; padding counts as 0 (peaks) or the max (troughs). */
function nodes(vol, n, peak, threshold) {
  if (n < 1) return [];
  const max = Math.max(...vol);
  const pad = peak ? 0 : max;
  const v = k => (k < 0 || k >= vol.length ? pad : vol[k]);
  const out = [];
  for (let k = 0; k < vol.length; k += 1) {
    let ok = vol[k] / max > threshold;
    for (let d = 1; ok && d <= n; d += 1) ok = peak ? vol[k] > v(k - d) && vol[k] > v(k + d) : vol[k] < v(k - d) && vol[k] < v(k + d);
    if (ok) out.push(k);
  }
  return out;
}

/**
 * The profile of bars[from..to] (inclusive), or null (no range or no volume).
 * { from, to, low, high, step, rows: [{ low, high, volume, up }], poc, vah, val,
 *   pocVolume, total, hvn: [price], lvn: [price] } (node prices are row middles).
 */
function buildProfile(bars, from, to, options = {}) {
  const o = { ...DEFAULTS, ...options };
  let lo = Infinity; let hi = -Infinity;
  for (let j = from; j <= to; j += 1) { lo = Math.min(lo, bars[j].l); hi = Math.max(hi, bars[j].h); }
  if (!(hi > lo)) return null;
  let low = lo; let step; let n;
  if (o.rowSize > 0) {
    step = o.rowSize;
    low = Math.floor(lo / step + 1e-9) * step;
    n = Math.max(1, Math.min(MAX_ROWS, Math.ceil((hi - low) / step - 1e-9)));
  } else {
    n = Math.max(1, Math.min(MAX_ROWS, Math.round(o.rows)));
    step = (hi - low) / n;
  }
  const vol = new Array(n).fill(0);
  const up = new Array(n).fill(0);
  for (let j = from; j <= to; j += 1) {
    const b = bars[j];
    const v = Number(b.v) || 0;
    if (v <= 0) continue;
    const s = Math.max(Math.floor((b.l - low) / step + 1e-9), 0);
    const e = Math.min(Math.floor((b.h - low) / step + 1e-9), n - 1);
    const range = b.h - b.l;
    const bull = b.c > b.o;
    for (let k = s; k <= e; k += 1) {
      const rLow = low + k * step;
      // The share of the bar's range inside this row (all of it for a bar with no range).
      const share = range > 0 ? Math.max(0, Math.min(b.h, rLow + step) - Math.max(b.l, rLow)) / range : (k === s ? 1 : 0);
      vol[k] += v * share;
      if (bull) up[k] += v * share;
    }
  }
  const total = vol.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  let poc = 0;
  for (let k = 1; k < n; k += 1) if (vol[k] > vol[poc]) poc = k;
  let vah = poc; let val = poc; let inside = vol[poc];
  while (inside < total * o.valueArea) {
    if (val === 0 && vah === n - 1) break;
    const above = vah < n - 1 ? vol[vah + 1] : 0;
    const below = val > 0 ? vol[val - 1] : 0;
    if (above === 0 && below === 0) break;
    if (above >= below) { inside += above; vah += 1; } else { inside += below; val -= 1; }
  }
  const mid = k => low + (k + 0.5) * step;
  return {
    from, to, low, high: low + n * step, step,
    rows: vol.map((volume, k) => ({ low: low + k * step, high: low + (k + 1) * step, volume, up: up[k] })),
    poc: mid(poc), vah: low + (vah + 1) * step, val: low + val * step, pocVolume: vol[poc], total,
    hvn: nodes(vol, Math.floor(n * o.nodePct), true, o.threshold).map(mid),
    lvn: nodes(vol, Math.floor(n * o.troughPct), false, o.threshold).map(mid),
  };
}

/** The node nearest above (dir 1) or below (dir -1) `price` in `list`, or NaN. */
function nearest(list, price, dir) {
  let best = NaN;
  for (const x of list) if (dir > 0 ? x > price && !(x >= best) : x < price && !(x <= best)) best = x;
  return best;
}

/** [start index of the window that bar i closes, or -1 when it is partial or not yet known] for each bar. */
function windowStarts(bars, kind, length) {
  const n = bars.length;
  const out = new Array(n).fill(-1);
  if (kind === 'rolling') {
    for (let i = length - 1; i < n; i += 1) out[i] = i - length + 1;
    return out;
  }
  if (kind === 'session') {
    let key = null; let start = -1;
    for (let i = 0; i < n; i += 1) {
      const k = ind.sessionKey(bars[i].t, GLOBEX_OPEN);
      if (k !== key) { key = k; start = i > 0 || ind.etInfo(bars[i].t).minute === GLOBEX_OPEN ? i : -1; }
      out[i] = start;
    }
    return out;
  }
  throw new Error(`unknown profile window "${kind}"`);
}

/**
 * Per-bar profile levels for a window: { profile: [profile|null], poc, vah,
 * val, hvn_above, hvn_below, lvn_above, lvn_below } (NaN where none). Node
 * above/below is relative to bar i's close. kind: 'prior_rth' | 'session' |
 * 'rolling' (with length).
 */
function profileSeries(bars, kind, { length = 0, options = {} } = {}) {
  const n = bars.length;
  const profile = new Array(n).fill(null);
  if (kind === 'prior_rth') {
    let day = null; let start = -1; let last = -1; let prior = null;
    for (let i = 0; i < n; i += 1) {
      const { day: d, minute } = ind.etInfo(bars[i].t);
      const inRth = minute >= RTH_OPEN && minute < RTH_CLOSE;
      // The day in progress ends at the first bar past it (a later day, or 16:00 ET on).
      if (day !== null && (d !== day || !inRth)) {
        if (start >= 0) prior = buildProfile(bars, start, last, options);
        day = null;
      }
      if (inRth) {
        if (day === null) { day = d; start = i > 0 ? i : -1; }
        last = i;
      }
      profile[i] = prior;
    }
  } else {
    const starts = windowStarts(bars, kind, length);
    for (let i = 0; i < n; i += 1) if (starts[i] >= 0) profile[i] = buildProfile(bars, starts[i], i, options);
  }
  const pick = f => profile.map((p, i) => (p ? f(p, i) : NaN));
  return {
    profile,
    poc: pick(p => p.poc), vah: pick(p => p.vah), val: pick(p => p.val),
    hvn_above: pick((p, i) => nearest(p.hvn, bars[i].c, 1)), hvn_below: pick((p, i) => nearest(p.hvn, bars[i].c, -1)),
    lvn_above: pick((p, i) => nearest(p.lvn, bars[i].c, 1)), lvn_below: pick((p, i) => nearest(p.lvn, bars[i].c, -1)),
  };
}

/** The profile bar i sees in a window (as profileSeries gives it), computing only that one. */
function profileAt(bars, kind, i, { length = 0, options = {} } = {}) {
  if (kind === 'prior_rth') return profileSeries(bars.slice(0, i + 1), 'prior_rth', { options }).profile[i];
  const start = windowStarts(bars.slice(0, i + 1), kind, length)[i];
  return start >= 0 ? buildProfile(bars, start, i, options) : null;
}

/** A compact summary of a profile for a snapshot or a prompt, with price's place in it. */
function describe(p, price, atr, round = x => x) {
  if (!p) return null;
  const where = price > p.vah ? 'above value' : price < p.val ? 'below value' : 'inside value';
  const dist = x => (atr > 0 ? round((price - x) / atr) : null);
  return {
    poc: round(p.poc), vah: round(p.vah), val: round(p.val), low: round(p.low), high: round(p.high),
    price: where, fromPocAtr: dist(p.poc),
    hvnAbove: Number.isFinite(nearest(p.hvn, price, 1)) ? round(nearest(p.hvn, price, 1)) : null,
    hvnBelow: Number.isFinite(nearest(p.hvn, price, -1)) ? round(nearest(p.hvn, price, -1)) : null,
    lvnAbove: Number.isFinite(nearest(p.lvn, price, 1)) ? round(nearest(p.lvn, price, 1)) : null,
    lvnBelow: Number.isFinite(nearest(p.lvn, price, -1)) ? round(nearest(p.lvn, price, -1)) : null,
    hvn: p.hvn.map(round), lvn: p.lvn.map(round),
    bars: p.to - p.from + 1,
  };
}

module.exports = { DEFAULTS, optionsFromParams, buildProfile, profileSeries, profileAt, nearest, describe };
