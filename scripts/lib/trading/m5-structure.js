'use strict';

/**
 * 5m structure (the composed entry's scenario 2): the latest BOS or CHoCH on COMPLETED 5m candles, and the
 * last confirmed 5m swing high and low, as of a bar's close. No 5m lane: the 5m candles are the briefing's own
 * (candle-facts.js completedCandlesAt): from the base bars when they divide 5m (1m, 5m), else from a 1m lane's bars
 * closed by the bar's close, and only while those reach the current 5m candle. Without them (3m bars and no 1m
 * lane, or 1m bars that stopped) it is unavailable, with why, never approximated from other bars.
 *
 * The break is structure-events.js lastBreaks on the 5m candles (a close through the last confirmed, unbroken swing,
 * pivots k = 2; BOS continuing the previous break's direction, CHoCH reversing it): `at` and `swingAt` are candle
 * opens, `knownAt` when the breaking candle was known complete (its close, or the later bar that completed it when its
 * last 1m bar is missing), `barsAgo` in 5m candles. The swings: structure-events.js pivots on the
 * same candles, the last confirmed high and low (confirmed by the candle two after it), with their candle's open.
 *
 *   structure5m({ bars, base, fine, at })   { source, lastBreak: { last, previous }, swingHigh, swingLow } or
 *                                           { unavailable }; as of base bar `at` (default the last): bars after it
 *                                           change nothing
 *   structureLine(s, et)                    the summary's event-driven line (a break at most RECENT candles old), or null
 */

const { completedCandlesAt, completedSeries } = require('./candle-facts');
const { lastBreaks, pivots } = require('./structure-events');

const MINUTES = 5;
// A break is news for this many 5m candles after it (the summary line's window); the JSON holds it longer.
const RECENT = require('../tunables').analysis().structure.m5Recent; // config/analysis.json

function structure5m({ bars, base, fine = null, at = bars.length - 1 }) {
  const c = completedCandlesAt({ bars, base, fine, minutes: MINUTES, at });
  if (c.unavailable) return { unavailable: `${c.unavailable} (never approximated)` };
  const cs = c.candles.slice(0, c.j + 1);
  // When each candle was known complete: the close of the first source bar whose series includes it (its own last bar
  // on the boundary, or a later one when that bar was missing), never the boundary assumed.
  const srcBase = c.src === bars ? base : 1;
  const lastAt = completedSeries(c.src, MINUTES, srcBase).lastAt;
  const knownAt = idx => {
    const k = lastAt.findIndex(x => x >= idx);
    return k >= 0 ? new Date(Date.parse(c.src[k].t) + srcBase * 60000).toISOString() : null;
  };
  const known = x => (x ? { ...x, knownAt: knownAt(cs.findIndex(y => y.t === x.at)) } : null);
  const lb = lastBreaks(cs);
  const ps = pivots(cs);
  const lastOf = type => {
    const p = ps.filter(x => x.type === type).pop();
    return p ? { price: p.price, at: p.t } : null;
  };
  return {
    source: c.src === bars ? `${base}m bars` : '1m bars',
    lastBreak: { last: known(lb.last), previous: known(lb.previous) },
    swingHigh: lastOf('high'),
    swingLow: lastOf('low'),
  };
}

/**
 * The summary's 5m structure line, event-driven: only when the last break is at most RECENT 5m candles old, e.g.
 * `- 5m structure: BOS up through 105 (known 10:45, 0 candles ago); swing high 105, swing low 94.`; or why it is
 * unavailable when 1m bars are configured (they stopped). null otherwise: the JSON holds the rest.
 */
function structureLine(s, et = x => x) {
  if (!s) return null;
  if (s.unavailable) return /no 1m bars configured/.test(s.unavailable) ? null : `- 5m structure: unavailable (${s.unavailable}).`;
  const b = s.lastBreak && s.lastBreak.last;
  if (!b || b.barsAgo > RECENT) return null;
  const swings = [s.swingHigh ? `swing high ${s.swingHigh.price}` : null, s.swingLow ? `swing low ${s.swingLow.price}` : null].filter(Boolean).join(', ');
  return `- 5m structure: ${b.kind} ${b.direction} through ${b.level} (known ${et(b.knownAt)}, ${b.barsAgo} candle${b.barsAgo === 1 ? '' : 's'} ago)${swings ? `; ${swings}` : ''}.`;
}

module.exports = { RECENT, structure5m, structureLine };
