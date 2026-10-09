'use strict';

/**
 * Volume profile from bars: how much volume traded at each price over a
 * window. Generic: any strategy, skill, the snapshot, and the RL observation
 * read it, over any window of closed bars.
 *
 * The method is the standard market-profile one (as in LuxAlgo's "Volume
 * Profile with Node Detection", re-implemented here, not copied):
 *   rows        the window's low..high split into `rows` equal rows, or one row per
 *               price on a grid of `rowSize` points (0.25: one MNQ tick), centred on
 *               it, so the POC, value area, and nodes are prices
 *   volume      each bar's volume spread over the rows its low..high covers, in
 *               proportion to the overlap; up volume is a bar closing above its open
 *   POC         the row with the most volume (the lowest such row on a tie)
 *   value area  from the POC, add the bigger of the next traded rows above and
 *               below (above on a tie) until it holds `valueArea` (70%) of the
 *               volume: VAL..VAH (the outer edges; on a grid, the edge rows' prices)
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
 * its row); its value area stops at the first empty row (here: it steps over
 * empty rows, such as a halt gap, to the next traded one); and it draws only on the last bar, over the trailing window, so
 * history repaints (here: every bar gets its own window, see below).
 *
 * Causal: the series (profileSeries) give bar i the profile of bars that had
 * closed by bar i's close, never a later bar. Windows:
 *   prior_rth   the last complete RTH day (09:30-16:00 ET), from the first bar after it
 *   session     the Globex session in progress (from 18:00 ET), through bar i
 *   rolling n   the last n bars through bar i
 * A window the bars start in the middle of is partial: no profile, not a wrong one.
 * Cost: prior_rth builds one profile per day; session and rolling build one per
 * bar (about 7 s for 100 rows, 18 s for one-tick rows, over 110k 1-minute bars),
 * keeping only the levels per bar.
 */

const ind = require('./indicators');

const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;
const GLOBEX_OPEN = 18 * 60;
const MAX_ROWS = 2000;

/**
 * The settings, as strategy params and market-snapshot flags: the one place
 * their defaults live (market-snapshot PARAMS spreads them in).
 *   vpRows       rows over the window's range
 *   vpRowSize    rows of this many points on a price grid instead (0 = use vpRows)
 *   vpValueArea  % of the volume in the value area
 *   vpNodePct    a high volume node beats this % of the rows on each side
 *   vpTroughPct  a low volume node is under this % of the rows on each side
 *   vpThreshold  nodes ignore rows under this % of the POC's volume
 */
const PARAM_DEFAULTS = { vpRows: 100, vpRowSize: 0, vpValueArea: 70, vpNodePct: 9, vpTroughPct: 7, vpThreshold: 1 };

/** buildProfile's options from params (percent -> fractions); a missing param takes its default. */
function optionsFromParams(params = {}) {
  const p = { ...PARAM_DEFAULTS };
  for (const k of Object.keys(PARAM_DEFAULTS)) if (Number.isFinite(params[k])) p[k] = params[k];
  return { rows: p.vpRows, rowSize: p.vpRowSize, valueArea: p.vpValueArea / 100, nodePct: p.vpNodePct / 100, troughPct: p.vpTroughPct / 100, threshold: p.vpThreshold / 100 };
}

const DEFAULTS = optionsFromParams();

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
 *   pocVolume, total, hvn: [price], lvn: [price] } (POC and node prices are row
 *   middles, or grid prices with rowSize).
 */
function buildProfile(bars, from, to, options = {}) {
  const o = { ...DEFAULTS, ...options };
  let lo = Infinity; let hi = -Infinity;
  for (let j = from; j <= to; j += 1) { lo = Math.min(lo, bars[j].l); hi = Math.max(hi, bars[j].h); }
  if (!(hi > lo)) return null;
  const grid = o.rowSize > 0;
  let low; let step; let n;
  if (grid) {
    // One row per grid price, centred on it (100.00 holds 99.875..100.125 at 0.25), so every
    // level is a price. Past MAX_ROWS, rows widen by whole multiples of rowSize and stay on the grid.
    const want = Math.round(hi / o.rowSize) - Math.round(lo / o.rowSize) + 1;
    step = o.rowSize * Math.max(1, Math.ceil(want / MAX_ROWS));
    const first = Math.round(lo / step);
    n = Math.round(hi / step) - first + 1;
    low = (first - 0.5) * step;
  } else {
    n = Math.max(1, Math.min(MAX_ROWS, Math.round(o.rows)));
    low = lo;
    step = (hi - lo) / n;
  }
  const vol = new Array(n).fill(0);
  const up = new Array(n).fill(0);
  const row = x => Math.min(Math.max(Math.floor((x - low) / step + 1e-9), 0), n - 1);
  for (let j = from; j <= to; j += 1) {
    const b = bars[j];
    const v = Number(b.v) || 0;
    if (v <= 0) continue;
    const s = row(b.l);
    const e = row(b.h);
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
  // The value area: from the POC, take the bigger of the next traded row above and below (empty
  // rows between are crossed, not a stop: a halt gap or a fast move leaves rows with no volume).
  let vah = poc; let val = poc; let inside = vol[poc];
  while (inside < total * o.valueArea) {
    let a = vah + 1; while (a < n && vol[a] === 0) a += 1;
    let b = val - 1; while (b >= 0 && vol[b] === 0) b -= 1;
    if (a >= n && b < 0) break;
    const above = a < n ? vol[a] : -1;
    const below = b >= 0 ? vol[b] : -1;
    if (above >= below) { inside += above; vah = a; } else { inside += below; val = b; }
  }
  // A row's level: its middle (on a grid, its price).
  const mid = k => low + (k + 0.5) * step;
  return {
    from, to, low, high: low + n * step, step,
    rows: vol.map((volume, k) => ({ low: low + k * step, high: low + (k + 1) * step, volume, up: up[k] })),
    poc: mid(poc),
    // Rows: the value area's outer edges, as the source. Grid: the prices of its top and bottom rows.
    vah: grid ? mid(vah) : low + (vah + 1) * step, val: grid ? mid(val) : low + val * step,
    pocVolume: vol[poc], total,
    hvn: nodes(vol, Math.floor(n * o.nodePct), true, o.threshold).map(mid),
    lvn: nodes(vol, Math.floor(n * o.troughPct), false, o.threshold).map(mid),
  };
}

/** A profile without its rows: the series keep one per bar, and the levels are what they read. */
const lean = p => {
  if (!p) return null;
  const { rows: _rows, ...rest } = p;
  return rest;
};

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
        if (start >= 0) prior = lean(buildProfile(bars, start, last, options));
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
    for (let i = 0; i < n; i += 1) if (starts[i] >= 0) profile[i] = lean(buildProfile(bars, starts[i], i, options));
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

module.exports = { PARAM_DEFAULTS, DEFAULTS, optionsFromParams, buildProfile, profileSeries, profileAt, nearest, describe };
