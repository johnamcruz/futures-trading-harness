'use strict';

/**
 * A fill the broker's position read doesn't show yet (a fill reported late): the position is there, its bracket stop
 * protects it, and a cleanup that trusts the position read alone would cancel that stop as a leftover. Before a stop
 * leg goes, every source counts, and a disagreement keeps the stop (the next read decides again):
 *
 *   evidenceNet(contractId, { fills, history })
 *       { net, unknown }: the signed net the fills (search_trades, not voided) and the order statuses (search_orders)
 *       show for that contract month since their anchor: the fills netted, plus each order's filled volume that no fill
 *       of it accounts for yet (an order reads filled, its fill isn't listed). `unknown`: a fill or an order on the
 *       contract whose side or size can't be read (never read as flat).
 *   workingEntryOf(leg, orders)
 *       the working order on the leg's contract, on the other side, placed no later than the leg (a leg is placed with
 *       or after its entry): the entry this stop may be the bracket of. An id that isn't a number counts.
 *   stopHeld(leg, { orders, fills, history })
 *       null when the stop may go as far as these sources tell, else why it stays: a position of the side it protects
 *       that the fills or order statuses show and the other stops don't cover, a working entry it may be the leg of, or
 *       an unreadable fill or order. The position read itself is the caller's (it is checked first).
 *
 * A stop is let go only once the fills net to zero (or to the other side), no order reads filled beyond its fills,
 * and no entry works: the position confirmed closed.
 */

const { isStopLeg, coveredSize, orderSign } = require('./bracket-legs');
const { ENUMS } = require('../broker/interface');

const { filled: FILLED, open: OPEN, pending: PENDING } = ENUMS.orderStatus;
const WORKING = new Set([OPEN, PENDING]);

const count = v => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v) : NaN);
const sideSign = side => ({ 0: 1, 1: -1 })[String(side)] || 0; // the interface's sides: 0 buy, 1 sell

function evidenceNet(contractId, { fills = [], history = [] } = {}) {
  let net = 0;
  let unknown = false;
  const seen = new Map(); // order id -> the fill volume listed for it
  for (const f of (Array.isArray(fills) ? fills : []).filter(x => x && x.contractId === contractId && x.voided !== true)) {
    const size = count(f.size);
    const sign = sideSign(f.side);
    if (!(size >= 0) || !sign) { unknown = true; continue; }
    net += sign * size;
    if (f.orderId !== undefined && f.orderId !== null) seen.set(String(f.orderId), (seen.get(String(f.orderId)) || 0) + size);
  }
  for (const o of (Array.isArray(history) ? history : []).filter(x => x && x.contractId === contractId)) {
    const given = o.fillVolume !== undefined && o.fillVolume !== null;
    const vol = given ? count(o.fillVolume) : 0;
    const size = Number(o.status) === FILLED ? count(o.size) : 0;
    if (Number.isNaN(vol) || Number.isNaN(size)) { unknown = true; continue; }
    const filled = Math.max(vol, size);
    if (!(filled > 0)) continue;
    const sign = sideSign(o.side);
    if (!sign) { unknown = true; continue; }
    const missing = filled - (seen.get(String(o.id)) || 0);
    if (missing > 0) net += sign * missing;
  }
  return { net, unknown };
}

function workingEntryOf(leg, orders = []) {
  const id = Number(leg.id);
  return (orders || []).find(o => o && o !== leg && String(o.id) !== String(leg.id) && o.contractId === leg.contractId
    && orderSign(o) === -orderSign(leg) && (o.status === undefined || o.status === null || WORKING.has(Number(o.status)))
    && (!Number.isFinite(id) || !Number.isFinite(Number(o.id)) || Number(o.id) <= id)) || null;
}

// `cover: false` (the runner's cleanup, which cancels one stop after another without re-reading): every stop of the
// side the evidence shows is held, whatever the other stops cover, so two stops of one hidden position never both go.
function stopHeld(leg, { orders = [], fills = [], history = [] } = {}, { cover = true } = {}) {
  if (!leg || !isStopLeg(leg)) return null;
  const protects = -orderSign(leg); // the position side this stop closes
  const { net, unknown } = evidenceNet(leg.contractId, { fills, history });
  if (unknown) return { why: 'unreadable', net, text: `a fill or order on ${leg.contractId} can't be read` };
  if (Math.sign(net) === protects) {
    const others = cover ? coveredSize((orders || []).filter(o => o && String(o.id) !== String(leg.id)), leg.contractId, protects) : 0;
    if (others < Math.abs(net)) return { why: 'fills', net, text: `the fills and order statuses show ${leg.contractId} ${protects > 0 ? 'long' : 'short'} ${Math.abs(net)} (a fill the position read doesn't show yet)` };
  }
  const entry = workingEntryOf(leg, orders);
  if (entry) return { why: 'entry', net, entry, text: `entry ${entry.id} still works on ${leg.contractId} and this may be its bracket stop` };
  return null;
}

/**
 * The size of the position a stop protects as the fills and order statuses show it: 0 when they show none on its side.
 * Throws when they can't be read (the caller fails closed); `fills` and `history` both undefined (no reads made): 0.
 */
function evidenceCover(leg, { fills, history } = {}) {
  if (fills === undefined && history === undefined) return 0;
  if (!Array.isArray(fills) || !Array.isArray(history)) throw new Error('the fills or the orders from the server are not a list');
  const { net, unknown } = evidenceNet(leg.contractId, { fills, history });
  if (unknown) throw new Error(`a fill or order on ${leg.contractId} can't be read`);
  return Math.sign(net) === -orderSign(leg) ? Math.abs(net) : 0;
}

module.exports = { evidenceNet, workingEntryOf, stopHeld, evidenceCover };
