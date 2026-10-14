'use strict';

/**
 * The learning loop's data split (the composed-entry design, section 4.7, with the owner's split): which months the model
 * practises on, which check that it learned, and which stay sealed. Separate from prop/splits.js on purpose: that
 * schedule is the promotion gate's (prop/promotion.js), frozen, and starts in 2021; this one is the learning loop's
 * and never moves a prop window. Each window is [from, to), session dates, `to` exclusive.
 *
 * - practice-train, 2020-01-01 to 2024-07-01: practice replays (exploration included), the experience log's
 *   teaching records, the experience index, lessons. Four and a half years: the 2020 crash and recovery, the 2021
 *   trend, the 2022 bear, the 2023-24 recovery, so the index sees every regime the briefing names.
 * - practice-validate, 2024-07-01 to 2025-01-01: the last six months before test, held back from the index. A
 *   validation replay reads the index built from practice-train and is never indexed itself. The carve-out is the
 *   tail, not a month per quarter: a held-back month between two practised months shares their regime and their
 *   news (leakage by adjacency), and the index would be judged on the weeks next to what built it; the tail is
 *   later in time than everything the index saw, so validate is a forward test, as test and final are after it.
 * - test, 2025-01-01 to 2026-01-01: sealed. Judged only, each run a look in the learning ledger, at most
 *   LOOK_BUDGETS.test looks.
 * - final, 2026-01-01 to 2027-01-01 (bars to about 2026-07-20): sealed for the final check, at most
 *   LOOK_BUDGETS.final look.
 *
 * Earlier and later dates have no learning role and are refused. A date string ('YYYY-MM-DD') is a session date; a
 * Date or a millisecond timestamp (a bar's time) is converted to its session first (18:00 ET rollover).
 *
 * The guard: practise and index only on practice-train (assertUse 'practice' and 'index'), validate only on
 * practice-validate; a test or final run takes a look in the ledger first (recordSealedLook), refused once its
 * budget is spent. The ledger is the prop ledger's file format (prop/looks.js, prop/ledger-file.js), its own file
 * (<FTH_HOME>/learning/looks.jsonl), so the two budgets never mix.
 *
 *   roleOf(date)                      'practice-train' | 'practice-validate' | 'test' | 'final' (throws outside)
 *   rolesBetween(from, to)            the roles [from, to) touches, in order
 *   assertUse(use, from, to)          throws unless every day of [from, to) is a role the use allows (USES)
 *   checkSealedLook(look, ledger)     { ok, refusals, role, spent, remaining, repeat }
 *   recordSealedLook(file, look, { create })   check and append under the ledger's lock; { ...check, appended }
 *   ledgerPath(env)                   <FTH_HOME>/learning/looks.jsonl
 */

const fs = require('fs');
const path = require('path');
const { tradingDayKey } = require('../trading/clock');
const { harnessHome } = require('../paths');
const { LOOK_BUDGET } = require('../prop/looks');
const { readLedger, appendLook, withLedgerLock } = require('../prop/ledger-file');

const WINDOWS = Object.freeze({
  'practice-train': Object.freeze(['2020-01-01', '2024-07-01']),
  'practice-validate': Object.freeze(['2024-07-01', '2025-01-01']),
  test: Object.freeze(['2025-01-01', '2026-01-01']),
  final: Object.freeze(['2026-01-01', '2027-01-01']),
});
const ROLES = Object.freeze(Object.keys(WINDOWS));
const SEALED = Object.freeze(['test', 'final']);
/** What each use may touch. Practice and the index: practice-train only. */
const USES = Object.freeze({
  practice: Object.freeze(['practice-train']),
  index: Object.freeze(['practice-train']),
  lessons: Object.freeze(['practice-train']),
  validate: Object.freeze(['practice-validate']),
  test: Object.freeze(['test']),
  final: Object.freeze(['final']),
});
/** Looks per sealed window: test as the prop out-of-sample budget; final one look. */
const LOOK_BUDGETS = Object.freeze({ test: LOOK_BUDGET, final: 1 });
const PURPOSES = Object.freeze(['judging', 'reasoning-fix']);
/** Looks taken before the ledger existed, kept so it starts true (prop/splits.js RECORDED_LOOKS). */
const RECORDED_LOOKS = Object.freeze([
  Object.freeze({ candidate: 'llm-replay-2026-06', purpose: 'reasoning-fix', from: '2026-06-01', to: '2026-06-06', what: 'LLM replay, June 1-5 2026, adherence only' }),
]);

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86400000;

/** A session date 'YYYY-MM-DD' from a session-date string, a Date or a timestamp. */
function sessionDate(date) {
  if (typeof date === 'string') {
    const m = ISO.exec(date);
    const ms = m ? Date.parse(`${date}T00:00:00Z`) : NaN;
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) throw new Error(`not an ISO date: "${date}"`);
    return date;
  }
  const t = date instanceof Date ? date.getTime() : date;
  if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error(`not a date: ${String(date)}`);
  return tradingDayKey(new Date(t));
}

/** The last session date of an exclusive end: the day before a date string; a timestamp's own session at to - 1 ms. */
function lastDay(to) {
  if (typeof to === 'string') return new Date(Date.parse(`${sessionDate(to)}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  const t = to instanceof Date ? to.getTime() : to;
  return sessionDate(t - 1);
}

function roleOf(date) {
  const d = sessionDate(date);
  const role = ROLES.find(r => d >= WINDOWS[r][0] && d < WINDOWS[r][1]);
  if (!role) throw new Error(`${d} has no learning role (${WINDOWS['practice-train'][0]} to ${WINDOWS.final[1]})`);
  return role;
}

/** The roles [from, to) touches, in order; throws on an empty range or one reaching outside the schedule. */
function rolesBetween(from, to) {
  const a = sessionDate(from);
  const b = lastDay(to);
  if (!(a <= b)) throw new Error(`empty range ${a}..${String(to)}`);
  const first = roleOf(a);
  const last = roleOf(b);
  return ROLES.slice(ROLES.indexOf(first), ROLES.indexOf(last) + 1);
}

/** Throws unless every day of [from, to) is in a role `use` allows. Returns the roles. */
function assertUse(use, from, to) {
  const allowed = USES[use];
  if (!allowed) throw new Error(`no learning use "${use}" (${Object.keys(USES).join(', ')})`);
  const roles = rolesBetween(from, to);
  const bad = roles.filter(r => !allowed.includes(r));
  if (bad.length) {
    const sealed = bad.filter(r => SEALED.includes(r));
    throw new Error(`${use} refused: ${sessionDate(from)}..${lastDay(to)} touches ${bad.join(', ')}${sealed.length ? ` (sealed: a ${sealed.join(' or ')} run is a look in the learning ledger, never practice or the index)` : ''}; ${use} uses ${allowed.join(', ')} only`);
  }
  return roles;
}

const lookKey = l => `${l.candidate}|${l.runId || ''}|${sessionDate(l.from)}|${sessionDate(l.to)}`;

/**
 * Whether a look at test or final may be taken: one range inside one sealed window, a candidate, a purpose. A
 * judging look spends one of the window's budget; a reasoning-fix look (no market claim, outcomes hidden) spends
 * none. The same look again (the same candidate, run id and range: a resumed run, a rewritten log) is a repeat and
 * spends nothing more.
 */
function checkSealedLook(look, ledger) {
  const refusals = [];
  if (!look || typeof look.candidate !== 'string' || !look.candidate.trim()) refusals.push('a look names its candidate');
  if (!look || !PURPOSES.includes(look.purpose)) refusals.push(`a look names its purpose, one of ${PURPOSES.join(', ')}; not ${String(look && look.purpose)}`);
  if (!Array.isArray(ledger)) return { ok: false, refusals: [...refusals, 'the ledger is required, a list of looks'], role: null };
  let roles;
  try {
    roles = rolesBetween(look.from, look.to);
  } catch (e) {
    return { ok: false, refusals: [...refusals, e.message], role: null };
  }
  if (roles.length !== 1 || !SEALED.includes(roles[0])) {
    return { ok: false, refusals: [...refusals, `a sealed look lies inside test or final alone, not ${roles.join(' + ')}`], role: roles.length === 1 ? roles[0] : null };
  }
  const role = roles[0];
  const all = [...RECORDED_LOOKS, ...ledger];
  const inRole = all.filter(e => { try { return rolesBetween(e.from, e.to).includes(role); } catch (_e) { return false; } });
  const spent = inRole.filter(e => e.purpose !== 'reasoning-fix').length;
  const repeat = refusals.length === 0 && inRole.some(e => lookKey(e) === lookKey(look) && e.purpose === look.purpose);
  const remaining = Math.max(0, LOOK_BUDGETS[role] - spent);
  if (!repeat && look.purpose === 'judging' && remaining === 0) refusals.push(`${role}: its ${LOOK_BUDGETS[role]} look(s) are spent; the window is sealed`);
  return { ok: refusals.length === 0, refusals, role, spent, remaining, repeat };
}

/** Check a sealed look and append it to the ledger file under its lock (a repeat is not appended again). Throws when refused. */
function recordSealedLook(file, look, { create = false, now = new Date() } = {}) {
  const run = () => {
    const ledger = readLedger(file, { create });
    const r = checkSealedLook(look, ledger);
    if (!r.ok) throw new Error(`sealed look refused: ${r.refusals.join('; ')}`);
    if (!r.repeat) appendLook(file, { ...look, from: sessionDate(look.from), to: sessionDate(look.to), role: r.role, at: now.toISOString() });
    return { ...r, appended: !r.repeat };
  };
  if (!fs.existsSync(path.dirname(file))) {
    if (!create) return run(); // readLedger refuses a missing ledger, with its own message
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  return withLedgerLock(file, run);
}

const ledgerPath = (env = process.env) => path.join(harnessHome(env), 'learning', 'looks.jsonl');

module.exports = { WINDOWS, ROLES, SEALED, USES, LOOK_BUDGETS, RECORDED_LOOKS, roleOf, rolesBetween, assertUse, checkSealedLook, recordSealedLook, ledgerPath, sessionDate };
