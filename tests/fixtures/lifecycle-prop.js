'use strict';

/**
 * A prop attempt over the scenario-1 world (tests/fixtures/lifecycle.js): the `mini` account (a $2,000 cushion), its
 * attempt started and a fresh snapshot, and a policy strategy, prop_portfolio, whose one component is the shipped
 * trade_lifecycle. Budget: 0.2 x $2,000 = $400. Scenario 1's 111-tick stop plus a tick of expected slippage is
 * 112 x $0.50 = $56.00 + $0.74 fees = $56.74 a micro: 7 MNQ ($397.18; 8 would be $453.92).
 *
 * LC_DOC: the shipped trade_lifecycle ($300 cap: 5 MNQ at this stop; the verdict's 7 is over it).
 *
 *   MINI, policy(extra), registry(policyExtra), propHome(o)   (propHome: the scenario's home with the attempt)
 */

const path = require('path');
const prop = require('../../scripts/lib/trading/prop-state');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { trendHome, TEST_SIZING } = require('../helpers');
const LC = require('./lifecycle');

const NOW = new Date('2026-10-07T14:00:02Z');
const MINI = {
  name: 'mini', valid: true, errors: [], starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod',
  daily_loss_limit: 1000, daily_loss_soft: 500, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50 }, fees_per_side: { MNQ: 0.37 },
};
// The same account with a $1,000 max loss: a $1,000 cushion, a $200 budget, 3 micros at this stop ($56.74 each).
const THIN = { ...MINI, max_loss: 1000 };
const policy = (extra = {}) => ({
  name: 'prop_portfolio', valid: true, errors: [], status: 'active', instruments: ['MNQ', 'NQ'], signal: 'policy', compiledRules: null,
  strategies: ['trade_lifecycle'], account: 'mini', contracts: 'micro', timeframe: '3m', risk: { stop: 'strategy', min_rr: 2 }, sizing: TEST_SIZING, ...extra,
});
const SHIPPED = loadStrategies(path.resolve(__dirname, '..', '..'), {}).strategies.find(s => s.name === 'trade_lifecycle');
const LC_DOC = SHIPPED;
const registry = (extra = {}) => [policy(extra), LC_DOC];

function propHome(o = {}) {
  const home = trendHome();
  const account = o.account || MINI;
  prop.startAttempt(home, account, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, account, o.balance || 50000, new Date(NOW.getTime() - 60000));
  const rec = LC.writeScenario(home, o);
  return { home, rec };
}

module.exports = { NOW, MINI, THIN, policy, registry, SHIPPED, LC_DOC, propHome };
