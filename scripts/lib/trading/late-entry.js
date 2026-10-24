'use strict';

/**
 * No late entry (the owner's rule, 2026-10-21: "if you miss the move don't enter late"). A composed entry is valid only
 * at its plan: when the market has left the plan by the time the order would go, it is a pass, never a late fill. A
 * buy limit above the market (a sell limit below it) fills at once as a marketable order, away from the plan's entry,
 * and the broker's brackets are distances from the fill, so its stop lands off the structure level the plan named.
 *
 * This module reads only local state (the hook calls it): the newest of
 *   - the price recorded for the order: by the gateway at the order itself (account-gate.js freshEntryPrice: the
 *     broker's newest closed 1m bar, read through the server it wraps; a failed read refuses the entry there), and by
 *     the runner just before its entry's order (runner-entry.js: the newest closed 1m bar it read through the adapter),
 *     kept per family root in <home>/latest-price.json (recordPrice);
 *   - the cycle bar briefing's own close (its `price` at its `closedAt`).
 * The newest of them is judged alone (a stale newest never falls back to an older one), within the signal age limit of its own bars (signal-state.js signalMaxAgeMin, the rule the gate's
 * briefing-age check uses) and not dated after now (beyond the gate's future tolerance); none that counts: refused (fails closed). Entries only: exits,
 * protective stops, stop moves and closes never reach it (order-gate.js returns before every entry check). A harness
 * whose head trader places its own entry (no runner's entry) records no fresh price: there the briefing's close alone
 * is checked, which is the plan's entry when composed on it, so the check holds little there (not a refusal).
 *
 *   recordPrice(home, root, { price, closedAt, minutes, source }, { now, log })   keep the latest price for the root's
 *                                  family: a newer kept one wins (logged), unless it is dated after now (replaced)
 *   readPrice(home, root)          { price, closedAt, minutes, source } or null
 *   latestPrice({ home, root, briefing, now, maxAgeMin })   { price, closedAt, source } | { price: null, why }
 *                                  maxAgeMin(minutes): the age limit of a price from bars of that many minutes
 *   lateEntry({ side, entry, stop, price, share })   null (the plan stands at this price) or { kind, message }:
 *                                  kind `beyond-stop` (short: price >= stop; long: price <= stop) or `missed-entry`
 *                                  (price past the entry against the trade by more than `share` of the stop distance:
 *                                  movedR, the share of the plan's risk moved toward the stop, the same for a long and a
 *                                  short; share: config/runner.json gate.lateEntryDriftShare, tighten-only)
 *                                  A price the trade's way past the entry is no refusal: the limit rests at the plan's
 *                                  price and expires with its record (lifecycle-runner.js dueComposed); never chased.
 *   lateEntryCheck({ home, root, side, entry, stop, target, briefing, now, share, maxAgeMin })   null or { message, late }
 *                                  (late: the skip as logged: the plan's prices, the price at the skip, movedR)
 *   lateEntryRefusal({ ... })      the refusal's message or null
 *   ageLimitOf(config)             maxAgeMin from the gate's config (loadConfig): its signal age bars, cap and ceiling
 */

const path = require('path');
const { familyRoot } = require('./contracts');
const { signalMaxAgeMin } = require('./signal-state');

const FUTURE_MIN = require('../tunables').runner().gate.futureToleranceMin; // config/runner.json: a clock's slack, as signal-state's
const FILE = 'latest-price.json';
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const keyOf = root => familyRoot(String(root || '').toUpperCase());
const priceFile = home => path.join(home, FILE);

function recordPrice(home, root, { price, closedAt, minutes = null, source = null } = {}, { now = new Date(), log = () => {} } = {}) {
  const { readJson, writeJsonAtomic } = require('../harness-run');
  const p = Number(price);
  const at = Date.parse(closedAt);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(at)) throw new Error(`not a price at a time: ${JSON.stringify({ price, closedAt })}`);
  const all = readJson(priceFile(home), {});
  const kept = isObj(all) ? all : {};
  const old = isObj(kept[keyOf(root)]) ? Date.parse(kept[keyOf(root)].closedAt) : NaN;
  // Never back in time: an older bar read late keeps the newer one, said; a kept one dated after now (past the gate's
  // future tolerance: a clock that jumped) is no price of now, and is replaced.
  const future = Number.isFinite(old) && old > now.getTime() + FUTURE_MIN * 60000;
  if (Number.isFinite(old) && old > at && !future) {
    log(`the latest price kept for ${keyOf(root)} (${kept[keyOf(root)].price} closed ${kept[keyOf(root)].closedAt}) is newer than this one (${p} closed ${new Date(at).toISOString()}): kept`);
    return kept[keyOf(root)];
  }
  const rec = { price: p, closedAt: new Date(at).toISOString(), minutes: Number.isInteger(minutes) && minutes > 0 ? minutes : null, source };
  writeJsonAtomic(priceFile(home), { ...kept, [keyOf(root)]: rec });
  return rec;
}

function readPrice(home, root) {
  const all = require('../harness-run').readJson(priceFile(home), {});
  const r = isObj(all) ? all[keyOf(root)] : null;
  return isObj(r) && Number.isFinite(Number(r.price)) && Number.isFinite(Date.parse(r.closedAt)) ? { ...r, price: Number(r.price) } : null;
}

function latestPrice({ home, root, briefing = null, now = new Date(), maxAgeMin }) {
  const candidates = [];
  let recorded;
  try { recorded = readPrice(home, root); } catch (_err) { recorded = null; }
  if (recorded) candidates.push({ price: recorded.price, closedAt: recorded.closedAt, minutes: recorded.minutes || 1, source: recorded.source || 'recorded' });
  if (isObj(briefing) && Number.isFinite(Number(briefing.price)) && Number.isFinite(Date.parse(briefing.closedAt))) {
    candidates.push({ price: Number(briefing.price), closedAt: briefing.closedAt, minutes: Number.isInteger(briefing.minutes) && briefing.minutes > 0 ? briefing.minutes : 1, source: 'briefing' });
  }
  if (!candidates.length) return { price: null, why: 'no local bar' };
  // The newest alone is judged: a stale newest never falls back to an older price (fails closed).
  const best = candidates.reduce((a, b) => (Date.parse(b.closedAt) > Date.parse(a.closedAt) ? b : a));
  const age = (now.getTime() - Date.parse(best.closedAt)) / 60000;
  const limit = maxAgeMin(best.minutes);
  if (!(age >= -FUTURE_MIN && age <= limit)) return { price: null, why: `the newest is not current: ${best.source} ${best.price} closed ${age.toFixed(1)} min ago (limit ${limit} min)` };
  return { price: best.price, closedAt: best.closedAt, source: best.source };
}

function lateEntry({ side, entry, stop, price, share }) {
  const sign = side === 'long' ? 1 : side === 'short' ? -1 : 0;
  const e = Number(entry);
  const s = Number(stop);
  const p = Number(price);
  if (!sign || ![e, s, p, share].every(Number.isFinite) || !(sign * (e - s) > 0)) return { kind: 'unreadable', message: `the plan (a ${side} at ${entry}, stop ${stop}) or the price ${price} can't be checked` };
  if (sign * (p - s) <= 0) return { kind: 'beyond-stop', message: `the setup was invalidated before the order went (price ${p} beyond the plan's stop ${s}): no late entry` };
  const against = sign * (e - p);
  const risk = sign * (e - s);
  // The share of the plan's risk (entry to stop) price has moved toward the stop, symmetric for a long and a short.
  const movedR = Math.round((against / risk) * 1000) / 1000;
  if (against > share * risk) {
    return { kind: 'missed-entry', movedR, message: `missed the plan's entry ${e} (price ${p} is ${Math.round(against * 1e6) / 1e6} points past it against the ${side}: ${Math.round(movedR * 100)}% of the ${risk}-point risk toward the stop, over ${share}R; the setup's premise is in question): the limit would fill away from the plan: no late entry` };
  }
  return null;
}

/**
 * The late-entry check with what a skip is logged with: null (the plan stands) or { message, late: { kind, side,
 * entry, stop, target, price, closedAt, source, movedR, share } } (kind: beyond-stop, missed-entry, no-price, failed).
 */
function lateEntryCheck({ home, root, side, entry, stop, target = null, briefing = null, now = new Date(), share, maxAgeMin }) {
  const base = { side, entry: Number(entry), stop: Number(stop), target: target === null ? null : Number(target), share };
  try {
    const got = latestPrice({ home, root, briefing, now, maxAgeMin });
    if (got.price === null) return { message: `no current price for ${keyOf(root)} from local bars (${got.why}): the plan's entry and stop can't be checked against the market, so no entry (fails closed)`, late: { ...base, kind: 'no-price', price: null, closedAt: null, source: null, movedR: null } };
    const late = lateEntry({ side, entry, stop, price: got.price, share });
    if (!late) return null;
    return { message: `${late.message} (the ${got.source} price at ${got.closedAt}). Pass; the next bar composes on its own facts`, late: { ...base, kind: late.kind, price: got.price, closedAt: got.closedAt, source: got.source, movedR: late.movedR ?? null } };
  } catch (err) {
    return { message: `the late-entry check failed (${err.message}): no entry (fails closed)`, late: { ...base, kind: 'failed', price: null, closedAt: null, source: null, movedR: null } };
  }
}

function lateEntryRefusal(args) {
  const r = lateEntryCheck(args);
  return r ? r.message : null;
}

const ageLimitOf = config => minutes => signalMaxAgeMin(`${minutes}m`, { bars: config.signalMaxAgeBars, capMin: config.signalMaxAgeCapMin, ceilingMin: config.signalMaxAgeCeilingMin });

module.exports = { FILE, recordPrice, readPrice, latestPrice, lateEntry, lateEntryCheck, lateEntryRefusal, ageLimitOf };
