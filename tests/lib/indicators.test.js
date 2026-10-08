'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ind = require('../../scripts/lib/trading/indicators');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

function bar(t, o, h, l, c, v = 100) { return { t, o, h, l, c, v }; }

test('normalizeBars accepts get_bars output and sorts by time', () => {
  const bars = ind.normalizeBars({ bars: [bar('2026-10-07T14:05:00Z', 2, 3, 1, 2), bar('2026-10-07T14:00:00Z', 1, 2, 0, 1)] });
  assert.strictEqual(bars[0].t, '2026-10-07T14:00:00Z');
  assert.throws(() => ind.normalizeBars({ nope: 1 }));
});

test('ema matches pandas ewm(adjust=False)', () => {
  const out = ind.ema([1, 2, 3, 4], 3); // alpha 0.5
  close(out[0], 1); close(out[1], 1.5); close(out[2], 2.25); close(out[3], 3.125);
});

test('rma seeds with the mean of the first period inputs, as futures_foundation does', () => {
  const out = ind.rma([2, 4, 6, 8], 2);
  assert.ok(Number.isNaN(out[0]));
  assert.deepStrictEqual(out.slice(1), [3, 4.5, 6.25]);
});

test('atr of constant-range bars equals the range', () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(`2026-10-07T14:${String(i).padStart(2, '0')}:00Z`, 10, 11, 9, 10));
  const a = ind.atr(bars, 14);
  assert.ok(Number.isNaN(a[12]));
  close(a[13], 2); close(a[29], 2); // first value at index period-1, as compute_atr
});

test('adx is high in a steady trend and supertrend points up', () => {
  const bars = Array.from({ length: 80 }, (_, i) => bar(new Date(Date.UTC(2026, 9, 7, 14, i)).toISOString(), 100 + i, 101.5 + i, 99.5 + i, 101 + i));
  const a = ind.adx(bars, 14);
  assert.ok(a[79] > 50, `adx ${a[79]}`);
  assert.strictEqual(ind.supertrend(bars, 10, 3).direction[79], 1);
  const k = ind.keltner(bars);
  assert.ok(k.upper[79] > k.mid[79] && k.mid[79] > k.lower[79]);
});

test('swings confirm k bars after the pivot', () => {
  const highs = [1, 2, 5, 2, 1, 1, 1];
  const bars = highs.map((h, i) => bar(`2026-10-07T14:0${i}:00Z`, h, h, h - 0.5, h));
  const s = ind.swings(bars, 2);
  assert.ok(Number.isNaN(s.high[3]));
  assert.strictEqual(s.high[4], 5);
  assert.strictEqual(s.highIdx[4], 2);
});

test('opening range is active only after it closes', () => {
  // 09:30, 09:35, 09:40 ET (13:30Z..), then 09:45 and 09:50
  const t = m => new Date(Date.UTC(2026, 9, 7, 13, 30 + m)).toISOString();
  const bars = [bar(t(-5), 1, 1, 1, 1), bar(t(0), 10, 12, 9, 11), bar(t(5), 11, 13, 10, 12), bar(t(10), 12, 12, 8, 9), bar(t(15), 9, 14, 9, 14), bar(t(20), 14, 15, 13, 14)];
  const or = ind.openingRange(bars, 15);
  assert.ok(Number.isNaN(or.high[3]));
  assert.strictEqual(or.high[4], 13);
  assert.strictEqual(or.low[4], 8);
});

test('anchored vwap resets at the anchor and rth vwap ignores overnight bars', () => {
  const t = (h, m) => new Date(Date.UTC(2026, 9, 7, h, m)).toISOString(); // ET = UTC-4
  const bars = [bar(t(13, 25), 0, 1, 1, 1, 10), bar(t(13, 30), 0, 2, 2, 2, 10), bar(t(13, 35), 0, 4, 4, 4, 30)];
  const rth = ind.anchoredVwap(bars, 570, 960);
  assert.ok(Number.isNaN(rth[0]));
  close(rth[1], 2); close(rth[2], 3.5);
  const globex = ind.anchoredVwap([bar(t(21, 55), 0, 10, 10, 10, 1), bar(t(22, 0), 0, 20, 20, 20, 1)], 18 * 60);
  close(globex[0], 10); close(globex[1], 20); // 18:00 ET starts a new session
});

test('ADX starts from flat bars instead of staying undefined', () => {
  const { adx } = require('../../scripts/lib/trading/indicators');
  const bars = [
    ...Array.from({ length: 20 }, () => ({ o: 100, h: 100, l: 100, c: 100 })),
    ...Array.from({ length: 60 }, (_, i) => ({ o: 100 + i, h: 101 + i, l: 99.5 + i, c: 100.5 + i })),
  ];
  const a = adx(bars, 14);
  assert.ok(Number.isFinite(a[a.length - 1]) && a[a.length - 1] > 50);
});
