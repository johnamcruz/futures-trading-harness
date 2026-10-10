'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CLOSED, EARLY_CLOSE, COVERED_UNTIL, exchangeCalendar, coverageError } = require('../../scripts/lib/trading/exchange-calendar');
const { tradingDayKey } = require('../../scripts/lib/trading/clock');

test('calendar: the built-in CME dates, plus configured ones (a list or a comma string); configuration only adds', () => {
  const base = exchangeCalendar();
  assert.ok(base.closedDates.has('2026-04-03') && base.closedDates.has('2026-12-25') && base.earlyCloseDates.has('2026-11-27'));
  const more = exchangeCalendar({ closed: '2028-04-14, 2028-12-25', early: ['2028-01-17'] });
  assert.ok(more.closedDates.has('2028-04-14') && more.closedDates.has('2028-12-25') && more.closedDates.has('2026-12-25'));
  assert.ok(more.earlyCloseDates.has('2028-01-17') && more.earlyCloseDates.has('2026-11-26'));
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
  assert.strictEqual(coverageError(new Date('2027-12-15T12:00:00Z'), { closed: ['2028-04-14'] }), null);
  assert.strictEqual(coverageError(new Date('2027-12-15T12:00:00Z'), { early: '2028-01-17' }), null);
  assert.match(coverageError(new Date('2027-12-15T12:00:00Z'), { closed: ['not-a-date'] }), /calendar ends 2027-12-31/);
});
