'use strict';

/**
 * Replay charges the cycle's real latency (the replay config's `latency`, on by default for a learning run: practice,
 * validate, test and final). Live is the reference: a live cycle that takes four minutes places its order four minutes
 * after the bar closed, and its compose record (valid a number of bars after its bar's close) expires on the wall
 * clock. With a pinned replay clock every order went at the bar's own moment, so no record ever expired however long
 * the cycle took. With latency charged:
 *
 *   - each step's replay clock runs with the wall clock from the step's time (FTH_REPLAY_WALL_START, harness-now.js):
 *     the gate, the runner and every tool judge at the decision time plus the time the step has taken;
 *   - the replay broker's clock moves with it: the driver rewrites its clock file (it re-reads the file on every
 *     call; the interface needs nothing new) every `everyMs` while the step runs, so an order goes, and fills, at the
 *     bar plus the cycle's time;
 *   - the clock never goes back (the replay broker refuses that): a decision time the previous step ran past runs at
 *     the clock instead, and a trade time whose next decision time has also been passed runs no step at all (live polls
 *     only the newest closed bar after a long cycle; its runner decides whether that bar is still fresh). Premarket and
 *     end of day are never skipped, only late, as live.
 *
 *   WALL_START                          the variable: the wall time (epoch ms) the step began
 *   latencySetting(raw, learning)       the config's `latency`: { value, error }; unset: on for a learning run
 *   runAt(point, clockMs)               when a decision time runs (ms): its own time, or the clock's when that is later
 *   skippedForLatency(point, next, clockMs)   a trade time the clock has passed whose next decision time it has passed
 *                                       too: no step
 *   readClockMs(file)                   the replay clock file's time (ms), or null (no file, unreadable)
 *   startTicker({ write, atMs, startedMs, wall, everyMs, timers })   writes atMs + (wall() - startedMs) now and every
 *                                       everyMs; stop() writes it once more and returns it (ms)
 */

const fs = require('fs');
const { WALL_START } = require('../trading/harness-now');

const TICK_MS = 1000;

function latencySetting(raw, learning) {
  if (raw === undefined) return { value: learning === true, error: null };
  if (typeof raw !== 'boolean') return { value: false, error: 'latency: true or false (charge each cycle\'s real time on the replay clock; on by default for a learning run)' };
  return { value: raw, error: null };
}

const runAt = (point, clockMs) => (Number.isFinite(clockMs) ? Math.max(point.t.getTime(), clockMs) : point.t.getTime());

const skippedForLatency = (point, next, clockMs) => Boolean(point && point.kind === 'trade' && next && Number.isFinite(clockMs) && next.t.getTime() <= clockMs);

function readClockMs(file) {
  try {
    const ms = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).now);
    return Number.isFinite(ms) ? ms : null;
  } catch (_err) {
    return null;
  }
}

function startTicker({ write, atMs, startedMs, wall = Date.now, everyMs = TICK_MS, timers = { setInterval, clearInterval } }) {
  const at = () => atMs + Math.max(0, wall() - startedMs);
  const tick = () => {
    const ms = at();
    try { write(new Date(ms)); } catch (_err) { /* the next tick writes again; stop() writes the last */ }
    return ms;
  };
  tick();
  const id = timers.setInterval(tick, everyMs);
  if (id && typeof id.unref === 'function') id.unref();
  return {
    stop() {
      timers.clearInterval(id);
      return tick();
    },
  };
}

module.exports = { WALL_START, TICK_MS, latencySetting, runAt, skippedForLatency, readClockMs, startTicker };
