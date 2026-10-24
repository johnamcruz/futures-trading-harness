'use strict';

/**
 * The trend batch's size round by round, and the learning curve it gives (Propose-Probe-Compose, docs/TRAINING.md).
 * Code only; nothing here keeps or rejects a change (the keep rule does, unchanged).
 *
 * The size (config/training.json trendBatch): each loop starts at `start` legs (split `half` probe, the rest confirm).
 * A round's outcome (outcomeOf):
 *   kept            the keep rule kept its change: a new champion, so the next round starts at `start` again
 *   improved        its combined change was confirmed on the confirm half (the screen showed an improvement)
 *   no-improvement  edits were screened and none showed one: every edit inconclusive or with no gain, or the combined
 *                   change not confirmed
 *   neutral         nothing to judge (no edit screened), or every edit clearly worse (hurt): a rejected edit is no
 *                   sign the batch is too small
 * After `growAfter` no-improvement rounds in a row at the current size (neutral rounds skipped), the next round's batch
 * is `growFactor` times the size, at most `max` (and the pool). An improved round keeps the size.
 *
 * The learning curve: each round's confirm half, as the champion after that round's keep stands: the kept change's
 * numbers when it was kept, the champion's otherwise. Its capture rate (legs caught of the half's legs, with a Wilson
 * interval at the keep rule's level), net R per session and the first-try reasoning summary (first-try.js: read accuracy,
 * compose OK rate, hint-rescue rate) and the selection value (selection.js: taken minus passed scan reactions' mean R);
 * the curve across rounds and its pooled rate. Two flags,
 * reported only:
 *   plateau       the last plateauRounds rounds: none caught more than every earlier round did, beyond its interval (its
 *                 lower bound above the best earlier rate)
 *   memorization  an edit whose legs caught rose on the probe half and on the regression days, but not on the confirm
 *                 half (the combined change it was part of did not gain there)
 *
 *   OUTCOMES
 *   outcomeOf({ probes, composed, kept })      the round's outcome
 *   planBatch(history, { pool, cfg })          { size, trigger: start | restart | keep | grow | cap, why }; history: the
 *                                              earlier rounds' [{ size, outcome }], oldest first
 *   curvePoint({ round, size, champion, composed, kept })   { round, batch, legs, caught, rate, lo, hi, netR, firstTry, selection,
 *                                              source }
 *   curveOf(points, { plateauRounds })         { points, pooled: { legs, caught, rate }, plateau }
 *   memorizationOf(probes, composed)           [{ id, probe, regression, confirm }]: the edits flagged
 */

const { wilson } = require('../prop/stats');

const OUTCOMES = Object.freeze(['kept', 'improved', 'no-improvement', 'neutral']);
const CFG = () => require('../tunables').training().trendBatch;
const LEVEL = () => require('../tunables').training().keepRule.level;

function outcomeOf({ probes = [], composed = null, kept = false } = {}) {
  if (kept) return 'kept';
  if (composed && composed.verdict === 'helped') return 'improved';
  if (!probes.length || probes.every(p => p.verdict === 'hurt')) return 'neutral';
  return 'no-improvement';
}

function planBatch(history = [], { pool = Infinity, cfg = CFG() } = {}) {
  const start = Math.min(cfg.start, pool);
  if (!history.length) return { size: start, trigger: 'start', why: `the loop's first round: ${start} legs` };
  const last = history[history.length - 1];
  if (last.outcome === 'kept') return { size: start, trigger: 'restart', why: `round ${history.length} kept a change (a new champion): back to ${start} legs` };
  const size = last.size;
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i];
    if (h.outcome === 'neutral') continue;
    if (h.size !== size || h.outcome !== 'no-improvement') break;
    streak += 1;
  }
  if (streak < cfg.growAfter) return { size, trigger: 'keep', why: streak ? `${streak} round(s) without an improvement at ${size} legs, under ${cfg.growAfter}` : `the last judged round at ${size} legs showed an improvement` };
  const grown = Math.min(size * cfg.growFactor, cfg.max, pool);
  if (grown === size) return { size, trigger: 'cap', why: `${streak} rounds without an improvement, already at the most (${size} legs)` };
  return { size: grown, trigger: 'grow', why: `${streak} rounds without an improvement at ${size} legs: ${grown} legs` };
}

/** One round's confirm half as the champion after its keep stands. champion: { legs, caught, netR }; composed: its trend measures. */
function curvePoint({ round, size, champion, composed = null, kept = false }) {
  const useKept = Boolean(kept && composed && composed.capture);
  // The kept change's legs: the champion's caught, plus those it fixed, minus those it broke (the same legs, paired).
  const caught = useKept ? champion.caught + composed.capture.b - composed.capture.c : champion.caught;
  const netR = useKept && composed.netR && composed.netR.diff !== null ? champion.netR + composed.netR.diff : champion.netR;
  const w = wilson(caught, champion.legs, LEVEL());
  // First-try reasoning (first-try.js): the kept change's own when it was kept, else the champion's.
  const firstTry = useKept && composed.firstTry ? composed.firstTry.probe : champion.firstTry || null;
  // Selection value (selection.js): the kept change's own when it was kept, else the champion's.
  const selection = useKept && composed.selection ? composed.selection : champion.selection || null;
  return { round, batch: size, legs: champion.legs, caught, rate: w.rate, lo: w.lo, hi: w.hi, netR: netR === null ? null : Math.round(netR * 10000) / 10000, firstTry, selection, source: useKept ? 'kept change' : 'champion' };
}

function curveOf(points, { plateauRounds = CFG().plateauRounds } = {}) {
  const legs = points.reduce((s, p) => s + p.legs, 0);
  const caught = points.reduce((s, p) => s + p.caught, 0);
  // A round improved when its interval's lower bound is above every earlier round's rate.
  const improved = points.map((p, i) => i > 0 && p.lo !== null && p.lo > Math.max(...points.slice(0, i).map(q => (q.rate === null ? 0 : q.rate))));
  const plateau = points.length > plateauRounds && !improved.slice(-plateauRounds).some(Boolean);
  return { points, pooled: { legs, caught, rate: legs ? Math.round((caught / legs) * 10000) / 10000 : null }, plateau, plateauRounds };
}

/** The edits whose legs caught rose on the probe half and the regression days, but whose combined change didn't gain on confirm. */
function memorizationOf(probes = [], composed = null) {
  if (!composed || !composed.trend || !composed.trend.capture) return [];
  const confirmGain = composed.trend.capture.b - composed.trend.capture.c;
  const parts = new Set(composed.parts || []);
  return probes.filter(p => parts.has(p.id) && p.trend && p.regression)
    .map(p => ({ id: p.id, probe: p.trend.capture.b - p.trend.capture.c, regression: p.regression.capture.b - p.regression.capture.c, confirm: confirmGain }))
    .filter(x => x.probe > 0 && x.regression > 0 && x.confirm <= 0);
}

module.exports = { OUTCOMES, outcomeOf, planBatch, curvePoint, curveOf, memorizationOf };
