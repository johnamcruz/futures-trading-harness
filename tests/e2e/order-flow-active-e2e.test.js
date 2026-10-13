'use strict';

/**
 * The order-flow strategies the owner activated (ofi, ofi_absorption, value_area; status active, for
 * replay and live), end to end through the entry points an LLM uses (separate processes, as in a
 * session): on bars that carry the broker's flow fields, `mtf.js --record` and `strategies.js scan
 * --record` write the gate's records, the plan goes in the journal, and the order goes through the
 * order-gate hook. Each is let through as an active strategy (value_area on a short, the side its constructed
 * session sets up). Without the flow fields (the broker's flow off) their flow conditions are false: the same
 * prices give no signal, so the same order is refused for having no trigger, never for a paper status.
 * value_area confirms by flow OR a range expansion on volume (ported as written), so without flow its
 * expansion branch still fires on a wide, heavy bar. Inside the policy strategies the same holds: value_area is a setup prop_portfolio trades, and
 * prop_flow_1m (active too) takes ofi's and ofi_absorption's setups, each passing the gate's prop checks.
 * Reverting any of them to paper fails these tests.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadStrategies, scan } = require('../../scripts/lib/trading/strategies');
const { profileSeries } = require('../../scripts/lib/trading/volume-profile');
const { createPropHooks } = require('../../scripts/lib/prop/live-runner');
const prop = require('../../scripts/lib/trading/prop-state');
const { accountNamed } = require('../../scripts/lib/trading/accounts');
const { liveSpecs } = require('../../scripts/lib/trading/broker-specs');
const { buildSignals, writeSignals } = require('../../scripts/lib/trading/signal-state');
const { FAKE_BROKERS, tmpDir, writeJournal, recordBrokerSpecs } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const M = 60000;
const S = 3 * M;
const STRATS = Object.fromEntries(loadStrategies(ROOT, {}).strategies.map(s => [s.name, s]));

const node = (args, env, input) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, input });

/** The broker's flow on a bar, as the ofi documents name it: the bar's imbalance and its 3- and 5-bar windows. */
const flow = (one, three = one, five = one) => ({ flow: { ofiTrade: one, complete: true, windows: { 3: { ofiTrade: three }, 5: { ofiTrade: five } } } });
const T1 = Date.UTC(2026, 9, 6, 22, 0); // 18:00 ET, 2026-10-06: the session's open
const QUIET = 1030; // to 11:10 ET 2026-10-07: four completed 4-hour candles, so the trend rule has its 4-hour read

/**
 * 1-minute bars: QUIET bars drifting up on 100 contracts (a mild uptrend, so a long is with the trend), then 5 that
 * move `dir` 2 points each on heavy volume; `flowOf(k, burst)` gives bar k's broker fields.
 */
function oneMinute(dir, flowOf) {
  const out = [];
  let c = 20000;
  for (let k = 0; k < QUIET + 5; k += 1) {
    const burst = k >= QUIET;
    const o = c;
    c = burst ? c + 2 * dir : c + (k % 2 ? 0.5 : -0.25);
    out.push({ t: new Date(T1 + k * M).toISOString(), o, h: Math.max(o, c) + 0.5, l: Math.min(o, c) - 0.5, c, v: burst ? 400 : 100, ...(flowOf(k, burst) || {}) });
  }
  return out;
}

/** ofi: buying flow at 1, 3 and 5 minutes under a rising price. */
const ofiBars = withFlow => oneMinute(1, (k, burst) => (withFlow ? flow(burst ? 0.6 : 0) : null));

/** ofi_absorption: 5 bars of heavy selling that hold the price, the last one turning up on buying. */
function absorptionBars(withFlow) {
  const last = QUIET + 4;
  const bars = oneMinute(0, (k, burst) => (withFlow ? flow(burst ? (k === last ? 0.4 : -0.5) : 0, 0, burst ? -0.4 : 0) : null));
  bars[last] = { ...bars[last], c: bars[last - 1].c + 0.5, h: bars[last - 1].c + 1 };
  return bars;
}

/**
 * value_area (3-minute): a balanced prior RTH day, then at 10:03 ET a rally to its POC from below that closes near
 * its low: a rejection short confirmed only by the broker's selling flow (no range expansion). With `expansion`,
 * the rejection bar is wide (3 points over the POC to 6 under it) on 4x volume: a range expansion that confirms on its own.
 */
function valueAreaBars(withFlow, { expansion = false } = {}) {
  const bar = (ms, o, c, v = 100) => ({ t: new Date(ms).toISOString(), o, h: Math.max(o, c) + 0.5, l: Math.min(o, c) - 0.5, c, v });
  const day1 = Date.UTC(2026, 9, 6, 13, 30); // 09:30 ET, 2026-10-06
  const day2 = day1 + 864e5;
  const bars = [bar(day1 - S, 100, 100)];
  for (let k = 0; k < 130; k += 1) {
    const c = 100 + 40 * Math.sin(k / 6) * (k % 2 ? 1 : 0.3);
    bars.push(bar(day1 + k * S, bars.at(-1).c, c, 100 + Math.round(200 * Math.exp(-((c - 100) ** 2) / 200))));
  }
  const poc = profileSeries(bars.concat([bar(day2 - S, 100, 100)]), 'prior_rth').profile.at(-1).poc;
  for (let k = 0; k < 30; k += 1) bars.push(bar(day2 - (30 - k) * S, poc - 4, poc - 4));
  for (let k = 0; k < 10; k += 1) bars.push({ ...bar(day2 + k * S, poc - 4, poc - 3.75), v: 100 });
  const f3 = x => (withFlow ? { flow: { windows: { 3: { ofiTrade: x } } } } : {});
  bars.push({ t: new Date(day2 + 10 * S).toISOString(), v: 100, o: poc - 3, h: poc - 2, l: poc - 3.25, c: poc - 3, ...f3(-0.1) });
  bars.push({ t: new Date(day2 + 11 * S).toISOString(), v: expansion ? 400 : 100, o: poc - 1, h: expansion ? poc + 3 : poc + 0.05, l: expansion ? poc - 6 : poc - 2.5, c: poc - 2.4, ...f3(-0.34) });
  return bars;
}

const CASES = [
  { name: 'ofi', tf: 1, side: 'long', bars: ofiBars },
  { name: 'ofi_absorption', tf: 1, side: 'long', bars: absorptionBars },
  { name: 'value_area', tf: 3, side: 'short', bars: valueAreaBars, plain: ' and no range expansion' },
];

/** Records the multi-timeframe read and the scan at the last bar's close, plans, and sends the order through the hook. */
function throughTheGate(c, withFlow, { symbol = 'MNQ', before = () => {} } = {}) {
  const contract = `${symbol}:2026-12`;
  const bars = c.bars(withFlow);
  const home = tmpDir();
  recordBrokerSpecs(home); // the broker's tick specs, as the translator records them at the contract lookup
  const file = path.join(home, `${symbol}-${c.tf}m.json`);
  fs.writeFileSync(file, JSON.stringify({ contractId: contract, bars }));
  const now = new Date(Date.parse(bars.at(-1).t) + c.tf * M + 30000).toISOString(); // the cycle, 30 s after the bar closed
  const journal = writeJournal(home, []);
  before(home, new Date(now));
  const env = {
    FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_JOURNAL: journal, NODE_ENV: 'test', FTH_TEST_NOW: now, FTH_AUTONOMOUS: '',
    FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'),
    FTH_KILL_SWITCH_FILE: path.join(home, 'STOP'), FTH_GATE_LOG: path.join(home, 'gate.jsonl'), CLAUDE_PLUGIN_ROOT: ROOT,
  };
  const mtf = node([path.join(ROOT, 'scripts', 'mtf.js'), file, '--record', '--symbol', symbol], env);
  assert.strictEqual(mtf.status, 0, mtf.stderr);
  const sc = node([path.join(ROOT, 'scripts', 'strategies.js'), 'scan', file, '--symbol', symbol, '--now', now, '--record'], env);
  assert.strictEqual(sc.status, 0, sc.stderr);
  const r = JSON.parse(sc.stdout).find(x => x.name === c.name);
  assert.ok(r, `${c.name} is scanned`);
  // The order a trade-executor sends for the setup these bars make (a 4-point stop: 16 ticks).
  const sign = c.side === 'long' ? 1 : -1;
  const stop = (Math.round(bars.at(-1).c * 4) / 4 - sign * 4).toFixed(2); // on the 0.25 tick
  fs.appendFileSync(journal, `${JSON.stringify({ ts: now, kind: 'plan', contractId: contract, tags: [`setup:${c.name}`, symbol], text: `${c.name} ${c.side}, stop ${stop}` })}\n`);
  const order = {
    accountId: 1, contractId: contract, side: sign > 0 ? 'buy' : 'sell', type: 'market', size: 1,
    stopLossBracket: { ticks: 16, type: 'stop' }, rationale: `setup:${c.name} ${c.side} trigger on the ${bars.at(-1).t} bar, stop ${stop}`,
  };
  const res = node([path.join(ROOT, 'scripts', 'hooks', 'run-with-flags.js'), 'pre:trading:order-gate', 'scripts/hooks/trading-order-gate.js', 'minimal,standard,strict'],
    env, JSON.stringify({ tool_name: 'mcp__broker__place_order', tool_input: order }));
  return { r, res };
}

for (const c of CASES) {
  test(`${c.name} is active: on bars carrying the broker's flow it fires ${c.side} and the gate lets its entry through`, () => {
    assert.strictEqual(STRATS[c.name].status, 'active', `${c.name} is active (the owner's decision), for replay and live`);
    const { r, res } = throughTheGate(c, true);
    assert.ok(r.candidate && r.direction === c.side, JSON.stringify(r).slice(0, 400));
    assert.strictEqual(res.status, 0, `${c.name} was refused:\n${res.stderr}`);
  });

  test(`${c.name} without the broker's flow${c.plain || ''}: no signal, so no entry (refused for no trigger, not for its status)`, () => {
    const { r, res } = throughTheGate(c, false);
    assert.ok(!r.candidate && !r.direction, JSON.stringify(r).slice(0, 400));
    assert.strictEqual(res.status, 2);
    assert.match(res.stderr, /\[trigger-fired\]/);
    assert.doesNotMatch(res.stderr, /\[strategy\]|status "paper"/, 'refused for the missing signal only: the strategy itself is active');
  });
}

test('value_area without the broker\'s flow but on a range expansion: its expansion branch confirms, and the gate lets it through', () => {
  const c = { name: 'value_area', tf: 3, side: 'short', bars: () => valueAreaBars(false, { expansion: true }) };
  const { r, res } = throughTheGate(c, false);
  assert.ok(r.candidate && r.direction === 'short', JSON.stringify(r).slice(0, 400));
  const confirm = r.rules.short[3];
  assert.deepStrictEqual(confirm.parts.map(x => x.ok), [false, true], 'the flow condition is false without flow; the expansion confirms');
  assert.strictEqual(res.status, 0, `refused:\n${res.stderr}`);
});

test('prop_flow_1m covers MNQ and NQ only: while an attempt runs, an ofi or ofi_absorption setup on MES, MYM or M2K is refused (fails closed)', () => {
  assert.deepStrictEqual(STRATS.prop_flow_1m.instruments, ['MNQ', 'NQ']);
  const account = accountNamed(ROOT, STRATS.prop_flow_1m.account, {});
  const attempt = (home, now) => prop.startAttempt(home, account, new Date(now.getTime() - 3600000));
  for (const symbol of ['MES', 'MYM', 'M2K']) {
    for (const name of ['ofi', 'ofi_absorption']) {
      assert.ok(STRATS[name].instruments.includes(symbol), `${name} lists ${symbol}`);
      const { r, res } = throughTheGate({ name, tf: 1, side: 'long', bars: name === 'ofi' ? ofiBars : absorptionBars }, true, { symbol, before: attempt });
      assert.ok(r.candidate, `${name} fires on ${symbol}`);
      assert.strictEqual(res.status, 2, `${name} on ${symbol}`);
      assert.match(res.stderr, /attempt is running: only a policy strategy that trades it/);
    }
  }
});

/**
 * The runner's prop hooks on the repo's own strategies and account (prop_portfolio and prop_flow_1m both name the
 * same one): an attempt running, a snapshot taken at `now`, then the screen of a real scan of `bars`, the
 * signal record the gate ties the verdict to, and the gate's prop checks (prop-state.js propViolations, as the
 * order gate runs them) on the entry the verdict allows.
 */
async function throughThePolicy(bars, tf) {
  const home = tmpDir();
  recordBrokerSpecs(home, { roots: ['MNQ', 'NQ'] });
  const registry = loadStrategies(ROOT, {}).strategies;
  const policies = ['prop_portfolio', 'prop_flow_1m'].map(n => registry.find(s => s.name === n));
  assert.strictEqual(policies[0].account, policies[1].account, 'both policies trade one account');
  const account = accountNamed(ROOT, policies[0].account, {});
  const now = new Date(Date.parse(bars.at(-1).t) + tf * M + 30000);
  prop.startAttempt(home, account, new Date(now.getTime() - 3600000));
  const client = {
    async accountBalance() { return 100000; },
    async accountState() { return { positions: [], orders: [] }; },
    async fillsSince() { return []; },
  };
  const hooks = createPropHooks({ root: ROOT, env: {}, home, client, accountId: '7', strategies: () => registry, journal: () => [] });
  await hooks.snapshot(now);
  const results = scan(registry.filter(s => s.timeframe === `${tf}m`), { bars }, { symbol: 'MNQ', now, selected: ['MNQ'] });
  writeSignals(home, buildSignals(results, { symbol: 'MNQ', bar: bars.at(-1), stepMs: tf * M, now }));
  const screened = hooks.screen(results, { symbol: 'MNQ', contractId: 'MNQ', bars, now });
  const gate = (name, v) => prop.propViolations(home, {
    strategy: registry.find(s => s.name === name), account, now, strategies: registry, specOf: liveSpecs({ FTH_HOME: home }), selected: ['MNQ'],
    input: { contractId: 'MNQ', side: v && v.direction === 'short' ? 'sell' : 'buy', size: v ? v.maxSize : 1, stopLossBracket: { ticks: v ? v.stopTicks : 16, type: 'stop' } },
  });
  return { home, results, screened, gate, verdict: name => prop.latestVerdict(home, name, 'MNQ') };
}

test('value_area trades as active inside prop_portfolio: its setup is the policy\'s, with a verdict the gate lets through', async () => {
  const policy = loadStrategies(ROOT, {}).strategies.find(s => s.name === 'prop_portfolio');
  assert.ok(policy.strategies.includes('value_area') && policy.status === 'active');
  const { screened, gate, verdict } = await throughThePolicy(valueAreaBars(true), 3);
  const row = screened.find(r => r.name === 'prop_portfolio');
  assert.deepStrictEqual([row.candidate, row.component, row.direction], [true, 'value_area', 'short'], JSON.stringify(row));
  assert.strictEqual(screened.find(r => r.name === 'value_area').note, 'traded through prop_portfolio', 'never passed over as paper');
  const v = verdict('prop_portfolio');
  assert.deepStrictEqual([v.component, v.action, v.contract], ['value_area', 'full', 'MNQ']);
  assert.deepStrictEqual(gate('prop_portfolio', v), [], 'the gate\'s prop checks let the verdict\'s entry through');
  // prop_flow_1m also trades that account on MNQ, but on 1-minute bars: on this 3-minute bar it has no setup and no verdict.
  assert.deepStrictEqual([screened.find(r => r.name === 'prop_flow_1m').candidate, verdict('prop_flow_1m')], [false, null]);
});

for (const [name, bars] of [['ofi', ofiBars], ['ofi_absorption', absorptionBars]]) {
  test(`prop_flow_1m is active: it takes ${name}'s setup on bars carrying the broker's flow, and the gate lets the entry through; without flow, nothing`, async () => {
    assert.strictEqual(STRATS.prop_flow_1m.status, 'active');
    const { screened, gate, verdict } = await throughThePolicy(bars(true), 1);
    const row = screened.find(r => r.name === 'prop_flow_1m');
    assert.deepStrictEqual([row.candidate, row.component, row.direction], [true, name, 'long'], JSON.stringify(row));
    const v = verdict('prop_flow_1m');
    assert.deepStrictEqual([v.component, v.action], [name, 'full']);
    assert.deepStrictEqual(gate('prop_flow_1m', v), []);
    // prop_portfolio (3-minute) has no setup on a 1-minute bar: no verdict, so the gate refuses an entry in its name.
    assert.strictEqual(verdict('prop_portfolio'), null);
    assert.match(gate('prop_portfolio', v).map(x => x.message).join(' '), /setup:prop_portfolio: no verdict for MNQ/);

    // The same prices without the broker's flow: no setup, no verdict, and the gate refuses.
    const plain = await throughThePolicy(bars(false), 1);
    assert.strictEqual(plain.screened.find(r => r.name === 'prop_flow_1m').candidate, false);
    assert.strictEqual(plain.verdict('prop_flow_1m'), null);
    assert.match(plain.gate('prop_flow_1m', null).map(x => x.message).join(' '), /setup:prop_flow_1m: no verdict for MNQ/);
  });
}
