'use strict';

/**
 * No late entry (the owner's rule, 2026-10-21: "if you miss the move don't enter late"). A composed entry is valid only
 * at its plan: when the market has left the plan by the time the order would go, it is a pass, never a late fill. A
 * buy limit above the market (a sell limit below it) fills at once as a marketable order, away from the plan's entry,
 * and the broker's brackets are distances from the fill, so its stop lands off the structure level the plan named.
 *
 * The latest price comes from local state only (hooks and the gateway read no network): the newest of
 *   - the price the runner recorded just before its entry's order (runner-entry.js: the newest closed 1m bar it read
 *     through the adapter), kept per family root in <home>/latest-price.json (recordPrice);
 *   - the cycle bar briefing's own close (its `price` at its `closedAt`).
 * Each counts only within the signal age limit of its own bars (signal-state.js signalMaxAgeMin, the rule the gate's
 * briefing-age check uses) and not dated after now (beyond the gate's future tolerance); none that counts: refused (fails closed). Entries only: exits,
 * protective stops, stop moves and closes never reach it (order-gate.js returns before every entry check).
 *
 *   recordPrice(home, root, { price, closedAt, minutes, source })   keep the latest price for the root's family
 *   readPrice(home, root)          { price, closedAt, minutes, source } or null
 *   latestPrice({ home, root, briefing, now, maxAgeMin })   { price, closedAt, source } | { price: null, why }
 *                                  maxAgeMin(minutes): the age limit of a price from bars of that many minutes
 *   lateEntry({ side, entry, stop, price, share })   null (the plan stands at this price) or { kind, message }:
 *                                  kind `beyond-stop` (short: price >= stop; long: price <= stop) or `missed-entry`
 *                                  (price past the entry against the trade by more than `share` of the stop distance)
 *                                  A price the trade's way past the entry is no refusal: the limit rests at the plan's
 *                                  price and expires with its record (lifecycle-runner.js dueComposed); never chased.
 *   lateEntryRefusal({ home, root, side, entry, stop, briefing, now, share, maxAgeMin })   the refusal's message or null
 *   ageLimitOf(config)             maxAgeMin from the gate's config (loadConfig): its signal age bars, cap and ceiling
 */

const path = require('path');
const { familyRoot } = require('./contracts');
const { signalMaxAgeMin } = require('./signal-state');

const EPS = 1e-9;
const FUTURE_MIN = require('../tunables').runner().gate.futureToleranceMin; // config/runner.json: a clock's slack, as signal-state's
const FILE = 'latest-price.json';
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const keyOf = root => familyRoot(String(root || '').toUpperCase());
const priceFile = home => path.join(home, FILE);

function recordPrice(home, root, { price, closedAt, minutes = null, source = null } = {}) {
  const { readJson, writeJsonAtomic } = require('../harness-run');
  const p = Number(price);
  const at = Date.parse(closedAt);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(at)) throw new Error(`not a price at a time: ${JSON.stringify({ price, closedAt })}`);
  const all = readJson(priceFile(home), {});
  const kept = isObj(all) ? all : {};
  const old = isObj(kept[keyOf(root)]) ? Date.parse(kept[keyOf(root)].closedAt) : NaN;
  // Never back in time: an older bar read late keeps the newer one.
  if (Number.isFinite(old) && old > at) return kept[keyOf(root)];
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
  const seen = [];
  const candidates = [];
  let recorded = null;
  try { recorded = readPrice(home, root); } catch (_err) { recorded = null; }
  if (recorded) candidates.push({ price: recorded.price, closedAt: recorded.closedAt, minutes: recorded.minutes || 1, source: recorded.source || 'recorded' });
  if (isObj(briefing) && Number.isFinite(Number(briefing.price)) && Number.isFinite(Date.parse(briefing.closedAt))) {
    candidates.push({ price: Number(briefing.price), closedAt: briefing.closedAt, minutes: Number.isInteger(briefing.minutes) && briefing.minutes > 0 ? briefing.minutes : 1, source: 'briefing' });
  }
  const fresh = candidates.filter(c => {
    const age = (now.getTime() - Date.parse(c.closedAt)) / 60000;
    const limit = maxAgeMin(c.minutes);
    const ok = age >= -FUTURE_MIN && age <= limit;
    if (!ok) seen.push(`${c.source} ${c.price} closed ${age.toFixed(1)} min ago (limit ${limit} min)`);
    return ok;
  });
  if (!fresh.length) return { price: null, why: seen.length ? `none current: ${seen.join('; ')}` : 'no local bar' };
  const best = fresh.reduce((a, b) => (Date.parse(b.closedAt) > Date.parse(a.closedAt) ? b : a));
  return { price: best.price, closedAt: best.closedAt, source: best.source };
}

function lateEntry({ side, entry, stop, price, share }) {
  const sign = side === 'long' ? 1 : side === 'short' ? -1 : 0;
  const e = Number(entry);
  const s = Number(stop);
  const p = Number(price);
  if (!sign || ![e, s, p, share].every(Number.isFinite) || !(sign * (e - s) > 0)) return { kind: 'unreadable', message: `the plan (a ${side} at ${entry}, stop ${stop}) or the price ${price} can't be checked` };
  if (sign * (p - s) <= EPS) return { kind: 'beyond-stop', message: `the setup was invalidated before the order went (price ${p} beyond the plan's stop ${s}): no late entry` };
  const against = sign * (e - p);
  const allowed = share * sign * (e - s);
  if (against > allowed + EPS) {
    return { kind: 'missed-entry', message: `missed the plan's entry ${e} (price ${p} is ${+against.toFixed(6)} points past it against the ${side}, over ${share} of the ${+(sign * (e - s)).toFixed(6)}-point stop): the limit would fill away from the plan: no late entry` };
  }
  return null;
}

function lateEntryRefusal({ home, root, side, entry, stop, briefing = null, now = new Date(), share, maxAgeMin }) {
  try {
    const got = latestPrice({ home, root, briefing, now, maxAgeMin });
    if (got.price === null) return `no current price for ${keyOf(root)} from local bars (${got.why}): the plan's entry and stop can't be checked against the market, so no entry (fails closed)`;
    const late = lateEntry({ side, entry, stop, price: got.price, share });
    return late ? `${late.message} (the ${got.source} price at ${got.closedAt}). Pass; the next bar composes on its own facts` : null;
  } catch (err) {
    return `the late-entry check failed (${err.message}): no entry (fails closed)`;
  }
}

const ageLimitOf = config => minutes => signalMaxAgeMin(`${minutes}m`, { bars: config.signalMaxAgeBars, capMin: config.signalMaxAgeCapMin, ceilingMin: config.signalMaxAgeCeilingMin });

module.exports = { FILE, recordPrice, readPrice, latestPrice, lateEntry, lateEntryRefusal, ageLimitOf };
