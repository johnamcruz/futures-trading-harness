'use strict';

/**
 * The CME equity index calendar the harness trades by when nothing else is
 * configured: holidays with no session, and early closes (halts at 12:00 CT /
 * 13:00 ET; the day after Thanksgiving and Christmas Eve close at 12:15 CT,
 * so 13:00 ET is a few minutes early, on the safe side). Dates are trading
 * days, named by the New York date they end on (clock.tradingDayKey): a
 * closed date has no session from 18:00 ET the evening before.
 *
 * Where sources disagree, the safer reading is taken: Good Friday is closed
 * (CME has run a short morning session on some). CME confirms holiday hours
 * about two weeks before each date; check its calendar and extend this table
 * (or set FTH_CLOSED_DATES / FTH_EARLY_CLOSE_DATES, or the runner config's
 * closedDates / earlyCloseDates, which add to it) before COVERED_UNTIL.
 */

const CLOSED = [
  '2026-01-01', // New Year's Day
  '2026-04-03', // Good Friday
  '2026-12-25', // Christmas
  '2027-01-01', // New Year's Day
  '2027-03-26', // Good Friday
  '2027-12-24', // Christmas (observed)
];

const EARLY_CLOSE = [
  '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
  '2026-11-26', '2026-11-27', '2026-12-24',
  '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06',
  '2027-11-25', '2027-11-26',
];

/** The last trading day the table covers. */
const COVERED_UNTIL = '2027-12-31';
const WARN_DAYS = 30;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const listOf = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim()).filter(Boolean);

/** The built-in calendar plus configured dates: { closedDates: Set, earlyCloseDates: Set }. */
function exchangeCalendar({ closed = [], early = [] } = {}) {
  return {
    closedDates: new Set([...CLOSED, ...listOf(closed)]),
    earlyCloseDates: new Set([...EARLY_CLOSE, ...listOf(early)]),
  };
}

/**
 * An error when the calendar runs out within WARN_DAYS of `now` (by the New
 * York date) and no configured date reaches past it; else null. The runner
 * refuses to start on it: without holidays it would trade into a closed
 * exchange and hold positions through an early close.
 */
function coverageError(now, { closed = [], early = [] } = {}) {
  const latest = [COVERED_UNTIL, ...listOf(closed), ...listOf(early)].filter(d => DATE.test(d)).sort().pop();
  const horizon = new Date(now.getTime() + WARN_DAYS * 86400000).toISOString().slice(0, 10);
  if (horizon <= latest) return null;
  return `the exchange calendar ends ${latest}: add the CME holidays and early closes after it (closedDates / earlyCloseDates, `
    + 'or FTH_CLOSED_DATES / FTH_EARLY_CLOSE_DATES), or extend scripts/lib/trading/exchange-calendar.js';
}

module.exports = { CLOSED, EARLY_CLOSE, COVERED_UNTIL, exchangeCalendar, coverageError };
