'use strict';

/**
 * Walk-forward test of one rules strategy: the honest number for a strategy
 * whose parameters were chosen by looking at results.
 *
 * The data range is cut into folds: `trainMonths` in sample, then
 * `testMonths` out of sample, stepping by `testMonths`. In each fold every
 * combination of the grid is backtested on the in-sample months; the best
 * (highest mean R with at least `minTrades` trades) is then traded, untouched,
 * on the out-of-sample months that follow. Only those out-of-sample trades
 * count. The strategy's own parameters are traded on the same out-of-sample
 * months as the baseline: if tuning doesn't beat it, keep the defaults.
 *
 * Grid keys: a `params` key (crtMinRR, orbMinutes, ...) or an exit key
 * (`exit.trail_activate_r`, `exit.trail_giveback_r`, `exit.target_r`,
 * `exit.max_bars`). The engine options are the backtest's (fills, slippage,
 * fees, harness rules), so the out-of-sample trades are what live would see.
 */

const { runEngine, prepare } = require('./engine');
const { stats } = require('./report');
const { PARAMS } = require('../trading/market-snapshot');

const EXIT_KEYS = ['trail_activate_r', 'trail_giveback_r', 'target_r', 'max_bars'];
const round = (x, d = 3) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Every combination of the grid's values: [{ key: value, ... }]. */
function combinations(grid) {
  return Object.entries(grid).reduce((acc, [k, values]) => acc.flatMap(c => values.map(v => ({ ...c, [k]: v }))), [{}]);
}

/** Problems with a grid for strategy `s`: [message]. */
function gridErrors(grid, s) {
  const errors = [];
  if (!grid || typeof grid !== 'object' || !Object.keys(grid).length) return ['grid: { "<param>": [values, ...] } with at least one key'];
  for (const [k, values] of Object.entries(grid)) {
    const exit = /^exit\.(.+)$/.exec(k);
    if (exit ? !EXIT_KEYS.includes(exit[1]) : !(k in PARAMS || (s.params && k in s.params))) {
      errors.push(`grid.${k}: not a parameter of ${s.name} (params: ${Object.keys({ ...PARAMS, ...(s.params || {}) }).join(', ')}; exit: ${EXIT_KEYS.map(x => `exit.${x}`).join(', ')})`);
    }
    if (!Array.isArray(values) || !values.length || !values.every(v => typeof v === 'number' && Number.isFinite(v))) errors.push(`grid.${k}: a list of numbers`);
  }
  const n = combinations(grid).length;
  if (n > 200) errors.push(`grid: ${n} combinations; keep it to 200 or fewer (each is a full backtest, and more tries make a lucky winner likelier)`);
  return errors;
}

/** The strategy with a grid point applied. */
function withPoint(s, point) {
  const params = { ...(s.params || {}) };
  const exit = { ...(s.exit || {}) };
  for (const [k, v] of Object.entries(point)) {
    const m = /^exit\.(.+)$/.exec(k);
    if (m) exit[m[1]] = v; else params[k] = v;
  }
  return { ...s, params, exit };
}

const addMonths = (ms, n) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
};

/** Folds over [from, to): [{ trainStart, testStart, testEnd }]. */
function folds(from, to, trainMonths, testMonths) {
  const out = [];
  for (let t = from; addMonths(t, trainMonths) < to; t = addMonths(t, testMonths)) {
    const testStart = addMonths(t, trainMonths);
    out.push({ trainStart: t, testStart, testEnd: Math.min(addMonths(testStart, testMonths), to) });
  }
  return out;
}

/**
 * @param markets the backtest's markets (bars loaded)
 * @param strategy one rules strategy
 * @param opts { grid, trainMonths, testMonths, minTrades, from, to (ms), engine (runEngine options) }
 */
function runWalkForward(markets, strategy, { grid, trainMonths = 6, testMonths = 1, minTrades = 20, from, to, engine = {} }) {
  const errors = gridErrors(grid, strategy);
  if (!(Number.isInteger(trainMonths) && trainMonths >= 1)) errors.push('trainMonths: whole months, 1 or more');
  if (!(Number.isInteger(testMonths) && testMonths >= 1)) errors.push('testMonths: whole months, 1 or more');
  if (!(Number.isInteger(minTrades) && minTrades >= 1)) errors.push('minTrades: 1 or more');
  if (errors.length) throw new Error(`invalid walk-forward:\n- ${errors.join('\n- ')}`);
  const plan = folds(from, to, trainMonths, testMonths);
  if (!plan.length) throw new Error(`walk-forward: the data (${new Date(from).toISOString().slice(0, 10)} to ${new Date(to).toISOString().slice(0, 10)}) is shorter than ${trainMonths} training month(s) plus a test window`);
  // Each variant's evaluator runs once over the whole data; folds only pick their range.
  const variants = combinations(grid).map(point => {
    const s = withPoint(strategy, point);
    return { point, s, prepared: prepare(markets, [s], engine) };
  });
  const base = { s: strategy, prepared: prepare(markets, [strategy], engine) };
  const trade = (v, start, end) => runEngine(markets, [v.s], { ...engine, prepared: v.prepared, start, end }).trades;
  const rows = [];
  const oos = [];
  const baseline = [];
  for (const f of plan) {
    const scored = variants.map(v => {
      const tr = trade(v, f.trainStart, f.testStart);
      const st = stats(tr);
      return { v, n: tr.length, meanR: st.meanR };
    }).filter(x => x.n >= minTrades && x.meanR !== null)
      .sort((a, b) => b.meanR - a.meanR || b.n - a.n);
    const row = {
      train: `${new Date(f.trainStart).toISOString().slice(0, 10)} to ${new Date(f.testStart).toISOString().slice(0, 10)}`,
      test: `${new Date(f.testStart).toISOString().slice(0, 10)} to ${new Date(f.testEnd).toISOString().slice(0, 10)}`,
    };
    const baseTrades = trade(base, f.testStart, f.testEnd);
    baseline.push(...baseTrades);
    row.baseline = { trades: baseTrades.length, meanR: stats(baseTrades).meanR };
    if (!scored.length) {
      rows.push({ ...row, chosen: null, note: `no combination had ${minTrades} trades in sample: nothing traded out of sample` });
      continue;
    }
    const best = scored[0];
    const test = trade(best.v, f.testStart, f.testEnd);
    oos.push(...test);
    rows.push({ ...row, chosen: best.v.point, inSample: { trades: best.n, meanR: best.meanR }, outOfSample: { trades: test.length, meanR: stats(test).meanR } });
  }
  const traded = rows.filter(r => r.chosen);
  const isMean = traded.length ? traded.reduce((a, r) => a + r.inSample.meanR, 0) / traded.length : null;
  const oosStats = stats(oos);
  return {
    strategy: strategy.name,
    grid,
    combinations: variants.length,
    trainMonths,
    testMonths,
    minTrades,
    folds: rows,
    outOfSample: oosStats,
    baseline: stats(baseline),
    // How much of the in-sample edge survived: out-of-sample mean R / average in-sample mean R of the winners.
    retention: isMean > 0 && oosStats.meanR !== null ? round(oosStats.meanR / isMean, 2) : null,
    // Did the same point win most folds? Unstable winners are a sign of fitting noise.
    stability: traded.length ? round(Math.max(...Object.values(traded.reduce((acc, r) => {
      const k = JSON.stringify(r.chosen);
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}))) / traded.length, 2) : null,
    positiveFolds: traded.length ? `${traded.filter(r => r.outOfSample.meanR > 0).length} of ${traded.length}` : '0 of 0',
    trades: oos,
  };
}

function toMarkdown(wf) {
  const v = x => (x === null || x === undefined ? '-' : x);
  const pct = x => (x === null ? '-' : `${Math.round(x * 100)}%`);
  const s = wf.outOfSample;
  const b = wf.baseline;
  return [
    `# Walk-forward: ${wf.strategy}`,
    '',
    `${wf.combinations} combinations of ${Object.keys(wf.grid).join(', ')}; ${wf.trainMonths} month(s) in sample, ${wf.testMonths} out of sample per fold; a winner needs ${wf.minTrades} in-sample trades.`,
    '',
    '## Out of sample (the number to trust)',
    '',
    `- Tuned: ${s.trades} trades, win ${pct(s.winRate)}, mean ${v(s.meanR)}R (95% ${s.meanRCI95 ? `${s.meanRCI95[0]} to ${s.meanRCI95[1]}` : '-'}), total ${v(s.sumR)}R, net $${v(s.netPnL)}; edge ${s.edge}`,
    `- Defaults (the strategy's own parameters, same months): ${b.trades} trades, mean ${v(b.meanR)}R, total ${v(b.sumR)}R, net $${v(b.netPnL)}`,
    `- Retention (out-of-sample mean R / in-sample mean R of the winners): ${v(wf.retention)}; folds positive out of sample: ${wf.positiveFolds}; the most frequent winner won ${pct(wf.stability)} of folds`,
    `- ${wf.combinations} tries per fold: the in-sample winner's edge is inflated by the search. Trust the out-of-sample numbers, and prefer the defaults unless the tuned run beats them out of sample.`,
    '',
    '## Folds',
    '',
    '| Train | Test | Chosen | In-sample n / mean R | Out-of-sample n / mean R | Defaults n / mean R |',
    '|---|---|---|---|---|---|',
    ...wf.folds.map(r => `| ${r.train} | ${r.test} | ${r.chosen ? Object.entries(r.chosen).map(([k, x]) => `${k}=${x}`).join(' ') : r.note} | ${r.inSample ? `${r.inSample.trades} / ${v(r.inSample.meanR)}` : '-'} | ${r.outOfSample ? `${r.outOfSample.trades} / ${v(r.outOfSample.meanR)}` : '-'} | ${r.baseline.trades} / ${v(r.baseline.meanR)} |`),
    '',
  ].join('\n');
}

module.exports = { combinations, gridErrors, withPoint, folds, runWalkForward, toMarkdown, EXIT_KEYS };
