'use strict';

/**
 * One training-loop iteration in one record (Propose-Probe-Compose, docs/TRAINING.md): what was proposed, what the screen
 * said of each edit, what was composed and confirmed, what the keep rule did, the deltas the screens measured, and what
 * each side cost in cycles. Built by code from the round's own files (its probe-report.json and the archive's lines of
 * the iteration), written as <iteration dir>/iteration-report.json, and printed by `train-loop.js status` as one line.
 * Nothing here judges: every verdict in it is the screen's (screen.js) or the keep rule's (model-verifier.js).
 *
 * The deltas are the combined change's on the confirm half (net fixed minus broken decisions, of the pairs, for the
 * correct reads, process adherence and its parts' target; the paired mean difference of R per decision), and with a
 * trend set the legs caught on its confirm half (fixed, broken, pairs, each side's capture rate, the paired net R per
 * session: trend-screen.js); null without one. The trend batch's probe half also counts its missed legs: learnable (a
 * valid plan existed: the findings), no valid plan at the time (a correct pass), unknown (trend-findings.js missedTally).
 *
 *   build({ probeReport, entries, previous })   the iteration's record (entries: the archive's lines of the iteration;
 *                                     previous: the earlier iterations' records, oldest first, for the learning curve)
 *   line(record)                      one line for status
 */

const TC = require('./trend-curve');

const net = t => (t && Number.isInteger(t.pairs) ? { fixed: t.b, broken: t.c, pairs: t.pairs } : null);
const targetLabel = tag => (tag ? (tag.agent ? `agent ${tag.agent}` : tag.skill || '?') : '?');

/** The round's trend batch: its size and why, its index, the pool, each half's days and legs, the round's outcome. */
function trendOf(r, kept) {
  const t = r.trend;
  const outcome = TC.outcomeOf({ probes: r.probes || [], composed: r.composed || null, kept: Boolean(kept && kept.verdict === 'kept') });
  return { set: t.set, batch: t.batch, outcome, probe: { days: t.probe.days.length, legs: t.probe.legs.length }, confirm: { days: t.confirm.days.length, legs: t.confirm.legs.length }, missed: t.missed || null, baseRate: t.baseRate || null };
}

/** The learning curve to this round (trend-curve.js): this round's confirm-half point, the curve, its flags. */
function curveFields(r, kept, previous) {
  if (!r.trend.champion) return { curve: curveOfPrevious(previous), memorization: [] };
  const point = TC.curvePoint({ round: r.iteration, size: r.trend.batch.size, champion: r.trend.champion, composed: r.composed && r.composed.trend ? r.composed.trend : null, kept: Boolean(kept && kept.verdict === 'kept') });
  return { curvePoint: point, curve: TC.curveOf([...previousPoints(previous), point]), memorization: TC.memorizationOf(r.probes || [], r.composed || null) };
}

const previousPoints = previous => (previous || []).map(x => x && x.curvePoint).filter(Boolean);
const curveOfPrevious = previous => TC.curveOf(previousPoints(previous));

function build({ probeReport = null, entries = [], previous = [] } = {}) {
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
    deltas: m ? { reads: net(m.reads), process: net(m.process), target: net(m.target), rPerDecision: m.r ? { diff: m.r.diff, lo: m.r.lo, hi: m.r.hi, pairs: m.r.pairs } : null, capture: m.trend ? { ...net(m.trend.capture), rate: m.trend.rate, netR: m.trend.netR } : null } : null,
    // The round's trend batch: its index in the pool's draw, the pool's fingerprint, each half's days and legs.
    trend: r.trend ? trendOf(r, kept) : null,
    ...(r.trend ? curveFields(r, kept, previous) : {}),
    cycles: r.cycles || null,
    // Each side's bars skipped while a cycle ran (latency, as live; probe.js): a slower edit shows here.
    skipped: r.skipped || null,
    why: r.why || null,
  };
}

const rate = b => (b && b.bars ? `${Math.round((b.valid / b.bars) * 100)}%` : 'n/a');

function line(x) {
  const rateN = b => `${rate(b)} (n ${b ? b.bars : 0})`;
  const verdicts = x.screened.reduce((o, s) => ({ ...o, [s.verdict]: (o[s.verdict] || 0) + 1 }), {});
  const screened = Object.keys(verdicts).length ? Object.entries(verdicts).map(([v, c]) => `${v} ${c}`).join(', ') : 'none';
  const c = x.cycles || {};
  const edits = Object.values(c.edits || {}).reduce((s, v) => s + (Number(v) || 0), 0);
  const ch = c.champion || {};
  const cost = `cycles: champion ${(ch.probe || 0) + (ch.confirm || 0) + (ch.trend || 0)}, edits ${edits}, combined ${c.composed || 0}`;
  // The trend windows' bars skipped while a cycle ran (latency): each side's share, so a slower edit is visible.
  const sk = x.skipped;
  const share = s => (s && s.share !== null && s.share !== undefined ? `${s.share}${s.legWindows ? ` (${s.legWindows} leg window(s))` : ''}` : 'n/a');
  const skipped = sk ? `; skipped bars: champion ${share(sk.champion)}${Object.entries(sk.edits || {}).map(([id, s]) => `, ${id} ${share(s)}`).join('')}${sk.composed ? `, combined ${share(sk.composed)}` : ''}` : '';
  const d = x.deltas;
  const deltas = d ? `; confirm deltas: reads ${d.reads ? `+${d.reads.fixed}/-${d.reads.broken} of ${d.reads.pairs}` : 'n/a'}, process ${d.process ? `+${d.process.fixed}/-${d.process.broken} of ${d.process.pairs}` : 'n/a'}, R/decision ${d.rPerDecision && d.rPerDecision.diff !== null && d.rPerDecision.diff !== undefined ? d.rPerDecision.diff : 'n/a'}${d.capture ? `, legs caught +${d.capture.fixed}/-${d.capture.broken} of ${d.capture.pairs} (${d.capture.rate.champion} -> ${d.capture.rate.probe}), net R/window ${d.capture.netR.diff === null ? 'n/a' : d.capture.netR.diff}` : ''}` : '';
  return `iteration ${x.iteration}: proposed ${x.proposed.length} (${x.proposed.filter(p => p.refused).length} refused), screened ${screened}`
    + `${x.trend ? `; trend batch ${x.trend.batch.index} (probe ${x.trend.probe.legs} legs on ${x.trend.probe.days} day(s), confirm ${x.trend.confirm.legs} on ${x.trend.confirm.days})` : ''}`
    + `${x.trend ? `, ${x.trend.batch.trigger} (${x.trend.outcome})` : ''}`
    + `${x.trend && x.trend.missed ? `; probe missed legs ${x.trend.missed.missed}: learnable ${x.trend.missed.learnable}, no valid plan ${x.trend.missed.noValidPlan} (a correct pass), unknown ${x.trend.missed.unknown}` : ''}`
    + `${x.trend && x.trend.baseRate ? `, valid plan on ${rateN(x.trend.baseRate.legBars)} of leg bars vs ${rateN(x.trend.baseRate.controlBars)} of control bars` : ''}`
    + `${x.curvePoint ? `; confirm capture ${x.curvePoint.rate} [${x.curvePoint.lo}, ${x.curvePoint.hi}] net R/window ${x.curvePoint.netR}${x.curvePoint.firstTry ? `, first-try reads ${x.curvePoint.firstTry.readAccuracy} OK ${x.curvePoint.firstTry.okRate} hint-rescued ${x.curvePoint.firstTry.rescueRate}` : ''}${x.curvePoint.selection ? `, selection value ${x.curvePoint.selection.value} (taken ${x.curvePoint.selection.taken.n} at ${x.curvePoint.selection.taken.meanR}R, passed ${x.curvePoint.selection.passed.n} at ${x.curvePoint.selection.passed.meanR}R)` : ''} (${x.curvePoint.source}), pooled ${x.curve.pooled.rate} over ${x.curve.pooled.rounds ?? x.curve.points.length} round(s)${x.curve.excluded ? ` (${x.curve.excluded} earlier round(s) of whole sessions left out)` : ''}${x.curve.plateau ? `, PLATEAU (no gain in ${x.curve.plateauRounds} rounds)` : ''}` : ''}`
    + `${x.memorization && x.memorization.length ? `; MEMORIZATION: ${x.memorization.map(m => m.id).join(', ')}` : ''}`
    + `; combined ${x.composed ? `${x.composed.id} ${x.composed.verdict}` : 'none'}; keep rule ${x.kept ? `${x.kept.verdict}` : 'not run'}${deltas}; ${cost}${skipped}${x.why ? `; ${x.why}` : ''}`;
}

module.exports = { build, line };
