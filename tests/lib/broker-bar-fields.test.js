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
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const STRATS = Object.fromEntries(loadStrategies(ROOT, {}).strategies.map(s => [s.name, s]));
const T0 = Date.UTC(2026, 9, 7, 14, 0); // 10:00 ET
const M = 60000;

/** The broker's flow on a bar: the bar's imbalance and its 3- and 5-bar windows (as the ofi documents name them). */
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

test('ofi fires on the broker\'s flow fields, both ways, and never without them', () => {
  const buying = series(1, (k, burst) => flow(burst ? 0.6 : 0));
  const f = fires(STRATS.ofi, buying);
  assert.ok(f.length >= 1, 'fires on the burst');
  assert.ok(f.every(x => x.i >= 70 && x.r.direction === 'long'), JSON.stringify(f.map(x => [x.i, x.r.direction])));
  const selling = series(-1, (k, burst) => flow(burst ? -0.6 : 0));
  assert.ok(fires(STRATS.ofi, selling).some(x => x.r.direction === 'short'));

  // The same prices: no flow on the bars (the broker's flow off), flow not complete (nulls), flow against the move.
  assert.deepStrictEqual(fires(STRATS.ofi, series(1, () => null)), [], 'no fields: no signal, no estimate');
  assert.deepStrictEqual(fires(STRATS.ofi, series(1, (k, burst) => flow(burst ? null : 0))), [], 'null fields: no signal');
  assert.deepStrictEqual(fires(STRATS.ofi, series(1, (k, burst) => flow(burst ? 0.6 : 0, 0.6, null))), [], 'one window null: no signal');
  assert.deepStrictEqual(fires(STRATS.ofi, series(1, (k, burst) => flow(burst ? -0.6 : 0))), [], 'selling flow under a rising price');
  // The windows are read where the document says: a weak 5-bar window stops it.
  assert.deepStrictEqual(fires(STRATS.ofi, series(1, (k, burst) => flow(burst ? 0.6 : 0, 0.6, 0.1))), []);
});

test('ofi_absorption fires when heavy selling in the broker\'s flow fails to move price and the last bar turns', () => {
  // 70 quiet bars, then 5 bars of selling on heavy volume that hold the price, the last one turning up.
  const bars = series(0, (k, burst) => flow(burst ? (k === 74 ? 0.4 : -0.5) : 0, 0, burst ? -0.4 : 0));
  bars[74] = { ...bars[74], c: bars[73].c + 0.5, h: bars[73].c + 1 };
  const f = fires(STRATS.ofi_absorption, bars);
  assert.deepStrictEqual(f.map(x => [x.i, x.r.direction]), [[74, 'long']]);
  const { flow: _f, ...plain } = bars[74];
  assert.deepStrictEqual(fires(STRATS.ofi_absorption, bars.slice(0, 74).concat([plain])), [], 'no fields on the turn bar: no signal');
});

test('ofi reads each window where its document says: distinct values, and one weak or flipped window stops it, both ways', () => {
  const fired = (dir, one, three, five) => fires(STRATS.ofi, series(dir, (k, burst) => flow(burst ? one : 0, burst ? three : 0, burst ? five : 0))).map(x => x.r.direction);
  // Long: one 0.6, three 0.5, five 0.4 all >= 0.3.
  assert.ok(fired(1, 0.6, 0.5, 0.4).includes('long'));
  assert.deepStrictEqual(fired(1, 0.6, 0.5, 0.2), [], 'a weak 5-bar window (the 3-bar one is strong)');
  assert.deepStrictEqual(fired(1, 0.6, 0.2, 0.4), [], 'a weak 3-bar window');
  assert.deepStrictEqual(fired(1, 0.2, 0.5, 0.4), [], 'a weak 1-bar imbalance');
  // Short: the mirror.
  assert.ok(fired(-1, -0.6, -0.5, -0.4).includes('short'));
  assert.deepStrictEqual(fired(-1, -0.6, -0.5, -0.2), [], 'a weak 5-bar window');
  assert.deepStrictEqual(fired(-1, -0.6, -0.2, -0.4), [], 'a weak 3-bar window');
  assert.deepStrictEqual(fired(-1, -0.2, -0.5, -0.4), [], 'a weak 1-bar imbalance');
  assert.deepStrictEqual(fired(-1, -0.6, -0.5, 0.4), [], 'a flipped 5-bar window');
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
  // Bars built from shorter ones: only the broker knows what its fields mean over a longer bar.
  const five = aggregate(loaded, { unit: 2, unitNumber: 5, nowMs: T0 + 75 * M });
  assert.ok(five.length > 0 && five.every(b => !('flow' in b)));
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
