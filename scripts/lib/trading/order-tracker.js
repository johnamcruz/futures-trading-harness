'use strict';

/**
 * The gateway's view of its order calls' outcomes, on top of order-markers.js
 * (the records on disk). One tracker per gateway process:
 *
 *   tagRequest(msg, { observed, now })            tag a place_order request and write its record (beforeSend)
 *   onReply(id, msg)                                a reply settles the record, unless it may hide a live order
 *   settle(accountId, now, { isWaiting })           settle this account's records from the broker's orders
 *   cancelLedger / exitLedger / exitOrders          unknown orders as the gate counts them
 *   pendingViolation / annotateExposure             the messages
 *
 * It also writes <FTH_HOME>/entry-orders.json (recordEntryOrder): the entries
 * the gateway let through, which the runner's cleanup and trailing manager read.
 */

const path = require('path');
const markers = require('./order-markers');
const { PENDING_ORDER_TTL_MS } = require('./gate-timing');
const { harnessHome } = require('../paths');
const { writeJsonAtomic, readJson } = require('../harness-run');
const { isRiskReducing } = require('./order-gate');

const PLACE_ORDER = /(?:^|__)place_order$/;

const ENTRY_ORDERS_KEPT = require('../tunables').runner().limits.entryOrdersKept; // config/runner.json
const STOP_PRICE = /\bstop(?:\s+at)?\s*[:=@]?\s*(\d+(?:\.\d+)?)\b/i;

/**
 * Remember an entry (setup:<name>) the gateway let through: the runner's
 * flat-account cleanup tells a pending entry from a leftover stop or target
 * by id, and its trailing-stop manager needs the strategy, the planned stop
 * (bracket ticks or the "stop <price>" in the rationale) and when it was sent.
 * Best effort; an id already recorded is kept as it is.
 */
function recordEntryOrder(env, orderId, args, at, onError = () => {}, stamp = null, pendingKey = null) {
  try {
    const file = path.join(harnessHome(env), 'entry-orders.json');
    const list = readJson(file, []);
    if (Array.isArray(list) && list.some(e => String(e.orderId) === String(orderId))) return;
    const setup = /^\s*setup:([a-z0-9][a-z0-9_-]*)/i.exec(String(args.rationale || ''));
    // The planned stop is the last "stop <price>" ("buy stop 21510 above the high, stop 21490" plans 21490).
    const stops = [...String(args.rationale || '').matchAll(new RegExp(STOP_PRICE.source, 'gi'))];
    const stop = stops.length ? stops[stops.length - 1] : null;
    const entry = {
      orderId, contractId: args.contractId, side: String(args.side || '').toLowerCase(), setup: setup ? setup[1].toLowerCase() : null,
      stopTicks: args.stopLossBracket && Number(args.stopLossBracket.ticks) > 0 ? Number(args.stopLossBracket.ticks) : null,
      // The entry's own target (its takeProfitBracket), for a trail past it (exit mode target_then_trail, exit-trail.js).
      ...(args.takeProfitBracket && Number.isInteger(Number(args.takeProfitBracket.ticks)) && Number(args.takeProfitBracket.ticks) > 0 ? { targetTicks: Number(args.takeProfitBracket.ticks) } : {}),
      stopPrice: stop ? Number(stop[1]) : null, at: new Date(at).toISOString(),
      // A composed entry (trade_lifecycle): its compose record on the cycle's bar and that record's expiry, at placement,
      // so the runner cancels it unfilled at the expiry, a restart in between too (lifecycle-runner.js dueComposed).
      // The gate's own stamp (the record it judged, the expiry it computed), handed over at the reply or written before
      // the order went (keyed by its customTag); never looked up again here.
      ...(() => { const c = require('./lifecycle-runner').entryStamp(env, args, stamp, pendingKey); return c ? { composed: c } : {}; })(),
    };
    writeJsonAtomic(file, [...(Array.isArray(list) ? list : []), entry].slice(-ENTRY_ORDERS_KEPT));
  } catch (err) {
    onError(`could not record entry order ${orderId}: ${err.message}`);
  }
}

/**
 * The grace period: markers.GRACE_MS, never shorter than a lane's wait plus
 * PENDING_ORDER_TTL_MS (an order still in another gateway's lane isn't "gone"). Tests may
 * shorten it (FTH_UNKNOWN_ORDER_GRACE_MS); a live or autonomous run can't.
 */
function graceFor(env, laneTimeoutMs) {
  const asked = Number(env.FTH_UNKNOWN_ORDER_GRACE_MS);
  const test = env.NODE_ENV === 'test' && env.FTH_AUTONOMOUS !== '1';
  return Math.max(test && asked > 0 ? asked : markers.GRACE_MS, laneTimeoutMs + PENDING_ORDER_TTL_MS);
}

function createOrderTracker({ env, graceMs, searchOrders, onError = () => {}, canon = a => a }) {
  // A record kept under a bare root (no front month recorded when it was written): named by the month it went to,
  // once the translator has looked the front month up to send it.
  const pinName = t => {
    if (typeof t.name !== 'function') return;
    try {
      const m = markers.readMarkers(env).find(x => x.tag === t.tag && String(x.accountId) === String(t.accountId));
      const std = m && require('../broker/translator').parseStandardName(m.contractId);
      if (!std || std.month) return;
      const named = t.name();
      if (named !== m.contractId) markers.writeMarker(env, { ...Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'file')), contractId: named });
    } catch (err) {
      onError(`could not name the record of order ${t.tag} by its month: ${err.message}`);
    }
  };
  // Client request id -> { accountId, tag } of the place_order it carries, until its reply.
  const tagOf = new Map();
  const ownCall = m => [...tagOf.entries()].find(([, t]) => t.tag === m.tag && String(t.accountId) === String(m.accountId));
  const recent = (m, now) => !m.unreadable && now.getTime() - Date.parse(m.sentAt) < graceMs;

  return {
    graceMs,

    /**
     * Before a place_order goes out: { refuse: { check, message } } or { args (tagged) }.
     * An order without an accountId can't be tracked per account: an entry is refused,
     * an exit goes untracked (the server refuses it anyway; the interface requires one).
     */
    beforeSend({ id, args, risk, observed, now }) {
      if (args.accountId === undefined || args.accountId === null || args.accountId === '') {
        return risk ? { args } : { refuse: { check: 'account-required', message: 'place_order needs an accountId: the gateway tracks each order\'s outcome per account.' } };
      }
      const inUse = t => [...tagOf.values()].some(x => x.tag === t && String(x.accountId) === String(args.accountId));
      // Its record carries the contract by its month in the gate's naming (canon, ledgerName), so exits and stops
      // count it, and a root that means another month from the next trading day never moves it. A root not yet
      // resolvable (no front month recorded today) is resolved again once the call has gone out (pinName).
      // The naming taken once, when the record is written: a rename after the trading day changed fails its guard
      // and keeps the root (as recordSent does), never naming it by the next day's front month.
      const checked = canon(args);
      const name = () => require('./account-gate').ledgerName(checked);
      const prep = markers.prepareSend({ env, args, risk, observed, inUse, now, contractId: name() });
      if (prep.refuse) return { refuse: { check: 'order-pending', message: prep.refuse } };
      if (prep.error) onError(`could not record ${prep.tag} before sending it: ${prep.error}`);
      // A composed entry's stamp from the gate (the gateway's check, observed.composed), on disk before it goes; every
      // other entry clears its key, so a reused tag never carries an old stamp.
      if (!risk) {
        try {
          const LR = require('./lifecycle-runner');
          const key = LR.pendingKey(args.accountId, prep.tag);
          if (observed && observed.composed) LR.writePendingStamp(env, key, observed.composed);
          else LR.clearPendingStamp(env, key);
        } catch (err) { onError(`could not stamp ${prep.tag}: ${err.message}`); }
      }
      if (id !== undefined) tagOf.set(id, { accountId: args.accountId, tag: prep.tag, name });
      return prep;
    },

    /**
     * A client message about to be forwarded: a place_order tools/call goes out
     * tagged, with its record written first (beforeSend). Anything else is
     * returned as it is. Returns { msg } (the message to send) or { refuse }.
     */
    tagRequest(msg, { observed = null, now }) {
      if (!msg || Array.isArray(msg) || msg.method !== 'tools/call' || !msg.params || !PLACE_ORDER.test(String(msg.params.name || ''))) return { msg };
      const args = msg.params.arguments || {};
      const prep = this.beforeSend({ id: msg.id, args, risk: isRiskReducing(args.rationale), observed, now });
      if (prep.refuse) return prep;
      return { msg: prep.args === args ? msg : { ...msg, params: { ...msg.params, arguments: prep.args } } };
    },

    /**
     * A reply settles the order's outcome when it is a result or a sure
     * refusal. Any other error (the server's own call to the broker timed out
     * or broke) may hide a live order: its record stays for settle.
     */
    onReply(id, msg) {
      const t = tagOf.get(id);
      tagOf.delete(id);
      if (!t) return;
      const r = msg && msg.result;
      if (!msg || msg.error || (r && r.isError && !markers.definitelyRefused(r.content && r.content[0] ? r.content[0].text : ''))) {
        pinName(t); // the record stays: by its month
        return;
      }
      try {
        markers.removeMarker(env, t);
      } catch (err) {
        onError(`could not clear the record of order ${t.tag}: ${err.message}`);
      }
      // Settled by its reply: the gateway stamps it from its own check (recordSent), so its pending stamp goes.
      try { const LR = require('./lifecycle-runner'); LR.clearPendingStamp(env, LR.pendingKey(t.accountId, t.tag)); } catch (err) { onError(`could not clear the stamp of ${t.tag}: ${err.message}`); }
    },

    /** A place_order whose reply is overdue: its record stays, by its month once the translator has resolved it. */
    onOverdue(id) {
      const t = tagOf.get(id);
      if (t) pinName(t);
    },

    /**
     * Settle the account's records from the broker's orders. `isWaiting(id)`
     * says whether the caller still awaits that request's reply (its order is
     * never "gone"). Entries found placed are recorded for the runner, at the
     * time they were sent. Returns { unknown, lookupFailed, ledger (entries
     * for orders found placed), settledIds (own requests a late reply must not
     * count again) }.
     */
    async settle(accountId, now, { isWaiting = () => false } = {}) {
      const r = await markers.settleMarkers({
        env, accountId, now, graceMs, searchOrders, onError,
        inFlight: m => { const own = ownCall(m); return Boolean(own && isWaiting(own[0])); },
      });
      const settledIds = [];
      for (const { marker: m, order } of r.placed) {
        const own = ownCall(m);
        if (own) { tagOf.delete(own[0]); settledIds.push(own[0]); }
        if (!m.risk && order.id !== undefined && order.id !== null) recordEntryOrder(env, order.id, m.args || m, Date.parse(m.sentAt), onError, null, require('./lifecycle-runner').pendingKey(m.accountId, m.tag));
      }
      // Not placed: a reply that still comes later is recorded as usual.
      for (const m of r.gone) { const own = ownCall(m); if (own) tagOf.delete(own[0]); }
      return { unknown: r.unknown, lookupFailed: r.lookupFailed, ledger: markers.placedLedger(r.placed, now, graceMs), settledIds };
    },

    /** For cancel-protection: unknown entries of any type count as filled (their bracket stop may protect them). */
    cancelLedger: (unknown, now) => markers.markerLedger(unknown.filter(m => !m.risk), now, graceMs, { anyType: true }),
    /** For an exit: unknown market orders count as filled, unknown limits and stops as resting. */
    exitLedger: (unknown, now) => markers.markerLedger(unknown, now, graceMs),
    exitOrders: (unknown, now) => markers.markerOrders(unknown, now, graceMs),

    pendingViolation: (unknown, now, lookupFailed) => ({ check: 'order-pending', message: markers.pendingMessage(unknown, now, graceMs, { lookupFailed }) }),

    /** Name the unknown orders an exit was counted against in its exposure refusals. */
    annotateExposure(violations, unknown, now) {
      const counted = unknown.filter(m => recent(m, now));
      if (!counted.length) return;
      const one = counted.length === 1;
      for (const v of violations.filter(x => x.check === 'exposure')) {
        v.message += ` This counts ${one ? 'an order' : `${counted.length} orders`} of unknown outcome (customTag ${counted.map(m => m.tag).join(', ')}) `
          + `as if ${one ? 'it' : 'they'} went through, until the broker's orders settle ${one ? 'it' : 'them'} (at most ${Math.round(graceMs / 60000)} min). close_position flattens now.`;
      }
    },
  };
}

module.exports = { recordEntryOrder, graceFor, createOrderTracker };
