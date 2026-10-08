'use strict';

/**
 * Backtest results: R-multiple statistics as algoTraderBot reports them
 * (trades, win rate, mean and total R, profit factor, MFE and capture), plus
 * dollars after fees and slippage, max drawdown, and breakdowns by strategy,
 * exit reason, symbol, month, entry hour (ET), and weekday.
 *
 * How much to trust it: a 95% confidence interval on the mean R (normal
 * approximation, mean +/- 1.96 sd / sqrt(n); with under 30 trades it is
 * flagged as anecdotal), the Sharpe ratio of daily net P&L (annualized over
 * 252 trading days, days with trades only), MAE (how far trades went against
 * the entry, in R), the longest losing streak, and the average bars held.
 */

const { zonedParts, tradingDayKey } = require('../trading/clock');

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
  const mae = trades.map(t => t.maeR).filter(Number.isFinite);
  const n = trades.length;
  const mean = n ? sum(r) / n : null;
  const sd = n > 1 ? Math.sqrt(sum(r.map(x => (x - mean) ** 2)) / (n - 1)) : null;
  const half = sd !== null ? 1.96 * sd / Math.sqrt(n) : null;
  let streak = 0;
  let worstStreak = 0;
  for (const x of r) { streak = x < 0 ? streak + 1 : 0; worstStreak = Math.max(worstStreak, streak); }
  return {
    trades: trades.length,
    winRate: trades.length ? round(r.filter(x => x > 0).length / trades.length, 3) : null,
    meanR: trades.length ? round(sum(r) / trades.length, 3) : null,
    sumR: round(sum(r)),
    profitFactorR: lossR > 0 ? round(winsR / lossR) : null,
    meanMfeR: trades.length ? round(sum(mfe) / trades.length) : null,
    maxMfeR: trades.length ? round(mfe.reduce((a, b) => Math.max(a, b), -Infinity)) : null,
    capture: sum(mfe) > 0 ? round(sum(r) / sum(mfe), 3) : null,
    netPnL: round(sum(net)),
    fees: round(sum(trades.map(t => t.fees))),
    profitFactor: lossD > 0 ? round(winsD / lossD) : null,
    avgWin: net.some(x => x > 0) ? round(winsD / net.filter(x => x > 0).length) : null,
    avgLoss: net.some(x => x < 0) ? round(-lossD / net.filter(x => x < 0).length) : null,
    sdR: round(sd, 3),
    meanRCI95: half !== null ? [round(mean - half, 3), round(mean + half, 3)] : null,
    // Is the edge distinguishable from zero? Not with under 30 trades, or when the interval spans 0.
    edge: n < 30 ? 'anecdotal (under 30 trades)' : half !== null && mean - half > 0 ? 'positive' : half !== null && mean + half < 0 ? 'negative' : 'unproven (the interval includes 0)',
    meanMaeR: mae.length ? round(sum(mae) / mae.length) : null,
    worstMaeR: mae.length ? round(Math.min(...mae)) : null,
    longestLosingStreak: worstStreak,
    avgBarsHeld: n ? round(sum(trades.map(t => t.barsHeld || 0)) / n, 1) : null,
  };
}

/** Sharpe ratio of daily net P&L (trading days with trades), annualized over 252 days. */
function sharpe(trades) {
  const days = new Map();
  for (const t of trades) {
    const d = tradingDayKey(new Date(t.exitTime));
    days.set(d, (days.get(d) || 0) + t.net);
  }
  const v = [...days.values()];
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
  return sd > 0 ? round((m / sd) * Math.sqrt(252)) : null;
}

const etParts = iso => zonedParts(new Date(iso), 'America/New_York');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hourOf = t => `${String(etParts(t.entryTime).hour).padStart(2, '0')}:00 ET`;
const weekdayOf = t => {
  const p = etParts(t.entryTime);
  return `${new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()}-${WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]}`;
};

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
    summary: { ...stats(sorted), maxDrawdown: maxDrawdown(sorted), sharpe: sharpe(sorted) },
    byStrategy: groupBy(sorted, t => t.strategy),
    byExit: groupBy(sorted, t => t.reason),
    bySymbol: groupBy(sorted, t => t.symbol),
    byMonth: groupBy(sorted, t => t.exitTime.slice(0, 7)),
    byHour: groupBy(sorted, hourOf),
    // Does agreement help? Trades by how many strategies fired their side on the signal bar.
    byConfluence: groupBy(sorted, t => `${t.confluence || 1} agreeing${t.conflict ? `, ${t.conflict} against` : ''}`),
    byWeekday: groupBy(sorted, weekdayOf),
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
    `- Net P&L: $${v(s.netPnL)} after $${v(s.fees)} fees; profit factor ${v(s.profitFactor)}; max drawdown $${v(s.maxDrawdown)}; Sharpe (daily, annualized) ${v(s.sharpe)}`,
    `- Edge: ${s.edge}; mean R 95% interval ${s.meanRCI95 ? `${s.meanRCI95[0]} to ${s.meanRCI95[1]}` : '-'} (sd ${v(s.sdR)}R)`,
    `- Risk: MAE mean ${v(s.meanMaeR)}R, worst ${v(s.worstMaeR)}R; longest losing streak ${s.longestLosingStreak}; ${v(s.avgBarsHeld)} bars held on average`,
    `- Fills: ${m.fill === 'close' ? 'at the signal bar\'s close' : 'at the next bar\'s open (live latency)'}, ${m.slippageTicks ?? 0} tick(s) of slippage per market fill${m.expired ? `; ${m.expired} setup(s) expired before their fill (gap through the stop or target, or the day ended)` : ''}`,
    ...(m.provenance ? [`- Provenance: harness ${m.provenance.commit || 'unknown commit'}; strategies ${Object.entries(m.provenance.strategies).map(([k, h]) => `${k}@${h || '?'}`).join(', ')}; data ${Object.entries(m.provenance.data).map(([k, d]) => `${k} ${d.sha256 || '?'} (${d.bytes ?? '?'} bytes)`).join(', ')}`] : []),
    ...Object.entries(m.dataAudit || {}).map(([sym, x]) => `- Data ${sym}: ${x && x.warnings && x.warnings.length ? x.warnings.join('; ') : `${x ? x.bars : '?'} bars, no gaps, jumps, or bad bars found`}`),
    ...(Object.keys(m.skipped || {}).length ? [`- Not backtested: ${Object.entries(m.skipped).map(([k, why]) => `${k} (${why})`).join('; ')}`] : []),
    '',
    '## By strategy',
    '',
    table(report.byStrategy),
    '',
    '## By symbol',
    '',
    table(report.bySymbol),
    '',
    '## By exit',
    '',
    table(report.byExit),
    '',
    '## By month',
    '',
    table(report.byMonth),
    '',
    '## By confluence (strategies firing the same side on the signal bar)',
    '',
    table(report.byConfluence || {}),
    '',
    '## By entry hour (ET)',
    '',
    table(report.byHour || {}),
    '',
    '## By weekday',
    '',
    table(report.byWeekday || {}),
    '',
  ].join('\n');
}

function toCsv(trades) {
  const cols = ['symbol', 'strategy', 'direction', 'entryTime', 'entry', 'initialStop', 'exitTime', 'exit', 'size', 'risk', 'r', 'mfeR', 'maeR', 'barsHeld', 'reason', 'pnl', 'fees', 'net'];
  return [cols.join(','), ...trades.map(t => cols.map(c => t[c]).join(','))].join('\n') + '\n';
}

module.exports = { stats, maxDrawdown, sharpe, buildReport, toMarkdown, toCsv };
