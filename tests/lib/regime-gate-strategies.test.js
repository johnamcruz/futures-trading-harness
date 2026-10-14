'use strict';

/**
 * The trend-following strategies trade only in a trend or transition regime, never in a range (chop): the scan
 * doesn't list them (evaluator inRegime) and the gateway refuses their entries (regime_gate). The reversal and
 * value-area-reentry strategies keep trading a range.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { createEvaluator } = require('../../scripts/lib/trading/evaluator');
const { classifyRegime } = require('../../scripts/lib/trading/regime');
const { regimeGatedStrategy, regimeViolation } = require('../../scripts/lib/trading/account-gate');

const ROOT = path.resolve(__dirname, '..', '..');
const ALL = Object.fromEntries(loadStrategies(ROOT, {}).strategies.map(s => [s.name, s]));
const TREND = ['orb', 'value_area_breakout'];
const T0 = Date.UTC(2026, 9, 7, 13, 30);
const series = (fn, n = 200) => Array.from({ length: n }, (_, k) => {
  const c = fn(k);
  return { t: new Date(T0 + k * 180000).toISOString(), o: c, h: c + 1, l: c - 1, c, v: 100 };
});
const CHOP = series(k => 21000 + Math.sin(k / 2) * 2);
const TRENDING = series(k => 21000 + k * 0.8);

test('the trend-following strategies are regime-gated to trend and transition', () => {
  for (const name of TREND) {
    const s = ALL[name];
    assert.ok(s && s.valid, name);
    assert.deepStrictEqual([s.regimes, s.regime_gate], [['trend', 'transition'], true], name);
  }
  // The reversal and range strategies are not: they trade a range too.
  for (const name of ['crt_1h', 'crt_4h', 'cisd_ote', 'value_area_reentry']) assert.ok(!ALL[name].regimes, name);
});

test('in a range the scan never lists them and the gateway refuses their entries; in a trend both let them through', () => {
  assert.strictEqual(classifyRegime(CHOP).primary, 'range', 'control: the chop is a range');
  assert.strictEqual(classifyRegime(TRENDING).primary, 'trend-up', 'control: the climb is a trend');
  const config = { skipChecks: new Set() };
  for (const name of TREND) {
    const s = ALL[name];
    const last = CHOP.length - 1;
    const r = createEvaluator(CHOP).at(s, last, { describe: true });
    assert.strictEqual(r.inRegime, false, `${name}: out of regime in a range`);
    assert.strictEqual(r.candidate, false, name);
    assert.strictEqual(createEvaluator(TRENDING).at(s, TRENDING.length - 1, { describe: true }).inRegime, true, `${name}: in regime in a trend`);
    // The gateway: a setup:<name> entry is regime-checked, refused in the range, let through in the trend.
    const gated = regimeGatedStrategy({ rationale: `setup:${name} long` }, Object.values(ALL));
    assert.strictEqual(gated && gated.name, name);
    assert.match(regimeViolation(gated, CHOP, config)[0].message, new RegExp(`setup:${name} trades only in trend, transition; the 3m regime is range`));
    assert.deepStrictEqual(regimeViolation(gated, TRENDING, config), [], name);
  }
});
