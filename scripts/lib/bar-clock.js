'use strict';

/**
 * Bar-close clock for the autonomous runner. Bars (get_bars) are timestamped by
 * their open time (`t`); a bar of `minutes` closes at t + minutes. The runner
 * sleeps until the forming bar's close, then polls get_bars (closed bars
 * only) until that bar appears. Bar alignment is learned from the data, not
 * assumed, so 1-, 3-, or 5-minute bars work whatever their anchor.
 *
 * Per-symbol state: { lastBarT, expectedCloseAt, pollingSince }
 */

function barOpenMs(bar) {
  const t = Date.parse(bar && bar.t);
  if (!Number.isFinite(t)) throw new Error(`bar has no valid open time: ${JSON.stringify(bar).slice(0, 80)}`);
  return t;
}

function barCloseMs(bar, minutes) {
  return barOpenMs(bar) + minutes * 60000;
}

/** State after seeing `bars` (closed, oldest first): next close = last closed bar + 2 bars. */
function stateFromBars(bars, minutes) {
  if (!bars.length) return { lastBarT: null, expectedCloseAt: null, pollingSince: null };
  const last = bars[bars.length - 1];
  return { lastBarT: last.t, expectedCloseAt: barOpenMs(last) + 2 * minutes * 60000, pollingSince: null };
}

/**
 * What to do now for one symbol: 'wait' (bar still forming), 'poll' (it should
 * have closed; fetch bars), or 'resync' (no bar arrived within the timeout,
 * e.g. the daily break or a halt; refetch and recompute the schedule).
 */
function barAction(state, now, { delayMs, timeoutMs }) {
  if (!state || state.expectedCloseAt === null) return 'resync';
  const t = now.getTime();
  if (t < state.expectedCloseAt + delayMs) return 'wait';
  if (t > state.expectedCloseAt + delayMs + timeoutMs) return 'resync';
  return 'poll';
}

/**
 * Compare freshly fetched closed bars with the state.
 * Returns { state, bar, stale } where `bar` is the newest closed bar if it is
 * new, and `stale` is true when that bar closed so long ago (a slow previous
 * cycle) that acting on it would be late; stale bars update the schedule but
 * should not start a cycle.
 */
function onBars(state, bars, now, minutes, { staleAfterMs } = {}) {
  if (!bars.length) return { state, bar: null, stale: false };
  const last = bars[bars.length - 1];
  if (state && state.lastBarT && barOpenMs(last) <= Date.parse(state.lastBarT)) {
    return { state, bar: null, stale: false };
  }
  const next = stateFromBars(bars, minutes);
  const limit = staleAfterMs === undefined ? (minutes * 60000) / 2 : staleAfterMs;
  const stale = now.getTime() - barCloseMs(last, minutes) > limit;
  return { state: next, bar: last, stale };
}

/** Milliseconds until any symbol needs attention (bounded so the loop stays responsive). */
function sleepMs(states, now, { delayMs, maxMs = 5000, minMs = 250 }) {
  let soonest = maxMs;
  for (const s of states) {
    if (!s || s.expectedCloseAt === null) return minMs;
    soonest = Math.min(soonest, s.expectedCloseAt + delayMs - now.getTime());
  }
  return Math.max(minMs, Math.min(maxMs, soonest));
}

/** After a resync that found no new bar (daily break, halt), wait one more bar before polling again. */
function rearm(state, now, minutes) {
  const base = state && state.expectedCloseAt !== null ? state : { lastBarT: null, expectedCloseAt: null, pollingSince: null };
  return { ...base, expectedCloseAt: now.getTime() + minutes * 60000 };
}

/**
 * One scheduling step for one symbol. `sym` is { symbol, contractId, clock,
 * lastPollAt }. `fetchBars()` returns closed bars, oldest first.
 * Resolves to { sym, event, bar } where event is one of:
 *   'wait'   bar still forming or polled too recently
 *   'no-bar' polled, the closed bar isn't published yet
 *   'resync' timed out or first run; schedule recomputed, no cycle
 *   'stale'  a new bar, but it closed too long ago to act on
 *   'bar'    a new closed bar: start a cycle
 */
async function barStep(sym, now, opts, fetchBars) {
  const { minutes, delayMs, timeoutMs, pollMs } = opts;
  const action = barAction(sym.clock, now, { delayMs, timeoutMs });
  if (action === 'wait') return { sym, event: 'wait', bar: null };
  // Never poll faster than pollMs, whether waiting for a close or resyncing after errors.
  if (sym.lastPollAt && now.getTime() - sym.lastPollAt < pollMs) return { sym, event: 'wait', bar: null };

  const bars = await fetchBars();
  const polled = { ...sym, lastPollAt: now.getTime() };
  const r = onBars(sym.clock, bars, now, minutes);
  if (!r.bar) {
    if (action === 'resync') {
      // First run (no clock yet) or no bar seen yet: learn alignment from the data if there is any.
      const next = bars.length && !(sym.clock && sym.clock.lastBarT) ? stateFromBars(bars, minutes) : sym.clock;
      const fresh = next && next.expectedCloseAt !== null && next.expectedCloseAt > now.getTime() ? next : rearm(next, now, minutes);
      return { sym: { ...polled, clock: fresh }, event: 'resync', bar: null, bars };
    }
    return { sym: polled, event: 'no-bar', bar: null, bars };
  }
  return { sym: { ...polled, clock: r.state }, event: r.stale ? 'stale' : 'bar', bar: r.bar, bars };
}

module.exports = { barOpenMs, barCloseMs, stateFromBars, barAction, onBars, sleepMs, rearm, barStep };
