'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { tradingDayStart, zonedTimeToUtc, parseWindows, inWindow, minutesOfDay } = require('../../scripts/lib/trading/clock');

test('trading day starts at the most recent 17:00 Chicago time', () => {
  // 09:00 CDT Wednesday -> started Tuesday 17:00 CDT (22:00Z)
  assert.strictEqual(tradingDayStart(new Date('2026-10-07T14:00:00Z')).toISOString(), '2026-10-06T22:00:00.000Z');
  // 17:30 CDT -> started today 17:00 CDT
  assert.strictEqual(tradingDayStart(new Date('2026-10-07T22:30:00Z')).toISOString(), '2026-10-07T22:00:00.000Z');
  // exactly 17:00 CDT counts as the new day
  assert.strictEqual(tradingDayStart(new Date('2026-10-07T22:00:00Z')).toISOString(), '2026-10-07T22:00:00.000Z');
});

test('trading day start follows standard time in winter', () => {
  // 10:00 CST -> previous day 17:00 CST (23:00Z)
  assert.strictEqual(tradingDayStart(new Date('2026-12-02T16:00:00Z')).toISOString(), '2026-12-01T23:00:00.000Z');
});

test('trading day start across the November DST change', () => {
  // DST ends 2026-11-01 02:00 CDT. Monday 2026-11-02 09:00 CST -> Sunday 17:00 CST (23:00Z)
  assert.strictEqual(tradingDayStart(new Date('2026-11-02T15:00:00Z')).toISOString(), '2026-11-01T23:00:00.000Z');
  // Sunday 2026-11-01 08:00 CST -> Saturday 17:00 CDT (22:00Z)
  assert.strictEqual(tradingDayStart(new Date('2026-11-01T14:00:00Z')).toISOString(), '2026-10-31T22:00:00.000Z');
});

test('zonedTimeToUtc converts wall clock to UTC', () => {
  assert.strictEqual(
    zonedTimeToUtc({ year: 2026, month: 3, day: 9, hour: 9, minute: 30 }, 'America/New_York').toISOString(),
    '2026-03-09T13:30:00.000Z'
  );
});

test('parseWindows accepts valid specs and reports invalid ones', () => {
  const { windows, errors } = parseWindows('09:30-09:35@America/New_York, bad, 10:00-11:00@Not/AZone, 25:00-26:00@UTC');
  assert.strictEqual(windows.length, 1);
  assert.deepStrictEqual(errors, ['bad', '10:00-11:00@Not/AZone', '25:00-26:00@UTC']);
  assert.deepStrictEqual(parseWindows(''), { windows: [], errors: [] });
});

test('inWindow is start-inclusive, end-exclusive, and wraps midnight', () => {
  const { windows: [open] } = parseWindows('09:30-09:35@America/New_York');
  assert.strictEqual(inWindow(new Date('2026-10-07T13:30:00Z'), open), true);
  assert.strictEqual(inWindow(new Date('2026-10-07T13:34:59Z'), open), true);
  assert.strictEqual(inWindow(new Date('2026-10-07T13:35:00Z'), open), false);
  const { windows: [night] } = parseWindows('23:00-01:00@UTC');
  assert.strictEqual(inWindow(new Date('2026-10-07T23:30:00Z'), night), true);
  assert.strictEqual(inWindow(new Date('2026-10-08T00:30:00Z'), night), true);
  assert.strictEqual(inWindow(new Date('2026-10-08T01:00:00Z'), night), false);
  assert.strictEqual(minutesOfDay(new Date('2026-10-07T14:05:00Z'), 'UTC'), 14 * 60 + 5);
});

test('one trading day runs from the 18:00 ET open to the 16:00 ET close, the same day everywhere it is counted', () => {
  const { tradingDayKey } = require('../../scripts/lib/trading/clock');
  const { sessionKey } = require('../../scripts/lib/trading/indicators');
  const { dayKey } = require('../../scripts/lib/autotrader');
  const { dayEndMs } = require('../../scripts/lib/trading/prop-state');
  const et = (date, hhmm) => zonedTimeToUtc({ year: +date.slice(0, 4), month: +date.slice(5, 7), day: +date.slice(8, 10), hour: +hhmm.slice(0, 2), minute: +hhmm.slice(3, 5) }, 'America/New_York');
  const days = at => [tradingDayKey(at), dayKey(at), sessionKey(at.toISOString(), 18 * 60).replace(/-(\d)(?=-|$)/g, '-0$1')];
  // Sunday's 18:00 open through Monday's 16:00 close is Monday's day, in the gate, the runner and the indicators alike.
  for (const [date, hhmm] of [['2026-10-11', '18:00'], ['2026-10-11', '23:59'], ['2026-10-12', '00:00'], ['2026-10-12', '09:30'], ['2026-10-12', '15:59']]) {
    assert.deepStrictEqual(days(et(date, hhmm)), ['2026-10-12', '2026-10-12', '2026-10-12'], `${date} ${hhmm} ET`);
  }
  // The 16:00-18:00 break belongs to the day that closed; the 18:00 open starts the next.
  assert.strictEqual(tradingDayKey(et('2026-10-12', '17:00')), '2026-10-12');
  assert.strictEqual(tradingDayKey(et('2026-10-12', '18:00')), '2026-10-13');
  // A day ends at the next open (18:00 ET), in summer and winter, and Friday's at Friday 18:00.
  assert.strictEqual(dayEndMs('2026-10-12'), et('2026-10-12', '18:00').getTime());
  assert.strictEqual(dayEndMs('2026-12-14'), et('2026-12-14', '18:00').getTime());
  assert.strictEqual(dayEndMs('2026-10-16'), et('2026-10-16', '18:00').getTime());
  // Across a clock change: the Sunday 18:00 open after the November change is Monday's day.
  assert.strictEqual(tradingDayKey(et('2026-11-01', '18:30')), '2026-11-02');
});
