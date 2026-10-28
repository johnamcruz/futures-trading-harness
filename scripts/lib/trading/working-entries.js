'use strict';

/**
 * A working entry's bracket as a fact, from the runner's own record of the order (entry-orders.json), never a
 * model claim. Brackets attach on the fill, so a working entry shows no stop leg in list_open_orders; without
 * this line the model reads it as unprotected and cancels a valid entry.
 *
 *   workingEntryLines(orders, entries)  one line per working order that has an entry record
 */

const { orderType: T, side: S } = require('../broker/interface').ENUMS;

const num = x => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);

function lineOf(o, rec) {
  const c = rec.composed || {};
  const stop = num(c.stop) ?? num(rec.stopPrice);
  const target = num(c.target);
  const px = num(o.limitPrice) ?? num(o.stopPrice);
  const side = o.side === S.sell || String(o.side).toLowerCase() === 'sell' ? 'sell' : 'buy';
  const kind = o.type === T.limit || String(o.type).toLowerCase() === 'limit' ? 'limit' : 'order';
  const legs = [stop !== null ? `stop ${stop}` : (num(rec.stopTicks) ? `stop ${rec.stopTicks} ticks` : null), target !== null ? `target ${target}` : (num(rec.targetTicks) ? `target ${rec.targetTicks} ticks` : null)].filter(Boolean);
  if (!legs.length) return null;
  return `entry ${o.id ?? rec.orderId}: ${side} ${kind} ${o.size ?? ''}${px !== null ? ` @ ${px}` : ''}, bracket attached on fill: ${legs.join(' / ')} (runner record)`.replace(/ {2,}/g, ' ');
}

function workingEntryLines(orders, entries) {
  const byId = new Map((entries || []).filter(e => e && e.orderId !== undefined).map(e => [String(e.orderId), e]));
  return (orders || []).map(o => {
    const rec = o && byId.get(String(o.id));
    return rec ? lineOf(o, rec) : null;
  }).filter(Boolean);
}

module.exports = { workingEntryLines };
