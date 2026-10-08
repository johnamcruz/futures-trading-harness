'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { compileCondition, compileRules, evaluateRules } = require('../../scripts/lib/trading/rules');
const { PARAMS, levels } = require('../../scripts/lib/trading/market-snapshot');
const { normalizeBars } = require('../../scripts/lib/trading/indicators');

const T0 = Date.UTC(2026, 9, 7, 14, 0);
function bars(closes) {
  return normalizeBars(closes.map((c, k) => ({ t: new Date(T0 + k * 180000).toISOString(), o: c, h: c + 1, l: c - 1, c, v: 100 })));
}

test('compileCondition parses series, functions, numbers, and arithmetic', () => {
  const c = compileCondition('close crosses_above vwap_rth + 0.5 * atr(14)');
  assert.strictEqual(c.op, 'crosses_above');
  assert.deepStrictEqual(c.left, [{ sign: 1, factors: [{ kind: 'series', key: 'close', shift: 0 }] }]);
  assert.strictEqual(c.right.length, 2);
  assert.strictEqual(compileCondition('-1 * close < 0').left[0].sign, -1);
  assert.strictEqual(compileCondition('minute_et >= 585').op, '>=');
  assert.deepStrictEqual(compileCondition('close > highest(20)[1]').right[0].factors[0], { kind: 'series', key: 'highest(20)', shift: 1 });
  assert.throws(() => compileCondition('close > open[501]'), /look-back/);
});

test('compileCondition rejects unknown series, bad syntax, and code', () => {
  for (const [text, msg] of [
    ['close > rsi(14)', /unknown function/],
    ['close > banana', /unknown series/],
    ['close', /needs a comparison/],
    ['close > open > high', /only one comparison/],
    ['close > ema(0)', /1-500/],
    ['close * high > 1', /not by another series/],
    ['close > open +', /ends with an operator/],
    ['process.exit() > 1', /cannot read/],
    ['close > open; rm -rf /', /cannot read/],
  ]) assert.throws(() => compileCondition(text), msg, text);
});

test('compileRules validates the block shape', () => {
  assert.deepStrictEqual(compileRules({ long: ['close > open'] }).errors, []);
  assert.match(compileRules(null).errors[0], /a map with long/);
  assert.match(compileRules({ up: ['close > 1'] }).errors[0], /only long and short/);
  assert.match(compileRules({ long: [] }).errors[0], /non-empty list/);
  assert.match(compileRules({ long: ['close >'] }).errors[0], /rules\.long/);
});

test('evaluateRules fires a direction when every condition holds', () => {
  const b = bars([100, 100, 100, 100, 102]);
  const p = { ...PARAMS };
  const lv = levels(b);
  const up = compileRules({ long: ['close crosses_above sma(3)', 'close > 101'], short: ['close < 90'] }).compiled;
  const r = evaluateRules(up, b, p, lv);
  assert.strictEqual(r.direction, 'long');
  assert.deepStrictEqual(r.long.map(x => x.ok), [true, true]);
  const notYet = compileRules({ long: ['close crosses_above sma(3)', 'close > 103'] }).compiled;
  assert.strictEqual(evaluateRules(notYet, b, p, lv).direction, null);
  const both = compileRules({ long: ['close > 1'], short: ['close > 1'] }).compiled;
  assert.strictEqual(evaluateRules(both, b, p, lv).direction, null, 'conflicting sides fire nothing');
  const warmup = compileRules({ long: ['close > ema(3)', 'adx(14) >= 0'] }).compiled;
  assert.strictEqual(evaluateRules(warmup, b, p, lv).direction, null, 'NaN warm-up values never satisfy a rule');
});
