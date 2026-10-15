'use strict';

/**
 * The runner's side of the trade lifecycle (the composed-entry design: D11 and section 5):
 *
 *   composedSetups(strategies)        the setup tags a composed entry goes under: every valid composed strategy
 *                                     (trade_lifecycle) and every policy listing one
 *   composedLaneErrors(lanes, strategies)   a lane that lists a composed strategy, or a policy listing one, on trigger
 *                                     "signal": nothing fires for it, so it would never cycle (D11: every bar)
 *   runsComposed(strategies, timeframe)   an active composed strategy trades this timeframe (the journal instincts are
 *                                     off for such a run: the experience record replaces them)
 *   isComposedEntry(env, args, root)  an entry (place_order arguments) of a composed setup (its tag), by the registry
 *   writePendingStamp(env, tag, stamp) / pendingStamp(env, tag)   the gate's stamp on a composed entry (the record it
 *                                     judged, the expiry it computed, the entry price, the side), written before the
 *                                     order goes (keyed by its customTag) so an order found placed later carries it
 *   entryStamp(env, args, stamp, tag)  the stamp entry-orders.json keeps: the gate's (given, or pending by tag); a
 *                                     composed entry without one gets { record: null, expiresAt: null } (due at once);
 *                                     another setup's: null. Never re-looked-up at reply time
 *   dueComposed({ entries, orders, composed, now })   the working orders that are composed entries (their gateway
 *                                     record's setup) whose stamped expiry has come, or that have no readable expiry
 *                                     (stamped without a record, or not stamped: after a restart too): [{ order, entry }]
 *   unrecordedEntries({ entries, orders, positions, root })   on a lane that runs only composed strategies: the
 *                                     working limit orders on the root the gateway never recorded as entries, flat or
 *                                     adding to the position's side (a bracket's target, the other side, stays)
 *   recordSummary(record)             a record as the decision history and the cycle log keep it: id, side, ok, the
 *                                     signatures, the stated size, the stop and target, each read with its check
 *   cycleComposed(home, cycleId, symbols)   the records the cycle's compose_check calls wrote (their cycleId)
 *
 * The runner cancels a due order (runner.js housekeeping): the broker interface has no time in force, so an unfilled
 * composed limit never outlives its record.
 */

const path = require('path');
const { contractRoot } = require('./journal');
const { familyRoot } = require('./contracts');
const { readRecords } = require('./trade-lifecycle');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function composedSetups(strategies) {
  const all = (strategies || []).filter(s => s && s.valid !== false);
  const composed = all.filter(s => s.signal === 'composed').map(s => s.name);
  const policies = all.filter(s => s.signal === 'policy' && (s.strategies || []).some(n => composed.includes(n))).map(s => s.name);
  return new Set([...composed, ...policies]);
}

function composedLaneErrors(lanes, strategies) {
  const tags = composedSetups(strategies);
  const errors = [];
  for (const l of lanes || []) {
    if (l.trigger !== 'signal') continue;
    const listed = [...(l.strategies || []), ...(l.policies || [])].filter(n => tags.has(n));
    if (listed.length) errors.push(`lane ${l.timeframe}m lists ${listed.join(', ')} on trigger "signal": nothing fires for a composed trade, so the lane would never cycle for it; use trigger "bar" (every bar, D11)`);
  }
  return errors;
}

function runsComposed(strategies, timeframe) {
  return (strategies || []).some(s => s && s.valid !== false && s.signal === 'composed' && s.status === 'active' && s.timeframe === timeframe);
}

const PENDING_KEPT = 200;
const pendingFile = env => path.join(require('../paths').harnessHome(env), 'composed-stamps.json');

function isComposedEntry(env, args, root = path.resolve(__dirname, '..', '..', '..')) {
  try {
    const setup = (/^\s*setup:([a-z0-9][a-z0-9_-]*)/i.exec(String((args && args.rationale) || '')) || [])[1];
    if (!setup) return false;
    const { loadStrategies } = require('./strategies');
    return composedSetups(loadStrategies(root, env).strategies).has(setup.toLowerCase());
  } catch (_err) {
    return true; // can't tell: treated as composed, so a missing stamp cancels it (fails safe)
  }
}

function writePendingStamp(env, tag, stamp) {
  const { readJson, writeJsonAtomic } = require('../harness-run');
  const file = pendingFile(env);
  const all = readJson(file, {});
  const next = { ...(isObj(all) ? all : {}), [String(tag)]: stamp };
  const keys = Object.keys(next);
  writeJsonAtomic(file, Object.fromEntries(keys.slice(-PENDING_KEPT).map(k => [k, next[k]])));
}

function pendingStamp(env, tag) {
  if (tag === undefined || tag === null) return null;
  const all = require('../harness-run').readJson(pendingFile(env), {});
  return isObj(all) && isObj(all[String(tag)]) ? all[String(tag)] : null;
}

function entryStamp(env, args, stamp = null, tag = null) {
  const given = isObj(stamp) ? stamp : pendingStamp(env, tag);
  if (given) return { record: given.record || null, expiresAt: given.expiresAt || null, ...(Number.isFinite(given.entry) ? { entry: given.entry } : {}), ...(given.side ? { side: given.side } : {}) };
  return isComposedEntry(env, args) ? { record: null, expiresAt: null } : null;
}

function dueComposed({ entries = [], orders = [], composed = new Set(), now = new Date() }) {
  const out = [];
  for (const o of orders || []) {
    const e = (entries || []).find(x => x && String(x.orderId) === String(o && o.id));
    if (!e || !composed.has(e.setup)) continue;
    const t = Date.parse(isObj(e.composed) ? e.composed.expiresAt : null);
    if (!Number.isFinite(t) || now.getTime() >= t) out.push({ order: o, entry: e });
  }
  return out;
}

// Broker order sides as the interface's enum (0 buy, 1 sell) or words; position types 1 long, 2 short.
const orderSign = o => (o.side === 0 || /^(buy|long)$/i.test(String(o.side)) ? 1 : o.side === 1 || /^(sell|short)$/i.test(String(o.side)) ? -1 : 0);
const LIMIT = new Set([1, '1', 'limit', 'Limit', 'LIMIT']);

function unrecordedEntries({ entries = [], orders = [], positions = [], root }) {
  const known = new Set((entries || []).map(e => String(e.orderId)));
  const fam = r => familyRoot(contractRoot(String(r || '')));
  const open = (positions || []).filter(p => p && fam(p.contractId) === fam(root) && Number(p.size) > 0);
  const posSign = open.length ? (Number(open[0].type) === 2 ? -1 : 1) : 0;
  return (orders || []).filter(o => o && LIMIT.has(o.type) && fam(o.contractId) === fam(root) && !known.has(String(o.id))
    && (!posSign || orderSign(o) === posSign));
}

function recordSummary(r) {
  if (!isObj(r)) return null;
  const p = isObj(r.plan) ? r.plan : null;
  return {
    id: r.id, side: r.side, bar: r.bar, ok: r.ok === true, signature: r.signature || null, skillSignature: r.skillSignature || null,
    symbol: r.symbol || null, contract: r.contract || null, lane: r.lane || null, context: isObj(r.context) ? r.context : null,
    entry: p && isObj(p.entry) ? p.entry.price : null, tick: p ? p.tick ?? null : null, tickValue: p ? p.tickValue ?? null : null,
    size: p && Number.isInteger(p.size) ? p.size : null,
    stop: p && isObj(p.stop) ? p.stop.price : null, target: p && isObj(p.target) ? p.target.price : null, rr: p ? p.rr ?? null : null,
    reads: (Array.isArray(r.reads) ? r.reads : []).map(x => ({ step: x.step, skill: x.skill, read: x.read, check: x.check, agrees: x.agrees, why: x.why })),
    problems: Array.isArray(r.problems) ? r.problems.length : 0,
  };
}

function cycleComposed(home, cycleId, symbols = []) {
  if (!cycleId) return [];
  const roots = [...new Set((symbols || []).map(s => familyRoot(String(s).toUpperCase())))];
  return roots.flatMap(root => readRecords(home, root).filter(r => r.cycleId === cycleId)).map(recordSummary);
}

module.exports = { composedSetups, composedLaneErrors, runsComposed, isComposedEntry, writePendingStamp, pendingStamp, entryStamp, dueComposed, unrecordedEntries, recordSummary, cycleComposed };
