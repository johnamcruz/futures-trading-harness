'use strict';

/**
 * The entries skipped as late (the owner: "we need to make sure we catch good moves too"): every composed entry the
 * late-entry rule passed on (trading/late-entry.js lateEntryCheck), from the runner's entry records (the cycle log's
 * `entry.late`: runner-entry.js) and the gate's refusals (the gate log's `late-entry` violations with their `late`), each
 * with a counterfactual from the bars after the skip: whether the plan's target or its stop traded first. A skip whose
 * target came first is a winner the rule passed on; one whose stop came first, a loser it spared; neither within the
 * skip's trading day, a trade the session's end would have closed. The threshold (config/runner.json
 * gate.lateEntryDriftShare) is tuned from these counts, never from a guess.
 *
 * An approximation, stated: the counterfactual walks the plan's absolute stop and target prices from the skip. A live
 * entry's brackets are distances from its fill, so a late fill away from the plan's entry would have its stop and
 * target moved by as much; the plan's own prices are what the skip judged (the structure levels the plan named).
 *
 *   readSkips(home)                              [{ at, root, side, entry, stop, target, price, kind, movedR, record, from }]
 *     one order judged by both the hook and the gateway is one skip: the same compose record (logged without one: the
 *     same cycle, contract, entry and side), the gateway's kept (the gateway runs without the hook's cycle id)
 *   firstHit(skip, bars)                         'target' | 'stop' | 'neither' | 'unknown' (bars: [{ t, h, l }], 1m, sorted)
 *     a bar reaching both is 'stop' (conservative); only bars that open at or after the skip, within its trading day;
 *     no target, or no such bar: unknown
 *   lateSkipReport(home, { barsFor })            { total, byKind, target, stop, neither, unknown, rows } (barsFor(root))
 *   reportLines(report)                          its text lines, for the replay report
 */

const fs = require('fs');
const path = require('path');
const { familyRoot } = require('../trading/contracts');
const { tradingDayStart } = require('../trading/clock');

const readLines = file => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch (_err) { return []; } }); } catch (_err) { return []; }
};
const num = x => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Number(x));
const skipOf = (late, at, root, from) => ({
  at, root: familyRoot(String(root || late.root || '').toUpperCase()) || null, side: late.side, entry: num(late.entry), stop: num(late.stop), target: num(late.target),
  price: num(late.price), kind: late.kind || null, movedR: num(late.movedR), record: late.record || null, from,
});

function readSkips(home) {
  const out = [];
  const logs = path.join(home, 'logs');
  // The runner's entry records (cycle-log.js: each cycle's file under logs/cycles/<day>/).
  const cycles = path.join(logs, 'cycles');
  let days;
  try { days = fs.readdirSync(cycles); } catch (_err) { days = []; }
  for (const day of days.sort()) {
    let files;
    try { files = fs.readdirSync(path.join(cycles, day)).filter(f => f.endsWith('.json')).sort(); } catch (_err) { files = []; }
    for (const f of files) {
      let c;
      try { c = JSON.parse(fs.readFileSync(path.join(cycles, day, f), 'utf8')); } catch (_err) { continue; }
      const late = c && c.entry && c.entry.late;
      if (late) out.push(skipOf(late, late.at || c.cycleAt, late.root, 'runner'));
    }
  }
  // The gate's late-entry refusals (the hook's and the gateway's: one order may be judged by both; the gateway's alone
  // counts where both judged it).
  const gate = readLines(path.join(logs, 'gate-log.jsonl')).filter(e => e && e.decision !== 'allowed');
  const seen = new Set();
  for (const e of gate.filter(x => x.source === 'gateway').concat(gate.filter(x => x.source !== 'gateway'))) {
    const v = (e.violations || []).find(x => x && x.check === 'late-entry' && x.late);
    if (!v) continue;
    const key = v.late.record ? `record|${v.late.record}|${v.late.side}|${v.late.entry}` : `cycle|${e.cycle || ''}|${e.contractId}|${v.late.entry}|${v.late.side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(skipOf(v.late, e.ts, e.contractId, 'gate'));
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function firstHit(skip, bars) {
  const sign = skip.side === 'long' ? 1 : skip.side === 'short' ? -1 : 0;
  if (!sign || skip.stop === null || skip.target === null || !Array.isArray(bars)) return 'unknown';
  const from = Date.parse(skip.at);
  if (!Number.isFinite(from)) return 'unknown';
  // The bars that open at or after the skip (the bar it fell in had traded before it: never counted), within the skip's
  // own trading day (the runner flattens by the session's end, so a later day's move is not the plan's).
  const day = tradingDayStart(new Date(from)).getTime();
  const after = bars.filter(b => Date.parse(b.t) >= from && tradingDayStart(new Date(Date.parse(b.t))).getTime() === day);
  if (!after.length) return 'unknown';
  for (const b of after) {
    const hitStop = sign > 0 ? Number(b.l) <= skip.stop : Number(b.h) >= skip.stop;
    const hitTarget = sign > 0 ? Number(b.h) >= skip.target : Number(b.l) <= skip.target;
    if (hitStop) return 'stop';
    if (hitTarget) return 'target';
  }
  return 'neither';
}

function lateSkipReport(home, { barsFor = () => null } = {}) {
  const rows = readSkips(home).map(s => ({ ...s, first: firstHit(s, barsFor(s.root)) }));
  const count = k => rows.filter(r => r.first === k).length;
  const byKind = {};
  for (const r of rows) byKind[r.kind || 'unknown'] = (byKind[r.kind || 'unknown'] || 0) + 1;
  return { total: rows.length, byKind, target: count('target'), stop: count('stop'), neither: count('neither'), unknown: count('unknown'), rows };
}

function reportLines(r) {
  if (!r || !r.total) return ['late-entry skips: none'];
  const kinds = Object.entries(r.byKind).map(([k, n]) => `${k} ${n}`).join(', ');
  return [
    `late-entry skips: ${r.total} (${kinds}); after the skip the plan's target traded first ${r.target}, its stop first ${r.stop}, neither within its trading day ${r.neither}, unknown ${r.unknown} (no bars)`,
    ...r.rows.map(x => `  ${x.at} ${x.root} ${x.side} entry ${x.entry} stop ${x.stop} target ${x.target ?? '-'}: price ${x.price ?? '-'}${x.movedR === null ? '' : ` (${Math.round(x.movedR * 100)}% of the risk toward the stop)`}, ${x.kind}; then ${x.first}`),
  ];
}

module.exports = { readSkips, firstHit, lateSkipReport, reportLines };
