'use strict';

/**
 * A closed trade's trip facts, as the runner's review records them (runner-reviews.js) for the trade feedback
 * (trade-feedback.js): a leaf module (only the broker interface's enums), so the fail-closed review hook's load graph
 * (toolcall/rules.js -> runner-reviews.js) never reaches the feedback's information-only code.
 *
 *   TRIP                                 the tag names
 *   tripTags({ side, size, fill, exit, openedAt, closedAt, risk, exitReason })   the review's trip-* tags (nothing
 *                                        unknown written)
 *   tripOf(review)                       those tags read back, or null when it has none
 *   grossR(trip)                         the price R of the trip (side x (exit - fill) / risk), or null
 *   exitReasonOf({ t, side, orderId, fills, history, stopTicks, tick })   the exit's reason from the broker's own word
 *                                        on the closing orders, or null
 */

const { orderType: ORDER_TYPE, side: SIDE } = require('../broker/interface').ENUMS;

const fin = Number.isFinite;
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const r6 = x => Math.round(x * 1e6) / 1e6; // a size-weighted fill price, kept to its precision
// The fill side that closes a long (a sell) and a short (a buy), by the broker interface's codes.
const CLOSING_SIDE = { long: SIDE.sell, short: SIDE.buy };

const TRIP = Object.freeze({ side: 'trip-side', size: 'trip-size', fill: 'trip-fill', exit: 'trip-out', openedAt: 'trip-open', closedAt: 'trip-close', risk: 'trip-risk', exitReason: 'trip-exit' });

/** The review's trip tags: what is known, nothing unknown written. */
function tripTags({ side, size, fill, exit, openedAt, closedAt, risk = null, exitReason = null }) {
  const iso = t => { const m = Date.parse(t); return fin(m) ? new Date(m).toISOString() : null; };
  const pairs = [['side', side === 'long' || side === 'short' ? side : null], ['size', fin(Number(size)) && Number(size) > 0 ? Number(size) : null],
    ['fill', fin(Number(fill)) ? r6(Number(fill)) : null], ['exit', fin(Number(exit)) ? r6(Number(exit)) : null], ['openedAt', iso(openedAt)], ['closedAt', iso(closedAt)],
    ['risk', fin(Number(risk)) && Number(risk) > 0 ? Number(risk) : null], ['exitReason', typeof exitReason === 'string' && exitReason ? exitReason : null]];
  return pairs.filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${TRIP[k]}:${v}`);
}

/** The trip tags read back: { side, size, fill, exit, openMs, closeMs, risk, exitReason }, or null when it has none. */
function tripOf(review) {
  const tags = review && Array.isArray(review.tags) ? review.tags.map(String) : [];
  const get = name => { const t = tags.find(x => x.startsWith(`${name}:`)); return t ? t.slice(name.length + 1) : null; };
  if (!tags.some(x => x.startsWith('trip-'))) return null;
  const num = name => { const v = get(name); return v !== null && fin(Number(v)) ? Number(v) : null; };
  const ms = name => { const v = get(name); const t = v ? Date.parse(v) : NaN; return fin(t) ? t : null; };
  const side = get(TRIP.side);
  return { side: side === 'long' || side === 'short' ? side : null, size: num(TRIP.size), fill: num(TRIP.fill), exit: num(TRIP.exit), openMs: ms(TRIP.openedAt), closeMs: ms(TRIP.closedAt), risk: num(TRIP.risk), exitReason: get(TRIP.exitReason) };
}

/** The trip's price R before fees: side x (exit - fill) / risk, or null when any is unknown. */
function grossR(trip) {
  const s = trip && trip.side === 'long' ? 1 : trip && trip.side === 'short' ? -1 : 0;
  if (!s || !fin(trip.fill) || !fin(trip.exit) || !(trip.risk > 0)) return null;
  return Math.round((s * (trip.exit - trip.fill) / trip.risk) * 100) / 100;
}

/**
 * The exit's reason from the broker's own word on the orders that closed it (search_orders, `history`): the closing
 * fills are the opposite side's on its contract from its open to its close (a same-side fill is an add, never a close);
 * a bracket's target leg `target`; a trailing stop, or a stop away from the planned one (the brackets are placed from
 * the fill: fill -/+ stopTicks x tick, within half a tick) `trail`; a stop at it `stop`; a market order `closed` (the
 * runner's or the model's close); closing orders that say different things `mixed`. Null when it can't be told: the
 * orders unread, a closing order not listed, a stop with no planned stop, another order type.
 */
function exitReasonOf({ t, side, orderId, fills, history, stopTicks = null, tick = null }) {
  if (!t || !Array.isArray(history) || !Array.isArray(fills)) return null;
  const from = Date.parse(t.openedAt);
  const to = Date.parse(t.closedAt);
  const s = side === 'long' ? 1 : side === 'short' ? -1 : 0;
  if (!s || !fin(from) || !fin(to)) return null;
  const closing = fills.filter(f => f && f.voided !== true && f.contractId === t.contractId && String(f.orderId) !== String(orderId)
    && Number(f.side) === CLOSING_SIDE[side] && fin(Date.parse(f.creationTimestamp)) && Date.parse(f.creationTimestamp) >= from && Date.parse(f.creationTimestamp) <= to);
  if (!closing.length) return null;
  const reasons = [...new Set(closing.map(f => f.orderId)).values()].map(id => {
    const o = history.find(x => x && String(x.id) === String(id));
    if (!o) return null;
    const type = Number(o.type);
    const role = isObj(o.bracket) ? o.bracket.role : null;
    if (role === 'target') return 'target';
    if (type === ORDER_TYPE.trailing_stop) return 'trail';
    if (role === 'stop' || type === ORDER_TYPE.stop) {
      const planned = Number(stopTicks) > 0 && Number(tick) > 0 && fin(Number(t.fill)) ? Number(t.fill) - s * Number(stopTicks) * Number(tick) : null;
      if (planned === null || !fin(Number(o.stopPrice))) return null;
      return Math.abs(Number(o.stopPrice) - planned) <= Number(tick) / 2 ? 'stop' : 'trail';
    }
    return type === ORDER_TYPE.market ? 'closed' : null;
  });
  if (reasons.some(x => x === null)) return null;
  return new Set(reasons).size === 1 ? reasons[0] : 'mixed';
}

module.exports = { TRIP, tripTags, tripOf, grossR, exitReasonOf };
