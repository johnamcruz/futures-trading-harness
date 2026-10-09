'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { htfCandles, normalizeBars } = require('../../scripts/lib/trading/indicators');
const { compileCondition, compileExpression, evaluateRules, seriesSource } = require('../../scripts/lib/trading/rules');
const { loadStrategies, validateStrategy } = require('../../scripts/lib/trading/strategies');
const { createEvaluator } = require('../../scripts/lib/trading/evaluator');
const { tmpDir } = require('../helpers');
const { crtSeries } = require('../../scripts/lib/trading/crt');
const { runEngine } = require('../../scripts/lib/backtest/engine');
const { spawnSync } = require('child_process');

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
 * The crt_1h example: C1, the 10:00 hour, ranges 21480-21540; at 11:12 C2 (the
 * 11:00 hour) sweeps to 21472.25, and the 11:18 bar closes at 21486.50, back
 * inside and above the five bars before it.
 */
function c1Rows() {
  const rows = [];
  for (let t = et(10, 0); t < et(11, 0); t += 180000) rows.push([t, 21510, 21515, 21505, 21510]);
  rows[2] = [et(10, 6), 21510, 21540, 21505, 21512]; // C1's high
  rows[10] = [et(10, 30), 21510, 21512, 21480, 21500]; // C1's low
  return rows;
}
const C2 = [
  [et(11, 0), 21490, 21486, 21484, 21485],
  [et(11, 3), 21485, 21486, 21483, 21484],
  [et(11, 6), 21484, 21485, 21482, 21483],
  [et(11, 9), 21483, 21484, 21481, 21482],
  [et(11, 12), 21482, 21483, 21472.25, 21476], // the sweep
  [et(11, 15), 21476, 21479, 21474, 21478],
  [et(11, 18), 21478, 21487, 21477, 21486.5], // the shift
];
const crtSweep = (extra = []) => mk([...c1Rows(), ...C2, ...extra]);
const ATR8 = n => new Array(n).fill(8);
const OPTS = { sweepBars: 10, shiftBars: 5, maxDepth: 0.5, minRangeAtr: 3, bufferAtr: 0.25, minRR: 2 };
const fires = (b, opts = {}, atr = ATR8(b.length)) => {
  const s = crtSeries(b, 60, atr, { ...OPTS, ...opts });
  return s.dir.map((d, i) => [i, d]).filter(([, d]) => d !== 0).map(([i, d]) => ({ at: new Date(b[i].t).toISOString(), dir: d, risk: s.risk[i], target: s.target[i], depth: s.depth[i] }));
};

test('CRT detector: a raid of the previous hour\'s low, reclaimed with a shift, fires once with its stop and target', () => {
  const b = crtSweep();
  // Stop: 21486.50 - 21472.25 + 0.25 x 8 = 16.25 (65 ticks). Target: C1's high 21540.00, 53.50 away (3.3R).
  assert.deepStrictEqual(fires(b), [{ at: new Date(et(11, 18)).toISOString(), dir: 1, risk: 16.25, target: 53.5, depth: 7.75 }]);
  // Once per candle: a second shift later in the same hour does not fire again.
  const again = crtSweep([[et(11, 21), 21486, 21488, 21470, 21471], [et(11, 24), 21471, 21474, 21470.5, 21473], [et(11, 27), 21473, 21495, 21472, 21494]]);
  assert.strictEqual(fires(again).length, 1);
  // Causal: the series up to a bar never changes when later bars arrive.
  const full = crtSeries(again, 60, ATR8(again.length), OPTS);
  for (let k = 20; k <= again.length; k += 1) assert.deepStrictEqual(crtSeries(again.slice(0, k), 60, ATR8(k), OPTS).dir, full.dir.slice(0, k));
});

test('CRT detector: no setup without a valid raid, room, or a fresh sweep', () => {
  const b = crtSweep();
  const at = t => b.findIndex(x => Date.parse(x.t) === t);
  const edit = (t, row) => mk(b.map(x => [Date.parse(x.t), x.o, x.h, x.l, x.c]).map(r => (r[0] === t ? row : r)));
  // Both sides taken (an outside hour): void.
  assert.deepStrictEqual(fires(edit(et(11, 3), [et(11, 3), 21485, 21545, 21483, 21484])), []);
  // Too deep: 40.00 past the low, over half the 60.00 range (acceptance, not a raid).
  assert.deepStrictEqual(fires(edit(et(11, 12), [et(11, 12), 21482, 21483, 21440, 21476])), []);
  // C1 too narrow: ATR 25 needs a 75-point range.
  assert.deepStrictEqual(fires(b, {}, new Array(b.length).fill(25)), []);
  // No room: 4R would need 65 points to C1's high; it is 53.50.
  assert.deepStrictEqual(fires(b, { minRR: 4 }), []);
  // Stale: with a 1-bar freshness limit, the sweep 2 bars back is too old.
  assert.deepStrictEqual(fires(b, { sweepBars: 1 }), []);
  // Not reclaimed yet / no shift: the bar before the shift does not fire.
  assert.deepStrictEqual(fires(mk(b.slice(0, at(et(11, 18))).map(x => [Date.parse(x.t), x.o, x.h, x.l, x.c]))), []);
});

test('CRT detector: a raid of the previous high is the mirror image (short)', () => {
  const M = 21510;
  const mirror = mk([...c1Rows(), ...C2].map(([t, o, h, l, c]) => [t, 2 * M - o, 2 * M - l, 2 * M - h, 2 * M - c]));
  assert.deepStrictEqual(fires(mirror), [{ at: new Date(et(11, 18)).toISOString(), dir: -1, risk: 16.25, target: 53.5, depth: 7.75 }]);
});

test('crt_1h: the strategy fires on the raid with crt_risk as its stop and the far side of C1 as its target', () => {
  const s = loadStrategies(ROOT, {}).strategies.find(x => x.name === 'crt_1h');
  assert.ok(s && s.valid, s && s.errors.join('; '));
  const b = crtSweep();
  const i = b.length - 1;
  const r = createEvaluator(b).at(s, i);
  assert.strictEqual(r.direction, 'long', JSON.stringify(r.rules));
  assert.strictEqual(r.candidate, true);
  const atr = seriesSource(b, {})('atr(20)')[i];
  assert.ok(Math.abs(r.stopDistance - (21486.5 - 21472.25 + 0.25 * atr)) < 1e-3);
  assert.strictEqual(r.targetDistance, 53.5);
  assert.deepStrictEqual([r.exit.targetR, r.exit.target, r.exit.maxBars], [null, 'crt_target(60)', 40]);
  assert.strictEqual(createEvaluator(b).at(s, i - 1).direction, null);
  const four = loadStrategies(ROOT, {}).strategies.find(x => x.name === 'crt_4h');
  assert.ok(four.valid, four.errors.join('; '));
  assert.strictEqual(createEvaluator(b).at(four, i).direction, null, 'no complete previous 4-hour candle in the data');
});

test('backtest: a CRT trade exits at the far side of the range (exit.target is a level), or by its time stop', () => {
  const s = loadStrategies(ROOT, {}).strategies.find(x => x.name === 'crt_1h');
  const warm = [];
  for (let t = et(10, 0) - 520 * 180000; t < et(10, 0); t += 180000) warm.push([t, 21510, 21512, 21508, 21510]);
  const up = [];
  for (let k = 1; k <= 8; k += 1) up.push([et(11, 18) + k * 180000, 21486 + 7 * (k - 1), 21486 + 7 * k, 21485 + 7 * (k - 1), 21486 + 7 * k]);
  const run = rows => runEngine([{ symbol: 'MNQ', bars: mk([...warm, ...c1Rows(), ...C2, ...rows]), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [s], { timeframe: 3, gate: false, fill: 'close', slippageTicks: 1 }).trades;
  const [t] = run(up);
  assert.strictEqual(t.strategy, 'crt_1h');
  assert.strictEqual(t.entry, 21486.75, 'the close plus one tick of slippage');
  assert.strictEqual(t.reason, 'target');
  assert.strictEqual(t.exit, 21540, 'C1\'s high, not entry + R');
  // Going nowhere: closed by the 40-bar time stop.
  const drift = [];
  for (let k = 1; k <= 45; k += 1) drift.push([et(11, 18) + k * 180000, 21490, 21492, 21488, 21490]);
  const [d] = run(drift);
  assert.strictEqual(d.reason, 'max_bars');
});

test('exit.target validation: a distance expression or a long/short map, never with target_r', () => {
  const base = {
    name: 'x', description: 'a test strategy with a target at a level, not an R multiple', version: 1, status: 'paper',
    instruments: ['MNQ'], timeframe: '3m', signal: 'rules', rules: { long: ['close > open'] }, risk: { stop: 'atr:1', min_rr: 2 }, source: 'test',
  };
  const body = '## When to Use\n## How It Works\n## Examples';
  const v = exit => validateStrategy({ ...base, exit }, body, 'x').join(' ');
  assert.strictEqual(v({ target: 'crt_target(60)' }), '');
  assert.strictEqual(v({ target: { long: 'htf_high(60) - close', short: 'close - htf_low(60)' }, max_bars: 10 }), '');
  assert.match(v({ target: 'crt_target(60)', target_r: 2 }), /target_r or target, not both/);
  assert.match(v({ target: 'banana' }), /exit.target/);
  assert.match(v({ target: { long: 'close' } }), /exactly long and short/);
  assert.match(v({ target: 3 }), /a distance expression/);
});

test('backtest CLI: an unknown flag is an error, not a silent run of every strategy', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backtest.js'), '--data', 'none.csv', '--symbol', 'MNQ', '--strategies', 'crt_1h'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown arguments: --strategies crt_1h/);
});

test('CRT detector explains every bar: the state and why it did or didn\'t fire', () => {
  const b = crtSweep();
  const s = crtSeries(b, 60, ATR8(b.length), OPTS);
  const at = t => b.findIndex(x => Date.parse(x.t) === t);
  assert.strictEqual(s.explain(at(et(10, 30))).reason, 'no_previous_candle');
  assert.strictEqual(s.explain(at(et(11, 0))).reason, 'no_sweep');
  const sweep = s.explain(at(et(11, 12)));
  assert.strictEqual(sweep.reason, 'not_reclaimed');
  assert.deepStrictEqual([sweep.side, sweep.extreme, sweep.depth, sweep.c1Low, sweep.c1High], ['long', 21472.25, 7.75, 21480, 21540]);
  assert.strictEqual(s.explain(at(et(11, 15))).reason, 'not_reclaimed');
  const fired = s.explain(at(et(11, 18)));
  assert.deepStrictEqual([fired.reason, fired.risk, fired.target, fired.shiftLevel, fired.barsSinceExtreme], ['fired', 16.25, 53.5, 21486, 2]);
  assert.match(fired.why, /sweep, reclaim, shift/);
  assert.strictEqual(s.explain(b.length), null);
  // Each blocking condition names itself.
  const reason = (opts, atr) => { const x = crtSeries(b, 60, atr || ATR8(b.length), { ...OPTS, ...opts }); return x.explain(b.length - 1).reason; };
  assert.strictEqual(reason({ minRR: 4 }), 'no_room');
  assert.strictEqual(reason({ sweepBars: 1 }), 'stale');
  assert.strictEqual(reason({}, new Array(b.length).fill(25)), 'range_too_small');
  assert.strictEqual(reason({ maxDepth: 0.1 }), 'too_deep');
  assert.strictEqual(reason({ shiftBars: 8 }), 'no_shift', 'the 8 bars before include the 10:57 bar at 21515');
  const after = crtSweep([[et(11, 21), 21486, 21488, 21484, 21487]]);
  assert.strictEqual(crtSeries(after, 60, ATR8(after.length), OPTS).explain(after.length - 1).reason, 'fired_this_candle');
});

test('CRT detector: a single bar that raids and reclaims with a shift fires (a wick soup); undefined options keep the defaults', () => {
  const rows = [...c1Rows(), ...C2.slice(0, 4), [et(11, 12), 21482, 21490, 21472.25, 21489]];
  const b = mk(rows);
  // Shift over the 4 bars before it (the 5th back is the 10:57 bar, high 21515).
  assert.deepStrictEqual(fires(b, { shiftBars: 4 }).map(x => [x.at, x.dir, x.risk]), [[new Date(et(11, 12)).toISOString(), 1, 18.75]]);
  const viaRules = seriesSource(crtSweep(), {})('crt_dir(60)');
  assert.ok(viaRules.includes(1), 'crt_dir(60) fires with no crt* params given');
});

test('htfCandles: a feed gap that skips a whole candle leaves no previous candle', () => {
  const rows = [...flat(et(9, 0), et(10, 0), 21500), ...flat(et(11, 0), et(11, 30), 21520)]; // the 10:00 hour is missing
  const h = htfCandles(mk(rows), 60);
  assert.ok(h.prevH.slice(20).every(Number.isNaN), 'the 09:00 hour is not the 11:00 hour\'s previous candle');
  // Across the 18:00 open, the last candle of the session before is the previous one.
  const overnight = mk([...flat(et(16, 0), et(17, 0), 21500), ...flat(et(18, 0), et(18, 30), 21520)]);
  const o = htfCandles(overnight, 60);
  assert.strictEqual(o.prevH[o.prevH.length - 1], 21502);
});

test('a policy strategy refuses exit.target (its trades exit by its trail)', () => {
  const p = loadStrategies(ROOT, {}).strategies.find(x => x.name === 'prop_portfolio_3m');
  const body = '## When to Use\n## How It Works\n## Examples';
  const { name, description, version, status, instruments, timeframe, signal, strategies, account, sizing, contracts, exit, risk, policy, source } = p;
  const data = { name, description, version, status, instruments, timeframe, signal, strategies, account, sizing, contracts, exit, risk, policy, source };
  assert.deepStrictEqual(validateStrategy(data, body, 'prop_portfolio_3m'), []);
  assert.match(validateStrategy({ ...data, exit: { ...exit, target: 'crt_target(60)' } }, body, 'prop_portfolio_3m').join(' '), /exit.target: not for a policy strategy/);
});

test('backtest: a fill already at or past the target level is not taken', () => {
  const s = loadStrategies(ROOT, {}).strategies.find(x => x.name === 'crt_1h');
  const warm = [];
  for (let t = et(10, 0) - 520 * 180000; t < et(10, 0); t += 180000) warm.push([t, 21510, 21512, 21508, 21510]);
  const trades = slip => runEngine([{ symbol: 'MNQ', bars: mk([...warm, ...c1Rows(), ...C2]), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [s], { timeframe: 3, gate: false, fill: 'close', slippageTicks: slip }).trades;
  assert.strictEqual(trades(1).length, 1);
  assert.strictEqual(trades(1)[0].setup.detail['crt(60)'].reason, 'fired', 'the trade carries the detector state that took it');
  assert.strictEqual(trades(400).length, 0, '400 ticks of slippage puts the fill past C1\'s high');
});

test('backtest --debug writes the strategy\'s verdict on every bar, and trades.jsonl the setups', () => {
  const { runBacktest } = require('../../scripts/lib/backtest/run');
  const dir = tmpDir();
  const data = path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv');
  const { runDir } = runBacktest({ symbols: ['MNQ'], timeframe: 3, data: { MNQ: data }, strategies: ['crt_1h'], gate: false, window: 200, debug: 'crt_1h', outDir: dir }, { root: ROOT, outRoot: dir });
  const lines = fs.readFileSync(path.join(runDir, 'decisions-crt_1h.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(lines.length, 1499);
  assert.ok(lines.every(l => l.name === 'crt_1h' && l.t && l.detail && l.detail['crt(60)'].reason));
  assert.ok(lines.slice(0, 199).every(l => /trades from bar 199/.test(l.warmup)) && !lines[199].warmup, 'bars before the window are marked');
  const fired = lines.filter(l => l.detail['crt(60)'].reason === 'fired');
  assert.ok(fired.length >= 1);
  const trades = fs.readFileSync(path.join(runDir, 'trades.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(trades.length >= 1 && trades.every(t => t.setup && t.setup.detail['crt(60)'].reason === 'fired' && t.target !== null));
  assert.throws(() => runBacktest({ symbols: ['MNQ'], timeframe: 3, data: { MNQ: data }, strategies: ['crt_1h'], gate: false, debug: 'orb', outDir: dir }, { root: ROOT, outRoot: dir }), /debug: orb is not among the strategies/);
});
