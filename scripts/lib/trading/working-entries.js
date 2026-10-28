'use strict';

/**
 * A working entry's bracket as a fact, from the runner's own record of the order (entry-orders.json), never a
 * model claim. Brackets attach on the fill, so a working entry shows no stop leg in list_open_orders; without
 * this line the model reads it as unprotected and cancels a valid entry.
 *
 *   workingEntryLines(orders, entries, now)  one line per working order that has a live entry record: same id, contract
 *                                       root and side, recorded today, not past its composed expiry
 */

const { orderType: T, side: S } = require('../broker/interface').ENUMS;

const { contractRoot } = require('./journal');
const { familyRoot } = require('./contracts');
const { tradingDayStart, MARKET_TZ } = require('./clock');

const fam = c => familyRoot(contractRoot(String(c || '')));
const sideOf = x => (x === S.sell || String(x).toLowerCase() === 'sell' ? 'sell' : x === S.buy || String(x).toLowerCase() === 'buy' ? 'buy' : null);
const num = x => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);

function lineOf(o, rec, expires) {
  const c = rec.composed || {};
  const stop = num(c.stop) ?? num(rec.stopPrice);
  const target = num(c.target);
  const px = num(o.limitPrice) ?? num(o.stopPrice);
  const side = sideOf(o.side) || 'buy';
  const kind = o.type === T.limit || String(o.type).toLowerCase() === 'limit' ? 'limit' : 'order';
  const legs = [stop !== null ? `stop ${stop}` : (num(rec.stopTicks) ? `stop ${rec.stopTicks} ticks` : null), target !== null ? `target ${target}` : (num(rec.targetTicks) ? `target ${rec.targetTicks} ticks` : null)].filter(Boolean);
  if (!legs.length) return null;
  return `entry ${o.id ?? rec.orderId}: ${side} ${kind} ${o.size ?? ''}${px !== null ? ` @ ${px}` : ''}, bracket attached on fill: ${legs.join(' / ')} (runner record)${expires}`.replace(/ {2,}/g, ' ');
}

function etTime(ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: MARKET_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

// The record is this order's own: same id, same contract root, same side (when both state one), written today
// (entry-orders.json keeps entries across days), and not past its composed expiry (a failed cancel leaves it working).
function live(o, rec, nowMs, dayMs) {
  if (rec.contractId && o.contractId && fam(rec.contractId) !== fam(o.contractId)) return false;
  const rs = sideOf(rec.side);
  if (rs && sideOf(o.side) && rs !== sideOf(o.side)) return false;
  const at = Date.parse(rec.at);
  if (Number.isFinite(at) && Number.isFinite(dayMs) && at < dayMs) return false;
  const exp = Date.parse(rec.composed && rec.composed.expiresAt);
  return !(Number.isFinite(exp) && exp <= nowMs);
}

function workingEntryLines(orders, entries, now = new Date()) {
  const nowMs = now instanceof Date && Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const dayMs = tradingDayStart(new Date(nowMs)).getTime();
  const byId = new Map((entries || []).filter(e => e && e.orderId !== undefined).map(e => [String(e.orderId), e]));
  return (orders || []).map(o => {
    const rec = o && byId.get(String(o.id));
    if (!rec || !live(o, rec, nowMs, dayMs)) return null;
    const exp = Date.parse(rec.composed && rec.composed.expiresAt);
    return lineOf(o, rec, Number.isFinite(exp) ? `, expires ${etTime(exp)} ET` : '');
  }).filter(Boolean);
}

module.exports = { workingEntryLines };
