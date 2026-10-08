'use strict';

/**
 * Backtest results from the simulated broker's fills and the trading
 * journal: round trips (flat to flat per contract), P&L after fees, win
 * rate, profit factor, expectancy, max drawdown, and per-setup and per-day
 * breakdowns. A round trip is credited to the setup named in the rationale of
 * the order that opened it (setup:<name>), as the agents journal it.
 */

const SETUP = /\bsetup:([a-z0-9_-]+)/i;
const round2 = x => Math.round(x * 100) / 100;

/** orderId -> setup name, from projectx-mcp `order_placed` journal entries. */
function setupsByOrder(journal) {
  const map = new Map();
  for (const e of journal) {
    if (e && e.kind === 'order_placed' && e.orderId !== undefined && e.orderId !== null) {
      const m = SETUP.exec(String(e.text || ''));
      if (m) map.set(Number(e.orderId), m[1].toLowerCase());
    }
  }
  return map;
}

/** Group fills (oldest first) into flat-to-flat round trips per contract. */
function roundTrips(trades, setups = new Map(), tickInfo = {}) {
  const open = new Map();
  const done = [];
  for (const t of trades) {
    if (t.voided) continue;
    const sign = t.side === 0 ? 1 : -1;
    let rt = open.get(t.contractId);
    if (!rt) {
      rt = { contractId: t.contractId, openedAt: t.creationTimestamp, direction: sign > 0 ? 'long' : 'short', setup: setups.get(t.orderId) || 'untagged', entry: t.price, maxSize: 0, net: 0, pnl: 0, fees: 0, fills: 0 };
      open.set(t.contractId, rt);
    }
    rt.pnl += t.profitAndLoss || 0;
    rt.fees += t.fees || 0;
    rt.fills += 1;
    const before = rt.net;
    rt.net += sign * t.size;
    rt.maxSize = Math.max(rt.maxSize, Math.abs(rt.net));
    if (before !== 0 && (rt.net === 0 || Math.sign(rt.net) !== Math.sign(before))) {
      rt.closedAt = t.creationTimestamp;
      rt.exit = t.price;
      const flipped = rt.net !== 0;
      const leftover = rt.net;
      rt.net = 0;
      rt.netPnL = round2(rt.pnl - rt.fees);
      rt.pnl = round2(rt.pnl);
      rt.fees = round2(rt.fees);
      const tick = tickInfo[t.contractId];
      if (tick) rt.points = round2((rt.exit - rt.entry) * (rt.direction === 'long' ? 1 : -1));
      done.push(rt);
      open.delete(t.contractId);
      if (flipped) {
        open.set(t.contractId, { contractId: t.contractId, openedAt: t.creationTimestamp, direction: leftover > 0 ? 'long' : 'short', setup: setups.get(t.orderId) || 'untagged', entry: t.price, maxSize: Math.abs(leftover), net: leftover, pnl: 0, fees: 0, fills: 0 });
      }
    }
  }
  return { closed: done, open: [...open.values()] };
}

function stats(trips) {
  const pnls = trips.map(r => r.netPnL);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  const net = pnls.reduce((a, b) => a + b, 0);
  return {
    trades: trips.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trips.length ? round2(wins.length / trips.length) : null,
    netPnL: round2(net),
    fees: round2(trips.reduce((a, r) => a + r.fees, 0)),
    avgWin: wins.length ? round2(grossWin / wins.length) : null,
    avgLoss: losses.length ? round2(-grossLoss / losses.length) : null,
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
    expectancy: trips.length ? round2(net / trips.length) : null,
  };
}

/** Peak-to-trough drawdown of the closed-trade equity curve. */
function maxDrawdown(trips, startingBalance) {
  let equity = startingBalance;
  let peak = startingBalance;
  let dd = 0;
  for (const r of trips) {
    equity += r.netPnL;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  return round2(dd);
}

function groupBy(trips, key) {
  const out = {};
  for (const r of trips) (out[key(r)] = out[key(r)] || []).push(r);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, stats(v)]));
}

function buildReport({ broker, journal, cycles, meta }) {
  const setups = setupsByOrder(journal);
  const { closed, open } = roundTrips(broker.trades, setups, Object.fromEntries([...broker.contracts.values()].map(c => [c.contractId, c])));
  const day = r => r.closedAt.slice(0, 10);
  return {
    meta,
    summary: {
      ...stats(closed),
      startingBalance: broker.startingBalance,
      endingBalance: round2(broker.account.balance),
      maxDrawdown: maxDrawdown(closed, broker.startingBalance),
      cycles,
      accountLocks: broker.events.filter(e => e.kind === 'lock').map(e => ({ at: e.at, reason: e.reason })),
      openAtEnd: open.length,
    },
    bySetup: groupBy(closed, r => r.setup),
    byDay: groupBy(closed, day),
    trades: closed,
  };
}

function toMarkdown(report) {
  const s = report.summary;
  const row = (name, x) => `| ${name} | ${x.trades} | ${x.winRate === null ? '-' : `${Math.round(x.winRate * 100)}%`} | ${x.netPnL} | ${x.profitFactor ?? '-'} | ${x.expectancy ?? '-'} |`;
  const table = obj => ['| | Trades | Win rate | Net P&L | PF | Expectancy |', '|---|---|---|---|---|---|', ...Object.entries(obj).map(([k, v]) => row(k, v))].join('\n');
  return [
    `# Backtest ${report.meta.runId}`,
    '',
    `${report.meta.harness} on ${report.meta.symbols.join(', ')}, ${report.meta.timeframe}m bars, ${report.meta.start} to ${report.meta.end}.`,
    '',
    '## Summary',
    '',
    `- Net P&L: ${s.netPnL} after ${s.fees} fees (balance ${s.startingBalance} -> ${s.endingBalance})`,
    `- Trades: ${s.trades} (${s.wins} wins, ${s.losses} losses${s.winRate === null ? '' : `, ${Math.round(s.winRate * 100)}%`})`,
    `- Profit factor: ${s.profitFactor ?? '-'}; expectancy per trade: ${s.expectancy ?? '-'}`,
    `- Max drawdown (closed trades): ${s.maxDrawdown}`,
    `- Harness cycles: ${s.cycles.trade} trade, ${s.cycles.premarket} premarket, ${s.cycles.eod} end of day, ${s.cycles.failed} failed`,
    ...(s.accountLocks.length ? [`- Account locks: ${s.accountLocks.map(l => `${l.at} ${l.reason}`).join('; ')}`] : []),
    '',
    '## By setup',
    '',
    table(report.bySetup),
    '',
    '## By day',
    '',
    table(report.byDay),
    '',
  ].join('\n');
}

module.exports = { setupsByOrder, roundTrips, stats, maxDrawdown, buildReport, toMarkdown };
