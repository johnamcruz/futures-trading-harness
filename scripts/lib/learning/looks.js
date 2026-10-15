'use strict';

/**
 * The learning ledger (learning/splits.js windows): every replay of the learning loop that looks at months outside
 * practice-train is logged here before its first cycle (learning/run-gate.js), and the sealed windows' budgets are
 * spent here. Its own file, ~/.futures-trading-harness/learning/looks.jsonl (the default home, whatever FTH_HOME), in the prop ledger's format (prop/looks.js parseLedger,
 * prop/ledger-file.js: JSON lines, appended under a lock), so the two budgets never mix.
 *
 * The owner's rules (the defaults, BUDGETS and FINAL_NEEDS_TEST_PASS):
 *   test (2025)          judging: LOOK_BUDGETS.test looks, counted per evaluation: every arm of one evaluation (with
 *                        experience, without, shuffled) runs under one evaluation id and spends one look together
 *   final (2026)         judging: LOOK_BUDGETS.final look, and only for a candidate with a test pass in the ledger
 *                        (recordResult)
 *   reasoning-fix        at test or final: free, and the run's outcomes are hidden (hideOutcomes)
 *   practice-validate    purpose validate: no budget, but every run is logged and counted
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
 *   checkLook(look, ledger, { budgets })    { ok, refusals, role, purpose, spent, remaining, budget, repeat, shared, hideOutcomes }
 *   recordLook(file, look, { create, now, budgets })   check, then append under the lock; throws when refused
 *   recordResult(file, result, { now })     a test evaluation's result (pass lets its candidate take the final look)
 *   recordScore(file, entry)                a Monte Carlo score of a run, beside its look (refused without it)
 *   scoresOf(ledger)                        the scores logged
 *   lookUsage(ledger)                       per role: looks, runs, evaluations spent
 *   ledgerPath(env)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { harnessHome } = require('../paths');
const { readLedger, appendLook, withLedgerLock } = require('../prop/ledger-file');
const { rolesBetween, sessionDate, SEALED } = require('./splits');

const LOOK_BUDGETS = Object.freeze({ test: 3, final: 1 });
const FINAL_NEEDS_TEST_PASS = true;
/** Runs one evaluation may hold: its arms (with experience, without, shuffled). */
const MAX_ARMS = 3;
const PURPOSES = Object.freeze(['judging', 'reasoning-fix', 'validate']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** An arm: the experience index it was shown (with:<hash>, shuffled:<hash>) or none (without), and `+library:<hash>` when shown the history library. */
const ARM = /^(?:without|with:[0-9a-f]{16}|shuffled:[0-9a-f]{16})(?:\+library:[0-9a-f]{16})?$/;
const LIBRARY_ARM = /\+library:[0-9a-f]{16}$/;
/** An arm's experience part (its index), without the library display. */
const indexArm = arm => String(arm || '').replace(LIBRARY_ARM, '');
/** The setup without the library display: the look's base, or its config when it has none (no display). */
const baseOf = e => e.base || e.config;
/** Whether an arm is shown the history library (the `+library` suffix; replay/config.js lookArm, via scripts/replay.js, is its only producer). */
const shownArm = arm => LIBRARY_ARM.test(String(arm || ''));
/** Looks taken before the ledger existed, so it starts true. */
const RECORDED_LOOKS = Object.freeze([
  Object.freeze({ kind: 'look', evaluation: 'llm-replay-2026-06', candidate: 'llm-replay-2026-06', purpose: 'reasoning-fix', runId: 'llm-replay-2026-06', from: '2026-06-01', to: '2026-06-06', role: 'final', what: 'LLM replay, June 1-5 2026, adherence only' }),
]);

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
const looksOf = ledger => [...RECORDED_LOOKS, ...ledger.filter(e => e && e.kind !== 'result' && e.kind !== 'score')];
const resultsOf = ledger => ledger.filter(e => e && e.kind === 'result');

function checkLook(look, ledger, { budgets = LOOK_BUDGETS } = {}) {
  const refusals = [];
  const l = look || {};
  if (!ID.test(String(l.evaluation || ''))) refusals.push('a look names its evaluation id (letters, digits, ".", "_", "-"; the arms of one evaluation share it)');
  if (typeof l.candidate !== 'string' || !l.candidate.trim()) refusals.push('a look names its candidate');
  if (!ID.test(String(l.runId || ''))) refusals.push('a look names its run id');
  if (!PURPOSES.includes(l.purpose)) refusals.push(`a look names its purpose, one of ${PURPOSES.join(', ')}; not ${String(l.purpose)}`);
  if (!Array.isArray(ledger)) return { ok: false, refusals: [...refusals, 'the ledger is required, a list of looks'], role: null };
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
  // An evaluation is its first look's: the same candidate, purpose and window, at most MAX_ARMS runs (its arms).
  const first = looksOf(ledger).find(e => e.evaluation === l.evaluation);
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
          if (shownArm(e.arm) !== shownArm(l.arm) || baseOf(e) !== baseOf(l)) {
            refusals.push(`evaluation ${l.evaluation}: arm ${l.arm} has ${e.runId}'s setup (config ${String(e.config).slice(0, 12)}) but not its library display or base (arm ${e.arm})`);
            break;
          }
          continue;
        }
        const pair = baseOf(e) === baseOf(l) && indexArm(e.arm) === indexArm(l.arm) && shownArm(e.arm) !== shownArm(l.arm);
        if (!pair) {
          refusals.push(`evaluation ${l.evaluation}: its arms differ only in their experience index, or only in the history library's display; this run's setup (config ${String(l.config).slice(0, 12)}, arm ${l.arm}) is not ${e.runId}'s (config ${String(e.config).slice(0, 12)}, arm ${e.arm})`);
          break;
        }
      }
      if (l.arm && runs.some(e => e.arm === l.arm)) refusals.push(`evaluation ${l.evaluation} has its ${l.arm} arm already`);
    }
  }
  if (SEALED.includes(role) && l.purpose === 'judging' && !(l.arm && ARM.test(l.arm) && l.config)) refusals.push('a judging look names its arm (with:<index>, without, shuffled:<index>, each with +library:<library> when shown the history library) and its run setup (config hash)');
  // The arm says the display; its base says the same (a shown arm's setup is not its base, a hidden one's is).
  if (l.arm && LIBRARY_ARM.test(l.arm) && !(l.base && l.config && l.base !== l.config)) refusals.push(`arm ${l.arm} is shown the history library: its look names its setup without the display (base), not its config`);
  if (l.arm && !LIBRARY_ARM.test(l.arm) && l.base && l.base !== l.config) refusals.push(`arm ${l.arm} is not shown the history library: its base is its config`);
  const judged = new Set(atRole.filter(e => e.purpose === 'judging').map(e => e.evaluation));
  const shared = l.purpose === 'judging' && judged.has(l.evaluation);
  const budget = SEALED.includes(role) ? budgets[role] : null;
  const spent = SEALED.includes(role) ? judged.size : null;
  const remaining = budget === null ? null : Math.max(0, budget - spent);
  if (refusals.length === 0 && l.purpose === 'judging' && !shared) {
    if (remaining === 0) refusals.push(`${role}: its ${budget} look(s) are spent (counted per evaluation); the window is sealed`);
    if (role === 'final' && FINAL_NEEDS_TEST_PASS && !resultsOf(ledger).some(r => r.role === 'test' && r.result === 'pass' && r.candidate === l.candidate)) {
      refusals.push(`final: candidate ${l.candidate} has no test pass in the ledger; the final look comes only after one (recordResult)`);
    }
  }
  return { ok: refusals.length === 0, refusals, role, purpose: l.purpose, budget, spent, remaining, repeat, shared, hideOutcomes: l.purpose === 'reasoning-fix' };
}

/** Run fn on the ledger's looks under its lock; a missing ledger is started only with `create`. */
function underLock(file, create, fn) {
  if (!fs.existsSync(file)) {
    if (!create) readLedger(file); // throws: no ledger at <file>
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  return withLedgerLock(file, () => fn(readLedger(file, { create })));
}

/** Check a look and append it (a repeat of the same run is not appended again). Throws when refused. */
function recordLook(file, look, { create = false, now = new Date(), budgets = LOOK_BUDGETS } = {}) {
  return underLock(file, create, ledger => {
    const r = checkLook(look, ledger, { budgets });
    if (!r.ok) throw new Error(`look refused: ${r.refusals.join('; ')}`);
    if (!r.repeat) {
      appendLook(file, {
        kind: 'look', evaluation: look.evaluation, candidate: look.candidate, purpose: look.purpose, runId: look.runId, arm: look.arm || null, config: look.config || null,
        ...(look.base && look.base !== look.config ? { base: look.base } : {}),
        ...(look.setup ? { setup: look.setup } : {}),
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

/** The scores in the ledger (recordScore), oldest first. */
const scoresOf = ledger => (Array.isArray(ledger) ? ledger.filter(e => e && e.kind === 'score') : []);

/** Per role: { looks, runs, evaluations (judging), validateRuns }. */
function lookUsage(ledger) {
  const out = {};
  for (const e of looksOf(ledger)) {
    const role = roleOfLook(e);
    if (!role) continue;
    const u = out[role] || (out[role] = { looks: 0, runs: new Set(), evaluations: new Set() });
    u.looks += 1;
    u.runs.add(e.runId);
    if (e.purpose === 'judging') u.evaluations.add(e.evaluation);
  }
  return Object.fromEntries(Object.entries(out).map(([k, u]) => [k, { looks: u.looks, runs: u.runs.size, evaluations: u.evaluations.size }]));
}

/**
 * The one ledger: under the default harness home (~/.futures-trading-harness), whatever FTH_HOME says, so a run under
 * another home never starts a budget of its own. `env.HOME` names the home folder (os.homedir() without it).
 */
const ledgerPath = (env = process.env) => path.join(harnessHome({}, String(env.HOME || '').trim() || os.homedir()), 'learning', 'looks.jsonl');

module.exports = { LOOK_BUDGETS, FINAL_NEEDS_TEST_PASS, MAX_ARMS, PURPOSES, RECORDED_LOOKS, ARM, checkLook, recordLook, recordResult, recordScore, scoresOf, lookUsage, ledgerPath };
