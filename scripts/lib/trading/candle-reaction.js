'use strict';

/**
 * The reaction read: how a completed candle reacted at a level it met (the owner's classification, 2026-10-31). A
 * read for context, never a veto and never an entry on its own: it removes no trade. Pure: the caller (candle-facts.js
 * briefingCandles) gives the candle, its previous one, the level, the patterns (candle-facts patternsOf) and, for a
 * frame checked against a higher one, that frame's last completed candle's relation to the same level.
 *
 * The side price came from (sideOf): the candle's open against the level, or, when it opened on it, the previous
 * candle's close (candle-facts relation's rule). From below the level is a high ("after a high"); from above a low
 * (the mirror: bullish and bearish swap, the upper wick becomes the lower). L the level; R range, B body, W the wick
 * beyond the level (after a high: high - max(L, open, close), the failed attempt past it; after a low the mirror), each a
 * candle's own:
 *
 *   confirmed rejection   the previous candle was a long-wick rejection of L (below), this one is the opposite-side
 *                         engulfing (bearish after a high) closing lower than the previous candle and back inside L. The
 *                         second candle carries it, met L or not
 *   breakout              closed beyond L (strictly) with a with-side engulfing (bullish after a high) or B >= breakoutBody R
 *   engulfing rejection   traded beyond L, closed back inside, an opposite-side engulfing
 *   long-wick rejection   traded beyond L, closed back inside, W >= wickBody B and W >= wickRange R
 *   conflicting           traded beyond L, closed back inside, and its body is with the push (bullish after a high), or
 *                         (a frame checked against a higher one: the 15m against the 1h) the higher frame's last completed
 *                         candle broke L the push's way (candle-facts `broke`: closed beyond, most of the body beyond)
 *   stall                 a doji or an inside candle at L (a doji is never conflicting: its body is noise)
 *   plain                 met L, none of the above
 *   unknown               the read can't be made (fail closed): a candle or level not finite, no previous candle, no
 *                         side, or the higher frame unknown where it would decide
 *
 * The first that holds wins, in that order. A close beyond L beats its wick (never a rejection); a close exactly on L
 * is no close beyond and none back (stall or plain). Thresholds: config/analysis.json `reaction` (tunables.js).
 *
 *   REACTIONS                                       the labels, in priority order, then 'unknown'
 *   sideOf(c, level, prevClose)                     'below' | 'above' | null
 *   isLongWick(c, level, side)                      the long-wick rejection's own test (the confirmed one's first candle)
 *   reactionOf({ c, prev, level, patterns, prevPrevClose, higher })
 *                                                   the reaction at a level c met; null when c didn't meet it and isn't
 *                                                   the confirmation of prev's long wick there
 */

const RE = require('../tunables').analysis().reaction; // config/analysis.json reaction: the thresholds
// wickRange 0.3333 stands for 1/3 (config holds no fraction; a wick of exactly a third still passes).
const DEF = Object.freeze({ wickBody: RE.wickBody, wickRange: RE.wickRange, breakoutBody: RE.breakoutBody });

const REACTIONS = Object.freeze(['confirmed rejection', 'breakout', 'engulfing rejection', 'long-wick rejection', 'conflicting', 'stall', 'plain', 'unknown']);

const finite = c => Boolean(c) && [c.o, c.h, c.l, c.c].every(Number.isFinite) && c.h >= c.l;

/** Where price came from: the open against the level, else (opened on it) the previous close; null when neither says. */
function sideOf(c, level, prevClose = NaN) {
  if (c.o < level) return 'below';
  if (c.o > level) return 'above';
  if (Number.isFinite(prevClose) && prevClose !== level) return prevClose < level ? 'below' : 'above';
  return null;
}

/** The candle's facts against the level from `side`: traded beyond, closed back inside, closed beyond, its wick. */
function against(c, level, side) {
  const up = side === 'below';
  const R = c.h - c.l;
  return {
    up, R, B: Math.abs(c.c - c.o),
    through: up ? c.h > level : c.l < level,
    back: up ? c.c < level : c.c > level,
    beyond: up ? c.c > level : c.c < level,
    // The wick beyond the level: the part of the attempt past it that failed (never the wick below it).
    wick: up ? c.h - Math.max(level, c.o, c.c) : Math.min(level, c.o, c.c) - c.l,
    withBody: up ? c.c > c.o : c.c < c.o,
    withEngulf: up ? 'bullish engulfing' : 'bearish engulfing',
    oppEngulf: up ? 'bearish engulfing' : 'bullish engulfing',
  };
}

/** A long-wick rejection: traded beyond the level, closed back inside, the wick beyond it at least wickBody bodies and wickRange of the range. */
function isLongWick(c, level, side, def = DEF) {
  if (!finite(c) || !Number.isFinite(level) || !side) return false;
  const x = against(c, level, side);
  return x.R > 0 && x.through && x.back && x.wick >= def.wickBody * x.B && x.wick >= def.wickRange * x.R;
}

/**
 * The reaction of candle c at `level` (see the header). prevPrevClose: the previous candle's own previous close (its
 * side), for the confirmed rejection. higher: undefined when no higher frame is checked; else that frame's last
 * completed candle's relation to the level (candle-facts relation: { relation, dir }; null: it is unknown).
 */
function reactionOf({ c, prev = null, level, patterns = [], prevPrevClose = NaN, higher, def = DEF } = {}) {
  if (!Number.isFinite(level)) return null;
  if (!finite(c)) return 'unknown';
  const met = c.h >= level && c.l <= level;
  // The confirmation: the previous candle a long-wick rejection of the level, this one the opposite engulfing closing
  // lower (after a high) and back inside it. On the second candle, whether it met the level or not.
  if (finite(prev)) {
    const ps = sideOf(prev, level, prevPrevClose);
    if (ps && isLongWick(prev, level, ps, def)) {
      const x = against(c, level, ps);
      const lower = x.up ? c.c < prev.c : c.c > prev.c;
      if (patterns.includes(x.oppEngulf) && lower && x.back) return 'confirmed rejection';
    }
  }
  if (!met) return null;
  if (!finite(prev)) return 'unknown';
  const side = sideOf(c, level, prev.c);
  if (!side) return 'unknown';
  const x = against(c, level, side);
  if (x.beyond && (patterns.includes(x.withEngulf) || (x.R > 0 && x.B >= def.breakoutBody * x.R))) return 'breakout';
  if (x.through && x.back && patterns.includes(x.oppEngulf)) return 'engulfing rejection';
  if (isLongWick(c, level, side, def)) return 'long-wick rejection';
  // A doji's with-side body is noise: it reads stall, never conflicting.
  if (x.through && x.back && !patterns.includes('doji')) {
    const broke = Boolean(higher) && higher.relation === 'broke' && higher.dir === (x.up ? 'up' : 'down');
    if (x.withBody || broke) return 'conflicting';
    if (higher === null) return 'unknown';
  }
  if (patterns.includes('doji') || patterns.includes('inside')) return 'stall';
  return 'plain';
}

module.exports = { REACTIONS, DEF, sideOf, isLongWick, reactionOf };
