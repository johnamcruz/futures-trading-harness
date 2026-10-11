'use strict';

// Several markets, one prop account: training configs, the env's trading days, the engine's
// one-position-at-a-time rule, and the bundle's markets.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { compileRules } = require('../../scripts/lib/trading/rules');
const { loadConfig } = require('../../scripts/lib/trading/config');
const { runEngine } = require('../../scripts/lib/backtest/engine');
const envlib = require('../../scripts/lib/rl/challenge-env');
const { envFromConfig } = require('../../scripts/lib/rl/env-config');
const { bundleMismatch, trainedSymbols } = require('../../scripts/lib/rl/policy-bundle');
const { optionsFromParams } = require('../../scripts/lib/trading/volume-profile');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'tests', 'fixtures', 'data');

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
  // market at that very bar is asked, whichever market is listed first.
  const { prepare } = require('../../scripts/lib/backtest/engine');
  // A strategy that fires on most bars, so setups fall on the other market's exit bars.
  const busyRules = { long: ['close > open'], short: ['close < open'] };
  const busy = { ...strategy, name: 'busy', rules: busyRules, compiledRules: compileRules(busyRules).compiled };
  for (const ms of [markets(), markets().reverse()]) {
    const prepared = prepare(ms, [busy], engine);
    const asked = [];
    // A deep account: the size always fits, so only the one-position rule can keep a setup from being asked.
    const res = runEngine(ms, [busy], { ...engine, prepared, account: { ...account, max_loss: 1e6 }, policy: { decide: (kind, _o, info) => { asked.push(`${kind} ${info.symbol} ${info.t}`); return kind === 'setup' ? 'full' : 'hold'; } } });
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
        assert.ok(asked.includes(`setup ${b.symbol} ${b.bars[i].t}`), `${b.symbol} setup at ${b.bars[i].t}, the bar ${t.symbol}'s trade ${t.reason}ped out (order ${ms.map(m => m.symbol)})`);
      }
    }
    assert.ok(checked > 0, `order ${ms.map(m => m.symbol)}: some setup fell on another market's exit bar`);
  }
});

test('engine: with a policy, a setup on another market is not even asked while a trade is open', () => {
  const asked = [];
  const res = runEngine(markets(), [strategy], {
    ...engine, account, policy: { decide: (kind, _obs, info) => { asked.push({ kind, symbol: info.symbol, t: info.t }); return kind === 'setup' ? 'full' : 'hold'; } },
  });
  const ms = t => Date.parse(t);
  for (const a of asked.filter(x => x.kind === 'setup')) {
    // The bar's close is 3 minutes after its open time; an open trade on the other market at that close means no question.
    const close = ms(a.t) + 180000;
    const open = res.trades.find(t => t.symbol !== a.symbol && ms(t.entryTime) <= close && close < ms(t.exitTime));
    assert.ok(!open, `asked on ${a.symbol} at ${a.t} while ${open && open.symbol} was open`);
  }
});

test('challenge env: trading days are every market\'s, not the first market\'s', () => {
  const early = { symbol: 'MNQ', bars: series(8, 5), tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 };
  const late = { symbol: 'MES', bars: series(8, 9, 5000, 14), tickSize: 0.25, tickValue: 1.25, feesPerSide: 0.37 };
  const one = envlib.createEnv({ markets: [early], strategies: [strategy], account, engine });
  const both = envlib.createEnv({ markets: [early, late], strategies: [strategy], account, engine });
  assert.ok(both.days.length > one.days.length);
  assert.deepStrictEqual(both.days, [...both.days].sort((a, b) => a - b), 'in order');
  assert.strictEqual(new Set(both.days).size, both.days.length, 'no day twice');
  assert.ok(both.days[both.days.length - 1] > one.days[one.days.length - 1], 'the later market\'s days are in');
  // Overlapping markets add no duplicates.
  assert.deepStrictEqual(envlib.tradingDays([{ bars: early.bars.map(b => ({ ms: Date.parse(b.t) })) }, { bars: early.bars.map(b => ({ ms: Date.parse(b.t) })) }]), one.days);
});

const build = cfg => envFromConfig({ name: 'multi', strategy: 'prop_portfolio', ...cfg }, { root: ROOT, baseDir: DATA, env: {}, hashData: false });

test('env-config: symbols trains on several markets; symbol still works', () => {
  const { meta, env } = build({ symbols: ['MNQ', 'MES'], data: { MNQ: 'bars.csv', MES: 'bars.csv' } });
  assert.deepStrictEqual(meta.symbols, ['MNQ', 'MES']);
  assert.deepStrictEqual(env.markets.map(m => m.symbol), ['MNQ', 'MES']);
  assert.deepStrictEqual(meta.data.map(d => d.symbol), ['MNQ', 'MES']);
  assert.strictEqual(meta.symbol, undefined, 'the list, not one symbol');
  assert.deepStrictEqual(build({ symbol: 'MNQ', data: { MNQ: 'bars.csv' } }).meta.symbols, ['MNQ']);
});

test('env-config: each market once, traded by the strategy, scanned by its strategies, with data', () => {
  const data = { MNQ: 'bars.csv', MES: 'bars.csv', NQ: 'bars.csv', CL: 'bars.csv' };
  assert.throws(() => build({ symbol: 'MNQ', symbols: ['MNQ'], data }), /symbol, symbols: use one/);
  assert.throws(() => build({ symbols: [], data }), /symbols: the data's contract roots/);
  assert.throws(() => build({ symbols: 'MNQ', data }), /symbols: the data's contract roots/);
  assert.throws(() => build({ symbols: ['mnq'], data }), /symbols: the data's contract roots/);
  assert.throws(() => build({ symbols: ['MNQ', 'MNQ'], data }), /MNQ and MNQ are the same market/);
  assert.throws(() => build({ symbols: ['MNQ', 'NQ'], data }), /MNQ and NQ are the same market/);
  assert.throws(() => build({ symbols: ['MNQ', 'CL'], data }), /trades .*, not CL/);
  assert.throws(() => build({ symbols: ['NQ'], data }), /none of prop_portfolio's strategies scans NQ; key the data by the root they list/);
  assert.throws(() => build({ symbols: ['MNQ', 'MES'], data: { MNQ: 'bars.csv' } }), /data\.MES/);
});

test('bundle: a live market is accepted when its index is among the trained ones, refused otherwise', () => {
  const strategy = { name: 'p', strategies: ['a'], account: 'acct', timeframe: '3m', sizing: null, contracts: 'mini', exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } };
  const meta = { strategy: 'p', components: ['a'], account: 'acct', timeframe: 3, sizing: null, contracts: 'mini', exit: strategy.exit, profile: optionsFromParams({}) };
  const four = { ...meta, symbols: ['MNQ', 'MES', 'MYM', 'M2K'] };
  for (const r of ['MNQ', 'NQ', 'MES', 'ES', 'MYM', 'YM', 'M2K', 'RTY']) assert.strictEqual(bundleMismatch(four, strategy, r), null, r);
  assert.match(bundleMismatch(four, strategy, 'GC'), /was trained on MNQ, MES, MYM, M2K, not GC/);
  // A bundle trained on the Nasdaq alone still refuses the S&P, in either form.
  assert.match(bundleMismatch({ ...meta, symbols: ['MNQ'] }, strategy, 'ES'), /trained on MNQ, not ES/);
  assert.match(bundleMismatch({ ...meta, symbol: 'MNQ' }, strategy, 'ES'), /trained on MNQ, not ES/, 'an older one-symbol bundle');
  assert.strictEqual(bundleMismatch({ ...meta, symbol: 'MNQ' }, strategy, 'NQ'), null, 'an older bundle keeps working on its index');
  // A malformed list trains on nothing usable: every market refused (fails closed).
  for (const bad of ['MNQ', null, {}, [], [7]]) assert.match(bundleMismatch({ ...meta, symbols: bad }, strategy, 'MNQ'), /not MNQ/, JSON.stringify(bad));
  assert.deepStrictEqual(trainedSymbols({ symbols: ['MNQ', 'MES'], symbol: 'MNQ' }), ['MNQ', 'MES'], 'the list wins');
  assert.strictEqual(trainedSymbols({}), null);
  assert.match(bundleMismatch(meta, strategy, 'MNQ'), /records no market/, 'a bundle with no market recorded fails closed');
  // The timeframe stays bound: a 3m bundle never trades a 1m strategy.
  assert.match(bundleMismatch(four, { ...strategy, timeframe: '1m' }, 'MNQ'), /trained on 3m bars, not 1m/);
});
