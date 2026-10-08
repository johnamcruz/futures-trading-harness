'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { htfCandles, normalizeBars } = require('../../scripts/lib/trading/indicators');
const { compileCondition, compileExpression, evaluateRules, seriesSource } = require('../../scripts/lib/trading/rules');
const { loadStrategies, validateStrategy } = require('../../scripts/lib/trading/strategies');
const { createEvaluator } = require('../../scripts/lib/trading/evaluator');

const ROOT = path.resolve(__dirname, '..', '..');
// 2026-10-07 is EDT (UTC-4): 09:00 ET = 13:00 UTC.
const et = (h, m = 0) => Date.UTC(2026, 9, 7, h + 4, m);
const mk = rows => normalizeBars(rows.map(([t, o, h, l, c]) => ({ t: new Date(t).toISOString(), o, h, l, c, v: 100 })));
/** Flat 3-minute bars from `from` (ms) to `to` (exclusive) around `c`. */
const flat = (from, to, c) => {
  const rows = [];
  for (let t = from; t < to; t += 180000) rows.push([t, c, c + 2, c - 2, c]);
  return rows;
};

test('htfCandles: previous and current higher-timeframe candles, causal, aligned to the 18:00 ET open', () => {
  const rows = [...flat(et(10, 0), et(11, 0), 21500), ...flat(et(11, 0), et(11, 30), 21520)];
  rows[3][2] = 21540; // 10:09 high
  rows[7][3] = 21480; // 10:21 low
  const b = mk(rows);
  const h = htfCandles(b, 60);
  const at = t => b.findIndex(x => Date.parse(x.t) === t);
  // Inside the 10:00 hour: the 09:00 hour isn't in the data, so no previous candle.
  assert.ok(Number.isNaN(h.prevH[at(et(10, 30))]));
  // Data that starts mid-candle: that candle is cut off, so it is never a previous candle.
  const late = htfCandles(b.slice(2), 60);
  assert.ok(Number.isNaN(late.prevH[at(et(11, 0)) - 2]));
  assert.strictEqual(h.curH[at(et(10, 9))], 21540, 'the candle so far includes this bar');
  assert.strictEqual(h.curH[at(et(10, 6))], 21502, 'and nothing after it');
  // The 11:00 hour sees the 10:00 hour as its previous candle.
  const i = at(et(11, 0));
  assert.deepStrictEqual([h.prevO[i], h.prevH[i], h.prevL[i], h.prevC[i]], [21500, 21540, 21480, 21500]);
  assert.deepStrictEqual([h.curO[i], h.curH[i], h.curL[i]], [21520, 21522, 21518]);
  assert.notStrictEqual(h.key[i], h.key[i - 1]);
  // 4 hours open at 02:00, 06:00, 10:00, 14:00 ET (18:00-aligned): 09:57 and 10:00 are different candles.
  const four = mk([...flat(et(9, 0), et(10, 0), 1), ...flat(et(10, 0), et(10, 30), 2)]);
  const k = htfCandles(four, 240).key;
  assert.notStrictEqual(k[19], k[20]);
  assert.strictEqual(k[0], k[19]);
});

test('htf rule functions: minutes must divide a day, and a new candle is not a cross', () => {
  assert.ok(compileCondition('htfc_low(240) < htf_low(240)'));
  assert.throws(() => compileCondition('close > htf_high(7)'), /minutes must divide a day/);
  assert.throws(() => compileCondition('close > htf_mid(60)'), /unknown function/);
  // The previous-hour low jumps at 11:00 (from the 09:00 hour's 21528 to the
  // 10:00 hour's 21498): a close above the new level there is not a cross.
  const rows = [...flat(et(9, 0), et(10, 0), 21530), ...flat(et(10, 0), et(11, 0), 21500),
    [et(11, 0), 21500, 21512, 21499, 21510], [et(11, 3), 21510, 21511, 21494, 21495], [et(11, 6), 21495, 21506, 21494, 21505]];
  const b = mk(rows);
  const get = seriesSource(b, {});
  const cond = { long: [compileCondition('close crosses_above htf_low(60)')], short: [] };
  const first = b.findIndex(x => Date.parse(x.t) === et(11, 0));
  assert.strictEqual(get('htf_low(60)')[first - 1], 21528);
  assert.strictEqual(get('htf_low(60)')[first], 21498);
  assert.ok(get.resets('htf_low(60)', first));
  assert.strictEqual(evaluateRules(cond, b, {}, { index: first, get }).direction, null, 'a jump, not a cross');
  // A real reclaim inside the hour is a cross.
  assert.strictEqual(evaluateRules(cond, b, {}, { index: first + 2, get }).direction, 'long');
});

test('a per-side stop: a map of long and short distance expressions', () => {
  const base = {
    name: 'x', description: 'a test strategy with a per-side stop for sweeps of a range', version: 1, status: 'paper',
    instruments: ['MNQ'], timeframe: '3m', signal: 'rules', rules: { long: ['close > open'], short: ['close < open'] }, source: 'test',
  };
  const body = '## When to Use\n## How It Works\n## Examples';
  assert.deepStrictEqual(validateStrategy({ ...base, risk: { stop: { long: 'close - low', short: 'high - close' }, min_rr: 2 } }, body, 'x'), []);
  assert.match(validateStrategy({ ...base, risk: { stop: { long: 'close - low' }, min_rr: 2 } }, body, 'x').join(' '), /exactly long and short/);
  assert.match(validateStrategy({ ...base, risk: { stop: { long: 'close - low', short: 'banana' }, min_rr: 2 } }, body, 'x').join(' '), /risk.stop.short/);
  assert.match(validateStrategy({ ...base, risk: { stop: { long: 'close - low', short: 5 }, min_rr: 2 } }, body, 'x').join(' '), /risk.stop.short: a distance expression/);
  // The evaluator takes the fired side's distance.
  const s = { ...base, valid: true, risk: { stop: { long: 'close - low', short: 'high - close' }, min_rr: 2 }, compiledStop: { long: compileExpression('close - low'), short: compileExpression('high - close') } };
  const sides = rules => ({ ...s, compiledRules: { long: rules.long.map(compileCondition), short: rules.short.map(compileCondition) } });
  const up = mk([...flat(et(10, 0), et(11, 0), 100), [et(11, 0), 100, 106, 98, 105]]);
  assert.strictEqual(createEvaluator(up).at(sides(s.rules), up.length - 1).stopDistance, 7);
  const down = mk([...flat(et(10, 0), et(11, 0), 100), [et(11, 0), 100, 103, 94, 95]]);
  assert.strictEqual(createEvaluator(down).at(sides(s.rules), down.length - 1).stopDistance, 8);
});

/**
 * The crt_1h example: the 10:00 hour ranges 21480-21540; at 11:12 the 11:00
 * hour sweeps to 21472.25, and the 11:18 bar closes at 21486.50, back inside
 * and above the five bars before it.
 */
function crtSweep() {
  const rows = [...flat(et(9, 0), et(10, 0), 21510)];
  for (let t = et(10, 0); t < et(11, 0); t += 180000) rows.push([t, 21510, 21515, 21505, 21510]);
  rows[22] = [et(10, 6), 21510, 21540, 21505, 21512]; // the 10:00 hour's high
  rows[30] = [et(10, 30), 21510, 21512, 21480, 21500]; // and its low
  rows.push(
    [et(11, 0), 21490, 21486, 21484, 21485],
    [et(11, 3), 21485, 21486, 21483, 21484],
    [et(11, 6), 21484, 21485, 21482, 21483],
    [et(11, 9), 21483, 21484, 21481, 21482],
    [et(11, 12), 21482, 21483, 21472.25, 21476], // the sweep
    [et(11, 15), 21476, 21479, 21474, 21478],
    [et(11, 18), 21478, 21487, 21477, 21486.5], // the shift
  );
  return mk(rows);
}

test('crt_1h fires on a sweep of the previous hour\'s low with the stop beyond the sweep', () => {
  const s = loadStrategies(ROOT, {}).strategies.find(x => x.name === 'crt_1h');
  assert.ok(s && s.valid, s && s.errors.join('; '));
  const b = crtSweep();
  const i = b.length - 1;
  const r = createEvaluator(b).at(s, i);
  assert.strictEqual(r.direction, 'long', JSON.stringify(r.rules));
  assert.strictEqual(r.candidate, true);
  const atr = seriesSource(b, {})('atr(20)')[i];
  assert.ok(Math.abs(r.stopDistance - (21486.5 - 21472.25 + 0.25 * atr)) < 1e-3);
  // One bar earlier (no shift yet), and with the far side too close for 2R, it does not fire.
  assert.strictEqual(createEvaluator(b).at(s, i - 1).direction, null);
  const near = b.map((x, k) => (k === 22 ? { ...x, h: 21500 } : x));
  assert.strictEqual(createEvaluator(near).at(s, i).direction, null, 'the CRT high is under 2R away');
  // A sweep of both sides (an outside hour) is not a CRT.
  const both = b.map((x, k) => (k === b.length - 3 ? { ...x, h: 21545 } : x));
  assert.strictEqual(createEvaluator(both).at(s, i).direction, null);
  // crt_4h reads the same series on 4-hour candles: one candle (06:00-10:00) isn't in the data, so it doesn't fire.
  const four = loadStrategies(ROOT, {}).strategies.find(x => x.name === 'crt_4h');
  assert.ok(four.valid);
  assert.strictEqual(createEvaluator(b).at(four, i).direction, null);
});
