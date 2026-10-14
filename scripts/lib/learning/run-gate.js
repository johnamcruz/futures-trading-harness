'use strict';

/**
 * A replay's learning gate, before its first cycle (scripts/replay.js run): every replay is a learning run unless its
 * config says `"learning": false`, and a learning run lies inside one window of the learning split (learning/splits.js)
 * and takes its look first (learning/looks.js):
 *
 *   practice-train      practice: no look (assertUse 'practice')
 *   practice-validate   only with the explicit validate flag; a validate look, unbudgeted but counted
 *   test, final         only with a candidate and an evaluation id (the arms of one evaluation share it): a judging
 *                       look under the window's budget, or with the reasoning-fix flag a free look whose outcomes
 *                       are hidden
 *
 * A run spanning two windows, or reaching outside the split, is refused. What was decided is kept in the run home
 * (<run home>/learning-run.json) and checked again on every resume: a resumed run keeps its role and its look, and
 * its repeat look is free. A run declared not learning (`"learning": false`) is recorded as such: the learning
 * loop's own tools (the experience log, the index, the pinned record) refuse it, so it never teaches and is never
 * shown a record.
 *
 *   startLearningRun(runHome, { from, to, runId, learning, candidate, evaluation, validate, reasoningFix, ledgerFile, env, now })
 *       { learning, role, look, hideOutcomes }; throws when refused, before anything is recorded for the run
 *   checkLearningRun(opts)      the same answer, nothing recorded (before the run home is seeded)
 *   readLearningRun(runHome)    the run's decision, or null (a run started before the gate, or never started)
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../harness-run');
const { rolesBetween, assertUse, SEALED } = require('./splits');
const { recordLook, checkLook, ledgerPath } = require('./looks');
const { readLedger } = require('../prop/ledger-file');

const FILE = 'learning-run.json';

function readLearningRun(runHome) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runHome, FILE), 'utf8'));
  } catch (_err) {
    return null;
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function decide({ from, to, runId, learning, candidate, evaluation, validate, reasoningFix }) {
  if (learning === false) {
    if (candidate || evaluation || validate || reasoningFix) throw new Error('a run declared "learning": false takes no candidate, evaluation, validate or reasoning-fix flag');
    return { learning: false, role: null, look: null, hideOutcomes: false };
  }
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

const ledgerOf = (ledgerFile, env) => (ledgerFile ? path.resolve(ledgerFile) : ledgerPath(env));

/**
 * The gate's answer without recording anything (before the run home is seeded): throws when the run would be
 * refused, its look included (a missing default ledger reads as empty; a named one must exist).
 */
function checkLearningRun({ from, to, runId, learning = true, candidate = null, evaluation = null, validate = false, reasoningFix = false, ledgerFile = null, env = process.env } = {}) {
  const d = decide({ from, to, runId, learning, candidate, evaluation, validate, reasoningFix });
  if (d.look) {
    const file = ledgerOf(ledgerFile, env);
    const ledger = !ledgerFile && !fs.existsSync(file) ? [] : readLedger(file);
    const r = checkLook({ ...d.look, runId, from, to }, ledger);
    if (!r.ok) throw new Error(`look refused: ${r.refusals.join('; ')}`);
  }
  return d;
}

function startLearningRun(runHome, { from, to, runId, learning = true, candidate = null, evaluation = null, validate = false, reasoningFix = false, ledgerFile = null, env = process.env, now = new Date() } = {}) {
  const d = decide({ from, to, runId, learning, candidate, evaluation, validate, reasoningFix });
  const before = readLearningRun(runHome);
  const kept = { learning: d.learning, role: d.role, look: d.look, hideOutcomes: d.hideOutcomes };
  if (before && !same({ learning: before.learning, role: before.role, look: before.look, hideOutcomes: before.hideOutcomes }, kept)) {
    throw new Error(`learning run refused: this run started as ${JSON.stringify({ learning: before.learning, role: before.role, look: before.look })}; a resume keeps it (start another runId to change it)`);
  }
  let ledger = null;
  let taken = null;
  if (d.look && SEALED.concat(['practice-validate']).includes(d.role)) {
    const file = ledgerOf(ledgerFile, env);
    // The default ledger starts itself on the first look; a ledger named on purpose must exist (a typo never starts a budget).
    taken = recordLook(file, { ...d.look, runId, from, to }, { create: !ledgerFile, now });
    ledger = path.basename(file);
  }
  if (!before) writeJsonAtomic(path.join(runHome, FILE), { ...kept, ledger, startedAt: now.toISOString() });
  return { ...kept, taken };
}

module.exports = { checkLearningRun, startLearningRun, readLearningRun, FILE };
