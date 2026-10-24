'use strict';

/**
 * One training-loop iteration in one record (Propose-Probe-Compose, docs/TRAINING.md): what was proposed, what the screen
 * said of each edit, what was composed and confirmed, what the keep rule did, the deltas the screens measured, and what
 * each side cost in cycles. Built by code from the round's own files (its probe-report.json and the archive's lines of
 * the iteration), written as <iteration dir>/iteration-report.json, and printed by `train-loop.js status` as one line.
 * Nothing here judges: every verdict in it is the screen's (screen.js) or the keep rule's (model-verifier.js).
 *
 * The deltas are the combined change's on the confirm half (net fixed minus broken decisions, of the pairs, for the
 * correct reads, process adherence and its parts' target; the paired mean difference of R per decision). The capture
 * deltas (the trend set: legs caught, missed R) are null until a round screens one.
 *
 *   build({ probeReport, entries })   the iteration's record (entries: the archive's lines of the iteration)
 *   line(record)                      one line for status
 */

const net = t => (t && Number.isInteger(t.pairs) ? { fixed: t.b, broken: t.c, pairs: t.pairs } : null);
const targetLabel = tag => (tag ? (tag.agent ? `agent ${tag.agent}` : tag.skill || '?') : '?');

function build({ probeReport = null, entries = [] } = {}) {
  const r = probeReport || {};
  const findings = new Map((r.findings || []).map(f => [f.id, f]));
  const kept = entries.find(e => e && e.phase !== 'held-out' && e.composition) || entries.find(e => e && e.phase !== 'held-out') || null;
  const m = r.composed && r.composed.measures ? r.composed.measures : null;
  return {
    iteration: r.iteration === undefined ? (kept ? kept.iteration : null) : r.iteration,
    split: r.split ? { seed: r.split.seed, probe: (r.split.probe || []).length, confirm: (r.split.confirm || []).length } : null,
    findings: (r.findings || []).map(f => ({ id: f.id, step: f.step === undefined ? null : f.step, target: f.agent ? `agent ${f.agent}` : f.skill || null, kind: f.kind, count: f.count })),
    proposed: (r.edits || []).map(e => {
      const f = e.tag ? findings.get(e.tag.finding) : null;
      return { id: e.id, target: targetLabel(e.tag), finding: e.tag ? e.tag.finding : null, step: f && f.step !== undefined ? f.step : null, kind: e.tag ? e.tag.kind : null, refused: (e.errors || []).length ? e.errors : null, probedBefore: Boolean(e.probedBefore) };
    }),
    screened: (r.probes || []).map(p => ({ id: p.id, target: targetLabel(p.tag), verdict: p.verdict, n: p.target ? p.target.pairs : null, harms: p.harms || [] })),
    composed: r.composed ? { id: r.composed.id, verdict: r.composed.verdict, parts: r.composition ? r.composition.parts : [], cancelled: r.composed.cancelled || [] } : null,
    kept: kept ? { proposalId: kept.proposalId, verdict: kept.verdict, reasons: kept.reasons || [] } : null,
    deltas: m ? { reads: net(m.reads), process: net(m.process), target: net(m.target), rPerDecision: m.r ? { diff: m.r.diff, lo: m.r.lo, hi: m.r.hi, pairs: m.r.pairs } : null, capture: null } : null,
    cycles: r.cycles || null,
    why: r.why || null,
  };
}

function line(x) {
  const verdicts = x.screened.reduce((o, s) => ({ ...o, [s.verdict]: (o[s.verdict] || 0) + 1 }), {});
  const screened = Object.keys(verdicts).length ? Object.entries(verdicts).map(([v, c]) => `${v} ${c}`).join(', ') : 'none';
  const c = x.cycles || {};
  const edits = Object.values(c.edits || {}).reduce((s, v) => s + (Number(v) || 0), 0);
  const ch = c.champion || {};
  const cost = `cycles: champion ${(ch.probe || 0) + (ch.confirm || 0)}, edits ${edits}, combined ${c.composed || 0}`;
  const d = x.deltas;
  const deltas = d ? `; confirm deltas: reads ${d.reads ? `+${d.reads.fixed}/-${d.reads.broken} of ${d.reads.pairs}` : 'n/a'}, process ${d.process ? `+${d.process.fixed}/-${d.process.broken} of ${d.process.pairs}` : 'n/a'}, R/decision ${d.rPerDecision && d.rPerDecision.diff !== null && d.rPerDecision.diff !== undefined ? d.rPerDecision.diff : 'n/a'}` : '';
  return `iteration ${x.iteration}: proposed ${x.proposed.length} (${x.proposed.filter(p => p.refused).length} refused), screened ${screened}`
    + `; combined ${x.composed ? `${x.composed.id} ${x.composed.verdict}` : 'none'}; keep rule ${x.kept ? `${x.kept.verdict}` : 'not run'}${deltas}; ${cost}${x.why ? `; ${x.why}` : ''}`;
}

module.exports = { build, line };
