'use strict';

/**
 * The prop challenge as an RL environment. An episode is one attempt: the
 * backtest engine (engine.js) runs the account (combine.js) from a start day
 * until it passes, blows, or times out, and asks the agent at every
 * decision through the policy hook, the same loop the backtester and the live
 * runner use. Rewards are assigned from the account's balance between
 * decisions plus the attempt's outcome.
 *
 * Actions (3, masked):
 *   at a setup:  0 skip, 1 half size, 2 full size (the combine budget)
 *   in a trade (past the ratchet): 0 hold, 1 close
 */

const { runEngine, prepare } = require('../backtest/engine');
const { tradingDayStart } = require('../trading/clock');
const { OBS_DIM } = require('./observation');

const ACTIONS = { setup: ['skip', 'half', 'full'], position: ['hold', 'close'] };
const ACTION_N = 3;
const MASKS = { setup: [1, 1, 1], position: [1, 1, 0] };
const DEFAULT_REWARD = {
  pass: 10, // reaching the target
  speed: 3, // + speed x the share of sessions left at the pass
  blow: 30, // - touching the floor (three times a pass: the zero-blow priority)
  timeout: 1, // - running out of sessions
  dense: 1, // + dense x (balance change between decisions) / max loss
  win: 0.5, // + for each winning trade (after fees): a high win rate, not just a pass
  loss: 0.5, // - for each losing trade
};
const DAY_MS = 86400000;

/**
 * Prepare an environment over markets (one symbol is typical) and strategies,
 * with the account profile and the engine's options (gate, sessions, eodAt,
 * calendar). Reusable for many episodes.
 */
function createEnv({ markets, strategies, account, sizing = null, prop = null, engine = {}, reward = {} }) {
  const prepared = prepare(markets, strategies, engine);
  const book = prepared.books[0];
  const days = [];
  for (const b of book.bars) {
    const d = tradingDayStart(new Date(b.ms + 1)).getTime();
    if (days[days.length - 1] !== d) days.push(d);
  }
  return {
    prepared, markets, strategies, account, sizing, prop, engine, reward: { ...DEFAULT_REWARD, ...reward }, days,
    /** Trading-day starts in [from, to) leaving room for a whole attempt before `to`. */
    starts(from, to, { every = 1 } = {}) {
      const inside = days.filter(d => d >= from && d < to);
      const room = inside.slice(0, Math.max(0, inside.length - account.sessions));
      return room.filter((_, k) => k % every === 0);
    },
  };
}

/** One attempt from `startMs` (a trading-day start), no later than `endMs`. policy: { decide } or null. */
function runAttempt(env, startMs, endMs, policy = null) {
  // An attempt spans `sessions` trading days; bound the engine's window
  // generously (weekends, holidays) so it never scans the whole series.
  const span = (env.account.sessions * 1.6 + 7) * DAY_MS;
  const res = runEngine(env.markets, env.strategies, {
    ...env.engine, prepared: env.prepared, account: env.account, sizing: env.sizing, prop: env.prop, policy,
    start: startMs, end: Math.min(endMs, startMs + span),
  });
  const cs = res.combine;
  return {
    start: new Date(startMs).toISOString(), status: cs.status, sessions: cs.days.length, profit: cs.balance - cs.start,
    balance: cs.balance, trades: res.trades, decisions: res.decisions, combine: cs,
  };
}

/** The attempt's outcome reward, added to the last decision's (pass, faster pass, blow, timeout). */
function outcomeReward(env, out) {
  const r = env.reward;
  if (out.status === 'passed') return r.pass + r.speed * Math.max(0, 1 - out.sessions / env.account.sessions);
  if (out.status === 'blown') return -r.blow;
  if (out.status === 'timeout') return -r.timeout;
  return 0;
}

/** Dense reward between two decisions: the balance change over the max loss. */
const denseReward = (env, from, to) => (env.reward.dense * (to - from)) / env.account.max_loss;

/** Reward for the trades closed between two decisions: + per win, - per loss. */
const tradeReward = (env, newWins, newLosses) => env.reward.win * newWins - env.reward.loss * newLosses;

/** Attempts from each start, deterministic policy (or rules only). Aggregate and per-month results. */
function evaluate(env, starts, endMs, policy = null) {
  const months = new Map();
  const blank = () => ({ attempts: 0, passed: 0, blown: 0, timeout: 0, other: 0, passDays: [], profit: 0, trades: 0, wins: 0 });
  const all = blank();
  const add = (agg, o) => {
    agg.attempts += 1;
    if (o.status === 'passed') { agg.passed += 1; agg.passDays.push(o.sessions); } else if (o.status === 'blown') agg.blown += 1;
    else if (o.status === 'timeout') agg.timeout += 1;
    else agg.other += 1;
    agg.profit += o.profit;
    agg.trades += o.trades.length;
    agg.wins += o.trades.filter(t => t.net > 0).length;
  };
  for (const s of starts) {
    const o = runAttempt(env, s, endMs, policy);
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
  });
  return { ...finish(all), months: Object.fromEntries([...months].map(([k, v]) => [k, finish(v)])) };
}

/** A deterministic policy hook from an inference policy (loadPolicy). */
function policyHook(policy) {
  return {
    decide(kind, obs) {
      return ACTIONS[kind][policy.act(obs, MASKS[kind])];
    },
  };
}

module.exports = { ACTIONS, ACTION_N, MASKS, OBS_DIM, DEFAULT_REWARD, createEnv, runAttempt, outcomeReward, denseReward, tradeReward, evaluate, policyHook };
