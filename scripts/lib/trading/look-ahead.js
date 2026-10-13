'use strict';

/**
 * No look-ahead under a replay clock: a replayed decision sees only bars that
 * had closed by its decision time, as live it could see nothing else. A bar is
 * keyed by its open time (`t`) and closes one bar later (`t` + the bars' step);
 * it is visible at the clock when it closes at or before it.
 *
 * Live (no replay clock) nothing here applies: the callers pass `at` null and
 * the bars are returned unchanged.
 *
 *   stepOf(bars)                         the bars' step in ms (the smallest gap between the last 50), or null
 *   closesAfter(bars, at, { stepMs })    the bars that close after `at` (a Date or ms); [] when `at` is null
 *   cutAtClock(bars, at, { stepMs })     the bars closed by `at` (what a fetch keeps); bars when `at` is null
 *   refuseAfterClock(bars, at, { what, stepMs })   bars, or throws LookAheadError naming the bars after the clock
 *   briefingAfterClock(briefing, at)     why a bar briefing is after the clock (its bar closed after it), or null
 */

const { normalizeBars } = require('./indicators');

class LookAheadError extends Error {}

const listOf = bars => (Array.isArray(bars) ? bars : bars && Array.isArray(bars.bars) ? bars.bars : []);
const openMs = b => (b && typeof b === 'object' ? Date.parse(String(b.t ?? b.time)) : NaN);
const msOf = at => (at === null || at === undefined ? null : at instanceof Date ? at.getTime() : Number(at));

/**
 * The smallest positive gap between the last 50 bars by time, in ms (as the scan names the bars'
 * timeframe), or null. In time order whatever the file's order (a newest-first file has the same step).
 */
function stepOf(bars) {
  const times = normalizeBars(bars).map(b => Date.parse(b.t)).sort((a, b) => a - b).slice(-50);
  const diffs = times.map((t, i) => (i ? t - times[i - 1] : Infinity)).filter(d => d > 0 && Number.isFinite(d));
  return diffs.length ? Math.min(...diffs) : null;
}

/**
 * The bars that close after `at`. A bar's close is its open plus `stepMs` (default: the bars' own
 * step; with no step known, its open: a lone bar opened after the clock is still after it). Bars as
 * an array or get_bars output ({ bars }), each timed by `t` (or `time`); a bar whose time can't be
 * read is no bar to the readers (normalizeBars drops it), so it is not counted.
 */
function closesAfter(bars, at, { stepMs = undefined } = {}) {
  const limit = msOf(at);
  if (limit === null) return [];
  if (!Number.isFinite(limit)) throw new LookAheadError(`the replay clock is not a time (${at})`);
  const step = stepMs === undefined ? stepOf(bars) || 0 : stepMs;
  return listOf(bars).filter(b => {
    const open = openMs(b);
    return Number.isFinite(open) && open + step > limit;
  });
}

/**
 * The bars (an array) shown closed by `at`, in their order: what a fetch at the clock keeps (a bar
 * whose time can't be read is dropped too). Unchanged when `at` is null.
 */
function cutAtClock(bars, at, { stepMs = undefined } = {}) {
  const limit = msOf(at);
  if (limit === null) return bars;
  if (!Number.isFinite(limit)) throw new LookAheadError(`the replay clock is not a time (${at})`);
  const step = stepMs === undefined ? stepOf(bars) || 0 : stepMs;
  return bars.filter(b => openMs(b) + step <= limit);
}

/**
 * The bars, when none closes after the clock; else a refusal that says which and what to do. `what`
 * names the bars in the message (a file, 'the daily bars').
 */
function refuseAfterClock(bars, at, { what = 'the bars', stepMs = undefined } = {}) {
  // Under a clock, bars whose length can't be told (one time only: a lone bar, or duplicates) can't be shown closed.
  if (msOf(at) !== null && stepMs === undefined && stepOf(bars) === null && listOf(bars).some(b => Number.isFinite(openMs(b)))) {
    throw new LookAheadError(`${what}: the bars are all at one time, so when they close can't be told against the replay clock (${new Date(msOf(at)).toISOString()}) (no look-ahead): use the runner's bars file or bars_fetch; not read`);
  }
  const after = closesAfter(bars, at, { stepMs });
  if (!after.length) return bars;
  const step = stepMs === undefined ? stepOf(bars) || 0 : stepMs;
  const first = after[0];
  const last = after[after.length - 1];
  const close = b => new Date(openMs(b) + step).toISOString();
  throw new LookAheadError(`${what}: ${after.length} bar(s) close after the replay clock (${new Date(msOf(at)).toISOString()}), the first at ${close(first)} and the last at ${close(last)}. A replayed decision sees only bars closed by the clock (no look-ahead): use the runner's bars file or bars_fetch, which cut at the clock; not read`);
}

/** Why a bar briefing can't be served at the clock (its bar closed after it), or null (also live: `at` null). */
function briefingAfterClock(b, at) {
  const limit = msOf(at);
  if (limit === null || !b) return null;
  const closed = Date.parse(b.closedAt);
  if (Number.isFinite(closed) && closed <= limit) return null;
  return `its bar closed ${b.closedAt}, after the replay clock (${new Date(limit).toISOString()}): a replayed decision never reads a later bar's briefing`;
}

module.exports = { LookAheadError, stepOf, closesAfter, cutAtClock, refuseAfterClock, briefingAfterClock };
