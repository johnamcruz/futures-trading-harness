'use strict';

/**
 * The data split windows, one canonical copy for everything that scores a
 * prop configuration on history: train (calibration and search), select
 * (choosing among candidates) and oos (the promotion gate,
 * prop/promotion.js). Each is [from, to): ISO dates, `to` exclusive. A
 * window changes only when the out-of-sample one is retired; out of sample
 * never overlaps train or select and never moves backward
 * (tests/lib/prop-splits.test.js).
 *
 * The schedule (docs/LEARNED-RULEBOOK.md section 4, R16, R17, R32): every
 * month from SCHEDULE_START on has exactly one mechanical role, set in
 * advance, so nothing chooses a month's use after seeing it:
 *
 * - train, select, oos: SPLITS below, unchanged.
 * - recent (2025-07 to 2026-06): reserved, the next out-of-sample window once
 *   the current one is retired through the ledger. Its one recorded look is
 *   the June 1-5, 2026 LLM replay, adherence only (RECORDED_LOOKS).
 * - from 2026-07 on, by half-year, by rule: every H2 is walk-forward and
 *   every H1 is reserve, so they alternate starting with 2026-H2 =
 *   walk-forward, 2027-H1 = reserve, 2027-H2 = walk-forward, ...
 * - each walk-forward half-year is two contiguous quarters, tuning first and
 *   held-out second: the held-out quarter is later in time than everything
 *   the proposer and Optuna were shown, so a held-out look is a forward test,
 *   and tuning data arrives first so the loop can start while the held-out
 *   months are still coming in.
 * - reserve half-years accumulate (oosQueue) until they hold at least
 *   RESERVE_MIN_MONTHS before they form an out-of-sample window. That is a
 *   computation, not a promotion: retiring a window goes through the ledger.
 *
 * The LLM role (months from LLM_FROM, after the model's training cutoff) is
 * orthogonal: a flag on a month, never a mechanical role of its own. So is
 * flow coverage (FLOW_COVERAGE, 2021-05 to 2025-11): it limits which months
 * carry flow, never a month's role. An attempt of a policy with a flow branch
 * is covered when its start day plus `sessions` sessions is covered
 * (attemptFlowCovered), decided at the start. Which looks at these months
 * are allowed and which count against a budget: prop/looks.js.
 *
 * A date string ('YYYY-MM[-DD]') is a trading-session date (the day a
 * session counts for); a Date or a millisecond timestamp (a bar's time) is
 * converted to its session first (18:00 ET rollover, clock.tradingDayKey),
 * so an evening bar belongs to the next session's block. Every block starts
 * on the first of a month.
 */

const { tradingDayKey } = require('../trading/clock');
const { CLOSED, cmeHolidays } = require('../trading/exchange-calendar');

const SPLITS = Object.freeze({
  train: Object.freeze(['2021-01-01', '2023-07-01']),
  select: Object.freeze(['2023-07-01', '2024-07-01']),
  oos: Object.freeze(['2024-07-01', '2025-07-01']),
});

/** Recent: reserved for the next out-of-sample window. [from, to). */
const RECENT = Object.freeze(['2025-07-01', '2026-07-01']);
/** The schedule's first month; earlier dates have no role. */
const SCHEDULE_START = SPLITS.train[0];
/** New months (half-year blocks) start here; 2026-H2 is walk-forward. */
const NEW_MONTHS_FROM = RECENT[1];
/** Months after the model's training cutoff: the LLM may be measured on them. */
const LLM_FROM = '2026-06-01';
/** A reserve becomes an out-of-sample window once it holds this many months. */
const RESERVE_MIN_MONTHS = 12;
/**
 * The replay server's flow coverage (section 4): [from, to), session dates, `to` exclusive, so 2021-05 through
 * 2025-11. Coverage limits which months carry flow, never which role a month has.
 */
const FLOW_COVERAGE = Object.freeze(['2021-05-01', '2025-12-01']);
const ROLES = Object.freeze(['train', 'select', 'oos', 'recent', 'walk-forward', 'reserve']);
const PARTS = Object.freeze(['tuning', 'held-out']);

/** Looks already taken at held-out or reserved months, kept so the ledger starts true. */
const RECORDED_LOOKS = Object.freeze([
  Object.freeze({
    block: 'recent', from: '2026-06-01', to: '2026-06-06',
    what: 'LLM replay, June 1-5 2026', use: 'adherence only, no candidate claims (R22)',
  }),
  // The flow parity check: Mar 4-22, Apr 8-19, May 20-24 and Jun 6-21, 2024 (select), Aug 1-9, 2024 (oos).
  Object.freeze({
    block: 'select', from: '2024-03-04', to: '2024-06-22',
    what: 'flow parity check', use: 'decided recalibration only, no threshold value',
  }),
  Object.freeze({
    block: 'oos', from: '2024-08-01', to: '2024-08-10',
    what: 'flow parity check', use: 'decided recalibration only, no threshold value',
  }),
]);

/** A window as ms: { from, to } (to exclusive). */
function windowMs(name) {
  const w = SPLITS[name];
  if (!w) throw new Error(`no split window "${name}" (${Object.keys(SPLITS).join(', ')})`);
  return { from: Date.parse(`${w[0]}T00:00:00Z`), to: Date.parse(`${w[1]}T00:00:00Z`) };
}

/** Whether two [from, to) windows share any time. */
const overlaps = (a, b) => a.from < b.to && b.from < a.to;

const ISO = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;

/** Month index (year * 12 + month0) and day of a date: ISO 'YYYY-MM[-DD]', ms, or Date (UTC). */
function parse(date) {
  let ms;
  if (typeof date === 'string') {
    const m = ISO.exec(date);
    if (!m) throw new Error(`not an ISO date: "${date}"`);
    ms = Date.parse(`${m[1]}-${m[2]}-${m[3] || '01'}T00:00:00Z`);
    if (Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3] || '01'}`) ms = NaN;
  } else if (date instanceof Date || typeof date === 'number') {
    // A timestamp (a bar's time) belongs to its trading session, which opens at 18:00 ET the evening before:
    // read as a UTC calendar date, an evening bar would land in the previous block or quarter (a held-out bar
    // labelled tuning). Converted to the session's date first.
    const t = date instanceof Date ? date.getTime() : date;
    if (Number.isFinite(t)) {
      const key = tradingDayKey(new Date(t));
      ms = Date.parse(`${key}T00:00:00Z`);
    }
  }
  if (!Number.isFinite(ms)) throw new Error(`not a date: ${String(date)}`);
  const d = new Date(ms);
  return { month: d.getUTCFullYear() * 12 + d.getUTCMonth(), ms };
}

const monthOf = iso => parse(iso).month;

/**
 * An exclusive range end, as the midnight after the last session in the range. A session-date string is that
 * midnight already. A timestamp is read through its last included instant (to - 1 ms): its session ends the range,
 * so a range ending inside a session holds that session (never cut back to its midnight, which would let a range
 * reaching into the next unit pass as inside this one).
 */
function parseEnd(to) {
  if (!(to instanceof Date) && typeof to !== 'number') return parse(to);
  const t = to instanceof Date ? to.getTime() : to;
  if (!Number.isFinite(t)) throw new Error(`not a date: ${String(to)}`);
  const ms = parse(t - 1).ms + 86400000;
  const d = new Date(ms);
  return { month: d.getUTCFullYear() * 12 + d.getUTCMonth(), ms };
}
const isoOfMonth = m => `${String(Math.floor(m / 12)).padStart(4, '0')}-${String((m % 12) + 1).padStart(2, '0')}-01`;

const START = monthOf(SCHEDULE_START);
const NEW_START = monthOf(NEW_MONTHS_FROM);
const LLM_START = monthOf(LLM_FROM);

function makeBlock(role, name, fromM, toM, parts) {
  const block = { role, block: name, from: isoOfMonth(fromM), to: isoOfMonth(toM), months: toM - fromM };
  if (parts) block.parts = Object.freeze(parts.map(p => Object.freeze(p)));
  return Object.freeze(block);
}

const FIXED_BLOCKS = Object.freeze([
  makeBlock('train', 'train', monthOf(SPLITS.train[0]), monthOf(SPLITS.train[1])),
  makeBlock('select', 'select', monthOf(SPLITS.select[0]), monthOf(SPLITS.select[1])),
  makeBlock('oos', 'oos', monthOf(SPLITS.oos[0]), monthOf(SPLITS.oos[1])),
  makeBlock('recent', 'recent', monthOf(RECENT[0]), monthOf(RECENT[1])),
]);

/** The half-year block (from NEW_MONTHS_FROM on) holding month index m. */
function halfYearBlock(m) {
  const year = Math.floor(m / 12);
  const h2 = m % 12 >= 6;
  const fromM = year * 12 + (h2 ? 6 : 0);
  const name = `${year}-H${h2 ? 2 : 1}`;
  // The rule: alternate by half-year from 2026-H2 (index 0) = walk-forward.
  const index = (fromM - NEW_START) / 6;
  if (index % 2 === 0) {
    return makeBlock('walk-forward', name, fromM, fromM + 6, [
      { part: 'tuning', from: isoOfMonth(fromM), to: isoOfMonth(fromM + 3), months: 3 },
      { part: 'held-out', from: isoOfMonth(fromM + 3), to: isoOfMonth(fromM + 6), months: 3 },
    ]);
  }
  return makeBlock('reserve', name, fromM, fromM + 6);
}

function blockAtMonth(m) {
  if (m < START) throw new Error(`${isoOfMonth(m)} is before the schedule (${SCHEDULE_START})`);
  if (m >= NEW_START) return halfYearBlock(m);
  return FIXED_BLOCKS.find(b => m >= monthOf(b.from) && m < monthOf(b.to));
}

/**
 * A date's place in the schedule: { role, block, part, llm, from, to }.
 * part is 'tuning' or 'held-out' in a walk-forward block, else null; from
 * and to bound the part (walk-forward) or the block. llm is true from
 * LLM_FROM on and does not change the mechanical role.
 */
function roleOf(date) {
  const m = parse(date).month;
  const b = blockAtMonth(m);
  const part = b.parts ? b.parts.find(p => m < monthOf(p.to)) : null;
  return Object.freeze({
    role: b.role, block: b.block, part: part ? part.part : null, llm: m >= LLM_START,
    from: part ? part.from : b.from, to: part ? part.to : b.to,
  });
}

/** Whether a date falls in the LLM's months (after the model's cutoff). */
const isLlmMonth = date => parse(date).month >= LLM_START;

/** A block by name ('train', 'recent', '2027-H1', ...). */
function blockByName(name) {
  const fixed = FIXED_BLOCKS.find(b => b.block === name);
  if (fixed) return fixed;
  const m = /^(\d{4})-H([12])$/.exec(String(name));
  const fromM = m ? Number(m[1]) * 12 + (m[2] === '2' ? 6 : 0) : NaN;
  if (!(fromM >= NEW_START)) throw new Error(`no schedule block "${name}"`);
  return halfYearBlock(fromM);
}

/** The blocks overlapping [from, to), in time order, each whole (not clipped). */
function blocksBetween(from, to) {
  const a = parse(from);
  const b = parseEnd(to);
  if (!(a.ms < b.ms)) return [];
  const out = [];
  // The last month touched by [from, to): to's month only if to is past its first instant.
  const last = b.ms > Date.parse(`${isoOfMonth(b.month)}T00:00:00Z`) ? b.month : b.month - 1;
  for (let m = a.month; m <= last;) {
    const blk = blockAtMonth(m);
    out.push(blk);
    m = monthOf(blk.to);
  }
  return out;
}

/**
 * The one unit holding all of [from, to): the part of a walk-forward block,
 * or a whole block otherwise, as roleOf returns it; null when the range
 * crosses a unit boundary. Every attempt must lie inside one unit.
 */
function unitContaining(from, to) {
  const a = parse(from);
  const b = parseEnd(to);
  if (!(a.ms < b.ms)) return null;
  const unit = roleOf(a.ms);
  return b.ms <= Date.parse(`${unit.to}T00:00:00Z`) ? unit : null;
}

/**
 * The out-of-sample windows the reserve forms, in order, that are complete
 * by asOf (every block ended): Recent first, then reserve half-years grouped
 * in time order until each group holds at least RESERVE_MIN_MONTHS. This only
 * says which windows exist; using one requires retiring the current window
 * through the ledger (R16).
 */
function oosQueue(asOf) {
  const until = parse(asOf).ms;
  const ended = blk => Date.parse(`${blk.to}T00:00:00Z`) <= until;
  const recent = FIXED_BLOCKS.find(b => b.role === 'recent');
  const out = [];
  if (!ended(recent)) return out;
  out.push(Object.freeze({ blocks: Object.freeze([recent.block]), months: recent.months, readyAt: recent.to }));
  let group = [];
  let months = 0;
  for (let m = NEW_START; ; m += 6) {
    const blk = halfYearBlock(m);
    if (!ended(blk)) break;
    if (blk.role !== 'reserve') continue;
    group.push(blk.block);
    months += blk.months;
    if (months >= RESERVE_MIN_MONTHS) {
      out.push(Object.freeze({ blocks: Object.freeze(group), months, readyAt: blk.to }));
      group = [];
      months = 0;
    }
  }
  return out;
}

const DAY = 86400000;
const isoOfMs = t => new Date(t).toISOString().slice(0, 10);
const closedByYear = new Map();
/**
 * The closed days of a year, from the harness's one exchange calendar (trading/exchange-calendar.js): its table
 * and its CME rules (cmeHolidays), both.
 */
function closedIn(year) {
  if (!closedByYear.has(year)) {
    closedByYear.set(year, new Set([...CLOSED.filter(d => d.startsWith(`${year}-`)), ...cmeHolidays(year).closed]));
  }
  return closedByYear.get(year);
}

/** Whether a session date (ms, UTC midnight) has a session: a weekday the exchange isn't closed. */
function sessionAt(t) {
  const d = new Date(t);
  return ![0, 6].includes(d.getUTCDay()) && !closedIn(d.getUTCFullYear()).has(isoOfMs(t));
}

/** Whether a date has a session; a timestamp (a bar's time) is read as its session first. */
const hasSession = date => sessionAt(parse(date).ms);

/**
 * An attempt's sessions from its start: { first, last, bound }, session dates. first is the first session on or
 * after start (a timestamp is read as its session first); last is the `sessions`-th session counting first as
 * one; bound is the session `sessions` sessions after first, the start day plus the maximum attempt length.
 * Closed days are every exchange holiday (the harness doesn't trade them), so a span never counts one.
 */
function attemptSessions(start, sessions) {
  if (!Number.isInteger(sessions) || sessions < 1) throw new Error(`sessions: a positive whole number, not ${String(sessions)}`);
  let t = parse(start).ms;
  while (!sessionAt(t)) t += DAY;
  const first = t;
  let last = first;
  for (let n = 1; n <= sessions; n++) {
    t += DAY;
    while (!sessionAt(t)) t += DAY;
    if (n < sessions) last = t;
  }
  return Object.freeze({ first: isoOfMs(first), last: isoOfMs(last), bound: isoOfMs(t) });
}

const FLOW_FROM = parse(FLOW_COVERAGE[0]).ms;
const FLOW_TO = parse(FLOW_COVERAGE[1]).ms;

/** Whether a date's session carries flow (FLOW_COVERAGE). A timestamp is read as its session first. */
function isFlowCovered(date) {
  const t = parse(date).ms;
  return t >= FLOW_FROM && t < FLOW_TO;
}

/**
 * Whether an attempt of a policy with a flow branch is covered (section 4): decided at the start, never by the
 * outcome. Covered only if its first session and its start day plus the maximum attempt length (`sessions`
 * sessions, the account's) are both covered, whatever the attempt does; otherwise it runs flow off.
 */
function attemptFlowCovered(start, sessions) {
  const a = attemptSessions(start, sessions);
  return isFlowCovered(a.first) && isFlowCovered(a.bound);
}

module.exports = {
  SPLITS, windowMs, overlaps,
  RECENT, SCHEDULE_START, NEW_MONTHS_FROM, LLM_FROM, RESERVE_MIN_MONTHS, ROLES, PARTS, RECORDED_LOOKS, FLOW_COVERAGE,
  roleOf, isLlmMonth, blockByName, blocksBetween, unitContaining, oosQueue,
  hasSession, attemptSessions, isFlowCovered, attemptFlowCovered,
};
