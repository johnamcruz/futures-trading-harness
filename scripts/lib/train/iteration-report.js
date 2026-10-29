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
 * valid plan existed: the findings), no valid plan at the time (a correct pass), unknown (trend-findings.js missedTally),
 * and scores its exits by what price did next (exit-findings.js exitTally: per who exited, cut a trend or right, late).
 *
 *   build({ probeReport, entries, previous })   the iteration's record (entries: the archive's lines of the iteration;
 *                                     previous: the earlier iterations' records, oldest first, for the learning curve)
 *   line(record)                      one line for status
 *   rideLines(record)                 the round's "Trend catch & ride" block for status (none without a trend set)
 *   masteryLines(record)              the round's mastery read for status (none without a trend set): on the confirm half
 *                                     (held-out trend legs), the champion's and the combined change's legs caught,
 *                                     R caught / available, control-window false-start share and blows (curriculum.js);
 *                                     the owner's bar on them is text (docs/TRAINING.md), never judged here
 */

const TC = require('./trend-curve');
const TR = require('../replay/trend-ride');
const CU = require('./curriculum');

const net = t => (t && Number.isInteger(t.pairs) ? { fixed: t.b, broken: t.c, pairs: t.pairs } : null);
const targetLabel = tag => (tag ? (tag.agent ? `agent ${tag.agent}` : tag.skill || '?') : '?');

/** The round's trend batch: its size and why, its index, the pool, each half's days and legs, the round's outcome. */
function trendOf(r, kept) {
  const t = r.trend;
  const outcome = TC.outcomeOf({ probes: r.probes || [], composed: r.composed || null, kept: Boolean(kept && kept.verdict === 'kept') });
  return { set: t.set, batch: t.batch, outcome, probe: { days: t.probe.days.length, legs: t.probe.legs.length }, confirm: { days: t.confirm.days.length, legs: t.confirm.legs.length }, missed: t.missed || null, baseRate: t.baseRate || null, exits: t.exits || null };
}

/** The learning curve to this round (trend-curve.js): this round's confirm-half point, the curve, its flags. */
function curveFields(r, kept, previous) {
  if (!r.trend.champion) return { curve: curveOfPrevious(previous), memorization: [] };
  const point = TC.curvePoint({ round: r.iteration, size: r.trend.batch.size, champion: r.trend.champion, composed: r.composed && r.composed.trend ? r.composed.trend : null, kept: Boolean(kept && kept.verdict === 'kept') });
  return { curvePoint: point, curve: TC.curveOf([...previousPoints(previous), point]), memorization: TC.memorizationOf(r.probes || [], r.composed || null) };
}

/** The round's catch & ride totals by side (see build). */
function rideOf(r) {
  const edits = Object.fromEntries((r.probes || []).filter(p => p && p.ride).map(p => [p.id, p.ride]));
  return {
    champion: r.trend.champion && r.trend.champion.ride ? r.trend.champion.ride : null, championProbe: r.trend.probeRide || null, edits,
    composed: r.composed && r.composed.trend && r.composed.trend.ride ? { id: r.composed.id, ...r.composed.trend.ride } : null,
  };
}

/** The round's mastery read (see masteryLines): the champion's confirm half, and the combined change's when judged. */
function masteryOf(r, kept) {
  const c = r.trend.champion;
  const t = r.composed && r.composed.trend ? r.composed.trend : null;
  return {
    curriculum: r.curriculum || CU.DEFAULT,
    champion: c ? CU.mastery({ ride: c.ride, blows: c.blows, controls: c.controls }) : null,
    composed: t ? { id: r.composed.id, kept: Boolean(kept && kept.verdict === 'kept'), ...CU.mastery({ ride: t.ride, blows: t.blows, controls: t.controls }) } : null,
  };
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
    // The round's trend catch & ride (replay/trend-ride.js), report only: the champion's confirm and probe halves, each
    // edit's probe half, the combined change's confirm half; null where a side recorded none.
    ride: r.trend ? rideOf(r) : null,
    // The round's mastery read (curriculum.js mastery): what the owner's trend-mastery bar reads (docs/TRAINING.md).
    mastery: r.trend ? masteryOf(r, kept) : null,
    ...(r.trend ? curveFields(r, kept, previous) : {}),
    cycles: r.cycles || null,
    // Each side's bars skipped while a cycle ran (latency, as live; probe.js): a slower edit shows here.
    skipped: r.skipped || null,
    why: r.why || null,
  };
}

// A base rate's count: the leg bars' (bars), the control bar-sides' (sides).
const countOf = b => (b ? b.bars ?? b.sides ?? 0 : 0);
const rate = b => (countOf(b) ? `${Math.round((b.valid / countOf(b)) * 100)}%` : 'n/a');

/** The probe half's exits in a few words: per who exited, cut (R left) / right / late; the model's tightens. */
function exitsText(e) {
  const by = Object.entries(e.byExit || {}).map(([k, v]) => `${k} ${v.n} (cut ${v.cut} ${v.leftR}R left, right ${v.right}, late ${v.late})`).join(', ') || 'none';
  const t = e.tightens || {};
  return `${by}; flip-decided ${(e.flip || {}).n || 0} (cut ${(e.flip || {}).cut || 0}); model tightens ${t.n || 0} (stopped ${t.stopped || 0}: cut ${t.cut || 0}, right ${t.right || 0})`;
}

function line(x) {
  const rateN = b => `${rate(b)} (n ${countOf(b)})`;
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
    + `${x.trend && x.trend.exits ? `; probe exits: ${exitsText(x.trend.exits)}` : ''}`
    + `${x.trend && x.trend.baseRate ? `, valid plan on ${rateN(x.trend.baseRate.legBars)} of leg bars vs ${rateN(x.trend.baseRate.controlBars)} of control bar-sides (won ${x.trend.baseRate.controlBars.won ?? '?'}, lost ${x.trend.baseRate.controlBars.lost ?? '?'}, undecided ${x.trend.baseRate.controlBars.undecided ?? '?'})` : ''}`
    + `${x.curvePoint ? `; confirm capture ${x.curvePoint.rate} [${x.curvePoint.lo}, ${x.curvePoint.hi}] net R/window ${x.curvePoint.netR}${x.curvePoint.firstTry ? `, first-try reads ${x.curvePoint.firstTry.readAccuracy} OK ${x.curvePoint.firstTry.okRate} hint-rescued ${x.curvePoint.firstTry.rescueRate}` : ''}${x.curvePoint.selection ? `, selection value ${x.curvePoint.selection.value} (taken ${x.curvePoint.selection.taken.n} at ${x.curvePoint.selection.taken.meanR}R, passed ${x.curvePoint.selection.passed.n} at ${x.curvePoint.selection.passed.meanR}R)` : ''} (${x.curvePoint.source}), pooled ${x.curve.pooled.rate} over ${x.curve.pooled.rounds ?? x.curve.points.length} round(s)${x.curve.excluded ? ` (${x.curve.excluded} earlier round(s) of whole sessions left out)` : ''}${x.curve.plateau ? `, PLATEAU (no gain in ${x.curve.plateauRounds} rounds)` : ''}` : ''}`
    + `${x.memorization && x.memorization.length ? `; MEMORIZATION: ${x.memorization.map(m => m.id).join(', ')}` : ''}`
    + `; combined ${x.composed ? `${x.composed.id} ${x.composed.verdict}` : 'none'}; keep rule ${x.kept ? `${x.kept.verdict}` : 'not run'}${deltas}; ${cost}${skipped}${x.why ? `; ${x.why}` : ''}`;
}

/** The round's "Trend catch & ride" block: a line per side that recorded one (trend-ride.js rideLine). */
function rideLines(x) {
  const r = x && x.ride;
  if (!r) return [];
  const sides = [
    ['champion confirm', r.champion], ['champion probe', r.championProbe],
    ...Object.entries(r.edits || {}).map(([id, t]) => [`edit ${id} probe`, t]),
    ...(r.composed ? [[`combined ${r.composed.id} confirm`, r.composed]] : []),
  ].filter(([, t]) => t);
  return sides.length ? [`  Trend catch & ride (iteration ${x.iteration}):`, ...sides.map(([k, t]) => `    ${k}: ${TR.rideLine(t)}`)] : [];
}

/** The round's mastery read: a line per side that has one (the champion's confirm half; the combined change's). */
function masteryLines(x) {
  const m = x && x.mastery;
  if (!m || (!m.champion && !m.composed)) return [];
  return [
    `  Mastery read (iteration ${x.iteration}, curriculum ${m.curriculum}, confirm half: held-out trend legs):`,
    ...(m.champion ? [`    champion: ${CU.masteryText(m.champion)}`] : []),
    ...(m.composed ? [`    combined ${m.composed.id}${m.composed.kept ? ' (kept)' : ''}: ${CU.masteryText(m.composed)}`] : []),
  ];
}

module.exports = { build, line, rideLines, masteryLines };
