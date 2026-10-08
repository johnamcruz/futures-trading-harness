'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { compileCondition, compileRules, evaluateRules, seriesSource, causalLevels } = require('../../scripts/lib/trading/rules');
const { PARAMS } = require('../../scripts/lib/trading/market-snapshot');
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
  const up = compileRules({ long: ['close crosses_above sma(3)', 'close > 101'], short: ['close < 90'] }).compiled;
  const r = evaluateRules(up, b, p);
  assert.strictEqual(r.direction, 'long');
  assert.deepStrictEqual(r.long.map(x => x.ok), [true, true]);
  const notYet = compileRules({ long: ['close crosses_above sma(3)', 'close > 103'] }).compiled;
  assert.strictEqual(evaluateRules(notYet, b, p).direction, null);
  const both = compileRules({ long: ['close > 1'], short: ['close > 1'] }).compiled;
  assert.strictEqual(evaluateRules(both, b, p).direction, null, 'conflicting sides fire nothing');
  const warmup = compileRules({ long: ['close > ema(3)', 'adx(14) >= 0'] }).compiled;
  assert.strictEqual(evaluateRules(warmup, b, p).direction, null, 'NaN warm-up values never satisfy a rule');
});

test('compile errors name the rule even when the text cannot be tokenized', () => {
  assert.throws(() => compileCondition('close > $5'), /"close > \$5": cannot read/);
  assert.throws(() => compileCondition('close'), /"close": needs a comparison/);
});

test('ema(n) has no value for the first n-1 bars', () => {
  const get = seriesSource(bars([1, 2, 3, 4, 5]), { ...PARAMS });
  const e = get('ema(3)');
  assert.ok(Number.isNaN(e[0]) && Number.isNaN(e[1]));
  assert.ok(Number.isFinite(e[2]));
});

test('rules mark conditions with no value yet as missing', () => {
  const r = evaluateRules(compileRules({ long: ['close > sma(50)', 'close > 0'] }).compiled, bars([1, 2, 3]), { ...PARAMS });
  assert.deepStrictEqual(r.long, [{ rule: 'close > sma(50)', ok: false, missing: true }, { rule: 'close > 0', ok: true }]);
});

test('overnight and prior levels are causal: each bar only sees earlier bars', () => {
  // 2026-10-06 RTH (ET = UTC-4): 13:30-20:00 UTC, then Globex from 22:00 UTC.
  const mk = (iso, h, l) => ({ t: iso, o: l, h, l, c: l, v: 1 });
  const b = normalizeBars([
    mk('2026-10-06T13:30:00Z', 110, 100),
    mk('2026-10-06T19:57:00Z', 120, 105), // RTH high 120
    mk('2026-10-06T22:00:00Z', 115, 112), // Globex opens
    mk('2026-10-07T02:00:00Z', 118, 111),
    mk('2026-10-07T06:00:00Z', 125, 113), // breaks the overnight high so far
    mk('2026-10-07T13:30:00Z', 126, 120), // RTH next day
  ]);
  const lv = causalLevels(b);
  assert.ok(Number.isNaN(lv.prior_high[0]) && Number.isNaN(lv.prior_high[1]), 'no completed RTH day yet');
  assert.strictEqual(lv.prior_high[2], 120);
  assert.strictEqual(lv.prior_low[2], 100);
  assert.ok(Number.isNaN(lv.overnight_high[2]), 'first Globex bar has no earlier overnight bars');
  assert.strictEqual(lv.overnight_high[3], 115);
  assert.strictEqual(lv.overnight_high[4], 118, 'the current bar is excluded so a break can cross it');
  assert.strictEqual(lv.overnight_high[5], 125);
  assert.strictEqual(lv.overnight_low[5], 111);
  const r = evaluateRules(compileRules({ long: ['high > overnight_high'] }).compiled, b.slice(0, 5), { ...PARAMS });
  assert.strictEqual(r.direction, 'long');
});

test('a break on the first bar after the opening range is a cross', () => {
  const mk = (iso, o, h, l, c) => ({ t: iso, o, h, l, c, v: 1 });
  // 2026-10-07, ET = UTC-4. 15-minute range 09:30-09:45 on 3m bars.
  const b = normalizeBars([
    mk('2026-10-07T13:30:00Z', 21495, 21500, 21490, 21495), mk('2026-10-07T13:33:00Z', 21495, 21499, 21492, 21494),
    mk('2026-10-07T13:36:00Z', 21494, 21498, 21491, 21495), mk('2026-10-07T13:39:00Z', 21495, 21497, 21493, 21494),
    mk('2026-10-07T13:42:00Z', 21494, 21498, 21492, 21495), mk('2026-10-07T13:45:00Z', 21495, 21510, 21494, 21508.25),
  ]);
  const r = evaluateRules(compileRules({ long: ['close crosses_above or_high'] }).compiled, b, { ...PARAMS });
  assert.strictEqual(r.direction, 'long');
});

test('a level that starts over is not a cross', () => {
  const mk = (iso, c) => ({ t: iso, o: c, h: c + 0.25, l: c - 0.25, c, v: 100 });
  // Session VWAP restarts at 18:00 ET (22:00Z): price is below the old VWAP and the new one starts at its typical price.
  const b = normalizeBars([mk('2026-10-07T21:50:00Z', 21540), mk('2026-10-07T21:55:00Z', 21480), { t: '2026-10-07T22:00:00Z', o: 21479, h: 21479, l: 21477, c: 21479, v: 100 }]);
  const get = seriesSource(b, { ...PARAMS });
  assert.ok(get('close')[1] < get('vwap_session')[1] && get('close')[2] > get('vwap_session')[2], 'the scenario would otherwise read as a cross');
  const r = evaluateRules(compileRules({ long: ['close crosses_above vwap_session'] }).compiled, b, { ...PARAMS });
  assert.strictEqual(r.direction, null);
});
