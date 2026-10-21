'use strict';

/**
 * The runner's factual reviews: the fixed part of a review, written in code for every entry the runner has seen end,
 * so the order gate's review-before-next-entry check (order-gate.js) never stalls a symbol on a review the model
 * skipped. The model's judgment (the grade, the mistakes, the regime) stays the trade-reviewer's (trade-review skill).
 *
 * Counted as the gate counts (order-gate.js successfulEntries against liveReviews, per contract root, today's): an
 * entry is covered by a review naming its order id; the reviews naming none (a model's) cover the oldest entries left,
 * in order. Only an uncovered entry gets one, so a trade is never reviewed twice (a second result: would count it twice
 * for the loss limits and the instincts).
 *
 * An uncovered entry gets:
 *   result:nofill         its order is no longer working and never filled: the broker's orders (search_orders) say it
 *                         was cancelled, expired or rejected (whatever else is open); else, with no position open on
 *                         its family and no filled volume shown, the runner cancelled it (expireComposed) or it was
 *                         placed ORDER_GRACE_MS ago (gate-timing.js: a broker may be slow to list a new order)
 *   result:win|loss|scratch  its own position (decision-history.js ownTrade: the broker's fills, by its order id) went
 *                         flat; R by decision-history.js rOf from the fill and exit prices over the planned stop
 *                         (entry-orders.json stopTicks, else the order's stopLossBracket) x the tick, net of fees
 *                         when they are known (netR): |R| under reviews.scratchR (config/runner.json) a scratch. With no planned stop, the price move's sign.
 * Its tags: by:runner, the result, setup:<name> (the rationale's tag, else the gateway's record), the root, and
 * r:<R net of fees> (the trade-review skill's r:) when the stop, the tick value and every fill's fees are known: the
 * price R less the trade's fees and commissions over its planned risk; its contractId the entry's own (so it counts on every root the entry counts on), its
 * orderId the entry's. Not told by the fills (another order's fill in the position, a close larger than it): no
 * review; the trade-reviewer reviews it.
 *
 *   coverage(dayEntries)               the uncovered entries: [{ entry, orderId, root (the gate's count's) }], oldest first
 *   unreviewedOn(dayEntries, root)     the gate's count of entries on the root with no review (0: none)
 *   reviewFor(c, ctx)                  { review } | { wait: why } for one uncovered entry
 *   writeReviews({ client, accountId, entries, entryOrders, now, cancelled, tickOf, tickValueOf, written, log, emit })
 *                                      one pass: the reviews due, each through client.journalAdd; returns the
 *                                      written ids (a failed write is logged and tried again next pass)
 *   unreviewedFor(env, symbol)         unreviewedOn for the local journal now (the compose_check rule; local only)
 *   tickValueFor(root, contracts)      the tick value of the root's own contract, never its family's
 */

const { entriesSince, entryTime, contractRoot, mayBeRoot, hasTag } = require('./journal');
const { tradingDayStart } = require('./clock');
const { familyRoot } = require('./contracts');
const { isOpen } = require('./positions');
const { ownTrade, rOf, sideOf, MIXED } = require('./decision-history');
const { ORDER_GRACE_MS } = require('./gate-timing');

const STATUS = require('../broker/interface').ENUMS.orderStatus;
// An order that ended without working on: its status word.
const ENDED = { [STATUS.cancelled]: 'cancelled', [STATUS.expired]: 'expired', [STATUS.rejected]: 'rejected' };
const REVIEWS = () => require('../tunables').runner().reviews; // config/runner.json
const SETUP_TAG = /^\s*setup:([a-z0-9][a-z0-9_-]*)\b/i;
const BY_RUNNER = 'by:runner';

const idOf = e => {
  const v = e && (e.orderId ?? (e.data && e.data.result && e.data.result.orderId));
  return v === undefined || v === null || v === '' ? null : String(v);
};
const famOf = id => familyRoot(contractRoot(id));

/** Today's (dayEntries) uncovered entries, oldest first: [{ entry, orderId, root }] (orderId null: none to name). */
function coverage(dayEntries) {
  const { successfulEntries, liveReviews } = require('./order-gate');
  const entries = successfulEntries(dayEntries).slice().sort((a, b) => entryTime(a) - entryTime(b));
  const out = new Map();
  for (const root of new Set(entries.map(e => contractRoot(e.contractId)))) {
    const list = entries.filter(e => mayBeRoot(e.contractId, root));
    const ids = new Set(list.map(idOf).filter(Boolean));
    const reviews = liveReviews(dayEntries, root);
    const named = new Set(reviews.map(idOf).filter(id => id && ids.has(id)));
    // Every review past one per named entry (one naming no entry, a second of one) covers the oldest entry left, as
    // the gate counts: never more reviews than entries.
    const rest = reviews.length - named.size;
    for (const e of list.filter(x => !named.has(idOf(x))).slice(rest)) {
      if (contractRoot(e.contractId) !== root) continue; // judged on its own root
      const key = idOf(e) || `t${entryTime(e)}`;
      if (!out.has(key)) out.set(key, { entry: e, orderId: idOf(e), root });
    }
  }
  return [...out.values()].sort((a, b) => entryTime(a.entry) - entryTime(b.entry));
}

/** The gate's count (order-gate.js review-before-next-entry): today's entries on `root` less its reviews, at least 0. */
function unreviewedOn(dayEntries, root) {
  const { successfulEntries, liveReviews } = require('./order-gate');
  return Math.max(0, successfulEntries(dayEntries).filter(e => mayBeRoot(e.contractId, root)).length - liveReviews(dayEntries, root).length);
}

/** An entry's contract by its standard name: the gateway's record's (the name it was sent with), else the journal's. */
const standardOf = (entry, record) => (record && typeof record.contractId === 'string' && record.contractId) || entry.contractId;

const fmt = x => String(Math.round(Number(x) * 100) / 100);

/**
 * One uncovered entry's review, or why it waits: { review } | { wait }. ctx: { orders, positions, fills, record (its
 * entry-orders.json entry or null), history (the broker's orders of the day: search_orders), cancelled (a Set of order ids
 * the runner cancelled), nowMs, tick, graceMs, scratchR }.
 */
/**
 * The price R less the trade's costs (its fills' fees and commissions, opening to closing, on its contract) over its
 * planned risk (the stop's ticks x the tick value x its size): the r: the trade-review skill writes. Null when the tick
 * value or any fill's fees are unknown (the tag is never a different measure).
 */
function netR(r, fills, t, stopTicks, tickValue) {
  const risk = Number(stopTicks) * Number(tickValue) * Number(t.size);
  if (!(risk > 0)) return null;
  const from = Date.parse(t.openedAt);
  const to = Date.parse(t.closedAt);
  const own = (fills || []).filter(f => f && f.voided !== true && f.contractId === t.contractId && Date.parse(f.creationTimestamp) >= from && Date.parse(f.creationTimestamp) <= to);
  if (!own.length || own.some(f => !Number.isFinite(f.fees))) return null;
  const costs = own.reduce((a, f) => a + f.fees + (Number.isFinite(f.commissions) ? f.commissions : 0), 0);
  return Math.round((r - costs / risk) * 100) / 100;
}

function reviewFor({ entry, orderId }, { orders = [], positions = [], fills = [], history = [], record = null, cancelled = new Set(), nowMs, tick = null, tickValue = null, graceMs = ORDER_GRACE_MS, scratchR = REVIEWS().scratchR }) {
  if (!orderId) return { wait: 'no order id to name' };
  // The contract by its standard name (the gateway's record holds the name the order was sent with; the journal the
  // broker's own id), as the account's positions and fills name it through the translator.
  const contract = standardOf(entry, record);
  const root = contractRoot(contract);
  if (orders.some(o => String(o.id) === orderId)) return { wait: 'still working' };
  const text = String(entry.text || '');
  const req = (entry.data && entry.data.request) || {};
  const setup = ((SETUP_TAG.exec(text) || [])[1] || (record && record.setup) || '').toLowerCase() || null;
  const side = sideOf(req.side) || sideOf(record && record.side);
  const tags = r => [BY_RUNNER, `result:${r}`, ...(setup ? [`setup:${setup}`] : []), root];
  const base = { kind: 'review', contractId: entry.contractId, orderId: Number(orderId) };
  const label = `${setup || 'entry'} ${side || ''}`.replace(/\s+$/, '');
  const own = (Array.isArray(fills) ? fills : []).filter(f => f && f.voided !== true && String(f.orderId) === orderId && Number.isFinite(Date.parse(f.creationTimestamp)));
  if (!own.length) {
    // No fill listed. Never a nofill while anything says it may have filled: the broker's order shows a filled volume
    // (a part fill, then a cancel), or a position is open on its family (its fills may lag).
    const listed = (Array.isArray(history) ? history : []).find(o => o && String(o.id) === orderId);
    if (listed && Number(listed.fillVolume) > 0) return { wait: 'filled (in part) at the broker, its fills not listed yet' };
    // The broker's own word first: cancelled, expired or rejected with nothing filled (search_orders), whatever else is
    // open on the family.
    if (listed && Object.prototype.hasOwnProperty.call(ENDED, Number(listed.status))) {
      return { review: { ...base, text: `runner: ${label} entry order ${orderId} on ${root} ended unfilled (${ENDED[Number(listed.status)]} at the broker; no fill). Facts only: the trade-reviewer adds the grade.`, tags: tags('nofill') } };
    }
    if (listed && Number(listed.status) === STATUS.filled) return { wait: 'filled at the broker, its fills not listed yet' };
    // Not said by the broker: never while a position is open on its family (its fills may lag); else the runner's own
    // cancel, or gone from the working orders longer than a broker may take to list one (the broker's orders read or not).
    if (positions.some(p => famOf(p.contractId) === famOf(contract) && isOpen(p))) return { wait: 'a position is open on its family: its fills may not be listed yet' };
    const at = Date.parse((record && record.at) || entry.ts);
    const graced = Number.isFinite(at) && nowMs - at >= graceMs;
    const gone = cancelled.has(orderId) ? 'cancelled by the runner (its record expired)' : graced ? 'no longer working' : null;
    if (!gone && history === null) return { wait: 'the broker\'s orders could not be read' };
    if (!gone) return { wait: 'too new to tell from the broker\'s orders' };
    return { review: { ...base, text: `runner: ${label} entry order ${orderId} on ${root} ended unfilled (${gone}; no fill). Facts only: the trade-reviewer adds the grade.`, tags: tags('nofill') } };
  }
  const from = new Date(Math.min(...own.map(f => Date.parse(f.creationTimestamp)))).toISOString();
  const t = ownTrade({ at: from, flatAt: true, side, orderId, contract }, fills, nowMs);
  // Closed only when its own closing fills add up to it (a later position on the family is another entry's).
  if (!t || t === MIXED || t.exit === null) {
    return { wait: positions.some(p => famOf(p.contractId) === famOf(contract) && isOpen(p)) ? 'its position may be open' : 'its outcome can\'t be told from the fills' };
  }
  const stopTicks = Number((record && record.stopTicks) || (req.stopLossBracket && req.stopLossBracket.ticks)) || null;
  const r = stopTicks && Number(tick) > 0 ? rOf(side, t.fill, t.exit, stopTicks * Number(tick)) : null;
  const move = (side === 'long' ? 1 : -1) * (t.exit - t.fill);
  const net = r !== null ? netR(r, fills, t, stopTicks, tickValue) : null;
  // Judged on the R the review states: net of fees when known (the skill's), else the price R.
  const rr = net !== null ? net : r;
  const result = rr !== null ? (Math.abs(rr) < scratchR ? 'scratch' : rr > 0 ? 'win' : 'loss') : move > 0 ? 'win' : move < 0 ? 'loss' : 'scratch';
  const rText = net !== null ? `${net > 0 ? '+' : ''}${fmt(net)}R net of fees on the planned ${stopTicks}-tick stop`
    : r !== null ? `${r > 0 ? '+' : ''}${fmt(r)}R before fees on the planned ${stopTicks}-tick stop (its fees unknown)` : 'R unknown (no planned stop recorded)';
  return { review: { ...base, text: `runner: ${label} ${t.size} ${root}, order ${orderId}: filled ${fmt(t.fill)}, out ${fmt(t.exit)} at ${t.closedAt}: ${result}, ${rText}. Facts only: the trade-reviewer adds the grade.`, tags: [...tags(result), ...(net !== null ? [`r:${fmt(net)}`] : [])] } };
}

/**
 * One pass: every uncovered entry of today that has ended gets its review through client.journalAdd. `entries`: the
 * journal (a list, or a function returning it); `written`: the ids already written (this trading day's), never
 * written again; returns them with this pass's. Reads the account only when an entry is uncovered, and the fills only
 * when one of those isn't working. A failed or errored write is logged and tried again on the next pass (the journal,
 * read again then, says whether it landed).
 */
async function writeReviews({ client, accountId, entries, entryOrders = [], now, cancelled = new Set(), tickOf = () => null, tickValueOf = () => null, written = [], waits = new Map(), log = () => {}, emit = () => {} }) {
  const done = new Set((written || []).map(String));
  if (!client || typeof client.journalAdd !== 'function' || typeof client.accountState !== 'function') return [...done];
  const all = typeof entries === 'function' ? entries() : entries;
  const day = entriesSince(Array.isArray(all) ? all : [], tradingDayStart(now));
  const todo = coverage(day).filter(c => c.orderId && !done.has(c.orderId));
  if (!todo.length) return [...done];
  const { orders, positions } = await client.accountState(accountId);
  const working = new Set((orders || []).map(o => String(o.id)));
  const ended = todo.some(c => !working.has(c.orderId));
  const fills = ended && typeof client.fillsSince === 'function' ? await client.fillsSince(accountId, tradingDayStart(now)) : [];
  // The broker's orders of the day (search_orders), for an entry gone with no fill: how it ended. Unread: the fallbacks.
  let history = null;
  if (ended && typeof client.ordersSince === 'function') {
    try {
      history = await client.ordersSince(accountId, tradingDayStart(now));
    } catch (err) {
      log(`the broker's orders could not be read for the reviews (${err.message})`, 'error');
    }
  }
  const records = new Map((entryOrders || []).map(e => [String(e.orderId), e]));
  for (const c of todo) {
    const record = records.get(c.orderId) || null;
    const root = contractRoot(standardOf(c.entry, record));
    const out = reviewFor(c, { orders: orders || [], positions: positions || [], fills: Array.isArray(fills) ? fills : [], history, record, cancelled, nowMs: now.getTime(), tick: tickOf(root), tickValue: tickValueOf(root) });
    if (!out.review) {
      // Why it waits, said once per entry and again only when the reason changes (`waits`: the caller's, per process).
      if (waits.get(c.orderId) !== out.wait) log(`${root}: no review of entry ${c.orderId} yet: ${out.wait}`);
      waits.set(c.orderId, out.wait);
      continue;
    }
    waits.delete(c.orderId);
    try {
      const res = await client.journalAdd(out.review);
      if (!res || typeof res !== 'object' || res.kind !== 'review') throw new Error('the broker returned no journal entry');
      done.add(c.orderId);
      log(`${root}: wrote the runner's review of entry ${c.orderId} (${out.review.tags[1]})`);
      emit('review_written', { orderId: c.orderId, contractId: c.entry.contractId, tags: out.review.tags });
    } catch (err) {
      log(`${root}: could not write the review of entry ${c.orderId} (${err.message}); the next bar tries again`, 'error');
      emit('review_failed', { orderId: c.orderId, error: err.message });
    }
  }
  return [...done];
}

/**
 * The tick value of `root`'s own contract (a mini's is not its micro's): the standard table's (contracts.js specFor),
 * else the broker's contract of that exact root among `contracts` ([{ contractId, tickValue }]), else null.
 */
function tickValueFor(root, contracts = []) {
  const spec = require('./contracts').specFor(root);
  if (spec && Number(spec.tickValue) > 0) return Number(spec.tickValue);
  const c = (contracts || []).find(x => x && x.contractId && contractRoot(x.contractId) === root && Number(x.tickValue) > 0);
  return c ? Number(c.tickValue) : null;
}

/** unreviewedOn for `symbol` from the local journal at the harness clock now (reads only local files). */
function unreviewedFor(env, symbol) {
  const { resolveJournalPath, readJournalWindow } = require('./journal');
  const now = require('./harness-now').recordNow(env);
  const day = entriesSince(readJournalWindow(resolveJournalPath(env)).entries, tradingDayStart(now));
  return unreviewedOn(day, contractRoot(symbol));
}

module.exports = { BY_RUNNER, coverage, unreviewedOn, reviewFor, writeReviews, unreviewedFor, tickValueFor, isRunnerReview: e => hasTag(e, BY_RUNNER) };
