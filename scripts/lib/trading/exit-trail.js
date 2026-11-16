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
 *   lockOf(trade, plan)                         the lock the step trails above (the ratchet honoured)
 *   swingClassOf({ trade, bar, plan, tick, swing })   the code floor's class at a bar (A-D), for the Position line
 *   extremeStep(acc, bar, trade)                one bar's best and worst excursion, with their prices
 *   tradeFold(trade, bars, plan, tick, swingAt) the step folded over closed bars (a trade the runner does not hold)
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
 * bar { h, l, c }; plan.afterTarget { lockGivebackR, trailBy ('r' | 'structure'), trailR, ratchet (true: on), lockAtR,
 * lockToTicks (the early lock: both set or both left out) }; swing: the structure level on the trade's side at this bar's
 * close (a long's swing low, a short's swing high), or null; a swing whose stop (a tick beyond it) is not on the
 * protective side of the bar's close counts as none.
 *
 * The early lock (the rulebook's lock_at_r, lock_to_ticks): once the best price (closed bars' extremes, this bar's
 * included) has reached lockAtR, the stop is at least the entry plus lockToTicks ticks (snapped to the tick on the safe
 * side), whether or not the target is armed; it never loosens a tighter stop. The bar that first sets the stop at that
 * lock level does not close the trade at market when its close is beyond the new stop (the stop rests from that close,
 * as the runner places it live); only a close at or through it closes the trade at the close (reason 'lock': a stop on
 * the wrong side of the market can't rest). Every other newly set stop already traded through by its bar closes the
 * trade at the close (reason 'trail'), as before.
 * Returns { stop, peakR, armed, locked, close: null | { price, reason: 'trail' | 'lock' }, fellBack (structure with no
 * usable swing: the R trail) }, and wrongSide: true when it fell back because the swing given was on the wrong side of
 * the close (not for want of one).
 */
function afterTargetStep(trade, bar, plan, tick, swing = null) {
  const { sign, entry, risk } = trade;
  const a = plan.afterTarget;
  const fav = sign > 0 ? bar.h : bar.l;
  const unfav = sign > 0 ? bar.l : bar.h;
  const peakR = Math.max(trade.peakR || 0, (sign * (fav - entry)) / risk);
  const target = Number.isFinite(trade.target) ? trade.target : null;
  const armed = Boolean(trade.armed) || (target !== null && sign * (fav - target) >= 0);
  const lockLevel = a && lockOn(a) && peakR >= a.lockAtR ? snapStop(entry + sign * a.lockToTicks * tick, sign, tick) : null;
  const locked = lockLevel !== null;
  const base = locked ? (sign > 0 ? Math.max(trade.stop, lockLevel) : Math.min(trade.stop, lockLevel)) : trade.stop;
  const through = s => s !== trade.stop && (sign > 0 ? unfav <= s : unfav >= s);
  // The lock bar: the stop newly at the lock level rests when the close is beyond it; a close at or through it, out there.
  const lockBar = s => (s === lockLevel && through(s) ? (sign * (bar.c - s) > 0 ? null : { price: bar.c, reason: 'lock' }) : undefined);
  if (!armed || !a) {
    const lb = lockBar(base);
    return { stop: base, peakR, armed, locked, close: lb === undefined ? null : lb, fellBack: false };
  }
  const lock = lockAt(sign, entry, risk, target, peakR, a);
  // A swing counts only when its stop is on the protective side of this bar's close (a long's under it, a short's over
  // it): a swing carried forward from before a gap (a long's old low now above the price) would put the stop through
  // the market and close the trade at once; it is no swing for this bar, so the lock and the R trail apply.
  const usable = Number.isFinite(swing) && sign * (bar.c - (swing - sign * tick)) > 0;
  const fellBack = a.trailBy === 'structure' && !usable;
  const why = fellBack && Number.isFinite(swing) ? { wrongSide: true } : {};
  const trail = a.trailBy === 'structure' && !fellBack ? swing - sign * tick : entry + sign * (peakR - a.trailR) * risk;
  const best = sign > 0 ? Math.max(lock, trail) : Math.min(lock, trail);
  const snapped = snapStop(best, sign, tick);
  const stop = sign > 0 ? Math.max(base, snapped) : Math.min(base, snapped);
  const lb = lockBar(stop);
  if (lb !== undefined) return { stop, peakR, armed, locked, close: lb, fellBack, ...why };
  if (through(stop)) return { stop, peakR, armed, locked, close: { price: bar.c, reason: 'trail' }, fellBack, ...why };
  return { stop, peakR, armed, locked, close: null, fellBack, ...why };
}

/**
 * The lock a target_then_trail step trails above (unsnapped, as the step uses it): the target's R less lockGivebackR.
 * With the ratchet on (opt in), the best R reached (`peakR`: closed bars' extremes, the peak the R trail reads) less it,
 * so it rises with the peak. Never below the entry. null with no afterTarget or no target.
 */
function lockOf(trade, plan) {
  const a = plan && plan.afterTarget;
  if (!a || !Number.isFinite(trade.target)) return null;
  return lockAt(trade.sign, trade.entry, trade.risk, trade.target, trade.peakR || 0, a);
}

/** The lock's arithmetic, one home for the step and lockOf. */
function lockAt(sign, entry, risk, target, peakR, a) {
  const targetR = (sign * (target - entry)) / risk;
  const lockR = a.ratchet === true ? Math.max(targetR, peakR) : targetR;
  return entry + sign * Math.max(0, lockR - a.lockGivebackR) * risk;
}

/**
 * The code floor's class at a closed bar, from the same inputs the step read there (the trade after the bar: its
 * peakR and armed; the bar's close; the swing it was given) (for the Position line):
 *   A  not armed: before the target, the initial stop holds (or the early lock, `earlyLock`, once reached)
 *   B  a usable swing (its stop on the protective side of the close) whose stop is beyond the lock: the stop trails it
 *   C  a usable swing whose stop is not beyond the lock: the stop rests at the lock
 *   D  no usable swing (none in the bars, `wrongSide`: one on the wrong side of the close; or a trail by R): the lock or
 *      the R trail, whichever is tighter (`binds`)
 * Returns { cls, trailBy, swing, swingStop, lock, binds ('swing' | 'lock' | 'trail'), trailStop, wrongSide, earlyLock (class A
 * with the early lock on and reached: the level the step holds the stop at; else null) } with the
 * levels snapped as the step snaps its stop; null with no afterTarget.
 */
function swingClassOf({ trade, bar, plan, tick, swing = null }) {
  const a = plan && plan.afterTarget;
  if (!a) return null;
  const { sign, entry, risk } = trade;
  const snap = x => (tick > 0 ? snapStop(x, sign, tick) : x);
  const raw = lockOf(trade, plan);
  const lock = raw === null ? null : snap(raw);
  const base = { trailBy: a.trailBy, swing: Number.isFinite(swing) ? swing : null, swingStop: Number.isFinite(swing) ? snap(swing - sign * tick) : null, lock };
  // Before the target, the early lock (lock_at_r, lock_to_ticks) holds the stop at its level once the best reached it.
  const early = lockOn(a) && (trade.peakR || 0) >= a.lockAtR ? snap(entry + sign * a.lockToTicks * tick) : null;
  if (!trade.armed || raw === null) return { cls: 'A', ...base, binds: null, trailStop: null, wrongSide: false, earlyLock: early };
  const usable = a.trailBy === 'structure' && Number.isFinite(swing) && sign * (bar.c - (swing - sign * tick)) > 0;
  if (usable) {
    const beyond = sign * ((swing - sign * tick) - raw) > 0;
    return { cls: beyond ? 'B' : 'C', ...base, binds: beyond ? 'swing' : 'lock', trailStop: null, wrongSide: false, earlyLock: null };
  }
  const trail = entry + sign * ((trade.peakR || 0) - a.trailR) * risk;
  return { cls: 'D', ...base, binds: sign * (trail - raw) > 0 ? 'trail' : 'lock', trailStop: snap(trail), wrongSide: a.trailBy === 'structure' && Number.isFinite(swing), earlyLock: null };
}

/**
 * One closed bar's excursion facts for a trade { sign, entry, risk } from `acc` (the facts so far, {} at the fill):
 * { peakR (the best R, never under 0), bestPrice and bestBarT (the bar that set it; null before one went the trade's
 * way), troughR (the worst R, never above 0), worstPrice (null before one went against it), stallBars (closed bars since
 * the best: the log's, no prompt reads it) }.
 */
function extremeStep(acc, bar, { sign, entry, risk }) {
  const fav = sign > 0 ? bar.h : bar.l;
  const unf = sign > 0 ? bar.l : bar.h;
  const favR = (sign * (fav - entry)) / risk;
  const unfR = (sign * (unf - entry)) / risk;
  const peak = acc.peakR || 0;
  const trough = acc.troughR || 0;
  const best = favR > peak;
  return {
    peakR: Math.max(peak, favR), bestPrice: best ? fav : acc.bestPrice ?? null, bestBarT: best ? bar.t : acc.bestBarT ?? null,
    troughR: Math.min(trough, unfR), worstPrice: unfR < trough ? unf : acc.worstPrice ?? null,
    stallBars: best ? 0 : acc.bestPrice === null || acc.bestPrice === undefined ? 0 : (acc.stallBars || 0) + 1,
  };
}

/**
 * The step folded over closed bars (oldest first, the caller's bar rule applied) for a trade the runner does not hold:
 * trade { sign, entry, risk, stop, target }; plan null (no exit plan known): the excursions only. swingAt(bar): the
 * swing the step would read at that bar's close. Returns extremeStep's facts and { armed, stop (null without a plan),
 * swing, lock, swingClass (swingClassOf at the last bar, null without a plan), lastClose, lastBarT }.
 */
function tradeFold(trade, bars, plan, tick, swingAt = () => null) {
  const after = plan && plan.afterTarget ? plan : null;
  let acc = {};
  let t = { ...trade, peakR: 0, armed: false };
  let swing = null;
  let last = null;
  for (const bar of bars || []) {
    acc = extremeStep(acc, bar, trade);
    if (after) {
      swing = after.afterTarget.trailBy === 'structure' ? swingAt(bar) : null;
      const s = afterTargetStep(t, bar, after, tick, swing);
      t = { ...t, stop: s.stop, peakR: s.peakR, armed: s.armed };
    } else t = { ...t, peakR: acc.peakR };
    last = bar;
  }
  const swingClass = after && last ? swingClassOf({ trade: t, bar: last, plan: after, tick, swing }) : null;
  return {
    ...acc, peakR: t.peakR, troughR: acc.troughR || 0, armed: t.armed, stop: after ? t.stop : null, swing,
    lock: after ? lockOf(t, after) : null, swingClass, lastClose: last ? last.c : null, lastBarT: last ? last.t : null,
  };
}

/** The early lock is on: both keys set (the rulebook's lock_at_r and lock_to_ticks; left out of the plan when off). */
const lockOn = a => Number.isFinite(a.lockAtR) && a.lockAtR > 0 && Number.isInteger(a.lockToTicks) && a.lockToTicks > 0;

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

module.exports = { SWING_TFS, swingSeries, afterTargetStep, lockOf, swingClassOf, extremeStep, tradeFold, swingAtBar, liveTarget };
