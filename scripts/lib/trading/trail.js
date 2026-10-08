'use strict';

/**
 * Trailing exit for trend-following setups, the same rule live and in the
 * backtest (algoTraderBot's exit_manager.manage_trail, without the PPO
 * policy): hold the initial stop until the trade's best price reaches
 * `trailActivateR`, then keep the stop `trailGivebackR` behind that best
 * price. 1R is the initial stop distance.
 *
 * Called once per closed bar while a trade is open:
 *   - the peak follows the bar's favorable extreme (high for longs, low for
 *     shorts), so intra-bar spikes count;
 *   - the stop only ratchets toward the market, snapped to the tick on the
 *     safe side (down for a long's stop, up for a short's);
 *   - if the same bar's unfavorable extreme already crossed the tightened
 *     stop, the trade closes at market (the bar's close), as algoTraderBot
 *     does: the new stop wasn't resting yet when price went through it.
 */

/** Round a stop to the tick on the safe side: below for a long, above for a short. */
function snapStop(price, sign, tick) {
  const n = price / tick;
  const eps = 1e-9;
  return Math.round((sign > 0 ? Math.floor(n + eps) : Math.ceil(n - eps)) * tick * 1e9) / 1e9;
}

/**
 * @param trade { sign: 1|-1, entry, risk (price), stop, peakR }
 * @param bar { h, l, c }
 * @param plan { trailActivateR, trailGivebackR }
 * @returns { stop, peakR, active, close: null | { price, reason: 'trail' } }
 */
function trailStep(trade, bar, plan, tickSize) {
  const { sign, entry, risk } = trade;
  const fav = sign > 0 ? bar.h : bar.l;
  const peakR = Math.max(trade.peakR || 0, (sign * (fav - entry)) / risk);
  let stop = trade.stop;
  const active = plan.trailActivateR !== null && plan.trailActivateR !== undefined && peakR >= plan.trailActivateR;
  if (active) {
    const cap = entry + sign * (peakR - plan.trailGivebackR) * risk;
    const tightest = sign > 0 ? Math.max(stop, cap) : Math.min(stop, cap);
    const snapped = snapStop(tightest, sign, tickSize);
    stop = sign > 0 ? Math.max(trade.stop, snapped) : Math.min(trade.stop, snapped);
    const unfav = sign > 0 ? bar.l : bar.h;
    if (stop !== trade.stop && (sign > 0 ? unfav <= stop : unfav >= stop)) {
      return { stop, peakR, active, close: { price: bar.c, reason: 'trail' } };
    }
  }
  return { stop, peakR, active, close: null };
}

module.exports = { trailStep, snapStop };
