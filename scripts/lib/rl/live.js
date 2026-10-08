'use strict';

/**
 * Live policy decisions: the observation the policy was trained on, built
 * from the runner's bars (rl/observation.js, the same function as training),
 * and the verdict the order gate checks (trading/prop-state.js).
 */

const combine = require('../trading/combine');
const ind = require('../trading/indicators');
const { buildObservation } = require('./observation');
const { timeframeMs } = require('../trading/evaluator');
const { roundHalfEven } = require('../backtest/engine');
const state = require('../trading/prop-state');

/** The bars as the env sees them: normalized, with the policy's market features. */
function liveBook(rawBars, spec) {
  const bars = ind.normalizeBars(rawBars);
  return { bars, tickSize: spec.tickSize, tickValue: spec.tickValue, feats: { atr20: ind.atr(bars, 20), atr100: ind.atr(bars, 100), adx: ind.adx(bars, 14) } };
}

/**
 * The verdict on a setup of a policy strategy at the last closed bar: which
 * contract (micro or mini), the largest size, and the stop it was sized for.
 * scan: the component strategy's scan result (candidate, direction,
 * stopDistance); component: that strategy's name. bundle: the trained policy,
 * or null to take every setup as sized. The order gate checks the verdict.
 */
function decideSetup({ bundle, account, cs, strategy, component, symbol, contractId, rawBars, spec, scan, now = new Date() }) {
  const book = liveBook(rawBars, spec);
  const i = book.bars.length - 1;
  const tf = timeframeMs(strategy.timeframe) || 60000;
  const closeAt = new Date(Date.parse(book.bars[i].t) + tf);
  const stopTicks = Math.max(1, roundHalfEven(scan.stopDistance / spec.tickSize)); // as the engine
  const z = { ...combine.DEFAULT_SIZING, ...(strategy.sizing || {}) };
  const { legs, ratio, mode } = state.legsFor(account, symbol);
  const plan = fraction => combine.contractPlan({
    dollars: combine.budget(cs, z), room: combine.room(cs), stopTicks, legs, mode: mode || strategy.contracts || 'auto', guard: z.min_size_guard, fraction, ratio,
  });
  const base = {
    at: now.toISOString(), expiresAt: new Date(closeAt.getTime() + tf).toISOString(), strategy: strategy.name, component, symbol, contractId,
    bar: book.bars[i].t, direction: scan.direction, stopTicks, account: account.name, combine: combine.summary(cs), policy: bundle ? bundle.meta.name : null,
  };
  let cp = plan(1);
  if (!cp) return { ...base, action: 'skip', maxSize: 0, contract: null, reason: combine.entryBlock(cs) || 'the size budget is below one contract' };
  const mini = Boolean(legs.mini && cp.root === legs.mini.root);
  const sign = scan.direction === 'long' ? 1 : -1;
  const obs = buildObservation({
    cs, account, book, i, closeAt, components: strategy.strategies,
    setup: { sign, stopTicks, size: cp.size, riskUsd: cp.size * cp.riskPerContract, mini, strategy: component },
  });
  const action = bundle ? bundle.decide('setup', obs) : 'full';
  if (action === 'half') cp = plan(0.5);
  if (action === 'skip' || !cp) return { ...base, action: 'skip', maxSize: 0, contract: null, reason: action === 'skip' ? 'the policy' : 'no half size fits' };
  return { ...base, action, contract: cp.root, maxSize: cp.size, riskPerContract: cp.riskPerContract };
}

/**
 * hold / close for an open trade past its ratchet. pos: { sign, entry, risk
 * (price), size, contract, component, peakR, troughR, barsHeld }.
 */
function decidePosition({ bundle, account, cs, strategy, rawBars, spec, pos }) {
  const book = liveBook(rawBars, spec);
  const i = book.bars.length - 1;
  const closeAt = new Date(Date.parse(book.bars[i].t) + (timeframeMs(strategy.timeframe) || 60000));
  const leg = state.legOf(account, pos.contract);
  const { legs } = state.legsFor(account, pos.contract);
  const p = { ...pos, tickValue: leg ? leg.tickValue : spec.tickValue, mini: Boolean(legs.mini && legs.mini.root === pos.contract), strategy: pos.component };
  return bundle.decide('position', buildObservation({ cs, account, book, i, closeAt, components: strategy.strategies, pos: p }));
}

module.exports = { ...state, liveBook, decideSetup, decidePosition };
