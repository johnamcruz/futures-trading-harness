'use strict';

/**
 * Compression and its turn into expansion, per timeframe, on COMPLETED candles only (the `compression` skill's one
 * definition; the parameters are config/analysis.json `compression`). A primitive: the flag and the pennant are
 * compositions the skill teaches, never their own facts.
 *
 * ATR is the timeframe's ATR(14) as of the candle BEFORE the box's first (the move it rests from: the box's own small
 * candles never shrink the yardstick it is measured with).
 *
 *   box          a run of at least minBars and at most maxBars back-to-back completed candles (none across the daily
 *                break, a weekend or a feed gap) whose high-to-low width is above 0 and at most boxAtr x ATR, whose
 *                mean candle range is at most barAtr x ATR, and that holds no displacement candle (candle-facts.js
 *                patternsOf, the candle-reading skill's: a pole is the move before the box, never in it); the longest
 *                such run ending on a candle is that candle's box. NOT a box: fewer than minBars candles (a single
 *                inside bar), a drift whose candles are wide (mean range over barAtr), a run wider than boxAtr (a trend
 *                long enough to widen it), or one with a displacement candle in it.
 *   shape        'converging' (the second half's high-low at most convergeShare of the first half's, its high no
 *                higher and its low no lower: a pennant's box), else 'drifting up' | 'drifting down' (last close minus
 *                first open at least driftShare of the width: a flag's counter-drift), else 'flat'
 *   break        the first candle after a box (back to back with it) that CLOSES beyond it: above its high `up`,
 *                below its low `down`; a wick beyond with the close inside is no break
 *   expansion    the break candle's range at least expandRange x the box's mean candle range AND at least expandAtr x
 *                ATR, its close at least minBeyondAtr x ATR beyond the edge (a poke of a tick or two is none); a close
 *                out on a small candle is a drift out, not an expansion. `volVsBox`: its volume over the box's mean
 *                (support only, momentum-and-volume's), `beyondAtr` how far it closed beyond
 *   beyondNow    price now (the latest base close) still beyond the broken edge (acceptance by closes is the
 *                breakout-vs-fakeout skill's; this is only where price is)
 *   volContract  the box's second half's mean volume over its first half's (under 1: volume falling as it forms)
 *   backInside   a later completed candle closed back inside the box (high to low)
 *   runAtr       how far price has run past the expansion candle's close, its way, in ATR (late past maxRunAtr: the
 *                leg already left; the entry is the next closed candle, never a chase)
 *   levels       the key levels the box sits at: the briefing's levels as they stood when the box began (the caller's
 *                `levels(from)`, so never one its own candles made), less a swing on its own timeframe or lower and
 *                the day's or session's extreme on its own edge: a level inside it
 *                or within levelBandAtr x ATR of an edge, with that
 *                edge: 'top' (the box pressing under it), 'bottom' (resting on it) or 'inside'; at most maxLevels,
 *                nearest an edge first
 *   state        'expanding': the latest break within recentBars candles is an expansion, not back inside, price still
 *                beyond it, not late;
 *                else 'neither' while an expansion in those candles failed (back inside or late: its box shown); else
 *                'compressing': a box ends on the last completed candle; else 'neither'
 *
 *   PARAMS                                     the config's values (frozen)
 *   boxEndingAt(candles, atr, e, params)       the longest box ending on candle e, or null (O(maxBars))
 *   boxesOf(candles, atr, params)              boxEndingAt for every candle (the census)
 *   compressionAt(candles, j, { price, params })   { state, box, break } as of candle j (null fields when none)
 *   compressionFrames({ bars, base, fine, frames, at, price, levels })   the briefing's `compression` (levels: the
 *                                              briefing's named levels, [name, price, shown?], or a function of a
 *                                              box's start time giving them as they stood then): { '3m': {...} |
 *                                              'unavailable (...)', ... } (candle-facts.js completedCandlesAt: the
 *                                              briefing's candle rule)
 *   compressionLine(block, et)                 the summary's line: a timeframe expanding, an expansion that failed (a
 *                                              fakeout, late) or a timeframe compressing; null when none
 */

const ind = require('./indicators');
const { completedCandlesAt, label, patternsOf } = require('./candle-facts');

const PARAMS = require('../tunables').analysis().compression; // config/analysis.json
const RUNNING = /^(day|session) (high|low)$/;
const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Whether candle b opens where candle a closed (back to back: no break, weekend or feed gap between). */
const adjacent = (a, b) => Boolean(a && b) && Date.parse(a.closedAt) === Date.parse(b.t);

/** Whether candle i is a displacement candle (candle-facts.js patternsOf, ATR as of the candle before it). */
const displacementAt = (cs, atr, i) => i > 0 && patternsOf(cs[i], cs[i - 1], atr[i - 1]).includes('displacement');

/** The longest box ending on candle e (see the header), or null. Reads candles up to e only. */
function boxEndingAt(cs, atr, e, P = PARAMS) {
  let hi = -Infinity;
  let lo = Infinity;
  let sum = 0;
  let best = null;
  for (let k = 1; k <= P.maxBars; k += 1) {
    const s = e - k + 1;
    if (s < 1) break;
    if (k > 1 && !adjacent(cs[s], cs[s + 1])) break;
    // A displacement candle is the move, never the rest: no box holds one (nor any longer run through it).
    if (displacementAt(cs, atr, s)) break;
    const c = cs[s];
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
    sum += c.h - c.l;
    if (k < P.minBars) continue;
    const ref = atr[s - 1];
    if (!(ref > 0)) continue;
    const width = hi - lo;
    const mean = sum / k;
    if (width > 0 && width <= P.boxAtr * ref && mean <= P.barAtr * ref) best = { s, e, high: hi, low: lo, width, meanRange: mean, atr: ref };
  }
  return best;
}

/** boxEndingAt for every candle index (the census). */
const boxesOf = (cs, atr, P = PARAMS) => cs.map((_, e) => boxEndingAt(cs, atr, e, P));

/** The box's shape (see the header). */
function shapeOf(cs, box, P) {
  const k = box.e - box.s + 1;
  const half = Math.floor(k / 2);
  const span = (a, b) => { let h = -Infinity; let l = Infinity; for (let i = a; i <= b; i += 1) { h = Math.max(h, cs[i].h); l = Math.min(l, cs[i].l); } return [h, l]; };
  const [hA, lA] = span(box.s, box.s + half - 1);
  const [hB, lB] = span(box.s + half, box.e);
  if (hA - lA > 0 && hB - lB <= P.convergeShare * (hA - lA) && hB <= hA && lB >= lA) return 'converging';
  const drift = box.width > 0 ? (cs[box.e].c - cs[box.s].o) / box.width : 0;
  return drift >= P.driftShare ? 'drifting up' : drift <= -P.driftShare ? 'drifting down' : 'flat';
}

/** A box as the briefing shows it. */
function boxFact(cs, box, P, levels = []) {
  return {
    high: box.high, low: box.low, width: r2(box.width), widthAtr: r2(box.width / box.atr), bars: box.e - box.s + 1,
    meanRangeAtr: r2(box.meanRange / box.atr), volContract: r2(volContractOf(cs, box)), shape: shapeOf(cs, box, P), atr: r2(box.atr),
    from: cs[box.s].t, to: cs[box.e].closedAt, levels: levelsAt(box, typeof levels === 'function' ? levels(cs[box.s].t) : levels, P),
  };
}

/** The box's second half's mean volume over its first half's (under 1: volume falling as it forms); null unknown. */
function volContractOf(cs, box) {
  const half = Math.floor((box.e - box.s + 1) / 2);
  const mean = xs => (xs.length && xs.every(Number.isFinite) ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const a = mean(cs.slice(box.s, box.s + half).map(x => x.v));
  const b = mean(cs.slice(box.s + half, box.e + 1).map(x => x.v));
  return a > 0 && Number.isFinite(b) ? b / a : NaN;
}

/** The key levels at a box (see the header): [{ name, price, edge }], nearest an edge first, at most maxLevels. */
function levelsAt(box, levels, P) {
  const band = P.levelBandAtr * box.atr;
  const out = [];
  const seen = new Set();
  for (const [name, price, shown] of Array.isArray(levels) ? levels : []) {
    if (!Number.isFinite(price) || price < box.low - band || price > box.high + band || seen.has(name)) continue;
    // The day's or the session's running extreme on the box's own edge is the box's own (its candles made it).
    if (RUNNING.test(name) && (price === box.high || price === box.low)) continue;
    seen.add(name);
    const dTop = Math.abs(price - box.high);
    const dBottom = Math.abs(price - box.low);
    const edge = dTop <= band && dTop <= dBottom ? 'top' : dBottom <= band ? 'bottom' : 'inside';
    out.push({ name, price: shown ?? price, edge, d: Math.min(dTop, dBottom) });
  }
  return out.sort((a, b) => a.d - b.d || a.name.localeCompare(b.name)).slice(0, P.maxLevels).map(({ d: _d, ...x }) => x);
}

/**
 * The state as of candle j (see the header): { state, box, break }. `price`: where price is now (the latest base close;
 * default candle j's close), for runAtr. `boxes`: boxesOf's result when the caller has it (the census).
 */
function compressionAt(cs, j, { price = null, params = PARAMS, atr = null, boxes = null, levels = [] } = {}) {
  const P = params;
  const none = { state: 'neither', box: null, break: null };
  if (!Array.isArray(cs) || !(j >= 0 && j < cs.length)) return none;
  const a = atr || ind.atr(cs, ind.ATR_PERIOD);
  // Only candles up to j are read (boxEndingAt reads up to its own e): a box or break after it changes nothing. Only the
  // boxes the breaks and the state need: those ending in the last recentBars + 1 candles.
  const memo = new Map();
  const bx = { at: e => { if (boxes) return boxes[e]; if (!memo.has(e)) memo.set(e, e >= 0 && e <= j ? boxEndingAt(cs, a, e, P) : null); return memo.get(e); } };
  const now = num(price) !== null ? price : cs[j].c;
  // The breaks in the last recentBars candles, latest first: a candle closing beyond the box that ended on the candle
  // before it. The latest expansion among them is the transition (a small candle after it, closing beyond a box that
  // took the expansion candle in, is its follow-through, not a new break); else the latest break.
  const breaks = [];
  for (let b = j; b >= Math.max(1, j - P.recentBars); b -= 1) {
    const box = bx.at(b - 1);
    const c = cs[b];
    if (!box || !adjacent(cs[b - 1], c)) continue;
    const dir = c.c > box.high ? 'up' : c.c < box.low ? 'down' : null;
    if (!dir) continue;
    const range = c.h - c.l;
    let backInside = false;
    for (let i = b + 1; i <= j; i += 1) if (cs[i].c <= box.high && cs[i].c >= box.low) backInside = true;
    const rangeVsBox = box.meanRange > 0 ? range / box.meanRange : Infinity;
    const rangeAtr = range / box.atr;
    // How far it closed beyond the edge, in ATR: a poke of a tick or two is no expansion (minBeyondAtr).
    const beyondAtr = (dir === 'up' ? c.c - box.high : box.low - c.c) / box.atr;
    const boxVol = cs.slice(box.s, box.e + 1).map(x => x.v);
    const volVsBox = boxVol.length && boxVol.every(Number.isFinite) && Number.isFinite(c.v) ? c.v / (boxVol.reduce((p, q) => p + q, 0) / boxVol.length) : NaN;
    const runAtr = (dir === 'up' ? now - c.c : c.c - now) / box.atr;
    breaks.push({
      box, dir, closedAt: c.closedAt, close: c.c, rangeAtr: r2(rangeAtr), rangeVsBox: r2(rangeVsBox),
      beyondAtr: r2(beyondAtr), volVsBox: r2(volVsBox),
      expansion: rangeVsBox >= P.expandRange && rangeAtr >= P.expandAtr && beyondAtr >= P.minBeyondAtr, barsAgo: j - b, backInside,
      // Price now (the latest base close) still beyond the broken edge, not back in the box.
      beyondNow: dir === 'up' ? now > box.high : now < box.low, runAtr: r2(runAtr), late: runAtr > P.maxRunAtr,
    });
  }
  const brk = breaks.find(x => x.expansion) || breaks[0] || null;
  const breakFact = x => ({ dir: x.dir, closedAt: x.closedAt, close: x.close, rangeAtr: x.rangeAtr, rangeVsBox: x.rangeVsBox, beyondAtr: x.beyondAtr, volVsBox: x.volVsBox, expansion: x.expansion, barsAgo: x.barsAgo, backInside: x.backInside, beyondNow: x.beyondNow, runAtr: x.runAtr, late: x.late });
  if (brk && brk.expansion && !brk.backInside && brk.beyondNow && !brk.late) return { state: 'expanding', box: boxFact(cs, brk.box, P, levels), break: breakFact(brk) };
  // An expansion that failed (back inside: a fakeout; or late) in the last recentBars candles: the transition is spent,
  // with the box it left (never a wider box that took the expansion candle in).
  if (brk && brk.expansion) return { state: 'neither', box: boxFact(cs, brk.box, P, levels), break: breakFact(brk) };
  if (bx.at(j)) return { state: 'compressing', box: boxFact(cs, bx.at(j), P, levels), break: brk ? breakFact(brk) : null };
  return brk ? { state: 'neither', box: boxFact(cs, brk.box, P, levels), break: breakFact(brk) } : none;
}

/** The briefing's `compression` block (see the header): per timeframe, as of base bar `at`. */
function compressionFrames({ bars, base, fine = null, frames = PARAMS.frames, at = bars.length - 1, price = null, levels = [], params = PARAMS } = {}) {
  const out = {};
  for (const m of frames) {
    const c = completedCandlesAt({ bars, base, fine, minutes: m, at });
    if (c.unavailable) { out[label(m)] = `unavailable (${c.unavailable})`; continue; }
    const cs = c.candles.slice(0, c.j + 1).map(({ t, closedAt, o, h, l, c: cl, v }) => ({ t, closedAt, o, h, l, c: cl, v }));
    // A swing on the box's timeframe or a lower one may be the box's own candles' (its high or low): never a key level
    // it sits at; a higher timeframe's swing is.
    const own = ([name]) => { const k = /^(?:untested )?(\d+)(m|h) swing\b/.exec(name); return Boolean(k) && Number(k[1]) * (k[2] === 'h' ? 60 : 1) <= m; };
    const mine = list => (list || []).filter(x => !own(x));
    out[label(m)] = compressionAt(cs, c.j, { price, params, levels: typeof levels === 'function' ? from => mine(levels(from)) : mine(levels) });
  }
  return out;
}

/**
 * The summary's compression line, the transition first: a timeframe expanding, in full ("3m expanding up: box
 * 21490-21497.5 (7.5 pts, 0.8 ATR, 6 bars, flat, at prior RTH high 21497.75 (its top)), expansion closed 10:12 above it
 * (range 2.6x the box's candles, 1.8 ATR), 1 bar ago"); an expansion that failed (closed back inside: a fakeout, or late),
 * as "no expansion: ..."; a timeframe compressing, compact ("15m compressing 7 bars in 21500.25-21512.75 (1.4 ATR,
 * flat, at prior VAH)"). A small candle out of a box is left out (no expansion: the JSON holds it). null when none.
 */
function compressionLine(block, et = x => x) {
  if (!block || typeof block !== 'object') return null;
  const parts = [];
  const at = b => (b.levels && b.levels.length ? `, at ${b.levels.map(l => `${l.name} ${l.price} (${l.edge === 'inside' ? 'inside' : `its ${l.edge}`})`).join(', ')}` : '');
  for (const [tf, x] of Object.entries(block)) {
    if (!x || typeof x !== 'object' || !x.box) continue;
    const b = x.box;
    const k = x.break && x.break.expansion ? x.break : null;
    const boxText = `box ${b.low}-${b.high} (${b.width} pts, ${b.widthAtr} ATR, ${b.bars} bars, ${b.shape}${at(b)})`;
    const brk = k ? `expansion closed ${et(k.closedAt)} ${k.dir === 'up' ? 'above' : 'below'} it (range ${k.rangeVsBox}x the box's candles, ${k.rangeAtr} ATR), ${k.barsAgo} ${k.barsAgo === 1 ? 'bar' : 'bars'} ago${k.backInside ? ', closed back inside' : !k.beyondNow ? ', price back inside' : ''}${k.late ? `, late: ${k.runAtr} ATR past its close` : ''}` : '';
    if (x.state === 'expanding') parts.push(`${tf} expanding ${k.dir}: ${boxText}, ${brk}`);
    else if (k) parts.push(`${tf} no expansion: ${boxText}, ${brk}`);
    // Compressing: compact (the JSON holds the rest).
    else if (x.state === 'compressing') parts.push(`${tf} compressing ${b.bars} bars in ${b.low}-${b.high} (${b.widthAtr} ATR, ${b.shape}${b.levels && b.levels.length ? `, at ${b.levels.map(l => l.name).join(', ')}` : ''})`);
  }
  return parts.length ? `- Compression (completed candles; a read, not a signal): ${parts.join('; ')}.` : null;
}

module.exports = { PARAMS, boxesOf, compressionAt, compressionFrames, compressionLine };
