'use strict';

/**
 * Trend catch & ride (the owner: "make sure we catch trends then learn to ride it ... how many became trends vs how much
 * we caught and how much of the trend we caught"): beside trend-capture.js's legs, how much of each caught leg the trade
 * banked, and how many of the run's filled entries were inside a leg its way at all. Analysis after the run only (fills
 * and closed bars), never shown to the model.
 *
 * Per caught leg (rideOf), in points of the leg's own move (`points`, from its start `from` to its extreme `to`),
 * side-aware (a short's move counts down), none capped (MEASURES says each):
 *   entryLag      (entry fill - from) / points: 0 the leg's start, 1 its extreme
 *   captureShare  (exit fill - entry fill) / points: the share of the whole leg banked; negative on a loss, and past
 *                 the remainder when the trade rode on past the detector's extreme
 *   rideShare     (exit - entry) / (to - entry): of what was left after the entry, how much was kept; null when the
 *                 entry was at or past the extreme (nothing left)
 *   peakR         the best R reached while open: the round trip's mfeR (the broker's), else the closed bars held
 *                 (opened at or after the entry fill, closed before the exit: the exit's own
 *                 bar may hold its high after a stop filled in it) at the trade's risk; never below the exit's R
 *   givebackR     peakR - r (r: the round trip's R, as trend-capture's entry.r)
 * An entry still open at the run's end (no round trip): open, and every exit measure null.
 *
 * The run's entries (entryKind): each filled entry is in-trend (inside a leg its way: the leg's start bar to its extreme
 * bar's close), counter (inside a leg the other way only) or none (in no leg), with its R.
 *
 * Leg size (sizeBucket): the leg's points over its threshold (minMoveAtr x the session's mean true range), bucketed by
 * config/replay.json trendCapture.sizeEdges ([2, 4]: 1-2x, 2-4x, 4x+); a leg without its session's scale (a given leg)
 * is 'unknown'.
 *
 *   MEASURES                                  [{ key, says }]: the per-leg measures, frozen (the docs and the lines)
 *   rideOf(leg, { entry, exit, r, peakR, riskPts, bars })   { entryLag, captureShare, rideShare, peakR, peakFrom, givebackR, r, open }
 *   peakFromBars({ side, entry, riskPts, bars, from, to })  the best R of the bars held, or null
 *   sizeBucket(x, edges)                      the bucket label of a leg x times its threshold
 *   entryKind({ side, at }, legs, stepMs)     { kind, leg } (legs: [{ id, side, start, end }])
 *   summarize({ legs, entries, edges })       the totals (see the function)
 *   compact(doc)                              a capture document's legs and entries as summarize reads them, or null
 *   rideLines(summary)                        the report's "Trend catch & ride" lines; rideLine(summary): one line
 */

const TUN = require('../tunables').replay().trendCapture; // config/replay.json

const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const round2 = x => (num(x) === null ? null : Math.round(x * 100) / 100);
const sign = side => (side === 'short' ? -1 : 1);

const MEASURES = Object.freeze([
  Object.freeze({ key: 'entryLag', says: '(entry fill - leg start) / leg points: 0 the leg\'s start, 1 its extreme' }),
  Object.freeze({ key: 'captureShare', says: '(exit fill - entry fill) / leg points: the share of the whole leg banked (negative on a loss, uncapped)' }),
  Object.freeze({ key: 'rideShare', says: '(exit - entry) / (leg extreme - entry): of what was left after the entry, the share kept (uncapped)' }),
  Object.freeze({ key: 'peakR', says: 'the best R reached while open (the round trip\'s mfeR, else the closed bars held)' }),
  Object.freeze({ key: 'givebackR', says: 'peakR - the trade\'s realized R' }),
]);

/** The best R of the closed bars held (opened at or after `from`, closed before `to`), side-aware; null without any. */
function peakFromBars({ side, entry, riskPts, bars = [], from, to, stepMs = 0 }) {
  if (num(entry) === null || !(num(riskPts) > 0)) return null;
  const s = sign(side);
  const held = (Array.isArray(bars) ? bars : []).filter(b => isObj(b) && Date.parse(b.t) >= from && Date.parse(b.t) + stepMs < to);
  if (!held.length) return null;
  return Math.max(...held.map(b => (s > 0 ? b.h - entry : entry - b.l))) / riskPts;
}

/** One caught leg's ride (see the header). leg: { side, from, to, points }; entry, exit: fill prices (exit null: open). */
function rideOf(leg, { entry = null, exit = null, r = null, peakR = null, riskPts = null, bars = [], from = null, to = null, stepMs = 0 } = {}) {
  const s = sign(leg.side);
  const pts = num(leg.points) !== null && leg.points > 0 ? leg.points : null;
  const known = num(leg.from) !== null && num(leg.to) !== null;
  const lag = pts && known && num(entry) !== null ? (s * (entry - leg.from)) / pts : null;
  const open = num(exit) === null;
  if (open) return { entryLag: round2(lag), captureShare: null, rideShare: null, peakR: null, peakFrom: null, givebackR: null, r: null, open: true };
  const moved = num(entry) !== null ? s * (exit - entry) : null;
  const left = known && num(entry) !== null ? s * (leg.to - entry) : null;
  // The peak: the broker's, else the bars held; never below the exit's own R (the exit is a price the trade reached).
  const exitR = moved !== null && num(riskPts) > 0 ? moved / riskPts : num(r);
  const fromBars = num(peakR) === null ? peakFromBars({ side: leg.side, entry, riskPts, bars, from, to, stepMs }) : null;
  const raw = num(peakR) !== null ? peakR : fromBars;
  const floor = [num(r), exitR].filter(x => x !== null);
  const peak = raw === null ? null : Math.max(raw, ...floor);
  return {
    entryLag: round2(lag),
    captureShare: pts && moved !== null ? round2(moved / pts) : null,
    rideShare: left !== null && left > 0 && moved !== null ? round2(moved / left) : null,
    peakR: round2(peak), peakFrom: num(peakR) !== null ? 'round-trip' : fromBars !== null ? 'bars' : null,
    givebackR: peak !== null && num(r) !== null ? round2(peak - r) : null,
    r: num(r), open: false,
  };
}

/** The size bucket of a leg x times its threshold, by ascending edges: below the first '1-<e1>x', ..., '<last>x+'. */
function sizeBucket(x, edges = TUN.sizeEdges) {
  if (num(x) === null) return 'unknown';
  const es = [...edges].sort((a, b) => a - b);
  let lo = 1;
  for (const e of es) {
    if (x < e) return `${lo}-${e}x`;
    lo = e;
  }
  return `${lo}x+`;
}

/** Every bucket label of the edges, smallest first. */
const bucketsOf = (edges = TUN.sizeEdges) => {
  const es = [...edges].sort((a, b) => a - b);
  return [...es.map((e, i) => `${i ? es[i - 1] : 1}-${e}x`), `${es[es.length - 1]}x+`];
};

/** A filled entry's kind (see the header): the first leg its way holding it, else the first the other way, else none. */
function entryKind({ side, at }, legs = [], stepMs = 0) {
  const t = Date.parse(at);
  const holding = (Array.isArray(legs) ? legs : []).filter(l => Number.isFinite(t) && t >= Date.parse(l.start) && t <= Date.parse(l.end) + stepMs);
  const mine = holding.find(l => l.side === side);
  if (mine) return { kind: 'in-trend', leg: mine.id };
  if (holding.length) return { kind: 'counter', leg: holding[0].id };
  return { kind: 'none', leg: null };
}

const sum = xs => round2(xs.reduce((a, b) => a + b, 0));
const statsOf = xs => {
  const s = xs.filter(x => num(x) !== null).sort((a, b) => a - b);
  if (!s.length) return { n: 0, median: null, mean: null };
  const mid = Math.floor(s.length / 2);
  return { n: s.length, median: round2(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2), mean: round2(s.reduce((a, b) => a + b, 0) / s.length) };
};
const rate = (a, b) => (b ? round2(a / b) : null);

/**
 * The totals of a run's (or a side's) legs and entries:
 *   legs, caught, catchRate          the trends that happened, the caught ones, caught / legs
 *   bySize { bucket: { legs, caught, catchRate } }   every bucket of the edges (and 'unknown' when a leg has no scale)
 *   entryLag, captureShare, rideShare, givebackR, peakR   { n, median, mean } over the caught legs with that measure
 *   open                             caught legs whose trade was still open at the end
 *   rCaught, rAvailable              the caught legs' realized R (summed), all legs' available R (summed), with how many
 *                                    of each were unknown (rCaughtUnknown, rAvailableUnknown: left out of the sums)
 *   entries { filled, inTrend, counter, none: { n, r, rUnknown }, inTrendShare }   the run's filled entries by kind
 * legs: [{ captured, availableR, size: { bucket }, ride }]; entries: [{ kind, r }].
 */
function summarize({ legs = [], entries = [], edges = TUN.sizeEdges } = {}) {
  const ls = (Array.isArray(legs) ? legs : []).filter(isObj);
  const caught = ls.filter(l => l.captured === true);
  const rides = caught.map(l => (isObj(l.ride) ? l.ride : {}));
  const bySize = Object.fromEntries(bucketsOf(edges).map(b => [b, { legs: 0, caught: 0, catchRate: null }]));
  for (const l of ls) {
    const b = isObj(l.size) && l.size.bucket ? l.size.bucket : 'unknown';
    bySize[b] = bySize[b] || { legs: 0, caught: 0, catchRate: null };
    bySize[b].legs += 1;
    if (l.captured === true) bySize[b].caught += 1;
  }
  for (const x of Object.values(bySize)) x.catchRate = rate(x.caught, x.legs);
  const es = (Array.isArray(entries) ? entries : []).filter(isObj);
  const kindOf = k => { const xs = es.filter(e => e.kind === k); return { n: xs.length, r: sum(xs.map(e => num(e.r)).filter(x => x !== null)), rUnknown: xs.filter(e => num(e.r) === null).length }; };
  const caughtR = rides.map(x => num(x.r));
  const avail = ls.map(l => num(l.availableR));
  const stat = key => statsOf(rides.map(x => x[key]));
  return {
    legs: ls.length, caught: caught.length, catchRate: rate(caught.length, ls.length), bySize,
    entryLag: stat('entryLag'), captureShare: stat('captureShare'), rideShare: stat('rideShare'), peakR: stat('peakR'), givebackR: stat('givebackR'),
    open: rides.filter(x => x.open === true).length,
    rCaught: sum(caughtR.filter(x => x !== null)), rCaughtUnknown: caughtR.filter(x => x === null).length,
    rAvailable: sum(avail.filter(x => x !== null)), rAvailableUnknown: avail.filter(x => x === null).length,
    entries: { filled: es.length, inTrend: kindOf('in-trend'), counter: kindOf('counter'), none: kindOf('none'), inTrendShare: rate(es.filter(e => e.kind === 'in-trend').length, es.length) },
  };
}

const pct = x => (num(x) === null ? '-' : `${Math.round(x * 100)}%`);
const med = (s, unit = '') => (isObj(s) && num(s.median) !== null ? `${s.median}${unit}` : '-');
const signed = x => (num(x) === null ? '-' : `${x > 0 ? '+' : ''}${x}`);

/** One line: legs, caught %, R caught / R available, the medians, the in-trend entry share (the PPC round's block). */
function rideLine(t) {
  if (!isObj(t)) return 'n/a';
  const e = t.entries || {};
  return `${t.legs} leg(s), ${t.caught} caught (${pct(t.catchRate)}), R caught ${t.rCaught}${t.rCaughtUnknown ? ` (${t.rCaughtUnknown} unknown)` : ''} / R available ${t.rAvailable}${t.rAvailableUnknown ? ` (${t.rAvailableUnknown} unknown)` : ''}`
    + `, median capture share ${med(t.captureShare)}, ride share ${med(t.rideShare)}, entry lag ${med(t.entryLag)}, giveback ${med(t.givebackR, 'R')}`
    + `${t.open ? `, ${t.open} still open` : ''}, in-trend entries ${e.inTrend ? e.inTrend.n : 0} of ${e.filled || 0} (${pct(e.inTrendShare)})`;
}

/** The report's block: the line, the means, the size buckets, the entries by kind with their R. */
function rideLines(t) {
  if (!isObj(t)) return [];
  const mean = (s, unit = '') => (isObj(s) && num(s.mean) !== null ? `${s.mean}${unit}` : '-');
  const e = t.entries;
  const kind = (label, k) => `${label} ${k.n} (${signed(k.r)}R${k.rUnknown ? `, ${k.rUnknown} R unknown` : ''})`;
  return [
    `Trend catch & ride: ${rideLine(t)}`,
    `  means: capture share ${mean(t.captureShare)}, ride share ${mean(t.rideShare)}, entry lag ${mean(t.entryLag)}, peak ${mean(t.peakR, 'R')}, giveback ${mean(t.givebackR, 'R')} (n ${t.captureShare.n})`,
    `  by size (x the leg threshold): ${Object.entries(t.bySize).map(([b, x]) => `${b} ${x.caught}/${x.legs}`).join(', ')}`,
    `  entries: ${kind('in-trend', e.inTrend)}, ${kind('counter', e.counter)}, ${kind('no leg', e.none)}`,
  ];
}

/** A capture document's legs and entries, only what summarize reads (a training phase keeps this, not the document). */
// A document written before the ride was recorded (no entries list) is unknown: null, never zero entries.
const compact = doc => (isObj(doc) && Array.isArray(doc.legs) && Array.isArray(doc.entries) ? {
  legs: doc.legs.map(l => ({ id: l.id, captured: l.captured === true, availableR: num(l.availableR), size: isObj(l.size) ? l.size : null, ride: isObj(l.ride) ? l.ride : null })),
  entries: doc.entries.map(e => ({ at: e.at, side: e.side, kind: e.kind, leg: e.leg || null, r: num(e.r) })),
} : null);

module.exports = { MEASURES, rideOf, peakFromBars, sizeBucket, entryKind, summarize, compact, rideLine, rideLines };
