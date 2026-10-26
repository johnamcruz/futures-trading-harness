'use strict';

/**
 * Which working orders are a position's bracket legs: its protective stop(s) and target(s). A server may mark a leg
 * with `bracket: { role: "stop" | "target" }` (the interface's optional field); when it does, the role decides. When
 * the field is absent (or names another role) the order's type does, as before: stop / trailing_stop / stop_limit are
 * stops, limit / join_bid / join_ask are targets. Absence never reads as "no bracket".
 *
 *   legRole(order)                            'stop' | 'target' | null (no role given)
 *   isStopLeg(order) / isTargetLeg(order)     by role, else by type
 *   protectiveStops(orders, contractId, sign) the working stops on the opposite side of a position of `sign` (1 long,
 *                                             -1 short), in exactly that contract month
 *   coveredSize(orders, contractId, sign)     their total size
 */

// The interface's order type ids (broker/interface.js ENUMS), by name: one home for them.
const { orderType: T } = require('../broker/interface').ENUMS;
const STOP_TYPES = new Set([T.stop_limit, T.stop, T.trailing_stop]);
const LIMIT_TYPES = new Set([T.limit, T.join_bid, T.join_ask]);

function legRole(o) {
  const r = o && o.bracket && typeof o.bracket === 'object' && typeof o.bracket.role === 'string' ? o.bracket.role.trim().toLowerCase() : null;
  return r === 'stop' || r === 'target' ? r : null;
}

const isStopLeg = o => (legRole(o) ? legRole(o) === 'stop' : STOP_TYPES.has(Number(o && o.type)));
const isTargetLeg = o => (legRole(o) ? legRole(o) === 'target' : LIMIT_TYPES.has(Number(o && o.type)));
const orderSign = o => (Number(o.side) === 0 ? 1 : -1);

function protectiveStops(orders, contractId, sign) {
  return (orders || []).filter(o => o && o.contractId === contractId && isStopLeg(o) && orderSign(o) === -sign);
}

function coveredSize(orders, contractId, sign) {
  return protectiveStops(orders, contractId, sign).reduce((n, o) => n + Number(o.size || 0), 0);
}

module.exports = { legRole, isStopLeg, isTargetLeg, protectiveStops, coveredSize, orderSign };
