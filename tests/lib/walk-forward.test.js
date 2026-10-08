'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { combinations, gridErrors, withPoint, folds, runWalkForward, toMarkdown } = require('../../scripts/lib/backtest/walk-forward');
const { compileRules } = require('../../scripts/lib/trading/rules');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');

/** An EMA-cross rules strategy whose fast EMA length is a param. */
function strategy() {
  const rules = { long: ['ema(9) crosses_above ema(20)'], short: ['ema(9) crosses_below ema(20)'] };
  return {
    name: 'xover', valid: true, status: 'active', instruments: ['MNQ'], timeframe: '3m', signal: 'rules', mtf: 'reversal', rules,
    compiledRules: compileRules(rules).compiled, params: { atrStop: 20 }, risk: { stop: 'atr:1', min_rr: 2 }, exit: { target_r: 2 },
  };
}

/** About four months of 3-minute bars: waves on a drift, enough to trade. */
function bars(months = 4) {
  const n = Math.floor((months * 30 * 24 * 60) / 3);
  const t0 = Date.UTC(2025, 0, 1);
  return Array.from({ length: n }, (_, k) => {
    const c = 20000 + 0.01 * k + 30 * Math.sin(k / 37) + 12 * Math.sin(k / 7);
    return { t: new Date(t0 + k * 180000).toISOString(), o: c, h: c + 3, l: c - 3, c, v: 10 };
  });
}

test('combinations, grid checks, and applying a grid point', () => {
  assert.deepStrictEqual(combinations({ a: [1, 2], 'exit.target_r': [2, 3] }), [
    { a: 1, 'exit.target_r': 2 }, { a: 1, 'exit.target_r': 3 }, { a: 2, 'exit.target_r': 2 }, { a: 2, 'exit.target_r': 3 },
  ]);
  const s = strategy();
  assert.deepStrictEqual(gridErrors({ atrStop: [14, 20], 'exit.target_r': [1.5, 2] }, s), []);
  assert.match(gridErrors({ nope: [1] }, s).join(), /grid\.nope: not a parameter of xover/);
  assert.match(gridErrors({ 'exit.bogus': [1] }, s).join(), /grid\.exit\.bogus/);
  assert.match(gridErrors({ atrStop: ['x'] }, s).join(), /a list of numbers/);
  assert.match(gridErrors({}, s).join(), /at least one key/);
  assert.match(gridErrors({ atrStop: Array.from({ length: 15 }, (_, i) => i + 1), orbMinutes: Array.from({ length: 15 }, (_, i) => i + 1) }, s).join(), /225 combinations/);
  const p = withPoint(s, { atrStop: 14, 'exit.target_r': 3 });
  assert.deepStrictEqual([p.params.atrStop, p.exit.target_r, s.params.atrStop, s.exit.target_r], [14, 3, 20, 2], 'a copy; the strategy is untouched');
});

test('folds: train then test, stepping by the test window, inside the data', () => {
  const f = folds(Date.UTC(2025, 0, 1), Date.UTC(2025, 4, 1), 2, 1);
  assert.deepStrictEqual(f.map(x => [x.trainStart, x.testStart, x.testEnd].map(t => new Date(t).toISOString().slice(0, 10))), [
    ['2025-01-01', '2025-03-01', '2025-04-01'],
    ['2025-02-01', '2025-04-01', '2025-05-01'],
  ]);
  assert.deepStrictEqual(folds(Date.UTC(2025, 0, 1), Date.UTC(2025, 1, 1), 2, 1), []);
});

test('runWalkForward: the in-sample winner is traded out of sample, next to the defaults; only out-of-sample trades count', () => {
  const markets = [{ symbol: 'MNQ', bars: bars(), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 }];
  const wf = runWalkForward(markets, strategy(), {
    grid: { 'exit.target_r': [1, 2, 3] }, trainMonths: 2, testMonths: 1, minTrades: 5,
    from: Date.UTC(2025, 0, 2), to: Date.UTC(2025, 4, 1), engine: { timeframe: 3, gate: false, window: 160 },
  });
  assert.strictEqual(wf.combinations, 3);
  assert.strictEqual(wf.folds.length, 2);
  for (const f of wf.folds) {
    assert.ok(f.chosen && [1, 2, 3].includes(f.chosen['exit.target_r']), JSON.stringify(f));
    assert.ok(f.inSample.trades >= 5);
  }
  // Every out-of-sample trade is inside a test window.
  const firstTest = Date.UTC(2025, 2, 2);
  assert.ok(wf.trades.length > 0 && wf.trades.every(t => Date.parse(t.entryTime) >= firstTest), 'no in-sample trade leaks into the result');
  assert.strictEqual(wf.outOfSample.trades, wf.folds.reduce((a, f) => a + f.outOfSample.trades, 0));
  assert.ok(wf.baseline.trades > 0);
  assert.match(wf.positiveFolds, /^\d of 2$/);
  const md = toMarkdown(wf);
  assert.match(md, /## Out of sample \(the number to trust\)/);
  assert.match(md, /3 tries per fold: the in-sample winner's edge is inflated by the search/);
  // Nothing qualifies: the fold says so and trades nothing.
  const none = runWalkForward(markets, strategy(), {
    grid: { 'exit.target_r': [2] }, trainMonths: 2, testMonths: 1, minTrades: 100000,
    from: Date.UTC(2025, 0, 2), to: Date.UTC(2025, 4, 1), engine: { timeframe: 3, gate: false, window: 160 },
  });
  assert.strictEqual(none.trades.length, 0);
  assert.match(none.folds[0].note, /no combination had 100000 trades in sample/);
  assert.throws(() => runWalkForward(markets, strategy(), { grid: { bad: [1] }, from: Date.UTC(2025, 0, 2), to: Date.UTC(2025, 4, 1) }), /grid\.bad/);
});

test('scripts/backtest.js --walk-forward writes walk-forward.md and prints the out-of-sample result', () => {
  const dir = tmpDir();
  const data = path.join(dir, 'bars.json');
  fs.writeFileSync(data, JSON.stringify({ bars: bars() }));
  const sdir = path.join(dir, 'strategies', 'xo');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'STRATEGY.md'), [
    '---', 'name: xo', 'description: Test EMA cross for the walk-forward CLI, long and short on MNQ.', 'status: active', 'instruments: [MNQ]',
    'timeframe: 3m', 'signal: rules', 'mtf: reversal', 'rules:', '  long:', '    - ema(9) crosses_above ema(20)', '  short:', '    - ema(9) crosses_below ema(20)',
    'exit:', '  target_r: 2', 'risk:', '  stop: atr:1', '  min_rr: 2', '---', '## When to Use', '## How It Works', '## Examples', '',
  ].join('\n'));
  const out = path.join(dir, 'out');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backtest.js'), '--data', data, '--symbol', 'MNQ', '--strategy', 'xo', '--no-gate',
    '--walk-forward', '--grid', 'exit.target_r=1,2', '--train-months', '2', '--test-months', '1', '--min-trades', '5', '--out', out],
  { encoding: 'utf8', env: { ...process.env, FTH_STRATEGIES_DIRS: path.join(dir, 'strategies'), FTH_HOME: dir } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /out of sample, tuned: \d+ trades/);
  assert.match(r.stdout, /out of sample, defaults: \d+ trades/);
  assert.ok(fs.existsSync(path.join(out, 'walk-forward.md')) && fs.existsSync(path.join(out, 'walk-forward.json')));
  const two = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backtest.js'), '--data', data, '--symbol', 'MNQ', '--walk-forward', '--grid', 'exit.target_r=1'],
    { encoding: 'utf8', env: { ...process.env, FTH_STRATEGIES_DIRS: path.join(dir, 'strategies'), FTH_HOME: dir } });
  assert.strictEqual(two.status, 1);
  assert.match(two.stderr, /walkForward: name exactly one strategy/);
});
