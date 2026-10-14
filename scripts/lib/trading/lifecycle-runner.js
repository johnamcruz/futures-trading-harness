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
 *   entryStamp(env, args, root)       the gateway's stamp on a composed entry it lets through (order-tracker.js
 *                                     recordEntryOrder, entry-orders.json): its compose record on the cycle's bar
 *                                     (FTH_CYCLE_BRIEFING_BARS over FTH_CYCLE_BARS), that record's id and expiry; null
 *                                     for an entry of another setup. Never throws (a failure stamps no record: due at once)
 *   dueComposed({ entries, orders, composed, now })   the working orders that are composed entries (their gateway
 *                                     record's setup) whose stamped expiry has come, or that have no readable expiry
 *                                     (stamped without a record, or not stamped: after a restart too): [{ order, entry }]
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

function entryStamp(env, args, root = path.resolve(__dirname, '..', '..', '..')) {
  try {
    const setup = (/^\s*setup:([a-z0-9][a-z0-9_-]*)/i.exec(String((args && args.rationale) || '')) || [])[1];
    if (!setup) return null;
    const { loadStrategies } = require('./strategies');
    if (!composedSetups(loadStrategies(root, env).strategies).has(setup.toLowerCase())) return null;
    const { loadConfig } = require('./config');
    const { recordsAt } = require('./lifecycle-gate');
    const cfg = loadConfig(env);
    const sym = contractRoot(String(args.contractId || ''));
    const bar = { ...(cfg.cycleBars || {}), ...(cfg.cycleBriefingBars || {}) }[familyRoot(sym)] || null;
    const side = String(args.side || '').toLowerCase() === 'buy' ? 'long' : String(args.side || '').toLowerCase() === 'sell' ? 'short' : null;
    const recs = bar && side ? recordsAt(cfg.home, sym, bar).filter(r => r.side === side) : [];
    const rec = recs.length ? recs[recs.length - 1] : null;
    return { record: rec ? rec.id : null, expiresAt: rec && rec.expiresAt ? rec.expiresAt : null, bar };
  } catch (_err) {
    return { record: null, expiresAt: null, bar: null };
  }
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

module.exports = { composedSetups, composedLaneErrors, runsComposed, entryStamp, dueComposed, recordSummary, cycleComposed };
