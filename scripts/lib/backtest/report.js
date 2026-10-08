'use strict';

/**
 * Backtest results: R-multiple statistics as algoTraderBot reports them
 * (trades, win rate, mean and total R, profit factor, MFE and capture), plus
 * dollars after fees and slippage, max drawdown, and breakdowns by strategy,
 * exit reason, symbol, and month.
 */

const round = (x, d = 2) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

function stats(trades) {
  const r = trades.map(t => t.r);
  const net = trades.map(t => t.net);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const winsR = sum(r.filter(x => x > 0));
  const lossR = -sum(r.filter(x => x < 0));
  const winsD = sum(net.filter(x => x > 0));
  const lossD = -sum(net.filter(x => x < 0));
  const mfe = trades.map(t => t.mfeR);
  return {
    trades: trades.length,
    winRate: trades.length ? round(r.filter(x => x > 0).length / trades.length, 3) : null,
    meanR: trades.length ? round(sum(r) / trades.length, 3) : null,
    sumR: round(sum(r)),
    profitFactorR: lossR > 0 ? round(winsR / lossR) : null,
    meanMfeR: trades.length ? round(sum(mfe) / trades.length) : null,
    maxMfeR: trades.length ? round(Math.max(...mfe)) : null,
    capture: sum(mfe) > 0 ? round(sum(r) / sum(mfe), 3) : null,
    netPnL: round(sum(net)),
    fees: round(sum(trades.map(t => t.fees))),
    profitFactor: lossD > 0 ? round(winsD / lossD) : null,
    avgWin: net.some(x => x > 0) ? round(winsD / net.filter(x => x > 0).length) : null,
    avgLoss: net.some(x => x < 0) ? round(-lossD / net.filter(x => x < 0).length) : null,
  };
}

/** Peak-to-trough drawdown of the closed-trade equity curve, in dollars. */
function maxDrawdown(trades) {
  let equity = 0;
  let peak = 0;
  let dd = 0;
  for (const t of trades) {
    equity += t.net;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  return round(dd);
}

function groupBy(trades, key) {
  const out = {};
  for (const t of trades) (out[key(t)] = out[key(t)] || []).push(t);
  return Object.fromEntries(Object.entries(out).sort().map(([k, v]) => [k, stats(v)]));
}

function buildReport(trades, meta) {
  const sorted = [...trades].sort((a, b) => a.exitTime.localeCompare(b.exitTime));
  return {
    meta,
    summary: { ...stats(sorted), maxDrawdown: maxDrawdown(sorted) },
    byStrategy: groupBy(sorted, t => t.strategy),
    byExit: groupBy(sorted, t => t.reason),
    bySymbol: groupBy(sorted, t => t.symbol),
    byMonth: groupBy(sorted, t => t.exitTime.slice(0, 7)),
    trades: sorted,
  };
}

function toMarkdown(report) {
  const s = report.summary;
  const pct = x => (x === null ? '-' : `${Math.round(x * 100)}%`);
  const v = x => (x === null ? '-' : x);
  const table = obj => [
    '| | Trades | Win | Mean R | Sum R | PF (R) | Net $ | PF ($) |',
    '|---|---|---|---|---|---|---|---|',
    ...Object.entries(obj).map(([k, x]) => `| ${k} | ${x.trades} | ${pct(x.winRate)} | ${v(x.meanR)} | ${v(x.sumR)} | ${v(x.profitFactorR)} | ${v(x.netPnL)} | ${v(x.profitFactor)} |`),
  ].join('\n');
  const m = report.meta;
  return [
    `# Backtest ${m.runId}`,
    '',
    `${m.symbols.join(', ')} on ${m.timeframe}m bars, ${m.start} to ${m.end}; strategies: ${m.strategies.join(', ')}; ${m.gate ? 'harness rules on (sessions, end of day, order-gate limits)' : 'no harness rules (as algoTraderBot trades)'}.`,
    '',
    '## Summary',
    '',
    `- Trades: ${s.trades}, win rate ${pct(s.winRate)}, mean ${v(s.meanR)}R, total ${v(s.sumR)}R, profit factor ${v(s.profitFactorR)} (R)`,
    `- MFE: mean ${v(s.meanMfeR)}R, max ${v(s.maxMfeR)}R; capture (total R / total MFE) ${pct(s.capture)}`,
    `- Net P&L: $${v(s.netPnL)} after $${v(s.fees)} fees; profit factor ${v(s.profitFactor)}; max drawdown $${v(s.maxDrawdown)}`,
    ...(Object.keys(m.skipped || {}).length ? [`- Not backtested: ${Object.entries(m.skipped).map(([k, why]) => `${k} (${why})`).join('; ')}`] : []),
    '',
    '## By strategy',
    '',
    table(report.byStrategy),
    '',
    '## By exit',
    '',
    table(report.byExit),
    '',
    '## By month',
    '',
    table(report.byMonth),
    '',
  ].join('\n');
}

function toCsv(trades) {
  const cols = ['symbol', 'strategy', 'direction', 'entryTime', 'entry', 'initialStop', 'exitTime', 'exit', 'size', 'risk', 'r', 'mfeR', 'barsHeld', 'reason', 'pnl', 'fees', 'net'];
  return [cols.join(','), ...trades.map(t => cols.map(c => t[c]).join(','))].join('\n') + '\n';
}

module.exports = { stats, maxDrawdown, buildReport, toMarkdown, toCsv };
