'use strict';

/**
 * P1, the exit option `prev_high_or_trail` (config/runner.json mtfEntry.exitMode; the owner: "exit when it hits the
 * previous high, or trail and ride"): on an MTF entry, the target is its previous high (a long) or low (a short), the
 * parent impulse extreme the MTF read froze (its COMPLETED level), stamped at the entry. Before it,
 * today's stop management is unchanged (the structural stop, the lock, the trail: exit-trail.js). Each closed 3m bar:
 *   broken    first: a 15m candle completing at this close beyond the target past the tie (protected-status.js through,
 *             the module's COMPLETED rule) - ride today's trail; no further target check
 *   rejected  else: the 3m bar touched the target (a long's high at or above it) and closed back on the entry side - the
 *             runner closes at market (the next open), with this reason; a gap through it is the same rule
 * The exit stays brackets + modify_order (the owner's rule): no separate protect order; this close is the runner's market
 * close, recorded with its reason. Pure: no files, no clock.
 *
 *   initial({ target, sign })          { target, sign, state: 'pending', at, why } or null (no target: today's exit)
 *   step(st, { bar, candle15, tie15 }) the state after one closed 3m bar: { ...st, state, exit (send the close now), why }
 *   clause(st, level)                  the Position line's clause, or null
 *   at15({ bars, bar, equalAtr, minutes })   the setup-frame (15m: mtf-entry.js setupMinutes)
 *                                      candle the 3m `bar` completes ({ candle15, tie15 }; none mid-candle), from the bars up to
 *                                      it only (causal); the tie equalAtr x that candle's ATR(14)
 */

const { through, tieAt } = require('./protected-status');
const { candles, closesCandle, stepOf } = require('./mtf');

const fin = Number.isFinite;

function initial({ target, sign, entry = null } = {}) {
  // a number only (a null stamp is no target: Number(null) would be 0); minor 8: a target the trade's
  // way of the entry only (one already behind it is no exit target: today's exit).
  if (typeof target !== 'number' || !fin(target) || (sign !== 1 && sign !== -1)) return null;
  if (fin(entry) && !(sign * (target - entry) > 0)) return null;
  return { target, sign, state: 'pending', at: null, why: null };
}

function step(st, { bar, candle15 = null, tie15 = 0 } = {}) {
  if (!st || st.state !== 'pending' || !bar) return { ...st, exit: false };
  const { target, sign } = st;
  const word = sign > 0 ? 'high' : 'low';
  if (candle15 && fin(candle15.c) && through(candle15.c, target, sign > 0 ? 'down' : 'up', fin(tie15) ? tie15 : 0)) {
    return { ...st, state: 'broken', at: bar.t || null, why: `previous ${word} ${target} broken: a 15m close ${candle15.c} past it; riding the trail`, exit: false };
  }
  const touched = sign > 0 ? bar.h >= target : bar.l <= target;
  const back = sign > 0 ? bar.c < target : bar.c > target;
  if (touched && back) {
    return { ...st, state: 'rejected', at: bar.t || null, why: `previous ${word} ${target} rejected: the 3m bar touched it (${word} ${sign > 0 ? bar.h : bar.l}) and closed back ${sign > 0 ? 'under' : 'above'} it at ${bar.c}`, exit: true };
  }
  return { ...st, exit: false };
}

function clause(st, level = x => x) {
  if (!st || !fin(st.target)) return null;
  const words = { pending: 'not reached', rejected: 'rejected', broken: 'broken: riding' };
  return `target ${level(st.target)} (previous ${st.sign > 0 ? 'high' : 'low'}): ${words[st.state] || st.state}`;
}

function at15({ bars, bar, equalAtr, minutes }) {
  if (!fin(equalAtr)) throw new Error('prev-high-exit: equalAtr is required (config/analysis.json marketState, never a literal)');
  if (!Number.isInteger(minutes) || minutes < 1) throw new Error('prev-high-exit: minutes is required (the setup frame: mtf-entry.js setupMinutes)');
  const upto = (bars || []).filter(b => Date.parse(b.t) <= Date.parse(bar.t));
  if (!upto.length || !closesCandle(bar.t, stepOf(upto), minutes)) return { candle15: null, tie15: 0 };
  const cs = candles(upto, minutes).filter(c => !c.cut);
  const last = cs[cs.length - 1];
  if (!last) return { candle15: null, tie15: 0 };
  const ind = require('./indicators');
  const atr = ind.atr(cs.map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })), ind.ATR_PERIOD);
  return { candle15: { t: last.t, o: last.o, h: last.h, l: last.l, c: last.c }, tie15: tieAt(atr, cs.length - 1, equalAtr) };
}

module.exports = { initial, step, clause, at15 };
