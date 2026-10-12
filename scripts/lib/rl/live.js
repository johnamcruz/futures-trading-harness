'use strict';

/**
 * Live policy decisions: the observation the policy was trained on, built
 * from the runner's bars (rl/observation.js, the same function as training),
 * and the verdict the order gate checks (trading/prop-state.js).
 */

const combine = require('../trading/combine');
const ind = require('../trading/indicators');
const { buildObservation, marketFeatures, confluence } = require('./observation');
const { timeframeMs } = require('../trading/evaluator');
const { roundHalfEven } = require('../backtest/engine');
const state = require('../trading/prop-state');
const { specFor } = require('../trading/contracts');

/** The bars as the env sees them: normalized, with the policy's market features. */
function liveBook(rawBars, spec, params = {}) {
  const bars = ind.normalizeBars(rawBars);
  return { bars, tickSize: spec.tickSize, tickValue: spec.tickValue, feats: marketFeatures(bars, params) };
}

/**
 * The observation at a setup of a policy strategy at the last closed bar of
 * rawBars, and the plan it is sized from: { book, i, tf, closeAt, stopTicks,
 * plan (fraction -> contractPlan), cp (the full-size plan, or null when no
 * size fits), obs (null when no size fits), sizing }. decideSetup asks the
 * policy with it, and the label dataset (rl/label-dataset.js) builds the
 * student's rows with it, so training reads what live reads.
 */
function setupObservation({ account, cs, strategy, component, symbol, rawBars, spec, scan, results = [], specOf = specFor }) {
  const book = liveBook(rawBars, spec, strategy.params);
  const i = book.bars.length - 1;
  const tf = timeframeMs(strategy.timeframe) || 60000;
  const closeAt = new Date(Date.parse(book.bars[i].t) + tf);
  const stopTicks = Math.max(1, roundHalfEven(scan.stopDistance / spec.tickSize)); // as the engine
  const z = { ...combine.DEFAULT_SIZING, ...(strategy.sizing || {}) };
  const { legs, ratio, mode } = state.legsFor(account, symbol, specOf);
  const plan = fraction => combine.contractPlan({
    dollars: combine.budget(cs, z), room: combine.room(cs), stopTicks, legs, mode: mode || strategy.contracts || 'auto', guard: z.min_size_guard, fraction, ratio,
  });
  const cp = plan(1);
  if (!cp) return { book, i, tf, closeAt, stopTicks, plan, cp: null, obs: null, sizing: z };
  const mini = Boolean(legs.mini && cp.root === legs.mini.root);
  const sign = scan.direction === 'long' ? 1 : -1;
  const obs = buildObservation({
    cs, account, book, i, closeAt, components: strategy.strategies,
    // Confluence from the same bar's scan of the policy strategy's other strategies (as the engine counts it).
    setup: { sign, stopTicks, size: cp.size, riskUsd: cp.size * cp.riskPerContract, mini, strategy: component, confluence: confluence(results.filter(r => strategy.strategies.includes(r.name)), component, sign) },
  });
  return { book, i, tf, closeAt, stopTicks, plan, cp, obs, sizing: z };
}

/**
 * The verdict on a setup of a policy strategy at the last closed bar: which
 * contract (micro or mini), the largest size, and the stop it was sized for.
 * scan: the component strategy's scan result (candidate, direction,
 * stopDistance); component: that strategy's name. bundle: the trained policy,
 * or null to take every setup as sized. The order gate checks the verdict.
 * specOf: root -> tick spec, the broker's live (as the gate sizes); the static table by default.
 */
function decideSetup({ bundle, account, cs, strategy, component, symbol, contractId, rawBars, spec, scan, results = [], now = new Date(), specOf = specFor }) {
  const { book, i, tf, closeAt, stopTicks, plan, cp: full, obs, sizing: z } = setupObservation({ account, cs, strategy, component, symbol, rawBars, spec, scan, results, specOf });
  const base = {
    at: now.toISOString(), expiresAt: new Date(closeAt.getTime() + tf).toISOString(), strategy: strategy.name, component, symbol, contractId,
    bar: book.bars[i].t, direction: scan.direction, stopTicks, account: account.name, combine: combine.summary(cs), policy: bundle ? bundle.meta.name : null,
  };
  let cp = full;
  if (!cp) return { ...base, action: 'skip', maxSize: 0, contract: null, reason: combine.entryBlock(cs) || `the size budget ($${combine.budget(cs, z)}) is below one contract at this stop; with a cushion of $${Math.round(combine.cushion(cs))} the attempt can only trade setups with tighter stops` };
  const action = bundle ? bundle.decide('setup', obs) : 'full';
  if (action === 'half') cp = plan(0.5);
  if (action === 'skip' || !cp) return { ...base, action: 'skip', maxSize: 0, contract: null, reason: action === 'skip' ? 'the policy' : 'no half size fits' };
  return { ...base, action, contract: cp.root, maxSize: cp.size, riskPerContract: cp.riskPerContract };
}

/**
 * The observation in an open trade at the last closed bar of rawBars (the one
 * decidePosition asks the policy with; the label dataset's too). pos: { sign,
 * entry, risk (price), size, contract, component, peakR, troughR, barsHeld }.
 */
function positionObservation({ account, cs, strategy, rawBars, spec, pos, specOf = specFor }) {
  const book = liveBook(rawBars, spec, strategy.params);
  const i = book.bars.length - 1;
  const closeAt = new Date(Date.parse(book.bars[i].t) + (timeframeMs(strategy.timeframe) || 60000));
  const leg = state.legOf(account, pos.contract, specOf);
  const { legs } = state.legsFor(account, pos.contract, specOf);
  const p = { ...pos, tickValue: leg ? leg.tickValue : spec.tickValue, mini: Boolean(legs.mini && legs.mini.root === pos.contract), strategy: pos.component };
  return buildObservation({ cs, account, book, i, closeAt, components: strategy.strategies, pos: p });
}

/** hold / close for an open trade past its ratchet: the policy on positionObservation. */
function decidePosition({ bundle, ...args }) {
  return bundle.decide('position', positionObservation(args));
}

module.exports = { ...state, liveBook, setupObservation, decideSetup, positionObservation, decidePosition };
