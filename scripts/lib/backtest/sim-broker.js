'use strict';

/**
 * The simulated broker: one market's position against historical bars, the
 * fill model the backtester (engine.js) drives bar by bar and the replay
 * runner will share. Pure: no clock, no account, no I/O; the caller decides
 * when to enter, cancel, or exit, and what a forced exit (a prop floor) is.
 *
 * Fill rules:
 *   - a market entry fills at the next bar's open plus `slippageTicks`
 *     (`fill: 'next-open'`, live latency) or at the signal bar's close plus
 *     slippage (`fill: 'close'`); its stop keeps the order's distance (`risk`)
 *     from the fill. A next-open fill at or through the stop the signal had,
 *     or one leaving a target level less than a tick (or under `minRR`) of
 *     reward, is no trade: the entry is dropped;
 *   - against each later bar the resting stop is checked first (a bar
 *     reaching both stop and target is a loss): it fills at the stop, or at
 *     the bar's open when the bar gapped through it, less slippage; the
 *     target fills at its price, or at a better open, with no slippage;
 *   - a plan that trails past its target (`plan.afterTarget`, exit mode
 *     target_then_trail) never fills the target: at the close of the bar that
 *     reached it, and every bar after, exit-trail.js moves the stop (the lock,
 *     then the swing or R trail) toward the market only;
 *   - at the bar's close the trail (trail.js) moves the stop toward the
 *     market only (a bar already through the new stop closes at the bar's
 *     close), then the time stop (`plan.maxBars`, bars held) closes at the
 *     close; anything else (end of day, the end of the data) is `exit(price, reason)`;
 *   - P&L: ticks x tick value x size, less fees per side on both sides.
 *
 * API (one broker per market, one position at a time):
 *   const b = createSimBroker({ tickSize, slippageTicks })
 *   b.position                      the position (pending or open) or null;
 *                                   a plain object, the order's extra keys kept
 *   b.submitMarket(order, { price, fill })  -> position | null (refused)
 *   b.fillAtOpen(bar)               a pending entry fills at bar.o -> position | null (dropped)
 *   b.cancel()                      drop a pending entry (or forget the position)
 *   b.onBar(bar, { guard })         settle the open position against the bar -> exit | null
 *   b.manage(bar, { swing })        at the bar's close: trail step (swing: the structure trail's level now), time stop -> exit | null
 *   b.exit(price, reason)           close at a price -> exit
 *   b.netAt(price), b.priceForNet(net)   open net P&L at a price, and its inverse
 * exit: { position, price, reason, gross, fees, net }
 *
 * Resting limit/stop entry orders would be another `submit*` that leaves the
 * position pending with its own trigger, checked in `fillAtOpen`/`onBar`.
 */

const { trailStep } = require('../trading/trail');
const { afterTargetStep } = require('../trading/exit-trail');

/** A price on the tick grid, free of float noise (2045.1 - 0.2 is 2044.9, not 2044.8999999999999). */
const onTick = (x, tick) => Math.round(Math.round(x / tick) * tick * 1e9) / 1e9;

/**
 * @param tickSize price increment
 * @param slippageTicks per market fill (entries and stops), in ticks
 */
function createSimBroker({ tickSize, slippageTicks = 1 }) {
  const slip = slippageTicks * tickSize;
  const tick = x => onTick(x, tickSize);
  // A target level closer than a tick to the fill, or under the order's min reward:risk, leaves no trade.
  const levelTooClose = (p, target, entry) => p.sign * (target - entry) < tickSize - 1e-9
    || (p.minRR > 0 && p.sign * (target - entry) < p.minRR * p.risk - 1e-9);
  const perPoint = p => (p.tickValue / tickSize) * p.size;

  const b = {
    position: null,

    /**
     * A market entry with its protective stop and optional target.
     * @param order { sign: 1|-1, risk (stop distance, price), size, tickValue, fee (per contract per side),
     *   plan: { trailActivateR, trailGivebackR, maxBars }, target: null | { ticks } (from the fill) | { price } (a level),
     *   minRR (a level target's minimum reward:risk; 0 = none), ...anything else, kept on the position }
     * @param ref { price: the signal bar's close, fill: 'next-open' (default) | 'close' }
     * @returns the position (pending for next-open), or null when a target level leaves no trade
     */
    submitMarket(order, { price, fill = 'next-open' }) {
      const { sign, risk, target: want, minRR = 0, ...rest } = order;
      const entry = tick(price + sign * slip);
      const stop = tick(entry - sign * risk);
      const target = !want ? null
        : want.ticks !== undefined ? tick(entry + sign * want.ticks * tickSize)
          : want.price === null || want.price === undefined ? null : want.price;
      const p = { ...rest, sign, entry, risk, stop, initialStop: stop, target, minRR, peakR: 0, troughR: 0, barsHeld: 0 };
      if (want && want.ticks === undefined && (target === null || levelTooClose(p, target, entry))) return null;
      if (fill === 'next-open') {
        // The stop keeps its distance from the fill; a fill at or through the signal's stop means the setup is gone.
        Object.assign(p, {
          pending: true,
          signalStop: stop,
          targetFrom: !want ? null : want.ticks !== undefined ? 'entry' : 'level',
          targetTicks: want && want.ticks !== undefined ? Math.round((target - entry) * sign / tickSize) : null,
        });
      }
      b.position = p;
      return p;
    },

    /** A pending market entry fills at this bar's open plus slippage, or is dropped (gap through its stop, target level gone). */
    fillAtOpen(bar) {
      const q = b.position;
      if (!q || !q.pending) return null;
      const entry = tick(bar.o + q.sign * slip);
      const stop = tick(entry - q.sign * q.risk);
      const target = q.targetFrom === 'entry' ? tick(entry + q.sign * q.targetTicks * tickSize) : q.target;
      if (q.sign * (entry - q.signalStop) <= 0 || (q.targetFrom === 'level' && levelTooClose(q, target, entry))) {
        b.position = null;
        return null;
      }
      Object.assign(q, { pending: false, entry, stop, initialStop: stop, target });
      return q;
    },

    cancel() {
      b.position = null;
    },

    /**
     * The resting stop and target against a bar after the fill: stop first. `guard(worst, position)` may
     * force an exit first ({ price, reason }), given the worst price the trade sees in the bar (its stop
     * fill or the bar's extreme), as a prop account's floor does.
     */
    onBar(bar, { guard = null } = {}) {
      const p = b.position;
      if (!p || p.pending) return null;
      const long = p.sign > 0;
      const stopHit = long ? bar.l <= p.stop : bar.h >= p.stop;
      const targetHit = p.target !== null && (long ? bar.h >= p.target : bar.l <= p.target);
      p.peakR = Math.max(p.peakR, (p.sign * ((long ? bar.h : bar.l) - p.entry)) / p.risk);
      const stopFill = stopHit ? tick((long ? Math.min(bar.o, p.stop) : Math.max(bar.o, p.stop)) - p.sign * slip) : null;
      const worst = stopHit ? stopFill : (long ? bar.l : bar.h);
      const trough = (p.sign * (worst - p.entry)) / p.risk;
      // Each deeper trough in ticks, in order (the evaluator's guard replays the floor and daily limit on it).
      if (p.troughPath && trough < p.troughR) p.troughPath.push(Math.round((p.sign * (worst - p.entry)) / tickSize * 1e6) / 1e6);
      p.troughR = Math.min(p.troughR, trough);
      const forced = guard ? guard(worst, p) : null;
      if (forced) return b.exit(forced.price, forced.reason);
      if (stopHit) return b.exit(stopFill, p.stop === p.initialStop ? 'stop' : 'trail');
      if (targetHit && !(p.plan && p.plan.afterTarget)) return b.exit(long ? Math.max(bar.o, p.target) : Math.min(bar.o, p.target), 'target');
      p.barsHeld += 1;
      return null;
    },

    /** At the bar's close: the trail moves the stop (toward the market only), then the time stop. */
    manage(bar, { swing = null } = {}) {
      const q = b.position;
      if (!q || q.pending) return null;
      if (q.plan.afterTarget) {
        const at = afterTargetStep(q, bar, q.plan, tickSize, swing);
        Object.assign(q, { stop: tick(at.stop), peakR: at.peakR, armed: at.armed });
        if (at.close) return b.exit(at.close.price, 'trail');
        if (q.plan.maxBars && q.barsHeld >= q.plan.maxBars) return b.exit(bar.c, 'max_bars');
        return null;
      }
      const step = trailStep(q, bar, q.plan, tickSize);
      q.stop = tick(step.stop);
      q.peakR = step.peakR;
      if (step.close) return b.exit(step.close.price, 'trail');
      if (q.plan.maxBars && q.barsHeld >= q.plan.maxBars) return b.exit(bar.c, 'max_bars');
      return null;
    },

    /** Close the position at `price`: P&L in ticks x tick value x size, fees on both sides. */
    exit(price, reason) {
      const p = b.position;
      const ticks = Math.round((p.sign * (price - p.entry)) / tickSize * 1e6) / 1e6;
      const gross = ticks * p.tickValue * p.size;
      const fees = 2 * p.fee * p.size;
      b.position = null;
      return { position: p, price, reason, gross, fees, net: gross - fees };
    },

    /** The open position's net P&L (after both sides' fees) at a price. */
    netAt(price) {
      const p = b.position;
      return p.sign * (price - p.entry) * perPoint(p) - 2 * p.fee * p.size;
    },

    /** The price at which the open position's net P&L equals `net`, rounded to the tick against the trade. */
    priceForNet(net) {
      const p = b.position;
      const raw = p.entry + p.sign * ((net + 2 * p.fee * p.size) / perPoint(p));
      return p.sign > 0 ? Math.floor(raw / tickSize + 1e-9) * tickSize : Math.ceil(raw / tickSize - 1e-9) * tickSize;
    },
  };
  return b;
}

module.exports = { createSimBroker, onTick };
