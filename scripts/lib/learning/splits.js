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
 * - test, 2025-01-01 to 2026-01-01: sealed, judged under the learning ledger's budget (learning/looks.js).
 * - final, 2026-01-01 to 2027-01-01 (bars to about 2026-07-20): sealed for the final check (learning/looks.js).
 *
 * Earlier and later dates have no learning role and are refused. A date string ('YYYY-MM-DD') is a session date; a
 * Date or a millisecond timestamp (a bar's time) is converted to its session first (18:00 ET rollover).
 *
 * The guard: practise and index only on practice-train (assertUse 'practice' and 'index'), validate only on
 * practice-validate; a run starts through learning/run-gate.js, which takes the run's look before its first cycle.
 *
 *   roleOf(date)                      'practice-train' | 'practice-validate' | 'test' | 'final' (throws outside)
 *   rolesBetween(from, to)            the roles [from, to) touches, in order
 *   assertUse(use, from, to)          throws unless every day of [from, to) is a role the use allows (USES)
 *   sessionDate(date)                 the session date 'YYYY-MM-DD'
 */

const { tradingDayKey } = require('../trading/clock');

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

module.exports = { WINDOWS, ROLES, SEALED, USES, roleOf, rolesBetween, assertUse, sessionDate };
