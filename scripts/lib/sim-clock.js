'use strict';

/**
 * Simulated wall clock for backtests. The backtester writes the simulated
 * time (ISO) to FTH_SIM_CLOCK_FILE; every harness process that installs this
 * clock (hooks, the MCP gateway, projectx-mcp behind it, the strategy and
 * snapshot CLIs) then sees that time from `new Date()` and `Date.now()`, so
 * sessions, trading days, and journal timestamps all follow the replay.
 *
 * Only active in backtest mode (FTH_BACKTEST=1 with a loopback simulated
 * broker, see paths.backtestMode): a live process never has its clock moved.
 */

const fs = require('fs');
const { backtestMode } = require('./paths');

const RealDate = Date;
const REREAD_MS = 50;

function makeReader(file) {
  let cached = NaN;
  let readAt = -Infinity;
  return () => {
    const real = RealDate.now();
    if (real - readAt >= REREAD_MS) {
      readAt = real;
      try {
        const t = RealDate.parse(fs.readFileSync(file, 'utf8').trim());
        if (Number.isFinite(t)) cached = t;
      } catch (_err) {
        // keep the last good value
      }
    }
    if (!Number.isFinite(cached)) throw new Error(`backtest clock file ${file} is missing or invalid`);
    return cached;
  };
}

/** Replace the global Date with one whose "now" is the simulated time. Returns true when installed. */
function installSimClock(env = process.env) {
  if (!backtestMode(env) || !env.FTH_SIM_CLOCK_FILE) return false;
  if (global.Date.isSimulated) return true;
  const simNow = makeReader(env.FTH_SIM_CLOCK_FILE);
  class SimDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(simNow());
      else super(...args);
    }

    static now() {
      return simNow();
    }
  }
  SimDate.isSimulated = true;
  global.Date = SimDate;
  return true;
}

module.exports = { installSimClock, RealDate };
