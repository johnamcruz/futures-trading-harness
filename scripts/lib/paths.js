'use strict';

/**
 * Where the harness keeps its local state (kill switch, gate log, blackouts,
 * runner state, bar files, backtest results). FTH_HOME moves all of it.
 * Default ~/.futures-trading-harness.
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

module.exports = { expandHome, harnessHome };
