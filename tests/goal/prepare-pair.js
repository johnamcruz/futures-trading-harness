'use strict';

/**
 * Tier 2 with prepare ahead (tests/goal/tier2-prepare.goal.js): a day on Claude Code with the key off and with "on",
 * compared. What the old path decided and did must be the same: every trade (its side, entry, size, exit, R), every
 * order call the exchange received (with its arguments), every gate decision (its source, tool, decision, the checks
 * that refused it, the order), every compose record (its time, side, bar, plan, problems), every cycle's result. Only
 * run-local values are left out (the gate's wall-clock stamp and cycle id, a record's id, which hash them, and that id as
 * an order's rationale names it, and the order's own customTag).
 *
 *   decisionsOf(result)         a tier2-day.js result as compared
 *   pairProblems(off, on)       [problem]: each field whose values differ, with the first difference
 *   prepareOf(w)                in the day's process: the confirms the mock played and the path each close took
 */

const fs = require('fs');
const path = require('path');
const GP = require('../../scripts/lib/eval/goal-path');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
// A compose record's id (it hashes the record, its cycle id among them: run-local) as an order's rationale names it.
const RECORD_ID = /\brecord [0-9a-f]{16}\b/g;
// The order's own tag (customTag: a hash the runner makes per order, run-local) likewise.
const TAG = /"customTag":"fth-[0-9a-f]{16}"/g;
const local = v => JSON.parse(JSON.stringify(v === undefined ? null : v).replace(RECORD_ID, 'record <id>').replace(TAG, '"customTag":"<tag>"'));

function decisionsOf(r) {
  return {
    trades: GP.dayTrades(r, { tick: r.tick }).map(t => ({ key: t.key, side: t.side, setup: t.setup, entry: t.entry, size: t.size, entryTime: t.entryTime, exitTime: t.exitTime, exitPrice: t.exitPrice, exitReason: t.exitReason, R: t.R })),
    calls: (r.calls || []).map(c => ({ tool: c.tool, args: local(c.args) })),
    gate: (r.gate || []).map(e => ({ source: e.source, tool: e.tool, decision: e.decision, checks: (e.violations || []).map(v => v.check).sort(), side: e.side, size: e.size, type: e.type, rationale: local(e.rationale) })),
    records: (r.records || []).map(x => ({ at: x.at, ok: x.ok, side: x.side, cycleBar: x.cycleBar, plan: x.plan, problems: x.problems })),
    results: (r.cycles || []).map(c => c.result),
  };
}

function firstDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return { i, off: a[i] === undefined ? null : a[i], on: b[i] === undefined ? null : b[i] };
  return null;
}

function pairProblems(off, on) {
  const a = decisionsOf(off);
  const b = decisionsOf(on);
  return Object.keys(a).flatMap(k => {
    const d = firstDiff(a[k], b[k]);
    return d ? [`${off.day}: ${k} differ (${a[k].length} off, ${b[k].length} on); first at ${d.i}: off ${JSON.stringify(d.off).slice(0, 300)} | on ${JSON.stringify(d.on).slice(0, 300)}`] : [];
  });
}

function prepareOf(w) {
  const dir = path.join(w.home, 'logs', 'cycles');
  const recs = fs.existsSync(dir) ? fs.readdirSync(dir).sort().flatMap(d => fs.readdirSync(path.join(dir, d)).sort().map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, d, f), 'utf8')); } catch (_err) { return null; } })).filter(Boolean) : [];
  const paths = {};
  let fellBack = 0;
  let entered = 0;
  for (const x of recs) {
    const on = isObj(x.prepare) && isObj(x.prepare.on) ? x.prepare.on : null;
    if (!on) continue;
    // A void plan by its reason (void:session-missing), so a fault row shows it was hit.
    const key = on.path === 'void' && on.reason ? `void:${on.reason}` : on.path;
    paths[key] = (paths[key] || 0) + 1;
    if (on.confirm && on.confirm.fellBack) fellBack += 1;
    // A close the confirm decided that entered: compose, phase 2, the executor and the gateway on a fork.
    if (on.path === 'confirm' && on.confirm && !on.confirm.fellBack && /^CYCLE RESULT: executed/.test(String(x.result || ''))) entered += 1;
  }
  const c = w.claude || {};
  return { confirms: c.confirms || 0, entered, voidConfirms: c.voidConfirms || 0, armed: c.armed || 0, paths, fellBack, made: recs.filter(x => isObj(x.prepare) && isObj(x.prepare.made) && x.prepare.made.outcome === 'done').length };
}

module.exports = { decisionsOf, pairProblems, prepareOf };
