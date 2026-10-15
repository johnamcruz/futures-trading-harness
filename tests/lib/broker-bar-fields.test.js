'use strict';

/**
 * Fields a broker puts on its bars, end to end in the harness: strategies that read them with field()
 * (test fixtures holding the rules of the retired order-flow strategies, which name the broker's flow
 * fields: fx_ofi, fx_ofi_absorption, fx_value_area), the evaluator, the backtester's bar files, and
 * a backtest. The harness gives the fields no meaning; a bar without them gives no signal.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { createEvaluator } = require('../../scripts/lib/trading/evaluator');
const { loadBars, aggregate } = require('../../scripts/lib/backtest/data');
const { runBacktest } = require('../../scripts/lib/backtest/run');
const { tmpDir, rootWithPolicies, FX_GOLDEN } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
// The retired strategies' rules as fixtures (tests/fixtures/strategies-golden); fx_orb among them reads no broker field.
const FX_ENV = { ...process.env, FTH_STRATEGIES_DIRS: FX_GOLDEN };
const STRATS = Object.fromEntries(loadStrategies(ROOT, { FTH_STRATEGIES_DIRS: FX_GOLDEN }).strategies.map(s => [s.name, s]));
const T0 = Date.UTC(2026, 9, 7, 14, 0); // 10:00 ET
const M = 60000;

/** The broker's flow on a bar: the bar's imbalance and its 3- and 5-bar windows (as the fx_ofi fixture names them). */
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

test('field() reads the broker\'s flow fields: a strategy on them (fx_ofi) fires both ways, and never without them', () => {
  const buying = series(1, (k, burst) => flow(burst ? 0.6 : 0));
  const f = fires(STRATS.fx_ofi, buying);
  assert.ok(f.length >= 1, 'fires on the burst');
  assert.ok(f.every(x => x.i >= 70 && x.r.direction === 'long'), JSON.stringify(f.map(x => [x.i, x.r.direction])));
  const selling = series(-1, (k, burst) => flow(burst ? -0.6 : 0));
  assert.ok(fires(STRATS.fx_ofi, selling).some(x => x.r.direction === 'short'));

  // The same prices: no flow on the bars (the broker's flow off), flow not complete (nulls), flow against the move.
  assert.deepStrictEqual(fires(STRATS.fx_ofi, series(1, () => null)), [], 'no fields: no signal, no estimate');
  assert.deepStrictEqual(fires(STRATS.fx_ofi, series(1, (k, burst) => flow(burst ? null : 0))), [], 'null fields: no signal');
  assert.deepStrictEqual(fires(STRATS.fx_ofi, series(1, (k, burst) => flow(burst ? 0.6 : 0, 0.6, null))), [], 'one window null: no signal');
  assert.deepStrictEqual(fires(STRATS.fx_ofi, series(1, (k, burst) => flow(burst ? -0.6 : 0))), [], 'selling flow under a rising price');
  // The nested windows are read where the rules say: a weak 5-bar window stops it.
  assert.deepStrictEqual(fires(STRATS.fx_ofi, series(1, (k, burst) => flow(burst ? 0.6 : 0, 0.6, 0.1))), []);
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
  const run = (strategies, logs = []) => runBacktest({ symbols: ['MNQ'], timeframe: 3, feesPerSide: 0.37, data: { MNQ: file }, strategies, gate: false, window: 160, outDir: dir }, { root: ROOT, outRoot: dir, env: FX_ENV, log: m => logs.push(m) });
  assert.throws(() => run(['fx_value_area', 'fx_orb']), /one\.json: its 1-minute bars carry the broker's own fields \(flow\), which the harness can't combine into 3-minute bars, and fx_value_area reads broker fields: fetch 3-minute bars from the broker instead \(backtest\.js fetch --contract <symbol> --timeframe 3/);
  const logs = [];
  run(['fx_orb'], logs);
  assert.ok(logs.some(l => /^warning: .*one\.json: building 3-minute bars from 1-minute ones drops the broker's own fields \(flow\): no strategy here reads them/.test(l)), logs.join('\n'));
});

test('a backtest on the broker\'s 1-minute bars trades from their flow fields, and nothing without them', () => {
  const dir = tmpDir();
  // fx_ofi_absorption (a reversal setup, so no higher-timeframe history is needed): heavy selling that holds, then a turn up.
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
    return runBacktest({ symbols: ['MNQ'], timeframe: 1, feesPerSide: 0.37, data: { MNQ: file }, strategies: ['fx_ofi_absorption'], gate: false, window: 160, outDir: dir }, { root: ROOT, outRoot: dir, env: FX_ENV }).report;
  };
  const withFlow = run('with', absorbed(true));
  assert.ok(withFlow.summary.trades >= 1 && withFlow.trades.every(t => t.strategy === 'fx_ofi_absorption' && t.direction === 'long'), JSON.stringify(withFlow.summary));
  assert.strictEqual(run('without', absorbed(false)).summary.trades, 0);
});

test('a policy on finer bars with broker fields: a paper strategy the policy leaves out reads them, and nothing is refused', () => {
  // Through the two-layer evaluator's run (prop/evaluate-run.js), which builds the policy's bars with barsAt.
  const { runEvaluation } = require('../../scripts/lib/prop/evaluate-run');
  const dir = tmpDir();
  // va_paper: a paper copy of fx_value_area (it reads the broker's flow), listed by an active policy with fx_orb.
  const strategies = path.join(dir, 'strategies');
  const write = (name, text) => { fs.mkdirSync(path.join(strategies, name), { recursive: true }); fs.writeFileSync(path.join(strategies, name, 'STRATEGY.md'), text); };
  write('va_paper', fs.readFileSync(path.join(FX_GOLDEN, 'fx_value_area', 'STRATEGY.md'), 'utf8').replace(/^name: fx_value_area$/m, 'name: va_paper').replace(/^status: active\b.*$/m, 'status: paper'));
  write('prop_mixed', fs.readFileSync(path.join(ROOT, 'strategies', 'prop_portfolio', 'STRATEGY.md'), 'utf8').replace(/^name: prop_portfolio$/m, 'name: prop_mixed').replace(/^strategies: .*$/m, 'strategies: [va_paper, fx_orb]'));
  const file = path.join(dir, 'one.json');
  // 1-minute bars in Train (the evaluator runs Train windows freely), from 10:00 ET on Wednesday 2022-10-05.
  const T1 = Date.UTC(2022, 9, 5, 14, 0);
  const bars = [];
  for (let k = 0; k < 3 * 1500; k += 1) bars.push({ t: new Date(T1 + k * M).toISOString(), o: 20000, h: 20001, l: 19999, c: 20000 + (k % 2 ? 0.25 : 0), v: 100, flow: { ofiTrade: 0.1 } });
  fs.writeFileSync(file, JSON.stringify({ bars }));
  const env = { ...process.env, FTH_STRATEGIES_DIRS: `${strategies},${FX_GOLDEN}` };
  // prop_mixed is listed in its account's rulebook (a plugin root with the accounts copied).
  const root = rootWithPolicies({ prop_mixed: fs.readFileSync(path.join(ROOT, 'strategies', 'prop_portfolio', 'STRATEGY.md'), 'utf8').match(/^account: (\S+)/m)[1] });
  const logs = [];
  try {
    runEvaluation({ prop: 'prop_mixed', symbols: ['MNQ'], data: { MNQ: file }, from: '2022-10-06', to: '2022-10-08', gate: false, window: 160, facts: false, paths: 10, reps: 10 }, { root, env, log: m => logs.push(m) });
  } catch (err) {
    // The run may find no attempt in so short a span; it must not be the bar-fields refusal.
    assert.doesNotMatch(err.message, /carry the broker's own fields/);
  }
  assert.ok(logs.some(l => /^prop_mixed: leaves out va_paper/.test(l)), logs.join('\n'));
  assert.ok(logs.some(l => /building 3-minute bars from 1-minute ones drops the broker's own fields \(flow\): no strategy here reads them/.test(l)), logs.join('\n'));
});
