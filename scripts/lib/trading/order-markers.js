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

const { ORDER_GRACE_MS: GRACE_MS } = require('./gate-timing');
const LOOKBACK_MS = require('../tunables').runner().gate.markerLookbackMs;
// Interface order statuses (broker/interface.js ENUMS.orderStatus) of an order that never worked or no longer does.
const DEAD = new Set([3, 4, 5]); // cancelled, expired, rejected
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
 * - placed: a live order (not cancelled, expired or rejected) carries the tag;
 * - gone: the order carrying the tag, created after the marker's was sent,
 *   was cancelled, expired or rejected; or none does and the grace period
 *   has passed since it was sent;
 * - unknown: everything else (and every marker when the lookup failed, or
 *   whose call the caller is still waiting on).
 */
function resolveMarkers(markers, orders, now, graceMs = GRACE_MS, { inFlight = () => false } = {}) {
  const listed = Array.isArray(orders);
  const tagged = (listed ? orders : []).filter(o => o && o.customTag !== undefined && o.customTag !== null);
  const created = o => Date.parse(o.creationTimestamp);
  // Orders carrying the tag, newest first. A live one settles the marker as placed (the broker's clock may
  // lag ours, so within the lookup's 60 s window). A dead one settles it as gone only when it was created
  // after the marker's order was sent: a client may reuse the tag of an older, finished order.
  const matches = m => tagged.filter(o => String(o.customTag) === m.tag)
    .sort((a, b) => (Number.isFinite(created(b)) ? created(b) : Infinity) - (Number.isFinite(created(a)) ? created(a) : Infinity));
  const placed = [];
  const gone = [];
  const unknown = [];
  for (const m of markers) {
    const all = m.unreadable ? [] : matches(m);
    const sent = Date.parse(m.sentAt);
    const live = all.find(o => !DEAD.has(Number(o.status)) && (!Number.isFinite(created(o)) || created(o) >= sent - LOOKBACK_MS));
    const dead = all.find(o => DEAD.has(Number(o.status)) && (!Number.isFinite(created(o)) || created(o) >= sent));
    if (m.unreadable || !listed) unknown.push(m);
    else if (live) placed.push({ marker: m, order: live });
    else if (dead) gone.push(m);
    else if (now.getTime() - Date.parse(m.sentAt) >= graceMs && !inFlight(m)) gone.push(m);
    else unknown.push(m);
  }
  return { placed, gone, unknown };
}

const recent = (m, now, graceMs) => now.getTime() - Date.parse(m.sentAt) < graceMs;

/** A ledger entry (see account-gate pendingState) for a marker's order, as if it filled. */
function ledgerEntry(m, now, orderId = null) {
  return {
    contractId: m.contractId, sign: String(m.side).toLowerCase() === 'buy' ? 1 : -1, size: Number(m.size),
    netBefore: m.observedNet, rootNetBefore: Number.isFinite(m.observedRootNet) ? m.observedRootNet : m.observedNet,
    at: now.getTime(), sentAt: Date.parse(m.sentAt), orderId,
  };
}

/**
 * Ledger entries for unknown orders, as if they filled. For exits, only
 * market orders (an exit checks against the account as it would be if they
 * filled, so two exits can't flip it; limit and stop orders rest first: see
 * markerOrders). `anyType` counts every type, for cancel-protection: an entry
 * of unknown outcome, even a limit, may be filled and protected by the stop.
 * Only within the grace period: after it, the broker's account is the truth
 * (an order that never came would otherwise hold every exit back).
 */
function markerLedger(markers, now, graceMs = GRACE_MS, { anyType = false } = {}) {
  return markers
    .filter(m => !m.unreadable && (anyType || isMarket(m)) && Number.isFinite(m.observedNet) && Number(m.size) > 0 && recent(m, now, graceMs))
    .map(m => ledgerEntry(m, now));
}

/**
 * Ledger entries for orders settled as placed: like any order just sent,
 * counted until the account shows it (pendingState skips one that still
 * rests). One sent before the grace period already shows.
 */
function placedLedger(placed, now, graceMs = GRACE_MS) {
  return placed
    .filter(({ marker: m }) => Number.isFinite(m.observedNet) && Number(m.size) > 0 && recent(m, now, graceMs))
    .map(({ marker: m, order }) => ledgerEntry(m, now, String(order.id)));
}

/**
 * Settle an account's markers from the broker's orders. `searchOrders(args)`
 * calls search_orders and returns its list (throws on failure); `inFlight(m)`
 * says whether the caller still awaits that order's reply. Placed and gone
 * markers are removed (a failed removal goes to onError). Returns
 * { placed, gone, unknown, lookupFailed }.
 */
async function settleMarkers({ env, accountId, now, graceMs = GRACE_MS, searchOrders, inFlight = () => false, onError = () => {} }) {
  let mine;
  try {
    mine = markersFor(readMarkers(env), accountId);
  } catch (_err) {
    return { placed: [], gone: [], unknown: [{ tag: null, file: markerDir(env), unreadable: true }], lookupFailed: false };
  }
  if (!mine.length) return { placed: [], gone: [], unknown: [], lookupFailed: false };
  const readable = mine.filter(m => !m.unreadable);
  let orders = [];
  if (readable.length) {
    const from = new Date(Math.min(...readable.map(m => Date.parse(m.sentAt))) - LOOKBACK_MS).toISOString();
    try {
      orders = await searchOrders({ accountId: Number(accountId), startTimestamp: from });
      if (!Array.isArray(orders)) throw new Error('search_orders did not return a list');
    } catch (err) {
      onError(`could not look up orders of unknown outcome: ${err.message}`);
      return { placed: [], gone: [], unknown: mine, lookupFailed: true };
    }
  }
  const { placed, gone, unknown } = resolveMarkers(mine, orders, now, graceMs, { inFlight });
  for (const m of [...placed.map(p => p.marker), ...gone]) {
    try {
      removeMarker(env, m);
    } catch (err) {
      onError(`could not clear the record of order ${m.tag}: ${err.message}`);
    }
  }
  return { placed, gone, unknown, lookupFailed: false };
}

/**
 * Before a place_order is sent: pick its customTag and write its marker.
 * `inUse(tag)` says whether a call of the caller's own still carries the tag.
 * A tag already carried by an order of unknown outcome on the account is
 * refused for an entry (its record would be overwritten, then erased by the
 * reply) and replaced by a fresh one for an exit. An entry whose marker can't
 * be written is refused too: its outcome could not be tracked.
 * `contractId`: the name the gate compares (the gateway's one standard name), when it differs from the call's.
 * Returns { refuse } or { tag, args (with the customTag), error? }.
 */
function prepareSend({ env, args, risk, observed = null, inUse = () => false, now, contractId = args.contractId }) {
  let tag = tagFor(args);
  if (inUse(tag) || markerExists(env, args.accountId, tag)) {
    if (!risk) return { refuse: `customTag ${JSON.stringify(tag)} is in use by an order of unknown outcome on this account. Send the entry with another customTag (or none).` };
    tag = newTag();
  }
  let error = null;
  try {
    writeMarker(env, {
      tag, accountId: args.accountId, contractId, side: args.side, size: args.size, type: args.type, risk,
      args: { contractId: args.contractId, side: args.side, rationale: args.rationale, stopLossBracket: args.stopLossBracket },
      observedNet: observed ? observed.observedNet : null, observedRootNet: observed ? observed.observedRootNet : null, sentAt: now.toISOString(),
    });
  } catch (err) {
    if (!risk) return { refuse: `The gateway could not record the order before sending it (${err.message}), so an unknown outcome could not be tracked. The order was not sent.` };
    error = err.message;
  }
  return { tag, args: args.customTag === tag ? args : { ...args, customTag: tag }, error };
}

/** Unknown limit and stop orders (within the grace period) as the resting orders they probably are (interface order shape). */
function markerOrders(markers, now, graceMs = GRACE_MS) {
  return markers
    .filter(m => !m.unreadable && RESTING_TYPE[String(m.type || '').toLowerCase()] !== undefined && Number(m.size) > 0 && recent(m, now, graceMs))
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
    + 'Exits, stop moves and cancels are still checked as usual, with the unknown order counted as if it filled (a market order) or rests (a limit or stop); close_position always goes.';
}

/**
 * True when an isError reply to place_order says for sure the order was not
 * placed: a guardrail of the server, the contract translator refusing before
 * it sent anything, or the broker's own refusal (success: false with a code
 * other than OrderPending or UnknownError). Anything else (a timeout, a
 * broken connection, an unknown error) may hide a live order.
 */
function definitelyRefused(text) {
  const t = String(text || '').trim();
  if (/^Blocked by risk guardrail:/.test(t) || /^contract-translator: not sent:/.test(t)) return true;
  try {
    const r = JSON.parse(t);
    return Boolean(r) && r.success === false && Number.isFinite(Number(r.errorCode)) && ![6, 7].includes(Number(r.errorCode));
  } catch (_err) {
    return false;
  }
}

module.exports = {
  GRACE_MS, markerDir, newTag, tagFor, writeMarker, markerExists, removeMarker, readMarkers, markersFor, resolveMarkers, markerLedger, placedLedger,
  markerOrders, settleMarkers, prepareSend, pendingMessage, definitelyRefused,
};
