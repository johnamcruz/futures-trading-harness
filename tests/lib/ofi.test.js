'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { barDelta, ofi, normalizeBars } = require('../../scripts/lib/trading/indicators');
const { seriesSource, compileCondition } = require('../../scripts/lib/trading/rules');
const { PARAMS } = require('../../scripts/lib/trading/market-snapshot');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { createEvaluator } = require('../../scripts/lib/trading/evaluator');

const ROOT = path.resolve(__dirname, '..', '..');
const T0 = Date.UTC(2026, 9, 7, 14, 0);
const mk = rows => normalizeBars(rows.map(([o, h, l, c, v], k) => ({ t: new Date(T0 + k * 60000).toISOString(), o, h, l, c, v })));

test('barDelta signs each bar\'s volume by where it closed in its range', () => {
  const d = barDelta(mk([[10, 11, 9, 11, 100], [11, 12, 10, 10, 100], [10, 12, 10, 11, 50], [11, 11, 11, 11, 40], [11, 10.5, 10.5, 10.5, 40]]));
  assert.deepStrictEqual(d, [100, -100, 0, 0, -40]);
});

test('ofi is signed volume over volume across n bars, NaN until n bars or with no volume', () => {
  const b = mk([[10, 11, 9, 11, 100], [11, 12, 10, 10, 300], [10, 12, 10, 12, 100], [12, 13, 12, 13, 0]]);
  const o3 = ofi(b, 3);
  assert.ok(Number.isNaN(o3[1]));
  assert.strictEqual(o3[2], (100 - 300 + 100) / 500);
  assert.ok(Number.isNaN(ofi(mk([[1, 2, 0, 1, 0]]), 1)[0]));
});

test('rules: ofi(n), delta(n) and vol_sma(n) are series', () => {
  for (const r of ['ofi(3) >= 0.3', 'delta(5) > 0', 'vol_sma(5) >= 1.2 * vol_sma(60)']) compileCondition(r);
  const b = mk([[10, 11, 9, 11, 100], [11, 12, 10, 10, 300], [10, 12, 10, 12, 100]]);
  const get = seriesSource(b, PARAMS);
  assert.deepStrictEqual(get('delta(2)').slice(1), [-200, -200]);
  assert.deepStrictEqual(get('vol_sma(3)').slice(2), [500 / 3]);
});

/** 70 quiet 1-minute bars, then `tail`. */
function series(tail) {
  const rows = [];
  for (let k = 0; k < 70; k += 1) {
    const c = 21500 + (k % 2 ? 1 : -1);
    rows.push([c, c + 2, c - 2, c, 100]);
  }
  return mk([...rows, ...tail]);
}

function fired(bars) {
  const all = loadStrategies(ROOT, {}).strategies.filter(s => s.name === 'ofi' || s.name === 'ofi_absorption');
  assert.strictEqual(all.length, 2);
  const ev = createEvaluator(bars);
  const i = bars.length - 1;
  return Object.fromEntries(all.map(s => [s.name, ev.at(s, i).direction]));
}

test('ofi fires on real flow: buying at 1, 3 and 5 minutes that moves price', () => {
  const tail = [];
  let c = 21499;
  for (let k = 0; k < 5; k += 1) { tail.push([c, c + 3, c - 0.5, c + 3, 300]); c += 3; }
  assert.deepStrictEqual(fired(series(tail)), { ofi: 'long', ofi_absorption: null });
});

test('ofi_absorption fires when heavy selling fails to move price and the bar turns', () => {
  // Four bars close at their lows on heavy volume, yet the closes don't fall.
  const tail = [[21499, 21502, 21498.5, 21499, 400], [21499, 21502, 21498.5, 21499, 400], [21499, 21502, 21498.5, 21499, 400], [21499, 21502, 21498.5, 21499, 400], [21499, 21500.75, 21498.75, 21500.5, 300]];
  assert.deepStrictEqual(fired(series(tail)), { ofi: null, ofi_absorption: 'long' });
});
