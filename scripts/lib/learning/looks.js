'use strict';

/**
 * The learning ledger (learning/splits.js windows): every replay of the learning loop that looks at months outside
 * practice-train is logged here before its first cycle (learning/run-gate.js), and the sealed windows' budgets are
 * spent here. Its own file, <FTH_HOME>/learning/looks.jsonl, in the prop ledger's format (prop/looks.js parseLedger,
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
 * A ledger line is a look { kind: 'look', evaluation, candidate, purpose, runId, from, to, role, at } or a result
 * { kind: 'result', evaluation, candidate, role: 'test', result: 'pass' | 'fail', at }.
 *
 *   checkLook(look, ledger, { budgets })    { ok, refusals, role, purpose, spent, remaining, budget, repeat, shared, hideOutcomes }
 *   recordLook(file, look, { create, now, budgets })   check, then append under the lock; throws when refused
 *   recordResult(file, result, { now })     a test evaluation's result (pass lets its candidate take the final look)
 *   lookUsage(ledger)                       per role: looks, runs, evaluations spent
 *   ledgerPath(env)
 */

const fs = require('fs');
const path = require('path');
const { harnessHome } = require('../paths');
const { readLedger, appendLook, withLedgerLock } = require('../prop/ledger-file');
const { rolesBetween, sessionDate, SEALED } = require('./splits');

const LOOK_BUDGETS = Object.freeze({ test: 3, final: 1 });
const FINAL_NEEDS_TEST_PASS = true;
const PURPOSES = Object.freeze(['judging', 'reasoning-fix', 'validate']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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
const looksOf = ledger => [...RECORDED_LOOKS, ...ledger.filter(e => e && e.kind !== 'result')];
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
  const repeat = atRole.some(e => e.evaluation === l.evaluation && e.runId === l.runId && e.purpose === l.purpose);
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
        kind: 'look', evaluation: look.evaluation, candidate: look.candidate, purpose: look.purpose, runId: look.runId,
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

const ledgerPath = (env = process.env) => path.join(harnessHome(env), 'learning', 'looks.jsonl');

module.exports = { LOOK_BUDGETS, FINAL_NEEDS_TEST_PASS, PURPOSES, RECORDED_LOOKS, checkLook, recordLook, recordResult, lookUsage, ledgerPath };
