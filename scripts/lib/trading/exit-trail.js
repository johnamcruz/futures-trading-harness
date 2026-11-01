'use strict';

/**
 * The policy's target-then-trail exit (exit mode `target_then_trail`, the account's rulebook), the same rule live
 * (runner.js), in the backtester's broker (backtest/sim-broker.js) and in the attempt simulator (prop/attempts.js
 * exitAs): the trade holds its original stop until its own target is reached; from there it is not closed at the
 * target but trailed, the stop never below the lock (the target's R less `lockGivebackR`, never below the entry; with
 * the rulebook's `ratchet: on`, the best R reached, at least the target's, less it: a lock that rises with the peak), and
 * behind either the best price by `trailR` (trail_by r) or the last confirmed swing on `swingMinutes` candles (trail_by
 * structure; the latest swing, even one confirmed before the entry, so the R trail is the fallback only when the bars
 * hold none or that swing's stop is not on the protective side of the bar's close). The stop only ratchets toward the
 * market, snapped to the tick on the safe side; a bar whose adverse extreme already went through the new stop closes the
 * trade at its close (trail.js: the stop wasn't resting there yet). Every input is a closed bar: nothing reads ahead.
 *
 *   SWING_TFS                                   the swing timeframes a structure trail may name, in minutes
 *   swingSeries(bars, minutes, k)               per base bar: the latest swing low and high confirmed by its close
 *   afterTargetStep(trade, bar, plan, tick, swing)   one closed bar of a trade under the rule
 *   swingAtBar(bars, bar, minutes, sign)        live: the swing a structure trail stands behind at `bar`'s close
 *   liveTarget({ rec, entry, sign, tick, orders, contractId })   live: the trade's own target and its resting order(s)
 */

const { candles, closesCandle, stepOf } = require('./mtf');
const { pivots } = require('./structure-events');
const { snapStop } = require('./trail');

const SWING_TFS = Object.freeze({ '5m': 5, '15m': 15, '1h': 60 });

/**
 * The swings a structure trail may stand behind, per base bar `i` of `bars` (normalized, oldest first): the latest
 * swing low and high (structure-events.js pivots, `k` candles each side, as the briefing reads them) of the
 * `minutes` candles built from the bars, counted only once the candle that confirms it has closed by bar i's close.
 * Returns { low: [price|null], high: [price|null] }, one per bar. Causal: bar i's values use bars 0..i only.
 */
function swingSeries(bars, minutes, k = 2) {
  const n = bars.length;
  const low = new Array(n).fill(null);
  const high = new Array(n).fill(null);
  if (!n) return { low, high };
  const cs = candles(bars, minutes);
  const step = stepOf(bars);
  // The base bar by whose close each candle is complete, as mtf.candles tells it on the bars so far: its last bar
  // when that bar closes on the candle's boundary, else the next candle's first bar; a last candle still open, never.
  const doneAt = cs.map((c, j) => (closesCandle(bars[c.end].t, step, minutes) ? c.end : j < cs.length - 1 ? cs[j + 1].start : Infinity));
  const ps = pivots(cs.filter(c => c.complete), k).map(p => ({ ...p, at: doneAt[p.confirmedAt] }))
    .filter(p => Number.isFinite(p.at)).sort((a, b) => a.at - b.at);
  let q = 0;
  let lo = null;
  let hi = null;
  for (let i = 0; i < n; i += 1) {
    while (q < ps.length && ps[q].at <= i) {
      if (ps[q].type === 'low') lo = ps[q].price; else hi = ps[q].price;
      q += 1;
    }
    low[i] = lo;
    high[i] = hi;
  }
  return { low, high };
}

/**
 * One closed bar of a trade after its fill under a target-then-trail plan.
 * trade { sign (1 long, -1 short), entry, risk (price, 1R), stop, peakR, armed, target (price, or null: never arms) }
 * bar { h, l, c }; plan.afterTarget { lockGivebackR, trailBy ('r' | 'structure'), trailR, ratchet (true: on) }; swing: the structure
 * level on the trade's side at this bar's close (a long's swing low, a short's swing high), or null; a swing whose stop
 * (a tick beyond it) is not on the protective side of the bar's close counts as none.
 * Returns { stop, peakR, armed, close: null | { price, reason: 'trail' }, fellBack (structure with no usable swing: the R trail) },
 * and wrongSide: true when it fell back because the swing given was on the wrong side of the close (not for want of one).
 */
function afterTargetStep(trade, bar, plan, tick, swing = null) {
  const { sign, entry, risk } = trade;
  const a = plan.afterTarget;
  const fav = sign > 0 ? bar.h : bar.l;
  const peakR = Math.max(trade.peakR || 0, (sign * (fav - entry)) / risk);
  const target = Number.isFinite(trade.target) ? trade.target : null;
  const armed = Boolean(trade.armed) || (target !== null && sign * (fav - target) >= 0);
  if (!armed || !a) return { stop: trade.stop, peakR, armed, close: null, fellBack: false };
  const targetR = (sign * (target - entry)) / risk;
  // The lock: the target's R less lockGivebackR. With the ratchet on (opt in), the best R reached (closed bars'
  // extremes, the peak the R trail reads) less it, so it rises with the peak. Never below the entry.
  const lockR = a.ratchet === true ? Math.max(targetR, peakR) : targetR;
  const lock = entry + sign * Math.max(0, lockR - a.lockGivebackR) * risk;
  // A swing counts only when its stop is on the protective side of this bar's close (a long's under it, a short's over
  // it): a swing carried forward from before a gap (a long's old low now above the price) would put the stop through
  // the market and close the trade at once; it is no swing for this bar, so the lock and the R trail apply.
  const usable = Number.isFinite(swing) && sign * (bar.c - (swing - sign * tick)) > 0;
  const fellBack = a.trailBy === 'structure' && !usable;
  const why = fellBack && Number.isFinite(swing) ? { wrongSide: true } : {};
  const trail = a.trailBy === 'structure' && !fellBack ? swing - sign * tick : entry + sign * (peakR - a.trailR) * risk;
  const best = sign > 0 ? Math.max(lock, trail) : Math.min(lock, trail);
  const snapped = snapStop(best, sign, tick);
  const stop = sign > 0 ? Math.max(trade.stop, snapped) : Math.min(trade.stop, snapped);
  const unfav = sign > 0 ? bar.l : bar.h;
  if (stop !== trade.stop && (sign > 0 ? unfav <= stop : unfav >= stop)) return { stop, peakR, armed, close: { price: bar.c, reason: 'trail' }, fellBack, ...why };
  return { stop, peakR, armed, close: null, fellBack, ...why };
}

/**
 * Live: the swing a structure trail stands behind at the close of `bar` (one of `bars`, the runner's closed bars,
 * oldest first): a long's latest confirmed swing low, a short's high, from the bars up to it only; null with none.
 */
function swingAtBar(bars, bar, minutes, sign) {
  const i = bars.indexOf(bar);
  if (i < 0 || !minutes) return null;
  const s = swingSeries(bars.slice(0, i + 1), minutes);
  return (sign > 0 ? s.low : s.high)[i];
}

/** A limit order's price (the interface's limitPrice), or NaN. */
const limitOf = o => Number(o && (o.limitPrice ?? o.price));

/**
 * Live: the trade's own target for a trail past it, and the resting order(s) to cancel so it isn't closed there: a
 * composed entry's plan target price (the gate's stamp, `rec.composed.target`: the structure level its plan named, not
 * the fill-shifted one), else the entry's takeProfitBracket ticks from the fill (the gateway's entry record,
 * `rec.targetTicks`), else the one resting limit order on the position's other side. Returns { price, cancel: [orders],
 * why } (price null: no target known; nothing is cancelled then). Only orders at the target price, or at the bracket's
 * distance from the fill (where the broker rests it), are cancelled; never a stop.
 */
function liveTarget({ rec, entry, sign, tick, orders = [], contractId }) {
  const exits = (orders || []).filter(o => o && o.contractId === contractId && Number(o.type) === 1 && (Number(o.side) === 0 ? 1 : -1) === -sign);
  const onTick = x => Math.round(Math.round(x / tick) * tick * 1e9) / 1e9;
  const bracket = rec && Number.isInteger(rec.targetTicks) && rec.targetTicks > 0 && tick > 0 ? onTick(entry + sign * rec.targetTicks * tick) : null;
  const planned = rec && rec.composed && Number.isFinite(rec.composed.target) && sign * (rec.composed.target - entry) > 0 ? rec.composed.target : null;
  let price = null;
  if (planned !== null) price = planned;
  else if (bracket !== null) price = bracket;
  else if (exits.length === 1 && Number.isFinite(limitOf(exits[0])) && sign * (limitOf(exits[0]) - entry) > 0) price = limitOf(exits[0]);
  if (price === null) return { price: null, cancel: [], why: exits.length > 1 ? 'several resting limit orders, none recorded as its target' : 'no takeProfitBracket recorded and no resting target' };
  return { price, cancel: exits.filter(o => [price, bracket].some(x => x !== null && Math.abs(limitOf(o) - x) < tick / 2)), why: null };
}

module.exports = { SWING_TFS, swingSeries, afterTargetStep, swingAtBar, liveTarget };
