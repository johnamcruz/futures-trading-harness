'use strict';

/**
 * Fields a broker puts on its bars, end to end in the harness: the strategy documents that read them
 * with field() (the order-flow ones name the broker's flow fields), the evaluator, the backtester's
 * bar files, and a backtest. The harness gives the fields no meaning; a bar without them gives no signal.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { createEvaluator } = require('../../scripts/lib/trading/evaluator');
const { loadBars, aggregate } = require('../../scripts/lib/backtest/data');
const { runBacktest } = require('../../scripts/lib/backtest/run');
const { tmpDir, FX_STRATEGIES } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const STRATS = Object.fromEntries(loadStrategies(ROOT, {}).strategies.map(s => [s.name, s]));
const T0 = Date.UTC(2026, 9, 7, 14, 0); // 10:00 ET
const M = 60000;

/** The broker's flow on a bar: the bar's imbalance and its 3- and 5-bar windows (as the flow strategy documents name them). */
const flow = (one, three = one, five = one) => ({ flow: { ofiTrade: one, complete: one !== null, windows: { 3: { ofiTrade: three }, 5: { ofiTrade: five } } } });

/**
 * 1-minute bars: `quiet` bars on 100 contracts (70 by default), then 5 bars that move `dir` 2 points each on 400
 * contracts. `flowOf(k)` gives bar k's broker fields (or none).
 */
function series(dir, flowOf, quiet = 70) {
  const out = [];
  let c = 20000;
  for (let k = 0; k < quiet + 5; k += 1) {
    const burst = k >= quiet;
    const o = c;
    c = burst ? c + 2 * dir : c + (k % 2 ? 0.25 : -0.25);
    out.push({ t: new Date(T0 + k * M).toISOString(), o, h: Math.max(o, c) + 0.5, l: Math.min(o, c) - 0.5, c, v: burst ? 400 : 100, ...(flowOf(k, burst) || {}) });
  }
  return out;
}

const fires = (s, bars) => {
  const ev = createEvaluator(bars);
  return bars.map((b, i) => ({ i, r: ev.at(s, i, { describe: false }) })).filter(x => x.r.direction);
};

test('ofi_absorption fires when heavy selling in the broker\'s flow fails to move price and the last bar turns', () => {
  // 70 quiet bars, then 5 bars of selling on heavy volume that hold the price, the last one turning up.
  const bars = series(0, (k, burst) => flow(burst ? (k === 74 ? 0.4 : -0.5) : 0, 0, burst ? -0.4 : 0));
  bars[74] = { ...bars[74], c: bars[73].c + 0.5, h: bars[73].c + 1 };
  const f = fires(STRATS.ofi_absorption, bars);
  assert.deepStrictEqual(f.map(x => [x.i, x.r.direction]), [[74, 'long']]);
  const { flow: _f, ...plain } = bars[74];
  assert.deepStrictEqual(fires(STRATS.ofi_absorption, bars.slice(0, 74).concat([plain])), [], 'no fields on the turn bar: no signal');
  // The same prices with the 5-bar window null (a bar in it incomplete), or with no flow at all: no signal, no estimate.
  const nullWindow = series(0, (k, burst) => flow(burst ? (k === 74 ? 0.4 : -0.5) : 0, 0, burst ? null : 0));
  nullWindow[74] = { ...nullWindow[74], c: nullWindow[73].c + 0.5, h: nullWindow[73].c + 1 };
  assert.deepStrictEqual(fires(STRATS.ofi_absorption, nullWindow), [], 'one window null: no signal');
  const none = series(0, () => null);
  none[74] = { ...none[74], c: none[73].c + 0.5, h: none[73].c + 1 };
  assert.deepStrictEqual(fires(STRATS.ofi_absorption, none), [], 'no fields: no signal');
});

test('ofi_absorption short: heavy buying that fails to lift price, then a bar that turns down; each flow condition counts', () => {
  // Five bars of buying on heavy volume that hold the price; the last one turns down. one: the 1-bar imbalance of the
  // turn bar; five: the 5-bar window; the other burst bars buy at 0.5.
  const absorbedShort = (one, five) => {
    const bars = series(0, (k, burst) => flow(burst ? (k === 74 ? one : 0.5) : 0, 0.3, burst ? five : 0));
    bars[74] = { ...bars[74], c: bars[73].c - 0.5, l: bars[73].c - 1 };
    return fires(STRATS.ofi_absorption, bars).map(x => [x.i, x.r.direction]);
  };
  assert.deepStrictEqual(absorbedShort(-0.4, 0.35), [[74, 'short']]);
  assert.deepStrictEqual(absorbedShort(0.4, 0.35), [], 'the turn bar still buys (1-bar imbalance > 0)');
  assert.deepStrictEqual(absorbedShort(-0.4, 0), [], 'no buying over 5 bars to absorb (window 5 under 0.25)');
  assert.deepStrictEqual(absorbedShort(-0.4, 0.2), [], 'window 5 just under 0.25');
  // Long: the 5-bar window must be selling.
  const bars = series(0, (k, burst) => flow(burst ? (k === 74 ? 0.4 : -0.5) : 0, 0, burst ? -0.1 : 0));
  bars[74] = { ...bars[74], c: bars[73].c + 0.5, h: bars[73].c + 1 };
  assert.deepStrictEqual(fires(STRATS.ofi_absorption, bars), [], 'window 5 at -0.1 is not heavy selling');
  // Long: the turn bar must buy (1-bar imbalance > 0); -0.1 is still selling.
  const still = series(0, (k, burst) => flow(burst ? (k === 74 ? -0.1 : -0.5) : 0, 0, burst ? -0.4 : 0));
  still[74] = { ...still[74], c: still[73].c + 0.5, h: still[73].c + 1 };
  assert.deepStrictEqual(fires(STRATS.ofi_absorption, still), [], 'the turn bar still sells');
});

test('backtest bar files: a JSON file of the broker\'s bars keeps their fields; CSV and built bars carry none', () => {
  const dir = tmpDir();
  const json = path.join(dir, 'b.json');
  const bars = series(1, (k, burst) => flow(burst ? 0.6 : 0));
  fs.writeFileSync(json, JSON.stringify({ bars }));
  const loaded = loadBars(json);
  assert.deepStrictEqual(loaded[72].flow, bars[72].flow);
  // A CSV column of the old buy/sell kind is just an unknown column now.
  const csv = path.join(dir, 'b.csv');
  fs.writeFileSync(csv, `time,open,high,low,close,volume,buy_volume,sell_volume\n${bars.map(b => [b.t, b.o, b.h, b.l, b.c, b.v, 300, 100].join(',')).join('\n')}\n`);
  assert.deepStrictEqual(Object.keys(loadBars(csv)[0]).sort(), ['c', 'h', 'l', 'ms', 'o', 't', 'v']);
  // Bars built from shorter ones: only the broker knows what its fields mean over a longer bar. Never dropped
  // silently: refused, unless the caller says it drops them.
  assert.throws(() => aggregate(loaded, { unit: 2, unitNumber: 5, nowMs: T0 + 75 * M }), /carry the broker's own fields \(flow\), which the harness can't combine into longer bars: fetch bars at the timeframe you need from the broker instead/);
  const five = aggregate(loaded, { unit: 2, unitNumber: 5, nowMs: T0 + 75 * M, extraFields: 'drop' });
  assert.ok(five.length > 0 && five.every(b => !('flow' in b)));
  assert.strictEqual(aggregate(loadBars(csv), { unit: 2, unitNumber: 5, nowMs: T0 + 75 * M }).length, five.length, 'plain bars aggregate as before');
});

test('JSON lines bar files: one bar a line, every nested field kept; a bad line is refused without echoing it', () => {
  const dir = tmpDir();
  const bars = series(1, (k, burst) => flow(burst ? 0.6 : 0));
  const file = path.join(dir, 'b.jsonl');
  fs.writeFileSync(file, `\ufeff${bars.map(b => JSON.stringify(b)).join('\n')}\n\n`);
  const loaded = loadBars(file);
  assert.strictEqual(loaded.length, bars.length);
  assert.deepStrictEqual(loaded[72].flow, bars[72].flow);
  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(bad, `${JSON.stringify(bars[0])}\nSECRET=hunter2\n`);
  assert.throws(() => loadBars(bad), err => /bad\.jsonl: line 2: not valid JSON/.test(err.message) && !/hunter2/.test(err.message));
});

test('a backtest on finer bars that carry broker fields: refused when a strategy reads broker fields, built with a warning when none does', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'one.json');
  // 1-minute bars with the broker's flow, for a 3-minute run.
  const bars = [];
  for (let k = 0; k < 600; k += 1) bars.push({ t: new Date(T0 + k * M).toISOString(), o: 20000, h: 20001, l: 19999, c: 20000 + (k % 2 ? 0.25 : 0), v: 100, flow: { ofiTrade: 0.1 } });
  fs.writeFileSync(file, JSON.stringify({ bars }));
  const run = (strategies, logs = []) => runBacktest({ symbols: ['MNQ'], timeframe: 3, data: { MNQ: file }, strategies, gate: false, window: 160, outDir: dir }, { root: ROOT, outRoot: dir, env: { FTH_STRATEGIES_DIRS: FX_STRATEGIES }, log: m => logs.push(m) });
  assert.throws(() => run(['value_area', 'fx_break']), /one\.json: its 1-minute bars carry the broker's own fields \(flow\), which the harness can't combine into 3-minute bars, and value_area reads broker fields: fetch 3-minute bars from the broker instead \(backtest\.js fetch --contract <symbol> --timeframe 3/);
  const logs = [];
  run(['fx_break'], logs);
  assert.ok(logs.some(l => /^warning: .*one\.json: building 3-minute bars from 1-minute ones drops the broker's own fields \(flow\): no strategy here reads them/.test(l)), logs.join('\n'));
});

test('a backtest on the broker\'s 1-minute bars trades from their flow fields, and nothing without them', () => {
  const dir = tmpDir();
  // ofi_absorption (a reversal setup, so no higher-timeframe history is needed): heavy selling that holds, then a turn up.
  const absorbed = withFlow => {
    const bars = series(0, (k, burst) => (withFlow ? flow(burst ? (k === 204 ? 0.4 : -0.5) : 0, 0, burst ? -0.4 : 0) : null), 200);
    bars[204] = { ...bars[204], c: bars[203].c + 0.5, h: bars[203].c + 1 };
    // Bars after the setup, to fill the entry and run the trade.
    for (let k = 205; k < 240; k += 1) { const c = bars[204].c + (k - 204) * 0.5; bars.push({ t: new Date(T0 + k * M).toISOString(), o: c - 0.5, h: c + 0.25, l: c - 0.75, c, v: 100 }); }
    return bars;
  };
  const run = (name, bars) => {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ bars }));
    return runBacktest({ symbols: ['MNQ'], timeframe: 1, data: { MNQ: file }, strategies: ['ofi_absorption'], gate: false, window: 160, outDir: dir }, { root: ROOT, outRoot: dir }).report;
  };
  const withFlow = run('with', absorbed(true));
  assert.ok(withFlow.summary.trades >= 1 && withFlow.trades.every(t => t.strategy === 'ofi_absorption' && t.direction === 'long'), JSON.stringify(withFlow.summary));
  assert.strictEqual(run('without', absorbed(false)).summary.trades, 0);
});

test('a prop run on finer bars with broker fields: a paper strategy the policy leaves out reads them, and nothing is refused', () => {
  const dir = tmpDir();
  // va_paper: a paper copy of value_area (it reads the broker's flow), listed by an active policy with the fixture fx_break.
  const strategies = path.join(dir, 'strategies');
  const write = (name, text) => { fs.mkdirSync(path.join(strategies, name), { recursive: true }); fs.writeFileSync(path.join(strategies, name, 'STRATEGY.md'), text); };
  write('va_paper', fs.readFileSync(path.join(ROOT, 'strategies', 'value_area', 'STRATEGY.md'), 'utf8').replace(/^name: value_area$/m, 'name: va_paper').replace(/^status: active\b.*$/m, 'status: paper'));
  write('prop_mixed', fs.readFileSync(path.join(ROOT, 'strategies', 'prop_portfolio', 'STRATEGY.md'), 'utf8').replace(/^name: prop_portfolio$/m, 'name: prop_mixed').replace(/^strategies: .*$/m, 'strategies: [va_paper, fx_break]'));
  const file = path.join(dir, 'one.json');
  const bars = [];
  for (let k = 0; k < 3 * 1500; k += 1) bars.push({ t: new Date(T0 + k * M).toISOString(), o: 20000, h: 20001, l: 19999, c: 20000 + (k % 2 ? 0.25 : 0), v: 100, flow: { ofiTrade: 0.1 } });
  fs.writeFileSync(file, JSON.stringify({ bars }));
  const env = { ...process.env, FTH_STRATEGIES_DIRS: `${strategies},${FX_STRATEGIES}` };
  const run = (prop, logs) => runBacktest({ symbols: ['MNQ'], timeframe: 3, data: { MNQ: file }, prop, gate: false, outDir: path.join(dir, prop) }, { root: ROOT, outRoot: dir, env, log: m => logs.push(m) });
  const logs = [];
  try {
    run('prop_mixed', logs);
  } catch (err) {
    // The run may find no attempt in so short a span; it must not be the bar-fields refusal.
    assert.doesNotMatch(err.message, /carry the broker's own fields/);
  }
  assert.ok(logs.some(l => /^prop_mixed: leaves out va_paper/.test(l)), logs.join('\n'));
  assert.ok(logs.some(l => /building 3-minute bars from 1-minute ones drops the broker's own fields \(flow\): no strategy here reads them/.test(l)), logs.join('\n'));
});
