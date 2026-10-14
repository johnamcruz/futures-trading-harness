'use strict';

/**
 * A replay's learning gate, before its first cycle (scripts/replay.js run; the training loop's window runs,
 * train/loop.js): every replay is a learning run unless its config says `"learning": false`, and a learning run lies
 * inside one window of the learning split (learning/splits.js) and takes its look first (learning/looks.js):
 *
 *   practice-train      practice: no look (assertUse 'practice')
 *   practice-validate   only with the explicit validate flag; a validate look, unbudgeted but counted
 *   test, final         only with a candidate and an evaluation id (the arms of one evaluation share it): a judging
 *                       look under the window's budget, or with the reasoning-fix flag a free look whose outcomes
 *                       are hidden
 *
 * Refused: a run spanning two windows or reaching outside the split; a learning run without its end of day
 * (`endOfDay: false`: a position carried into the next session would settle a decision on another day than its
 * own); and `"learning": false` on any test or final day, so the sealed windows have no way around their look
 * (a replay outside the split, after 2026, declares itself not learning).
 *
 * One ledger: every look goes to the canonical ledger (looks.js ledgerPath, the user's FTH_HOME), never one named
 * per run, so no run starts a budget of its own; the run keeps the ledger's path and a resume under another is
 * refused. What was decided is kept with the run's own record (<run dir>/learning-run.json, with a copy in the run
 * home for the tools a cycle calls) and checked again on every resume: a resumed run keeps its role and its look,
 * and its repeat look is free. A run declared not learning is recorded as such: the learning loop's own tools (the
 * experience log, the index, the pinned record) refuse it, so it never teaches and is never shown a record.
 *
 *   checkLearningRun(opts)      the gate's answer, nothing recorded (before the run home is seeded); throws when refused
 *   startLearningRun(runHome, { runDir, from, to, runId, learning, endOfDay, candidate, evaluation, validate, reasoningFix, env, now })
 *       { learning, role, look, hideOutcomes, taken }; throws when refused
 *   readLearningRun(dir)        the decision kept in a run dir or a run home, or null (a run started before the gate)
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../harness-run');
const { rolesBetween, assertUse, touchesSealed, SEALED } = require('./splits');
const { recordLook, checkLook, ledgerPath } = require('./looks');
const { readLedger } = require('../prop/ledger-file');

const FILE = 'learning-run.json';

function readLearningRun(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
  } catch (_err) {
    return null;
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function decide({ from, to, runId, learning, endOfDay, candidate, evaluation, validate, reasoningFix }) {
  if (learning === false) {
    if (candidate || evaluation || validate || reasoningFix) throw new Error('a run declared "learning": false takes no candidate, evaluation, validate or reasoning-fix flag');
    if (touchesSealed(from, to)) throw new Error('learning run refused: "learning": false on a test or final day; the sealed windows are judged only through their look (--candidate, --evaluation)');
    return { learning: false, role: null, look: null, hideOutcomes: false };
  }
  if (endOfDay === false) throw new Error('learning run refused: a learning run keeps its end of day (endOfDay: false would carry a position into the next session, and its decision would settle on another day)');
  let roles;
  try {
    roles = rolesBetween(from, to);
  } catch (e) {
    throw new Error(`learning run refused: ${e.message} (a replay outside the learning split declares "learning": false in its config)`, { cause: e });
  }
  if (roles.length > 1) throw new Error(`learning run refused: it spans ${roles.join(' + ')}; a learning run lies inside one window`);
  const role = roles[0];
  if (role === 'practice-train') {
    if (validate || reasoningFix || candidate || evaluation) throw new Error('learning run refused: practice-train is practice; no candidate, evaluation, validate or reasoning-fix flag');
    assertUse('practice', from, to);
    return { learning: true, role, look: null, hideOutcomes: false };
  }
  if (role === 'practice-validate') {
    if (!validate) throw new Error('learning run refused: practice-validate months need the validate flag (--validate); every validate run is logged and counted');
    if (reasoningFix) throw new Error('learning run refused: reasoning-fix looks are for test and final');
    assertUse('validate', from, to);
    return { learning: true, role, look: { evaluation: evaluation || runId, candidate: candidate || runId, purpose: 'validate' }, hideOutcomes: false };
  }
  if (validate) throw new Error(`learning run refused: ${role} is sealed, not validate`);
  if (!candidate || !evaluation) throw new Error(`learning run refused: ${role} is sealed: name the candidate it judges (--candidate) and the evaluation id its arms share (--evaluation)`);
  assertUse(role, from, to);
  return { learning: true, role, look: { evaluation, candidate, purpose: reasoningFix ? 'reasoning-fix' : 'judging' }, hideOutcomes: Boolean(reasoningFix) };
}

const OPTS = o => ({ from: o.from, to: o.to, runId: o.runId, learning: o.learning !== false, endOfDay: o.endOfDay, candidate: o.candidate || null, evaluation: o.evaluation || null, validate: o.validate === true, reasoningFix: o.reasoningFix === true });

function checkLearningRun(opts = {}) {
  const d = decide(OPTS(opts));
  if (d.look) {
    const file = ledgerPath(opts.env || process.env);
    const ledger = fs.existsSync(file) ? readLedger(file) : [];
    const r = checkLook({ ...d.look, runId: opts.runId, from: opts.from, to: opts.to }, ledger);
    if (!r.ok) throw new Error(`look refused: ${r.refusals.join('; ')}`);
  }
  return d;
}

function startLearningRun(runHome, opts = {}) {
  const { runDir = null, env = process.env, now = new Date() } = opts;
  const d = decide(OPTS(opts));
  const homes = [runDir, runHome].filter(Boolean);
  const before = homes.map(readLearningRun).find(Boolean) || null;
  const kept = { learning: d.learning, role: d.role, look: d.look, hideOutcomes: d.hideOutcomes };
  if (before && !same({ learning: before.learning, role: before.role, look: before.look, hideOutcomes: before.hideOutcomes }, kept)) {
    throw new Error(`learning run refused: this run started as ${JSON.stringify({ learning: before.learning, role: before.role, look: before.look })}; a resume keeps it (start another runId to change it)`);
  }
  let ledger = null;
  let taken = null;
  if (d.look) {
    ledger = ledgerPath(env);
    if (before && before.ledger && before.ledger !== ledger) throw new Error(`learning run refused: this run's look is in ${before.ledger}, not ${ledger}: one ledger (the same FTH_HOME) for a run and its resumes`);
    taken = recordLook(ledger, { ...d.look, runId: opts.runId, from: opts.from, to: opts.to }, { create: true, now });
  }
  if (!before) for (const dir of homes) writeJsonAtomic(path.join(dir, FILE), { ...kept, ledger, startedAt: now.toISOString() });
  return { ...kept, taken };
}

module.exports = { checkLearningRun, startLearningRun, readLearningRun, FILE, SEALED };
