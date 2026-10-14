'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classifyRegime, regimeFits } = require('../../scripts/lib/trading/regime');
const { barsRequest, regimeGatedStrategy, regimeViolation } = require('../../scripts/lib/trading/account-gate');
const { normalizeBars } = require('../../scripts/lib/trading/indicators');

const T0 = Date.UTC(2026, 9, 7, 13, 30);
function series(fn, n = 160, range = 1) {
  return normalizeBars(Array.from({ length: n }, (_, k) => {
    const c = fn(k);
    return { t: new Date(T0 + k * 180000).toISOString(), o: c, h: c + range, l: c - range, c, v: 100 };
  }));
}

test('a steady climb is trend-up and a steady fall trend-down', () => {
  const up = classifyRegime(series(k => 100 + k * 0.8));
  assert.strictEqual(up.primary, 'trend-up');
  assert.deepStrictEqual(up.tags.slice(0, 2), ['trend-up', 'trend']);
  assert.strictEqual(classifyRegime(series(k => 300 - k * 0.8)).primary, 'trend-down');
});

test('a sideways oscillation is a range', () => {
  const r = classifyRegime(series(k => 100 + Math.sin(k / 2) * 2));
  assert.strictEqual(r.primary, 'range');
  assert.ok(r.metrics.adx < 18);
  assert.ok(!('vwapCrosses' in r.metrics), 'the count is named by its VWAP: sessionVwapCrosses');
});

test('chopping through the session VWAP is a range on the crosses alone (sessionVwapCrosses), whatever the ADX', () => {
  // From 16:00 ET, so the 18:00 ET session open (and its VWAP) is inside the bars.
  const t0 = Date.UTC(2026, 9, 7, 20, 0);
  const bars = normalizeBars(Array.from({ length: 160 }, (_, k) => {
    const c = 100 + Math.sin(k / 2) * 2;
    return { t: new Date(t0 + k * 180000).toISOString(), o: c, h: c + 1, l: c - 1, c, v: 100 };
  }));
  const r = classifyRegime(bars);
  assert.strictEqual(r.metrics.sessionVwapCrosses, 5);
  // The ADX branch off (rangeAdx 0): the crosses alone make it a range ...
  assert.strictEqual(classifyRegime(bars, { rangeAdx: 0 }).primary, 'range');
  // ... and without enough crosses it isn't one.
  assert.strictEqual(classifyRegime(bars, { rangeAdx: 0, rangeCrosses: 6 }).primary, 'transition');
});

test('volatility expansion is tagged high-vol; too few bars gives no regime', () => {
  const bars = series(k => 100 + Math.sin(k / 3), 160, 1).map((b, k) => (k >= 150 ? { ...b, h: b.c + 6, l: b.c - 6 } : b));
  assert.strictEqual(classifyRegime(bars).volatility, 'high');
  assert.strictEqual(classifyRegime(series(k => k, 20)), null);
});

test('regimeFits: any listed tag matches; no list fits all; unknown regime fits only unrestricted strategies', () => {
  const r = { primary: 'trend-up', tags: ['trend-up', 'trend', 'normal-vol'] };
  assert.strictEqual(regimeFits(['trend'], r), true);
  assert.strictEqual(regimeFits(['range', 'high-vol'], r), false);
  assert.strictEqual(regimeFits(undefined, r), true);
  assert.strictEqual(regimeFits(['trend'], null), false);
});

test('gateway regime gate: only gated entries, correct bars request, and a readable block', () => {
  const gated = { name: 'vwap_reclaim', valid: true, regime_gate: true, regimes: ['trend'], timeframe: '3m' };
  const strategies = [gated, { name: 'orb', valid: true, regimes: ['trend'] }];
  assert.strictEqual(regimeGatedStrategy({ rationale: 'setup:vwap_reclaim long' }, strategies), gated);
  assert.strictEqual(regimeGatedStrategy({ rationale: 'setup:orb long' }, strategies), null);
  assert.strictEqual(regimeGatedStrategy({ rationale: '[exit] flatten setup:vwap_reclaim' }, strategies), null);
  assert.deepStrictEqual(barsRequest('C', '3m'), { contractId: 'C', unit: 'minute', unitNumber: 3, limit: 500, includePartialBar: false });
  assert.deepStrictEqual(barsRequest('C', '1h').unit, 'hour');
  assert.strictEqual(barsRequest('C', 'weird'), null);
  const config = { skipChecks: new Set() };
  assert.deepStrictEqual(regimeViolation(gated, series(k => 100 + k * 0.8), config), []);
  const v = regimeViolation(gated, series(k => 100 + Math.sin(k / 2) * 2), config);
  assert.strictEqual(v[0].check, 'regime');
  assert.match(v[0].message, /trades only in trend; the 3m regime is range/);
});
