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
 * orthogonal: a flag on a month, never a mechanical role of its own.
 *
 * Dates here are trading-session dates (the day a session counts for), not
 * bar timestamps; every block starts on the first of a month.
 */

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
const ROLES = Object.freeze(['train', 'select', 'oos', 'recent', 'walk-forward', 'reserve']);
const PARTS = Object.freeze(['tuning', 'held-out']);

/** Looks already taken at reserved months, kept so the ledger starts true. */
const RECORDED_LOOKS = Object.freeze([
  Object.freeze({
    block: 'recent', from: '2026-06-01', to: '2026-06-06',
    what: 'LLM replay, June 1-5 2026', use: 'adherence only, no candidate claims (R22)',
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
  } else if (date instanceof Date) ms = date.getTime();
  else if (typeof date === 'number') ms = date;
  if (!Number.isFinite(ms)) throw new Error(`not a date: ${String(date)}`);
  const d = new Date(ms);
  return { month: d.getUTCFullYear() * 12 + d.getUTCMonth(), ms };
}

const monthOf = iso => parse(iso).month;
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
  const b = parse(to);
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
  const b = parse(to);
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

module.exports = {
  SPLITS, windowMs, overlaps,
  RECENT, SCHEDULE_START, NEW_MONTHS_FROM, LLM_FROM, RESERVE_MIN_MONTHS, ROLES, PARTS, RECORDED_LOOKS,
  roleOf, isLlmMonth, blockByName, blocksBetween, unitContaining, oosQueue,
};
