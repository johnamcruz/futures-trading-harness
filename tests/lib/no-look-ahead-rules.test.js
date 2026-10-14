'use strict';

// No look-ahead in what a decision reads (part of the no-look-ahead suite, tests/e2e/no-look-ahead.test.js):
//   - every rules series (each name and function, and field() at every look-back) at bar t is the
//     same whether or not bars after t exist: the real ones that followed, or an adversarial one;
//   - every rules strategy's evaluation at bar t (direction, filters, stop, target, the trend rule,
//     regime, detail) is unchanged by bars after t (the shipped tree has none since 2026-10-14: the
//     fixtures that hold the retired strategies' rules, tests/fixtures/strategies-*);
//   - the backtest engine (fill: next-open, the default) fills an entry decided at bar t at bar t+1's
//     open plus its slippage, never sooner, and the entries it makes through bar T are the same
//     with or without the bars after T;
//   - the labels' decision inputs (the stop's ATR) read only bars closed by the decision time; the
//     outcome may look ahead (it is what came after), and the counterfactual fills at the next bar.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { normalizeBars } = require('../../scripts/lib/trading/indicators');
const rules = require('../../scripts/lib/trading/rules');
const { PARAMS } = require('../../scripts/lib/trading/market-snapshot');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { createEvaluator } = require('../../scripts/lib/trading/evaluator');
const { runEngine } = require('../../scripts/lib/backtest/engine');
const { atrAt } = require('../../scripts/lib/replay/labels');
const { simulate } = require('../../scripts/lib/replay/counterfactual');
const { FX_STRATEGIES, FX_PARITY, FX_GOLDEN } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
// Every fixture rules strategy: the rules of the retired strategies (opening range, CISD, CRT, volume profile, VWAP,
// the broker's flow, swing breaks, EMA crosses, Keltner, SuperTrend), so every detector and series a rule reads is judged.
const FX_ALL = { FTH_STRATEGIES_DIRS: [FX_STRATEGIES, FX_PARITY, FX_GOLDEN].join(',') };
// Broker fields on every bar (as an order-flow server puts them), deterministic, so field() has values to read.
const withFields = bars => bars.map((b, i) => ({ ...b, flow: { x: Math.sin(i / 3), windows: { 3: { x: Math.cos(i / 5) }, 5: { x: Math.sin(i / 7) } } } }));
const BARS = withFields(normalizeBars(readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'))));
const STEP = 180000;
// Decision bars across the file: the overnight, the RTH open, the day's middle, the next day.
const CUTS = [];
for (let t = 60; t < BARS.length - 2; t += 41) CUTS.push(t);

/** An adversarial bar right after t: a spike every way (range, volume, every field), the step after it. */
function spike(prev) {
  const ms = Date.parse(prev.t) + STEP;
  return { t: new Date(ms).toISOString(), o: prev.c, h: prev.c * 1.2, l: prev.c * 0.8, c: prev.c * 1.15, v: prev.v * 1000 + 1, flow: { x: 99, windows: { 3: { x: -99 }, 5: { x: 99 } } } };
}

/** The futures a decision at bar t must not see: the real bars after it, or one adversarial bar. */
const futures = t => [BARS, [...BARS.slice(0, t + 1), spike(BARS[t])], [...BARS.slice(0, t + 1), spike(BARS[t]), spike(spike(BARS[t]))]];

const same = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || Object.is(a, b) || (a === null && b === null) || (a === undefined && b === undefined);

// Every series a rule can name: each name, each function at a few lengths (higher timeframes at 60 and
// 240 minutes), and field() paths (one-level, nested, a digit key) at look-backs 0 to 500.
const SERIES = [
  ...rules.NAMES,
  ...[...rules.FUNCS].flatMap(f => (rules.HTFD_REL[f] ? [`${f}(15,prior_high)`, `${f}(60,vwap_session)`, `${f}(3,previous_low)`]
    : /^htfd_/.test(f) ? [`${f}(3)`, `${f}(15)`, `${f}(60)`]
      : /^(htf|htfc|crt|mtf)/.test(f) ? [`${f}(60)`, `${f}(240)`]
      // The CISD series on completed 3m, 15m and 60m candles (cisd.js).
        : /^(cisd|ote|in_ote)/.test(f) ? [`${f}(3)`, `${f}(15)`, `${f}(60)`] : [`${f}(5)`, `${f}(20)`])),
  'field:flow.x', 'field:flow.windows.3.x', 'field:flow.windows.5.x',
];
const LOOKBACKS = [0, 1, 2, 3, 5, 20, 500];

test('every rules series at bar t (every name, function and field()) is unchanged by the bars after t', () => {
  const params = { ...PARAMS };
  const bad = [];
  for (const t of CUTS) {
    const now = rules.seriesSource(BARS.slice(0, t + 1), params, { barMinutes: 3 });
    for (const future of futures(t)) {
      const later = rules.seriesSource(future, params, { barMinutes: 3 });
      for (const key of SERIES) {
        const a = now(key);
        const b = later(key);
        // Every value up to t (a look-back [n] reads t - n): the same with the future as without it.
        for (let j = 0; j <= t; j += 1) {
          if (!same(a[j], b[j])) { bad.push(`${key} at bar ${j} (decided at ${t}): ${a[j]} without the future, ${b[j]} with it`); break; }
        }
      }
    }
  }
  assert.deepStrictEqual(bad, []);
  // The completed-candle series have values here (the bar size given): the check above is not on empty series.
  const all = rules.seriesSource(BARS, params, { barMinutes: 3 });
  for (const key of SERIES.filter(k => /^htfd_/.test(k) && !/next_swing|\(3,previous_low\)/.test(k))) {
    assert.ok(all(key).some(Number.isFinite), `${key} has values`);
  }
});

test('field() at every look-back reads bar t - n, never a later bar, and a missing look-back has no value', () => {
  for (const n of LOOKBACKS) {
    const [term] = rules.compileExpression(n ? `field("flow.windows.3.x")[${n}]` : 'field("flow.windows.3.x")');
    for (const t of CUTS) {
      for (const future of futures(t)) {
        const get = rules.seriesSource(future, PARAMS);
        const want = t - n >= 0 ? BARS[t - n].flow.windows[3].x : null;
        assert.strictEqual(rules.valueAt([term], get, t), want, `[${n}] at ${t}`);
      }
    }
  }
  // A whole rule on field() look-backs: the verdict at t is the same with and without the future.
  const compiled = rules.compileRules({ long: ['field("flow.x") > field("flow.x")[1]', 'field("flow.windows.5.x")[2] > 0'], short: ['field("flow.x") < field("flow.x")[3]'] }).compiled;
  for (const t of CUTS) {
    const want = rules.evaluateRules(compiled, BARS.slice(0, t + 1), PARAMS, { index: t });
    for (const future of futures(t)) assert.deepStrictEqual(rules.evaluateRules(compiled, future, PARAMS, { index: t }), want, `rule at ${t}`);
  }
});

test('every rules strategy\'s evaluation at bar t is unchanged by the bars after t', () => {
  const { strategies } = loadStrategies(ROOT, FX_ALL);
  const judged = strategies.filter(s => s.valid && s.signal !== 'policy');
  assert.ok(judged.length >= 14 && ['fx_ofi', 'fx_crt_1h', 'fx_cisd_ote', 'fx_value_area', 'fx_orb'].every(n => judged.some(s => s.name === n)), `the rules strategies: ${judged.map(s => s.name)}`);
  let fired = 0;
  for (const t of CUTS) {
    // Fresh evaluators judging in the same order: a detector one strategy ran is in the next one's detail on both.
    const now = createEvaluator(BARS.slice(0, t + 1));
    const want = judged.map(s => now.at(s, t, { describe: true }));
    fired += want.filter(r => r.direction).length;
    for (const future of futures(t)) {
      const later = createEvaluator(future);
      judged.forEach((s, k) => assert.deepStrictEqual(later.at(s, t, { describe: true }), want[k], `${s.name} at bar ${t} (${BARS[t].t})`));
    }
  }
  assert.ok(fired > 0, 'some strategy fired at a decision bar: the property covers fired setups too');
});

/** One market of the fixture's bars for the engine (each bar with its open time in ms). */
const market = bars => [{ symbol: 'MNQ', bars, tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }];

test('the backtest engine fills an entry decided at bar t at bar t+1\'s open plus slippage (fill: next-open, the default), never sooner', () => {
  const { strategies } = loadStrategies(ROOT, FX_ALL);
  const rulesStrategies = strategies.filter(s => s.valid && s.signal === 'rules' && s.timeframe === '3m');
  const { trades } = runEngine(market(BARS), rulesStrategies, { timeframe: 3, gate: false });
  assert.ok(trades.length >= 3, `trades to check: ${trades.length}`);
  const byT = new Map(BARS.map((b, i) => [b.t, i]));
  for (const tr of trades) {
    const i = byT.get(tr.setup.signalBar);
    assert.ok(i !== undefined, tr.setup.signalBar);
    const fillBar = BARS[i + 1];
    assert.strictEqual(tr.entryTime, fillBar.t, 'filled at the next bar');
    assert.ok(Date.parse(tr.entryTime) >= Date.parse(BARS[i].t) + STEP, 'no sooner than the signal bar\'s close');
    const sign = tr.direction === 'long' ? 1 : -1;
    assert.strictEqual(tr.entry, Math.round((fillBar.o + sign * 0.25) / 0.25) * 0.25, 'at that bar\'s open plus one tick against');
  }
});

test('the backtest engine\'s entries through bar T are the same with or without the bars after T', () => {
  // Every fixture 3m rules strategy (fx_cisd_ote, paper, included), so the file has entries before each cut whichever
  // strategies fire in it.
  const { strategies } = loadStrategies(ROOT, FX_ALL);
  const rulesStrategies = strategies.filter(s => s.valid && s.signal === 'rules' && s.timeframe === '3m');
  const entries = (bars, last) => runEngine(market(bars), rulesStrategies, { timeframe: 3, gate: false }).trades
    .filter(tr => Date.parse(tr.entryTime) <= Date.parse(last))
    .map(tr => [tr.strategy, tr.direction, tr.setup.signalBar, tr.entryTime, tr.entry, tr.initialStop]);
  const full = BARS.map(b => ({ ...b }));
  for (const T of [BARS.length - 400, BARS.length - 150]) {
    const last = BARS[T].t;
    const want = entries(full, last);
    assert.ok(want.length > 0, `entries before bar ${T}`);
    assert.deepStrictEqual(entries(BARS.slice(0, T + 1), last), want, `through ${last}`);
    assert.deepStrictEqual(entries([...BARS.slice(0, T + 1), spike(BARS[T])], last), want, `through ${last}, a spike after`);
  }
});

test('labels: the stop\'s ATR at a decision reads only bars closed by it; the counterfactual fills at the next bar\'s open', () => {
  const bars = BARS.map(b => ({ ...b, ms: Date.parse(b.t) }));
  for (const t of CUTS.filter(x => x > 30)) {
    const at = bars[t].ms + STEP + 2000; // the decision time: the bar's close, polled 2 s later
    const want = atrAt(bars.slice(0, t + 1), STEP, at);
    assert.ok(want > 0);
    // The bars after it (the real ones, or a spike) don't move it; the bar forming at the decision isn't read either.
    assert.strictEqual(atrAt(bars, STEP, at), want);
    const sp = spike(bars[t]);
    assert.strictEqual(atrAt([...bars.slice(0, t + 1), { ...sp, ms: Date.parse(sp.t) }], STEP, at), want);
    assert.strictEqual(atrAt(bars, STEP, bars[t + 1].ms + STEP - 1), want, 'one ms before the next bar closes: still bar t\'s');
  }
  // The counterfactual's entry: the next bar's open after the signal bar, plus a tick.
  const i = 700;
  const bars0 = bars.map(b => ({ ...b }));
  const strategy = loadStrategies(ROOT, FX_ALL).strategies.find(s => s.name === 'fx_orb');
  const r = simulate({ bars: bars0, tfMs: STEP, signalMs: bars0[i].ms, signalClose: bars0[i].c, direction: 'long', stopDistance: 20, targetDistance: null, strategy, spec: { tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }, eodMs: Infinity });
  assert.strictEqual(r.simulated, true, JSON.stringify(r));
  assert.strictEqual(r.entry, Math.round((bars0[i + 1].o + 0.25) / 0.25) * 0.25, JSON.stringify(r));
});
