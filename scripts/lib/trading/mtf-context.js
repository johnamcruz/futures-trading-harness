'use strict';

/**
 * P1, the MTF candidate's CONTEXT facts (the owner's decision kept the turn, the BOS count since it and the impulse's
 * strength): facts the model weighs, never a filter, a gate or a preference (the turn's age says when it was, "cleanness"
 * measures the impulse; neither is advice; the flip test judges whether they move a pick). Pure and causal: each is
 * computed from what the MTF read knows at the candidate's bar; the displacement label is the one rule (cisd.js strongCandle, displacement.js's
 * candleDisplaced), unchanged.
 *
 *   impulseQuality({ candles, from, to, start, extreme, dir, atr, displaced })   the parent impulse on the setup frame's
 *                                  completed candles from..to (the leg start's candle to the extreme's): { atr (the net
 *                                  move in ATR(14) at the extreme's candle), bars, displaced (the candles the displacement rule
 *                                  labels displaced the impulse's way), cleanness (net move over the sum of the candles'
 *                                  ranges, 0-1) }, or null when it can't be measured
 *   sessionsBetween(from, to)      trading sessions back from `to` to `from` (0 the same; weekends not counted)
 *   isFresh(turn, sessionsAgo)     a CHoCH turn in this session or the previous one
 *   turnText(turn, frame, { sessionsAgo })   "1h turn (this session): 1h CHoCH up 10:15, BOS up 10:42; 1 BOS since the
 *                                  turn", "1h turn 3 sessions ago (older): ...", or "no turn: trend since 10:42, 3 BOS"
 *                                  (turn: mtf-structure.js parent.turn)
 *   impulseText(q)                 "impulse 2.4 ATR in 9 bars, 2 displacement candles, cleanness 0.78"; cut: cleanness
 *                                  first
 */

const r2 = x => Math.round(x * 100) / 100;
const fin = Number.isFinite;

function impulseQuality({ candles, from, to, start, extreme, dir, atr, displaced }) {
  if (!Array.isArray(candles) || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= candles.length) return null;
  if (!fin(start) || !fin(extreme) || !(dir === 1 || dir === -1)) return null;
  const net = dir * (extreme - start);
  if (!(net > 0)) return null;
  const a = Array.isArray(atr) ? atr[to] : NaN;
  let range = 0;
  let disp = 0;
  for (let i = from; i <= to; i += 1) {
    range += candles[i].h - candles[i].l;
    if (displaced(i)) disp += 1;
  }
  return { atr: fin(a) && a > 0 ? r2(net / a) : null, bars: to - from + 1, displaced: disp, cleanness: range > 0 ? r2(Math.min(1, net / range)) : null };
}

/** Trading sessions from `fromIso` back to `toIso`'s (clock.js tradingDayKey, the 18:00 ET rollover; Saturday and Sunday
 * keys never counted): 0 the same session, 1 the previous one; null when either time can't be read. */
function sessionsBetween(fromIso, toIso) {
  const { tradingDayKey } = require('./clock');
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!fin(a) || !fin(b)) return null;
  const ka = tradingDayKey(new Date(a));
  const kb = tradingDayKey(new Date(b));
  if (ka >= kb) return 0;
  // Count each calendar day after `ka` up to `kb` that is a weekday (a trading day's key is never a Saturday or Sunday).
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
  let n = 0;
  const d = new Date(`${ka}T12:00:00Z`);
  for (;;) {
    d.setUTCDate(d.getUTCDate() + 1);
    const key = d.toISOString().split('T')[0];
    if (key > kb) break;
    if (!['Sat', 'Sun'].includes(weekday.format(d))) n += 1;
  }
  return n;
}

/** A turn is fresh only with its CHoCH in this session or the previous one. */
const isFresh = (turn, sessionsAgo) => Boolean(turn && turn.choch) && Number.isInteger(sessionsAgo) && sessionsAgo <= 1;

function turnText(turn, frame, { sessionsAgo = null } = {}) {
  if (!turn || typeof turn !== 'object') return null;
  const bos = n => `${n} BOS`;
  if (turn.choch) {
    const b = turn.bos ? `, BOS ${turn.way} ${turn.bos.et}` : `, no BOS ${turn.way} yet`;
    const head = isFresh(turn, sessionsAgo) ? `${frame} turn (${sessionsAgo === 0 ? 'this session' : 'the previous session'})`
      : Number.isInteger(sessionsAgo) ? `${frame} turn ${sessionsAgo} sessions ago (older)` : `${frame} turn of unknown age (older)`;
    return `${head}: ${frame} CHoCH ${turn.way} ${turn.choch.et}${b}; ${bos(turn.bosCount)} since the turn`;
  }
  return `no turn: trend since ${turn.since ? turn.since.et : '?'}, ${bos(turn.bosCount)}`;
}

function impulseText(q, { cut = 0 } = {}) {
  if (!q) return 'impulse not measured';
  const parts = [`impulse ${q.atr === null ? '? ATR' : `${q.atr} ATR`} in ${q.bars} bars`, `${q.displaced} displacement candle${q.displaced === 1 ? '' : 's'}`];
  if (cut < 1 && q.cleanness !== null) parts.push(`cleanness ${q.cleanness}`);
  return parts.join(', ');
}

module.exports = { impulseQuality, sessionsBetween, isFresh, turnText, impulseText };
