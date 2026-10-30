'use strict';

/**
 * The base timeframe's timing against the higher-timeframe side (the owner: "Ideally timing is when the 3m starts to
 * align with the trend, by a trend change"): a briefing fact, read by the htf-to-ltf and pullback-vs-reversal skills as
 * evidence in the count, never a veto. Pure: computed from the closed base bars the briefing is built on (causal) and
 * the facts beside them, with the reads' own machinery, never a copy of it: the 4h and 1h trends (the h1 section's,
 * mtf.js), the base regime (regime.js, m3.regime.primary), the base structure breaks (structure-events.js breaksOf) and
 * the base timeframe's compression break (compression.js, m3.compression).
 *
 * The side: the one the 4h and the 1h both trend (the policy's bias_agree: both up a long, both down a short); none
 * when they don't agree (then no timing: no side to time). Its state, first that holds:
 *
 *   with      the base regime trends the side's way (trend-up for a long)
 *   turned    the latest base event the side's way (a BOS or CHoCH its way, or the base compression break its way)
 *             closed after the latest base break against it: the turn back, with its kind, direction, time and age
 *   pullback  otherwise: the base structure points against the side; `since` the latest break against it (none known:
 *             null)
 *
 *   timingOf({ trends, regime, bars, minutes, breaks, compression })   { side, state, kind?, dir?, at?, barsAgo?, since? }
 *                                              or null (no agreed side, or no bars)
 *   timingLine(timing, et, tf)                 the summary's line, or null
 */

const WAY = { long: 'up', short: 'down' };

/** The side the 4h and 1h agree on, or null. */
function sideOf(trends) {
  const t = trends || {};
  if (t['4h'] === 'up' && t['1h'] === 'up') return 'long';
  if (t['4h'] === 'down' && t['1h'] === 'down') return 'short';
  return null;
}

function timingOf({ trends, regime = null, bars = [], minutes, breaks = [], compression = null } = {}) {
  const side = sideOf(trends);
  if (!side || !Array.isArray(bars) || !bars.length || !(minutes > 0)) return null;
  const way = WAY[side];
  const step = minutes * 60000;
  const lastI = bars.length - 1;
  if (regime === `trend-${way}`) return { side, state: 'with' };
  const closeOf = b => Date.parse(b.at) + step;
  const against = [...breaks].reverse().find(b => b.direction !== way) || null;
  const withBreak = [...breaks].reverse().find(b => b.direction === way) || null;
  // The base compression break its way (m3.compression[<base>].break): an event too, at its candle's close.
  const cb = compression && compression.break && compression.break.dir === way ? compression.break : null;
  const events = [
    ...(withBreak ? [{ kind: withBreak.kind, dir: way, closeMs: closeOf(withBreak), barsAgo: lastI - withBreak.i }] : []),
    ...(cb && Number.isFinite(Date.parse(cb.closedAt)) ? [{ kind: 'compression break', dir: way, closeMs: Date.parse(cb.closedAt), barsAgo: Number.isInteger(cb.barsAgo) ? cb.barsAgo : null }] : []),
  ].sort((a, b) => b.closeMs - a.closeMs);
  const turn = events[0] || null;
  if (turn && (!against || turn.closeMs > closeOf(against))) {
    return { side, state: 'turned', kind: turn.kind, dir: turn.dir, at: new Date(turn.closeMs - step).toISOString(), barsAgo: turn.barsAgo };
  }
  return { side, state: 'pullback', since: against ? against.at : null };
}

/** The summary's line: "- 3m timing (long, the 4h and 1h up): ..." or null. */
function timingLine(t, et, tf) {
  if (!t) return null;
  const head = `- ${tf} timing (${t.side}: the 4h and 1h ${WAY[t.side]}):`;
  if (t.state === 'with') return `${head} ${tf} with the HTF side.`;
  if (t.state === 'turned') return `${head} ${tf} turned back: ${t.kind} ${t.dir} at ${et(t.at)} ET${Number.isInteger(t.barsAgo) ? ` (${t.barsAgo} bars ago)` : ''}.`;
  return `${head} ${tf} pullback: trending against the HTF side${t.since ? ` since ${et(t.since)} ET` : ''}.`;
}

module.exports = { timingOf, timingLine, sideOf };
