'use strict';

/**
 * The prop challenge simulator: combine attempts on history. An attempt runs
 * the backtest engine (engine.js) with the account (combine.js) from a start
 * day until it passes, blows, or times out, the same loop and sizing the
 * live runner uses. The backtester's prop runs (backtest/run.js) score a
 * policy strategy with it: pass, blow and timeout rates, overall and by the
 * month an attempt starts in.
 */

const { runEngine, prepare } = require('../backtest/engine');
const { tradingDayStart } = require('../trading/clock');

const DAY_MS = 86400000;

/** The trading-day starts with a bar in any of the books (markets), in order: every market's days, not the first's. */
function tradingDays(books) {
  const set = new Set();
  for (const book of books) {
    let last = null;
    for (const b of book.bars) {
      const d = tradingDayStart(new Date(b.ms + 1)).getTime();
      if (d !== last) { set.add(d); last = d; }
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Prepare a simulator over markets (one or several, sharing one account) and
 * strategies, with the account profile and the engine's options (gate,
 * sessions, eodAt, calendar). Reusable for many attempts.
 */
function createEnv({ markets, strategies, account, sizing = null, prop = null, engine = {} }) {
  const prepared = prepare(markets, strategies, { ...engine, prop });
  const days = tradingDays(prepared.books);
  return {
    prepared, markets, strategies, account, sizing, prop, engine, days,
    /** Trading-day starts in [from, to) leaving room for a whole attempt before `to`. */
    starts(from, to, { every = 1 } = {}) {
      const inside = days.filter(d => d >= from && d < to);
      const room = inside.slice(0, Math.max(0, inside.length - account.sessions));
      return room.filter((_, k) => k % every === 0);
    },
  };
}

/** One attempt from `startMs` (a trading-day start), no later than `endMs`. */
function runAttempt(env, startMs, endMs) {
  // An attempt spans `sessions` trading days; bound the engine's window
  // generously (weekends, holidays) so it never scans the whole series.
  const span = (env.account.sessions * 1.6 + 7) * DAY_MS;
  const res = runEngine(env.markets, env.strategies, {
    ...env.engine, prepared: env.prepared, account: env.account, sizing: env.sizing, prop: env.prop,
    start: startMs, end: Math.min(endMs, startMs + span),
  });
  const cs = res.combine;
  return {
    start: new Date(startMs).toISOString(), status: cs.status, sessions: cs.days.length, profit: cs.balance - cs.start,
    balance: cs.balance, trades: res.trades, combine: cs,
  };
}

/** Attempts from each start. Aggregate and per-month (by the attempt's start) results. */
function evaluate(env, starts, endMs) {
  const months = new Map();
  const blank = () => ({ attempts: 0, passed: 0, blown: 0, timeout: 0, other: 0, passDays: [], profit: 0, trades: 0, wins: 0, losses: 0, winR: 0, lossR: 0, sumR: 0 });
  const all = blank();
  const add = (agg, o) => {
    agg.attempts += 1;
    if (o.status === 'passed') { agg.passed += 1; agg.passDays.push(o.sessions); } else if (o.status === 'blown') agg.blown += 1;
    else if (o.status === 'timeout') agg.timeout += 1;
    else agg.other += 1;
    agg.profit += o.profit;
    agg.trades += o.trades.length;
    agg.wins += o.trades.filter(t => t.net > 0).length;
    agg.losses += o.trades.filter(t => t.net < 0).length;
    for (const t of o.trades) {
      const r = Number.isFinite(t.r) ? t.r : 0;
      agg.sumR += r;
      if (t.net > 0) agg.winR += r;
      else if (t.net < 0) agg.lossR += r;
    }
  };
  for (const s of starts) {
    const o = runAttempt(env, s, endMs);
    const key = new Date(s).toISOString().slice(0, 7);
    if (!months.has(key)) months.set(key, blank());
    add(months.get(key), o);
    add(all, o);
  }
  const finish = a => ({
    attempts: a.attempts, passed: a.passed, blown: a.blown, timeout: a.timeout, unfinished: a.other,
    passRate: a.attempts ? Math.round((a.passed / a.attempts) * 1000) / 1000 : null,
    blowRate: a.attempts ? Math.round((a.blown / a.attempts) * 1000) / 1000 : null,
    medianDaysToPass: a.passDays.length ? a.passDays.slice().sort((x, y) => x - y)[Math.floor(a.passDays.length / 2)] : null,
    avgProfit: a.attempts ? Math.round(a.profit / a.attempts) : null,
    tradesPerAttempt: a.attempts ? Math.round((a.trades / a.attempts) * 10) / 10 : null,
    trades: a.trades,
    wins: a.wins,
    // Winning trades (after fees) over all trades.
    winRate: a.trades ? Math.round((a.wins / a.trades) * 1000) / 1000 : null,
    losses: a.losses,
    // Average R of the winning trades, of the losing ones, and of every trade (expectancy).
    avgWinR: a.wins ? Math.round((a.winR / a.wins) * 1000) / 1000 : null,
    avgLossR: a.losses ? Math.round((a.lossR / a.losses) * 1000) / 1000 : null,
    expectancyR: a.trades ? Math.round((a.sumR / a.trades) * 1000) / 1000 : null,
  });
  return { ...finish(all), months: Object.fromEntries([...months].map(([k, v]) => [k, finish(v)])) };
}

module.exports = { tradingDays, createEnv, runAttempt, evaluate };
