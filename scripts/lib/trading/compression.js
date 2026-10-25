'use strict';

/**
 * Compression and its turn into expansion, per timeframe, on COMPLETED candles only (the `compression` skill's one
 * definition; the parameters are config/analysis.json `compression`). A primitive: the flag and the pennant are
 * compositions the skill teaches, never their own facts. The classic narrow-range family:
 *
 *   box          a candle that is inside (candle-facts.js insideStacks, the candle-reading skill's inside rule: in a
 *                stack inside one mother candle) or NR7 (its range the narrowest of the last 7 back-to-back completed
 *                candles, ties included: `nr`, the config's lengths). An inside candle's box is its mother's range; when
 *                that box is not narrow (below; a displacement mother is a pole, never a box) an NR candle's is its own. `flavor`: the box's ('inside' when the mother's,
 *                else 'nr7'); `flavors` all that hold; `insideStack` the stack's count. ATR is the timeframe's ATR(14)
 *                as of the candle before the box (the mother, for an inside stack). A box is narrow: no wider than
 *                maxWidthAtr x ATR, its candles back to back, none a displacement; one of zero width is none.
 *   pole         a displacement candle (candle-facts.js patternsOf, the candle-reading skill's) among the poleBars
 *                candles just before the box, back to back with it: { dir, closedAt, rangeAtr }; the pole stays
 *                outside the box (a flag: a pole, then a narrow candle or an inside stack, then the break its way)
 *   break        the candle after a box candle (back to back with it) that CLOSES beyond the box: above its high
 *                `up`, below its low `down`; a wick beyond with the close inside is no break
 *   expansion    its range at least expandAtr x ATR and its close at least minBeyondAtr x ATR beyond the edge (a poke
 *                of a tick or two is none); `beyondAtr`, `rangeAtr`; `volVsBox` its volume over the box candle's
 *                (support only, the momentum-and-volume skill's); `withPole` the box's pole is its way
 *   backInside   a later completed candle closed back inside the box (high to low)
 *   beyondNow    price now (the latest base close) still beyond the broken edge (acceptance by closes is the
 *                breakout-vs-fakeout skill's; this is only where price is)
 *   runAtr       how far price has run past the expansion candle's close, its way, in ATR (late past maxRunAtr)
 *   levels       the key levels the box sits at: the caller's `levels(from)`, the briefing's levels that stood when
 *                the box began and still stand at that value, less a swing on its own timeframe or lower: a level
 *                inside it or within levelBandAtr x ATR of an edge, with that edge ('top', 'bottom', 'inside'); at
 *                most maxLevels, nearest an edge first
 *   state        'expanding': the latest break within recentBars candles is an expansion, not back inside, price still
 *                beyond it, not late; else 'neither' while an expansion in those candles failed (its box shown) and no
 *                box began after it; else 'compressing': the last completed candle is a box; else 'neither'
 *
 *   PARAMS                                     the config's values (frozen)
 *   seriesOf(candles, params)                  { atr, stacks, nr } per candle (one pass each): what boxAt reads
 *   boxAt(candles, k, series, params)          the box candle k makes, or null: { k, s, high, low, width, atr, flavor,
 *                                              flavors, insideStack, pole }
 *   compressionAt(candles, j, { price, params, series, levels })   { state, box, break } as of candle j
 *   compressionFrames({ bars, base, fine, frames, at, price, levels })   the briefing's `compression` (levels: the
 *                                              briefing's named levels, [name, price, shown?], or a function of a
 *                                              box's start time giving them): { '3m': {...} | 'unavailable (...)', ... }
 *                                              (candle-facts.js completedCandlesAt: the briefing's candle rule)
 *   compressionLine(block, et)                 the summary's line: a timeframe expanding, an expansion that failed, or a
 *                                              timeframe whose last candle is a box; null when none
 */

const ind = require('./indicators');
const { completedCandlesAt, label, patternsOf, insideStacks } = require('./candle-facts');

const PARAMS = require('../tunables').analysis().compression; // config/analysis.json
const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Whether candle b opens where candle a closed (back to back: no break, weekend or feed gap between). */
const adjacent = (a, b) => Boolean(a && b) && Date.parse(a.closedAt) === Date.parse(b.t);

/** Per candle, one pass each: ATR(14), the inside stacks (candle-facts.js) and the NR lengths it is narrowest of. */
function seriesOf(cs, P = PARAMS) {
  const atr = ind.atr(cs, ind.ATR_PERIOD);
  const stacks = insideStacks(cs);
  const range = cs.map(c => c.h - c.l);
  // NRn: the narrowest range of the last n back-to-back completed candles, ties included.
  const nr = cs.map((_, k) => P.nr.filter(n => {
    if (k < n - 1) return false;
    for (let q = k - n + 1; q < k; q += 1) if (!adjacent(cs[q], cs[q + 1]) || range[q] < range[k]) return false;
    return true;
  }));
  return { atr, stacks, nr };
}

/** The box candle k makes (see the header), or null. */
function boxAt(cs, k, series, P = PARAMS) {
  if (!(k >= 1 && k < cs.length)) return null;
  const { atr, stacks, nr } = series;
  const disp = q => q >= 1 && patternsOf(cs[q], cs[q - 1], atr[q - 1]).includes('displacement');
  const st = stacks[k] || {};
  // Narrow: no wider than maxWidthAtr x ATR (as of the candle before it), every candle back to back (no feed gap,
  // weekend or daily break inside it), and none of its candles a displacement (the move, never the rest).
  const narrow = from => {
    const ref = atr[from - 1];
    const w = cs[from].h - cs[from].l;
    if (!(from >= 1 && ref > 0 && w > 0 && w <= P.maxWidthAtr * ref)) return false;
    for (let q = from; q <= k; q += 1) if ((q > from && !adjacent(cs[q - 1], cs[q])) || disp(q)) return false;
    return true;
  };
  // The inside stack's mother's range when narrow; else (a displacement mother, the pole; or one too wide, across a gap
  // or holding a displacement) the candle's own range when it is an NR candle and narrow.
  const inside = Boolean(st.insideStack) && narrow(k - st.insideStack);
  const nrs = nr[k].map(n => `nr${n}`);
  if (!inside && !(nrs.length && narrow(k))) return null;
  const s = inside ? k - st.insideStack : k;
  const flavors = inside ? ['inside', ...nrs] : nrs;
  const ref = atr[s - 1];
  const high = cs[s].h;
  const low = cs[s].l;
  // The pole: a displacement candle among the poleBars just before the box, back to back with it.
  let pole = null;
  for (let q = s - 1; q >= Math.max(1, s - P.poleBars) && !pole; q -= 1) {
    if (!adjacent(cs[q], cs[q + 1])) break;
    if (disp(q)) pole = { dir: cs[q].c > cs[q].o ? 'up' : 'down', closedAt: cs[q].closedAt, rangeAtr: r2((cs[q].h - cs[q].l) / atr[q - 1]) };
  }
  return { k, s, high, low, width: high - low, atr: ref, flavor: flavors[0], flavors, insideStack: inside ? st.insideStack : 0, pole };
}

/** A box as the briefing shows it. */
function boxFact(cs, box, P, levels = []) {
  return {
    high: box.high, low: box.low, width: r2(box.width), widthAtr: r2(box.width / box.atr), flavor: box.flavor, flavors: box.flavors,
    ...(box.insideStack ? { insideStack: box.insideStack } : {}), atr: r2(box.atr), pole: box.pole,
    from: cs[box.s].t, to: cs[box.k].closedAt, levels: levelsAt(box, typeof levels === 'function' ? levels(cs[box.s].t) : levels, P),
  };
}

/** The key levels at a box (see the header): [{ name, price, edge }], nearest an edge first, at most maxLevels. */
function levelsAt(box, levels, P) {
  const band = P.levelBandAtr * box.atr;
  const out = [];
  const seen = new Set();
  for (const [name, price, shown] of Array.isArray(levels) ? levels : []) {
    if (!Number.isFinite(price) || price < box.low - band || price > box.high + band || seen.has(name)) continue;
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
 * default candle j's close). `series`: seriesOf's result for these candles when the caller has it (the census). Only
 * candles up to j are read: the series are causal (each value from candles up to its own), so later ones change nothing.
 */
function compressionAt(cs, j, { price = null, params = PARAMS, series = null, levels = [] } = {}) {
  const P = params;
  const none = { state: 'neither', box: null, break: null };
  if (!Array.isArray(cs) || !(j >= 0 && j < cs.length)) return none;
  const sr = series || seriesOf(cs.slice(0, j + 1), P);
  const now = num(price) !== null ? price : cs[j].c;
  // The breaks in the last recentBars candles, latest first: a candle closing beyond the box the candle before it made.
  // The latest expansion among them is the transition; else the latest break.
  const breaks = [];
  for (let b = j; b >= Math.max(1, j - P.recentBars); b -= 1) {
    const box = boxAt(cs, b - 1, sr, P);
    const c = cs[b];
    if (!box || !adjacent(cs[b - 1], c)) continue;
    const dir = c.c > box.high ? 'up' : c.c < box.low ? 'down' : null;
    if (!dir) continue;
    let backInside = false;
    for (let i = b + 1; i <= j; i += 1) if (cs[i].c <= box.high && cs[i].c >= box.low) backInside = true;
    const rangeAtr = (c.h - c.l) / box.atr;
    // How far it closed beyond the edge, in ATR: a poke of a tick or two is no expansion (minBeyondAtr).
    const beyondAtr = (dir === 'up' ? c.c - box.high : box.low - c.c) / box.atr;
    const boxVol = cs[box.k].v;
    const volVsBox = Number.isFinite(boxVol) && boxVol > 0 && Number.isFinite(c.v) ? c.v / boxVol : NaN;
    const runAtr = (dir === 'up' ? now - c.c : c.c - now) / box.atr;
    breaks.push({
      box, dir, closedAt: c.closedAt, close: c.c, rangeAtr: r2(rangeAtr), beyondAtr: r2(beyondAtr), volVsBox: r2(volVsBox),
      expansion: rangeAtr >= P.expandAtr && beyondAtr >= P.minBeyondAtr, withPole: Boolean(box.pole) && box.pole.dir === dir,
      barsAgo: j - b, backInside,
      // Price now (the latest base close) still beyond the broken edge, not back in the box.
      beyondNow: dir === 'up' ? now > box.high : now < box.low, runAtr: r2(runAtr), late: runAtr > P.maxRunAtr,
    });
  }
  const brk = breaks.find(x => x.expansion) || breaks[0] || null;
  const breakFact = x => ({ dir: x.dir, closedAt: x.closedAt, close: x.close, rangeAtr: x.rangeAtr, beyondAtr: x.beyondAtr, volVsBox: x.volVsBox, expansion: x.expansion, withPole: x.withPole, barsAgo: x.barsAgo, backInside: x.backInside, beyondNow: x.beyondNow, runAtr: x.runAtr, late: x.late });
  if (brk && brk.expansion && !brk.backInside && brk.beyondNow && !brk.late) return { state: 'expanding', box: boxFact(cs, brk.box, P, levels), break: breakFact(brk) };
  // An expansion that failed (back inside, price back in the box, or late) in the last recentBars candles: spent.
  const last = boxAt(cs, j, sr, P);
  // A box newer than the failed expansion (on a candle after it) is the state; else the failure, with the box it left.
  if (brk && brk.expansion && !(last && last.s > j - brk.barsAgo)) return { state: 'neither', box: boxFact(cs, brk.box, P, levels), break: breakFact(brk) };
  if (last) return { state: 'compressing', box: boxFact(cs, last, P, levels), break: brk ? breakFact(brk) : null };
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

/** A box's words: its flavor, its range, its pole and levels. */
function boxWords(b, full) {
  const at = b.levels && b.levels.length ? `, at ${b.levels.map(l => (full ? `${l.name} ${l.price} (${l.edge === 'inside' ? 'inside' : `its ${l.edge}`})` : l.name)).join(', ')}` : '';
  const pole = b.pole ? `, after a ${b.pole.dir} displacement pole` : '';
  const stack = b.insideStack ? ` x${b.insideStack}` : '';
  return `${b.flavor}${stack} box ${b.low}-${b.high} (${full ? `${b.width} pts, ` : ''}${b.widthAtr} ATR${pole}${at})`;
}

/**
 * The summary's compression line, the transition first: a timeframe expanding, in full ("3m expanding up: nr7 box
 * 21490-21497.5 (7.5 pts, 0.8 ATR, after a up displacement pole, at prior RTH high 21497.75 (its top)), expansion
 * closed 10:12 above it (range 1.8 ATR, 0.4 ATR beyond, volume 2.1x), 1 bar ago"); an expansion that failed, as "no
 * expansion: ..." with why; a timeframe whose last candle is a box, compact ("15m nr7 box 21500.25-21512.75 (0.4 ATR,
 * at prior VAH)"). null when none.
 */
function compressionLine(block, et = x => x) {
  if (!block || typeof block !== 'object') return null;
  const parts = [];
  for (const [tf, x] of Object.entries(block)) {
    if (!x || typeof x !== 'object' || !x.box) continue;
    const b = x.box;
    const k = x.break && x.break.expansion ? x.break : null;
    const brk = k ? `expansion closed ${et(k.closedAt)} ${k.dir === 'up' ? 'above' : 'below'} it (range ${k.rangeAtr} ATR, ${k.beyondAtr} ATR beyond${k.volVsBox !== null ? `, volume ${k.volVsBox}x` : ''}), ${k.barsAgo} ${k.barsAgo === 1 ? 'bar' : 'bars'} ago${k.backInside ? ', closed back inside' : !k.beyondNow ? ', price back inside' : ''}${k.late ? `, late: ${k.runAtr} ATR past its close` : ''}` : '';
    if (x.state === 'expanding') parts.push(`${tf} expanding ${k.dir}: ${boxWords(b, true)}, ${brk}`);
    else if (k) parts.push(`${tf} no expansion: ${boxWords(b, true)}, ${brk}`);
    else if (x.state === 'compressing') parts.push(`${tf} ${boxWords(b, false)}`);
  }
  return parts.length ? `- Compression (completed candles; a read, not a signal): ${parts.join('; ')}.` : null;
}

module.exports = { PARAMS, seriesOf, boxAt, compressionAt, compressionFrames, compressionLine };
