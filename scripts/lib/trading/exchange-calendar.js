'use strict';

/**
 * The CME equity index calendar the harness trades by when nothing else is
 * configured: closed days, and early closes (13:00 ET). Dates are trading
 * days, named by the New York date they end on (clock.tradingDayKey): a
 * closed date has no session from 18:00 ET the evening before.
 *
 * Every exchange holiday is closed, the safer reading: CME runs a short
 * session on some (MLK Day, Presidents Day, Memorial Day, Juneteenth,
 * Independence Day, Labor Day, Thanksgiving, sometimes Good Friday), with
 * thin books and no cash-market settlement, and the harness doesn't trade
 * them. The day after Thanksgiving and Christmas Eve, trading days that close
 * at 12:15 CT, are early closes (13:00 ET, a few minutes early). CME confirms
 * holiday hours about two weeks before each date; check its calendar and
 * extend this table (or set FTH_CLOSED_DATES / FTH_EARLY_CLOSE_DATES, or the
 * runner config's closedDates / earlyCloseDates, which add to it) before
 * COVERED_UNTIL.
 */

const CLOSED = [
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King Jr. Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
  '2027-01-01', // New Year's Day
  '2027-01-18', // Martin Luther King Jr. Day
  '2027-02-15', // Presidents Day
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (observed)
  '2027-07-05', // Independence Day (observed)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas (observed)
];

const EARLY_CLOSE = [
  '2026-11-27', // day after Thanksgiving
  '2026-12-24', // Christmas Eve
  '2027-11-26', // day after Thanksgiving
];

/** The last trading day the table covers. */
const COVERED_UNTIL = '2027-12-31';
const WARN_DAYS = 30;

const { tradingDayKey } = require('./clock');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const listOf = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim()).filter(Boolean);

/** The built-in calendar plus configured dates: { closedDates: Set, earlyCloseDates: Set }. */
function exchangeCalendar({ closed = [], early = [] } = {}) {
  return {
    closedDates: new Set([...CLOSED, ...listOf(closed)]),
    earlyCloseDates: new Set([...EARLY_CLOSE, ...listOf(early)]),
  };
}

/** A year has at least this many exchange holidays (closed days); fewer configured means the year isn't covered. */
const MIN_CLOSED_PER_YEAR = 9;

/**
 * The last trading day the calendar covers: COVERED_UNTIL, extended a year at
 * a time by configured years that list a whole year's closed days (at least
 * MIN_CLOSED_PER_YEAR), never by a stray date. The order gate refuses entries
 * on any later trading day: without its holidays it would trade into a closed
 * exchange and hold positions through an early close.
 */
function calendarEnd({ closed = [] } = {}) {
  const configured = listOf(closed).filter(d => DATE.test(d));
  let end = COVERED_UNTIL;
  for (let y = Number(COVERED_UNTIL.slice(0, 4)) + 1; configured.filter(d => d.startsWith(`${y}-`)).length >= MIN_CLOSED_PER_YEAR; y += 1) end = `${y}-12-31`;
  return end;
}

/**
 * A warning when the calendar ends within WARN_DAYS of `now` (by trading
 * day), else null. The runner logs it once a day.
 */
function coverageError(now, dates = {}) {
  const latest = calendarEnd(dates);
  if (tradingDayKey(new Date(now.getTime() + WARN_DAYS * 86400000)) <= latest) return null;
  return `the exchange calendar ends ${latest}, and the order gate refuses entries after it: add the next year's CME holidays (all of them: a year counts once it lists at least ${MIN_CLOSED_PER_YEAR}) and early closes `
    + '(closedDates / earlyCloseDates, or FTH_CLOSED_DATES / FTH_EARLY_CLOSE_DATES), or extend scripts/lib/trading/exchange-calendar.js';
}

module.exports = { CLOSED, EARLY_CLOSE, COVERED_UNTIL, MIN_CLOSED_PER_YEAR, exchangeCalendar, calendarEnd, coverageError };
