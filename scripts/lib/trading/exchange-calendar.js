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

const listOf = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim()).filter(Boolean);

/** The built-in calendar plus configured dates: { closedDates: Set, earlyCloseDates: Set }. */
function exchangeCalendar({ closed = [], early = [] } = {}) {
  return {
    closedDates: new Set([...CLOSED, ...listOf(closed)]),
    earlyCloseDates: new Set([...EARLY_CLOSE, ...listOf(early)]),
  };
}

/**
 * A year's exchange holidays and early closes by the rules the table follows:
 * { closed, early }, trading days as YYYY-MM-DD. Closed: New Year's Day, MLK
 * Day (3rd Monday of January), Presidents Day (3rd Monday of February), Good
 * Friday, Memorial Day (last Monday of May), Juneteenth (from 2022, its first year as an exchange holiday), Independence Day,
 * Labor Day (1st Monday of September), Thanksgiving (4th Thursday of
 * November), Christmas; a holiday on a Saturday is kept the Friday before,
 * on a Sunday the Monday after (New Year's Day on a Saturday isn't kept).
 * Early closes: July 3 when Independence Day falls Tuesday to Friday, the day
 * after Thanksgiving, and Christmas Eve on a Monday to Thursday. CME's own
 * calendar decides; this checks that a configured year lists them all.
 */
function cmeHolidays(year) {
  const d = (m, day) => new Date(Date.UTC(year, m - 1, day));
  const iso = x => x.toISOString().slice(0, 10);
  const nth = (m, weekday, n) => { const x = d(m, 1); x.setUTCDate(1 + ((weekday - x.getUTCDay() + 7) % 7) + 7 * (n - 1)); return x; };
  const last = (m, weekday) => { const x = d(m + 1, 0); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() - weekday + 7) % 7)); return x; };
  const kept = x => { const w = x.getUTCDay(); if (w === 6) x.setUTCDate(x.getUTCDate() - 1); if (w === 0) x.setUTCDate(x.getUTCDate() + 1); return x; };
  // Easter (anonymous Gregorian algorithm); Good Friday is two days before.
  const a = year % 19; const b = Math.floor(year / 100); const c = year % 100;
  const h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const goodFriday = d(month, ((h + l - 7 * m + 114) % 31) + 1);
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  const thanksgiving = nth(11, 4, 4);
  const closed = [
    ...(d(1, 1).getUTCDay() === 6 ? [] : [kept(d(1, 1))]), nth(1, 1, 3), nth(2, 1, 3), goodFriday, last(5, 1),
    ...(year >= 2022 ? [kept(d(6, 19))] : []), kept(d(7, 4)), nth(9, 1, 1), thanksgiving, kept(d(12, 25)),
  ].map(iso);
  const dayAfter = new Date(thanksgiving.getTime() + 86400000);
  const july4 = d(7, 4).getUTCDay();
  const eve = d(12, 24).getUTCDay();
  const early = [...(july4 >= 2 && july4 <= 5 ? [d(7, 3)] : []), dayAfter, ...(eve >= 1 && eve <= 4 ? [d(12, 24)] : [])].map(iso);
  return { closed: closed.sort(), early: early.sort() };
}

/**
 * The last trading day the calendar covers: COVERED_UNTIL, extended a year at
 * a time by configured years that list every one of that year's holidays and
 * early closes (cmeHolidays), never by a stray date. The order gate refuses
 * entries on any later trading day: without its holidays it would trade into
 * a closed exchange and hold positions through an early close.
 */
function calendarEnd({ closed = [], early = [] } = {}) {
  const shut = new Set(listOf(closed));
  const short = new Set([...listOf(early), ...shut]);
  let end = COVERED_UNTIL;
  for (let y = Number(COVERED_UNTIL.slice(0, 4)) + 1; ; y += 1) {
    const r = cmeHolidays(y);
    if (!(r.closed.every(x => shut.has(x)) && r.early.every(x => short.has(x)))) return end;
    end = `${y}-12-31`;
  }
}

/**
 * A warning when the calendar ends within WARN_DAYS of `now` (by trading
 * day), else null. The runner logs it once a day.
 */
function coverageError(now, dates = {}) {
  const latest = calendarEnd(dates);
  if (tradingDayKey(new Date(now.getTime() + WARN_DAYS * 86400000)) <= latest) return null;
  return `the exchange calendar ends ${latest}, and the order gate refuses entries after it: add the next year's CME holidays and early closes (all of them: a year counts once it lists every one, exchange-calendar.js cmeHolidays) `
    + '(closedDates / earlyCloseDates, or FTH_CLOSED_DATES / FTH_EARLY_CLOSE_DATES), or extend scripts/lib/trading/exchange-calendar.js';
}

module.exports = { CLOSED, EARLY_CLOSE, COVERED_UNTIL, cmeHolidays, exchangeCalendar, calendarEnd, coverageError };
