'use strict';

// Several markets, one prop account: the trade stream's trading days and the engine's
// one-position-at-a-time rule.

const test = require('node:test');
const assert = require('node:assert');
const { compileRules } = require('../../scripts/lib/trading/rules');
const { loadConfig } = require('../../scripts/lib/trading/config');
const { runEngine, prepare } = require('../../scripts/lib/backtest/engine');
const { tradingDays } = require('../../scripts/lib/prop/trade-stream');

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

/** 3-minute bars from Sunday 2026-01-04 18:00 ET (plus `offsetDays`), a seeded walk. */
function series(days, seed, px = 20000, offsetDays = 0) {
  const r = rng(seed);
  const out = [];
  const t0 = Date.parse('2026-01-04T23:00:00Z') + offsetDays * 86400000;
  for (let k = 0; k < (days * 1440) / 3; k += 1) {
    const o = px;
    const c = Math.round((px + Math.sin(k / 90) * 0.6 + (r() - 0.5) * 6) * 4) / 4;
    out.push({ t: new Date(t0 + k * 180000).toISOString(), o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 100 });
    px = c;
  }
  return out;
}

const rules = { long: ['close crosses_above ema(20)'], short: ['close crosses_below ema(20)'] };
const strategy = {
  name: 'trendy', valid: true, status: 'active', instruments: ['MNQ', 'MES'], timeframe: '3m', signal: 'rules', rules,
  compiledRules: compileRules(rules).compiled, risk: { stop: 'atr:1', min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 },
};
const account = {
  name: 'mini', starting_balance: 50000, profit_target: 100000, max_loss: 2000, max_loss_mode: 'trailing_eod', daily_loss_limit: 0,
  daily_loss_soft: 0, consistency_pct: 0, sessions: 20, max_contracts: { MNQ: 20, MES: 20 }, fees_per_side: { MNQ: 0.37, MES: 0.37 },
};
const markets = () => [
  { symbol: 'MNQ', bars: series(25, 5), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 },
  { symbol: 'MES', bars: series(25, 9, 5000), tickSize: 0.25, tickValue: 1.25, feesPerSide: 0.37 },
];
const engine = { timeframe: 3, gate: false, fill: 'next-open', slippageTicks: 1, gateConfig: loadConfig({}), window: 160, start: Date.parse('2026-01-08T00:00:00Z') };

/** Pairs of trades open at the same time (entry before the other's exit, both ways). */
const overlaps = trades => {
  const out = [];
  for (let a = 0; a < trades.length; a += 1) {
    for (let b = a + 1; b < trades.length; b += 1) {
      const [x, y] = [trades[a], trades[b]];
      if (Date.parse(x.entryTime) < Date.parse(y.exitTime) && Date.parse(y.entryTime) < Date.parse(x.exitTime)) out.push([x, y]);
    }
  }
  return out;
};

test('engine: several markets on one prop account trade one position at a time across them', () => {
  // Without an account each market trades on its own: their trades overlap in time.
  const plain = runEngine(markets(), [strategy], engine);
  assert.ok(overlaps(plain.trades).length > 0, 'the markets fire together often enough to overlap');
  // With the account, a setup on one market waits while the other's trade is open (or filling).
  const res = runEngine(markets(), [strategy], { ...engine, account });
  assert.ok(res.trades.length > 10, `${res.trades.length} trades`);
  assert.deepStrictEqual(new Set(res.trades.map(t => t.symbol)), new Set(['MNQ', 'MES']), 'both markets trade');
  assert.deepStrictEqual(overlaps(res.trades).map(([x, y]) => `${x.symbol} ${x.entryTime}-${x.exitTime} / ${y.symbol} ${y.entryTime}-${y.exitTime}`), []);
  // So every trade is sized from the whole cushion with no other open risk, and none can stop past the floor.
  assert.notStrictEqual(res.combine.status, 'blown');
});

test('engine: bars closing together settle on every market before any entry, so market order favours none', () => {
  // A trade stopped on one market at a bar leaves the account flat at that bar's close for every market,
  // as live (the runner reads all closed bars and the account before the cycle). So a setup on the other
  // market at that very bar enters, whichever market is listed first.
  const { prepare } = require('../../scripts/lib/backtest/engine');
  // A strategy that fires on most bars, so setups fall on the other market's exit bars.
  const busyRules = { long: ['close > open'], short: ['close < open'] };
  const busy = { ...strategy, name: 'busy', rules: busyRules, compiledRules: compileRules(busyRules).compiled };
  for (const ms of [markets(), markets().reverse()]) {
    const prepared = prepare(ms, [busy], engine);
    // A deep account: the size always fits, so only the one-position rule can keep a setup from entering.
    const res = runEngine(ms, [busy], { ...engine, prepared, account: { ...account, max_loss: 1e6 } });
    let checked = 0;
    for (const t of res.trades.filter(x => ['stop', 'target', 'trail'].includes(x.reason))) {
      const barMs = Date.parse(t.exitTime) - 180000; // the bar it closed in
      for (const b of prepared.books.filter(x => x.symbol !== t.symbol)) {
        const i = b.bars.findIndex(x => x.ms === barMs);
        if (i < 0 || !b.setupAt(i)) continue;
        const when = new Date(barMs + 180000);
        const h = when.getUTCHours();
        if (h >= 19 && h <= 23) continue; // keep clear of end of day and the daily break
        // A market listed before it may take that bar first (one position at a time): its trade fills at the next open.
        if (res.trades.some(x => x.symbol !== b.symbol && x.entryTime === t.exitTime)) continue;
        checked += 1;
        // It fills at the next bar's open: the close of the exit bar.
        assert.ok(res.trades.some(x => x.symbol === b.symbol && x.entryTime === t.exitTime), `${b.symbol} setup at ${b.bars[i].t}, the bar ${t.symbol}'s trade ${t.reason}ped out (order ${ms.map(m => m.symbol)})`);
      }
    }
    assert.ok(checked > 0, `order ${ms.map(m => m.symbol)}: some setup fell on another market's exit bar`);
  }
});

test('trade stream: trading days are every market\'s, not the first market\'s', () => {
  const early = { symbol: 'MNQ', bars: series(8, 5), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 };
  const late = { symbol: 'MES', bars: series(8, 9, 5000, 14), tickSize: 0.25, tickValue: 1.25, feesPerSide: 0.37 };
  const daysOf = markets => ({ days: tradingDays(prepare(markets, [strategy], engine).books) });
  const one = daysOf([early]);
  const both = daysOf([early, late]);
  assert.ok(both.days.length > one.days.length);
  assert.deepStrictEqual(both.days, [...both.days].sort((a, b) => a - b), 'in order');
  assert.strictEqual(new Set(both.days).size, both.days.length, 'no day twice');
  assert.ok(both.days[both.days.length - 1] > one.days[one.days.length - 1], 'the later market\'s days are in');
  // Overlapping markets add no duplicates.
  assert.deepStrictEqual(tradingDays([{ bars: early.bars.map(b => ({ ms: Date.parse(b.t) })) }, { bars: early.bars.map(b => ({ ms: Date.parse(b.t) })) }]), one.days);
});
