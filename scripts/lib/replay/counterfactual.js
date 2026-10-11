'use strict';

/**
 * Counterfactual outcomes for the labels (labels.js): what a strategy's own
 * trade would have done at a candidate the teacher didn't take (a skipped
 * setup, or one fired on a bar no cycle ran on), and the same fields from the
 * real fills of a trade it did take, so RL can tell a skilful skip (a loser
 * avoided) from an overly cautious one (a winner missed).
 *
 * The simulation is the backtester's (backtest/engine.js), through the same
 * simulated broker (backtest/sim-broker.js) and exit plan (evaluator.js
 * exitPlan), on the replay's bars:
 *   - entry: a market order at the next bar's open after the signal bar plus
 *     one tick of slippage (fill: next-open), dropped (`expired`) when that
 *     bar opens through the stop or a target level, or falls in another
 *     trading day or at or after end of day;
 *   - stop: the scan's `stopDistance`, rounded as the skills round a bracket
 *     (ceil to ticks: never tighter than the strategy's distance);
 *   - target: `exit.target_r` (or `risk.min_rr`) x the stop distance, floored
 *     to ticks (a target rounds toward the entry), from the fill; an
 *     `exit.target` level is the signal bar's close plus the scan's
 *     `targetDistance` (floored to ticks), refused under `risk.min_rr`;
 *     trailing exits (`trail_activate_r`, `trail_giveback_r`) and `max_bars`
 *     run as the backtester runs them (trail.js through the simulated broker);
 *   - each bar: the stop is checked before the target, so a bar reaching both
 *     is a loss (conservative); at the bar's close the trail and time stop,
 *     then end of day: a bar closing at or after the day's end of day exits
 *     at its close (`eod`), as the runner flattens. exitTime is the close of
 *     the bar the trade exited in.
 * A candidate that can't be simulated (no strategy file, a manual strategy, no
 * stop distance, an exit.target without a distance, no bars after the signal
 * or bars ending before the exit) is `simulated: false` with the reason.
 *
 *   simulate({ bars, tfMs, signalMs, signalClose, direction, stopDistance, targetDistance, strategy, spec, eodMs })
 *   fromFills(outcome, { stopPoints, targetTicks, spec, bars, tfMs })    a taken trade's same fields
 */

const { exitPlan } = require('../trading/evaluator');
const { createSimBroker, onTick } = require('../backtest/sim-broker');
const { tradingDayKey } = require('../trading/clock');

const SLIPPAGE_TICKS = 1; // the backtester's default per market fill
const round = (x, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const resultOf = net => (net > 0 ? 'win' : net < 0 ? 'loss' : 'scratch');

function unsimulated(base, reason) {
  return { ...base, entry: null, stop: null, target: null, exitTime: null, exitPrice: null, exitReason: null, R: null, pnl: null, net: null, maeR: null, mfeR: null, result: null, simulated: false, reason };
}

/** First index with ms >= t. */
function lowerBound(bars, t) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].ms < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * @param bars the timeframe's bars, sorted, each with ms (open time)
 * @param signalMs the signal bar's open time; signalClose its close
 * @param spec { tickSize, tickValue, feesPerSide }
 * @param eodMs the signal's trading day's end of day (a bar closing at or after it is flattened)
 */
function simulate({ bars, tfMs, signalMs, signalClose, direction, stopDistance, targetDistance = null, strategy, spec, eodMs }) {
  const base = { strategy: strategy ? strategy.name : null, direction, source: 'simulated' };
  if (!strategy) return unsimulated(base, 'strategy not found');
  if (strategy.signal === 'manual') return unsimulated(base, 'manual strategy');
  if (!spec || !(spec.tickSize > 0)) return unsimulated(base, 'no contract spec');
  if (!(stopDistance > 0)) return unsimulated(base, 'no stop distance');
  const tick = spec.tickSize;
  const sign = direction === 'long' ? 1 : direction === 'short' ? -1 : 0;
  if (!sign) return unsimulated(base, 'no direction');
  const plan = exitPlan(strategy);
  const stopTicks = Math.max(1, Math.ceil(stopDistance / tick - 1e-9));
  const risk = onTick(stopTicks * tick, tick);
  let target = null;
  if (plan.targetR) target = { ticks: Math.max(1, Math.floor((plan.targetR * stopDistance) / tick + 1e-9)) };
  else if (plan.target) {
    if (!(targetDistance > 0) || !Number.isFinite(signalClose)) return unsimulated(base, 'no target distance');
    target = { price: onTick(signalClose + sign * Math.floor(targetDistance / tick + 1e-9) * tick, tick) };
  }
  const i = lowerBound(bars, signalMs + tfMs);
  if (i >= bars.length) return unsimulated(base, 'no bars after the signal');
  const broker = createSimBroker({ tickSize: tick, slippageTicks: SLIPPAGE_TICKS });
  const fee = Number(spec.feesPerSide) || 0;
  const minRR = plan.target && !plan.targetR ? (strategy.risk && strategy.risk.min_rr) || 0 : 0;
  const pos = broker.submitMarket({ sign, risk, size: 1, tickValue: spec.tickValue, fee, plan, target, minRR }, { price: signalClose, fill: 'next-open' });
  const expired = why => ({ ...base, entry: null, stop: null, target: null, exitTime: null, exitPrice: null, exitReason: 'expired', R: null, pnl: null, net: null, maeR: null, mfeR: null, result: 'no-trade', simulated: true, reason: why });
  if (!pos) return expired('the target level leaves no trade');
  const day = tradingDayKey(new Date(signalMs + tfMs));
  const first = bars[i];
  if (tradingDayKey(new Date(first.ms)) !== day || first.ms + tfMs >= eodMs) return expired('the next bar is past end of day');
  if (!broker.fillAtOpen(first)) return expired('the next bar opened through the stop or the target');
  const p = broker.position;
  let done = null;
  let exitBar = null;
  let last = null;
  for (let j = i; j < bars.length; j += 1) {
    const bar = bars[j];
    // Nothing is carried into another trading day: closed at the last bar's close.
    if (tradingDayKey(new Date(bar.ms)) !== day) { done = broker.exit(last.c, 'eod'); exitBar = last; break; }
    done = broker.onBar(bar) || broker.manage(bar) || (bar.ms + tfMs >= eodMs ? broker.exit(bar.c, 'eod') : null);
    last = bar;
    if (done) { exitBar = bar; break; }
  }
  if (!done) return unsimulated(base, 'the bars end before the exit');
  const R = (sign * (done.price - p.entry)) / p.risk;
  return {
    ...base, entry: p.entry, stop: p.initialStop, target: p.target, exitTime: new Date(exitBar.ms + tfMs).toISOString(), exitPrice: done.price,
    exitReason: done.reason, R: round(R), pnl: round(done.gross, 2), net: round(done.net, 2),
    maeR: round(p.troughR), mfeR: round(p.peakR), result: resultOf(done.net), simulated: true, reason: null,
  };
}

/** A taken trade's counterfactual fields from its real fills (MAE/MFE from the bars when the broker sends none). */
function fromFills(outcome, { stopPoints = null, targetTicks = null, spec = null, bars = [], tfMs = 0, strategy = null, direction = null } = {}) {
  const base = { strategy, direction, source: 'fills' };
  if (!outcome || !outcome.filled || outcome.entryPrice === null) return unsimulated(base, outcome && outcome.result === 'refused' ? 'refused' : 'not filled');
  const sign = outcome.side === 'buy' ? 1 : -1;
  const tick = spec ? spec.tickSize : null;
  const stop = stopPoints && tick ? onTick(outcome.entryPrice - sign * stopPoints, tick) : null;
  const target = targetTicks && tick ? onTick(outcome.entryPrice + sign * targetTicks * tick, tick) : null;
  const size = outcome.size || 1;
  let { maeR, mfeR } = outcome;
  if ((maeR === null || mfeR === null) && stopPoints && outcome.exitTime && bars.length) {
    const from = Date.parse(outcome.entryTime);
    const to = Date.parse(outcome.exitTime);
    const span = bars.filter(b => b.ms + tfMs > from && b.ms < to);
    if (span.length) {
      const fav = Math.max(...span.map(b => sign * ((sign > 0 ? b.h : b.l) - outcome.entryPrice)));
      const adv = Math.min(...span.map(b => sign * ((sign > 0 ? b.l : b.h) - outcome.entryPrice)));
      if (mfeR === null) mfeR = round(Math.max(0, fav) / stopPoints);
      if (maeR === null) maeR = round(Math.min(0, adv) / stopPoints);
    }
  }
  const closed = outcome.exitTime !== null && outcome.result !== 'open';
  return {
    ...base, entry: outcome.entryPrice, stop, target, exitTime: outcome.exitTime, exitPrice: outcome.exitPrice,
    exitReason: closed ? outcome.exitReason || 'closed' : null, R: outcome.r,
    pnl: closed ? round(outcome.pnl / size, 2) : null, net: closed ? round(outcome.net / size, 2) : null,
    maeR, mfeR, result: closed ? outcome.result : 'open', simulated: false, reason: null,
  };
}

module.exports = { simulate, fromFills, SLIPPAGE_TICKS };
