'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { openingType, dayType, dayContextSeries, describeDay } = require('../../scripts/lib/trading/day-context');
const { readBarsArg } = require('../../scripts/lib/backtest/data');

const NQ = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
const at = t => NQ.findIndex(b => b.t === t);

test('opening types: drive, test-drive, rejection-reverse, auction (and their mirrors)', () => {
  // o, h, l, c over the first 30 minutes; th/tl: when the high and low came.
  assert.strictEqual(openingType({ o: 100, h: 120, l: 99, c: 118, th: 9, tl: 0 }), 'open-drive up');
  assert.strictEqual(openingType({ o: 100, h: 101, l: 80, c: 82, th: 0, tl: 9 }), 'open-drive down');
  assert.strictEqual(openingType({ o: 100, h: 120, l: 94, c: 116, th: 9, tl: 2 }), 'open-test-drive up', 'tested 6 down first, then drove up');
  assert.strictEqual(openingType({ o: 100, h: 106, l: 80, c: 84, th: 2, tl: 9 }), 'open-test-drive down');
  assert.strictEqual(openingType({ o: 100, h: 110, l: 88, c: 106, th: 9, tl: 3 }), 'open-rejection-reverse up', 'went 12 down first, rejected back through the open');
  assert.strictEqual(openingType({ o: 100, h: 112, l: 90, c: 94, th: 3, tl: 9 }), 'open-rejection-reverse down');
  assert.strictEqual(openingType({ o: 100, h: 105, l: 95, c: 101, th: 3, tl: 6 }), 'open-auction');
  assert.strictEqual(openingType({ o: 100, h: 100, l: 100, c: 100, th: 0, tl: 0 }), null);
});

test('day types from the initial balance extensions', () => {
  assert.strictEqual(dayType(110, 100, 109, 101), 'inside the initial balance');
  assert.strictEqual(dayType(110, 100, 114, 100), 'normal variation up');
  assert.strictEqual(dayType(110, 100, 110, 97), 'normal variation down');
  assert.strictEqual(dayType(110, 100, 121, 100), 'normal variation up', 'one IB of extension is still normal variation (Dalton)');
  assert.strictEqual(dayType(110, 100, 130, 100), 'trend up', 'two IBs');
  assert.strictEqual(dayType(110, 100, 100, 79), 'trend down');
  assert.strictEqual(dayType(110, 100, 121, 100, 40), 'trend up', 'one IB from a narrow IB (under 0.35 ADR)');
  assert.strictEqual(dayType(110, 100, 121, 100, 20), 'normal variation up', 'an IB half the ADR is not narrow');
  assert.strictEqual(dayType(110, 100, 112, 98), 'neutral');
});

test('on real NQ bars: the open against the prior day, the initial balance, the day type, the ADR', () => {
  const s = dayContextSeries(NQ, { adrDays: 2 });
  // 2026-04-24: opened 27210.00, above the prior RTH day's range, +283.75 from its close; extended 1.4 IBs up.
  const close = s.day[at('2026-04-24T19:57:00.000Z')];
  assert.strictEqual(close.open, 27210);
  assert.strictEqual(close.openVs, 'above the prior range');
  assert.strictEqual(close.gap, 283.75);
  assert.strictEqual(close.ibHigh, 27267.25);
  assert.strictEqual(close.ibLow, 27130.25);
  assert.strictEqual(close.dayType, 'normal variation up', '195.25 above a 137-point IB: under 2 IBs');
  assert.strictEqual(close.adr, null, 'one complete day before it: no 2-day average');
  // The IB is known from the 10:27 ET bar (it closes at 10:30), not before.
  const ib = at('2026-04-24T14:27:00.000Z');
  assert.ok(Number.isNaN(s.ib_high[ib - 1]) && s.ib_high[ib] === 27267.25);
  assert.strictEqual(s.day[ib - 1].dayType, null);
  // The opening type is known from the 09:57 ET bar.
  const ot = at('2026-04-24T13:57:00.000Z');
  assert.strictEqual(s.day[ot - 1].openType, null);
  assert.ok(typeof s.day[ot].openType === 'string');
  // 2026-04-27: opened inside the prior value area; by 13:15 ET still inside its IB; 2 days of ADR.
  const d = s.day[at('2026-04-27T17:15:00.000Z')];
  assert.strictEqual(d.openVs, 'inside the prior value area');
  assert.strictEqual(d.dayType, 'inside the initial balance');
  assert.ok(Math.abs(d.adr - 403.125) < 1e-9);
  assert.ok(Math.abs(s.adr[at('2026-04-27T17:15:00.000Z')] - 403.125) < 1e-9);
  // Outside RTH there is no day context.
  assert.strictEqual(s.day[NQ.length - 1], null);
});

test('a missing last bar of the opening window or the first hour still completes them, from their own bars', () => {
  // 2026-04-24 without its 09:57 and 10:27 ET bars: the opening type and the IB come on the next bar.
  const drop = new Set(['2026-04-24T13:57:00.000Z', '2026-04-24T14:27:00.000Z']);
  const bars = NQ.filter(b => !drop.has(b.t));
  const full = dayContextSeries(NQ, { adrDays: 2 });
  const gap = dayContextSeries(bars, { adrDays: 2 });
  const after = t => bars.findIndex(b => b.t === t);
  assert.ok(typeof gap.day[after('2026-04-24T14:00:00.000Z')].openType === 'string');
  // The IB from the first hour's bars only: the 10:30 bar's range is not in it.
  const ib = gap.day[after('2026-04-24T14:30:00.000Z')];
  const want = NQ.filter(b => b.t >= '2026-04-24T13:30:00.000Z' && b.t < '2026-04-24T14:30:00.000Z' && !drop.has(b.t));
  assert.strictEqual(ib.ibHigh, Math.max(...want.map(b => b.h)));
  assert.strictEqual(ib.ibLow, Math.min(...want.map(b => b.l)));
  assert.ok(ib.ibHigh <= full.day[at('2026-04-24T14:30:00.000Z')].ibHigh);
});

test('no look-ahead: bar i gets the same context from bars 0..i as from the whole series', () => {
  const full = dayContextSeries(NQ, { adrDays: 2 });
  for (const i of [500, 560, 700, 980, 1250, 1299, 1400]) {
    const part = dayContextSeries(NQ.slice(0, i + 1), { adrDays: 2 });
    assert.deepStrictEqual(part.day[i], full.day[i], `bar ${i}`);
    assert.ok(Object.is(part.ib_high[i], full.ib_high[i]));
  }
});

test('the prompt line, and the series in the rules language', () => {
  const s = dayContextSeries(NQ, { adrDays: 2 });
  const line = describeDay(s.day[at('2026-04-27T17:15:00.000Z')], { symbol: 'MNQ' });
  assert.match(line, /^MNQ day: opened 27410\.75 inside the prior value area, gap -23\.25 from the prior close \(0\.06 ADR\); opening type open-[a-z-]+( up| down)?; initial balance 27298\.5-27435 \(136\.5 points, 0\.34 ADR\), extended 0 up and 0 down: inside the initial balance; range so far 136\.5 of a 2-day average 403\.13 \(34% used\)\.$/);
  assert.match(describeDay(s.day[at('2026-04-24T13:45:00.000Z')]), /the first 30 minutes are not over; initial balance: the first hour is not over/);
  const { seriesSource, compileCondition } = require('../../scripts/lib/trading/rules');
  const { PARAMS } = require('../../scripts/lib/trading/market-snapshot');
  const get = seriesSource(NQ, { ...PARAMS });
  assert.deepStrictEqual(get('ib_high'), dayContextSeries(NQ).ib_high);
  assert.deepStrictEqual(get('adr(2)'), s.adr);
  assert.doesNotThrow(() => compileCondition('close crosses_above ib_high'));
  assert.doesNotThrow(() => compileCondition('rth_high - rth_low < 0.5 * adr(10)'));
  // The IB appears on the bar that completes it, with no value before: nothing crosses it on that bar.
  const { evaluateRules, compileRules } = require('../../scripts/lib/trading/rules');
  const done = at('2026-04-27T14:27:00.000Z');
  assert.ok(Number.isNaN(get('ib_high')[done - 1]) && Number.isFinite(get('ib_high')[done]));
  const r = evaluateRules(compileRules({ long: ['close crosses_above ib_high'] }).compiled, NQ, { ...PARAMS }, { index: done, get });
  assert.strictEqual(r.long[0].ok, false);
});

test('a strategy can use ib_high, ib_low, adr(n) only on a timeframe with a bar at 09:30 ET', () => {
  const { validateStrategy } = require('../../scripts/lib/trading/strategies');
  const body = '## When to Use\n## How It Works\n## Examples';
  const base = { name: 'x', description: 'x'.repeat(40), status: 'paper', instruments: ['MNQ'], signal: 'rules', rules: { long: ['close crosses_above ib_high'] }, risk: { stop: 'atr:1', min_rr: 2 } };
  assert.deepStrictEqual(validateStrategy({ ...base, timeframe: '3m' }, body, 'x'), []);
  assert.deepStrictEqual(validateStrategy({ ...base, timeframe: '15m' }, body, 'x'), []);
  assert.ok(validateStrategy({ ...base, timeframe: '1h' }, body, 'x').some(e => /divides 30 minutes/.test(e)));
  assert.ok(validateStrategy({ ...base, timeframe: '20m', rules: { long: ['rth_high - rth_low < adr(10)'] } }, body, 'x').some(e => /divides 30 minutes/.test(e)));
});
