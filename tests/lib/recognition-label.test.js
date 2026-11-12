'use strict';

// The recognition test's bars-only chop label v2 (scripts/lib/learning/recognition/label.js; docs/TRAINING.md "The
// recognition test"). It picks chop cases; it is never shown to the model and never grades a read. Synthetic bars only.
const test = require('node:test');
const assert = require('node:assert');
const L = require('../../scripts/lib/learning/recognition/label');
const RC = require('../../scripts/lib/learning/recognition/config');

const DEF = RC.load().definitions.chopLabel;
const TF = 3 * 60000;
const ET0 = Date.parse('2022-04-25T13:30:00Z'); // 09:30 New York (summer time)
const bars = (closes, warm = 30, t0 = ET0) => {
  const out = [];
  for (let i = -warm; i < 0; i += 1) out.push({ t: new Date(t0 + i * TF).toISOString(), o: 100, h: 100.5, l: 99.5, c: 100 });
  closes.forEach((c, i) => { const o = i ? closes[i - 1] : 100; out.push({ t: new Date(t0 + i * TF).toISOString(), o, h: Math.max(o, c) + 0.25, l: Math.min(o, c) - 0.25, c }); });
  return out;
};
const osc = n => Array.from({ length: n }, (_, i) => 100 + 30 * Math.sin((2 * Math.PI * i) / 25)); // back and forth, ~no net move
const run = n => Array.from({ length: n }, (_, i) => 100 + i * 1.5); // one straight line

test('the frozen thresholds come from config/recognition.json', () => {
  assert.deepStrictEqual({ ...DEF }, { window: '09:30-12:00@America/New_York', minBars: 40, netAtrMax: 1.5, rangeAtrMin: 3, atrPeriod: 14 });
  assert.strictEqual(L.erMax(50), 1 / Math.sqrt(50), 'a driftless random walk\'s expected efficiency: derived, not tuned');
});

test('an oscillation with no net move and a wide range is chop', () => {
  const r = L.chopLabel(bars(osc(50)), DEF);
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.n, 50);
  assert.strictEqual(r.day, '2022-04-25');
  assert.strictEqual(r.chop, true);
  assert.ok(r.efficiency < 0.05 && r.rangeAtr >= 3, JSON.stringify(r));
});

test('a straight run is not chop (efficiency near 1)', () => {
  const r = L.chopLabel(bars(run(50)), DEF);
  assert.strictEqual(r.chop, false);
  assert.ok(r.efficiency > 0.9);
});

test('too few window bars: not eligible, never a label', () => {
  const r = L.chopLabel(bars(osc(20)), DEF);
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.chop, null);
  assert.strictEqual(L.chopLabel([], DEF).eligible, false);
});

test('only bars opening in the window count: bars after it, and another day\'s, never change the label', () => {
  const a = bars(osc(50));
  const late = a.concat(Array.from({ length: 30 }, (_, i) => ({ t: new Date(ET0 + (50 + i) * TF).toISOString(), o: 100, h: 900, l: 1, c: 500 + i })));
  assert.deepStrictEqual(L.chopLabel(late, DEF), L.chopLabel(a, DEF));
  const nextDay = late.concat(bars(run(50), 0, ET0 + 24 * 3600000));
  assert.deepStrictEqual(L.chopLabel(nextDay, { ...DEF, day: '2022-04-25' }), L.chopLabel(a, DEF), 'the named day');
  assert.strictEqual(L.chopLabel(nextDay, { ...DEF, day: '2022-04-26' }).chop, false);
});

test('winter time: the window follows the New York clock', () => {
  const r = L.chopLabel(bars(osc(50), 30, Date.parse('2021-12-01T14:30:00Z')), DEF);
  assert.strictEqual(r.n, 50);
  assert.strictEqual(r.day, '2021-12-01');
});

test('each guard decides: a net move past the ceiling, or a range under the floor, is not chop', () => {
  const r = L.chopLabel(bars(osc(50)), DEF);
  assert.strictEqual(L.chopLabel(bars(osc(50)), { ...DEF, netAtrMax: Math.abs(r.netAtr) / 2 }).chop, false);
  assert.strictEqual(L.chopLabel(bars(osc(50)), { ...DEF, rangeAtrMin: r.rangeAtr * 2 }).chop, false);
  const drift = Array.from({ length: 50 }, (_, i) => 100 + i * 0.6 + (i % 2 ? -4 : 4));
  const d = L.chopLabel(bars(drift), DEF);
  assert.strictEqual(d.chop, d.efficiency <= L.erMax(d.n) && Math.abs(d.netAtr) <= 1.5 && d.rangeAtr >= 3);
});
