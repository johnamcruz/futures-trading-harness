'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { compileRules } = require('../../scripts/lib/trading/rules');
const { loadConfig } = require('../../scripts/lib/trading/config');
const { runEngine } = require('../../scripts/lib/backtest/engine');
const { OBS_DIM, OBS_FIELDS, observationFields } = require('../../scripts/lib/rl/observation');
const envlib = require('../../scripts/lib/rl/challenge-env');
const { serve } = require('../../scripts/lib/rl/env-server');
const { loadBundle, checkBundle, gateFailures, BUNDLE_FORMAT, BUNDLE_VERSION } = require('../../scripts/lib/rl/policy-bundle');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');

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
const engine = { timeframe: 3, gate: false, gateConfig: loadConfig({}), window: 160 };

test('a run with an account is a prop challenge: sized from the cushion, ends on pass, blow, or timeout', () => {
  const bars = series(30);
  const res = runEngine([market(bars)], [strategy()], { ...engine, account: account(), start: Date.parse('2026-01-08T00:00:00Z') });
  assert.ok(['passed', 'blown', 'timeout'].includes(res.combine.status), res.combine.status);
  assert.ok(res.trades.length > 0);
  // 0.2 x cushion 1000 = $200 budget per trade.
  for (const t of res.trades.slice(0, 3)) assert.ok(t.size * (t.risk / 0.25) * 0.5 <= 200 * 1.5 + 1e-9, `size ${t.size} risk ${t.risk}`);
  // Sizing to the whole cushion still leaves a planned stop short of the floor.
  const whole = { ...engine, account: account({ max_loss: 200, daily_loss_soft: 0, max_contracts: { MNQ: 1000 } }), sizing: { cushion_frac: 1, min_size_guard: 10 }, start: Date.parse('2026-01-08T00:00:00Z') };
  const sized = runEngine([market(bars)], [strategy()], whole);
  assert.notStrictEqual(sized.combine.status, 'blown');
  const first = sized.trades[0];
  assert.ok(first.size * ((first.risk / 0.25) * 0.5 + 0.74) < 200, 'the first trade risks less than the whole $200 cushion');
  // A stop that fills far past its price (slippage, a gap) blows inside the bar, liquidated at the floor.
  const tiny = runEngine([market(bars)], [strategy()], { ...whole, slippageTicks: 400 });
  assert.strictEqual(tiny.combine.status, 'blown');
  assert.strictEqual(tiny.trades[tiny.trades.length - 1].reason, 'blow');
  assert.ok(tiny.combine.balance <= tiny.combine.floor + 1e-9);
});

test('the policy hook decides at setups and past the ratchet; skip means no trade, half halves the size', () => {
  const bars = series(30);
  const opts = { ...engine, account: account(), start: Date.parse('2026-01-08T00:00:00Z') };
  const seen = [];
  const skip = runEngine([market(bars)], [strategy()], { ...opts, policy: { decide: (kind, obs) => { seen.push([kind, obs.length]); return kind === 'setup' ? 'skip' : 'hold'; } } });
  assert.strictEqual(skip.trades.length, 0);
  assert.ok(seen.length > 0 && seen.every(([k, n]) => k === 'setup' && n === OBS_DIM));
  const full = runEngine([market(bars)], [strategy()], { ...opts, policy: { decide: kind => (kind === 'setup' ? 'full' : 'hold') } });
  const half = runEngine([market(bars)], [strategy()], { ...opts, policy: { decide: kind => (kind === 'setup' ? 'half' : 'hold') } });
  assert.strictEqual(half.trades[0].size, Math.max(1, Math.floor(full.trades[0].size / 2)));
  // A wide give-back keeps trades open past the ratchet, where the policy is asked.
  const wide = strategy({ exit: { trail_activate_r: 2, trail_giveback_r: 2 } });
  const closer = runEngine([market(bars)], [wide], { ...opts, policy: { decide: kind => (kind === 'setup' ? 'full' : 'close') } });
  assert.ok(closer.decisions.some(d => d.kind === 'position'), 'asked in a trade past the ratchet');
  assert.ok(closer.trades.some(t => t.reason === 'policy'));
  for (const t of closer.trades.filter(x => x.reason === 'policy')) assert.ok(t.mfeR >= 2, 'never closed before the ratchet');
});

/** Run the env server over request lines; returns the parsed replies. */
function talk(env, requests) {
  const lines = requests.map(r => (typeof r === 'string' ? r : JSON.stringify(r)));
  const out = [];
  serve({ env, meta: { account: 'mini' }, readLine: () => (lines.length ? lines.shift() : null), writeLine: s => out.push(JSON.parse(s)) });
  return out;
}

/** A random tanh network in the bundle format. */
function network(seed = 1, hidden = [8], obsDim = OBS_DIM) {
  const r = rng(seed);
  const sizes = [obsDim, ...hidden, 3];
  return {
    obsDim, actionN: 3, hidden,
    actor: { sizes, layers: sizes.slice(1).map((n, l) => ({ W: Array.from({ length: n * sizes[l] }, () => r() - 0.5), b: Array.from({ length: n }, () => 0) })) },
    normalizer: { mean: new Array(obsDim).fill(0), var: new Array(obsDim).fill(1), count: 10, clip: 5 },
  };
}

test('the env server: an episode is the backtest paused at each decision, rewards sum to the balance change, the trades won and lost, and the outcome', () => {
  const bars = series(40);
  const wide = strategy({ exit: { trail_activate_r: 2, trail_giveback_r: 2 } });
  const e = envlib.createEnv({ markets: [market(bars)], strategies: [wide], account: account(), engine });
  const [info, { starts }] = talk(e, [{ cmd: 'info' }, { cmd: 'starts', from: '2026-01-08', to: '2026-02-10' }]);
  assert.deepStrictEqual(info.obsFields, OBS_FIELDS);
  assert.strictEqual(info.actionN, 3);
  assert.strictEqual(info.bundleFormat, BUNDLE_FORMAT);
  assert.deepStrictEqual(info.promotionGate, { minPassRate: 0.4, maxBlows: 0, minAttempts: 20, minMonths: 2 });
  assert.ok(starts.length > 5);
  // Take every setup at full size, close every trade past the ratchet.
  const policy = { decide: kind => (kind === 'setup' ? 'full' : 'close') };
  const direct = envlib.runAttempt(e, starts[0], Infinity, policy);
  assert.ok(direct.decisions.some(d => d.kind === 'position'));
  const requests = [{ cmd: 'reset', start: starts[0] }, ...direct.decisions.map(d => ({ cmd: 'step', action: d.kind === 'setup' ? 2 : 1 })), { cmd: 'close' }];
  const replies = talk(e, requests);
  assert.strictEqual(replies.length, direct.decisions.length + 1);
  replies.slice(0, -1).forEach((m, k) => {
    assert.strictEqual(m.kind, direct.decisions[k].kind);
    assert.strictEqual(m.obs.length, OBS_DIM);
    assert.deepStrictEqual(m.mask, envlib.MASKS[m.kind]);
    assert.strictEqual(m.reward === undefined, k === 0);
  });
  const end = replies[replies.length - 1];
  assert.strictEqual(end.done, true);
  assert.strictEqual(end.outcome.status, direct.status);
  assert.strictEqual(end.outcome.trades, direct.trades.length);
  const total = replies.slice(1).reduce((a, m) => a + m.reward, 0);
  const wins = direct.trades.filter(t => t.net > 0).length;
  const losses = direct.trades.filter(t => t.net < 0).length;
  assert.deepStrictEqual([end.outcome.wins, end.outcome.losses], [wins, losses]);
  // + 0.5 per winning trade, - 0.5 per losing one (DEFAULT_REWARD), on top of the balance and the outcome.
  const expected = (direct.balance - 50000) / 1000 + 0.5 * wins - 0.5 * losses + envlib.outcomeReward(e, direct);
  assert.ok(Math.abs(total - expected) < 1e-9, `${total} vs ${expected}`);
  // A masked action is refused and the decision stands; another request abandons the episode.
  const posAt = direct.decisions.findIndex(d => d.kind === 'position');
  const steps = direct.decisions.slice(0, posAt).map(d => ({ cmd: 'step', action: d.kind === 'setup' ? 2 : 1 }));
  const r2 = talk(e, [{ cmd: 'reset', start: starts[0] }, ...steps, { cmd: 'step', action: 2 }, { cmd: 'step', action: 7 }, { cmd: 'info' }, 'not json', { cmd: 'step', action: 0 }, { cmd: 'nope' }]);
  const tail = r2.slice(posAt + 1);
  assert.match(tail[0].error, /not allowed for a position decision/);
  assert.match(tail[1].error, /not allowed/);
  assert.deepStrictEqual(tail[2].obsFields, OBS_FIELDS, 'info answered after the episode was abandoned');
  assert.match(tail[3].error, /not JSON/);
  assert.match(tail[4].error, /no episode is running/);
  assert.match(tail[5].error, /unknown cmd/);
});

test('the env server evaluates a network with the harness inference; rules-only evaluation aggregates by month', () => {
  const bars = series(40);
  const e = envlib.createEnv({ markets: [market(bars)], strategies: [strategy()], account: account(), engine });
  const starts = e.starts(Date.parse('2026-01-08T00:00:00Z'), Date.parse('2026-02-10T00:00:00Z')).slice(0, 6);
  const [rules, withNet] = talk(e, [{ cmd: 'evaluate', starts, end: null, network: null }, { cmd: 'evaluate', starts, end: '2026-03-01', network: network() }]);
  for (const r of [rules, withNet]) {
    assert.strictEqual(r.attempts, 6);
    assert.ok(r.wins <= r.trades && (r.trades === 0 || Math.abs(r.winRate - r.wins / r.trades) < 0.001));
    assert.strictEqual(r.passed + r.blown + r.timeout + r.unfinished, 6);
    assert.strictEqual(Object.values(r.months).reduce((a, m) => a + m.attempts, 0), 6);
  }
  assert.deepStrictEqual(rules, envlib.evaluate(e, starts, Infinity, null));
});

test('bundles: live trading needs zero blows in every out-of-sample month and at least a 40% pass rate; backtests may load a candidate', () => {
  const months = { '2026-03': { attempts: 10, blown: 0, passRate: 0.5 }, '2026-04': { attempts: 10, blown: 0, passRate: 0.4 } };
  const oos = { attempts: 20, passed: 9, blown: 0, passRate: 0.45, months };
  const bundle = {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, name: 'mini_policy', strategy: 'prop_trendy', components: ['trendy'], account: 'mini', strategies: ['trendy'],
    obsFields: observationFields(['trendy']), actions: envlib.ACTIONS, network: network(1, [8], OBS_DIM + 1), gate: { minPassRate: 0.4, maxBlows: 0 }, oos, validated: true,
  };
  assert.deepStrictEqual(checkBundle(bundle), []);
  assert.deepStrictEqual(gateFailures(oos), []);
  const oneBlow = { ...oos, blown: 1, months: { ...months, '2026-04': { ...months['2026-04'], blown: 1 } } };
  assert.match(gateFailures(oneBlow)[0], /2026-04.*zero blows/);
  assert.match(checkBundle({ ...bundle, oos: oneBlow }).join(), /not validated/, 'a blow is refused even if the bundle says validated');
  assert.match(checkBundle({ ...bundle, oos: { ...oos, passed: 7 } }).join(), /under 0.4/);
  // The exact rate decides: 333/833 rounds to 0.400 but is under 40%.
  assert.match(gateFailures({ ...oos, attempts: 833, passed: 333, passRate: 0.4 }).join(), /333\/833\) is under 0.4/);
  assert.match(gateFailures({ ...oos, attempts: 3, passed: 3 }).join(), /too small/);
  assert.match(gateFailures({ ...oos, months: { '2026-03': months['2026-03'] } }).join(), /too small/);
  assert.match(gateFailures({ attempts: 20, passed: 10, passRate: 0.5 }).join(), /malformed/, 'a missing blow count fails closed');
  assert.match(gateFailures({ ...oos, months: { ...months, '2026-04': { attempts: 10 } } }).join(), /no blow count/);
  // An optional win-rate gate, from the bundle's own gate.
  assert.deepStrictEqual(gateFailures({ ...oos, trades: 100, wins: 55 }, 0.4, 0.5), []);
  assert.match(gateFailures({ ...oos, trades: 100, wins: 45 }, 0.4, 0.5).join(), /win rate 0.45 is under 0.5/);
  assert.match(checkBundle({ ...bundle, gate: { minPassRate: 0.4, maxBlows: 0, minWinRate: 0.5 } }).join(), /win rate unknown/);
  assert.match(checkBundle({ ...bundle, gate: { minPassRate: 0.5 } }).join(), /under 0.5/, 'a raised gate is kept');
  assert.match(checkBundle({ ...bundle, gate: { minPassRate: 0.1 } }).join() || 'ok', /ok/, 'a lower gate never lowers the floor');
  assert.match(checkBundle({ ...bundle, oos: { ...oos, passed: 6 }, gate: { minPassRate: 0.1 } }).join(), /under 0.4/);
  assert.match(checkBundle({ ...bundle, validated: false }).join(), /not validated/);
  assert.deepStrictEqual(checkBundle({ ...bundle, validated: false }, { requireValidated: false }), []);
  assert.match(checkBundle({ ...bundle, version: 1 }).join(), /version/);

  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'mini_policy.json'), JSON.stringify(bundle));
  const loaded = loadBundle(ROOT, 'mini_policy', { FTH_MODELS_DIRS: dir });
  assert.ok(['skip', 'half', 'full'].includes(loaded.decide('setup', new Array(OBS_DIM + 1).fill(0))));
  assert.ok(['hold', 'close'].includes(loaded.decide('position', new Array(OBS_DIM + 1).fill(0))));
  assert.match(checkBundle({ ...bundle, network: network() }).join(), /inputs for/);
  assert.match(checkBundle({ ...bundle, components: undefined }).join(), /strategy, components/);
  fs.writeFileSync(path.join(dir, 'cand.json'), JSON.stringify({ ...bundle, validated: false }));
  assert.throws(() => loadBundle(ROOT, 'cand', { FTH_MODELS_DIRS: dir }), /not validated/);
  assert.strictEqual(loadBundle(ROOT, 'cand', { FTH_MODELS_DIRS: dir }, { requireValidated: false }).meta.validated, false);
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ ...bundle, obsFields: OBS_FIELDS }));
  assert.throws(() => loadBundle(ROOT, 'old', { FTH_MODELS_DIRS: dir }), /different observation/);
  assert.throws(() => loadBundle(ROOT, '../etc', { FTH_MODELS_DIRS: dir }), /not found/);
});

test('micros and minis: a policy strategy run sizes in micros, trades minis by its contract mode, and settles each at its own tick value', () => {
  const bars = series(30);
  const acct = account({ max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 } });
  const wide = strategy({ exit: { trail_activate_r: 2, trail_giveback_r: 2 } });
  const prop = contracts => ({ strategy: { exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } }, components: ['trendy'], contracts });
  const opts = { ...engine, account: acct, sizing: { cushion_frac: 1 }, start: Date.parse('2026-01-08T00:00:00Z') };
  const seen = [];
  const policy = { decide: (kind, obs) => { seen.push(obs); return kind === 'setup' ? 'full' : 'hold'; } };
  const micro = runEngine([market(bars)], [wide], { ...opts, prop: prop('micro'), policy });
  const auto = runEngine([market(bars)], [wide], { ...opts, prop: prop('auto') });
  const mini = runEngine([market(bars)], [wide], { ...opts, prop: prop('mini') });
  assert.ok(micro.trades.length && micro.trades.every(t => t.contract === 'MNQ'));
  assert.ok(mini.trades.length && mini.trades.every(t => t.contract === 'NQ'));
  assert.ok(auto.trades.some(t => t.contract === 'NQ') || auto.trades.every(t => t.contract === 'MNQ'));
  for (const t of mini.trades) {
    // NQ: $5 a tick, $1.40 a side.
    const ticks = Math.round(((t.direction === 'long' ? 1 : -1) * (t.exit - t.entry)) / 0.25);
    assert.ok(Math.abs(t.pnl - ticks * 5 * t.size) < 1e-6 && Math.abs(t.fees - 2.8 * t.size) < 1e-6, JSON.stringify(t));
  }
  // The policy strategy's exit applies (give-back 0.5), not the component's (2), and the observation names the strategy.
  assert.ok(micro.trades.every(t => t.reason !== 'policy'));
  assert.ok(seen.length && seen.every(o => o.length === OBS_DIM + 1 && o[OBS_DIM] === 1));
});
