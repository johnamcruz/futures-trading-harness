'use strict';

/**
 * The learning loop's data split (the composed-entry design, section 4.7, with the owner's split): which months the model
 * practises on, which check that it learned, and which stay sealed. Its windows are config, config/schedule.json
 * `learning` (scripts/lib/schedule.js loads and validates it, and refuses a change to the sealed ones after a look);
 * the prop promotion schedule (prop/splits.js) is the same file's `prop`, with other windows, and never moves a
 * learning window. Each window is [from, to), session dates, `to` exclusive.
 *
 * - practice-train: practice replays (exploration included), the experience log's teaching records, the experience
 *   index, lessons. Long enough that the index sees every regime the briefing names.
 * - practice-validate: the last months before test, held back from the index. A validation replay reads the index
 *   built from practice-train and is never indexed itself. The carve-out is the tail, not a month per quarter: a
 *   held-back month between two practised months shares their regime and their news (leakage by adjacency), and the
 *   index would be judged on the weeks next to what built it; the tail is later in time than everything the index
 *   saw, so validate is a forward test, as test and final are after it.
 * - test: sealed, judged under the learning ledger's budget (learning/looks.js).
 * - final: sealed for the final check (learning/looks.js).
 *
 * Earlier and later dates have no learning role and are refused. A date string ('YYYY-MM-DD') is a session date; a
 * Date or a millisecond timestamp (a bar's time) is converted to its session first (18:00 ET rollover).
 *
 * The guard: practise and index only on practice-train (assertUse 'practice' and 'index'), validate only on
 * practice-validate; a run starts through learning/run-gate.js, which takes the run's look before its first cycle.
 *
 *   WINDOWS                           { role: [from, to) } from the schedule (read when used)
 *   roleOf(date)                      'practice-train' | 'practice-validate' | 'test' | 'final' (throws outside)
 *   rolesBetween(from, to)            the roles [from, to) touches, in order
 *   assertUse(use, from, to)          throws unless every day of [from, to) is a role the use allows (USES)
 *   touchesHeldBack(from, to)         whether any day of [from, to) is practice-validate, test or final
 *   sessionDate(date)                 the session date 'YYYY-MM-DD'
 */

const { tradingDayKey } = require('../trading/clock');
const schedule = require('../schedule');

/** The windows, from the schedule (a refused schedule throws: no role without it). */
const windows = () => schedule.current().learning.windows;
const ROLES = Object.freeze(['practice-train', 'practice-validate', 'test', 'final']);
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
  const W = windows();
  const role = ROLES.find(r => d >= W[r][0] && d < W[r][1]);
  if (!role) throw new Error(`${d} has no learning role (${W['practice-train'][0]} to ${W.final[1]}, config/schedule.json)`);
  return role;
}

/** The roles [from, to) touches, in order; throws on an empty range or one reaching outside the schedule (or a gap in it). */
function rolesBetween(from, to) {
  const a = sessionDate(from);
  const b = lastDay(to);
  if (!(a <= b)) throw new Error(`empty range ${a}..${String(to)}`);
  const first = roleOf(a);
  const last = roleOf(b);
  const roles = ROLES.slice(ROLES.indexOf(first), ROLES.indexOf(last) + 1);
  // A gap between two windows (the schedule allows one) has no role: a range across it is refused.
  const W = windows();
  for (let i = 1; i < roles.length; i++) {
    if (W[roles[i - 1]][1] !== W[roles[i]][0]) throw new Error(`${a}..${b} crosses days with no learning role (${W[roles[i - 1]][1]} to ${W[roles[i]][0]}, config/schedule.json)`);
  }
  return roles;
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

/** Whether any day of [from, to) is a practice-validate, test or final day: held back from practice. */
function touchesHeldBack(from, to) {
  const a = sessionDate(from);
  const b = lastDay(to);
  const W = windows();
  return a < W.final[1] && b >= W['practice-validate'][0];
}

module.exports = {
  get WINDOWS() { return windows(); },
  ROLES, SEALED, USES, roleOf, rolesBetween, assertUse, touchesHeldBack, sessionDate,
};
