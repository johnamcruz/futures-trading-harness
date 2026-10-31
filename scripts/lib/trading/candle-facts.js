'use strict';

/**
 * Completed-candle facts: per timeframe (3m, 5m, 15m, 60m, 4h), the LAST COMPLETED candle as of a bar's close (never
 * the one forming), its shape, a pattern label, how it met the key levels, and the next swing high above and swing
 * low below price. One code path for the bar briefing (the last bar) and the rules language (every bar, htfd_*):
 * both read the per-bar series below, so a fact on a bar depends only on the bars closed by then.
 *
 * Candles: grouped on the 18:00 ET grid (indicators.htfCandles, as mtf.js candles and the briefing's wholeBars), each
 * stamped with its own boundary's open (a missing first sub-bar never moves it). A candle is completed on the bar that
 * closes on its boundary, or, when its last sub-bar is missing, on the first bar of the next candle (only then is it
 * known to be over). A first candle the bars start partway into is dropped. A timeframe that isn't whole base bars (5m
 * from 3m bars) is unavailable: never approximated. The base bars' size is GIVEN (`base`, minutes: the runner's or
 * lane's timeframe, a strategy's), never guessed from the gaps: one bar off the grid must not change what is whole
 * or when a candle closes. Without it there are no candle facts.
 *
 * 4h candles open on the same grid: 18:00, 22:00, 02:00, 06:00, 10:00 and 14:00 ET. The session's last one (14:00 ET)
 * holds the bars up to the daily break and is completed on the next session's first bar (18:00 ET, or Sunday's open),
 * as any candle whose last sub-bar is missing: never from a clock or a calendar; its `closedAt` is the 18:00 ET
 * boundary.
 *
 * Every timeframe's candle states whether it traded beyond its previous candle's high or low (prevSweep, `sweep`): a
 * sweep when it closed back inside that range (the sweep of the prior 4h low and close back), else the side it closed
 * beyond. The one place the briefing says it (the CRT read uses it too).
 *
 *   completedSeries(bars, minutes, base)   { available, reason, candles, lastAt }: lastAt[i] the index of the last
 *                                          candle completed by bar i's close (-1 none)
 *   shape(c)                               { body, upperWick, lowerWick, closeAt } shares of the range (null at zero range)
 *   closeLocation(c)                       'top' | 'middle' | 'bottom' (third of the range), null at zero range
 *   patternsOf(c, prev, atrPrev)           every pattern that holds, in label priority; patternLabel: the first, else 'none'
 *   factsOf(candles)                       per candle: shape, closeLocation, rangeAtr (ATR as of the candle before), volRatio,
 *                                          patterns and pattern (one pass; the momentum read reads these)
 *   insideStackOf(candles, j)              { insideStack, mother } of candle j (the candles in a row inside one mother), or {}
 *                                          (insideStacks(candles): every candle's, one pass)
 *   relation(c, level, prevClose)          { relation: 'rejected' | 'broke' | 'touched' | 'none', dir } or null (no level)
 *   candleSeries(bars, minutes, base)      per-bar facts (the rules language's htfd_* series), memoised on the bars
 *   relationSeries(bars, minutes, base, level, { at })   per-bar relation to a level series ('open', 'close', 'now')
 *   swingTargetSeries(bars, minutes, base) per bar: the nearest untaken confirmed swing high above / low below the close
 *   briefingCandles({ bars, base, fine, levelsAt, zonesAt, crtFrames })   the briefing's `candles` block (last bar; fine:
 *                                          1m bars for a timeframe the base bars can't build; zonesAt(openIdx, openMs): the gap
 *                                          edges as of the candle's open, read into `fvgRelations`)
 *   holdingSwingsAt(bars, minutes, base, idx)   the swings still holding as of bar idx
 *   briefingTargets({ bars, minutes, price, oneR, tick })    the briefing's `swingTargets` block (last bar)
 *   briefingRangeTargets({ bars, base, price, oneR, tick, index })   the briefing's `rangeTargets`: per frame (1h, 4h)
 *                                          the last completed candle's high, mid and low as targets, and the side the
 *                                          candle forming since has taken (prevSweep), only when it has
 *   completedCandlesAt({ bars, base, fine, minutes, at })   the completed candles as of bar at's close, by the
 *                                          briefing's rule ({ src, upto, candles, j } or { unavailable })
 *   prevSweep(c, prev)                     { side: 'high' | 'low' | 'both', closedBack, closedBeyond } when c traded
 *                                          beyond prev's high or low (closedBack: closed inside prev's range; closedBeyond:
 *                                          'high' | 'low', the side it closed beyond, else null), else null
 *
 * The definitions below are HYPOTHESES to test against outcomes, not established edges. R = high - low, B = |close -
 * open|, U = high - max(open, close), D = min(open, close) - low; prev is the previous completed candle on the same
 * timeframe; ATR is the timeframe's ATR(14) as of the previous candle (the candle's own range never dilutes it):
 *
 *   doji               R > 0 and B <= 0.1 R
 *   hammer             R > 0, D >= 2 B, D >= 0.6 R and U <= 0.15 R (a shape only: no prior trend is required)
 *   shooting star      R > 0, U >= 2 B, U >= 0.6 R and D <= 0.15 R
 *   bullish engulfing  close > open, prev close < prev open, the body covers prev's body and B > prev's B
 *   bearish engulfing  the mirror
 *   inside             high <= prev high, low >= prev low and R < prev R; `insideStack` counts the candles in a row
 *                      inside one mother candle (insideStacks), `mother` its range
 *   outside            high >= prev high, low <= prev low and R > prev R
 *   displacement       B >= 0.7 R and R >= 1.5 x ATR (direction: close against open)
 *   none               none of these; a zero-range candle (open = high = low = close) is always none
 *
 * The label is the first that holds in this order: bullish/bearish engulfing, displacement, hammer, shooting star,
 * outside, inside, doji (two-candle patterns before one-candle shapes; a dragonfly doji with a long lower wick is a
 * hammer). Close location: (close - low) / R at least 2/3 is the top third, at most 1/3 the bottom, else the middle.
 *
 * A level L against a candle: a FIXED level (the prior day, overnight, opening range, IB, the prior profile, swings)
 * as it stood when the candle OPENED, so a candle reacts only to levels that existed before it began (never one its
 * own bars made); a MOVING level (VWAP, the developing session profile) at its value when the candle CLOSED. Where
 * price came from: the candle's open, or, when it opened on L, the previous candle's close:
 *   none       L is outside [low, high]
 *   rejected   traded through L and closed back on the side it came from (from below: high > L and close < L, dir
 *              down; from above: low < L and close > L, dir up)
 *   broke      closed beyond L with most of the body beyond (from below: close > L and (open + close) / 2 > L, dir up;
 *              the mirror down)
 *   touched    traded at L otherwise (reached it exactly, a close beyond with most of the body still behind, or no side)
 *
 * Swing targets: confirmed fractal swings on completed candles (a high above the 2 candles each side, structure-events
 * pivots), confirmed when the 2nd candle after it completes; a swing is taken once a later bar trades beyond it, and
 * then no longer a target. The next swing high is the lowest untaken one above the close, the next swing low the
 * highest untaken one below.
 *
 * The briefing lists at most MAX_LEVELS level relations per candle, strongest first: rejected, then broke, then
 * touched; within each, by level (LEVEL_ORDER: the prior day, overnight, IB and opening range, VWAP, value areas,
 * swings, CRT range, previous candle, round numbers), the rest counted.
 *
 * Each relation carries its `reaction` (candle-reaction.js: confirmed rejection, breakout, engulfing rejection,
 * long-wick rejection, conflicting, stall, plain, unknown), a read for context, never a veto. A confirmed rejection of
 * a level the previous candle rejected with a long wick, which this candle didn't meet, is listed in `confirmed`.
 */

const { htfCandles, atr: atrOf, sessionKey, ATR_PERIOD } = require('./indicators');
const { zonedParts, tradingDayStart } = require('./clock');
const { pivots } = require('./structure-events');
const { momentumRead } = require('./momentum');
const { reactionOf } = require('./candle-reaction');
const { GLOBEX_OPEN_MIN } = require('./clock'); // the session boundaries' one home

const CAN = require('../tunables').analysis().candles;
// The reaction read's higher frame per frame (config/analysis.json reaction.conflict: the 15m against the 1h).
const CONFLICT = require('../tunables').analysis().reaction.conflict; // config/analysis.json candles: the pattern definitions and the reads' lengths
const TIMEFRAMES = CAN.timeframes;
const ATR_LEN = ATR_PERIOD;
const VOL_LEN = CAN.volLen;
const VOL_MIN = CAN.volMin;
const SWING_K = require('../tunables').analysis().indicators.swingK;
const MAX_ACTIVE = CAN.maxActive;
const DEF = { dojiBody: CAN.dojiBody, wickBody: CAN.wickBody, wickRange: CAN.wickRange, otherWick: CAN.otherWick, dispBody: CAN.dispBody, dispAtr: CAN.dispAtr };
const LABELS = ['bullish engulfing', 'bearish engulfing', 'displacement', 'hammer', 'shooting star', 'outside', 'inside', 'doji'];

const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const label = m => (m % 60 === 0 ? `${m / 60}h` : `${m}m`);

/** Whether an instant is on an m-minute boundary of the 18:00 ET grid. */
function onBoundary(ms, minutes) {
  return sinceOpen(ms) % minutes === 0;
}
/** Minutes since the 18:00 ET open, -1 off a whole minute. */
function sinceOpen(ms) {
  if (ms % 60000 !== 0) return -1;
  const p = zonedParts(new Date(ms), 'America/New_York');
  return (p.hour * 60 + p.minute - GLOBEX_OPEN_MIN + 1440) % 1440;
}

/** The open of the m-minute boundary containing `ms` (counted from the trading day's start, as briefing nextClose). */
function boundaryOpen(ms, minutes) {
  const start = tradingDayStart(new Date(ms)).getTime();
  const step = minutes * 60000;
  return start + Math.floor((ms - start) / step) * step;
}

/** Why `minutes` can't be built from `base`-minute bars (5m from 3m: never approximated); null when it can. */
function unavailableReason(base, minutes) {
  if (!(Number.isInteger(base) && base > 0)) return 'the bar size is not known (never guessed)';
  return minutes >= base && minutes % base === 0 ? null : `not whole ${label(base)} bars`;
}

const CACHE = new WeakMap();
const memo = (bars, key, make) => {
  if (!CACHE.has(bars)) CACHE.set(bars, new Map());
  const m = CACHE.get(bars);
  if (!m.has(key)) m.set(key, make());
  return m.get(key);
};

/** The higher-timeframe candles of `bars` (indicators htfCandles), once per bars and timeframe. */
const htfOf = (bars, minutes) => memo(bars, `htf:${minutes}`, () => htfCandles(bars, minutes));

/**
 * The completed m-minute candles of `bars` (each `base` minutes), and per bar the last one completed by its close
 * (-1: none, or the timeframe isn't whole base bars).
 */
function completedSeries(bars, minutes, base) {
  return memo(bars, `series:${minutes}:${base}`, () => {
    const n = bars.length;
    const lastAt = new Array(n).fill(-1);
    const candles = [];
    const reason = n ? unavailableReason(base, minutes) : 'no bars';
    if (reason) return { available: false, reason, candles, lastAt };
    const h = htfOf(bars, minutes);
    const ms = bars.map(b => Date.parse(b.t));
    // Each bar's close in minutes since the 18:00 ET open (once per bars and bar size, for every timeframe).
    const closes = memo(bars, `closes:${base}`, () => ms.map(x => sinceOpen(x + base * 60000)));
    let cur = null;
    const finish = x => {
      if (!x || x.cut || x.done) return;
      x.done = true;
      const t = boundaryOpen(ms[x.first], minutes);
      candles.push({ t: new Date(t).toISOString(), closedAt: new Date(t + minutes * 60000).toISOString(), o: x.o, h: x.h, l: x.l, c: x.c, v: x.v, first: x.first, last: x.last });
    };
    for (let i = 0; i < n; i += 1) {
      const b = bars[i];
      if (!cur || cur.key !== h.key[i]) {
        finish(cur);
        cur = { key: h.key[i], o: b.o, h: b.h, l: b.l, c: b.c, v: Number.isFinite(b.v) ? b.v : NaN, first: i, last: i, cut: i === 0 && !onBoundary(ms[i], minutes), done: false };
      } else if (!cur.done) {
        cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.last = i;
        cur.v = Number.isFinite(cur.v) && Number.isFinite(b.v) ? cur.v + b.v : NaN;
      }
      if (closes[i] >= 0 && closes[i] % minutes === 0) finish(cur);
      lastAt[i] = candles.length - 1;
    }
    return { available: true, reason: null, candles, lastAt };
  });
}

/** Body and wick shares of the range, and where the close sits in it (0 low, 1 high); null at zero range. */
function shape(c) {
  const R = c.h - c.l;
  if (!(R > 0)) return { body: null, upperWick: null, lowerWick: null, closeAt: null };
  return { body: Math.abs(c.c - c.o) / R, upperWick: (c.h - Math.max(c.o, c.c)) / R, lowerWick: (Math.min(c.o, c.c) - c.l) / R, closeAt: (c.c - c.l) / R };
}

function closeLocation(c) {
  const { closeAt } = shape(c);
  if (closeAt === null) return null;
  return closeAt >= 2 / 3 - 1e-9 ? 'top' : closeAt <= 1 / 3 + 1e-9 ? 'bottom' : 'middle';
}

/** The inside rule, one definition: c within m's high and low, with a smaller range (the pattern; a stack's mother). */
const isInside = (c, m) => c.h <= m.h && c.l >= m.l && c.h - c.l < m.h - m.l;

/** Every pattern that holds on candle c (prev: the candle before it; atrPrev: ATR as of prev), in label priority. */
function patternsOf(c, prev = null, atrPrev = NaN) {
  const R = c.h - c.l;
  if (!(R > 0)) return [];
  const B = Math.abs(c.c - c.o);
  const U = c.h - Math.max(c.o, c.c);
  const D = Math.min(c.o, c.c) - c.l;
  const out = new Set();
  if (prev) {
    const pB = Math.abs(prev.c - prev.o);
    const covers = Math.min(c.o, c.c) <= Math.min(prev.o, prev.c) && Math.max(c.o, c.c) >= Math.max(prev.o, prev.c) && B > pB;
    if (covers && c.c > c.o && prev.c < prev.o) out.add('bullish engulfing');
    if (covers && c.c < c.o && prev.c > prev.o) out.add('bearish engulfing');
    const pR = prev.h - prev.l;
    if (c.h >= prev.h && c.l <= prev.l && R > pR) out.add('outside');
    if (isInside(c, prev)) out.add('inside');
  }
  if (B >= DEF.dispBody * R && atrPrev > 0 && R >= DEF.dispAtr * atrPrev) out.add('displacement');
  if (D >= DEF.wickBody * B && D >= DEF.wickRange * R && U <= DEF.otherWick * R) out.add('hammer');
  if (U >= DEF.wickBody * B && U >= DEF.wickRange * R && D <= DEF.otherWick * R) out.add('shooting star');
  if (B <= DEF.dojiBody * R) out.add('doji');
  return LABELS.filter(x => out.has(x));
}

const patternLabel = list => (list.length ? list[0] : 'none');

/** How candle c met `level` (see the header); null without a level. */
function relation(c, level, prevClose = NaN) {
  if (!Number.isFinite(level)) return null;
  if (c.h < level || c.l > level) return { relation: 'none', dir: null };
  const from = c.o < level ? 'below' : c.o > level ? 'above'
    : Number.isFinite(prevClose) && prevClose !== level ? (prevClose < level ? 'below' : 'above') : null;
  if (from === 'below') {
    if (c.c > level && (c.o + c.c) / 2 > level) return { relation: 'broke', dir: 'up' };
    if (c.h > level && c.c < level) return { relation: 'rejected', dir: 'down' };
  } else if (from === 'above') {
    if (c.c < level && (c.o + c.c) / 2 < level) return { relation: 'broke', dir: 'down' };
    if (c.l < level && c.c > level) return { relation: 'rejected', dir: 'up' };
  }
  return { relation: 'touched', dir: null };
}

/**
 * Whether candle c traded beyond its previous candle's high (low), and where it closed: back inside prev's range
 * (strictly between its low and high: a sweep), or beyond its high or low (closedBeyond; on the extreme counts as
 * beyond). Both sides: 'both'. null without prev or when it stayed inside.
 */
function prevSweep(c, prev) {
  if (!prev) return null;
  const high = c.h > prev.h;
  const low = c.l < prev.l;
  if (!high && !low) return null;
  const closedBack = c.c > prev.l && c.c < prev.h;
  return { side: high && low ? 'both' : high ? 'high' : 'low', closedBack, closedBeyond: closedBack ? null : c.c >= prev.h ? 'high' : 'low' };
}

/** Per completed candle: its facts (shape, ATR, volume against its average, patterns). */
function candleFactsList(bars, minutes, base) {
  return memo(bars, `facts:${minutes}:${base}`, () => factsOf(completedSeries(bars, minutes, base).candles));
}

function factsOf(cs) {
  const atr = cs.length ? atrOf(cs, ATR_LEN) : [];
  const stacks = insideStacks(cs);
  return cs.map((c, j) => {
    const prev = j > 0 ? cs[j - 1] : null;
    const atrPrev = j > 0 ? atr[j - 1] : NaN;
    const vols = cs.slice(Math.max(0, j - VOL_LEN), j).map(x => x.v);
    const avg = vols.length >= VOL_MIN && vols.every(Number.isFinite) ? vols.reduce((a, b) => a + b, 0) / vols.length : NaN;
    const patterns = patternsOf(c, prev, atrPrev);
    return {
      ...shape(c), closeLocation: closeLocation(c), prev,
      rangeAtr: atrPrev > 0 ? (c.h - c.l) / atrPrev : NaN,
      volRatio: avg > 0 && Number.isFinite(c.v) ? c.v / avg : NaN,
      patterns, pattern: patternLabel(patterns), ...stacks[j],
    };
  });
}

/**
 * The inside-bar stacks, per candle: { insideStack, mother } when the candle lies inside the mother candle of the stack
 * the candle before it is in (the `inside` rule: high and low within the mother's, a smaller range; the stack grows),
 * else inside the candle before it (a new stack of 1, that candle the mother); {} otherwise. The mother's range is the
 * box the stack sits in. One pass, oldest first.
 */
function insideStacks(cs) {
  const out = [];
  let mother = -1;
  let n = 0;
  for (let j = 0; j < cs.length; j += 1) {
    if (n && isInside(cs[j], cs[mother])) n += 1;
    else if (j > 0 && isInside(cs[j], cs[j - 1])) { mother = j - 1; n = 1; } else n = 0;
    out.push(n ? { insideStack: n, mother: { t: cs[mother].t, h: cs[mother].h, l: cs[mother].l } } : {});
  }
  return out;
}

/** The inside-bar stack of candle j (insideStacks). */
const insideStackOf = (cs, j) => insideStacks(cs.slice(0, j + 1))[j] || {};

const sign = (list, up, down) => (list.includes(up) ? 1 : list.includes(down) ? -1 : 0);

/**
 * Per-bar series of the last completed m-minute candle (NaN before the first): the rules language's htfd_* series.
 * Flags are 1 or 0; engulfing and displacement are 1 bullish, -1 bearish, 0; close_loc is 1 top, 0 middle, -1 bottom.
 */
function candleSeries(bars, minutes, base) {
  return memo(bars, `candles:${minutes}:${base}`, () => {
    const s = completedSeries(bars, minutes, base);
    const facts = candleFactsList(bars, minutes, base);
    const of = fn => s.lastAt.map(j => (j < 0 ? NaN : fn(s.candles[j], facts[j])));
    const num = x => (Number.isFinite(x) ? x : NaN);
    return {
      htfd_open: of(c => c.o), htfd_high: of(c => c.h), htfd_low: of(c => c.l), htfd_close: of(c => c.c), htfd_volume: of(c => num(c.v)),
      htfd_prev_high: of((c, f) => (f.prev ? f.prev.h : NaN)), htfd_prev_low: of((c, f) => (f.prev ? f.prev.l : NaN)),
      htfd_body: of((c, f) => num(f.body)), htfd_upper_wick: of((c, f) => num(f.upperWick)), htfd_lower_wick: of((c, f) => num(f.lowerWick)),
      htfd_close_loc: of((c, f) => (f.closeLocation === 'top' ? 1 : f.closeLocation === 'bottom' ? -1 : f.closeLocation ? 0 : NaN)),
      htfd_range_atr: of((c, f) => f.rangeAtr), htfd_vol_ratio: of((c, f) => f.volRatio),
      // The momentum read (momentum.js momentumRead) on the unrounded facts, as htfd_range_atr and htfd_vol_ratio: 1 up,
      // -1 down, 0 none, NaN unknown. A candle it fires on always shows `momentum` up or down in the briefing (rounded).
      htfd_momentum: of((c, f) => { const m = momentumRead({ rangeAtr: f.rangeAtr, closeLocation: f.closeLocation, volRatio: f.volRatio }); return m === 'up' ? 1 : m === 'down' ? -1 : m === 'none' ? 0 : NaN; }),
      htfd_doji: of((c, f) => +f.patterns.includes('doji')), htfd_hammer: of((c, f) => +f.patterns.includes('hammer')),
      htfd_shooting_star: of((c, f) => +f.patterns.includes('shooting star')),
      htfd_inside: of((c, f) => +f.patterns.includes('inside')), htfd_outside: of((c, f) => +f.patterns.includes('outside')),
      htfd_engulfing: of((c, f) => sign(f.patterns, 'bullish engulfing', 'bearish engulfing')),
      htfd_displacement: of((c, f) => (f.patterns.includes('displacement') ? Math.sign(c.c - c.o) : 0)),
      key: s.lastAt,
    };
  });
}

/**
 * Per bar, the relation of the last completed candle to `level` (a series over the bars): rejected / broke (1 up, -1
 * down, 0), touched (1 / 0). A fixed level counts when it was complete by the candle's open (its last bar closed at
 * or before it), at its value then; one its own bars made, or one formed later, has none, so no relation. `at`:
 * 'open' reads it on the bar before the candle's first (a series that has its value on its completing bar), 'first'
 * on the candle's first bar (a series made of earlier bars only, from the bar after it completes); 'close' a moving
 * one at the candle's close (its last bar); 'now' on this bar (the candle's own previous candle's high or low).
 * `session`: the level belongs to one session (the opening range, IB, overnight, today's RTH open): read on a bar of
 * the session before (the new session's first candle, at 18:00 ET or Sunday's open) it is stale, so no relation;
 * the prior RTH day is not one (it is the day that just closed).
 */
function relationSeries(bars, minutes, base, level, { at = 'close', session = false } = {}) {
  const s = completedSeries(bars, minutes, base);
  const out = { rejected: [], broke: [], touched: [] };
  s.lastAt.forEach((j, i) => {
    const c = j < 0 ? null : s.candles[j];
    // The level's value on the bar before the candle's first ('open': a series that includes its completing bar), on
    // its first bar ('first': a series made of earlier bars only, set on the bar after it completes), on its last bar
    // ('close'), or on this bar ('now': the candle's own previous one).
    const k = !c ? -1 : at === 'open' ? c.first - 1 : at === 'first' ? c.first : at === 'close' ? c.last : i;
    // A session's own level (`session`: the opening range, IB, overnight, today's RTH open) read on a bar of the
    // session before (a new session's first candle) is stale: no level, so no relation.
    const stale = session && k >= 0 && sessionKey(bars[k].t, GLOBEX_OPEN_MIN) !== sessionKey(c.t, GLOBEX_OPEN_MIN);
    const rel = c ? relation(c, k >= 0 && !stale ? level[k] : NaN, j > 0 ? s.candles[j - 1].c : NaN) : null;
    const dir = rel && rel.dir === 'up' ? 1 : -1;
    out.rejected.push(rel ? (rel.relation === 'rejected' ? dir : 0) : NaN);
    out.broke.push(rel ? (rel.relation === 'broke' ? dir : 0) : NaN);
    out.touched.push(rel ? +(rel.relation === 'touched') : NaN);
  });
  return out;
}

/** Per bar: the nearest untaken confirmed swing high above and swing low below the bar's close (NaN for none). */
function swingTargetSeries(bars, minutes, base) {
  return memo(bars, `targets:${minutes}:${base}`, () => {
    const s = completedSeries(bars, minutes, base);
    const n = bars.length;
    const high = new Array(n).fill(NaN);
    const low = new Array(n).fill(NaN);
    const cs = s.candles;
    let highs = [];
    let lows = [];
    let seen = -1; // the last candle whose completion was processed
    for (let i = 0; i < n; i += 1) {
      const b = bars[i];
      if (highs.some(x => b.h > x)) highs = highs.filter(x => !(b.h > x));
      if (lows.some(x => b.l < x)) lows = lows.filter(x => !(b.l < x));
      for (let j = seen + 1; j <= s.lastAt[i]; j += 1) {
        const p = j - SWING_K;
        if (p < SWING_K) continue;
        const around = cs.slice(p - SWING_K, p + SWING_K + 1).filter((_, k) => k !== SWING_K);
        // The bars after the confirming candle up to this one (a candle known complete only on the next one's first
        // bar): one of them may have traded beyond the swing already.
        const since = bars.slice(cs[j].last + 1, i + 1);
        if (around.every(x => cs[p].h > x.h) && !since.some(x => x.h > cs[p].h)) highs.push(cs[p].h);
        if (around.every(x => cs[p].l < x.l) && !since.some(x => x.l < cs[p].l)) lows.push(cs[p].l);
      }
      seen = Math.max(seen, s.lastAt[i]);
      if (highs.length > MAX_ACTIVE) highs = highs.slice(-MAX_ACTIVE);
      if (lows.length > MAX_ACTIVE) lows = lows.slice(-MAX_ACTIVE);
      for (const x of highs) if (x > b.c && !(x >= high[i])) high[i] = x;
      for (const x of lows) if (x < b.c && !(x <= low[i])) low[i] = x;
    }
    return { available: s.available, reason: s.reason, high, low };
  });
}

// The briefing's cap on level relations per candle, strongest first: the relation, then the level (LEVEL_ORDER).
const MAX_LEVELS = CAN.maxLevels;
const REL_RANK = { rejected: 0, broke: 1, touched: 2 };
const LEVEL_ORDER = [/^prior RTH/, /^overnight/, /^IB/, /^opening range/, /^VWAP/, /^prior (VAH|VAL|POC)/, /^session (VAH|VAL|POC)/,
  /^1h swing/, /^15m swing/, /^CRT/, /^previous/, /^round number/];
const levelRank = name => { const k = LEVEL_ORDER.findIndex(re => re.test(name)); return k < 0 ? LEVEL_ORDER.length : k; };

const RELATION_TEXT = { rejected: { up: 'rejected: closed back above', down: 'rejected: closed back below' }, broke: { up: 'broke above', down: 'broke below' } };

/**
 * The swings of completed m-minute candles as they stood at bar `idx`'s close (structure-events pivots, k = 2,
 * confirmed by then): the last `n` highs and lows, those no bar closed beyond from the swing candle's close to `idx`
 * (the briefing's htfLevels "still holding", as of that bar). [{ label, type, price }]
 */
function holdingSwingsAt(bars, minutes, base, idx, n = 3) {
  const s = completedSeries(bars, minutes, base);
  const J = idx >= 0 && idx < bars.length ? s.lastAt[idx] : -1;
  if (J < 0) return [];
  const cs = s.candles.slice(0, J + 1);
  const ps = pivots(cs, SWING_K);
  const out = [];
  for (const type of ['high', 'low']) {
    for (const x of ps.filter(q => q.type === type).slice(-n)) {
      const end = Date.parse(cs[x.i].closedAt);
      const broken = bars.slice(cs[x.i].last + 1, idx + 1).some(b => Date.parse(b.t) >= end && (type === 'high' ? b.c > x.price : b.c < x.price));
      if (!broken) out.push({ label: label(minutes), type, price: x.price });
    }
  }
  return out;
}

/**
 * The round numbers inside a candle's range: multiples of the family's step (round-numbers.js, the briefing's own
 * round numbers); none for a family without one.
 */
const roundsIn = (c, step) => {
  const out = [];
  if (!(step > 0)) return out;
  for (let k = Math.ceil(c.l / step); k * step <= c.h; k += 1) out.push([`round number ${k * step}`, k * step]);
  return out;
};

/**
 * The briefing's `candles` block: per timeframe the last completed candle's facts as of the last bar, and how it met
 * the key levels as they stood: `levelsAt(idx, openIdx, firstIdx)` gives them ([name, price]); idx is the last base
 * bar closed by the candle's close (a moving level's value then), openIdx the last one closed by its open, firstIdx
 * the first one from its open on (a fixed level complete by the open, read where it holds without the candle's own
 * bars: briefing.js says which level on which). Plus the round
 * numbers in its range, its previous candle's high and low, and the CRT range (the previous `crtFrames` candle, as
 * crt.js reads it on the candle's last bar).
 *
 * A timeframe that isn't whole base bars is built from `fine` (1m bars, e.g. a 1m lane's) when given: only those
 * closed by the base bar's close, and a candle is complete only once its 1m bar ending on the boundary has closed (or
 * a later one has), else the one before is the last completed; never a partial one. Without 1m bars it is
 * unavailable (named why); with 1m bars that stopped (their last completed candle more than one candle old), too.
 */
const ENTRY_TF = (C => C.chainOf(C.SHIPPED).entry)(require('./chain'));

function briefingCandles({ bars, base, fine = null, levelsAt = () => [], zonesAt = null, roundStep = null, crtFrames = [60, 240], timeframes = TIMEFRAMES }) {
  const i = bars.length - 1;
  const out = {};
  const pending = []; // per frame built, what its reactions need (levelReactionsOf, once every frame is in)
  const closeOf = k => Date.parse(bars[k].t) + base * 60000;
  const closedAt = i >= 0 ? closeOf(i) : NaN;
  const fineBars = Array.isArray(fine) ? fine.filter(b => Date.parse(b.t) + 60000 <= closedAt) : null;
  // Whether the 1m bars reach this bar's close (their last one closes with it).
  const reaches = Boolean(fineBars && fineBars.length && Date.parse(fineBars[fineBars.length - 1].t) + 60000 >= closedAt);
  for (const m of timeframes) {
    let src = bars;
    let srcBase = base;
    let s = completedSeries(bars, m, base);
    if (!s.available && fineBars && fineBars.length > 1) {
      const sf = completedSeries(fineBars, m, 1);
      if (sf.available) { src = fineBars; srcBase = 1; s = sf; }
    }
    if (!s.available) { out[label(m)] = { unavailable: fineBars ? `${s.reason}; the 1m bars can't build it` : `${s.reason}; no 1m bars configured` }; continue; }
    const j = s.lastAt[src.length - 1];
    if (j < 0) { out[label(m)] = { unavailable: 'no completed candle in the bars yet' }; continue; }
    const c = s.candles[j];
    if (src !== bars) {
      // From 1m bars: the candle ending on the last boundary by this close, complete; when the 1m bars don't reach
      // the close yet, the one before it; any older one is not current.
      const lastBoundary = closedAt - ((sinceOpen(closedAt) % m + m) % m) * 60000;
      const ok = Date.parse(c.closedAt) === lastBoundary || (!reaches && Date.parse(c.closedAt) === lastBoundary - m * 60000);
      if (!ok) { out[label(m)] = { unavailable: `the 1m bars stop at ${fineBars.length ? new Date(Date.parse(fineBars[fineBars.length - 1].t) + 60000).toISOString() : 'none'}: no current ${label(m)} candle` }; continue; }
    }
    const facts = candleFactsList(src, m, srcBase);
    const f = facts[j];
    const prev = f.prev;
    // The levels candle k met as they stood (levelsAt by its own close, open and first bar), its round numbers, its
    // previous candle's high and low (above the entry frame) and the CRT range.
    const levelsOfCandle = k => {
      const x = s.candles[k];
      const px = k > 0 ? s.candles[k - 1] : null;
      // The last base bar closed by the candle's close (a moving level's value then), and by its open (a fixed level as
      // it stood before the candle began; a swing it broke still held then).
      let idx = src === bars ? x.last : i;
      while (idx >= 0 && closeOf(idx) > Date.parse(x.closedAt)) idx -= 1;
      let openIdx = idx;
      while (openIdx >= 0 && closeOf(openIdx) > Date.parse(x.t)) openIdx -= 1;
      // And the first base bar from its open on (the candle's own first bar on base bars).
      const firstIdx = src === bars ? x.first : bars.findIndex(b => Date.parse(b.t) >= Date.parse(x.t));
      const crt = crtFrames.filter(F => F > m && 1440 % F === 0).flatMap(F => {
        const h = htfOf(src, F);
        return [[`CRT ${label(F)} range high`, h.prevH[x.last]], [`CRT ${label(F)} range low`, h.prevL[x.last]]];
      });
      // The previous candle's high and low are levels on a frame above the entry frame only (the owner: "We should never use
      // entry timeframes as levels"; chain.js): on the chain's entry frame, or the base bars under it, none.
      const prevLevels = px && !(label(m) === ENTRY_TF || m <= base);
      return { openIdx, all: [...(idx >= 0 ? levelsAt(idx, openIdx, firstIdx) : []), ...roundsIn(x, roundStep), ...(prevLevels ? [[`previous ${label(m)} high`, px.h], [`previous ${label(m)} low`, px.l]] : []), ...crt] };
    };
    const { openIdx, all } = levelsOfCandle(j);
    const found = [];
    for (const [name, price] of all) {
      const rel = relation(c, price, prev ? prev.c : NaN);
      if (!rel || rel.relation === 'none' || found.some(x => x.name === name)) continue;
      found.push({ name, price, rel: rel.relation, dir: rel.dir, text: rel.relation === 'touched' ? 'touched' : RELATION_TEXT[rel.relation][rel.dir] });
    }
    // The previous candle's levels, for a confirmed rejection of one this candle didn't meet (reactions, below).
    const prevAll = j > 0 ? levelsOfCandle(j - 1).all : [];
    found.sort((x, y) => (REL_RANK[x.rel] - REL_RANK[y.rel]) || (levelRank(x.name) - levelRank(y.name)));
    // The fair value gaps' edges as they stood at the candle's open (zonesAt(openIdx, its open in ms): [name, price,
    // side]), by the relation rule read through the gap's side (gapRelation): a gap the candle itself fills still
    // counts, so its failure reads broke, never rejected.
    const zones = [];
    for (const z of zonesAt && openIdx >= 0 ? zonesAt(openIdx, Date.parse(c.t)) : []) {
      const [name, price, side] = Array.isArray(z) ? z : [];
      const rel = typeof name === 'string' ? gapRelation(relation(c, price, prev ? prev.c : NaN), name, side) : null;
      if (!rel || rel.relation === 'none' || zones.some(x => x.name === name && x.price === price)) continue;
      zones.push({ name, price, side: side || null, rel: rel.relation, dir: rel.dir });
    }
    out[label(m)] = {
      t: c.t, closedAt: c.closedAt, o: c.o, h: c.h, l: c.l, c: c.c, v: Number.isFinite(c.v) ? c.v : null,
      body: r2(f.body), upperWick: r2(f.upperWick), lowerWick: r2(f.lowerWick), closeLocation: f.closeLocation,
      rangeAtr: r2(f.rangeAtr), volRatio: r2(f.volRatio), pattern: f.pattern,
      // The momentum read (momentum.js, D4) from the values shown: up, down, none, or null (unknown).
      momentum: momentumRead({ rangeAtr: r2(f.rangeAtr), closeLocation: f.closeLocation, volRatio: r2(f.volRatio) }),
      ...(f.patterns.length > 1 ? { patterns: f.patterns } : {}),
      ...(f.pattern === 'displacement' ? { dir: c.c > c.o ? 'up' : 'down' } : {}),
      // An inside bar's stack: how many candles in a row sit inside one mother candle, and the mother's range.
      ...(f.insideStack ? { insideStack: f.insideStack, mother: f.mother } : {}),
      ...sweepField(m, c, prev),
      levels: Object.fromEntries(found.slice(0, MAX_LEVELS).map(x => [x.name, x.text])),
      // Filled in below (reactions), once every frame's relations are known.
      reactions: null,
      ...(found.length > MAX_LEVELS ? { moreLevels: found.length - MAX_LEVELS } : {}),
      // Every relation, structured and uncapped (the text above keeps MAX_LEVELS): what the composed-entry reads checker
      // (composed-reads.js) verifies against. Never rendered (briefing.js detailEntries and candleLines leave it out).
      relations: found.map(x => ({ name: x.name, price: x.price, rel: x.rel, dir: x.dir })),  // + reaction (levelReactionsOf)
      // How it met the fair value gaps' edges ('<tf> fvg low|high', fvg-frames.js fvgEdgesAt), uncapped and never
      // rendered either: the composed-entry FVG reads verify against it. Only when the caller gives the gaps.
      ...(zonesAt ? { fvgRelations: zones } : {}),
    };
    pending.push({ m, c, prev, pp: j > 1 ? s.candles[j - 2].c : NaN, patterns: f.patterns, found, prevAll });
  }
  for (const x of pending) Object.assign(out[label(x.m)], levelReactionsOf(x, out));
  return out;
}

/** A confirmed level named as the previous candle met it, with its price: `previous 15m high` there is `the 15m high 110`. */
const confirmedText = (name, price) => (/^previous /.test(name) ? `the ${name.replace(/^previous /, '')} ${price}` : `${name} ${price}`);

/**
 * A candle's reactions (candle-reaction.js) at the levels it met, on its relations (and `reactions`, by level, the
 * rendered text's), and `confirmed`: the confirmed rejections of levels its previous candle met that it didn't. A frame
 * checked against a higher one (CONFLICT) reads that frame's relation to the same level; the frame missing: unknown.
 */
function levelReactionsOf({ m, c, prev, pp, patterns, found, prevAll }, out) {
  const hm = CONFLICT[String(m)];
  const hc = hm ? out[label(hm)] : undefined;
  const higherOf = name => {
    if (!hm) return undefined;
    if (!hc || hc.unavailable || !Array.isArray(hc.relations)) return null;
    const r = hc.relations.find(x => x.name === name);
    return r ? { relation: r.rel, dir: r.dir } : { relation: 'none', dir: null };
  };
  const relations = found.map(x => ({ name: x.name, price: x.price, rel: x.rel, dir: x.dir, reaction: reactionOf({ c, prev, level: x.price, patterns, prevPrevClose: pp, higher: higherOf(x.name) }) }));
  // The previous candle's levels are named as they stood for it: a relative one (its `previous <tf> high`) is another
  // price for this candle, so each is said with its price (as the previous candle met it), and deduplicated against this
  // candle's own levels and each other by price, never by name.
  const confirmed = [];
  for (const [name, price] of prevAll) {
    if (!Number.isFinite(price) || found.some(x => x.price === price) || confirmed.some(x => x.price === price)) continue;
    if (reactionOf({ c, prev, level: price, patterns, prevPrevClose: pp }) === 'confirmed rejection') confirmed.push({ name, price, dir: c.c < prev.c ? 'down' : 'up', text: confirmedText(name, price) });
  }
  return { relations, reactions: Object.fromEntries(relations.map(x => [x.name, x.reaction])), ...(confirmed.length ? { confirmed } : {}) };
}

/**
 * A candle's relation to a fair value gap's edge, by the gap's side: a bullish gap (support) is rejected only up (the
 * bounce) and broken only down through its low (the failure: a close beyond its far edge); a bearish gap the mirror
 * (rejected down, broken up through its high). Anything else that met the edge (a close inside the gap, a gap of
 * unknown side) is touched. null without a relation.
 */
function gapRelation(rel, name, side) {
  if (!rel || rel.relation === 'none' || rel.relation === 'touched') return rel;
  const edge = / fvg (low|high)$/.exec(name);
  const bull = side === 'bullish';
  const bear = side === 'bearish';
  const ok = rel.relation === 'rejected' ? (bull && rel.dir === 'up') || (bear && rel.dir === 'down')
    : (bull && rel.dir === 'down' && edge && edge[1] === 'low') || (bear && rel.dir === 'up' && edge && edge[1] === 'high');
  return ok ? rel : { relation: 'touched', dir: null };
}

/**
 * A candle's `sweep` of its previous candle: { of, closedBack, closedBeyond } when it traded beyond its high or low;
 * null when it stayed inside, or without a previous candle.
 */
function sweepField(m, c, prev) {
  const s = prevSweep(c, prev);
  return { sweep: s ? { of: `previous ${label(m)} ${s.side === 'both' ? 'high and low' : s.side}`, closedBack: s.closedBack, closedBeyond: s.closedBeyond } : null };
}

/**
 * The briefing's `swingTargets`: per side, the next swing on each of `frames` (the base bars' own, 15m, 60m, 4h) with its
 * distance in points, ticks and R (oneR: 1R in points).
 */
function briefingTargets({ bars, minutes, price, oneR, tick = 0.25, frames = [minutes, 15, 60, 240] }) {
  // `minutes`: the bars' own size (given, never guessed).
  const i = bars.length - 1;
  const above = [];
  const below = [];
  for (const m of [...new Set(frames)].sort((a, b) => a - b)) {
    const s = swingTargetSeries(bars, m, minutes);
    if (!s.available) continue;
    for (const [list, p] of [[above, s.high[i]], [below, s.low[i]]]) {
      if (!Number.isFinite(p)) continue;
      const points = Math.abs(p - price);
      list.push({ frame: label(m), price: p, points: r2(points), ticks: Math.round(points / tick), R: oneR > 0 ? r2(points / oneR) : null });
    }
  }
  return { above, below };
}

// The frames whose last completed candle's range (high, mid, low) is a target (briefingRangeTargets): 1h and 4h.
const RANGE_FRAMES = CAN.rangeFrames;

/**
 * A target level against price: its side, and its distance in whole ticks, points and R (oneR: 1R in points) to the
 * level rounded onto the tick toward price (a target rounds toward the entry: an off-tick midpoint loses the part
 * tick; a level on the tick is unchanged).
 */
const targetAt = (p, price, oneR, tick) => {
  const ticks = Math.floor(Math.abs(p - price) / tick + 1e-9);
  const points = ticks * tick;
  return { price: p, side: p > price ? 'above' : p < price ? 'below' : 'at', points: r2(points), ticks, R: oneR > 0 ? r2(points / oneR) : null };
};

/**
 * The briefing's `rangeTargets`: per frame (RANGE_FRAMES), the last COMPLETED candle as of bar `index` (the last; never
 * the one forming: completedSeries) with its high, low and midpoint ((high + low) / 2, the price exact; its distance to the tick toward price: targetAt) as target levels, each
 * with its side of price, distance and R; and, only when it happened, `taken`: the candle forming since it (its bars
 * up to `index`) has traded beyond exactly one side of it (prevSweep): { side: 'high' | 'low', closedBack } (closedBack:
 * this bar closed back inside the range; the far side is then the other one). A frame the base bars can't build, or
 * with no completed candle yet: { unavailable }. Reads bars 0..index only.
 */
function briefingRangeTargets({ bars, base, price, oneR, tick = 0.25, frames = RANGE_FRAMES, index = bars.length - 1 }) {
  const i = index;
  const out = {};
  for (const m of frames) {
    const s = completedSeries(bars, m, base);
    if (!s.available) { out[label(m)] = { unavailable: s.reason }; continue; }
    const j = i >= 0 ? s.lastAt[i] : -1;
    if (j < 0) { out[label(m)] = { unavailable: 'no completed candle in the bars yet' }; continue; }
    const c = s.candles[j];
    const x = { t: c.t, closedAt: c.closedAt, high: targetAt(c.h, price, oneR, tick), mid: targetAt((c.h + c.l) / 2, price, oneR, tick), low: targetAt(c.l, price, oneR, tick) };
    // The candle forming since: the bars after the completed one's last, up to this one.
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = c.last + 1; k <= i; k += 1) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }
    const sw = c.last < i ? prevSweep({ h: hi, l: lo, c: bars[i].c }, c) : null;
    if (sw && sw.side !== 'both') x.taken = { side: sw.side, closedBack: sw.closedBack };
    out[label(m)] = x;
  }
  return out;
}

/**
 * The completed `minutes` candles as of base bar `at`'s close, by the briefing's candle rule (briefingCandles): from
 * the base bars when the timeframe is whole base bars, else from `fine` (1m bars, a 1m lane's) closed by that close,
 * and then only a current candle (the one ending on the last boundary, or the one before while the 1m bars don't
 * reach the close yet). { src, upto, candles, j }: src the bars they are built from, upto the last of them closed by
 * the close, j the last candle completed by then; or { unavailable } with why (never approximated). Only the bars
 * closed by bar `at`'s close are read: bars after it change nothing. `until` (ms, at or after that close and before the
 * next base bar's): the 1m bars are read up to it instead (a candle's open between base closes, e.g. a 5m open).
 */
function completedCandlesAt({ bars, base, fine = null, minutes, at = bars.length - 1, until = null }) {
  if (!(at >= 0 && at < bars.length)) return { unavailable: 'no bars' };
  const barClose = Date.parse(bars[at].t) + base * 60000;
  const closedAt = Number.isFinite(until) && until >= barClose && until < barClose + base * 60000 ? until : barClose;
  let src = bars;
  let upto = at;
  let s = completedSeries(bars, minutes, base);
  const fineBars = Array.isArray(fine) ? fine.filter(b => Date.parse(b.t) + 60000 <= closedAt) : null;
  if (!s.available && fineBars && fineBars.length > 1) {
    const sf = completedSeries(fineBars, minutes, 1);
    if (sf.available) { src = fineBars; upto = fineBars.length - 1; s = sf; }
  }
  if (!s.available) return { unavailable: fineBars ? `${s.reason}; the 1m bars can't build it` : `${s.reason}; no 1m bars configured` };
  const j = s.lastAt[upto];
  if (j < 0) return { unavailable: 'no completed candle in the bars yet' };
  if (src !== bars) {
    const lastFine = Date.parse(fineBars[fineBars.length - 1].t) + 60000;
    const lastBoundary = closedAt - ((sinceOpen(closedAt) % minutes + minutes) % minutes) * 60000;
    const end = Date.parse(s.candles[j].closedAt);
    if (!(end === lastBoundary || (lastFine < closedAt && end === lastBoundary - minutes * 60000))) {
      return { unavailable: `the 1m bars stop at ${new Date(lastFine).toISOString()}: no current ${label(minutes)} candle` };
    }
  }
  return { src, upto, candles: s.candles, j };
}

module.exports = {
  TIMEFRAMES, DEF, LABELS, MAX_LEVELS, LEVEL_ORDER, label, completedSeries, shape, closeLocation, patternsOf, patternLabel, relation,
  candleSeries, relationSeries, swingTargetSeries, holdingSwingsAt, briefingCandles, briefingTargets, RELATION_TEXT,
  prevSweep, RANGE_FRAMES, briefingRangeTargets, completedCandlesAt, gapRelation, insideStackOf, insideStacks, factsOf, levelReactionsOf, confirmedText,
};
