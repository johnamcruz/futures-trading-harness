'use strict';

/**
 * The learning ledger (learning/splits.js windows): every replay of the learning loop that looks at months outside
 * practice-train is logged here before its first cycle (learning/run-gate.js), and the sealed windows' budgets are
 * spent here. Its own file, ~/.futures-trading-harness/learning/looks.jsonl (the default home, whatever FTH_HOME), in the prop ledger's format (prop/looks.js parseLedger,
 * prop/ledger-file.js: JSON lines, appended under a lock), so the two budgets never mix.
 *
 * The owner's rules (the schedule's learning.sealed, config/schedule.json: LOOK_BUDGETS and FINAL_NEEDS_TEST_PASS):
 *   test                 judging: LOOK_BUDGETS.test looks, counted per evaluation: every arm of one evaluation (with
 *                        experience, without, shuffled) runs under one evaluation id and spends one look together
 *   final                judging: LOOK_BUDGETS.final look, and only for a candidate with a test pass in the ledger
 *                        (recordResult)
 *   reasoning-fix        at test or final: free, and the run's outcomes are hidden (hideOutcomes)
 *   practice-validate    purpose validate: no budget, but every run is logged and counted; the stage-1 exit test
 *                        pools a candidate's first VALIDATE_RUNS_PER_CANDIDATE runs (validateRuns) and reads no more
 *   practice-train       no look: practice
 *
 * An evaluation id belongs to its first look: another candidate, purpose or window under it is refused, and it holds
 * at most MAX_ARMS runs, each a different arm (with:<index>, without, shuffled:<index>, each with +library:<library>
 * when shown the history library) naming its run setup (config hash): a judging look names both, so two arms differ in
 * their experience index only (the same config) or in the library's display only (below).
 *
 * A resumed run's look (the same evaluation, run id and purpose) is free, and it is the look it took: a resume naming
 * another arm, or another setup without its code (`setup`), than its ledger line is refused (its config and base digest
 * the code, so they are not compared: a code fix doesn't strand it).
 *
 * The model's risk record display (replay/config.js riskRecordDisplay) is a dimension of the same kind: an arm shown it ends
 * in `+risk:<record hash>` (after any `+library:`), and a with/without-risk-record pair shares its base and index and differs
 * in that display only (never both displays at once).
 *
 * The history library's display (replay/config.js libraryDisplay) is an arm dimension of its own: an arm shown the
 * library ends in `+library:<library hash>` (e.g. `without+library:<hash>`), and its config hash (which names the
 * display) is not the hidden arm's. A paired with/without-library comparison is two arms of one evaluation that share
 * their `base` (the setup without the display, replay/config.js setupBase: the same library pinned in both) and their
 * experience arm, and differ in the display only. Every two arms of an evaluation differ in one dimension: the same
 * config (their index), or the same base and index (the display); never both. A look's `base` is kept only when it
 * isn't its config (a run without the display: the line it had).
 *
 * A ledger line is a look { kind: 'look', evaluation, candidate, purpose, runId, arm, config, base?, setup?, from, to, role, at }, a result
 * { kind: 'result', evaluation, candidate, role: 'test', result: 'pass' | 'fail', at }, or a score { kind: 'score',
 * evaluation, candidate, runId, role, from, to, rulebook, diagnostic, at } (a prop Monte Carlo of a run's trades, logged
 * beside the run's look; never a look itself).
 *
 *   checkLook(look, ledger)    { ok, refusals, role, purpose, spent, remaining, budget, repeat, shared, hideOutcomes }
 *   recordLook(file, look, { create, now })   check, then append under the lock; throws when refused
 *   recordResult(file, result, { now })     a test evaluation's result (pass lets its candidate take the final look)
 *   recordScore(file, entry)                a Monte Carlo score of a run, beside its look (refused without it)
 *   scoresOf(ledger)                        the scores logged
 *   validateRuns(ledger, candidate, mode)   { counted, beyond, all }: the validate runs the stage-1 exit test pools (of one
 *                                           training mode: a look's `mode`, none for stage 1)
 *   lookUsage(ledger)                       per role: looks, runs, evaluations spent
 *   ledgerPath(env)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { harnessHome } = require('../paths');
const { readLedger, appendLook, withLedgerLock } = require('../prop/ledger-file');
const { rolesBetween, sessionDate, SEALED } = require('./splits');
const schedule = require('../schedule');

/**
 * The schedule's learning budgets (config/schedule.json learning.sealed, schedule.js): looks per sealed window
 * (LOOK_BUDGETS, counted per evaluation), whether the final look needs a test pass (FINAL_NEEDS_TEST_PASS), and the
 * validate runs of one candidate the stage-1 exit test pools (VALIDATE_RUNS_PER_CANDIDATE, validateRuns). Each
 * validate run judged alone would be a fresh chance at a false pass (about 1 to 2% a run at zero edge), so retries
 * compound; the test reads the candidate's runs pooled, and only its first VALIDATE_RUNS_PER_CANDIDATE: at most that
 * many looks at one candidate's exit test, and a later run can't move it. A new candidate (another skill version)
 * starts its own. Read when used: a refused schedule throws, never a default.
 */
const S = () => schedule.current().learning;
/** Runs one evaluation may hold: its arms (with experience, without, shuffled). */
const MAX_ARMS = require('../tunables').training().looks.maxArms; // config/training.json (only falls)
const PURPOSES = Object.freeze(['judging', 'reasoning-fix', 'validate']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** An arm: the experience index it was shown (with:<hash>, shuffled:<hash>) or none (without), and `+library:<hash>` when shown the history library. */
const ARM = /^(?:without|with:[0-9a-f]{16}|shuffled:[0-9a-f]{16})(?:\+library:[0-9a-f]{16})?(?:\+risk:[0-9a-f]{16})?$/;
const LIBRARY_ARM = /\+library:[0-9a-f]{16}/;
const RISK_ARM = /\+risk:[0-9a-f]{16}/;
/** An arm's experience part (its index), without the displays. */
const indexArm = arm => String(arm || '').replace(LIBRARY_ARM, '').replace(RISK_ARM, '');
/** An arm's display of each kind (the suffix, or ''): the dimensions a with/without comparison varies. */
const libraryPart = arm => (LIBRARY_ARM.exec(String(arm || '')) || [''])[0];
const riskPart = arm => (RISK_ARM.exec(String(arm || '')) || [''])[0];
/** The setup without the displays: the look's base, or its config when it has none (no display). */
const baseOf = e => e.base || e.config;
/** Whether an arm is shown the history library (the `+library` suffix; replay/config.js lookArm, via scripts/replay.js, is its only producer). */
const shownArm = arm => LIBRARY_ARM.test(String(arm || ''));
/** Whether an arm is shown the model's risk record (the `+risk` suffix; lookArm is its only producer). */
const riskArm = arm => RISK_ARM.test(String(arm || ''));
/** Whether an arm is shown anything beyond its experience index: its look names its setup without the displays (base). */
const displayArm = arm => shownArm(arm) || riskArm(arm);
/** Looks taken before the ledger existed, so it starts true: the schedule's learning.sealed.recordedLooks. */
const recordedLooks = () => S().recordedLooks;

const roleOfLook = e => {
  if (typeof e.role === 'string') return e.role;
  try {
    const r = rolesBetween(e.from, e.to);
    return r.length === 1 ? r[0] : null;
  } catch (_err) {
    return null;
  }
};
// A score (recordScore) reads the outcomes a look already allowed: never a look of its own, never a budget spent.
const looksOf = ledger => [...recordedLooks(), ...ledger.filter(e => e && e.kind !== 'result' && e.kind !== 'score')];
const resultsOf = ledger => ledger.filter(e => e && e.kind === 'result');

/**
 * The look a learning role requires (schedule.js resolve): { purposes (allowed), budget (looks per sealed window,
 * counted per evaluation, or null), needsTestPass, validateCap (the validate runs the exit test pools, or null) }.
 */
function lookRule(role) {
  const s = S();
  if (role === 'practice-train') return { purposes: [], budget: null, needsTestPass: false, validateCap: null };
  if (role === 'practice-validate') return { purposes: ['validate'], budget: null, needsTestPass: false, validateCap: s.validateRunsPerCandidate };
  if (!SEALED.includes(role)) throw new Error(`no learning role "${role}"`);
  return { purposes: ['judging', 'reasoning-fix'], budget: s.lookBudgets[role], needsTestPass: role === 'final' && s.finalNeedsTestPass, validateCap: null };
}

function checkLook(look, ledger) {
  const budgets = S().lookBudgets;
  const refusals = [];
  const l = look || {};
  if (!ID.test(String(l.evaluation || ''))) refusals.push('a look names its evaluation id (letters, digits, ".", "_", "-"; the arms of one evaluation share it)');
  if (typeof l.candidate !== 'string' || !l.candidate.trim()) refusals.push('a look names its candidate');
  if (!ID.test(String(l.runId || ''))) refusals.push('a look names its run id');
  if (!PURPOSES.includes(l.purpose)) refusals.push(`a look names its purpose, one of ${PURPOSES.join(', ')}; not ${String(l.purpose)}`);
  if (!Array.isArray(ledger)) return { ok: false, refusals: [...refusals, 'the ledger is required, a list of looks'], role: null };
  // The sealed rule (schedule.js): no look under a schedule whose sealed learning windows changed after a look.
  refusals.push(...schedule.sealedRefusals('learning', ledger));
  let roles;
  try {
    roles = rolesBetween(l.from, l.to);
  } catch (e) {
    return { ok: false, refusals: [...refusals, e.message], role: null };
  }
  if (roles.length !== 1) return { ok: false, refusals: [...refusals, `a look lies inside one window, not ${roles.join(' + ')}`], role: null };
  const role = roles[0];
  if (role === 'practice-train') refusals.push('practice-train is practice: no look');
  if (role === 'practice-validate' && l.purpose !== 'validate') refusals.push(`practice-validate takes validate looks only, not ${String(l.purpose)}`);
  if (SEALED.includes(role) && l.purpose === 'validate') refusals.push(`${role} is sealed: a judging or reasoning-fix look, not validate`);
  const atRole = looksOf(ledger).filter(e => roleOfLook(e) === role);
  const prior = atRole.find(e => e.evaluation === l.evaluation && e.runId === l.runId && e.purpose === l.purpose);
  const repeat = Boolean(prior);
  // A resume is the look it took: the same arm as its line (an old line without one keeps none), and the same setup
  // without its code (`setup`, replay/config.js setupFixed: a line that has one). The arm names all the run is shown
  // (its index, and the library with its display); config and base are not compared, as they digest the code too, so a
  // code fix between a run's start and its resume stays a resume, as the manifest's configHash allows; a run home
  // deleted and started again with another runner config, model or documents is not. The pins can't change on a
  // resume (learning/run-pins.js, pinIndex, pinLibrary).
  if (prior && prior.arm != null && prior.arm !== (l.arm || 'without')) {
    refusals.push(`run ${l.runId} took its look in evaluation ${l.evaluation} as another arm (${l.arm || 'without'}, not ${prior.arm}): a resume keeps its arm (start another runId)`);
  }
  if (prior && prior.setup != null && prior.setup !== (l.setup || null)) {
    refusals.push(`run ${l.runId} took its look in evaluation ${l.evaluation} with another setup (${String(l.setup).slice(0, 12)}, not ${String(prior.setup).slice(0, 12)}: its runner config, documents, library or its display changed): a resume keeps its setup (start another runId)`);
  }
  // An evaluation is its first look's: the same candidate, purpose and window, at most MAX_ARMS runs (its arms), and
  // the same schedule (config/schedule.json): its arms are compared, so none runs under another schedule.
  const first = looksOf(ledger).find(e => e.evaluation === l.evaluation);
  const evalSchedule = first ? schedule.entryFingerprint(first) : null;
  if (evalSchedule && evalSchedule.hash !== schedule.current().fingerprint.hash) {
    refusals.push(`evaluation ${l.evaluation} was taken under schedule ${evalSchedule.version} (${evalSchedule.hash.slice(0, 12)}), not the current ${schedule.current().version} (${schedule.current().fingerprint.hash.slice(0, 12)}): one evaluation runs under one schedule (start another evaluation id)`);
  }
  if (first && refusals.length === 0) {
    let span = null;
    try { span = [sessionDate(l.from), sessionDate(l.to)]; } catch (_err) { /* refused above */ }
    if (first.candidate !== l.candidate || first.purpose !== l.purpose || roleOfLook(first) !== role || !span || first.from !== span[0] || first.to !== span[1]) {
      refusals.push(`evaluation ${l.evaluation} is ${first.candidate}'s ${first.purpose} look at ${first.from}..${first.to}: another candidate, purpose or window takes an evaluation id of its own`);
    }
    const runs = looksOf(ledger).filter(e => e.evaluation === l.evaluation);
    const arms = new Set(runs.map(e => e.runId));
    if (!arms.has(l.runId) && arms.size >= MAX_ARMS) refusals.push(`evaluation ${l.evaluation} has its ${MAX_ARMS} arms (${[...arms].join(', ')})`);
    // Every two arms differ in one dimension: their index (the same run setup, its config hash) or the library's
    // display (the same base and index); each a different arm.
    if (!arms.has(l.runId)) {
      for (const e of runs.filter(x => x.config)) {
        // The same config: the index differs, and the display and base must agree with it (the config names both).
        if (l.config === e.config) {
          if (libraryPart(e.arm) !== libraryPart(l.arm) || riskPart(e.arm) !== riskPart(l.arm) || baseOf(e) !== baseOf(l)) {
            refusals.push(`evaluation ${l.evaluation}: arm ${l.arm} has ${e.runId}'s setup (config ${String(e.config).slice(0, 12)}) but not its library display or base, or its risk record display (arm ${e.arm})`);
            break;
          }
          continue;
        }
        // One display differs, the other kind alike: a display is shown in one arm and hidden in the other.
        const libDiffers = shownArm(e.arm) !== shownArm(l.arm);
        const riskDiffers = riskArm(e.arm) !== riskArm(l.arm);
        const alike = libDiffers ? riskPart(e.arm) === riskPart(l.arm) : libraryPart(e.arm) === libraryPart(l.arm);
        const pair = baseOf(e) === baseOf(l) && indexArm(e.arm) === indexArm(l.arm) && libDiffers !== riskDiffers && alike;
        if (!pair) {
          refusals.push(`evaluation ${l.evaluation}: its arms differ only in their experience index, or only in the history library's display, or only in the risk record's; this run's setup (config ${String(l.config).slice(0, 12)}, arm ${l.arm}) is not ${e.runId}'s (config ${String(e.config).slice(0, 12)}, arm ${e.arm})`);
          break;
        }
      }
      if (l.arm && runs.some(e => e.arm === l.arm)) refusals.push(`evaluation ${l.evaluation} has its ${l.arm} arm already`);
    }
  }
  if (SEALED.includes(role) && l.purpose === 'judging' && !(l.arm && ARM.test(l.arm) && l.config)) refusals.push('a judging look names its arm (with:<index>, without, shuffled:<index>, each with +library:<library> when shown the history library, +risk:<record> when shown the risk record) and its run setup (config hash)');
  // The arm says the display; its base says the same (a shown arm's setup is not its base, a hidden one's is).
  if (l.arm && displayArm(l.arm) && !(l.base && l.config && l.base !== l.config)) refusals.push(`arm ${l.arm} is shown the history library or the risk record: its look names its setup without the display (base), not its config`);
  if (l.arm && !displayArm(l.arm) && l.base && l.base !== l.config) refusals.push(`arm ${l.arm} is not shown the history library: its base is its config (nor the risk record)`);
  const judged = new Set(atRole.filter(e => e.purpose === 'judging').map(e => e.evaluation));
  const shared = l.purpose === 'judging' && judged.has(l.evaluation);
  const budget = SEALED.includes(role) ? budgets[role] : null;
  const spent = SEALED.includes(role) ? judged.size : null;
  const remaining = budget === null ? null : Math.max(0, budget - spent);
  if (refusals.length === 0 && l.purpose === 'judging' && !shared) {
    if (remaining === 0) refusals.push(`${role}: its ${budget} look(s) are spent (counted per evaluation); the window is sealed`);
    if (role === 'final' && S().finalNeedsTestPass && !resultsOf(ledger).some(r => r.role === 'test' && r.result === 'pass' && r.candidate === l.candidate)) {
      refusals.push(`final: candidate ${l.candidate} has no test pass in the ledger; the final look comes only after one (recordResult)`);
    }
  }
  return { ok: refusals.length === 0, refusals, role, purpose: l.purpose, budget, spent, remaining, repeat, shared, hideOutcomes: l.purpose === 'reasoning-fix' };
}

/**
 * Run fn on the ledger's looks under its lock; a missing ledger is started only with `create`. Nothing is written
 * under a schedule the sealed rule refuses (schedule.js assertSealed): a look, a result or a score.
 */
function underLock(file, create, fn) {
  if (!fs.existsSync(file)) {
    if (!create) readLedger(file); // throws: no ledger at <file>
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  return withLedgerLock(file, () => {
    const ledger = readLedger(file, { create });
    schedule.assertSealed('learning', ledger);
    return fn(ledger);
  });
}

/** Check a look and append it (a repeat of the same run is not appended again). Throws when refused. */
function recordLook(file, look, { create = false, now = new Date() } = {}) {
  return underLock(file, create, ledger => {
    const r = checkLook(look, ledger);
    if (!r.ok) throw new Error(`look refused: ${r.refusals.join('; ')}`);
    if (!r.repeat) {
      appendLook(file, {
        kind: 'look', evaluation: look.evaluation, candidate: look.candidate, purpose: look.purpose, runId: look.runId, arm: look.arm || null, config: look.config || null,
        ...(look.base && look.base !== look.config ? { base: look.base } : {}),
        ...(look.setup ? { setup: look.setup } : {}),
        // A training mode's run (gateOptions mode: combine, account-states; the loop's day-attempts) names it, so pools never mix the modes.
        ...(look.mode ? { mode: look.mode } : {}),
        from: sessionDate(look.from), to: sessionDate(look.to), role: r.role, at: now.toISOString(),
      });
    }
    return { ...r, appended: !r.repeat };
  });
}

/** A test evaluation's result. Refused unless that evaluation judged test in the ledger. */
function recordResult(file, { evaluation, candidate, result }, { now = new Date() } = {}) {
  if (!['pass', 'fail'].includes(result)) throw new Error('result: pass or fail');
  return underLock(file, false, ledger => {
    const judged = looksOf(ledger).some(e => e.evaluation === evaluation && e.candidate === candidate && e.purpose === 'judging' && roleOfLook(e) === 'test');
    if (!judged) throw new Error(`no judging look at test for evaluation ${evaluation} of ${candidate}: a result follows its look`);
    const entry = { kind: 'result', evaluation, candidate, role: 'test', result, at: now.toISOString() };
    appendLook(file, entry);
    return entry;
  });
}

/**
 * A Monte Carlo score of a run's trades (prop/evaluator.js checkModelWindow builds the entry): appended beside the run's
 * look, which must be in the ledger (the same run, evaluation and role); every score is kept, so how often a sealed run
 * was scored, and with which rulebook, is on the record. Never counted as a look. Throws without the look.
 */
function recordScore(file, entry) {
  const e = entry || {};
  if (e.kind !== 'score' || !ID.test(String(e.runId || '')) || !ID.test(String(e.evaluation || '')) || typeof e.role !== 'string') throw new Error('a score names its run, its evaluation and its role (kind: score)');
  return underLock(file, false, ledger => {
    const look = looksOf(ledger).find(l => l.runId === e.runId && l.evaluation === e.evaluation && roleOfLook(l) === e.role);
    if (!look) throw new Error(`no ${e.role} look of run ${e.runId} (evaluation ${e.evaluation}) in the ledger: a run's outcomes are scored only through the look it took before its first cycle`);
    appendLook(file, { ...e });
    return e;
  });
}

/**
 * A candidate's validate runs, in the order their looks were taken: the runs the stage-1 exit test pools
 * (replay/stage.js), the first VALIDATE_RUNS_PER_CANDIDATE of them only. { counted, beyond, all: { runs, candidates } }:
 * counted, the run ids the test reads; beyond, the later ones it never reads (a retry past the cap can't move it);
 * all, every validate run and candidate the ledger holds (the family of tests the exit test is one of); windows, each
 * counted run's look window { runId, from, to } (runs over the same days overlap: the pooled test counts a day and a
 * moment once).
 */
function validateRuns(ledger, candidate, mode = null) {
  // Only the runs of the same training mode (a look's `mode`: none for stage 1): a combine run, a drawn-state run and a
  // stage-1 run never pool.
  const validate = looksOf(Array.isArray(ledger) ? ledger : []).filter(e => e.purpose === 'validate' && roleOfLook(e) === 'practice-validate' && (e.mode || null) === mode);
  const ids = [...new Set(validate.filter(e => e.candidate === candidate).map(e => e.runId))];
  const cap = S().validateRunsPerCandidate;
  const counted = ids.slice(0, cap);
  const windows = counted.map(id => { const l = validate.find(e => e.runId === id); return { runId: id, from: l.from, to: l.to }; });
  return {
    counted, windows, beyond: ids.slice(cap),
    all: { runs: new Set(validate.map(e => e.runId)).size, candidates: new Set(validate.map(e => e.candidate)).size },
  };
}

/** The scores in the ledger (recordScore), oldest first. */
const scoresOf = ledger => (Array.isArray(ledger) ? ledger.filter(e => e && e.kind === 'score') : []);

/**
 * Per role: { looks, runs, evaluations (judging), versions }: versions, the schedule version each look was taken under
 * ({ version: looks }; a look from before fingerprints, and a recorded look, the first schedule's: schedule.js).
 */
function lookUsage(ledger) {
  const out = {};
  for (const e of looksOf(ledger)) {
    const role = roleOfLook(e);
    if (!role) continue;
    const u = out[role] || (out[role] = { looks: 0, runs: new Set(), evaluations: new Set(), versions: {} });
    u.looks += 1;
    u.runs.add(e.runId);
    if (e.purpose === 'judging') u.evaluations.add(e.evaluation);
    const v = schedule.scheduleVersion(e);
    u.versions[v] = (u.versions[v] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).map(([k, u]) => [k, { looks: u.looks, runs: u.runs.size, evaluations: u.evaluations.size, versions: u.versions }]));
}

/**
 * The one ledger: under the default harness home (~/.futures-trading-harness), whatever FTH_HOME says, so a run under
 * another home never starts a budget of its own. `env.HOME` names the home folder (os.homedir() without it).
 */
const ledgerPath = (env = process.env) => path.join(harnessHome({}, String(env.HOME || '').trim() || os.homedir()), 'learning', 'looks.jsonl');

module.exports = {
  // The schedule's values, read when used (config/schedule.json learning.sealed).
  get LOOK_BUDGETS() { return S().lookBudgets; },
  get FINAL_NEEDS_TEST_PASS() { return S().finalNeedsTestPass; },
  get VALIDATE_RUNS_PER_CANDIDATE() { return S().validateRunsPerCandidate; },
  get RECORDED_LOOKS() { return recordedLooks(); },
  MAX_ARMS, PURPOSES, ARM, lookRule, checkLook, recordLook, recordResult, recordScore, scoresOf, validateRuns, lookUsage, ledgerPath,
};
