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
 * opens, `knownAt` the breaking candle's close, `barsAgo` in 5m candles. The swings: structure-events.js pivots on the
 * same candles, the last confirmed high and low (confirmed by the candle two after it), with their candle's open.
 *
 *   structure5m({ bars, base, fine, at })   { source, lastBreak: { last, previous }, swingHigh, swingLow } or
 *                                           { unavailable }; as of base bar `at` (default the last): bars after it
 *                                           change nothing
 */

const { completedCandlesAt } = require('./candle-facts');
const { lastBreaks, pivots } = require('./structure-events');

const MINUTES = 5;
const STEP = MINUTES * 60000;

/** A break with its candle's close as knownAt (null stays null). */
const known = x => (x ? { ...x, knownAt: new Date(Date.parse(x.at) + STEP).toISOString() } : null);

function structure5m({ bars, base, fine = null, at = bars.length - 1 }) {
  const c = completedCandlesAt({ bars, base, fine, minutes: MINUTES, at });
  if (c.unavailable) return { unavailable: `${c.unavailable} (never approximated)` };
  const cs = c.candles.slice(0, c.j + 1);
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

module.exports = { structure5m };
