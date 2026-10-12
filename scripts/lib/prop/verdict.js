'use strict';

/**
 * The sizing verdict on a policy strategy's setup: which contract (micro or
 * mini), the largest size the attempt's budget allows at the setup's stop
 * (combine.contractPlan, as the backtester and the order gate size it), or a
 * skip with the reason. The runner records it (prop/live-runner.js) and the
 * order gate checks every entry against it (trading/prop-state.js).
 */

const combine = require('../trading/combine');
const { normalizeBars } = require('../trading/indicators');
const { timeframeMs } = require('../trading/evaluator');
const { roundHalfEven } = require('../backtest/engine');
const { legsFor } = require('../trading/prop-state');
const { specFor } = require('../trading/contracts');

/**
 * The plan a setup at the last closed bar of rawBars is sized from: { bars,
 * i, tf, closeAt, stopTicks, plan (fraction -> contractPlan), cp (the
 * full-size plan, or null when no size fits), sizing }.
 */
function setupPlan({ account, cs, strategy, symbol, rawBars, spec, scan, specOf = specFor, selected = null }) {
  const bars = normalizeBars(rawBars);
  const i = bars.length - 1;
  const tf = timeframeMs(strategy.timeframe) || 60000;
  const closeAt = new Date(Date.parse(bars[i].t) + tf);
  const stopTicks = Math.max(1, roundHalfEven(scan.stopDistance / spec.tickSize)); // as the engine
  const z = { ...combine.DEFAULT_SIZING, ...(strategy.sizing || {}) };
  const { legs, ratio, mode } = legsFor(account, symbol, specOf, selected);
  const plan = fraction => combine.contractPlan({
    dollars: combine.budget(cs, z), room: combine.room(cs), stopTicks, legs, mode: mode || strategy.contracts || 'auto', guard: z.min_size_guard, fraction, ratio,
  });
  return { bars, i, tf, closeAt, stopTicks, plan, cp: plan(1), sizing: z };
}

/**
 * The verdict on a setup of a policy strategy at the last closed bar: `full`
 * (contract, maxSize, the stop it was sized for) or `skip` with the reason.
 * scan: the component strategy's scan result (candidate, direction,
 * stopDistance); component: that strategy's name. specOf: root -> tick spec,
 * the broker's live (as the gate sizes); the static table by default.
 */
function decideSetup({ account, cs, strategy, component, symbol, contractId, rawBars, spec, scan, now = new Date(), specOf = specFor, selected = null }) {
  const { bars, i, tf, closeAt, stopTicks, cp, sizing: z } = setupPlan({ account, cs, strategy, symbol, rawBars, spec, scan, specOf, selected });
  const base = {
    at: now.toISOString(), expiresAt: new Date(closeAt.getTime() + tf).toISOString(), strategy: strategy.name, component, symbol, contractId,
    bar: bars[i].t, direction: scan.direction, stopTicks, account: account.name, combine: combine.summary(cs),
  };
  if (!cp) return { ...base, action: 'skip', maxSize: 0, contract: null, reason: combine.entryBlock(cs) || `the size budget ($${combine.budget(cs, z)}) is below one contract at this stop; with a cushion of $${Math.round(combine.cushion(cs))} the attempt can only trade setups with tighter stops` };
  return { ...base, action: 'full', contract: cp.root, maxSize: cp.size, riskPerContract: cp.riskPerContract };
}

module.exports = { setupPlan, decideSetup };
