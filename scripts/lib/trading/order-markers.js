'use strict';

/**
 * Order calls whose outcome isn't known yet, kept on disk so the knowledge
 * outlives the process that sent them. The gateway writes a marker before it
 * forwards a place_order and removes it when the broker answers. A marker that
 * is still there means the broker may hold an order nobody was told about: the
 * reply timed out, or the gateway (a new one starts with every agent cycle)
 * exited first.
 *
 * Each place_order goes out with a customTag (the client's, or one the gateway
 * adds: the interface's tag is unique per account), so a marker is resolved
 * from the broker's own order list: an order carrying the tag means it was
 * placed (or refused, by its status); none after the grace period means it
 * never was.
 *
 * One file per account and tag (<FTH_HOME>/pending-orders/<sha256>.json; the
 * tag and account are inside): the gateways of the runner and of each agent
 * cycle share the directory and never rewrite each other's markers.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { harnessHome } = require('../paths');

const GRACE_MS = 120000;
// Interface order status codes (broker/interface.js ENUMS.orderStatus).
const STATUS = { open: 1, filled: 2, cancelled: 3, expired: 4, rejected: 5, pending: 6 };
const DEAD = new Set([STATUS.cancelled, STATUS.expired, STATUS.rejected]);
// Interface order type ids for orders that rest in the book before they fill.
const RESTING_TYPE = { limit: 1, stop_limit: 3, stop: 4, trailing_stop: 5, join_bid: 6, join_ask: 7 };

const markerDir = env => path.join(harnessHome(env), 'pending-orders');
const fileFor = (env, accountId, tag) => path.join(markerDir(env), `${crypto.createHash('sha256').update(`${String(accountId)}\0${tag}`).digest('hex')}.json`);

/** A fresh tag for an order the client sent without one. */
function newTag() {
  return `fth-${crypto.randomBytes(8).toString('hex')}`;
}

/** The tag a place_order goes out with: the client's own when it gave one (≤ 100 chars), else a fresh one. */
function tagFor(args) {
  const own = args && typeof args.customTag === 'string' ? args.customTag : '';
  return own.length >= 1 && own.length <= 100 ? own : newTag();
}

function writeMarker(env, marker) {
  const dir = markerDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const file = fileFor(env, marker.accountId, marker.tag);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(marker)}\n`);
  fs.renameSync(tmp, file);
}

/** True when an order of unknown outcome on this account already carries the tag. */
function markerExists(env, accountId, tag) {
  return fs.existsSync(fileFor(env, accountId, tag));
}

/** Remove a marker: one read from disk (its file), or { accountId, tag }. */
function removeMarker(env, marker) {
  try {
    fs.unlinkSync(marker.file || fileFor(env, marker.accountId, marker.tag));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Every marker on disk. One that can't be read comes back as
 * { file, unreadable: true }: it may be any order on any account, so
 * entries stay blocked until someone looks at it.
 */
function readMarkers(env) {
  let names;
  try {
    names = fs.readdirSync(markerDir(env));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names.filter(n => n.endsWith('.json'))) {
    const file = path.join(markerDir(env), name);
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!m || typeof m.tag !== 'string' || !Number.isFinite(Date.parse(m.sentAt))) throw new Error('malformed');
      out.push({ ...m, file });
    } catch (err) {
      if (err.code === 'ENOENT') continue; // resolved by another gateway meanwhile
      out.push({ tag: null, file, unreadable: true });
    }
  }
  return out;
}

/** Markers that concern an account (unreadable ones concern every account). */
function markersFor(markers, accountId) {
  return markers.filter(m => m.unreadable || String(m.accountId) === String(accountId));
}

const isMarket = m => String(m.type || 'market').toLowerCase() === 'market';

/**
 * Sort markers by what the broker's orders (search_orders) say:
 * - placed: an order carries the tag; `filled` when its status says so (or,
 *   with no status, when it was a market order);
 * - gone: the order carrying the tag was cancelled, expired or rejected, or
 *   none does and the grace period has passed since it was sent;
 * - unknown: everything else (and every marker when the lookup failed).
 */
function resolveMarkers(markers, orders, now, graceMs = GRACE_MS) {
  const listed = Array.isArray(orders);
  const byTag = new Map((listed ? orders : []).filter(o => o && o.customTag !== undefined && o.customTag !== null).map(o => [String(o.customTag), o]));
  const placed = [];
  const gone = [];
  const unknown = [];
  for (const m of markers) {
    const order = m.unreadable ? null : byTag.get(m.tag);
    if (m.unreadable || !listed) unknown.push(m);
    else if (order && DEAD.has(Number(order.status))) gone.push(m);
    else if (order) {
      const status = order.status === undefined || order.status === null ? null : Number(order.status);
      placed.push({ marker: m, order, filled: status === STATUS.filled || (status === null && isMarket(m)) });
    } else if (now.getTime() - Date.parse(m.sentAt) >= graceMs) gone.push(m);
    else unknown.push(m);
  }
  return { placed, gone, unknown };
}

/**
 * Ledger entries (see account-gate pendingState) for unknown market orders:
 * an exit checks against the account as it would be if they filled, so two
 * exits can't flip it. Limit and stop orders rest first: see markerOrders.
 */
function markerLedger(markers, now) {
  return markers
    .filter(m => !m.unreadable && isMarket(m) && Number.isFinite(m.observedNet) && Number(m.size) > 0)
    .map(m => ({
      contractId: m.contractId, sign: String(m.side).toLowerCase() === 'buy' ? 1 : -1, size: Number(m.size),
      netBefore: m.observedNet, rootNetBefore: Number.isFinite(m.observedRootNet) ? m.observedRootNet : m.observedNet, at: now.getTime(), orderId: null,
    }));
}

/** Unknown limit and stop orders as the resting orders they probably are (interface order shape). */
function markerOrders(markers) {
  return markers
    .filter(m => !m.unreadable && RESTING_TYPE[String(m.type || '').toLowerCase()] !== undefined && Number(m.size) > 0)
    .map(m => ({
      id: `pending:${m.tag}`, contractId: m.contractId, type: RESTING_TYPE[String(m.type).toLowerCase()],
      side: String(m.side).toLowerCase() === 'buy' ? 0 : 1, size: Number(m.size),
    }));
}

/** The order-pending message for markers still unknown. */
function pendingMessage(unknown, now, graceMs = GRACE_MS, { lookupFailed = false } = {}) {
  const parts = unknown.map(m => (m.unreadable
    ? `an unreadable record ${m.file} (check the broker's orders, then delete it)`
    : `${m.side || ''} ${m.size || ''} ${m.contractId || ''} sent ${Math.round((now.getTime() - Date.parse(m.sentAt)) / 1000)} s ago (customTag ${m.tag})`.replace(/\s+/g, ' ').trim()));
  const until = lookupFailed
    ? 'the broker\'s orders (search_orders) can be read again and settle it'
    : `the order shows in the broker's orders, or ${Math.round(graceMs / 60000)} min pass without it`;
  return `The outcome of ${parts.length === 1 ? 'an order' : `${parts.length} orders`} is unknown: ${parts.join('; ')}. `
    + `The broker may hold a position or a working order this account check can't see yet. New entries wait until ${until}. `
    + 'Exits, stop moves and cancels still go through.';
}

module.exports = {
  GRACE_MS, markerDir, newTag, tagFor, writeMarker, markerExists, removeMarker, readMarkers, markersFor, resolveMarkers, markerLedger, markerOrders, pendingMessage,
};
