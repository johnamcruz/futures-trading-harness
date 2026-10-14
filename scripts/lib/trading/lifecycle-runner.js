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
 *   stampComposed({ known, before, entries, items, recordsAt, composed })
 *                                     after a cycle: each composed entry order placed in it (in `entries`, the
 *                                     gateway's entry-orders.json, and not in `before`, the ids known before the
 *                                     cycle) stamped with its record's expiry: the latest compose record for its root
 *                                     and side on the cycle's bar (items: [{ symbol, bar }]). No record: due at once
 *                                     (fails safe: the limit is cancelled). Returns the map { <orderId>: { expiresAt,
 *                                     record, root } }, the last KEEP
 *   dueComposed({ known, orders, now })   the working orders whose stamped expiry has come (or can't be read)
 *   recordSummary(record)             a record as the decision history and the cycle log keep it: id, side, ok, the
 *                                     signatures, the stated size, the stop and target, each read with its check
 *   cycleComposed(home, cycleId, symbols)   the records the cycle's compose_check calls wrote (their cycleId)
 *
 * The runner cancels a due order (runner.js housekeeping): the broker interface has no time in force, so an unfilled
 * composed limit never outlives its record.
 */

const { contractRoot } = require('./journal');
const { familyRoot } = require('./contracts');
const { readRecords } = require('./trade-lifecycle');

const KEEP = 50;
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

function stampComposed({ known = {}, before = new Set(), entries = [], items = [], recordsAt, composed = new Set() }) {
  const out = { ...(isObj(known) ? known : {}) };
  for (const e of entries || []) {
    const id = String(e && e.orderId);
    if (!e || before.has(id) || Object.hasOwn(out, id) || !composed.has(e.setup)) continue;
    const root = contractRoot(e.contractId || '');
    const side = e.side === 'buy' ? 'long' : e.side === 'sell' ? 'short' : null;
    const item = items.find(i => familyRoot(i.symbol) === familyRoot(root));
    const recs = item && side ? recordsAt(root, item.bar).filter(r => r.side === side) : [];
    const rec = recs.length ? recs[recs.length - 1] : null;
    out[id] = { expiresAt: rec && rec.expiresAt ? rec.expiresAt : null, record: rec ? rec.id : null, root };
  }
  const ids = Object.keys(out);
  return Object.fromEntries(ids.slice(-KEEP).map(k => [k, out[k]]));
}

function dueComposed({ known = {}, orders = [], now = new Date() }) {
  return (orders || []).filter(o => o && Object.hasOwn(known || {}, String(o.id))).filter(o => {
    const t = Date.parse(known[String(o.id)].expiresAt);
    return !Number.isFinite(t) || now.getTime() >= t;
  });
}

function recordSummary(r) {
  if (!isObj(r)) return null;
  const p = isObj(r.plan) ? r.plan : null;
  return {
    id: r.id, side: r.side, bar: r.bar, ok: r.ok === true, signature: r.signature || null, skillSignature: r.skillSignature || null,
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

module.exports = { KEEP, composedSetups, composedLaneErrors, runsComposed, stampComposed, dueComposed, recordSummary, cycleComposed };
