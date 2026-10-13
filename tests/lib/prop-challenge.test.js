'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { compileRules } = require('../../scripts/lib/trading/rules');
const { loadConfig } = require('../../scripts/lib/trading/config');
const { createEnv, runAttempt, evaluate, tradingDays } = require('../../scripts/lib/prop/challenge');

/** mulberry32 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 3-minute bars, a seeded random walk with drift bursts, from Sunday 2026-01-04 18:00 ET for `days` calendar days. */
function series(days, seed = 5) {
  const r = rng(seed);
  const out = [];
  let px = 20000;
  const t0 = Date.parse('2026-01-04T23:00:00Z');
  for (let k = 0; k < (days * 1440) / 3; k += 1) {
    const drift = Math.sin(k / 90) * 0.6;
    const o = px;
    const c = Math.round((px + drift + (r() - 0.5) * 6) * 4) / 4;
    out.push({ t: new Date(t0 + k * 180000).toISOString(), o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 100 });
    px = c;
  }
  return out;
}

const strategy = (extra = {}) => {
  const rules = { long: ['close crosses_above ema(20)'], short: ['close crosses_below ema(20)'] };
  return {
    name: 'trendy', valid: true, status: 'active', instruments: ['MNQ'], timeframe: '3m', signal: 'rules', rules,
    compiledRules: compileRules(rules).compiled, risk: { stop: 'atr:1', min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 }, ...extra,
  };
};
const account = (extra = {}) => ({
  name: 'mini', starting_balance: 50000, profit_target: 1500, max_loss: 1000, max_loss_mode: 'trailing_eod', daily_loss_limit: 0,
  daily_loss_soft: 400, consistency_pct: 0, sessions: 4, max_contracts: { MNQ: 20 }, fees_per_side: { MNQ: 0.37 }, ...extra,
});
const market = bars => ({ symbol: 'MNQ', bars, tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 });
const engine = { timeframe: 3, gate: false, fill: 'close', slippageTicks: 0, gateConfig: loadConfig({}), window: 160 };

test('a prop attempt runs the account from a start day to pass, blow, or timeout; starts leave room for a whole attempt', () => {
  const bars = series(40);
  const e = createEnv({ markets: [market(bars)], strategies: [strategy()], account: account(), engine });
  assert.deepStrictEqual(e.days, tradingDays(e.prepared.books));
  assert.ok(e.days.length > 20 && e.days.every((d, k) => k === 0 || d > e.days[k - 1]), 'trading days, in order');
  const from = Date.parse('2026-01-08T00:00:00Z');
  const to = Date.parse('2026-02-10T00:00:00Z');
  const all = e.starts(from, to);
  const inside = e.days.filter(d => d >= from && d < to);
  assert.strictEqual(all.length, inside.length - account().sessions, 'the last `sessions` days leave no room for an attempt');
  assert.deepStrictEqual(e.starts(from, to, { every: 3 }), all.filter((_, k) => k % 3 === 0));
  const o = runAttempt(e, all[0], Infinity);
  assert.ok(['passed', 'blown', 'timeout'].includes(o.status), o.status);
  assert.ok(o.sessions <= account().sessions);
  assert.strictEqual(o.profit, o.balance - account().starting_balance);
  assert.strictEqual(o.start, new Date(all[0]).toISOString());
});

test('the attempt simulation sizes with the policy strategy\'s own stop_slippage_ticks, as live', () => {
  // The first trade of an attempt: $200 budget (0.2 x $1,000 cushion), a 14-tick stop. The default tick:
  // 15 x $0.50 = $7.50 + $0.74 = $8.24 a micro, 24 MNQ ($197.76); stop_slippage_ticks 3: 17 x $0.50 + $0.74 = $9.24, 21 ($194.04).
  const bars = series(40);
  const acct = account({ max_contracts: { MNQ: 100 } });
  const first = sizing => {
    const e = createEnv({ markets: [market(bars)], strategies: [strategy()], account: acct, sizing, engine });
    const t = runAttempt(e, e.starts(Date.parse('2026-01-08T00:00:00Z'), Infinity)[0], Infinity).trades[0];
    return [t.size, Math.round(t.risk / 0.25)];
  };
  assert.deepStrictEqual(first(null), [24, 14]);
  assert.deepStrictEqual(first({ stop_slippage_ticks: 3 }), [21, 14]);
});

test('evaluate aggregates attempts overall and by start month: pass, blow, timeout, win rate, and R', () => {
  const bars = series(40);
  const e = createEnv({ markets: [market(bars)], strategies: [strategy()], account: account(), engine });
  const starts = e.starts(Date.parse('2026-01-08T00:00:00Z'), Date.parse('2026-02-10T00:00:00Z')).slice(0, 6);
  const r = evaluate(e, starts, Infinity);
  assert.strictEqual(r.attempts, 6);
  assert.ok(r.wins <= r.trades && (r.trades === 0 || Math.abs(r.winRate - r.wins / r.trades) < 0.001));
  assert.strictEqual(r.passed + r.blown + r.timeout + r.unfinished, 6);
  assert.strictEqual(Object.values(r.months).reduce((a, m) => a + m.attempts, 0), 6);
  assert.deepStrictEqual(evaluate(e, starts, Infinity), r, 'deterministic');
  // Average win R, loss R, and expectancy come from the attempts' trades.
  const trades = starts.flatMap(s => runAttempt(e, s, Infinity).trades);
  const avg = xs => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null);
  assert.strictEqual(r.avgWinR, avg(trades.filter(t => t.net > 0).map(t => t.r)));
  assert.strictEqual(r.avgLossR, avg(trades.filter(t => t.net < 0).map(t => t.r)));
  assert.strictEqual(r.expectancyR, avg(trades.map(t => t.r)));
  assert.strictEqual(r.losses, trades.filter(t => t.net < 0).length);
  assert.ok(trades.length > 0 && (r.avgWinR === null || r.avgWinR > 0) && (r.avgLossR === null || r.avgLossR < 0));
  assert.deepStrictEqual(evaluate(e, [], Infinity).passRate, null, 'no attempts: no rate');
});
