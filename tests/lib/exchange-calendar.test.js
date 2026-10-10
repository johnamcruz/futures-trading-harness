'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CLOSED, EARLY_CLOSE, COVERED_UNTIL, cmeHolidays, exchangeCalendar, calendarEnd, coverageError } = require('../../scripts/lib/trading/exchange-calendar');
const { tradingDayKey } = require('../../scripts/lib/trading/clock');

test('calendar: the built-in CME dates, plus configured ones (a list or a comma string); configuration only adds', () => {
  const base = exchangeCalendar();
  assert.ok(base.closedDates.has('2026-04-03') && base.closedDates.has('2026-12-25') && base.earlyCloseDates.has('2026-11-27'));
  // Every exchange holiday is closed, even where CME runs a short session; only the half days are early closes.
  for (const d of ['2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2027-06-18', '2027-07-05', '2027-11-25']) {
    assert.ok(base.closedDates.has(d) && !base.earlyCloseDates.has(d), `${d} is closed`);
  }
  assert.deepStrictEqual(EARLY_CLOSE, ['2026-11-27', '2026-12-24', '2027-11-26']);
  const more = exchangeCalendar({ closed: '2028-04-14, 2028-12-25', early: ['2028-01-17'] });
  assert.ok(more.closedDates.has('2028-04-14') && more.closedDates.has('2028-12-25') && more.closedDates.has('2026-12-25'));
  assert.ok(more.earlyCloseDates.has('2028-01-17') && more.earlyCloseDates.has('2026-11-27'));
});

test('calendar: every date is a weekday trading day, none is both closed and early, all within the coverage', () => {
  for (const d of [...CLOSED, ...EARLY_CLOSE]) {
    assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
    const weekday = new Date(`${d}T12:00:00Z`).getUTCDay();
    assert.ok(weekday >= 1 && weekday <= 5, `${d} is a weekend`);
    assert.strictEqual(tradingDayKey(new Date(`${d}T15:00:00Z`)), d, `${d} names its own trading day`);
    assert.ok(d <= COVERED_UNTIL);
  }
  assert.deepStrictEqual(CLOSED.filter(d => EARLY_CLOSE.includes(d)), []);
});

test('coverage: an error within 30 days of the table\'s end, unless configured dates reach past it', () => {
  assert.strictEqual(coverageError(new Date('2026-10-10T12:00:00Z')), null);
  assert.match(coverageError(new Date('2027-12-15T12:00:00Z')), /calendar ends 2027-12-31/);
  // Only a whole year (every holiday and early close) extends it, never a stray date.
  const y2028 = cmeHolidays(2028);
  assert.strictEqual(coverageError(new Date('2027-12-15T12:00:00Z'), y2028), null);
  assert.match(coverageError(new Date('2027-12-15T12:00:00Z'), { closed: y2028.closed }), /calendar ends 2027-12-31/, 'its early closes missing');
  assert.match(coverageError(new Date('2027-12-15T12:00:00Z'), { closed: ['2028-04-14'] }), /calendar ends 2027-12-31/);
  assert.match(coverageError(new Date('2027-12-15T12:00:00Z'), { early: '2028-01-17' }), /calendar ends 2027-12-31/);
  assert.match(coverageError(new Date('2027-12-15T12:00:00Z'), { closed: ['not-a-date'] }), /calendar ends 2027-12-31/);
  // By trading day: 30 days after 20:00 ET on 2027-12-01 is the trading day 2028-01-01, after 15:00 ET still 2027-12-31.
  assert.match(coverageError(new Date('2027-12-02T01:00:00Z')), /calendar ends 2027-12-31/);
  assert.strictEqual(coverageError(new Date('2027-12-01T20:00:00Z')), null);
  assert.strictEqual(calendarEnd(), COVERED_UNTIL);
  assert.strictEqual(calendarEnd({ early: '2028-11-24' }), COVERED_UNTIL);
  assert.strictEqual(calendarEnd({ closed: y2028.closed.join(','), early: y2028.early.join(',') }), '2028-12-31');
  const y2029 = cmeHolidays(2029);
  assert.strictEqual(calendarEnd({ closed: y2028.closed.slice(1), early: y2028.early }), COVERED_UNTIL, 'a year missing a holiday is not covered');
  assert.strictEqual(calendarEnd({ closed: y2029.closed, early: y2029.early }), COVERED_UNTIL, 'years extend it in order: 2028 first');
  assert.strictEqual(calendarEnd({ closed: [...y2028.closed, ...y2029.closed.slice(1)], early: [...y2028.early, ...y2029.early] }), '2028-12-31', '2029 without New Year\'s Day');
  assert.strictEqual(calendarEnd({ closed: [...y2028.closed, ...y2029.closed, '2029-01-09'], early: [...y2028.early, ...y2029.early] }), '2029-12-31', 'an extra closure is fine');
});

test('cmeHolidays: the rules reproduce the built-in table, and the CME calendars around it', () => {
  assert.deepStrictEqual([2026, 2027].flatMap(y => cmeHolidays(y).closed), CLOSED);
  assert.deepStrictEqual([2026, 2027].flatMap(y => cmeHolidays(y).early), EARLY_CLOSE);
  // 2025: July 3, the day after Thanksgiving and Christmas Eve closed early; Good Friday April 18.
  assert.deepStrictEqual(cmeHolidays(2025), {
    closed: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25'],
    early: ['2025-07-03', '2025-11-28', '2025-12-24'],
  });
  // 2028: New Year's Day on a Saturday isn't kept; Christmas Eve on a Sunday has no early close.
  assert.deepStrictEqual(cmeHolidays(2028), {
    closed: ['2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25'],
    early: ['2028-07-03', '2028-11-24'],
  });
  for (const y of [2026, 2027, 2028, 2029, 2030, 2031, 2032]) {
    for (const d of [...cmeHolidays(y).closed, ...cmeHolidays(y).early]) assert.ok(![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()), `${d} is a weekday`);
  }
});
