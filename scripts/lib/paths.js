'use strict';

/**
 * Where the harness keeps its local state (kill switch, gate log, blackouts,
 * runner state, bar files). FTH_HOME moves all of it, which is how a backtest
 * runs fully isolated from live state. Default ~/.futures-trading-harness.
 */

const os = require('os');
const path = require('path');

function expandHome(p, home = os.homedir()) {
  if (p === '~') return home;
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

function harnessHome(env = process.env, home = os.homedir()) {
  const configured = String(env.FTH_HOME || '').trim();
  return configured ? path.resolve(expandHome(configured, home)) : path.join(home, '.futures-trading-harness');
}

/** True for a URL on this machine (the backtest broker only ever listens on loopback). */
function isLoopbackUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch (_err) {
    return false;
  }
}

/**
 * Backtest mode: FTH_BACKTEST=1 and a loopback simulated broker URL. Anything
 * less is not a backtest, so a stray FTH_BACKTEST can't shift a live clock.
 */
function backtestMode(env = process.env) {
  return env.FTH_BACKTEST === '1' && isLoopbackUrl(String(env.FTH_SIM_API_URL || ''));
}

module.exports = { expandHome, harnessHome, isLoopbackUrl, backtestMode };
