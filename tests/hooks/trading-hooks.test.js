'use strict';

// Integration tests: run hooks through run-with-flags.js exactly as hooks.json does.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { rootWithPolicies, FAKE_BROKERS, homeBrokers, shippedBroker, tmpDir, trendHome, writeJournal, minutesAgo, placed, entryOrder, recordBrokerSpecs, FX_GOLDEN } = require('../helpers');

// The gate's clock for these end-to-end runs: a Wednesday at 10:30 ET, inside
// market hours whenever the tests run (FTH_TEST_NOW is ignored in autonomous runs).
const TEST_NOW = '2026-10-07T14:30:00.000Z';
// The bar setup()'s signal record is for (trendHome): the bar a policy verdict must be for.
const HOOK_BAR = '2026-10-07T14:27:00Z';

const REPO = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(REPO, 'scripts', 'hooks', 'run-with-flags.js');

// A plugin root whose only strategy trades MNQ at any time, so these tests
// don't depend on the wall clock falling inside a real strategy's sessions.
const ROOT = (() => {
  const root = tmpDir();
  fs.symlinkSync(path.join(REPO, 'scripts'), path.join(root, 'scripts'));
  const dir = path.join(root, 'strategies', 'anytime');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'STRATEGY.md'), [
    '---', 'name: anytime', 'description: Test strategy that is valid at any time of day for MNQ only.',
    'status: active', 'instruments: [MNQ]', 'timeframe: 3m', 'signal: manual', 'risk:', '  stop: manual', '  min_rr: 1', '---',
    '## When to Use', '## How It Works', '## Examples', '',
  ].join('\n'));
  // A manual strategy with a per-trade dollar cap (the gate's max-risk check).
  const capped = path.join(root, 'strategies', 'capped');
  fs.mkdirSync(capped, { recursive: true });
  fs.writeFileSync(path.join(capped, 'STRATEGY.md'), [
    '---', 'name: capped', 'description: Test strategy valid at any time for MNQ, with a 30 dollar per-trade risk cap.',
    'status: active', 'instruments: [MNQ]', 'timeframe: 3m', 'signal: manual', 'risk:', '  stop: manual', '  min_rr: 1', '  max_risk_usd: 30', '---',
    '## When to Use', '## How It Works', '## Examples', '',
  ].join('\n'));
  const prop = path.join(root, 'strategies', 'propped');
  fs.mkdirSync(prop, { recursive: true });
  fs.writeFileSync(path.join(prop, 'STRATEGY.md'), [
    '---', 'name: propped', 'description: Test policy strategy that trades the topstep_50k combine in MNQ micros, any time.',
    'status: active', 'instruments: [MNQ, NQ]', 'timeframe: 3m', 'signal: policy', 'strategies: [crossing, drifting]', 'account: topstep_50k', 'contracts: micro',
    'risk:', '  stop: strategy', '  min_rr: 2', '---',
    '## When to Use', '## How It Works', '## Examples', '',
  ].join('\n'));
  const rules = path.join(root, 'strategies', 'crossing');
  fs.mkdirSync(rules, { recursive: true });
  fs.writeFileSync(path.join(rules, 'STRATEGY.md'), [
    '---', 'name: crossing', 'description: Test rules strategy, an EMA cross on MNQ, traded only through the propped policy strategy.',
    'status: active', 'instruments: [MNQ]', 'timeframe: 3m', 'signal: rules', 'rules:', '  long:', '    - ema(9) crosses_above ema(20)',
    'risk:', '  stop: atr:0.5', '  min_rr: 2', '---', '## When to Use', '## How It Works', '## Examples', '',
  ].join('\n'));
  // A paper component of the propped policy: it stays paper inside the policy (the gate refuses its verdict's entry).
  const paperRules = path.join(root, 'strategies', 'drifting');
  fs.mkdirSync(paperRules, { recursive: true });
  fs.writeFileSync(path.join(paperRules, 'STRATEGY.md'), [
    '---', 'name: drifting', 'description: Test paper rules strategy, an EMA cross on MNQ, listed by the propped policy strategy.',
    'status: paper', 'instruments: [MNQ]', 'timeframe: 3m', 'signal: rules', 'rules:', '  long:', '    - ema(9) crosses_above ema(20)',
    'risk:', '  stop: atr:0.5', '  min_rr: 2', '---', '## When to Use', '## How It Works', '## Examples', '',
  ].join('\n'));
  return root;
})();
// The shipped accounts, with propped listed in its account's rulebook (a policy is sized only from there), with
// prop_flow_1m's numbers (a fifth of the cushion, no cap): the sizing these tests' arithmetic uses.
const HOOK_ACCOUNTS = (() => {
  const account = fs.readFileSync(path.join(ROOT, 'strategies', 'propped', 'STRATEGY.md'), 'utf8').match(/^account: (\S+)/m)[1];
  return path.join(rootWithPolicies({ propped: account }, { from: 'prop_flow_1m' }), 'accounts');
})();
const ORDER =entryOrder({ rationale: 'setup:anytime long, stop 21480, target 21540, risk $40' });
// Exits and protective stops go without brackets (the gate refuses them).
const { stopLossBracket: _sl, ...EXIT_BASE } = ORDER;

function runHook(hookId, script, profiles, payload, env = {}) {
  const res = spawnSync(process.execPath, [RUNNER, hookId, script, profiles], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_ROOT: ROOT, ...env },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const gate = (payload, env) =>
  runHook('pre:trading:order-gate', 'scripts/hooks/trading-order-gate.js', 'minimal,standard,strict', payload, env);

function setup(entries, extraEnv = {}) {
  const dir = tmpDir();
  // A home of its own with a fresh up-trend read (closed 3 min before TEST_NOW), unless a test brings one.
  const home = extraEnv.FTH_HOME || path.join(dir, 'home');
  if (!fs.existsSync(path.join(home, 'mtf', 'MNQ.json'))) trendHome(home, { closedAt: '2026-10-07T14:27:00.000Z' });
  return {
    dir,
    env: {
      FTH_HOME: home,
      FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_API_URL: 'https://api.fake-broker.test', FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '1,7', FAKE_BROKER_JOURNAL: writeJournal(dir, entries),
      FTH_BLACKOUTS_FILE: path.join(dir, 'blackouts.json'),
      FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
      FTH_KILL_SWITCH_FILE: path.join(dir, 'STOP'),
      FTH_GATE_LOG: path.join(dir, 'gate.jsonl'),
      ...extraEnv,
    },
  };
}

const orderPayload = (input = ORDER) => ({ tool_name: 'mcp__broker__place_order', tool_input: input });

test('order gate: a server-written entry under a broker id the translator never named still needs its review', () => {
  const at = m => minutesAgo(m, new Date(TEST_NOW));
  const raw = { ts: at(30), kind: 'order_placed', contractId: 'fake:MNQ:Z26', text: 'setup:anytime long, stop 21480', data: { result: { success: true } } };
  const { env } = setup([raw, { ts: at(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const r = gate(orderPayload(), env);
  assert.strictEqual(r.code, 2, 'no translator cache in this home: the id may be MNQ, so it counts');
  assert.match(r.stderr, /\[review-before-next-entry\]/);
  const reviewed = setup([raw, { ts: at(10), kind: 'review', contractId: raw.contractId, text: 'closed', tags: ['result:win'] },
    { ts: at(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  assert.strictEqual(gate(orderPayload(), reviewed.env).code, 0, 'reviewed under the id journal_read shows: cleared');
  // With the translator's lookup on file, it counts as MNQ (and still needs the review); on another root it wouldn't.
  fs.writeFileSync(path.join(env.FTH_HOME, 'contracts-fake.json'), JSON.stringify({ ids: { 'fake:MNQ:Z26': { root: 'MES', month: '2026-12' } }, front: {} }));
  recordBrokerSpecs(env.FTH_HOME);
  assert.strictEqual(gate(orderPayload(), env).code, 0, 'named by the translator as another root: not this contract\'s entry');
});

test('order gate blocks an unplanned entry with exit code 2', () => {
  const { env } = setup([]);
  const r = gate(orderPayload(), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[plan-required\]/);
});

test('order gate allows a planned entry', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const r = gate(orderPayload(), env);
  assert.strictEqual(r.code, 0, r.stderr);
});

test('order gate: a setup tag that is not first is refused with where it goes', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const r = gate(orderPayload(entryOrder({ rationale: 'long setup:orb, stop 21480' })), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[setup-tag\] Rationale must start with the strategy as setup:<name>/);
});

test('order gate wiring: an entry carries its stop as stopLossBracket; a stop only in the rationale is refused, [protect] and [exit] go without one', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const r = gate(orderPayload(EXIT_BASE), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[stop-defined\] Entry has no stop bracket: every entry carries its stop as stopLossBracket/);
  assert.match(r.stderr, /never send it again without one, and report the broker's message to the user/);
  for (const b of [{ ticks: 0, type: 'stop' }, { ticks: -40, type: 'stop' }, { ticks: 2.5, type: 'stop' }, { ticks: '40', type: 'stop' }, { ticks: 40, type: 'limit' }, { ticks: 40 }, { ticks: 40, type: 'STOP' }]) {
    const bad = gate(orderPayload({ ...ORDER, stopLossBracket: b }), env);
    assert.strictEqual(bad.code, 2, JSON.stringify(b));
    assert.match(bad.stderr, /\[stop-defined\]/, JSON.stringify(b));
  }
  assert.strictEqual(gate(orderPayload(ORDER), env).code, 0, 'the same entry with its bracket goes');
  for (const rationale of ['[protect] stop for the anytime long at 21480', '[exit] flatten']) {
    const ok = gate(orderPayload({ ...EXIT_BASE, side: 'sell', type: 'stop', stopPrice: 21480, rationale }), env);
    assert.strictEqual(ok.code, 0, `${rationale}: ${ok.stderr}`);
  }
});

test('order gate: an order that contradicts its rationale is refused with what disagrees', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const r = gate(orderPayload(entryOrder({ side: 'sell', rationale: 'setup:orb long break above 21500, stop 21480' })), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[order-consistency\] The order doesn't agree with itself: the rationale says long but the order side is sell/);
  const off = gate(orderPayload(entryOrder({ rationale: 'setup:orb long, stop 21480.10' })), env);
  assert.strictEqual(off.code, 2);
  assert.match(off.stderr, /\[order-consistency\].*not on the 0\.25 tick/);
});

test('order gate: a trend strategy entry against the recorded prevailing trend is refused', () => {
  const home = trendHome(tmpDir(), { closedAt: '2026-10-07T14:27:00.000Z', biases: { 240: -1, 60: -1, 15: 0 } });
  const { env } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }], { FTH_HOME: home });
  const r = gate(orderPayload(), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[mtf-trend\] setup:anytime long is against the prevailing 4h down trend/);
  const short = gate(orderPayload({ ...ORDER, side: 'sell', rationale: 'setup:anytime short, stop 21520, target 21460' }), env);
  assert.strictEqual(short.code, 0, short.stderr);
  // No record at all: refused, with how to make one.
  const none = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  fs.rmSync(path.join(none.env.FTH_HOME, 'mtf'), { recursive: true });
  assert.match(gate(orderPayload(), none.env).stderr, /\[mtf-trend\] No multi-timeframe read for MNQ/);
});

test('order gate: a rules strategy entry needs its own trigger in the signal record', () => {
  const plan = [{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }];
  const order = orderPayload({ ...ORDER, rationale: 'setup:crossing long, stop 21480, target 21540' });
  const none = setup(plan, { FTH_HOME: trendHome(tmpDir(), { closedAt: '2026-10-07T14:27:00.000Z', fired: [] }) });
  const r = gate(order, none.env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[trigger-fired\] setup:crossing long did not fire on the last closed MNQ bar/);
  const fired = setup(plan, { FTH_HOME: trendHome(tmpDir(), { closedAt: '2026-10-07T14:27:00.000Z', fired: [{ name: 'crossing', direction: 'long' }] }) });
  const ok = gate(order, fired.env);
  assert.strictEqual(ok.code, 0, ok.stderr);
});

test('order gate wiring: a signal\'s age is 3 bars of its own timeframe (FTH_SIGNAL_MAX_AGE_BARS), so a 1m signal expires sooner than a 3m one', () => {
  const plan = [{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }];
  // Rules strategies on 1m (quick), 15m (slow) and 1h (hourly) beside the 3m crossing.
  const extra = path.join(tmpDir(), 'strategies');
  for (const [name, tf] of [['quick', '1m'], ['slow', '15m'], ['hourly', '1h']]) {
    fs.mkdirSync(path.join(extra, name), { recursive: true });
    fs.writeFileSync(path.join(extra, name, 'STRATEGY.md'), [
      '---', `name: ${name}`, `description: Test rules strategy on ${tf} bars, an EMA cross, for the signal age per timeframe.`,
      'status: active', 'instruments: [MNQ]', `timeframe: ${tf}`, 'signal: rules', 'rules:', '  long:', '    - ema(9) crosses_above ema(20)',
      'risk:', '  stop: atr:0.5', '  min_rr: 2', '---', '## When to Use', '## How It Works', '## Examples', '',
    ].join('\n'));
  }
  // The gate's clock is TEST_NOW (14:30): each record's bar closed `ago` minutes before it.
  const run = (tf, name, ago, env = {}) => {
    const closedAt = new Date(Date.parse(TEST_NOW) - ago * 60000).toISOString();
    // The trend record fresh (its own 15-minute limit is not under test); the signal record aged.
    const home = trendHome(tmpDir(), { closedAt: new Date(Date.parse(TEST_NOW) - 60000).toISOString(), fired: [{ name, direction: 'long' }] });
    fs.writeFileSync(path.join(home, 'signals', `MNQ-${tf}.json`), JSON.stringify({ symbol: 'MNQ', timeframe: tf, asOf: closedAt, closedAt, candidates: [{ name, direction: 'long' }] }));
    const { env: e } = setup(plan, { FTH_HOME: home, FTH_STRATEGIES_DIRS: extra, ...env });
    return gate(orderPayload({ ...ORDER, rationale: `setup:${name} long, stop 21480, target 21540` }), e);
  };
  // 1m: 3 bars are 3 minutes.
  const ok1 = run('1m', 'quick', 2.5);
  assert.strictEqual(ok1.code, 0, ok1.stderr);
  const late1 = run('1m', 'quick', 3.6);
  assert.strictEqual(late1.code, 2);
  assert.match(late1.stderr, /\[trigger-fired\] The last recorded signal bar for MNQ closed 4 min ago \(limit 3 min: 3 1m bars, FTH_SIGNAL_MAX_AGE_BARS\)/);
  // 3m: 9 minutes (the flat 10 is gone: 10 min is too old).
  const ok3 = run('3m', 'crossing', 8.5);
  assert.strictEqual(ok3.code, 0, ok3.stderr);
  assert.match(run('3m', 'crossing', 9.6).stderr, /\[trigger-fired\].*limit 9 min: 3 3m bars/);
  // 15m and 1h: 45 minutes, the ceiling (3 1h bars would be 180).
  const slow = run('15m', 'slow', 44.5);
  assert.strictEqual(slow.code, 0, slow.stderr);
  assert.match(run('15m', 'slow', 45.6).stderr, /\[trigger-fired\].*limit 45 min: 3 15m bars/);
  const hourly = run('1h', 'hourly', 44.5);
  assert.strictEqual(hourly.code, 0, hourly.stderr);
  assert.match(run('1h', 'hourly', 45.6).stderr, /\[trigger-fired\].*limit 45 min: 3 1h bars, FTH_SIGNAL_MAX_AGE_BARS, at most 45 min/);
  // The count from the environment; FTH_SIGNAL_MAX_AGE_MIN only shortens it.
  assert.strictEqual(run('1m', 'quick', 5, { FTH_SIGNAL_MAX_AGE_BARS: '6' }).code, 0);
  assert.match(run('3m', 'crossing', 5, { FTH_SIGNAL_MAX_AGE_MIN: '4' }).stderr, /\[trigger-fired\].*capped at 4 min by FTH_SIGNAL_MAX_AGE_MIN/);
  assert.match(run('3m', 'crossing', 10, { FTH_SIGNAL_MAX_AGE_MIN: '60' }).stderr, /\[trigger-fired\].*limit 9 min/);
});

test('order gate wiring: a rules strategy trades only the selected leg (FTH_SYMBOLS) of a family it lists, in that contract\'s own specs and dollars; exits on either leg go', () => {
  const at = m => minutesAgo(m, new Date(TEST_NOW));
  const planFor = contractId => [{ ts: at(5), kind: 'plan', contractId, text: 'plan' }];
  // A rules strategy listing MNQ only, capped at $100 a trade.
  const extra = path.join(tmpDir(), 'strategies');
  fs.mkdirSync(path.join(extra, 'minicap'), { recursive: true });
  fs.writeFileSync(path.join(extra, 'minicap', 'STRATEGY.md'), [
    '---', 'name: minicap', 'description: Test rules strategy listing MNQ only, an EMA cross with a 100 dollar per-trade risk cap.',
    'status: active', 'instruments: [MNQ]', 'timeframe: 3m', 'signal: rules', 'rules:', '  long:', '    - ema(9) crosses_above ema(20)',
    'risk:', '  stop: atr:0.5', '  min_rr: 2', '  max_risk_usd: 100', '---', '## When to Use', '## How It Works', '## Examples', '',
  ].join('\n'));
  const homeFor = (opts = {}) => trendHome(tmpDir(), { closedAt: '2026-10-07T14:27:00.000Z', fired: [{ name: 'crossing', direction: 'long' }, { name: 'minicap', direction: 'long' }], ...opts });
  const run = (contractId, rationale, { size = 1, ticks = 40, home = homeFor(), symbols, input = null } = {}) => {
    const { env } = setup(planFor(contractId), { FTH_HOME: home, FTH_STRATEGIES_DIRS: extra, ...(symbols === undefined ? {} : { FTH_SYMBOLS: symbols }) });
    return gate(orderPayload(input || { ...ORDER, contractId, size, stopLossBracket: { ticks, type: 'stop' }, rationale }), env);
  };
  const CROSS = 'setup:crossing long, stop 21480, target 21540';
  // NQ selected: crossing (listing MNQ) enters NQ, on the family's trigger and trend records; MNQ is refused.
  const nq = run('NQ', CROSS, { symbols: 'NQ' });
  assert.strictEqual(nq.code, 0, nq.stderr);
  const mnqOnNq = run('MNQ', CROSS, { symbols: 'NQ' });
  assert.strictEqual(mnqOnNq.code, 2);
  assert.match(mnqOnNq.stderr, /\[strategy\] setup:crossing trades NQ \(the selected contract\), not MNQ\./);
  // MNQ selected: MNQ enters, NQ is refused.
  assert.strictEqual(run('MNQ', CROSS, { symbols: 'MNQ,MES' }).code, 0);
  assert.match(run('NQ', CROSS, { symbols: 'MNQ,MES' }).stderr, /\[strategy\] setup:crossing trades MNQ \(the selected contract\), not NQ\./);
  // No selection: its list (MNQ) only; NQ refused, saying how to select it. An unreadable selection refuses every entry.
  assert.strictEqual(run('MNQ', CROSS).code, 0);
  assert.match(run('NQ', CROSS).stderr, /\[strategy\] setup:crossing does not trade NQ \(instruments: MNQ\); .*FTH_SYMBOLS=NQ\)/);
  assert.match(run('MNQ', CROSS, { symbols: 'MNQ,NQ' }).stderr, /\[strategy\] FTH_SYMBOLS selects two contracts of one index \(MNQ, NQ\)/);
  // An autonomous run without FTH_SYMBOLS has lost its selection: refused, never "its list".
  const lostRun = (symbols) => {
    const { env } = setup(planFor('MNQ'), { FTH_HOME: homeFor(), FTH_STRATEGIES_DIRS: extra, FTH_AUTONOMOUS: '1', ...(symbols ? { FTH_SYMBOLS: symbols } : {}) });
    return gate(orderPayload({ ...ORDER, rationale: CROSS }), env);
  };
  assert.match(lostRun().stderr, /\[strategy\] FTH_SYMBOLS is not set in this autonomous run, .*re-running node scripts\/install\.js --target <harness>/);
  assert.doesNotMatch(lostRun('MNQ').stderr, /\[strategy\]/);
  // A contract outside every family it lists: refused, selected or not.
  for (const c of ['ES', 'MES', 'GC', 'CL']) {
    const r = run(c, CROSS, { symbols: c });
    assert.strictEqual(r.code, 2, c);
    assert.match(r.stderr, new RegExp(`\\[strategy\\] setup:crossing does not trade ${c} \\(instruments: MNQ\\)`));
  }
  // The manual anytime (MNQ only) still matches exactly: no NQ, even selected.
  assert.match(run('NQ', 'setup:anytime long, stop 21480, target 21540', { symbols: 'NQ' }).stderr, /\[strategy\] setup:anytime does not trade NQ \(instruments: MNQ\)/);
  // max_risk_usd in NQ's dollars: 40 ticks x $5 = $200 over $100 (MNQ at 40 ticks is $20 a contract).
  assert.strictEqual(run('MNQ', 'setup:minicap long, stop 21480, target 21540', { size: 5, symbols: 'MNQ' }).code, 0);
  const big = run('NQ', 'setup:minicap long, stop 21480, target 21540', { symbols: 'NQ' });
  assert.strictEqual(big.code, 2);
  assert.match(big.stderr, /\[max-risk\] risk \$200\.00 \(size 1 x 40-tick stop x \$5\.00 a tick on NQ\) over setup:minicap's risk\.max_risk_usd \$100\.00/);
  assert.strictEqual(run('NQ', 'setup:minicap long, stop 21480, target 21540', { ticks: 20, symbols: 'NQ' }).code, 0, '20 ticks x $5 = $100: at the cap');
  // NQ's own broker specs: MNQ's recorded doesn't do.
  const microOnly = homeFor({ specs: false });
  recordBrokerSpecs(microOnly, { roots: ['MNQ'] });
  const nospec = run('NQ', CROSS, { home: microOnly, symbols: 'NQ' });
  assert.strictEqual(nospec.code, 2);
  assert.match(nospec.stderr, /\[contract-specs\] .*NQ/);
  // Exits and protective stops on either leg go, whatever is selected (an open position can always be closed).
  for (const c of ['MNQ', 'NQ']) {
    for (const symbols of ['NQ', 'MNQ', undefined, 'MNQ,NQ']) {
      for (const input of [
        { ...EXIT_BASE, contractId: c, size: 3, side: 'sell', rationale: '[exit] flatten' },
        { ...EXIT_BASE, contractId: c, size: 3, side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long at 21480' },
      ]) {
        const r = run(c, null, { symbols, input });
        assert.strictEqual(r.code, 0, `${c} ${symbols} ${input.rationale}: ${r.stderr}`);
      }
    }
  }
});

test('order gate: with a Claude transcript, an entry needs the trading skills loaded in the session', () => {
  const { env, dir } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const skill = name => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: name } }] } });
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, skill('trade-session'));
  const r = gate({ ...orderPayload(), transcript_path: transcript }, env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[skills-loaded\] Load the trading skills before an entry; not loaded in this session: multi-timeframe-analysis, strategy-library/);
  fs.writeFileSync(transcript, ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan'].map(skill).join('\n'));
  const ok = gate({ ...orderPayload(), transcript_path: transcript }, env);
  assert.strictEqual(ok.code, 0, ok.stderr);
});

test('order gate (hook): an entry needs setup-judgment and trade-plan read (REQUIRED_AT_ENTRY); exits, protective stops, stop moves and cancels never wait for them', () => {
  const { env, dir } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const skill = name => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: name } }] } });
  const transcript = path.join(dir, 'session.jsonl');
  const EVERY = ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks'];
  fs.writeFileSync(transcript, [...EVERY, 'setup-judgment'].map(skill).join('\n'));
  const r = gate({ ...orderPayload(), transcript_path: transcript }, env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[skills-at-entry\] Read how to judge the setup and write its plan before an entry; not read in this session: trade-plan\./);
  assert.doesNotMatch(r.stderr, /\[skills-loaded\]/, 'its own check, apart from the per-cycle list');
  for (const order of [{ ...ORDER, side: 'sell', rationale: '[exit] flatten' }, { ...ORDER, side: 'sell', type: 'stop', stopPrice: 21480, stopLossBracket: undefined, rationale: '[protect] stop for the long' }]) {
    const ok = gate({ ...orderPayload(order), transcript_path: transcript }, env);
    assert.strictEqual(ok.code, 0, ok.stderr);
  }
  for (const [tool, input] of [['modify_order', { accountId: ORDER.accountId, orderId: 7, stopPrice: 21490 }], ['cancel_order', { accountId: ORDER.accountId, orderId: 7 }]]) {
    const ok = gate({ tool_name: `mcp__broker__${tool}`, tool_input: input, transcript_path: transcript }, env);
    assert.strictEqual(ok.code, 0, `${tool}: ${ok.stderr}`);
  }
  // A transcript named but unreadable: refused (fails closed).
  const gone = gate({ ...orderPayload(), transcript_path: path.join(dir, 'gone.jsonl') }, env);
  assert.strictEqual(gone.code, 2);
  assert.match(gone.stderr, /\[skills-at-entry\] The session's transcript can't be read/);
  fs.writeFileSync(transcript, [...EVERY, 'setup-judgment', 'trade-plan'].map(skill).join('\n'));
  const ok = gate({ ...orderPayload(), transcript_path: transcript }, env);
  assert.strictEqual(ok.code, 0, ok.stderr);
});

test('order gate (hook): the runner\'s head-prompt attestation (opencode, index mode) never counts for a hook\'s own transcript', () => {
  const { env, dir } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const H = require('../../scripts/lib/head-prompt');
  const configFile = path.join(dir, 'workspace', 'opencode.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, require('../../scripts/lib/harness-sync').expectedFiles(REPO)['workspace/opencode.json']);
  const att = H.attestation(configFile, REPO);
  // The runner's opencode cycle transcript (no skill loaded by tool: the head trader's prompt embeds them; this
  // non-composed entry's strategy skills it looked up, as the prompt embeds the composed entry's list).
  const cycle = path.join(dir, 'cycle-transcript.jsonl');
  const lookup = skill => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'harness_skill_lookup', state: { status: 'completed', input: { skill }, output: `<skill name="${skill}">...` } } });
  fs.writeFileSync(cycle, [JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 's', part: { type: 'step-start' } }), ...['strategy-library', 'strategy-scan', 'strategy-gate-checks'].map(lookup)].join('\n'));
  const auto = { ...env, FTH_AUTONOMOUS: '1', FTH_SYMBOLS: 'MNQ', FTH_ROLE_SKILLS: 'index', FTH_CYCLE_TRANSCRIPT: cycle, FTH_HEAD_PROMPT: JSON.stringify(att) };
  // A hook call with its own transcript (Claude Code's, Qwen Code's) that loaded no skill: refused for them, attestation or not.
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'deciding' }] } }));
  const hooked = gate({ ...orderPayload(), transcript_path: transcript }, auto);
  assert.strictEqual(hooked.code, 2);
  assert.match(hooked.stderr, /\[skills-loaded\] Load the trading skills before an entry; not loaded in this session: trade-session/);
  assert.match(hooked.stderr, /\[skills-at-entry\] [^\n]*not read in this session: setup-judgment, trade-plan\./);
  // The same call on the runner's cycle transcript (no transcript_path, as the gateway sees it): the attested skills count.
  const cycleCall = gate(orderPayload(), auto);
  assert.doesNotMatch(cycleCall.stderr, /\[skills-loaded\]|\[skills-at-entry\]/);
  // ... and without the attestation they don't.
  const unattested = gate(orderPayload(), { ...auto, FTH_HEAD_PROMPT: '' });
  assert.match(unattested.stderr, /\[skills-loaded\][^\n]*not loaded in this session: trade-session/);
  // An exit is never held by any of it.
  const exit = gate({ ...orderPayload({ ...EXIT_BASE, contractId: entryOrder().contractId, size: 1, side: 'sell', rationale: '[exit] flatten' }), transcript_path: transcript }, auto);
  assert.doesNotMatch(exit.stderr, /\[skills-loaded\]|\[skills-at-entry\]/);
});

test('order gate (hook): strategy-library was split; an entry without any one of its pieces is refused, an exit never is', () => {
  const { env, dir } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const skill = name => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: name } }] } });
  const transcript = path.join(dir, 'session.jsonl');
  const ALL = ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan'];
  for (const missing of ['strategy-library', 'strategy-scan', 'strategy-gate-checks']) {
    fs.writeFileSync(transcript, ALL.filter(s => s !== missing).map(skill).join('\n'));
    const r = gate({ ...orderPayload(), transcript_path: transcript }, env);
    assert.strictEqual(r.code, 2, missing);
    assert.match(r.stderr, new RegExp(`\\[skills-loaded\\] .*not loaded in this session: ${missing}\\.`), missing);
    const exit = gate({ ...orderPayload({ ...EXIT_BASE, contractId: entryOrder().contractId, size: 1, side: 'sell', rationale: '[exit] flatten' }), transcript_path: transcript }, env);
    assert.strictEqual(exit.code, 0, `${missing}: an exit is never held back by it: ${exit.stderr}`);
  }
  fs.writeFileSync(transcript, ALL.map(skill).join('\n'));
  const ok = gate({ ...orderPayload(), transcript_path: transcript }, env);
  assert.strictEqual(ok.code, 0, ok.stderr);
});

test('order gate: with a Qwen Code chat transcript (parts format), the skills loaded let an entry through; missing or failed loads do not', () => {
  const { env, dir } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const call = (id, skill) => JSON.stringify({ type: 'assistant', message: { role: 'model', parts: [{ text: 'loading' }, { functionCall: { id, name: 'skill', args: { skill: `futures-trading-harness:${skill}` } } }] } });
  const answer = (id, response, status) => JSON.stringify({ type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id, name: 'skill', response } }] }, toolCallResult: { callId: id, status } });
  const load = (id, skill) => [call(id, skill), answer(id, { output: `Base directory for this skill: /x/${skill}` }, 'success')];
  const transcript = path.join(dir, 'chats', 'session.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, load('a', 'trade-session').join('\n'));
  const none = gate({ ...orderPayload(), transcript_path: transcript }, env);
  assert.strictEqual(none.code, 2);
  assert.match(none.stderr, /\[skills-loaded\] Load the trading skills before an entry; not loaded in this session: multi-timeframe-analysis, strategy-library/);
  const failedLoad = [call('c', 'strategy-library'), answer('c', { error: 'Skill "strategy-library" not found.' }, 'error')];
  fs.writeFileSync(transcript, [...load('a', 'trade-session'), ...load('b', 'multi-timeframe-analysis'), ...load('e', 'strategy-scan'), ...load('f', 'strategy-gate-checks'), ...failedLoad].join('\n'));
  const failed = gate({ ...orderPayload(), transcript_path: transcript }, env);
  assert.strictEqual(failed.code, 2);
  assert.match(failed.stderr, /\[skills-loaded\] .*not loaded in this session: strategy-library\./);
  fs.writeFileSync(transcript, [...load('a', 'trade-session'), ...load('b', 'multi-timeframe-analysis'), ...load('e', 'strategy-scan'), ...load('f', 'strategy-gate-checks'), ...failedLoad, ...load('d', 'strategy-library'), ...load('g', 'setup-judgment'), ...load('h', 'trade-plan')].join('\n'));
  const ok = gate({ ...orderPayload(), transcript_path: transcript }, env);
  assert.strictEqual(ok.code, 0, ok.stderr);
  assert.doesNotMatch(ok.stderr, /skills-loaded/);
});

test('order gate: a trend strategy is refused when another strategy fired the other side on the bar', () => {
  const plan = [{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }];
  const fired = [{ name: 'crossing', direction: 'long', confluence: { with: [], against: ['other'] } }, { name: 'other', direction: 'short', confluence: { with: [], against: ['crossing'] } }];
  const { env } = setup(plan, { FTH_HOME: trendHome(tmpDir(), { closedAt: '2026-10-07T14:27:00.000Z', fired }) });
  const r = gate(orderPayload({ ...ORDER, rationale: 'setup:crossing long, stop 21480, target 21540' }), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[trigger-fired\] setup:crossing long conflicts with other firing the other side on the same bar/);
});

test('order gate ignores other tools and plugin-scoped tool names still match', () => {
  const { env } = setup([]);
  assert.strictEqual(gate({ tool_name: 'mcp__broker__get_bars', tool_input: {} }, env).code, 0);
  assert.strictEqual(gate({ tool_name: 'mcp__plugin_fth_broker__place_order', tool_input: ORDER }, env).code, 2);
  // A server registered under an older name is still gated.
  assert.strictEqual(gate({ tool_name: 'mcp__oldname__place_order', tool_input: ORDER }, env).code, 2);
});

test('order gate: a broken broker config blocks every order (fails closed) and says close_position still flattens', () => {
  const { env, dir } = setup([]);
  fs.writeFileSync(path.join(dir, 'brokers.json'), '{ broken');
  const r = gate({ tool_name: 'mcp__broker__place_order', tool_input: { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' } }, { ...env, FTH_BROKERS_FILE: path.join(dir, 'brokers.json') });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /broker-config[\s\S]*close_position still flattens/);
});

test('order gate blocks unknown strategies and instruments the strategy does not trade', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: 'MES', text: 'plan' }]);
  const unknown = gate(orderPayload({ ...ORDER, rationale: 'setup:nosuch long, stop 1' }), env);
  assert.strictEqual(unknown.code, 2);
  assert.match(unknown.stderr, /\[strategy\] setup:nosuch is not a known strategy/);
  const mes = gate(orderPayload({ ...ORDER, contractId: 'MES' }), env);
  assert.match(mes.stderr, /does not trade MES/);
});

test('order gate: a trade-lifecycle entry (signal: composed) outside a runner cycle is refused ([composed-reads]); its exit goes', () => {
  // The shipped strategies, trade_lifecycle among them.
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: 'MNQ', text: 'plan' }], { FTH_STRATEGIES_DIRS: path.join(REPO, 'strategies') });
  const entry = gate(orderPayload({ ...ORDER, rationale: 'setup:trade_lifecycle long, stop 21480' }), env);
  assert.strictEqual(entry.code, 2);
  assert.match(entry.stderr, /\[composed-reads\] setup:trade_lifecycle: no cycle bar for MNQ/);
  assert.doesNotMatch(entry.stderr, /\[strategy\]/);
  const exit = gate(orderPayload({ ...EXIT_BASE, side: 'sell', rationale: '[exit] close the trade_lifecycle long' }), env);
  assert.strictEqual(exit.code, 0, exit.stderr);
});

test('order gate: an entry tagged with a retired strategy is refused, saying so; its exit goes; a retired runner lane refuses even a manual entry', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: 'MNQ', text: 'plan' }]);
  const old = gate(orderPayload({ ...ORDER, rationale: 'setup:bos long, stop 21480' }), env);
  assert.strictEqual(old.code, 2);
  assert.match(old.stderr, /\[strategy\] setup:bos is not a known strategy \(retired on 2026-10-13: strategies\/README\.md, "Retired strategies"\): no new entries from it/);
  const exit = gate(orderPayload({ ...EXIT_BASE, side: 'sell', rationale: '[exit] close the bos long' }), env);
  assert.strictEqual(exit.code, 0, exit.stderr);
  // The runner's 3m lane lists a retired strategy (its signal record says so): the manual anytime (3m) is refused too.
  const { buildSignals, writeSignals } = require('../../scripts/lib/trading/signal-state');
  writeSignals(env.FTH_HOME, buildSignals([], { symbol: 'MNQ', bar: { t: '2026-10-07T14:24:00.000Z' }, stepMs: 180000, now: new Date(TEST_NOW), retiredLane: ['keltner'] }));
  const lane = gate(orderPayload(ORDER), env);
  assert.strictEqual(lane.code, 2);
  assert.match(lane.stderr, /\[retired-lane\] setup:anytime trades 3m bars, and the runner's 3m lane lists keltner \(retired on 2026-10-13/);
  assert.strictEqual(gate(orderPayload({ ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' }), env).code, 0, 'exits still go');
  // A hard rule: the gate's skip list can't switch it off.
  const skipped = gate(orderPayload(ORDER), { ...env, FTH_ORDER_GATE_SKIP: 'retired-lane' });
  assert.strictEqual(skipped.code, 2);
  assert.match(skipped.stderr, /\[retired-lane\]/);
  // An unknown or retired name has no timeframe of its own: with the strategy check skipped, the lane still refuses it.
  for (const tag of ['nosuch', 'bos']) {
    const unknown = gate(orderPayload({ ...ORDER, rationale: `setup:${tag} long, stop 21480` }), { ...env, FTH_ORDER_GATE_SKIP: 'retired-lane,strategy' });
    assert.strictEqual(unknown.code, 2, tag);
    assert.doesNotMatch(unknown.stderr, /\[strategy\]/, tag);
    assert.match(unknown.stderr, new RegExp(`\\[retired-lane\\] setup:${tag} names no known strategy, so no timeframe of its own, and the runner's 3m lane lists keltner`), tag);
  }
  assert.strictEqual(gate(orderPayload({ ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' }), { ...env, FTH_ORDER_GATE_SKIP: 'retired-lane,strategy' }).code, 0, 'exits still go');
});

test('order gate: an unreadable runner lane record refuses an entry (it may hold the retired mark), named or not; exits and stops go', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: 'MNQ', text: 'plan' }]);
  const { signalFile } = require('../../scripts/lib/trading/signal-state');
  fs.mkdirSync(path.dirname(signalFile(env.FTH_HOME, 'MNQ', '3m')), { recursive: true });
  fs.writeFileSync(signalFile(env.FTH_HOME, 'MNQ', '3m'), '{ half a file');
  const skip = { ...env, FTH_ORDER_GATE_SKIP: 'retired-lane,strategy' };
  const named = gate(orderPayload(ORDER), skip);
  assert.strictEqual(named.code, 2);
  assert.match(named.stderr, /\[retired-lane\] setup:anytime trades 3m bars, and the runner's 3m lane record for MNQ is unreadable/);
  const unknown = gate(orderPayload({ ...ORDER, rationale: 'setup:nosuch long, stop 21480' }), skip);
  assert.strictEqual(unknown.code, 2);
  assert.match(unknown.stderr, /\[retired-lane\] setup:nosuch names no known strategy, so no timeframe of its own, and the runner's 3m lane record for MNQ is unreadable/);
  for (const rationale of ['[exit] flatten', '[protect] stop to 21480']) {
    assert.strictEqual(gate(orderPayload({ ...EXIT_BASE, side: 'sell', rationale }), skip).code, 0, rationale);
  }
});

test('order gate fails closed on malformed input', () => {
  const { env } = setup([]);
  const r = gate('{not json', env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /could not run/);
});

test('order gate fails closed when the journal is unreadable', () => {
  const { dir, env } = setup([]);
  const r = gate(orderPayload(), { ...env, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_API_URL: 'https://api.fake-broker.test', FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '1,7', FAKE_BROKER_JOURNAL: dir });
  assert.strictEqual(r.code, 2);
});

test('order gate fails closed on oversized input', () => {
  const { env } = setup([]);
  const r = gate(orderPayload({ ...ORDER, rationale: `setup:anytime ${'x'.repeat(5000)}` }), { ...env, FTH_HOOK_INPUT_MAX_BYTES: '1000' });
  assert.strictEqual(r.code, 2);
});

test('order gate honours an explicit disable, but not in autonomous runs, and never dry-runs', () => {
  const { env } = setup([]);
  assert.strictEqual(gate(orderPayload(), { ...env, FTH_DISABLED_HOOKS: 'pre:trading:order-gate' }).code, 0);
  assert.strictEqual(gate(orderPayload(), { ...env, FTH_DISABLED_HOOKS: 'pre:trading:order-gate', FTH_AUTONOMOUS: '1' }).code, 2);
  assert.strictEqual(gate(orderPayload(), { ...env, FTH_HOOKS_ENABLED: 'false', FTH_AUTONOMOUS: '1' }).code, 2);
  assert.strictEqual(gate(orderPayload(), { ...env, FTH_DRY_RUN: '1' }).code, 2);
});

test('order gate reads the blackout file', () => {
  const { dir, env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const now = Date.parse(TEST_NOW);
  fs.writeFileSync(path.join(dir, 'blackouts.json'), JSON.stringify([
    { start: new Date(now - 60000).toISOString(), end: new Date(now + 600000).toISOString(), reason: 'FOMC' },
  ]));
  const r = gate(orderPayload(), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /FOMC/);
});

test('session-start briefing lists lessons and day state', () => {
  const { env } = setup([
    { ts: minutesAgo(60 * 24 * 3, new Date(TEST_NOW)), kind: 'lesson', text: 'Skip ORB before 09:45 ET', tags: ['setup:orb'] },
    { ts: minutesAgo(1, new Date(TEST_NOW)), kind: 'note', text: 'n' },
  ]);
  const r = runHook('session-start:trading:briefing', 'scripts/hooks/trading-session-start.js', 'minimal,standard,strict', {}, env);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Trading harness briefing/);
  assert.match(r.stdout, /Skip ORB before 09:45 ET \[setup:orb\]/);
  assert.match(r.stdout, /Harness root \(FTH_ROOT\): /);
  assert.match(r.stdout, /Know the account before every decision: get_account_snapshot/);
  assert.doesNotMatch(r.stdout, /Prop attempts/);
});

test('session-start briefing states each running prop attempt from its last snapshot', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const home = tmpDir();
  const account = accountNamed(REPO, 'topstep_100k', {});
  prop.startAttempt(home, account, new Date('2026-10-05T14:00:00Z'));
  // At the gate's clock (TEST_NOW), which the briefing reads too.
  prop.snapshot(home, account, 101250, new Date(TEST_NOW));
  const { env } = setup([], { FTH_HOME: home });
  const r = runHook('session-start:trading:briefing', 'scripts/hooks/trading-session-start.js', 'minimal,standard,strict', {}, env);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /### Prop attempts \(the order gate enforces these\)/);
  assert.match(r.stdout, /- topstep_100k \(active\) as of .* \(0 min ago\): balance \$101,250, floor \$97,000, cushion \$4,250, profit \+\$1,250 of \$6,000/);
  assert.doesNotMatch(r.stdout, /entries blocked/);
});

test('session-start briefing shows the block the gate applies now: a missing or old snapshot, a missed close', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const fresh = tmpDir();
  const account = accountNamed(REPO, 'topstep_100k', {});
  prop.startAttempt(fresh, account, new Date('2026-10-05T14:00:00Z'));
  const a = runHook('session-start:trading:briefing', 'scripts/hooks/trading-session-start.js', 'minimal,standard,strict', {}, setup([], { FTH_HOME: fresh }).env);
  assert.strictEqual(a.code, 0);
  assert.match(a.stdout, /- topstep_100k: attempt started .*, no balance snapshot yet .*; entries blocked: the topstep_100k account snapshot is missing or older than 10 minutes/);
  const old = tmpDir();
  prop.startAttempt(old, account, new Date('2026-10-05T14:00:00Z'));
  prop.snapshot(old, account, 99000, new Date(Date.parse(TEST_NOW) - 3 * 3600000));
  const b = runHook('session-start:trading:briefing', 'scripts/hooks/trading-session-start.js', 'minimal,standard,strict', {}, setup([], { FTH_HOME: old }).env);
  assert.match(b.stdout, /- topstep_100k \(active\) as of .* \(180 min ago\): balance \$99,000, .*profit -\$1,000 of \$6,000.*; entries blocked: the topstep_100k account snapshot is missing or older than 10 minutes/);
});

test('the built-in exchange calendar holds in the hook with nothing configured: no entry on Good Friday, even with the check skipped', () => {
  const now = '2026-04-03T14:00:00Z';
  const { env } = setup([{ ts: minutesAgo(5, new Date(now)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }],
    { FTH_TEST_NOW: now, NODE_ENV: 'test', FTH_ORDER_GATE_SKIP: 'time-window,market-hours' });
  const r = gate(orderPayload(), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /market-hours.*2026-04-03/);
  // Past the calendar's end: refused too (its holidays are unknown).
  const later = '2028-01-05T15:00:00Z';
  const past = setup([{ ts: minutesAgo(5, new Date(later)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }],
    { FTH_TEST_NOW: later, NODE_ENV: 'test', FTH_ORDER_GATE_SKIP: 'time-window,market-hours' });
  const r2 = gate(orderPayload(), past.env);
  assert.strictEqual(r2.code, 2);
  assert.match(r2.stderr, /market-hours.*calendar ends 2027-12-31/);
});

test('market hours are a hard rule: no entry in the 16:00-18:00 ET break even with FTH_ENTRY_HOURS empty and the check skipped', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date('2026-10-07T21:00:00Z')), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }],
    { FTH_TEST_NOW: '2026-10-07T21:00:00Z', NODE_ENV: 'test', FTH_ORDER_GATE_SKIP: 'time-window,market-hours' });
  const r = gate(orderPayload(entryOrder()), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /market-hours/);
  const exit = gate(orderPayload(entryOrder({ side: 'sell', rationale: '[exit] flatten before the close' })), env);
  assert.strictEqual(exit.code, 0, 'exits are always allowed');
});

test('stop hook asks once for a review of unreviewed entries', () => {
  // An entry a minute before the gate's test clock (a fixed Wednesday morning, whatever the wall clock says).
  const { env } = setup([placed(1, 'setup:orb long stop 1', true)].map(e => ({ ...e, ts: new Date(Date.parse(TEST_NOW) - 60000).toISOString() })));
  const run = payload => runHook('stop:trading:review-reminder', 'scripts/hooks/trading-stop-review.js', 'standard,strict', payload, env);
  const first = run({ stop_hook_active: false });
  assert.strictEqual(first.code, 2);
  assert.match(first.stderr, /no review/);
  assert.strictEqual(run({ stop_hook_active: true }).code, 0);
  assert.strictEqual(runHook('stop:trading:review-reminder', 'scripts/hooks/trading-stop-review.js', 'standard,strict',
    {}, { ...env, FTH_HOOK_PROFILE: 'minimal' }).code, 0);
});

test('MCP gateway blocks a bad order end to end and forwards everything else', async () => {
  const { spawn } = require('child_process');
  const dir = tmpDir();
  const strategiesDir = path.join(ROOT, 'strategies');
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    FAKE_POSITIONS: JSON.stringify([{ contractId: 'MNQ', type: 1, size: 1 }]),
    FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_API_URL: 'https://api.fake-broker.test', FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '1,7', FAKE_BROKER_JOURNAL: writeJournal(dir, []),
    FTH_STRATEGIES_DIRS: strategiesDir,
    FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
    FTH_GATE_LOG: path.join(dir, 'gate.jsonl'),
  };
  const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js'), '--', process.execPath, path.join(REPO, 'tests', 'fixtures', 'fake-mcp-server.js')], { env });
  let out = '';
  gw.stdout.on('data', c => { out += c; });
  const send = m => gw.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_bars', arguments: {} } });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'place_order', arguments: ORDER } });
  // Labelled [exit] but on the same side as the open long: would add exposure.
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'place_order', arguments: { ...EXIT_BASE, rationale: '[exit] take profit' } } });
  // A real exit: sell 1 against the long 1.
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'place_order', arguments: { ...EXIT_BASE, side: 'sell', rationale: '[exit] take profit' } } });
  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'modify_order', arguments: { orderId: 9, size: 3 } } });
  gw.stdin.end();
  const code = await new Promise(resolve => gw.on('close', resolve));
  assert.strictEqual(code, 0);
  const responses = out.trim().split('\n').map(l => JSON.parse(l));
  const byId = Object.fromEntries(responses.map(r => [r.id, r]));
  assert.strictEqual(byId[1].result.content[0].text, 'forwarded:initialize');
  assert.strictEqual(byId[2].result.content[0].text, 'forwarded:tools/call:get_bars');
  assert.strictEqual(byId[3].result.isError, true);
  assert.match(byId[3].result.content[0].text, /\[plan-required\]/);
  assert.match(byId[3].result.content[0].text, /\[position-open\]/);
  assert.match(byId[4].result.content[0].text, /\[exposure\] .*same side/);
  assert.strictEqual(byId[5].result.content[0].text, 'forwarded:tools/call:place_order');
  assert.match(byId[6].result.content[0].text, /\[modify-size\]/);
  assert.ok(!out.includes('fth-gw-'), 'gateway-internal responses must not reach the client');
  const log = fs.readFileSync(env.FTH_GATE_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(log[0].decision, 'blocked');
});

test('MCP gateway: rapid-fire [exit] orders cannot flip a position while fills are in flight', async () => {
  const { spawn } = require('child_process');
  const dir = tmpDir();
  const env = {
    PATH: process.env.PATH, HOME: dir, START_NET: '1', FILL_DELAY_MS: '300',
    FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_API_URL: 'https://api.fake-broker.test', FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '1,7', FAKE_BROKER_JOURNAL: writeJournal(dir, []), FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
  };
  const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js'), '--', process.execPath, path.join(REPO, 'tests', 'fixtures', 'stateful-mcp-server.js')], { env });
  let out = '';
  gw.stdout.on('data', c => { out += c; });
  const exit = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'place_order', arguments: { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' } } });
  // Three exits written at once, as parallel tool calls would.
  gw.stdin.write(`${[exit(1), exit(2), exit(3)].map(m => JSON.stringify(m)).join('\n')}\n`);
  gw.stdin.end();
  await new Promise(resolve => gw.on('close', resolve));
  const byId = Object.fromEntries(out.trim().split('\n').map(l => JSON.parse(l)).map(r => [r.id, r]));
  assert.strictEqual(byId[1].result.isError, undefined, 'the first exit is forwarded');
  for (const id of [2, 3]) {
    assert.strictEqual(byId[id].result.isError, true, `exit ${id} must be blocked`);
    assert.match(byId[id].result.content[0].text, /\[exposure\]/);
  }
});

test('MCP gateway: a confirmed close lets the closed position\'s stop be cancelled before the account shows it', async () => {
  const { spawn } = require('child_process');
  const run = async extra => {
    const dir = tmpDir();
    const env = {
      PATH: process.env.PATH, HOME: dir, START_NET: '1', FILL_DELAY_MS: '1500', STOP_ORDER: '1', ...extra,
      FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_API_URL: 'https://api.fake-broker.test', FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '1,7', FAKE_BROKER_JOURNAL: writeJournal(dir, []), FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
    };
    const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js'), '--', process.execPath, path.join(REPO, 'tests', 'fixtures', 'stateful-mcp-server.js')], { env });
    let out = '';
    gw.stdout.on('data', c => { out += c; });
    const msg = (id, name, args) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    // The runner's flatten: close, then cancel the leftover stop at once (the fill lands 1.5 s later).
    gw.stdin.write(`${msg(1, 'close_position', { accountId: 1, contractId: EXIT_BASE.contractId, reason: '[exit] runner' })}\n${msg(2, 'cancel_order', { accountId: 1, orderId: 9 })}\n`);
    gw.stdin.end();
    await new Promise(resolve => gw.on('close', resolve));
    return Object.fromEntries(out.trim().split('\n').map(l => JSON.parse(l)).map(r => [r.id, r]));
  };
  const ok = await run({});
  assert.strictEqual(ok[2].result.isError, undefined, 'the stop of a confirmed close may be cancelled');
  const refused = await run({ CLOSE_FAIL: '1' });
  assert.strictEqual(refused[2].result.isError, true, 'a refused close leaves the position: its stop stays');
  assert.match(refused[2].result.content[0].text, /protective stop/);
});

test('MCP gateway: with no command it starts the broker server named in the broker config', async () => {
  const { spawn } = require('child_process');
  const dir = tmpDir();
  const brokers = homeBrokers(dir, { fake: { command: [process.execPath, path.join(REPO, 'tests', 'fixtures', 'fake-mcp-server.js')] } });
  const env = {
    PATH: process.env.PATH, HOME: dir, FTH_HOME: dir, FTH_BROKERS_FILE: brokers, FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '1,7', FAKE_BROKER_JOURNAL: writeJournal(dir, []),
    FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
  };
  const run = extra => new Promise(resolve => {
    const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js')], { env: { ...env, ...extra } });
    let out = '';
    let err = '';
    gw.stdout.on('data', c => { out += c; });
    gw.stderr.on('data', c => { err += c; });
    gw.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_bars', arguments: {} } })}\n`);
    gw.on('close', code => resolve({ code, out, err }));
  });
  const ok = await run({});
  assert.strictEqual(JSON.parse(ok.out.trim()).result.content[0].text, 'forwarded:tools/call:get_bars');
  const unknown = await run({ FTH_BROKER: 'nope' });
  assert.strictEqual(unknown.code, 2);
  assert.match(unknown.err, /unknown broker "nope"/);
});

test('MCP gateway: the configured server sits behind the contract translator: standard names above it, the broker\'s ids below', async () => {
  const { spawn } = require('child_process');
  const dir = tmpDir();
  const argsFile = path.join(dir, 'args.jsonl');
  const fake = path.join(REPO, 'tests', 'fixtures', 'broker-mcp-server.js');
  fs.writeFileSync(path.join(dir, 'brokers.json'), JSON.stringify({ broker: 'fake', brokers: { fake: { command: [process.execPath, fake] } } }));
  const env = {
    PATH: process.env.PATH, HOME: dir, FTH_HOME: dir, FAKE_ARGS: argsFile, FTH_JOURNAL_PATH: writeJournal(dir, []),
    FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
  };
  const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js')], { env });
  let out = '';
  gw.stdout.on('data', c => { out += c; });
  const call = (id, name, args) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  gw.stdin.write(`${[
    call(1, 'search_contracts', { searchText: 'MNQ' }),
    call(2, 'list_open_positions', { accountId: 7 }),
    call(3, 'place_order', { accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: '[exit] flatten the long' }),
    call(4, 'get_bars', { contractId: 'ES', unit: 'minute', unitNumber: 1, limit: 5 }),
    call(5, 'close_position', { accountId: 7, contractId: 'fake:MNQ:Z26' }),
  ].join('\n')}\n`);
  // Every reply in (not a fixed sleep: a loaded machine can take longer than any guess), then the end of input.
  const answered = () => new Set(out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l).id));
  for (const until = Date.now() + 30000; [1, 2, 3, 4, 5].some(id => !answered().has(id)) && Date.now() < until;) await new Promise(r => setTimeout(r, 25));
  gw.stdin.end();
  await new Promise(resolve => gw.on('close', resolve));
  const byId = Object.fromEntries(out.trim().split('\n').map(l => JSON.parse(l)).map(r => [r.id, r]));
  const data = id => JSON.parse(byId[id].result.content[0].text);
  // Above the translator: standard names only.
  assert.deepStrictEqual(data(1).map(c => c.id), ['MNQ', 'MNQ:2027-03']);
  assert.strictEqual(data(2)[0].contractId, 'MNQ');
  assert.strictEqual(byId[3].result.isError, undefined, 'the gate judged the exit on the standard name and let it through');
  assert.match(byId[4].result.content[0].text, /^contract-translator: not sent: no ES contract found at this broker/);
  // Below it: the server only ever saw its own ids.
  const seen = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const placed = seen.find(c => c.name === 'place_order');
  assert.strictEqual(placed.args.contractId, 'fake:MNQ:Z26');
  assert.ok(!seen.some(c => c.args && c.args.contractId === 'MNQ'), 'no standard name reached the server');
  assert.ok(seen.some(c => c.name === 'close_position' && c.args.contractId === 'fake:MNQ:Z26'), 'a broker id still closes: it goes through as is');
  assert.ok(!byId[5].result.isError, byId[5].result.content && byId[5].result.content[0].text);
});

async function gatewayRun(extraEnv, messages, { gapMs = 0, dir = tmpDir() } = {}) {
  const { spawn } = require('child_process');
  const env = {
    PATH: process.env.PATH, HOME: dir, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_API_URL: 'https://api.fake-broker.test', FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '1,7', FAKE_BROKER_JOURNAL: writeJournal(dir, []),
    FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test', ...extraEnv,
  };
  const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js'), '--', process.execPath, path.join(REPO, 'tests', 'fixtures', 'fake-mcp-server.js')], { env });
  let out = '';
  gw.stdout.on('data', c => { out += c; });
  for (const m of messages) {
    gw.stdin.write(`${JSON.stringify(m)}\n`);
    if (gapMs) await new Promise(r => setTimeout(r, gapMs));
  }
  gw.stdin.end();
  await new Promise(resolve => gw.on('close', resolve));
  const all = out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { byId: Object.fromEntries(all.map(r => [r.id, r])), all, dir };
}

const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const LONG1 = JSON.stringify([{ contractId: 'MNQ', type: 1, size: 1 }]);

test('MCP gateway wiring: a replayed day over a home that replayed another day first trades exactly as a fresh home does: earlier, unseen post-roll and later days, never a wrong month, never a refused exit of the position\'s own month', async () => {
  const { spawn } = require('child_process');
  const { stopLossBracket: _sl, ...exitBase } = ORDER;
  // December is the front month before the roll on 2026-10-08, March from it on.
  const contracts = day => JSON.stringify([{ id: 'sim-Z6', name: 'MNQZ6', tickSize: 0.25, tickValue: 0.5, activeContract: day < '2026-10-08' }, { id: 'sim-H7', name: 'MNQH7', tickSize: 0.25, tickValue: 0.5, activeContract: day >= '2026-10-08' }]);
  const newHome = () => {
    const dir = tmpDir();
    const home = path.join(dir, '.futures-trading-harness');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, path.join(REPO, 'tests', 'fixtures', 'fake-mcp-server.js')], journal: writeJournal(dir, []), allowedAccountsEnv: 'SIM_ALLOWED_ACCOUNTS', replay: true } } }));
    return dir;
  };
  let k = 0;
  const run = async (dir, day, messages, position = null) => {
    const argsFile = path.join(dir, `args-${k += 1}.jsonl`);
    const at = `${day}T14:30:00.000Z`;
    const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js')], { env: {
      PATH: process.env.PATH, HOME: dir, FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: '2026-10-10T15:00:00.000Z', NODE_ENV: 'test',
      SIM_ALLOWED_ACCOUNTS: '1,7', FAKE_ARGS: argsFile, FTH_REPLAY_NOW: at, FAKE_SERVER_CONFIG: JSON.stringify({ tradingEnabled: true, maxOrderSize: 5, serverTime: at, replay: true }),
      FAKE_CONTRACTS: contracts(day), FAKE_POSITIONS: JSON.stringify(position ? [{ contractId: position, type: 1, size: 1 }] : []),
    } });
    let out = '';
    gw.stdout.on('data', c => { out += c; });
    const replies = () => out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    for (const m of messages) {
      gw.stdin.write(`${JSON.stringify(m)}\n`);
      for (let t = 0; t < 400 && !replies().some(r => r.id === m.id); t += 1) await new Promise(r => setTimeout(r, 25));
    }
    gw.stdin.end();
    await new Promise(r => gw.on('close', r));
    const texts = replies().sort((a, b) => a.id - b.id).map(r => r.result.content[0].text.slice(0, 400));
    const sent = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(c => /place_order|close/.test(c.name)).map(c => `${c.name} ${c.args.contractId}`) : [];
    return { texts, sent };
  };
  const month = { 'sim-Z6': 'MNQ:2026-12', 'sim-H7': 'MNQ:2027-03' };
  const other = { 'sim-Z6': 'MNQ:2027-03', 'sim-H7': 'MNQ:2026-12' };
  const exit = (id, contractId) => call(id, 'place_order', { ...exitBase, contractId, side: 'sell', rationale: '[exit] flatten' });
  // The day starts with a contract lookup (as premarket does: the fake server has no get_contract).
  const probes = pos => [call(0, 'search_contracts', { searchText: 'MNQ' }), call(1, 'list_open_positions', { accountId: 1 }), exit(2, other[pos]), call(3, 'partial_close_position', { accountId: 1, contractId: other[pos], size: 1 }), exit(4, month[pos])];
  const reused = newHome();
  await run(reused, '2026-10-09', [call(0, 'search_contracts', { searchText: 'MNQ' })]); // a later day first: March
  for (const day of ['2026-10-05', '2026-10-08', '2026-10-12', '2026-10-06']) {
    for (const pos of ['sim-Z6', 'sim-H7']) {
      const r = await run(reused, day, probes(pos), pos);
      const fresh = await run(newHome(), day, probes(pos), pos);
      assert.deepStrictEqual(r, fresh, `${day} ${pos}: as a fresh home`);
      assert.deepStrictEqual(r.sent, [`place_order ${pos}`], `${day} ${pos}: only the position's own exit reached the server`);
      assert.match(r.texts[2], /\[exposure\]/, `${day} ${pos}: the other month's exit is refused`);
      assert.match(r.texts[3], /\[partial-close\]/);
      assert.match(r.texts[1], new RegExp(`"contractId": "${day < '2026-10-08' === (pos === 'sim-Z6') ? 'MNQ' : month[pos]}"`), `${day} ${pos}: listed by that day's front month`);
    }
  }
  // A day's very first call, with nothing looked up that day: the gateway has the translator look the front month up
  // before naming it, so the two name it alike (a December long on 2026-10-07; after the roll on 2026-10-13).
  const first = async (day, msgs) => run(reused, day, msgs, 'sim-Z6');
  const dec = await first('2026-10-07', [exit(1, 'MNQ:2026-12')]);
  assert.deepStrictEqual(dec.sent, ['place_order sim-Z6'], dec.texts.join(' | '));
  const roll = await first('2026-10-13', [exit(1, 'MNQ'), exit(2, 'MNQ:2026-12')]);
  assert.match(roll.texts[0], /\[exposure\]/, 'MNQ is March after the roll: a sell there would open a short');
  assert.deepStrictEqual(roll.sent, ['place_order sim-Z6']);
  // A close by the month, then an exit by the root, first thing on a new day: the close counts for the exit.
  const closed = await run(reused, '2026-10-14', [call(1, 'close_position', { accountId: 1, contractId: 'MNQ:2027-03' }), exit(2, 'MNQ')], 'sim-H7');
  assert.deepStrictEqual(closed.sent, ['close_position sim-H7']);
  assert.match(closed.texts[1], /\[exposure\][\s\S]*once recent orders fill/, closed.texts.join(' | '));
});

test('MCP gateway wiring: on a replayed day a hung or slow front-month lookup costs an exit no more than on main: one call timeout when it hangs (fail closed), a few seconds when slow', { timeout: 60000 }, async () => {
  const { spawn } = require('child_process');
  const { stopLossBracket: _sl, ...exitBase } = ORDER;
  const run = async extra => {
    const dir = tmpDir();
    const home = path.join(dir, '.futures-trading-harness');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, path.join(REPO, 'tests', 'fixtures', 'fake-mcp-server.js')], journal: writeJournal(dir, []), allowedAccountsEnv: 'SIM_ALLOWED_ACCOUNTS', replay: true } } }));
    // The day before looked MNQ up: its ids name the December long today, whatever today's lookup does.
    fs.writeFileSync(path.join(home, 'contracts-sim.2026-10-06.json'), JSON.stringify({ ids: { 'sim-Z6': { root: 'MNQ', month: '2026-12' } }, front: { MNQ: { id: 'sim-Z6', month: '2026-12', day: '2026-10-06' } } }));
    const argsFile = path.join(dir, 'args.jsonl');
    const at = '2026-10-07T14:30:00.000Z';
    const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js')], { env: {
      PATH: process.env.PATH, HOME: dir, FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: '2026-10-10T15:00:00.000Z', NODE_ENV: 'test',
      SIM_ALLOWED_ACCOUNTS: '1,7', FAKE_ARGS: argsFile, FTH_REPLAY_NOW: at, FAKE_SERVER_CONFIG: JSON.stringify({ tradingEnabled: true, maxOrderSize: 5, serverTime: at, replay: true }),
      FAKE_CONTRACTS: JSON.stringify([{ id: 'sim-Z6', name: 'MNQZ6', tickSize: 0.25, tickValue: 0.5, activeContract: true }]), FAKE_POSITIONS: JSON.stringify([{ contractId: 'sim-Z6', type: 1, size: 1 }]), ...extra,
    } });
    let out = '';
    gw.stdout.on('data', c => { out += c; });
    // The clock starts once the gateway, the translator and the server are up (an initialize answered from the server):
    // the exit's own cost is timed, not three processes starting on a loaded machine.
    gw.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`);
    for (const until = Date.now() + 20000; !out.includes('"id":0');) { assert.ok(Date.now() < until, `the gateway never answered initialize: ${out}`); await new Promise(r => setTimeout(r, 25)); }
    const t0 = Date.now();
    gw.stdin.write(`${JSON.stringify(call(1, 'place_order', { ...exitBase, contractId: 'MNQ:2026-12', side: 'sell', rationale: '[exit] flatten' }))}\n`);
    for (const until = Date.now() + 40000; !out.includes('"id":1');) { assert.ok(Date.now() < until, 'no answer to the exit'); await new Promise(r => setTimeout(r, 25)); }
    const took = Date.now() - t0;
    gw.stdin.end();
    await new Promise(r => gw.on('close', r));
    const text = JSON.parse(out.trim().split('\n').find(l => l.includes('"id":1'))).result.content[0].text;
    const sent = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(c => c.name === 'place_order').map(c => c.args.contractId);
    return { took, text, sent };
  };
  // The lookup hangs: the account read waits on it and the gate fails closed at one call timeout (15 s), as on
  // main; nothing waits on a lookup of its own first, and nothing reaches the server.
  const hung = await run({ FAKE_DROP: 'search_contracts' });
  assert.match(hung.text, /the order gate could not run \((list_open_positions|list_open_orders) timed out\)/, 'whichever account read times out first (an exit never reads the fills)');
  assert.deepStrictEqual(hung.sent, []);
  // One call timeout (15 s), timed from the gateway being up: under the translator's lookup timeout (20 s), so waiting on
  // the lookup before the account reads (or a second timeout) fails it, and a loaded machine's late timer does not.
  assert.ok(hung.took < require(path.join(REPO, 'scripts', 'lib', 'trading', 'mcp-gateway')).LOOKUP_TIMEOUT_MS, `${hung.took} ms`);
  // A slow broker (every lookup and order reply 1.5 s late): a few seconds, never a timeout's worth.
  const slow = await run({ FAKE_DELAY_MS: '1500' });
  assert.deepStrictEqual(slow.sent, ['sim-Z6'], slow.text);
  assert.ok(slow.took < 9000, `${slow.took} ms`);
});

// A live gateway (no replay clock) over a home whose contract cache was written on an earlier call: `front` is the
// front month it recorded and the day it did. December is the front month before the roll, March after it.
const ROLL_IDS = { 'sim-Z6': { root: 'MNQ', month: '2026-12' }, 'sim-H7': { root: 'MNQ', month: '2027-03' } };
const rollContracts = active => JSON.stringify([{ id: 'sim-Z6', name: 'MNQZ6', tickSize: 0.25, tickValue: 0.5, activeContract: active === 'sim-Z6' }, { id: 'sim-H7', name: 'MNQH7', tickSize: 0.25, tickValue: 0.5, activeContract: active === 'sim-H7' }]);
// `dir`: a home an earlier run used (its contract cache and order records are kept).
// `gaps`: ms to wait before sending the message of that id (FTH_TEST_NOW's clock runs on from its start).
async function liveRollRun({ now, front, active, position, messages, extra = {}, dir: given = null, waitMs = 40000, gaps = {} }) {
  const { spawn } = require('child_process');
  const dir = given || tmpDir();
  const home = path.join(dir, '.futures-trading-harness');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, path.join(REPO, 'tests', 'fixtures', 'fake-mcp-server.js')], journal: writeJournal(dir, []), allowedAccountsEnv: 'SIM_ALLOWED_ACCOUNTS' } } }));
  if (!given) fs.writeFileSync(path.join(home, 'contracts-sim.json'), JSON.stringify({ ids: ROLL_IDS, front: front ? { MNQ: { id: front.id, month: ROLL_IDS[front.id].month, day: front.day } } : {} }));
  const argsFile = path.join(dir, 'args.jsonl');
  const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js')], { env: {
    PATH: process.env.PATH, HOME: dir, FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: now, NODE_ENV: 'test',
    SIM_ALLOWED_ACCOUNTS: '1,7', FAKE_ARGS: argsFile, FAKE_CONTRACTS: rollContracts(active),
    FAKE_POSITIONS: JSON.stringify([].concat(position || []).map(p => ({ contractId: p, type: 1, size: 1 }))), ...extra,
  } });
  let out = '';
  gw.stdout.on('data', c => { out += c; });
  const replies = () => out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const m of messages) {
    if (gaps[m.id]) await new Promise(r => setTimeout(r, gaps[m.id]));
    gw.stdin.write(`${JSON.stringify(m)}\n`);
    for (let t = 0; t < waitMs / 25 && !replies().some(r => r.id === m.id); t += 1) await new Promise(r => setTimeout(r, 25));
  }
  gw.stdin.end();
  await new Promise(r => gw.on('close', r));
  const texts = Object.fromEntries(replies().map(r => [r.id, r.result.content[0].text.slice(0, 400)]));
  const sent = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(c => /place_order|close/.test(c.name)).map(c => `${c.name} ${c.args.contractId}`) : [];
  return { texts, sent, dir, cache: JSON.parse(fs.readFileSync(path.join(home, 'contracts-sim.json'), 'utf8')) };
}
const rollExit = (id, contractId, side = 'sell') => call(id, 'place_order', { ...EXIT_BASE, contractId, side, rationale: '[exit] flatten' });
const rollPartial = (id, contractId) => call(id, 'partial_close_position', { accountId: 1, contractId, size: 1 });
const rollClose = (id, contractId) => call(id, 'close_position', { accountId: 1, contractId });
// The first call after a roll, live: yesterday's cache says December, the broker marks March active.
const ROLL = { now: TEST_NOW, front: { id: 'sim-Z6', day: '2026-10-06' }, active: 'sim-H7' };

test('MCP gateway wiring, live: the first call after a roll, with yesterday\'s December front month cached, never sends an exit to a month with no position (A) and never refuses one on the month that has it (B)', async () => {
  // A: long 1 March; an [exit] sell named for December as the very first call would open a December short.
  const a = await liveRollRun({ ...ROLL, position: 'sim-H7', messages: [rollExit(1, 'MNQ:2026-12')] });
  assert.match(a.texts[1], /\[exposure\][\s\S]*MNQ:2026-12[\s\S]*open MNQ position is in MNQ\b/, a.texts[1]);
  assert.deepStrictEqual(a.sent, [], 'nothing reached the server');
  assert.deepStrictEqual([a.cache.front.MNQ.id, a.cache.front.MNQ.day], ['sim-H7', '2026-10-07'], 'the front month was refreshed from the broker\'s active contract');
  // B: a partial close of the March long named by its month, as the very first call: allowed, sent to March.
  const b = await liveRollRun({ ...ROLL, position: 'sim-H7', messages: [rollPartial(1, 'MNQ:2027-03')] });
  assert.doesNotMatch(b.texts[1], /\[partial-close\]/, b.texts[1]);
  assert.deepStrictEqual(b.sent, ['partial_close_position sim-H7']);
  // The same exit by its month, or by the root (March from today), first thing: sent to March, never December.
  for (const name of ['MNQ:2027-03', 'MNQ']) {
    const r = await liveRollRun({ ...ROLL, position: 'sim-H7', messages: [rollExit(1, name)] });
    assert.deepStrictEqual(r.sent, ['place_order sim-H7'], `${name}: ${r.texts[1]}`);
  }
  // A partial close named for December (no position there) is refused; the buy side of a long is refused too.
  const wrong = await liveRollRun({ ...ROLL, position: 'sim-H7', messages: [rollPartial(1, 'MNQ:2026-12'), rollExit(2, 'MNQ:2027-03', 'buy')] });
  assert.match(wrong.texts[1], /\[partial-close\]/);
  assert.match(wrong.texts[2], /\[exposure\][\s\S]*same side/);
  assert.deepStrictEqual(wrong.sent, []);
});

test('MCP gateway wiring, live: on the roll day a position still open in the old month is exited by its month; the root means the new month', async () => {
  const r = await liveRollRun({ ...ROLL, position: 'sim-Z6', messages: [rollExit(1, 'MNQ'), rollPartial(2, 'MNQ'), rollExit(3, 'MNQ:2026-12')] });
  assert.match(r.texts[1], /\[exposure\][\s\S]*open MNQ position is in MNQ:2026-12/, 'MNQ is March now: a sell there would open a short');
  assert.match(r.texts[2], /\[partial-close\]/);
  assert.deepStrictEqual(r.sent, ['place_order sim-Z6'], JSON.stringify(r.texts));
  const partial = await liveRollRun({ ...ROLL, position: 'sim-Z6', messages: [rollPartial(1, 'MNQ:2026-12')] });
  assert.deepStrictEqual(partial.sent, ['partial_close_position sim-Z6'], partial.texts[1]);
  // Flattening always works: close_position by the position's month.
  const flat = await liveRollRun({ ...ROLL, position: 'sim-Z6', messages: [rollClose(1, 'MNQ:2026-12')] });
  assert.deepStrictEqual(flat.sent, ['close_position sim-Z6']);
  // Both months open on the roll day: each exit goes to its own month only.
  const both = await liveRollRun({ ...ROLL, position: ['sim-Z6', 'sim-H7'], messages: [rollExit(1, 'MNQ:2026-12'), rollExit(2, 'MNQ')] });
  assert.deepStrictEqual(both.sent, ['place_order sim-Z6', 'place_order sim-H7'], JSON.stringify(both.texts));
  // The day's front month was looked up before the broker flagged the roll (December, today): it stays fixed for
  // the trading day, and every name still means one month to the gate and the translator alike.
  const fixed = await liveRollRun({ now: TEST_NOW, front: { id: 'sim-Z6', day: '2026-10-07' }, active: 'sim-H7', position: 'sim-H7', messages: [rollExit(1, 'MNQ'), rollExit(2, 'MNQ:2027-03')] });
  assert.match(fixed.texts[1], /\[exposure\]/, 'MNQ is still December today: refused');
  assert.deepStrictEqual(fixed.sent, ['place_order sim-H7']);
  assert.strictEqual(fixed.cache.front.MNQ.id, 'sim-Z6', 'fixed for the trading day');
});

test('MCP gateway wiring, live: crossing 18:00 ET starts a new trading day, so the front month is looked up again before any exit is judged', async () => {
  // Looked up at 17:59 ET (December); the broker marks March from the 18:00 ET session.
  const before = { now: '2026-10-07T21:59:00.000Z', front: { id: 'sim-Z6', day: '2026-10-07' }, active: 'sim-H7', position: 'sim-H7' };
  const pre = await liveRollRun({ ...before, messages: [rollExit(1, 'MNQ'), rollExit(2, 'MNQ:2027-03')] });
  assert.match(pre.texts[1], /\[exposure\]/, 'still the 2026-10-07 trading day: MNQ is December');
  assert.deepStrictEqual(pre.sent, ['place_order sim-H7']);
  const post = await liveRollRun({ ...before, now: '2026-10-07T22:01:00.000Z', messages: [rollExit(1, 'MNQ:2026-12'), rollExit(2, 'MNQ')] });
  assert.match(post.texts[1], /\[exposure\]/, '18:01 ET: December has no position');
  assert.deepStrictEqual(post.sent, ['place_order sim-H7'], JSON.stringify(post.texts));
  assert.deepStrictEqual([post.cache.front.MNQ.id, post.cache.front.MNQ.day], ['sim-H7', '2026-10-08']);
  const partial = await liveRollRun({ ...before, now: '2026-10-07T22:01:00.000Z', messages: [rollPartial(1, 'MNQ:2027-03')] });
  assert.deepStrictEqual(partial.sent, ['partial_close_position sim-H7'], partial.texts[1]);
});

test('MCP gateway wiring, live: an exit by the root answered just before 18:00 ET is counted by its month, so just after 18:00 (March the new front month) the March long\'s only stop still can\'t be cancelled', { timeout: 60000 }, async () => {
  // 17:59:58.5 ET, December the front month (looked up today); long 1 December and long 1 March, March's stop order 9.
  // The exit sell by MNQ (December) is allowed and answered; 3.5 s later, past 18:00 ET, March's stop is cancelled.
  const r = await liveRollRun({ now: '2026-10-07T21:59:58.500Z', front: { id: 'sim-Z6', day: '2026-10-07' }, active: 'sim-H7', position: ['sim-Z6', 'sim-H7'],
    extra: { FAKE_ORDERS: JSON.stringify([{ id: 9, contractId: 'sim-H7', type: 4, side: 1, size: 1, stopPrice: 21480 }]) },
    gaps: { 2: 3500 }, messages: [rollExit(1, 'MNQ'), call(2, 'cancel_order', { accountId: 1, orderId: 9 })] });
  assert.deepStrictEqual(r.sent, ['place_order sim-Z6'], JSON.stringify(r.texts));
  assert.match(r.texts[2], /\[cancel-protection\]/, 'kept under the root, the December exit would count against March and let its only stop go');
  assert.deepStrictEqual([r.cache.front.MNQ.id, r.cache.front.MNQ.day], ['sim-H7', '2026-10-08'], 'the cancel was judged on the new trading day');
});

test('MCP gateway wiring, live: an exit of unknown outcome sent by the root before 18:00 ET is kept by its month, so after 18:00 (a new front month) it is never counted against the new month\'s position', async () => {
  // 17:59:30 ET, December the front month (looked up today), long 1 December: an [exit] by the root gets no reply.
  const first = await liveRollRun({ now: '2026-10-07T21:59:30.000Z', front: { id: 'sim-Z6', day: '2026-10-07' }, active: 'sim-Z6', position: 'sim-Z6',
    extra: { FAKE_DROP: 'place_order', FTH_LANE_TIMEOUT_MS: '300' }, waitMs: 1500, messages: [rollExit(1, 'MNQ')] });
  assert.deepStrictEqual(first.sent, ['place_order sim-Z6']);
  const records = fs.readdirSync(path.join(first.dir, '.futures-trading-harness'), { recursive: true }).map(String).filter(f => /pending|marker|order/i.test(f) && f.endsWith('.json'));
  const kept = records.map(f => fs.readFileSync(path.join(first.dir, '.futures-trading-harness', f), 'utf8')).join('\n');
  assert.match(kept, /"contractId": ?"MNQ:2026-12"/, `the record keeps December by its month: ${records.join(', ')}`);
  // 18:00:30 ET, the broker marks March active; long 1 March: its protective stop and a partial close go (counted
  // under the root, the December exit would make March look closed and refuse both).
  const protect = (id, contractId) => call(id, 'place_order', { ...EXIT_BASE, contractId, side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the March long' });
  const later = await liveRollRun({ dir: first.dir, now: '2026-10-07T22:00:30.000Z', active: 'sim-H7', position: 'sim-H7', extra: { FTH_LANE_TIMEOUT_MS: '300' },
    messages: [call(1, 'list_open_positions', { accountId: 1 }), protect(2, 'MNQ')] });
  assert.match(later.texts[1], /"contractId": "MNQ"/, 'March is MNQ now');
  assert.deepStrictEqual(later.sent, [...first.sent, 'place_order sim-H7'], later.texts[2]);
  const partial = await liveRollRun({ dir: first.dir, now: '2026-10-07T22:00:40.000Z', active: 'sim-H7', position: 'sim-H7', extra: { FTH_LANE_TIMEOUT_MS: '300' }, messages: [rollPartial(1, 'MNQ')] });
  assert.ok(partial.sent.includes('partial_close_position sim-H7'), partial.texts[1]);
});

test('MCP gateway wiring, live: a late, errored or lost broker reply on the first call after a roll never sends an exit to the wrong month, and close_position always goes', { timeout: 120000 }, async () => {
  // The front-month search errors: the gate can't tell what MNQ means today, so the root and the empty month are
  // refused; the position's own month still exits (A and B under a broker error).
  const errored = await liveRollRun({ ...ROLL, position: 'sim-H7', extra: { FAKE_ERROR: 'search_contracts' },
    messages: [rollExit(1, 'MNQ:2026-12'), rollExit(2, 'MNQ'), rollExit(3, 'MNQ:2027-03')] });
  assert.match(errored.texts[1], /\[exposure\]/);
  assert.match(errored.texts[2], /\[exposure\]/);
  assert.deepStrictEqual(errored.sent, ['place_order sim-H7'], JSON.stringify(errored.texts));
  const erroredPartial = await liveRollRun({ ...ROLL, position: 'sim-H7', extra: { FAKE_ERROR: 'search_contracts' }, messages: [rollPartial(1, 'MNQ:2027-03')] });
  assert.deepStrictEqual(erroredPartial.sent, ['partial_close_position sim-H7'], erroredPartial.texts[1]);
  // An old-month position under the same error: named by its month (never by yesterday's front month), so its exit
  // by that month goes and the root, unknown today, is refused.
  const erroredOld = await liveRollRun({ ...ROLL, position: 'sim-Z6', extra: { FAKE_ERROR: 'search_contracts' }, messages: [call(1, 'list_open_positions', { accountId: 1 }), rollExit(2, 'MNQ'), rollExit(3, 'MNQ:2026-12')] });
  assert.match(erroredOld.texts[1], /"contractId": "MNQ:2026-12"/, 'the agent sees the month');
  assert.match(erroredOld.texts[2], /\[exposure\]/);
  assert.deepStrictEqual(erroredOld.sent, ['place_order sim-Z6'], JSON.stringify(erroredOld.texts));
  // Late replies (the search and the account reads 1.5 s late): judged on the refreshed front month.
  const late = await liveRollRun({ ...ROLL, position: 'sim-H7', extra: { FAKE_DELAY_MS: '1500', FAKE_ACCOUNT_DELAY_MS: '1500' }, messages: [rollExit(1, 'MNQ:2026-12'), rollPartial(2, 'MNQ:2027-03')] });
  assert.match(late.texts[1], /\[exposure\]/);
  assert.deepStrictEqual(late.sent, ['partial_close_position sim-H7']);
  // The positions can't be read (an error reply): every gated exit fails closed; close_position still goes.
  const noPositions = await liveRollRun({ ...ROLL, position: 'sim-H7', extra: { FAKE_ERROR: 'list_open_positions' },
    messages: [rollExit(1, 'MNQ:2026-12'), rollPartial(2, 'MNQ:2027-03'), rollClose(3, 'MNQ:2027-03')] });
  assert.match(noPositions.texts[1], /could not run/);
  assert.match(noPositions.texts[2], /could not run/);
  assert.deepStrictEqual(noPositions.sent, ['close_position sim-H7']);
  // The positions reply is lost: the exit fails closed at the call timeout; close_position still goes.
  const lost = await liveRollRun({ ...ROLL, position: 'sim-H7', extra: { FAKE_DROP: 'list_open_positions' }, messages: [rollExit(1, 'MNQ:2026-12'), rollClose(2, 'MNQ:2027-03')] });
  assert.match(lost.texts[1], /could not run \(list_open_positions timed out\)/);
  assert.deepStrictEqual(lost.sent, ['close_position sim-H7']);
});

test('MCP gateway: an entry for a regime-gated strategy (fx_orb) fetches its bars: no regime refusal in a trend, a regime refusal in a range, and a refusal when the bars can\'t be read', async () => {
  // fx_orb: the fixture holding the retired orb rules (regime_gate, trend and transition), loaded from FX_GOLDEN.
  const FX = { FTH_STRATEGIES_DIRS: FX_GOLDEN };
  const gated = { ...ORDER, rationale: 'setup:fx_orb long, stop 21480, target 21540, risk $40' };
  const bars = fn => JSON.stringify({ bars: Array.from({ length: 160 }, (_, k) => {
    const c = fn(k);
    return { t: new Date(Date.parse(TEST_NOW) - (160 - k) * 180000).toISOString(), o: c, h: c + 1, l: c - 1, c, v: 100 };
  }) });
  const text = r => r.result.content[0].text;
  const REGIME = /\[regime\] setup:fx_orb trades only in trend, transition; the 3m regime is/;
  // (Other checks refuse this bare order too, e.g. no plan or signal recorded: only the regime line is under test.)
  // A steady climb: trend-up, so no regime refusal; the gateway asked the broker for the strategy's 500 3m bars.
  const argsFile = path.join(tmpDir(), 'args.jsonl');
  const trend = await gatewayRun({ ...FX, FAKE_BARS: bars(k => 21000 + k * 0.8), FAKE_ARGS: argsFile }, [call(1, 'place_order', gated)]);
  assert.doesNotMatch(text(trend.byId[1]), REGIME);
  const req = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(c => c.name === 'get_bars');
  assert.deepStrictEqual(req.args, { contractId: gated.contractId, unit: 'minute', unitNumber: 3, limit: 500, includePartialBar: false });
  // Chop through VWAP: range, refused.
  const chop = await gatewayRun({ ...FX, FAKE_BARS: bars(k => 21000 + Math.sin(k / 2) * 2) }, [call(2, 'place_order', gated)]);
  assert.match(text(chop.byId[2]), REGIME);
  assert.notStrictEqual(text(chop.byId[2]), 'forwarded:tools/call:place_order');
  // Bars that can't be read: the check can't run, so the entry is refused (fail closed).
  const broken = await gatewayRun({ ...FX, FAKE_BARS: 'not json' }, [call(3, 'place_order', gated)]);
  assert.ok(broken.byId[3].result.isError, text(broken.byId[3]));
  assert.match(text(broken.byId[3]), /could not run \(get_bars returned non-JSON content\)/, 'refused because the bars could not be read');
  assert.notStrictEqual(text(broken.byId[3]), 'forwarded:tools/call:place_order');
  // An exit naming the strategy is never regime-checked.
  const exit = await gatewayRun({ ...FX, FAKE_POSITIONS: LONG1, FAKE_BARS: 'not json' }, [call(4, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten setup:fx_orb' })]);
  assert.strictEqual(text(exit.byId[4]), 'forwarded:tools/call:place_order');
});

test('MCP gateway wiring: a failed, lost or null search_trades never holds an [exit] or a [protect] (they never ask for the fills); an entry is still refused', { timeout: 60000 }, async () => {
  const text = r => r.result.content[0].text;
  const exit = id => call(id, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' });
  const protect = id => call(id, 'place_order', { ...EXIT_BASE, side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long' });
  for (const fault of [{ FAKE_ERROR: 'search_trades' }, { FAKE_DROP: 'search_trades' }, { FAKE_TRADES: 'null' }]) {
    const argsFile = path.join(tmpDir(), 'args.jsonl');
    const label = JSON.stringify(fault);
    // Each on its own gateway (once an exit is sent, the long counts as closed for the next order), each timed:
    // no call timeout (15 s) waited on.
    const timed = async msg => {
      const t0 = Date.now();
      const r = await gatewayRun({ ...fault, FAKE_POSITIONS: LONG1, FAKE_ARGS: argsFile }, [msg]);
      assert.ok(Date.now() - t0 < require(path.join(REPO, 'scripts', 'lib', 'trading', 'mcp-gateway')).CALL_TIMEOUT_MS, `${label}: waited on a read it never uses`);
      return r;
    };
    const ex = await timed(exit(1));
    const pr = await timed(protect(2));
    assert.strictEqual(text(ex.byId[1]), 'forwarded:tools/call:place_order', `${label}: ${text(ex.byId[1])}`);
    assert.strictEqual(text(pr.byId[2]), 'forwarded:tools/call:place_order', `${label}: ${text(pr.byId[2])}`);
    const asked = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l).name);
    assert.ok(!asked.includes('search_trades'), `${label}: an exit asked for the fills`);
  }
  // An entry still reads the fills: a broker error there refuses it (fail closed), with the close_position hint.
  const entry = await gatewayRun({ FAKE_ERROR: 'search_trades' }, [call(3, 'place_order', ORDER)]);
  assert.ok(entry.byId[3].result.isError);
  assert.match(text(entry.byId[3]), /the order gate could not run \(search_trades failed: [^)]*\)\. The order was not sent; close_position still flattens\./);
});

test('MCP gateway wiring: an entry without its stopLossBracket is refused and never reaches the broker; with it, no stop-defined refusal', async () => {
  const text = r => r.result.content[0].text;
  const argsFile = path.join(tmpDir(), 'args.jsonl');
  // (Other checks refuse this bare order too, e.g. no plan recorded: only the stop-defined line is under test.)
  const bare = await gatewayRun({ FAKE_ARGS: argsFile }, [call(1, 'place_order', EXIT_BASE), call(2, 'place_order', { ...ORDER, stopLossBracket: { ticks: 0, type: 'stop' } })]);
  for (const id of [1, 2]) {
    assert.ok(bare.byId[id].result.isError, text(bare.byId[id]));
    assert.match(text(bare.byId[id]), /\[stop-defined\] Entry has no stop bracket: every entry carries its stop as stopLossBracket/);
  }
  const sent = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  assert.ok(!sent.some(c => c.name === 'place_order'), 'no unbracketed entry reached the broker');
  const bracketed = await gatewayRun({}, [call(3, 'place_order', ORDER)]);
  assert.doesNotMatch(text(bracketed.byId[3]), /\[stop-defined\]/);
  // A [protect] stop for an open position goes without a bracket.
  const protect = await gatewayRun({ FAKE_POSITIONS: LONG1 }, [call(4, 'place_order', { ...EXIT_BASE, side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long at 21480' })]);
  assert.strictEqual(text(protect.byId[4]), 'forwarded:tools/call:place_order');
});

test('MCP gateway: an order call reusing an in-flight request id is refused', async () => {
  const { all } = await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_DELAY_MS: '400' }, [
    call(7, 'get_bars', {}),
    call(7, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' }),
  ]);
  const texts = all.map(r => (r.error ? r.error.message : r.result.content[0].text));
  assert.ok(texts.some(t => /already in use/.test(t)), texts.join(' | '));
  assert.ok(texts.includes('forwarded:tools/call:get_bars'));
  assert.ok(!texts.includes('forwarded:tools/call:place_order'), 'the order never reached the server');
  const { byId: control } = await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_DELAY_MS: '400' }, [call(8, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' })]);
  assert.strictEqual(control[8].result.content[0].text, 'forwarded:tools/call:place_order');
});

test('MCP gateway: an order of unknown outcome blocks new entries, not exits, stop moves or cancels', async () => {
  const stop = JSON.stringify([{ id: 9, contractId: 'MNQ', side: 1, type: 4, size: 1, stopPrice: 21480 }]);
  const { byId } = await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_ORDERS: stop, FAKE_DELAY_MS: '1500', FTH_LANE_TIMEOUT_MS: '300' }, [
    call(1, 'place_order', { ...EXIT_BASE, side: 'sell', type: 'limit', limitPrice: 21600, rationale: '[exit] target' }),
    call(2, 'modify_order', { accountId: 1, orderId: 9, stopPrice: 21490, reason: '[protect] tighten' }),
    call(3, 'cancel_order', { accountId: 1, orderId: 9 }),
    call(4, 'close_position', { accountId: 1, contractId: 'MNQ' }),
    call(5, 'place_order', ORDER),
  ]);
  assert.strictEqual(byId[1].result.content[0].text, 'forwarded:tools/call:place_order', 'the reply came late, after the lane timed out');
  assert.strictEqual(byId[2].result.content[0].text, 'forwarded:tools/call:modify_order');
  assert.ok(!/order-pending/.test(byId[3].result.content[0].text), byId[3].result.content[0].text);
  assert.strictEqual(byId[4].result.content[0].text, 'forwarded:tools/call:close_position');
  assert.match(byId[5].result.content[0].text, /\[order-pending\] The outcome of an order is unknown: sell 1 MNQ .*close_position always goes/);
});

test('MCP gateway: an unknown order outcome survives a gateway restart until the broker\'s orders settle it', async () => {
  const dir = tmpDir();
  const argsFile = path.join(dir, 'args.jsonl');
  // Gateway 1: the broker never answers the order, and the gateway exits (an agent cycle ending).
  await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_DROP: 'place_order', FAKE_ARGS: argsFile, FTH_LANE_TIMEOUT_MS: '300' }, [
    call(1, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' }),
  ], { dir });
  const sent = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(c => c.name === 'place_order');
  const tag = sent.args.customTag;
  assert.match(tag, /^fth-[0-9a-f]{16}$/, 'the order went out with a customTag the gateway added');
  const pending = path.join(dir, '.futures-trading-harness', 'pending-orders');
  const records = () => fs.readdirSync(pending).map(f => JSON.parse(fs.readFileSync(path.join(pending, f), 'utf8')));
  assert.deepStrictEqual(records().map(r => [r.tag, r.accountId]), [[tag, EXIT_BASE.accountId]]);
  // Gateway 2 (a new cycle): the broker doesn't list it yet, so entries wait.
  const blockedRun = await gatewayRun({ FAKE_SEARCH_ORDERS: '[]' }, [call(2, 'place_order', ORDER)], { dir });
  assert.match(blockedRun.byId[2].result.content[0].text, /\[order-pending\]/);
  // Once the broker's orders show it, it is settled: no order-pending, and the record is gone.
  const shown = await gatewayRun({ FAKE_SEARCH_ORDERS: JSON.stringify([{ id: 77, customTag: tag, status: 2 }]) }, [call(3, 'place_order', ORDER)], { dir });
  assert.ok(!/order-pending/.test(shown.byId[3].result.content[0].text), shown.byId[3].result.content[0].text);
  assert.deepStrictEqual(records(), []);
});

test('MCP gateway: an unknown order the broker never lists is settled as not placed after the grace period', async () => {
  const dir = tmpDir();
  await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_DROP: 'place_order', FTH_LANE_TIMEOUT_MS: '300' }, [call(1, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten', customTag: 'exit-1' })], { dir });
  const pending = path.join(dir, '.futures-trading-harness', 'pending-orders');
  const tags = () => fs.readdirSync(pending).map(f => JSON.parse(fs.readFileSync(path.join(pending, f), 'utf8')).tag);
  assert.deepStrictEqual(tags(), ['exit-1'], 'the client\'s own customTag is kept');
  // A failed lookup settles nothing: entries stay blocked, and the message says why.
  const failing = await gatewayRun({ FAKE_SEARCH_ORDERS: 'not json', FTH_TEST_NOW: new Date(Date.parse(TEST_NOW) + 600000).toISOString() }, [call(2, 'place_order', ORDER)], { dir });
  assert.match(failing.byId[2].result.content[0].text, /\[order-pending\].*until the broker's orders \(search_orders\) can be read again/);
  // The grace period is never shorter than a lane's wait plus a margin (60 s by default here).
  const early = await gatewayRun({ FAKE_SEARCH_ORDERS: '[]', FTH_UNKNOWN_ORDER_GRACE_MS: '1', FTH_TEST_NOW: new Date(Date.parse(TEST_NOW) + 30000).toISOString() }, [call(2, 'place_order', ORDER)], { dir });
  assert.match(early.byId[2].result.content[0].text, /\[order-pending\]/);
  const { byId } = await gatewayRun({ FAKE_SEARCH_ORDERS: '[]', FTH_TEST_NOW: new Date(Date.parse(TEST_NOW) + 180000).toISOString() }, [call(2, 'place_order', ORDER)], { dir });
  assert.ok(!/order-pending/.test(byId[2].result.content[0].text), byId[2].result.content[0].text);
  assert.deepStrictEqual(tags(), []);
});

test('MCP gateway: a customTag carried by an order of unknown outcome can\'t be reused by an entry', async () => {
  const dir = tmpDir();
  const argsFile = path.join(dir, 'args.jsonl');
  await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_DROP: 'place_order', FTH_LANE_TIMEOUT_MS: '300' }, [
    call(1, 'place_order', { ...EXIT_BASE, side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long at 21480', customTag: 'orb-1' }),
  ], { dir });
  const transcript = path.join(dir, 'cycle-transcript.jsonl');
  const { byId } = await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_ARGS: argsFile, FTH_CYCLE_TRANSCRIPT: transcript }, [
    call(2, 'place_order', { ...ORDER, customTag: 'orb-1' }),
    // An exit reusing it still goes, under a fresh tag, so the first order's record survives.
    call(3, 'place_order', { ...EXIT_BASE, side: 'sell', type: 'limit', limitPrice: 21600, rationale: '[exit] target', customTag: 'orb-1' }),
  ], { dir });
  assert.match(byId[2].result.content[0].text, /\[order-pending\]/);
  // The tracker's refusal is logged with the order's contract, side, size, type and rationale, and the runner cycle's
  // id (the cycle log reads them: cycle-log.js gateOrders).
  const refusal = fs.readFileSync(path.join(dir, 'gate.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(e => e.decision === 'blocked' && (e.violations || []).some(v => v.check === 'order-pending'));
  assert.deepStrictEqual([refusal.source, refusal.contractId, refusal.side, refusal.size, refusal.type, refusal.rationale, refusal.cycle], ['gateway', ORDER.contractId, ORDER.side, ORDER.size, ORDER.type, ORDER.rationale, require('../../scripts/lib/trading/check-order').cycleId({ FTH_CYCLE_TRANSCRIPT: transcript })]);
  assert.ok(ORDER.side !== undefined && ORDER.size !== undefined && ORDER.type !== undefined);
  assert.strictEqual(byId[3].result.content[0].text, 'forwarded:tools/call:place_order');
  const placed = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(c => c.name === 'place_order');
  assert.strictEqual(placed.length, 1, 'only the exit reached the broker');
  assert.match(placed[0].args.customTag, /^fth-/);
  // The same tag on another account is that account's own.
  const other = await gatewayRun({ FAKE_ARGS: argsFile }, [call(4, 'place_order', { ...EXIT_BASE, accountId: 99, side: 'sell', rationale: '[exit] flatten', customTag: 'orb-1' })], { dir });
  assert.ok(!/customTag/.test(other.byId[4].result.content[0].text), other.byId[4].result.content[0].text);
});

test('MCP gateway: with an exit of unknown outcome, the stop can\'t be cancelled but can be placed', async () => {
  const stop = JSON.stringify([{ id: 9, contractId: 'MNQ', side: 1, type: 4, size: 1, stopPrice: 21480 }]);
  const dir = tmpDir();
  await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_DROP: 'place_order', FTH_LANE_TIMEOUT_MS: '300' }, [
    call(1, 'place_order', { ...EXIT_BASE, side: 'sell', type: 'limit', limitPrice: 21600, rationale: '[exit] target' }),
  ], { dir });
  const withStop = await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_ORDERS: stop }, [call(2, 'cancel_order', { accountId: 1, orderId: 9 })], { dir });
  assert.match(withStop.byId[2].result.content[0].text, /\[cancel-protection\]/);
  // No stop yet: a [protect] stop goes (the unknown target counts as resting, not as filled).
  const noStop = await gatewayRun({ FAKE_POSITIONS: LONG1 }, [call(3, 'place_order', { ...EXIT_BASE, side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long at 21480' })], { dir });
  assert.strictEqual(noStop.byId[3].result.content[0].text, 'forwarded:tools/call:place_order');
});

const writeUnknown = (dir, extra) => require('../../scripts/lib/trading/order-markers').writeMarker({ FTH_HOME: path.join(dir, '.futures-trading-harness') }, {
  tag: 'u-1', accountId: 1, contractId: 'MNQ', side: 'buy', size: 1, type: 'market', risk: false, observedNet: 0, observedRootNet: 0,
  args: { contractId: 'MNQ', side: 'buy', rationale: 'setup:orb long, stop 21480' }, sentAt: new Date(Date.parse(TEST_NOW) - 5000).toISOString(), ...extra,
});

test('MCP gateway: an entry of unknown outcome keeps its bracket stop from being cancelled', async () => {
  const dir = tmpDir();
  writeUnknown(dir);
  // The account doesn't show the fill yet, but the bracket stop rests: it is the entry's protection.
  const stop = JSON.stringify([{ id: 9, contractId: 'MNQ', side: 1, type: 4, size: 1, stopPrice: 21480 }]);
  const { byId } = await gatewayRun({ FAKE_ORDERS: stop, FAKE_SEARCH_ORDERS: '[]' }, [call(1, 'cancel_order', { accountId: 1, orderId: 9 })], { dir });
  assert.match(byId[1].result.content[0].text, /\[cancel-protection\]/);
});

test('MCP gateway: a limit entry of unknown outcome keeps its bracket stop too; a resting target never lets the only stop go', async () => {
  const dir = tmpDir();
  writeUnknown(dir, { type: 'limit' });
  const stop = JSON.stringify([{ id: 9, contractId: 'MNQ', side: 1, type: 4, size: 1, stopPrice: 21480 }]);
  const { byId } = await gatewayRun({ FAKE_ORDERS: stop, FAKE_SEARCH_ORDERS: '[]' }, [call(1, 'cancel_order', { accountId: 1, orderId: 9 })], { dir });
  assert.match(byId[1].result.content[0].text, /\[cancel-protection\]/);
  const withTarget = JSON.stringify([{ id: 9, contractId: 'MNQ', side: 1, type: 4, size: 1, stopPrice: 21480 }, { id: 55, contractId: 'MNQ', side: 1, type: 1, size: 1, limitPrice: 21600 }]);
  const target = await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_ORDERS: withTarget }, [call(2, 'cancel_order', { accountId: 1, orderId: 9 })]);
  assert.match(target.byId[2].result.content[0].text, /\[cancel-protection\]/);
});

test('MCP gateway: an unknown entry listed as pending still counts until the account shows it', async () => {
  const dir = tmpDir();
  writeUnknown(dir);
  const { byId } = await gatewayRun({ FAKE_SEARCH_ORDERS: JSON.stringify([{ id: 41, customTag: 'u-1', status: 6 }]) }, [call(2, 'place_order', ORDER)], { dir });
  assert.match(byId[2].result.content[0].text, /\[position-open\] A MNQ position is about to open/);
});

test('MCP gateway: an unknown exit holds other exits back only within the grace period, and says so', async () => {
  const dir = tmpDir();
  writeUnknown(dir, { side: 'sell', risk: true, observedNet: 1, observedRootNet: 1, args: { contractId: 'MNQ', side: 'sell', rationale: '[exit] flatten' } });
  const exit = call(1, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten again' });
  // The lookup fails throughout (FAKE_SEARCH_ORDERS not JSON).
  const soon = await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_SEARCH_ORDERS: 'not json' }, [exit], { dir });
  assert.match(soon.byId[1].result.content[0].text, /\[exposure\] .*once recent orders fill.*customTag u-1.*close_position flattens now/);
  const later = await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_SEARCH_ORDERS: 'not json', FTH_TEST_NOW: new Date(Date.parse(TEST_NOW) + 4 * 3600000).toISOString(), FTH_ENTRY_HOURS: '' }, [exit], { dir });
  assert.strictEqual(later.byId[1].result.content[0].text, 'forwarded:tools/call:place_order', 'after the grace period the account is the truth for exits');
});

test('MCP gateway: a refusal settles an order; a transport failure leaves its outcome unknown', async () => {
  const dir = tmpDir();
  const pending = path.join(dir, '.futures-trading-harness', 'pending-orders');
  const exit = call(1, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' });
  await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_PLACE_ERROR: '{"orderId":null,"success":false,"errorCode":2,"errorName":"OrderRejected"}' }, [exit], { dir });
  await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_PLACE_ERROR: 'Blocked by risk guardrail: trading disabled' }, [exit], { dir });
  assert.ok(!fs.existsSync(pending) || fs.readdirSync(pending).length === 0, 'refused: nothing left unknown');
  await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_PLACE_ERROR: 'HTTP 500 Internal Server Error' }, [exit], { dir });
  assert.strictEqual(fs.readdirSync(pending).length, 1, 'the server\'s own call to the broker failed: the order may exist');
});

test('MCP gateway: an unknown entry the broker lists as filled is recorded for the runner and counted until the account shows it', async () => {
  const markers = require('../../scripts/lib/trading/order-markers');
  const dir = tmpDir();
  const env = { FTH_HOME: path.join(dir, '.futures-trading-harness') };
  markers.writeMarker(env, {
    tag: 'orb-9', accountId: 1, contractId: 'MNQ', side: 'buy', size: 1, type: 'market', risk: false, observedNet: 0, observedRootNet: 0,
    args: { contractId: 'MNQ', side: 'buy', rationale: 'setup:orb long, stop 21480' }, sentAt: new Date(Date.parse(TEST_NOW) - 5000).toISOString(),
  });
  // The broker lists it filled, but the account doesn't show the position yet: the next entry still waits.
  const { byId } = await gatewayRun({ FAKE_SEARCH_ORDERS: JSON.stringify([{ id: 41, customTag: 'orb-9', status: 2 }]) }, [call(2, 'place_order', ORDER)], { dir });
  assert.match(byId[2].result.content[0].text, /\[position-open\] A MNQ position is about to open/);
  assert.ok(!/order-pending/.test(byId[2].result.content[0].text));
  const recorded = JSON.parse(fs.readFileSync(path.join(env.FTH_HOME, 'entry-orders.json'), 'utf8'));
  assert.deepStrictEqual(recorded.map(e => [e.orderId, e.setup, e.stopPrice]), [[41, 'orb', 21480]]);
});

test('MCP gateway: an unknown order the broker lists as rejected is settled as not placed', async () => {
  const dir = tmpDir();
  await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_DROP: 'place_order', FTH_LANE_TIMEOUT_MS: '300' }, [call(1, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten', customTag: 'x-1' })], { dir });
  const { byId } = await gatewayRun({ FAKE_SEARCH_ORDERS: JSON.stringify([{ id: 5, customTag: 'x-1', status: 5 }]) }, [call(2, 'place_order', ORDER)], { dir });
  assert.ok(!/order-pending/.test(byId[2].result.content[0].text), byId[2].result.content[0].text);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.futures-trading-harness', 'pending-orders')), []);
});

test('MCP gateway: a position whose size can\'t be read blocks entries (never read as flat); close_position still goes', async () => {
  const odd = JSON.stringify([{ contractId: 'MNQ', type: 1, quantity: 1 }]);
  const { byId } = await gatewayRun({ FAKE_POSITIONS: odd }, [
    call(1, 'place_order', ORDER),
    call(2, 'close_position', { accountId: 1, contractId: 'MNQ' }),
  ]);
  assert.match(byId[1].result.content[0].text, /order gate could not run \(position MNQ has no valid size.*The order was not sent/);
  assert.strictEqual(byId[2].result.content[0].text, 'forwarded:tools/call:close_position');
});

test('MCP gateway: partial_close_position is checked against the position; close_position always goes', async () => {
  const { byId } = await gatewayRun({ FAKE_POSITIONS: LONG1 }, [
    call(1, 'partial_close_position', { accountId: 1, contractId: 'MNQ', size: 50 }),
    call(2, 'partial_close_position', { accountId: 1, contractId: 'MES', size: 1 }),
    call(3, 'partial_close_position', { accountId: 1, contractId: 'MNQ', size: 1 }),
    call(4, 'close_position', { accountId: 1, contractId: 'MES' }),
  ]);
  assert.match(byId[1].result.content[0].text, /\[partial-close\] partial_close_position size 50 is over the open MNQ position \(1\)/);
  assert.match(byId[2].result.content[0].text, /\[partial-close\] No open MES position/);
  assert.strictEqual(byId[3].result.content[0].text, 'forwarded:tools/call:partial_close_position');
  assert.strictEqual(byId[4].result.content[0].text, 'forwarded:tools/call:close_position');
});

test('MCP gateway: a stop can\'t be moved toward the market right after a close the account doesn\'t show yet', async () => {
  const { spawn } = require('child_process');
  const dir = tmpDir();
  const env = {
    PATH: process.env.PATH, HOME: dir, START_NET: '1', FILL_DELAY_MS: '600', STOP_ORDER: '1',
    FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_API_URL: 'https://api.fake-broker.test', FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '1,7', FAKE_BROKER_JOURNAL: writeJournal(dir, []), FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
  };
  const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js'), '--', process.execPath, path.join(REPO, 'tests', 'fixtures', 'stateful-mcp-server.js')], { env });
  let out = '';
  gw.stdout.on('data', c => { out += c; });
  gw.stdin.write(`${JSON.stringify(call(1, 'close_position', { accountId: 1, contractId: 'MNQ' }))}\n`);
  gw.stdin.write(`${JSON.stringify(call(2, 'modify_order', { accountId: 1, orderId: 9, stopPrice: 21600, reason: '[protect] tighten' }))}\n`);
  gw.stdin.end();
  await new Promise(resolve => gw.on('close', resolve));
  const byId = Object.fromEntries(out.trim().split('\n').map(l => JSON.parse(l)).map(r => [r.id, r]));
  assert.strictEqual(byId[1].result.isError, undefined);
  assert.match(byId[2].result.content[0].text, /\[modify-entry\] .*once recent orders fill/);
});

test('MCP gateway: a protective stop can be tightened but not widened', async () => {
  const stop = JSON.stringify([{ id: 9, contractId: 'MNQ', side: 1, type: 4, size: 1, stopPrice: 21480 }]);
  const { byId } = await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_ORDERS: stop }, [
    call(1, 'modify_order', { accountId: 1, orderId: 9, stopPrice: 21400 }),
    call(2, 'modify_order', { accountId: 1, orderId: 9, stopPrice: 21490 }),
  ]);
  assert.match(byId[1].result.content[0].text, /\[modify-protection\]/);
  assert.strictEqual(byId[2].result.content[0].text, 'forwarded:tools/call:modify_order');
});

test('MCP gateway: an [exit] right after close_position cannot flip the position', async () => {
  const { spawn } = require('child_process');
  const dir = tmpDir();
  const env = {
    PATH: process.env.PATH, HOME: dir, START_NET: '1', FILL_DELAY_MS: '400',
    FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_API_URL: 'https://api.fake-broker.test', FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '1,7', FAKE_BROKER_JOURNAL: writeJournal(dir, []), FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
  };
  const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js'), '--', process.execPath, path.join(REPO, 'tests', 'fixtures', 'stateful-mcp-server.js')], { env });
  let out = '';
  gw.stdout.on('data', c => { out += c; });
  gw.stdin.write(`${JSON.stringify(call(1, 'close_position', { accountId: 1, contractId: 'MNQ' }))}\n`);
  gw.stdin.write(`${JSON.stringify(call(2, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' }))}\n`);
  gw.stdin.end();
  await new Promise(resolve => gw.on('close', resolve));
  const byId = Object.fromEntries(out.trim().split('\n').map(l => JSON.parse(l)).map(r => [r.id, r]));
  assert.strictEqual(byId[1].result.isError, undefined);
  assert.match(byId[2].result.content[0].text, /\[exposure\] .*once recent orders fill/);
});

test('MCP gateway: no request may reuse the id of an order call whose reply is overdue', async () => {
  const { all } = await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_DELAY_MS: '1500', FTH_LANE_TIMEOUT_MS: '300' }, [
    call(1, 'place_order', { ...EXIT_BASE, side: 'sell', type: 'limit', limitPrice: 21600, rationale: '[exit] target' }),
    call(1, 'list_open_positions', { accountId: 1 }),
  ]);
  const texts = all.map(r => (r.error ? r.error.message : r.result.content[0].text));
  assert.ok(texts.some(t => /already in use/.test(t)), texts.join(' | '));
});

test('order gate: at the profit target a prop entry is refused only once today\'s close would pass', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const account = accountNamed(REPO, 'topstep_50k', {}); // $3,000 target, 50% consistency
  const order = entryOrder({ rationale: 'setup:propped long, stop 21480, target 21540', size: 2 });
  const run = days => {
    const { env } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: order.contractId, text: 'plan' }], { FTH_HOME: tmpDir(), FTH_ACCOUNTS_DIRS: HOOK_ACCOUNTS });
    prop.startAttempt(env.FTH_HOME, account, new Date('2026-10-02T14:00:00Z'));
    for (const [day, close] of days) prop.recordEndOfDay(env.FTH_HOME, account, close, day);
    prop.snapshot(env.FTH_HOME, account, 53100, new Date(Date.parse(TEST_NOW) - 60000));
    prop.appendVerdict(env.FTH_HOME, {
      strategy: 'propped', component: 'crossing', contractId: order.contractId, contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 18,
      bar: HOOK_BAR, at: new Date(Date.parse(TEST_NOW) - 60000).toISOString(), expiresAt: new Date(Date.parse(TEST_NOW) + 120000).toISOString(),
    });
    return gate(orderPayload(order), env);
  };
  // $2,500 yesterday is over 50% of the $3,100 profit: the attempt keeps trading.
  const lopsided = run([['2026-10-06', 52500]]);
  assert.strictEqual(lopsided.code, 0, lopsided.stderr);
  // $1,000, $1,000, +$1,100 today: today's close passes, so no new entries.
  const spread = run([['2026-10-05', 51000], ['2026-10-06', 52000]]);
  assert.strictEqual(spread.code, 2);
  assert.match(spread.stderr, /\[combine\] topstep_50k: at the profit target: no new entries/);
});

test('order gate: a live attempt past its sessions still trades (sessions bound training, not the firm)', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const account = accountNamed(REPO, 'topstep_50k', {}); // sessions: 30
  const order = entryOrder({ rationale: 'setup:propped long, stop 21480, target 21540', size: 2 });
  const { env } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: order.contractId, text: 'plan' }], { FTH_HOME: tmpDir(), FTH_ACCOUNTS_DIRS: HOOK_ACCOUNTS });
  prop.startAttempt(env.FTH_HOME, account, new Date('2026-08-01T14:00:00Z'));
  for (let d = 0; d < 32; d += 1) {
    const day = new Date(Date.UTC(2026, 7, 3) + d * 86400000).toISOString().slice(0, 10);
    prop.recordEndOfDay(env.FTH_HOME, account, 50000 + 10 * (d + 1), day);
  }
  prop.snapshot(env.FTH_HOME, account, 50320, new Date(Date.parse(TEST_NOW) - 60000));
  prop.appendVerdict(env.FTH_HOME, {
    strategy: 'propped', component: 'crossing', contractId: order.contractId, contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 18,
    bar: HOOK_BAR, at: new Date(Date.parse(TEST_NOW) - 60000).toISOString(), expiresAt: new Date(Date.parse(TEST_NOW) + 120000).toISOString(),
  });
  const r = gate(orderPayload(order), env);
  assert.strictEqual(r.code, 0, r.stderr);
  // Two closes missed in a row: recording only the first still refuses entries.
  prop.snapshot(env.FTH_HOME, account, 50320, new Date('2026-10-05T19:00:00Z'));
  prop.snapshot(env.FTH_HOME, account, 50320, new Date('2026-10-06T19:00:00Z'));
  prop.snapshot(env.FTH_HOME, account, 50320, new Date(Date.parse(TEST_NOW) - 60000));
  prop.recordEndOfDay(env.FTH_HOME, account, 50320, '2026-10-05');
  const missed = gate(orderPayload(order), env);
  assert.strictEqual(missed.code, 2);
  assert.match(missed.stderr, /close of 2026-10-06 was never recorded/);
});

test('order gate: a strategy that trades an account is gated on the attempt and its size budget, even with the checks skipped', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const order = entryOrder({ rationale: 'setup:propped long, stop 21480, target 21540', size: 2 });
  const { dir, env } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: order.contractId, text: 'plan' }], {
    FTH_HOME: tmpDir(), FTH_ACCOUNTS_DIRS: HOOK_ACCOUNTS, FTH_ORDER_GATE_SKIP: 'combine,policy',
  });
  let r = gate(orderPayload(order), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[combine\] topstep_50k: no topstep_50k attempt is started/);
  const account = accountNamed(REPO, 'topstep_50k', {});
  prop.startAttempt(env.FTH_HOME, account);
  prop.snapshot(env.FTH_HOME, account, 50000, new Date(Date.parse(TEST_NOW) - 60000));
  r = gate(orderPayload(order), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[policy\] setup:propped: no verdict for MNQ/);
  prop.appendVerdict(env.FTH_HOME, {
    strategy: 'propped', component: 'crossing', contractId: order.contractId, contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 18,
    bar: HOOK_BAR, at: new Date(Date.parse(TEST_NOW) - 60000).toISOString(), expiresAt: new Date(Date.parse(TEST_NOW) + 120000).toISOString(),
  });
  r = gate(orderPayload(order), env);
  assert.strictEqual(r.code, 0, r.stderr);
  // The verdict permits one entry: once the journal shows it placed, a re-entry waits for the next setup.
  const used = setup([
    { ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: order.contractId, text: 'plan' },
    { ts: minutesAgo(0.5, new Date(TEST_NOW)), kind: 'order_placed', contractId: order.contractId, text: 'setup:propped long', data: { result: { success: true } } },
    { ts: minutesAgo(0.2, new Date(TEST_NOW)), kind: 'review', contractId: order.contractId, text: 'stopped', tags: ['result:loss', 'setup:propped'] },
  ], { FTH_HOME: env.FTH_HOME, FTH_ACCOUNTS_DIRS: env.FTH_ACCOUNTS_DIRS });
  r = gate(orderPayload(order), used.env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /already used for an entry/);
  // While the attempt runs, a strategy that doesn't trade it can't enter.
  r = gate(orderPayload(entryOrder({ rationale: 'setup:anytime long, stop 21480, target 21540' })), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /topstep_50k attempt is running/);
  // 0.2 x $2,000 cushion = $400; 40 ticks plus a tick of expected slippage = 41 x $0.50 + $0.74 = $21.24 a contract: at most 18.
  r = gate(orderPayload({ ...order, size: 19 }), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /19 MNQ is not within the account's size budget for a 40-tick stop \(18 MNQ at \$21\.24/);
  assert.ok(fs.existsSync(dir));
});

test('order gate wiring: a policy entry whose verdict names a paper component is refused, even with the checks skipped; exits still go', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const order = entryOrder({ rationale: 'setup:propped long, stop 21480, target 21540', size: 2 });
  const account = accountNamed(REPO, 'topstep_50k', {});
  const run = (component, input = order) => {
    const { env } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: order.contractId, text: 'plan' }], {
      FTH_HOME: tmpDir(), FTH_ACCOUNTS_DIRS: HOOK_ACCOUNTS, FTH_ORDER_GATE_SKIP: 'combine,policy,strategy',
    });
    prop.startAttempt(env.FTH_HOME, account);
    prop.snapshot(env.FTH_HOME, account, 50000, new Date(Date.parse(TEST_NOW) - 60000));
    prop.appendVerdict(env.FTH_HOME, {
      strategy: 'propped', component, contractId: order.contractId, contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 18,
      bar: HOOK_BAR, at: new Date(Date.parse(TEST_NOW) - 60000).toISOString(), expiresAt: new Date(Date.parse(TEST_NOW) + 120000).toISOString(),
    });
    return gate(orderPayload(input), env);
  };
  const ok = run('crossing');
  assert.strictEqual(ok.code, 0, ok.stderr);
  const paper = run('drifting');
  assert.strictEqual(paper.code, 2);
  assert.match(paper.stderr, /\[policy\] setup:propped: the latest verdict's setup is from drifting: drifting has status "paper": propped trades only its active strategies live/);
  const unknown = run('nowhere');
  assert.strictEqual(unknown.code, 2);
  assert.match(unknown.stderr, /\[policy\] setup:propped: the latest verdict's setup is from nowhere: nowhere is not one of propped's strategies/);
  const exit = run('drifting', { ...EXIT_BASE, side: 'sell', size: 2, rationale: '[exit] close the policy long' });
  assert.strictEqual(exit.code, 0, exit.stderr);
  const stop = run('drifting', { ...EXIT_BASE, side: 'sell', size: 2, type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the policy long' });
  assert.strictEqual(stop.code, 0, stop.stderr);
});

test('order gate wiring: a prop size counts the stop\'s expected slippage against the room to the daily limit', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  // topstep_50k with the harness's soft daily limit off, so the firm's limit sets the room.
  const acctRoot = tmpDir();
  fs.mkdirSync(path.join(acctRoot, 'accounts', 'topstep_50k'), { recursive: true });
  // The soft limit lives in the account's rulebook (RULEBOOK.md beside it): this copy's rulebook sets it to 0.
  const dst = path.join(acctRoot, 'accounts', fs.readdirSync(path.join(acctRoot, 'accounts'))[0]);
  const src = path.join(HOOK_ACCOUNTS, path.basename(dst));
  fs.copyFileSync(path.join(src, 'ACCOUNT.md'), path.join(dst, 'ACCOUNT.md'));
  const book = fs.readFileSync(path.join(src, 'RULEBOOK.md'), 'utf8').replace(/^daily_loss_soft: \d+\b/m, 'daily_loss_soft: off');
  assert.match(book, /^daily_loss_soft: off\b/m);
  fs.writeFileSync(path.join(dst, 'RULEBOOK.md'), book);
  const account = accountNamed(acctRoot, 'topstep_50k', {});
  // Down $917 today of the $1,000 daily limit: $83 of room. 4 micros at a 40-tick stop ($20.74 each without slippage,
  // $82.96) would fit, but stopped a tick past the stop they lose 4 x $21.24 = $84.96: past the limit. 3 ($63.72) fit.
  const run = size => {
    const home = tmpDir();
    prop.startAttempt(home, account);
    prop.snapshot(home, account, 49083, new Date(Date.parse(TEST_NOW) - 60000));
    prop.appendVerdict(home, {
      strategy: 'propped', component: 'crossing', contractId: 'MNQ', contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: size,
      bar: HOOK_BAR, at: new Date(Date.parse(TEST_NOW) - 60000).toISOString(), expiresAt: new Date(Date.parse(TEST_NOW) + 120000).toISOString(),
    });
    const order = entryOrder({ contractId: 'MNQ', rationale: 'setup:propped long, stop 21480, target 21540', size });
    const { env } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: 'MNQ', text: 'plan' }], { FTH_HOME: home, FTH_ACCOUNTS_DIRS: path.join(acctRoot, 'accounts'), FTH_ORDER_GATE_SKIP: 'combine,policy' });
    return gate(orderPayload(order), env);
  };
  let r = run(4);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[combine\] topstep_50k: 4 MNQ is not within the account's size budget for a 40-tick stop \(3 MNQ at \$21\.24/);
  r = run(3);
  assert.strictEqual(r.code, 0, r.stderr);
});

test('order gate hook: a verdict is full or skip, and a full one needs a multiplier above 0 and at most 1 (R4); refused even with the checks skipped', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const order = entryOrder({ rationale: 'setup:propped long, stop 21480, target 21540', size: 2 });
  const { env } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: order.contractId, text: 'plan' }], {
    FTH_HOME: tmpDir(), FTH_ACCOUNTS_DIRS: HOOK_ACCOUNTS, FTH_ORDER_GATE_SKIP: 'combine,policy',
  });
  const account = accountNamed(REPO, 'topstep_50k', {});
  prop.startAttempt(env.FTH_HOME, account);
  prop.snapshot(env.FTH_HOME, account, 50000, new Date(Date.parse(TEST_NOW) - 60000));
  const verdict = (action, extra = {}) => prop.appendVerdict(env.FTH_HOME, {
    strategy: 'propped', component: 'crossing', contractId: order.contractId, contract: 'MNQ', direction: 'long', action, stopTicks: 40, maxSize: 18,
    bar: HOOK_BAR, at: new Date(Date.parse(TEST_NOW) - 60000).toISOString(), expiresAt: new Date(Date.parse(TEST_NOW) + 120000).toISOString(), ...extra,
  });
  const refused = (o, re) => {
    const r = gate(orderPayload(o), env);
    assert.strictEqual(r.code, 2, r.stderr);
    assert.match(r.stderr, re);
  };
  verdict('close', { multiplier: 1 });
  refused(order, /\[policy\] setup:propped: the verdict's action "close" allows no entry \(a verdict is full or skip\)/);
  // The retired half: refused whatever multiplier it carries.
  verdict('half', { multiplier: 0.5 });
  refused(order, /the verdict's action "half" allows no entry \(a verdict is full or skip\)/);
  // A missing or stale fact made an enforced item 0: the setup was skipped.
  verdict('full', { multiplier: 0 });
  refused(order, /\[policy\] setup:propped: the rulebook's enforced items skipped the setup \(multiplier 0\)/);
  // No multiplier, one that would raise the size, or not a number: no size can be judged (fails closed).
  for (const m of [undefined, 1.5, 'x', -1, null]) {
    verdict('full', { multiplier: m });
    refused(order, /the verdict's size multiplier \(.*\) is not above 0 and at most 1/);
  }
  // A full verdict at 0.5: the budget is checked at that share ($400 budget, 18 MNQ at full: 9 at 0.5), hard.
  verdict('full', { multiplier: 0.5, maxSize: 18 });
  refused({ ...order, size: 10 }, /\[combine\] [a-z0-9_]+: 10 MNQ is not within the account's 0\.5x size budget/);
  let r = gate(orderPayload({ ...order, size: 9 }), env);
  assert.strictEqual(r.code, 0, r.stderr);
  verdict('full', { multiplier: 1 });
  r = gate(orderPayload(order), env);
  assert.strictEqual(r.code, 0, r.stderr);
});

test('order gate wiring: a policy strategy trades the selected leg (FTH_SYMBOLS), sized in it whatever its contracts mode; the other leg is refused', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const account = accountNamed(REPO, 'topstep_50k', {});
  // propped: contracts micro, listing MNQ and NQ. $400 budget at a 40-tick stop (plus a tick of slippage): 18 MNQ ($21.24 each), or 1 NQ ($205 + $2.80 fees).
  const run = (symbols, contract, size) => {
    const home = tmpDir();
    prop.startAttempt(home, account);
    prop.snapshot(home, account, 50000, new Date(Date.parse(TEST_NOW) - 60000));
    prop.appendVerdict(home, {
      strategy: 'propped', component: 'crossing', contractId: contract, contract, direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: size,
      bar: HOOK_BAR, at: new Date(Date.parse(TEST_NOW) - 60000).toISOString(), expiresAt: new Date(Date.parse(TEST_NOW) + 120000).toISOString(),
    });
    const order = entryOrder({ contractId: contract, rationale: 'setup:propped long, stop 21480, target 21540', size });
    const { env } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: contract, text: 'plan' }], { FTH_HOME: home, FTH_ACCOUNTS_DIRS: HOOK_ACCOUNTS, FTH_SYMBOLS: symbols });
    return gate(orderPayload(order), env);
  };
  let r = run('MNQ', 'MNQ', 18);
  assert.strictEqual(r.code, 0, r.stderr);
  r = run('NQ', 'NQ', 1);
  assert.strictEqual(r.code, 0, `NQ selected: sized in NQ though propped says contracts: micro. ${r.stderr}`);
  r = run('MNQ', 'NQ', 1);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[strategy\] setup:propped trades MNQ \(the selected contract\), not NQ\./);
  assert.match(r.stderr, /\[combine\] topstep_50k: 1 NQ is not within .*\(18 MNQ/);
  r = run('NQ', 'MNQ', 18);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[strategy\] setup:propped trades NQ \(the selected contract\), not MNQ\./);
});

test('order gate wiring: a balance that doesn\'t reconcile with the broker\'s fills refuses prop entries, even with the checks skipped; exits pass', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const account = accountNamed(REPO, 'topstep_50k', {});
  const home = tmpDir();
  prop.startAttempt(home, account);
  const now = Date.parse(TEST_NOW);
  prop.snapshot(home, account, 50000, new Date(now - 120000), { fills: [] });
  // The broker's balance says $50,000, but a -$40.50 loss (fees $0.74) was filled since the anchor.
  const fills = [{ creationTimestamp: new Date(now - 90000).toISOString(), profitAndLoss: -40.5, fees: 0.74 }];
  prop.snapshot(home, account, 50000, new Date(now - 60000), { fills });
  prop.appendVerdict(home, {
    strategy: 'propped', component: 'crossing', contractId: 'MNQ', contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 18,
    bar: HOOK_BAR, at: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 120000).toISOString(),
  });
  const order = entryOrder({ contractId: 'MNQ', rationale: 'setup:propped long, stop 21480, target 21540', size: 2 });
  const { env } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: 'MNQ', text: 'plan' }], { FTH_HOME: home, FTH_ACCOUNTS_DIRS: HOOK_ACCOUNTS, FTH_SYMBOLS: 'MNQ', FTH_ORDER_GATE_SKIP: 'combine,policy' });
  let r = gate(orderPayload(order), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[combine\] topstep_50k: the account balance doesn't reconcile: the broker reports \$50000, .* gives \$49958\.76/);
  // Exits and protective orders are never held back by it.
  r = gate(orderPayload({ ...order, side: 1, rationale: '[exit] close the long' }), env);
  assert.strictEqual(r.code, 0, r.stderr);
  // Once the broker books it, entries go.
  prop.snapshot(home, account, 49958.76, new Date(now - 30000), { fills });
  r = gate(orderPayload(order), env);
  assert.strictEqual(r.code, 0, r.stderr);
});

test('order gate wiring: a policy or account refused for a bad or missing rulebook refuses entries naming it, even with the strategy check skipped, while exits, flattens and protective stops still go', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const name = fs.readFileSync(path.join(ROOT, 'strategies', 'propped', 'STRATEGY.md'), 'utf8').match(/^account: (\S+)/m)[1];
  const good = JSON.parse(JSON.stringify(require('../../scripts/lib/trading/accounts').loadAccounts(path.dirname(HOOK_ACCOUNTS), {}).accounts.find(a => a.name === name)));
  const now = Date.parse(TEST_NOW);
  const order = entryOrder({ contractId: 'MNQ', rationale: 'setup:propped long, stop 21480, target 21540', size: 2 });
  for (const [label, breakIt] of [
    ['missing', f => fs.rmSync(f)],
    ['no soft stop', f => fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^daily_loss_soft: .*\n/m, ''))],
    ['a cap left out', f => fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^ {6}cap_usd: .*\n/m, ''))],
    ['truncated', f => fs.writeFileSync(f, fs.readFileSync(f, 'utf8').slice(0, 200))],
    // The account stays valid; only the policy is refused (its rulebook doesn't list it): never sized by the defaults.
    ['the policy not listed', f => fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^ {2}propped:$/m, '  propped_renamed:'))],
  ]) {
    const accounts = path.join(tmpDir(), 'accounts');
    fs.cpSync(HOOK_ACCOUNTS, accounts, { recursive: true });
    const file = path.join(accounts, name, 'RULEBOOK.md');
    breakIt(file);
    // A running attempt with a fresh snapshot and a full verdict: only the rulebook is wrong.
    const home = tmpDir();
    prop.startAttempt(home, good);
    prop.snapshot(home, good, 50000, new Date(now - 60000), { fills: [] });
    prop.appendVerdict(home, {
      strategy: 'propped', component: 'crossing', contractId: 'MNQ', contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 18,
      bar: HOOK_BAR, at: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 120000).toISOString(),
    });
    const { env } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: 'MNQ', text: 'plan' }], { FTH_HOME: home, FTH_ACCOUNTS_DIRS: accounts, FTH_SYMBOLS: 'MNQ', FTH_ORDER_GATE_SKIP: 'combine,policy,strategy' });
    let r;
    for (const size of [2, 18]) {
      r = gate(orderPayload({ ...order, size }), env);
      assert.strictEqual(r.code, 2, `${label} ${size}: ${r.stderr}`);
      assert.ok(r.stderr.includes(file) || r.stderr.includes('RULEBOOK.md'), `${label}: names the rulebook: ${r.stderr}`);
    }
    // Risk-reducing orders are never held by it: an exit, a flatten, a protective stop.
    for (const o of [{ ...order, side: 1, rationale: '[exit] close the long' }, { ...order, side: 1, rationale: '[exit] flatten' },
      { ...order, side: 1, type: 'stop', stopPrice: 21480, stopLossBracket: undefined, rationale: '[protect] stop for the open long' }]) {
      r = gate(orderPayload(o), env);
      assert.strictEqual(r.code, 0, `${label} ${o.rationale}: ${r.stderr}`);
    }
  }
});

test('order gate hook: a prop verdict is for its own bar - an older bar\'s verdict is refused, even with the checks skipped; exits pass', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const order = entryOrder({ rationale: 'setup:propped long, stop 21480, target 21540', size: 2 });
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: order.contractId, text: 'plan' }], {
    FTH_HOME: tmpDir(), FTH_ACCOUNTS_DIRS: HOOK_ACCOUNTS, FTH_ORDER_GATE_SKIP: 'combine,policy',
  });
  const account = accountNamed(REPO, 'topstep_50k', {});
  prop.startAttempt(env.FTH_HOME, account);
  prop.snapshot(env.FTH_HOME, account, 50000, new Date(Date.parse(TEST_NOW) - 60000));
  const verdict = bar => prop.appendVerdict(env.FTH_HOME, {
    strategy: 'propped', component: 'crossing', contractId: order.contractId, contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 18,
    bar, at: new Date(Date.parse(TEST_NOW) - 60000).toISOString(), expiresAt: new Date(Date.parse(TEST_NOW) + 120000).toISOString(),
  });
  // The bar before the recorded one (14:27): unexpired, same side and stop, still refused.
  verdict('2026-10-07T14:24:00.000Z');
  // FTH_ORDER_GATE_SKIP names policy and combine: neither reaches this check.
  const r = gate(orderPayload(order), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[policy\] setup:propped: the latest verdict is for the 3m bar opened 2026-10-07T14:24:00\.000Z; the setup on the bar opened 2026-10-07T14:27:00\.000Z has no verdict yet/);
  // Risk-reducing orders are never held by it.
  const exit = gate(orderPayload({ ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten the policy long' }), env);
  assert.strictEqual(exit.code, 0, exit.stderr);
  // No bar: refused.
  verdict(undefined);
  const none = gate(orderPayload(order), env);
  assert.strictEqual(none.code, 2);
  assert.match(none.stderr, /\[policy\] setup:propped: the latest verdict \(full, .*\) names no bar/);
  // The verdict for the recorded bar, in another format: allowed.
  verdict('2026-10-07T14:27:00Z');
  const ok = gate(orderPayload(order), env);
  assert.strictEqual(ok.code, 0, ok.stderr);
});

test('order gate hook: an entry on another market since the account snapshot holds a prop entry, even with the checks skipped', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const order = entryOrder({ rationale: 'setup:propped long, stop 21480, target 21540', size: 2 });
  const journal = extra => [{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: order.contractId, text: 'plan' }, ...extra];
  const base = setup(journal([]), { FTH_HOME: tmpDir(), FTH_ACCOUNTS_DIRS: HOOK_ACCOUNTS, FTH_ORDER_GATE_SKIP: 'combine,policy' });
  const account = accountNamed(REPO, 'topstep_50k', {});
  prop.startAttempt(base.env.FTH_HOME, account);
  prop.snapshot(base.env.FTH_HOME, account, 50000, new Date(Date.parse(TEST_NOW) - 90000));
  prop.appendVerdict(base.env.FTH_HOME, {
    strategy: 'propped', component: 'crossing', contractId: order.contractId, contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 18,
    bar: HOOK_BAR, at: new Date(Date.parse(TEST_NOW) - 30000).toISOString(), expiresAt: new Date(Date.parse(TEST_NOW) + 120000).toISOString(),
  });
  assert.strictEqual(gate(orderPayload(order), base.env).code, 0);
  const other = setup(journal([{ ts: minutesAgo(1, new Date(TEST_NOW)), kind: 'order_placed', contractId: 'MES', text: 'setup:propped long', data: { result: { success: true } } }]),
    { FTH_HOME: base.env.FTH_HOME, FTH_ACCOUNTS_DIRS: base.env.FTH_ACCOUNTS_DIRS, FTH_ORDER_GATE_SKIP: 'combine,policy,review-before-next-entry' });
  const r = gate(orderPayload(order), other.env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[combine\] topstep_50k: an entry \(MES\) went in at or after the account snapshot/);
  // An entry whose time can't be read counts as since the snapshot (fails closed), and says why.
  const garbled = setup(journal([{ ts: 'not a time', kind: 'order_placed', contractId: 'MES', text: 'setup:propped long', data: { result: { success: true } } }]),
    { FTH_HOME: base.env.FTH_HOME, FTH_ACCOUNTS_DIRS: base.env.FTH_ACCOUNTS_DIRS, FTH_ORDER_GATE_SKIP: 'combine,policy,review-before-next-entry' });
  const g = gate(orderPayload(order), garbled.env);
  assert.strictEqual(g.code, 2);
  assert.match(g.stderr, /went in at or after the account snapshot.*unreadable time/);
  // A snapshot dated more than a minute in the future (the clock stepped back) is refused.
  prop.snapshot(base.env.FTH_HOME, account, 50000, new Date(Date.parse(TEST_NOW) + 2 * 60000));
  const f = gate(orderPayload(order), base.env);
  assert.strictEqual(f.code, 2);
  assert.match(f.stderr, /dated in the future/);
});

test('MCP gateway: while a prop attempt runs, no entry while any position is open on the account', async () => {
  const { spawn } = require('child_process');
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const dir = tmpDir();
  const home = tmpDir();
  prop.startAttempt(home, accountNamed(REPO, 'topstep_50k', {}));
  const env = {
    PATH: process.env.PATH, HOME: dir, FTH_HOME: home,
    FAKE_POSITIONS: JSON.stringify([{ contractId: 'MES', type: 1, size: 1 }]),
    FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_API_URL: 'https://api.fake-broker.test', FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '1,7', FAKE_BROKER_JOURNAL: writeJournal(dir, []),
    FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
    FTH_GATE_LOG: path.join(dir, 'gate.jsonl'),
  };
  const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js'), '--', process.execPath, path.join(REPO, 'tests', 'fixtures', 'fake-mcp-server.js')], { env });
  let out = '';
  gw.stdout.on('data', c => { out += c; });
  gw.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'place_order', arguments: ORDER } })}\n`);
  gw.stdin.end();
  assert.strictEqual(await new Promise(resolve => gw.on('close', resolve)), 0);
  const r = JSON.parse(out.trim().split('\n')[0]);
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /\[prop-one-position\] A topstep_50k attempt trades one position at a time: MES is open/);
});

test('MCP gateway: while a prop attempt runs, no entry while an order is working on another market', async () => {
  const { spawn } = require('child_process');
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const dir = tmpDir();
  const home = tmpDir();
  prop.startAttempt(home, accountNamed(REPO, 'topstep_50k', {}));
  const env = {
    PATH: process.env.PATH, HOME: dir, FTH_HOME: home,
    FAKE_ORDERS: JSON.stringify([{ id: 9, contractId: 'MES', type: 1, side: 0, size: 1, limitPrice: 5000 }]),
    FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_API_URL: 'https://api.fake-broker.test', FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '1,7', FAKE_BROKER_JOURNAL: writeJournal(dir, []),
    FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
    FTH_GATE_LOG: path.join(dir, 'gate.jsonl'),
  };
  const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js'), '--', process.execPath, path.join(REPO, 'tests', 'fixtures', 'fake-mcp-server.js')], { env });
  let out = '';
  gw.stdout.on('data', c => { out += c; });
  gw.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'place_order', arguments: ORDER } })}\n`);
  gw.stdin.end();
  assert.strictEqual(await new Promise(resolve => gw.on('close', resolve)), 0);
  const r = JSON.parse(out.trim().split('\n')[0]);
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /\[prop-one-position\] A topstep_50k attempt trades one position at a time: an order is working on MES/);
});

// --- The replay clock (trading/harness-now.js): FTH_REPLAY_NOW, honored only with a replay broker. ---
const SATURDAY = '2026-10-10T15:00:00.000Z'; // market closed

/** brokers.json in the env's home selecting "sim" (journal: the test's), a replay broker or not; the env reads it. */
function simBroker(env, { replay = true, extra = {} } = {}) {
  const home = env.FTH_HOME;
  homeBrokers(home, { sim: { command: ['node', 'sim.js'], journal: env.FAKE_BROKER_JOURNAL, ...(replay ? { replay: true } : {}), ...extra } }, { env });
  recordBrokerSpecs(home, { broker: 'sim' }); // the replay broker's tick specs, as its translator records them
  recordBrokerSpecs(home, { broker: 'sim', day: '2026-10-07' }); // and on the replayed day (TEST_NOW's): its own file
}

test('order gate hook: with a replay broker it judges the order at FTH_REPLAY_NOW, not the wall clock', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  simBroker(env);
  // The wall clock (the suite's) on Saturday: closed, the plan and the trend read stale.
  const live = gate(orderPayload(), { ...env, FTH_TEST_NOW: SATURDAY });
  assert.strictEqual(live.code, 2);
  assert.match(live.stderr, /\[market-hours\]/);
  // The replayed Wednesday 10:30 ET: allowed.
  const replayed = gate(orderPayload(), { ...env, FTH_TEST_NOW: SATURDAY, FTH_REPLAY_NOW: TEST_NOW });
  assert.strictEqual(replayed.code, 0, replayed.stderr);
  // A replayed Saturday is closed, whatever the wall clock says.
  const closed = gate(orderPayload(), { ...env, FTH_REPLAY_NOW: SATURDAY });
  assert.strictEqual(closed.code, 2);
  assert.match(closed.stderr, /\[market-hours\]/);
});

test('order gate hook: on a replayed day whose file has tick specs but no front month, an entry is refused saying why; an exit goes', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  simBroker(env);
  const replay = { ...env, FTH_TEST_NOW: SATURDAY, FTH_REPLAY_NOW: TEST_NOW };
  assert.strictEqual(gate(orderPayload(), replay).code, 0, 'the day\'s front month recorded: allowed');
  // Only a lookup by month succeeded that day: specs, no front month.
  const file = path.join(env.FTH_HOME, 'contracts-sim.2026-10-07.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), front: {} }));
  const entry = gate(orderPayload(), replay);
  assert.strictEqual(entry.code, 2);
  assert.match(entry.stderr, /\[contract-specs\] the replayed day's MNQ front month \(2026-10-07\) is not looked up yet[\s\S]*call search_contracts for MNQ first/);
  const exit = gate(orderPayload({ ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' }), replay);
  assert.strictEqual(exit.code, 0, exit.stderr);
});

test('order gate hook: FTH_REPLAY_NOW without a real replay broker, or unparseable, blocks entries (even autonomous with checks skipped); exits, stops and stop moves still go', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  assert.strictEqual(gate(orderPayload(), env).code, 0, 'control: allowed without the override');
  const modify = { tool_name: 'mcp__broker__modify_order', tool_input: { accountId: 1, orderId: 9, stopPrice: 21490, reason: '[protect] tighten' } };
  const exit = orderPayload({ ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' });
  const protect = orderPayload({ ...EXIT_BASE, side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long at 21480' });
  for (const extra of [
    { FTH_REPLAY_NOW: TEST_NOW },
    { FTH_REPLAY_NOW: TEST_NOW, FTH_AUTONOMOUS: '1', FTH_ORDER_GATE_SKIP: 'replay-clock,market-hours', FTH_DISABLED_HOOKS: 'pre:trading:order-gate' },
  ]) {
    const r = gate(orderPayload(), { ...env, ...extra });
    assert.strictEqual(r.code, 2, JSON.stringify(extra));
    assert.match(r.stderr, /\[replay-clock\] FTH_REPLAY_NOW is set but the selected broker "fake" is not a replay broker/);
    assert.match(r.stderr, /close_position still go/);
    for (const payload of [exit, protect, modify]) {
      const ok = gate(payload, { ...env, ...extra });
      assert.strictEqual(ok.code, 0, `${payload.tool_name} ${JSON.stringify(extra)}: ${ok.stderr}`);
    }
  }
  simBroker(env);
  const garbage = gate(orderPayload(), { ...env, FTH_REPLAY_NOW: 'now' });
  assert.strictEqual(garbage.code, 2);
  assert.match(garbage.stderr, /\[replay-clock\] FTH_REPLAY_NOW "now" is not an ISO 8601 UTC time/);
  // A replay broker that reads a shipped live broker's credentials is refused too (the hook can't ask the server).
  const live = shippedBroker();
  const vars = live.env.slice(0, 2);
  simBroker(env, { extra: { env: vars } });
  const twin = gate(orderPayload(), { ...env, FTH_REPLAY_NOW: TEST_NOW });
  assert.strictEqual(twin.code, 2);
  assert.ok(twin.stderr.includes(`"sim" looks live: it reads the live broker "${live.name}"'s variables (${vars.join(', ')})`), twin.stderr);
  const log = fs.readFileSync(env.FTH_GATE_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(log.some(e => e.decision === 'blocked' && e.violations.some(v => v.check === 'replay-clock')), 'logged');
});

test('session-start and stop hooks read the trading day at the replayed time with a replay broker; a refused clock is said', () => {
  const replay = '2026-03-04T15:00:00.000Z'; // Wednesday 10:00 ET
  const { env } = setup([{ ts: '2026-03-04T14:50:00.000Z', kind: 'order_placed', contractId: 'MNQ', text: 'setup:anytime long, stop 21480', data: { result: { success: true } } }]);
  simBroker(env);
  const brief = runHook('session-start:trading:briefing', 'scripts/hooks/trading-session-start.js', 'minimal,standard,strict', {}, { ...env, FTH_REPLAY_NOW: replay });
  assert.match(brief.stdout, /Trading day started 2026-03-03T23:00:00.000Z/);
  assert.match(brief.stdout, /Today: 1 orders placed/);
  const stop = (extra) => runHook('stop:trading:review-reminder', 'scripts/hooks/trading-stop-review.js', 'standard,strict', {}, { ...env, ...extra });
  assert.strictEqual(stop({ FTH_REPLAY_NOW: replay }).code, 2, 'the replayed day\'s entry has no review');
  assert.strictEqual(stop({}).code, 0, 'on the wall clock (TEST_NOW) that entry is months old');
  const refused = stop({ FTH_REPLAY_NOW: 'later' });
  assert.strictEqual(refused.code, 2);
  assert.match(refused.stderr, /\[replay-clock\] FTH_REPLAY_NOW "later" is not an ISO 8601 UTC time.*review reminder could not check/);
});

// --- The gateway with a configured broker (behind the contract translator), as installed. ---
const FAKE_MCP = path.join(REPO, 'tests', 'fixtures', 'fake-mcp-server.js');
const CONTRACTS = JSON.stringify([{ id: 'MNQ', name: 'MNQZ6', tickSize: 0.25, tickValue: 0.5, activeContract: true }]);
const serverSays = (serverTime, replay = true) => JSON.stringify({ tradingEnabled: true, maxOrderSize: 5, serverTime, ...(replay ? { replay: true } : {}) });

/** A harness home under `dir` whose broker "sim" runs the fake server; returns its brokers.json path. */
function simHome(dir, { replay = true, journalEntries = [] } = {}) {
  const home = path.join(dir, '.futures-trading-harness');
  fs.mkdirSync(path.join(dir, 'sim'), { recursive: true });
  const journal = writeJournal(path.join(dir, 'sim'), journalEntries);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'brokers.json');
  fs.writeFileSync(file, JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, FAKE_MCP], journal, allowedAccountsEnv: 'SIM_ALLOWED_ACCOUNTS', ...(replay ? { replay: true } : {}) } } }));
  return { home, file, journal };
}

/** The gateway as registered (no server command: the configured broker). Items: messages, or functions run between them. */
async function gatewayCfg(extraEnv, items, { dir }) {
  const { spawn } = require('child_process');
  const env = {
    PATH: process.env.PATH, HOME: dir, FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '',
    FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test', FAKE_CONTRACTS: CONTRACTS, SIM_ALLOWED_ACCOUNTS: '1,7', ...extraEnv,
  };
  const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js')], { env });
  let out = '';
  gw.stdout.on('data', c => { out += c; });
  const replies = () => out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const item of items) {
    if (typeof item === 'function') { await item(); continue; }
    gw.stdin.write(`${JSON.stringify(item)}\n`);
    // One at a time: wait for this reply before the next item.
    for (let t = 0; t < 400 && !replies().some(r => r.id === item.id); t += 1) await new Promise(r => setTimeout(r, 25));
  }
  gw.stdin.end();
  await new Promise(resolve => gw.on('close', resolve));
  return Object.fromEntries(replies().map(r => [r.id, r]));
}
const textOf = r => (r.error ? r.error.message : r.result.content[0].text);

test('MCP gateway: FTH_REPLAY_NOW without a real replay broker refuses entries; exits, cancels, partial and full closes still go', async () => {
  const msgs = [
    call(1, 'place_order', ORDER),
    call(2, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' }),
    call(3, 'cancel_order', { accountId: 1, orderId: 9 }),
    call(4, 'partial_close_position', { accountId: 1, contractId: 'MNQ', size: 1 }),
    call(5, 'close_position', { accountId: 1, contractId: 'MNQ' }),
  ];
  // The server from the gateway's command line: never a replay broker. Each risk-reducing call in a run of its own
  // (one after another they'd count each other's pending fills).
  const env = { FAKE_POSITIONS: LONG1, FTH_REPLAY_NOW: TEST_NOW, FAKE_SERVER_CONFIG: serverSays(TEST_NOW) };
  for (const m of msgs.slice(1)) {
    const { byId } = await gatewayRun(env, [msgs[0], m]);
    assert.match(textOf(byId[1]), /\[replay-clock\] .*a server given on its command line/);
    assert.strictEqual(textOf(byId[m.id]), `forwarded:tools/call:${m.params.name}`);
  }
  // A configured broker that isn't a replay broker.
  const dir = tmpDir();
  simHome(dir, { replay: false });
  const cfg = await gatewayCfg({ FAKE_POSITIONS: LONG1, FTH_REPLAY_NOW: TEST_NOW, FAKE_SERVER_CONFIG: serverSays(TEST_NOW) }, msgs, { dir });
  assert.match(textOf(cfg[1]), /\[replay-clock\] FTH_REPLAY_NOW is set but the selected broker "sim" is not a replay broker/);
  assert.strictEqual(textOf(cfg[2]), 'forwarded:tools/call:place_order');
  assert.strictEqual(textOf(cfg[5]), 'forwarded:tools/call:close_position');
});

test('MCP gateway: a broker labelled replay is honored only if its server confirms replay at FTH_REPLAY_NOW', async () => {
  const run = async server => {
    const dir = tmpDir();
    simHome(dir);
    return gatewayCfg({ FTH_TEST_NOW: SATURDAY, FTH_REPLAY_NOW: TEST_NOW, ...(server ? { FAKE_SERVER_CONFIG: server } : {}) }, [call(1, 'place_order', ORDER)], { dir });
  };
  // A live server behind a replay label (it doesn't say replay): refused.
  assert.match(textOf((await run(serverSays(TEST_NOW, false)))[1]), /\[replay-clock\] .*does not report itself a replay server/);
  // A replay server at another time: refused.
  assert.match(textOf((await run(serverSays('2026-10-07T14:40:00.000Z')))[1]), /\[replay-clock\] .*not within 5 min of the replay server's time/);
  // No answer it can read: refused.
  assert.match(textOf((await run(null))[1]), /\[replay-clock\] .*get_server_config could not be read/);
  // Confirmed: judged at the replayed Wednesday, not the Saturday wall clock.
  const ok = textOf((await run(serverSays('2026-10-07T14:32:00.000Z')))[1]);
  assert.doesNotMatch(ok, /market-hours|replay-clock/);
});

test('MCP gateway: the replay decision is pinned for its lifetime; editing brokers.json mid-session changes nothing', async () => {
  const dir = tmpDir();
  const { file } = simHome(dir);
  const relabel = replay => () => fs.writeFileSync(file, JSON.stringify({ broker: 'sim', brokers: { sim: { ...JSON.parse(fs.readFileSync(file, 'utf8')).brokers.sim, replay } } }));
  const env = { FTH_TEST_NOW: SATURDAY, FTH_REPLAY_NOW: TEST_NOW, FAKE_SERVER_CONFIG: serverSays(TEST_NOW) };
  const honored = await gatewayCfg(env, [call(1, 'place_order', ORDER), relabel(false), call(2, 'place_order', ORDER)], { dir });
  assert.doesNotMatch(textOf(honored[1]), /replay-clock|market-hours/);
  assert.doesNotMatch(textOf(honored[2]), /replay-clock|market-hours/, 'still the pinned replay clock');
  const refused = await gatewayCfg(env, [call(1, 'place_order', ORDER), relabel(true), call(2, 'place_order', ORDER)], { dir });
  assert.match(textOf(refused[1]), /\[replay-clock\] .*not a replay broker/);
  assert.match(textOf(refused[2]), /\[replay-clock\] .*not a replay broker/, 'still refused');
});

test('MCP gateway with a replay broker: its ledger and orders of unknown outcome run on the replayed clock', async () => {
  // A replayed time past the wall clock: a ledger stamped on the wall clock would look minutes old and expire at once.
  const future = '2027-03-03T15:00:00.000Z';
  const env = { FAKE_POSITIONS: LONG1, FTH_REPLAY_NOW: future, FAKE_SERVER_CONFIG: serverSays(future) };
  const exit = id => call(id, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' });
  let dir = tmpDir();
  simHome(dir);
  const twice = await gatewayCfg(env, [exit(1), exit(2)], { dir });
  assert.strictEqual(textOf(twice[1]), 'forwarded:tools/call:place_order');
  assert.match(textOf(twice[2]), /\[exposure\] .*once recent orders fill/, 'the first exit still counts');
  dir = tmpDir();
  simHome(dir);
  const afterClose = await gatewayCfg(env, [call(1, 'close_position', { accountId: 1, contractId: 'MNQ' }), exit(2)], { dir });
  assert.match(textOf(afterClose[2]), /\[exposure\] .*once recent orders fill/, 'the close still counts');
  dir = tmpDir();
  simHome(dir);
  const confirmed = await gatewayCfg({ ...env, FAKE_CLOSE_RESULT: JSON.stringify({ success: true, errorCode: 0 }) }, [call(1, 'close_position', { accountId: 1, contractId: 'MNQ' }), exit(2)], { dir });
  assert.match(textOf(confirmed[2]), /\[exposure\] .*once recent orders fill/, 'a confirmed close still counts until the account shows it');
  // Orders of unknown outcome age on the replayed clock (the wall clock stays on Saturday throughout).
  dir = tmpDir();
  simHome(dir);
  const at = s => new Date(Date.parse(TEST_NOW) + s * 1000).toISOString();
  const replayAt = s => ({ FTH_TEST_NOW: SATURDAY, FTH_REPLAY_NOW: at(s), FAKE_SERVER_CONFIG: serverSays(at(s)) });
  await gatewayCfg({ FAKE_POSITIONS: LONG1, FAKE_DROP: 'place_order', FTH_LANE_TIMEOUT_MS: '300', ...replayAt(0) },
    [call(1, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten', customTag: 'r-1' })], { dir });
  const early = await gatewayCfg({ FAKE_SEARCH_ORDERS: '[]', ...replayAt(30) }, [call(2, 'place_order', ORDER)], { dir });
  assert.match(textOf(early[2]), /\[order-pending\]/, '30 replayed seconds later: still inside the grace period');
  const later = await gatewayCfg({ FAKE_SEARCH_ORDERS: '[]', ...replayAt(180) }, [call(2, 'place_order', ORDER)], { dir });
  assert.doesNotMatch(textOf(later[2]), /order-pending/, '3 replayed minutes later: settled as not placed');
});

test('MCP gateway with a replay broker: an allowed entry is recorded at the replayed time', async () => {
  const dir = tmpDir();
  const { home } = simHome(dir, { journalEntries: [{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: 'MNQ', text: 'plan' }] });
  trendHome(home, { closedAt: '2026-10-07T14:27:00.000Z' });
  const byId = await gatewayCfg({
    FTH_TEST_NOW: SATURDAY, FTH_REPLAY_NOW: TEST_NOW, FAKE_SERVER_CONFIG: serverSays(TEST_NOW), FTH_STRATEGIES_DIRS: path.join(ROOT, 'strategies'),
    FAKE_PLACE_RESULT: JSON.stringify({ orderId: 5, success: true, errorCode: 0 }),
  }, [call(0, 'search_contracts', { searchText: 'MNQ' }), call(1, 'place_order', ORDER)], { dir }); // the contract first: its tick specs
  assert.match(textOf(byId[1]), /"orderId":\s*5/, textOf(byId[1]));
  const entries = JSON.parse(fs.readFileSync(path.join(home, 'entry-orders.json'), 'utf8'));
  assert.deepStrictEqual(entries.map(e => [e.orderId, e.at]), [[5, TEST_NOW]]);
});

test('order gate wiring: without the broker\'s tick specs the hook and the gateway refuse an entry, never an exit or a stop; looking the contract up records them', async () => {
  const plan = [{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }];
  // The hook: a home whose translator file has no specs.
  const { env } = setup(plan, { FTH_HOME: trendHome(tmpDir(), { closedAt: '2026-10-07T14:27:00.000Z', specs: false }) });
  const entry = gate(orderPayload(), env);
  assert.strictEqual(entry.code, 2);
  assert.match(entry.stderr, /\[contract-specs\] no tick specs from the broker for MNQ yet: call get_contract or search_contracts for MNQ first/);
  // Even autonomous with every check named skipped.
  const auto = gate(orderPayload(), { ...env, FTH_AUTONOMOUS: '1', FTH_ORDER_GATE_SKIP: 'contract-specs,order-consistency' });
  assert.strictEqual(auto.code, 2);
  for (const input of [{ ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' }, { ...EXIT_BASE, side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long at 21480' }]) {
    const r = gate(orderPayload(input), env);
    assert.strictEqual(r.code, 0, `${input.rationale}: ${r.stderr}`);
  }
  assert.strictEqual(gate({ tool_name: 'mcp__broker__modify_order', tool_input: { accountId: 1, orderId: 9, stopPrice: 21490, reason: '[protect] tighten' } }, env).code, 0);
  assert.strictEqual(gate({ tool_name: 'mcp__broker__close_position', tool_input: { accountId: 1, contractId: 'MNQ', reason: 'flatten' } }, env).code, 0);
  // The gateway, on the configured broker behind the translator: refused, then the contract is looked up and the entry goes.
  const dir = tmpDir();
  const { home } = simHome(dir, { journalEntries: plan });
  trendHome(home, { closedAt: '2026-10-07T14:27:00.000Z', specs: false });
  const base = { FTH_STRATEGIES_DIRS: path.join(ROOT, 'strategies'), FTH_REPLAY_NOW: TEST_NOW, FAKE_SERVER_CONFIG: serverSays(TEST_NOW) };
  // The broker's answer has no tick specs (a contract lookup records none: the gateway's own lookup of the replayed
  // day's front month included).
  const noSpecs = JSON.stringify(JSON.parse(CONTRACTS).map(({ tickSize: _s, tickValue: _v, ...c }) => c));
  const held = await gatewayCfg({ ...base, FAKE_POSITIONS: LONG1, FAKE_CONTRACTS: noSpecs }, [
    call(1, 'place_order', ORDER),
    call(2, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' }),
  ], { dir });
  assert.match(textOf(held[1]), /\[contract-specs\] no tick specs from the broker for MNQ yet/);
  assert.strictEqual(textOf(held[2]), 'forwarded:tools/call:place_order', 'the exit goes without specs');
  // The replayed day's own file (broker/config.js contractsCacheFile).
  fs.rmSync(path.join(home, 'contracts-sim.2026-10-07.json'), { force: true }); // (the exit's own translation looked MNQ up; start over)
  const r = await gatewayCfg({ ...base, FAKE_PLACE_RESULT: JSON.stringify({ orderId: 5, success: true, errorCode: 0 }) }, [
    call(3, 'search_contracts', { searchText: 'MNQ' }),
    call(4, 'place_order', ORDER),
  ], { dir });
  const recorded = JSON.parse(fs.readFileSync(path.join(home, 'contracts-sim.2026-10-07.json'), 'utf8')).specs.MNQ;
  assert.deepStrictEqual([recorded.tickSize, recorded.tickValue, recorded.name], [0.25, 0.5, 'MNQZ6']);
  assert.match(textOf(r[4]), /"orderId":\s*5/, textOf(r[4]));
});

test('order gate wiring: the hook refuses an entry over the broker\'s max order size or its strategy\'s max_risk_usd (even with the checks named skipped); exits, stops and stop moves of any size go', () => {
  const plan = [{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }];
  const { env } = setup(plan);
  recordBrokerSpecs(env.FTH_HOME, { server: { maxOrderSize: 5 } });
  const over = gate(orderPayload({ ...ORDER, size: 27 }), env);
  assert.strictEqual(over.code, 2);
  assert.match(over.stderr, /\[max-order-size\] size 27 over the broker's max order size 5 \(get_server_config maxOrderSize\): reduce the size to 5 or less/);
  const auto = gate(orderPayload({ ...ORDER, size: 6 }), { ...env, FTH_ORDER_GATE_SKIP: 'max-order-size,max-risk' });
  assert.strictEqual(auto.code, 2);
  assert.match(auto.stderr, /\[max-order-size\]/);
  assert.strictEqual(gate(orderPayload({ ...ORDER, size: 5 }), env).code, 0);
  // setup:capped caps a trade at $30: MNQ at a 40-tick stop is $20 a contract.
  const capped = { ...ORDER, rationale: 'setup:capped long, stop 21480, target 21540' };
  assert.strictEqual(gate(orderPayload(capped), env).code, 0);
  const risky = gate(orderPayload({ ...capped, size: 2 }), env);
  assert.strictEqual(risky.code, 2);
  assert.match(risky.stderr, /\[max-risk\] risk \$40\.00 \(size 2 x 40-tick stop x \$0\.50 a tick on MNQ\) over setup:capped's risk\.max_risk_usd \$30\.00: reduce the size to 1 or less, or tighten to a stop of at most 30 ticks at size 2/);
  // The replayed 27-lot: market, no bracket, the stop only in the rationale.
  const { stopLossBracket: _b, ...bare } = capped;
  const replayed = gate(orderPayload({ ...bare, size: 27 }), env);
  assert.strictEqual(replayed.code, 2);
  assert.match(replayed.stderr, /\[max-order-size\] size 27 over/);
  assert.match(replayed.stderr, /\[max-risk\] setup:capped caps risk at \$30\.00 .*can't be computed: a market entry with its stop only in the rationale/);
  // Exits, protective stops, a stop move and a close of any size: never refused by either.
  for (const input of [
    { ...EXIT_BASE, size: 27, side: 'sell', rationale: '[exit] flatten' },
    { ...EXIT_BASE, size: 27, side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long at 21480' },
  ]) {
    const r = gate(orderPayload(input), env);
    assert.strictEqual(r.code, 0, `${input.rationale}: ${r.stderr}`);
  }
  assert.strictEqual(gate({ tool_name: 'mcp__broker__modify_order', tool_input: { accountId: 1, orderId: 9, stopPrice: 21470, reason: '[protect] trail' } }, env).code, 0);
  assert.strictEqual(gate({ tool_name: 'mcp__broker__close_position', tool_input: { accountId: 1, contractId: 'MNQ' } }, env).code, 0);
  // No get_server_config answer recorded: no entry, saying how to fix it; the exit still goes.
  const raw = JSON.parse(fs.readFileSync(path.join(env.FTH_HOME, 'contracts-fake.json'), 'utf8'));
  delete raw.server;
  fs.writeFileSync(path.join(env.FTH_HOME, 'contracts-fake.json'), JSON.stringify(raw));
  const unknown = gate(orderPayload(), env);
  assert.strictEqual(unknown.code, 2);
  assert.match(unknown.stderr, /\[max-order-size\] the broker server's max order size is not recorded yet: call get_server_config/);
  assert.strictEqual(gate(orderPayload({ ...EXIT_BASE, size: 27, side: 'sell', rationale: '[exit] flatten' }), env).code, 0);
});

test('order gate wiring: the gateway refuses a rules entry on the leg not selected (FTH_SYMBOLS); the selected leg and exits on either go', async () => {
  const CROSS = { ...ORDER, rationale: 'setup:crossing long, stop 21480, target 21540' };
  const base = { FTH_STRATEGIES_DIRS: path.join(ROOT, 'strategies'), FAKE_SERVER_CONFIG: JSON.stringify({ tradingEnabled: true, maxOrderSize: 5, allowedAccountIds: [1, 7] }), FAKE_PLACE_RESULT: JSON.stringify({ orderId: 5, success: true, errorCode: 0 }) };
  const through = async (symbols, input) => {
    const dir = tmpDir();
    const { home } = simHome(dir, { replay: false, journalEntries: [{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: 'MNQ', text: 'plan' }] });
    trendHome(home, { closedAt: '2026-10-07T14:27:00.000Z', specs: false, fired: [{ name: 'crossing', direction: 'long' }] });
    const r = await gatewayCfg({ ...base, FTH_SYMBOLS: symbols, ...(/^\[exit\]/.test(input.rationale) ? { FAKE_POSITIONS: JSON.stringify([{ contractId: 'MNQ', type: 1, size: 1 }]), FAKE_PLACE_RESULT: '' } : {}) },
      [call(1, 'search_contracts', { searchText: 'MNQ' }), call(2, 'get_server_config', {}), call(3, 'place_order', input)], { dir });
    return textOf(r[3]);
  };
  assert.match(await through('NQ', CROSS), /\[strategy\] setup:crossing trades NQ \(the selected contract\), not MNQ\./);
  assert.match(await through('MNQ', CROSS), /"orderId":\s*5/);
  assert.strictEqual(await through('NQ', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' }), 'forwarded:tools/call:place_order');
});

test('order gate wiring: the gateway, behind the translator, refuses an entry until get_server_config records the max order size, then over it or over max_risk_usd; exits of any size go', async () => {
  const plan = [{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }];
  const dir = tmpDir();
  const { home } = simHome(dir, { replay: false, journalEntries: plan });
  trendHome(home, { closedAt: '2026-10-07T14:27:00.000Z', specs: false });
  const base = { FTH_STRATEGIES_DIRS: path.join(ROOT, 'strategies'), FAKE_SERVER_CONFIG: JSON.stringify({ tradingEnabled: true, maxOrderSize: 2, allowedAccountIds: [1, 7] }), FAKE_PLACE_RESULT: JSON.stringify({ orderId: 5, success: true, errorCode: 0 }) };
  const capped = { ...ORDER, rationale: 'setup:capped long, stop 21480, target 21540' };
  const r = await gatewayCfg(base, [
    call(1, 'search_contracts', { searchText: 'MNQ' }),
    call(2, 'place_order', ORDER),
    call(3, 'get_server_config', {}),
    call(4, 'place_order', { ...ORDER, size: 3 }),
    call(5, 'place_order', { ...capped, size: 2 }),
    call(6, 'place_order', { ...ORDER, size: 2 }),
  ], { dir });
  assert.match(textOf(r[2]), /\[max-order-size\] the broker server's max order size is not recorded yet: call get_server_config/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'contracts-sim.json'), 'utf8')).server.maxOrderSize, 2, 'recorded by the translator');
  assert.match(textOf(r[4]), /\[max-order-size\] size 3 over the broker's max order size 2/);
  assert.match(textOf(r[5]), /\[max-risk\] risk \$40\.00 \(size 2 x 40-tick stop x \$0\.50 a tick on MNQ\) over setup:capped's risk\.max_risk_usd \$30\.00/);
  assert.doesNotMatch(textOf(r[5]), /max-order-size/);
  assert.match(textOf(r[6]), /"orderId":\s*5/, textOf(r[6]));
  // An exit (and a protective stop) larger than the max order size goes to the broker, which enforces its own.
  const LONG27 = JSON.stringify([{ contractId: 'MNQ', type: 1, size: 27 }]);
  for (const input of [
    { ...EXIT_BASE, size: 27, side: 'sell', rationale: '[exit] flatten' },
    { ...EXIT_BASE, size: 27, side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long at 21480' },
  ]) {
    const d2 = tmpDir();
    const h2 = simHome(d2, { replay: false }).home;
    recordBrokerSpecs(h2, { broker: 'sim', server: { maxOrderSize: 1 } });
    const x = await gatewayCfg({ ...base, FAKE_POSITIONS: LONG27, FAKE_PLACE_RESULT: '' }, [call(7, 'place_order', input)], { dir: d2 });
    assert.strictEqual(textOf(x[7]), 'forwarded:tools/call:place_order', `${input.rationale}: ${textOf(x[7])}`);
  }
});

test('order gate: in an autonomous full cycle, an entry waits until the analysts and both risk-manager phases returned (Claude transcript)', () => {
  const { env, dir } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }],
    { FTH_AUTONOMOUS: '1', FTH_ROLE_SKILLS: 'full', FTH_CYCLE: 'full', FTH_SYMBOLS: 'MNQ' });
  const content = c => JSON.stringify({ type: 'assistant', message: { content: [c] } });
  const skills = ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan'].map(skill => content({ type: 'tool_use', name: 'Skill', input: { skill } }));
  const role = (id, subagent_type) => [content({ type: 'tool_use', id, name: 'Task', input: { subagent_type, prompt: 'p' } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'VERDICT: APPROVE - size 1' }] } })];
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, [...skills, ...role('r1', 'risk-manager')].join('\n'));
  const r = gate({ ...orderPayload(), transcript_path: transcript }, env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[roles-ran\] A full cycle enters only after its roles report.*market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst, risk-manager phase 2/);
  const all = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager', 'risk-manager'].flatMap((t, i) => role(`a${i}`, t));
  fs.writeFileSync(transcript, [...skills, ...all].join('\n'));
  // (An autonomous run reads the wall clock, so other checks may refuse this fixture's entry: only roles-ran is asserted.)
  const ok = gate({ ...orderPayload(), transcript_path: transcript }, env);
  assert.doesNotMatch(ok.stderr, /roles-ran/);
  // The trade-executor places the order: its hook gets its own subagent transcript, read with the main session's.
  const sub = path.join(dir, 'session', 'subagents', 'agent-exec.jsonl');
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(sub, content({ type: 'tool_use', id: 'o1', name: 'mcp__broker__place_order', input: {} }));
  assert.doesNotMatch(gate({ ...orderPayload(), transcript_path: sub }, env).stderr, /roles-ran/);
  fs.writeFileSync(transcript, skills.join('\n'));
  assert.match(gate({ ...orderPayload(), transcript_path: sub }, env).stderr, /\[roles-ran\]/);
  // Phase 2 vetoed, and the order went anyway: refused (every role ran; the verdict is what decides).
  const vetoed = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'].flatMap((t, i) => role(`v${i}`, t));
  const veto = [content({ type: 'tool_use', id: 'vp2', name: 'Task', input: { subagent_type: 'risk-manager', prompt: 'p' } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'vp2', content: 'VERDICT: VETO - mixed alignment at size 1: stand aside' }] } })];
  fs.writeFileSync(transcript, [...skills, ...vetoed, ...veto].join('\n'));
  assert.match(gate({ ...orderPayload(), transcript_path: transcript }, env).stderr, /\[roles-ran\][^\n]*risk-manager phase 2 approving the plan/);
  // Roles the runner served from its report cache (FTH_CYCLE_CACHED) count: only phase 2 ran this cycle.
  fs.writeFileSync(transcript, [...skills, ...role('p2', 'risk-manager')].join('\n'));
  assert.match(gate({ ...orderPayload(), transcript_path: transcript }, env).stderr, /\[roles-ran\]/, 'control: nothing cached');
  const cached = { ...env, FTH_CYCLE_CACHED: 'market-structure-analyst,trend-momentum-analyst,volume-liquidity-analyst,risk-manager' };
  assert.doesNotMatch(gate({ ...orderPayload(), transcript_path: transcript }, cached).stderr, /roles-ran/);
  // An exit is never held for roles.
  fs.writeFileSync(transcript, '');
  const exit = gate({ ...orderPayload({ ...ORDER, side: 'sell', rationale: '[exit] flatten' }), transcript_path: transcript }, env);
  assert.strictEqual(exit.code, 0, exit.stderr);
});

test('order gate hook: a room fact is about the order\'s own setup tag (phase2-facts), never the verdict\'s text', () => {
  const B = require('../../scripts/lib/trading/briefing');
  const BAR = '2026-10-07T14:24:00.000Z';
  const { env, dir } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }],
    { FTH_AUTONOMOUS: '1', FTH_ROLE_SKILLS: 'full', FTH_CYCLE: 'full', FTH_SYMBOLS: 'MNQ', FTH_CYCLE_BARS: JSON.stringify({ MNQ: BAR }) });
  // The order's setup:anytime long is short of room; vx long has room.
  B.writeBriefing(env.FTH_HOME, { symbol: 'MNQ', minutes: 3, asOf: BAR, closedAt: '2026-10-07T14:27:00.000Z', sections: {
    m3: { version: 'a', validUntil: '2026-10-07T14:30:00.000Z', data: { window: 'opening drive', windowEntries: 'allowed', candidates: [
      { name: 'anytime', direction: 'long', stopPoints: 8, needR: 2, inTheWay: { name: 'IB high', R: 0.5 } },
      { name: 'vx', direction: 'long', stopPoints: 8, needR: 2, inTheWay: null },
    ] } },
  } });
  const content = c => JSON.stringify({ type: 'assistant', message: { content: [c] } });
  const skills = ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan'].map(skill => content({ type: 'tool_use', name: 'Skill', input: { skill } }));
  const role = (id, subagent_type, text) => [content({ type: 'tool_use', id, name: 'Task', input: { subagent_type, prompt: 'p' } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })];
  const cycle = p2 => [...skills, ...['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'].flatMap((t, i) => role(`a${i}`, t, 'report')), ...role('p2', 'risk-manager', p2)].join('\n');
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, cycle('VERDICT: APPROVE - size 1, vx long\nFACTS: window opening drive; entries allowed; room long enough'));
  assert.match(gate({ ...orderPayload(), transcript_path: transcript }, env).stderr, /\[phase2-facts\] Risk-manager phase 2 approved on a fact the bar briefing contradicts: "room long enough" \(the briefing: anytime: IB high at 0\.5R, it needs 2R\)/);
  fs.writeFileSync(transcript, cycle('VERDICT: APPROVE - size 1, vx long\nFACTS: window opening drive; entries allowed; room vx long enough'));
  assert.match(gate({ ...orderPayload(), transcript_path: transcript }, env).stderr, /\[phase2-facts\] Risk-manager phase 2 approved on room facts that can't be matched to this order \(setup:anytime long\): "room vx long enough"/);
  // An exit goes whatever the facts say.
  const exit = gate({ ...orderPayload({ ...ORDER, side: 'sell', rationale: '[exit] flatten' }), transcript_path: transcript }, env);
  assert.strictEqual(exit.code, 0, exit.stderr);
});

test('order gate: in an autonomous cycle, an entry approved on a fact the bar briefing contradicts is refused (phase2-facts, Claude transcript and FTH_CYCLE_BARS); exits go', () => {
  const B = require('../../scripts/lib/trading/briefing');
  const BAR = '2026-10-07T14:24:00.000Z';
  const { env, dir } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }],
    { FTH_AUTONOMOUS: '1', FTH_ROLE_SKILLS: 'full', FTH_CYCLE: 'full', FTH_SYMBOLS: 'MNQ', FTH_CYCLE_BARS: JSON.stringify({ MNQ: BAR }) });
  B.writeBriefing(env.FTH_HOME, { symbol: 'MNQ', minutes: 3, asOf: BAR, closedAt: '2026-10-07T14:27:00.000Z', sections: {
    m3: { version: 'a', validUntil: '2026-10-07T14:30:00.000Z', data: { window: 'opening drive', windowEntries: 'allowed', vwap: { side: 'below' } } },
    m15: { version: 'b', validUntil: '2026-10-07T14:30:00.000Z', data: { alignment: { long: 'aligned', short: 'counter' } } },
  } });
  const content = c => JSON.stringify({ type: 'assistant', message: { content: [c] } });
  const skills = ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan'].map(skill => content({ type: 'tool_use', name: 'Skill', input: { skill } }));
  const role = (id, subagent_type, text) => [content({ type: 'tool_use', id, name: 'Task', input: { subagent_type, prompt: 'p' } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text } ] } })];
  const cycle = p2 => [...skills, ...['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'].flatMap((t, i) => role(`a${i}`, t, 'report')), ...role('p2', 'risk-manager', p2)].join('\n');
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, cycle('VERDICT: APPROVE - size 1, risk $40\nFACTS: entries allowed; vwap above; read long aligned'));
  const r = gate({ ...orderPayload(), transcript_path: transcript }, env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[phase2-facts\] Risk-manager phase 2 approved on a fact the bar briefing contradicts: "vwap above" \(the briefing: price below the VWAP\)/);
  assert.doesNotMatch(r.stderr, /roles-ran/);
  // The same facts, true: no phase2-facts refusal (an autonomous run reads the wall clock, so only this check is asserted).
  fs.writeFileSync(transcript, cycle('VERDICT: APPROVE - size 1, risk $40\nFACTS: entries allowed; vwap below; read long aligned'));
  assert.doesNotMatch(gate({ ...orderPayload(), transcript_path: transcript }, env).stderr, /phase2-facts/);
  // Another bar's briefing for the cycle: the stated facts can't be checked, refused.
  const later = { ...env, FTH_CYCLE_BARS: JSON.stringify({ MNQ: '2026-10-07T14:27:00.000Z' }) };
  assert.match(gate({ ...orderPayload(), transcript_path: transcript }, later).stderr, /\[phase2-facts\] The bar briefing for this cycle's MNQ bar \(2026-10-07T14:27:00.000Z\) can't be read/);
  // A current briefing: at least 2 checkable claims (owner's decision): no line, or one claim, refused; two go.
  for (const [p2, n] of [['VERDICT: APPROVE - size 1, risk $40', 0], ['VERDICT: APPROVE - size 1\nFACTS: entries allowed', 1]]) {
    fs.writeFileSync(transcript, cycle(p2));
    assert.match(gate({ ...orderPayload(), transcript_path: transcript }, env).stderr, new RegExp(`\\[phase2-facts\\] Risk-manager phase 2 approved with ${n} checkable facts? \\(at least 2 needed`), p2);
  }
  fs.writeFileSync(transcript, cycle('VERDICT: APPROVE - size 1\nFACTS: entries allowed; window opening drive'));
  assert.doesNotMatch(gate({ ...orderPayload(), transcript_path: transcript }, env).stderr, /phase2-facts/);
  // An exit with no FACTS line goes under a current briefing.
  fs.writeFileSync(transcript, cycle('VERDICT: APPROVE - size 1'));
  const bare = gate({ ...orderPayload({ ...ORDER, side: 'sell', rationale: '[exit] flatten' }), transcript_path: transcript }, env);
  assert.strictEqual(bare.code, 0, bare.stderr);
  // An exit goes, with the false facts and the briefing gone.
  fs.writeFileSync(transcript, cycle('VERDICT: APPROVE - size 1\nFACTS: vwap above'));
  fs.unlinkSync(B.briefingFile(env.FTH_HOME, 'MNQ'));
  const exit = gate({ ...orderPayload({ ...ORDER, side: 'sell', rationale: '[exit] flatten' }), transcript_path: transcript }, env);
  assert.strictEqual(exit.code, 0, exit.stderr);
  // The cycle's bar pinned and its briefing gone: refused, even with FACTS: none; an exit still goes (above).
  fs.writeFileSync(transcript, cycle('VERDICT: APPROVE - size 1\nFACTS: none'));
  assert.match(gate({ ...orderPayload(), transcript_path: transcript }, env).stderr, /\[phase2-facts\] The bar briefing for this cycle's MNQ bar \(2026-10-07T14:24:00.000Z\) can't be read/);
  // No bar pinned and no briefing: FACTS: none (or no line) is no phase2-facts refusal.
  const { FTH_CYCLE_BARS: _pinned, ...unpinned } = env;
  assert.doesNotMatch(gate({ ...orderPayload(), transcript_path: transcript }, unpinned).stderr, /phase2-facts/);
  fs.writeFileSync(transcript, cycle('VERDICT: APPROVE - size 1'));
  assert.doesNotMatch(gate({ ...orderPayload(), transcript_path: transcript }, unpinned).stderr, /phase2-facts/);
});

test('order gate hook: a live entry needs the broker\'s allow-list holding its account; exits and protective stops go without one; a paper run is exempt', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  for (const [list, why] of [['', /FAKE_BROKER_ALLOWED_ACCOUNT_IDS is empty/], ['any', /never empty or "any"/], ['7', /account 1 is not in FAKE_BROKER_ALLOWED_ACCOUNT_IDS \(7\)/]]) {
    const r = gate(orderPayload(), { ...env, FAKE_BROKER_ALLOWED_ACCOUNT_IDS: list });
    assert.strictEqual(r.code, 2, list);
    assert.match(r.stderr, /\[allowed-accounts\]/);
    assert.match(r.stderr, why);
  }
  const { FAKE_BROKER_ALLOWED_ACCOUNT_IDS: _unset, ...noList } = env;
  for (const input of [{ ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' }, { ...EXIT_BASE, side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long at 21480' }]) {
    const r = gate(orderPayload(input), noList);
    assert.strictEqual(r.code, 0, r.stderr);
  }
  // Paper (the broker's paper settings in force): the server refuses every order, so no list is needed.
  assert.strictEqual(gate(orderPayload(), { ...noList, FAKE_BROKER_TRADING_ENABLED: 'false' }).code, 0);
  // Control: listed, the entry goes.
  assert.strictEqual(gate(orderPayload(), { ...env, FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '5, 1' }).code, 0);
  // The list in the .env the gateway loads (the hook's own environment lacks it) counts as the server's.
  fs.writeFileSync(path.join(env.FTH_HOME, '.env'), 'FAKE_BROKER_ALLOWED_ACCOUNT_IDS=1\n', { mode: 0o600 });
  assert.strictEqual(gate(orderPayload(), noList).code, 0);
  fs.writeFileSync(path.join(env.FTH_HOME, '.env'), 'FAKE_BROKER_ALLOWED_ACCOUNT_IDS=7\n', { mode: 0o600 });
  assert.match(gate(orderPayload(), noList).stderr, /account 1 is not in FAKE_BROKER_ALLOWED_ACCOUNT_IDS \(7\)/);
});

test('MCP gateway: a live entry on an account off the allow-list is refused before the broker sees it; exits and closes still go', async () => {
  const base = { FTH_STRATEGIES_DIRS: path.join(ROOT, 'strategies'), FAKE_SERVER_CONFIG: JSON.stringify({ tradingEnabled: true, maxOrderSize: 5, allowedAccountIds: [1, 7] }), FAKE_PLACE_RESULT: JSON.stringify({ orderId: 5, success: true, errorCode: 0 }) };
  const through = async (extra, msgs) => {
    const dir = tmpDir();
    const { home } = simHome(dir, { replay: false, journalEntries: [{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: 'MNQ', text: 'plan' }] });
    trendHome(home, { closedAt: '2026-10-07T14:27:00.000Z', specs: false });
    return gatewayCfg({ ...base, ...extra }, [call(1, 'search_contracts', { searchText: 'MNQ' }), call(2, 'get_server_config', {}), ...msgs], { dir });
  };
  for (const list of ['', 'any', '7']) {
    const r = await through({ SIM_ALLOWED_ACCOUNTS: list }, [call(3, 'place_order', ORDER)]);
    assert.match(textOf(r[3]), /\[allowed-accounts\]/, list);
  }
  // Risk-reducing calls with no list at all, each in a run of its own.
  for (const m of [
    call(3, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' }),
    call(3, 'close_position', { accountId: 1, contractId: 'MNQ' }),
    call(3, 'cancel_order', { accountId: 1, orderId: 9 }),
  ]) {
    const r = await through({ SIM_ALLOWED_ACCOUNTS: '', FAKE_POSITIONS: LONG1, FAKE_PLACE_RESULT: '' }, [m]);
    assert.strictEqual(textOf(r[3]), `forwarded:tools/call:${m.params.name}`);
  }
  // Control: listed, the entry reaches the broker.
  assert.match(textOf((await through({ SIM_ALLOWED_ACCOUNTS: '1' }, [call(3, 'place_order', ORDER)]))[3]), /"orderId":\s*5/);
});

test('MCP gateway: the server attests live entries - an override can\'t spoof a shipped broker\'s paper or allow-list settings, a server that trades overrides a paper claim, its own allowed accounts must list the account, and an unreadable config refuses entries only', async () => {
  const plan = [{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: 'MNQ', text: 'plan' }];
  const server = over => JSON.stringify({ tradingEnabled: true, maxOrderSize: 5, allowedAccountIds: [1], ...over });
  const placed5 = JSON.stringify({ orderId: 5, success: true, errorCode: 0 });
  const through = async ({ name = 'sim', broker = {}, env = {}, msgs = [call(3, 'place_order', ORDER)] }) => {
    const dir = tmpDir();
    const { home, journal } = simHome(dir, { replay: false, journalEntries: plan });
    fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: name, brokers: { [name]: { command: [process.execPath, FAKE_MCP], journal, ...broker } } }));
    trendHome(home, { closedAt: '2026-10-07T14:27:00.000Z', specs: false });
    recordBrokerSpecs(home, { broker: name }); // the tick specs and max order size, recorded earlier (a broken config records none)
    const r = await gatewayCfg({ FTH_STRATEGIES_DIRS: path.join(ROOT, 'strategies'), FAKE_SERVER_CONFIG: server(), FAKE_PLACE_RESULT: placed5, SIM_ALLOWED_ACCOUNTS: '', ...env },
      [call(1, 'search_contracts', { searchText: 'MNQ' }), call(2, 'get_server_config', {}), ...msgs], { dir });
    return textOf(r[3]);
  };
  const refused = (text, why) => { assert.match(text, /\[allowed-accounts\]/); assert.match(text, why); };
  // 1. A user override of the shipped live broker that names its own paper switch and allow-list: both stay the shipped ones.
  const shipped = shippedBroker();
  refused(await through({ name: shipped.name, broker: { paperEnv: { SPOOF_PAPER: 'on' }, allowedAccountsEnv: 'SPOOF_LIST' }, env: { SPOOF_PAPER: 'on', SPOOF_LIST: '1' } }),
    new RegExp(`${shipped.allowedAccountsEnv} is empty`));
  // 2. A paper claim (the broker's paper settings in force) the server contradicts (trading on) is a live entry.
  const paperSim = { allowedAccountsEnv: 'SIM_ALLOWED_ACCOUNTS', paperEnv: { SIM_PAPER: 'on' } };
  refused(await through({ broker: paperSim, env: { SIM_PAPER: 'on' } }), /SIM_ALLOWED_ACCOUNTS is empty/);
  // ...and the server with trading off confirms it: the entry goes to the server (which refuses it itself).
  assert.match(await through({ broker: paperSim, env: { SIM_PAPER: 'on', FAKE_SERVER_CONFIG: server({ tradingEnabled: false }) } }), /"orderId":\s*5/);
  // 3. The local list holds the account, the server's own doesn't (or takes any account): refused.
  const live = { allowedAccountsEnv: 'SIM_ALLOWED_ACCOUNTS' };
  refused(await through({ broker: live, env: { SIM_ALLOWED_ACCOUNTS: '1', FAKE_SERVER_CONFIG: server({ allowedAccountIds: [7] }) } }), /account 1 is not among the broker server's allowed accounts \(7\)/);
  refused(await through({ broker: live, env: { SIM_ALLOWED_ACCOUNTS: '1', FAKE_SERVER_CONFIG: server({ allowedAccountIds: 'any' }) } }), /allows any account/);
  // 4. A server config that can't be read: entries refused, exits and closes still go.
  const broken = { FAKE_SERVER_CONFIG: '' }; // the fake server answers with plain text, not JSON
  refused(await through({ broker: live, env: { SIM_ALLOWED_ACCOUNTS: '1', ...broken } }), /get_server_config could not be read/);
  for (const m of [call(3, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' }), call(3, 'close_position', { accountId: 1, contractId: 'MNQ' })]) {
    assert.strictEqual(await through({ broker: live, env: { SIM_ALLOWED_ACCOUNTS: '1', FAKE_POSITIONS: LONG1, FAKE_PLACE_RESULT: '', ...broken }, msgs: [m] }), `forwarded:tools/call:${m.params.name}`);
  }
  // Control: both lists hold the account and the server trades: the entry goes.
  assert.match(await through({ broker: live, env: { SIM_ALLOWED_ACCOUNTS: '1' } }), /"orderId":\s*5/);
});

test('order gate wiring: FTH_ACCOUNT_LOCK - an entry from a cycle without its runner\'s lock (or one it lost) is refused; exits pass; held, no refusal', () => {
  const L = require('../../scripts/lib/account-lock');
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const lockEnv = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const lock = L.acquireAccountLocks({ env: lockEnv, broker: { name: 'live' }, servers: ['cmd:/s'], accountId: String(entryOrder().accountId) });
  try {
    const none = gate(orderPayload(), { ...env, FTH_ACCOUNT_LOCK: 'none' });
    assert.strictEqual(none.code, 2);
    assert.match(none.stderr, /\[account-lock\] This cycle runs without its account's runner lock/);
    const exit = gate(orderPayload(entryOrder({ side: 'sell', rationale: '[exit] flatten before the close' })), { ...env, FTH_ACCOUNT_LOCK: 'none' });
    assert.strictEqual(exit.code, 0, 'exits are always allowed');
    const held = gate(orderPayload(), { ...env, FTH_ACCOUNT_LOCK: L.lockSpec(lock) });
    assert.doesNotMatch(held.stderr, /account-lock/);
    fs.writeFileSync(lock.files[0], JSON.stringify({ pid: process.pid, host: require('os').hostname(), token: 'theirs' }));
    const lost = gate(orderPayload(), { ...env, FTH_ACCOUNT_LOCK: L.lockSpec(lock) });
    assert.strictEqual(lost.code, 2);
    assert.match(lost.stderr, /\[account-lock\] The runner no longer holds its account's lock/);
  } finally {
    lock.release();
  }
});

test('order gate wiring: outside a runner (no FTH_ACCOUNT_LOCK), an entry on an account a live runner holds is refused; exits pass; free, no refusal', () => {
  const L = require('../../scripts/lib/account-lock');
  const os = require('os');
  const { spawn } = require('child_process');
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const lockEnv = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1', FAKE_BROKER_API_URL: 'https://api.fake-broker.test' };
  const full = { ...env, ...lockEnv };
  const free = gate(orderPayload(), full);
  assert.doesNotMatch(free.stderr, /account-lock/);
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/x/scripts/autotrader.js'], { stdio: 'ignore' });
  try {
    const file = L.lockFileFor({ env: lockEnv, server: 'api:https://api.fake-broker.test', accountId: entryOrder().accountId });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: runner.pid, host: os.hostname(), home: '/homes/runner', startedAt: 't', token: 'x' }));
    const held = gate(orderPayload(), full);
    assert.strictEqual(held.code, 2);
    assert.match(held.stderr, new RegExp(`\\[account-lock\\] account \\d+ on broker "fake" is already traded by another runner \\(pid ${runner.pid}.*Entries from another session are refused`));
    const exit = gate(orderPayload(entryOrder({ side: 'sell', rationale: '[exit] flatten before the close' })), full);
    assert.strictEqual(exit.code, 0, 'exits are always allowed');
    const protect = gate(orderPayload(entryOrder({ side: 'sell', rationale: '[protect] stop at 21480' })), full);
    assert.doesNotMatch(protect.stderr, /account-lock/);
  } finally {
    runner.kill();
  }
});

test('order gate wiring: inside a runner (FTH_ACCOUNT_LOCK), an entry on another account is refused even when no runner holds that one; an exit there passes', () => {
  const L = require('../../scripts/lib/account-lock');
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const lockEnv = { FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const mine = String(entryOrder().accountId);
  const lock = L.acquireAccountLocks({ env: lockEnv, broker: { name: 'live' }, servers: ['cmd:/s'], accountId: mine });
  try {
    const full = { ...env, ...lockEnv, FTH_ACCOUNT_LOCK: L.lockSpec(lock) };
    const other = gate(orderPayload(entryOrder({ accountId: 7 })), full);
    assert.strictEqual(other.code, 2);
    assert.match(other.stderr, new RegExp(`\\[account-lock\\] This runner holds account ${mine}'s lock, not account 7's`));
    const exit = gate(orderPayload(entryOrder({ accountId: 7, side: 'sell', rationale: '[exit] flatten before the close' })), full);
    assert.strictEqual(exit.code, 0, 'exits on any account are always allowed');
    const own = gate(orderPayload(), full);
    assert.doesNotMatch(own.stderr, /account-lock/);
  } finally {
    lock.release();
  }
});

test('order gate wiring: outside a runner, an entry with no valid account id is refused by the lock check; exits pass', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const full = { ...env, FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1' };
  const r = gate(orderPayload(entryOrder({ accountId: 'x' })), full);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[account-lock\] The order names no valid accountId \("x"\)/);
  const exit = gate(orderPayload(entryOrder({ accountId: 'x', side: 'sell', rationale: '[exit] flatten before the close' })), full);
  assert.doesNotMatch(exit.stderr, /account-lock/, 'exits never meet the lock check');
});

test('order gate wiring: outside a runner, a live broker whose API URL variable is unset refuses entries (naming it); exits pass', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const full = { ...env, FTH_LOCK_DIR: tmpDir(), FTH_TEST_LOCKS: '1', FAKE_BROKER_API_URL: '' };
  const r = gate(orderPayload(), full);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[account-lock\] broker "fake": FAKE_BROKER_API_URL is not set, .*Set FAKE_BROKER_API_URL/);
  const exit = gate(orderPayload(entryOrder({ side: 'sell', rationale: '[exit] flatten before the close' })), full);
  assert.strictEqual(exit.code, 0, 'exits are always allowed');
});

test('order gate hook: in index mode (the default: no FTH_ROLE_SKILLS set) a role\'s report counts only with the lookups its bar requires; an exit, a protective stop and a stop move are never held', () => {
  const { writeBriefing } = require('../../scripts/lib/trading/briefing');
  const { recordLookup } = require('../../scripts/lib/trading/skill-lookups');
  const { env, dir } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }],
    { FTH_AUTONOMOUS: '1', FTH_CYCLE: 'full', FTH_SYMBOLS: 'MNQ' });
  // A with-trend candidate on this bar's briefing (current by the wall clock an autonomous run reads): the situational
  // skills of the roles that index them are required (skills-loaded.js SITUATIONAL).
  writeBriefing(env.FTH_HOME, { symbol: 'MNQ', sections: { m3: { validUntil: new Date(Date.now() + 3600000).toISOString(), data: { candidates: [{ name: 'anytime', direction: 'long', trendRule: 'allows' }] } } } });
  const ev = (tool, input, time) => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool, state: { status: 'completed', input, output: 'VERDICT: APPROVE - size 1', ...(time ? { time } : {}) } } });
  const T = 1.8e12;
  const transcript = path.join(dir, 'cycle-transcript.jsonl');
  fs.writeFileSync(transcript, [...['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan'].map(name => ev('skill', { name })),
    ...[['market-structure-analyst', 10, 20], ['trend-momentum-analyst', 10, 20], ['volume-liquidity-analyst', 10, 20], ['risk-manager', 10, 18], ['risk-manager', 30, 40]]
      .map(([subagent_type, s, e]) => ev('task', { subagent_type }, { start: T + s, end: T + e }))].join('\n'));
  // The default: no FTH_ROLE_SKILLS in the hook's environment is index mode.
  assert.strictEqual(env.FTH_ROLE_SKILLS, undefined);
  const index = env;
  const look = (role, skill, at) => recordLookup({ FTH_CYCLE_TRANSCRIPT: transcript }, { role, skill }, T + at);
  look('risk-manager', 'confluence-counting', 31);
  look('risk-manager', 'invalidation', 31);
  const r = gate({ ...orderPayload(), transcript_path: transcript }, index);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[roles-ran\][^\n]*market-structure-analyst reported without looking up breakout-vs-fakeout, breakout(?![\w-])/);
  assert.match(gate({ ...orderPayload(), transcript_path: transcript }, { ...env, FTH_ROLE_SKILLS: 'index' }).stderr, /\[roles-ran\][^\n]*market-structure-analyst reported without looking up/);
  // Full, on request (as the runner sets for every harness but opencode): not required.
  assert.doesNotMatch(gate({ ...orderPayload(), transcript_path: transcript }, { ...env, FTH_ROLE_SKILLS: 'full' }).stderr, /roles-ran/);
  // Never held by the missing lookup: an exit, a protective stop, a stop move (modify_order).
  for (const order of [{ ...ORDER, side: 'sell', rationale: '[exit] flatten' }, { ...ORDER, side: 'sell', type: 'stop', stopPrice: 21480, stopLossBracket: undefined, rationale: '[protect] stop for the long' }]) {
    const r2 = gate({ ...orderPayload(order), transcript_path: transcript }, index);
    assert.strictEqual(r2.code, 0, r2.stderr);
  }
  const moved = gate({ tool_name: 'mcp__broker__modify_order', tool_input: { accountId: ORDER.accountId, orderId: 7, stopPrice: 21490 }, transcript_path: transcript }, index);
  assert.strictEqual(moved.code, 0, moved.stderr);
  // Looked up during its call (the harness tool records it next to the transcript): counted.
  look('market-structure-analyst', 'breakout-vs-fakeout', 15);
  look('market-structure-analyst', 'breakout', 15);
  assert.doesNotMatch(gate({ ...orderPayload(), transcript_path: transcript }, index).stderr, /roles-ran/);
  // An exit is never held.
  fs.unlinkSync(`${transcript}.lookups.jsonl`);
  const exit = gate({ ...orderPayload({ ...ORDER, side: 'sell', rationale: '[exit] flatten' }), transcript_path: transcript }, index);
  assert.strictEqual(exit.code, 0, exit.stderr);
});

test('order gate hook, several lanes (FTH_CYCLE_LANE_BARS): a closed lane\'s candidate requires the lookups in the default mode; with them it goes; an exit is never held', () => {
  const { writeBriefing, writeFrameBriefing } = require('../../scripts/lib/trading/briefing');
  const { recordLookup } = require('../../scripts/lib/trading/skill-lookups');
  const lane = '2026-10-07T14:29:00.000Z';
  const { env, dir } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }],
    { FTH_AUTONOMOUS: '1', FTH_CYCLE: 'full', FTH_SYMBOLS: 'MNQ', FTH_CYCLE_LANE_BARS: JSON.stringify({ MNQ: { 1: lane } }) });
  // The runner's 3m briefing: no candidate. The 1m lane's briefing on the bar that closed this cycle: a with-trend one.
  writeBriefing(env.FTH_HOME, { symbol: 'MNQ', minutes: 3, sections: { m3: { validUntil: new Date(Date.now() + 3600000).toISOString(), data: { candidates: [] } } } });
  writeFrameBriefing(env.FTH_HOME, { symbol: 'MNQ', minutes: 1, asOf: lane, closedAt: '2026-10-07T14:30:00.000Z', sections: { bar: { validUntil: new Date(Date.now() + 3600000).toISOString(), data: { candidates: [{ name: 'anytime', direction: 'long', trendRule: 'allows' }] } } } });
  const ev = (tool, input, time) => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool, state: { status: 'completed', input, output: 'VERDICT: APPROVE - size 1', ...(time ? { time } : {}) } } });
  const T = 1.8e12;
  const transcript = path.join(dir, 'cycle-transcript.jsonl');
  fs.writeFileSync(transcript, [...['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan'].map(name => ev('skill', { name })),
    ...[['market-structure-analyst', 10, 20], ['trend-momentum-analyst', 10, 20], ['volume-liquidity-analyst', 10, 20], ['risk-manager', 10, 18], ['risk-manager', 30, 40]]
      .map(([subagent_type, s, e]) => ev('task', { subagent_type }, { start: T + s, end: T + e }))].join('\n'));
  const r = gate({ ...orderPayload(), transcript_path: transcript }, env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[roles-ran\][^\n]*market-structure-analyst reported without looking up breakout-vs-fakeout, breakout/);
  assert.doesNotMatch(r.stderr, /risk-manager reported without/, "the risk manager embeds its situational skills");
  // Without the lane in the environment, the 3m briefing alone: nothing required.
  const { FTH_CYCLE_LANE_BARS: _lanes, ...oneLane } = env;
  assert.doesNotMatch(gate({ ...orderPayload(), transcript_path: transcript }, oneLane).stderr, /roles-ran/);
  const exit = gate({ ...orderPayload({ ...ORDER, side: 'sell', rationale: '[exit] flatten' }), transcript_path: transcript }, env);
  assert.strictEqual(exit.code, 0, exit.stderr);
  const look = (role, skill, at) => recordLookup({ FTH_CYCLE_TRANSCRIPT: transcript }, { role, skill }, T + at);
  look('market-structure-analyst', 'breakout-vs-fakeout', 15);
  look('market-structure-analyst', 'breakout', 15);
  look('risk-manager', 'confluence-counting', 31);
  look('risk-manager', 'invalidation', 31);
  assert.doesNotMatch(gate({ ...orderPayload(), transcript_path: transcript }, env).stderr, /roles-ran/);
});

test('order gate hook, reports from the report cache (FTH_CYCLE_CACHED): a cached report counts on a bar requiring lookups only with its own call\'s lookups (FTH_CYCLE_CACHED_LOOKUPS); none, unreadable or another role\'s: refused; an exit is never held', () => {
  const { writeBriefing } = require('../../scripts/lib/trading/briefing');
  const { env, dir } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }],
    { FTH_AUTONOMOUS: '1', FTH_CYCLE: 'full', FTH_SYMBOLS: 'MNQ', FTH_CYCLE_CACHED: 'market-structure-analyst,trend-momentum-analyst,volume-liquidity-analyst,risk-manager' });
  // The bar's briefing, its m3 version the facts key the requirement comes from (skill-lookups.js factsKey).
  const brief = version => writeBriefing(env.FTH_HOME, { symbol: 'MNQ', sections: { m3: { version, validUntil: new Date(Date.now() + 3600000).toISOString(), data: { candidates: [{ name: 'anytime', direction: 'long', trendRule: 'reversal' }] } } } });
  brief('m3@bar-n');
  const ev = (tool, input, time) => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool, state: { status: 'completed', input, output: 'VERDICT: APPROVE - size 1', ...(time ? { time } : {}) } } });
  const T = 1.8e12;
  const transcript = path.join(dir, 'cycle-transcript.jsonl');
  // Only phase 2 ran this cycle: every other report came from the cache.
  fs.writeFileSync(transcript, [...['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan'].map(name => ev('skill', { name })),
    ev('task', { subagent_type: 'risk-manager' }, { start: T + 30, end: T + 40 })].join('\n'));
  const keyed = (o, key = 'm3@bar-n') => Object.fromEntries(Object.entries(o).map(([role, skills]) => [role, { skills, key }]));
  const met = keyed({ 'market-structure-analyst': ['pullback-vs-reversal', 'rejection'], 'trend-momentum-analyst': ['pullback-vs-reversal'] });
  const run = extra => gate({ ...orderPayload(), transcript_path: transcript }, { ...env, ...extra });
  const none = run({});
  assert.strictEqual(none.code, 2);
  assert.match(none.stderr, /\[roles-ran\][^\n]*market-structure-analyst was served from the report cache, which made no lookup of pullback-vs-reversal, rejection/);
  for (const raw of ['not json', JSON.stringify(keyed({ 'volume-liquidity-analyst': ['pullback-vs-reversal', 'rejection'] })), JSON.stringify({ ...met, ...keyed({ 'market-structure-analyst': ['rejection'] }) }),
    JSON.stringify({ ...met, 'market-structure-analyst': ['pullback-vs-reversal', 'rejection'] }), JSON.stringify(keyed({ 'market-structure-analyst': ['pullback-vs-reversal', 'rejection'], 'trend-momentum-analyst': ['pullback-vs-reversal'] }, 'm3@bar-earlier'))]) {
    const r = run({ FTH_CYCLE_CACHED_LOOKUPS: raw });
    assert.strictEqual(r.code, 2, raw);
    assert.match(r.stderr, /market-structure-analyst was served from the report cache, which made no lookup of pullback-vs-reversal/, raw);
  }
  // Not cached this cycle (FTH_CYCLE_CACHED without it): its lookups are ignored.
  assert.strictEqual(run({ FTH_CYCLE_CACHED: 'trend-momentum-analyst,volume-liquidity-analyst,risk-manager', FTH_CYCLE_CACHED_LOOKUPS: JSON.stringify(met) }).code, 2);
  assert.doesNotMatch(run({ FTH_CYCLE_CACHED_LOOKUPS: JSON.stringify(met) }).stderr, /roles-ran/);
  // A new bar with a candidate since the reports were made: their lookups are not credited to it.
  brief('m3@bar-n3');
  assert.match(run({ FTH_CYCLE_CACHED_LOOKUPS: JSON.stringify(met) }).stderr, /market-structure-analyst was served from the report cache/);
  const exit = gate({ ...orderPayload({ ...ORDER, side: 'sell', rationale: '[exit] flatten' }), transcript_path: transcript }, env);
  assert.strictEqual(exit.code, 0, exit.stderr);
});

test('order gate hook, a long cycle: past its briefing\'s validUntil by the wall clock, the briefing of the cycle\'s bar (FTH_CYCLE_BARS) decides the required lookups and the cached key; no bar or another bar\'s: every lookup required; an exit is never held', () => {
  const { writeBriefing } = require('../../scripts/lib/trading/briefing');
  const { recordLookup } = require('../../scripts/lib/trading/skill-lookups');
  const BAR_T = '2026-10-07T14:24:00.000Z';
  const { env, dir } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }],
    { FTH_AUTONOMOUS: '1', FTH_CYCLE: 'full', FTH_SYMBOLS: 'MNQ' });
  // The cycle's bar's briefing, expired by the wall clock the live gate reads (a delegated cycle outlasts its bar).
  const brief = asOf => writeBriefing(env.FTH_HOME, { symbol: 'MNQ', minutes: 3, asOf, closedAt: new Date(Date.now() - 4 * 60000).toISOString(), sections: { m3: { version: `m3@${asOf}`, validUntil: new Date(Date.now() - 60000).toISOString(), data: { candidates: [{ name: 'anytime', direction: 'long', trendRule: 'reversal' }] } } } });
  brief(BAR_T);
  const ev = (tool, input, time) => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool, state: { status: 'completed', input, output: 'VERDICT: APPROVE - size 1', ...(time ? { time } : {}) } } });
  const T = 1.8e12;
  const transcript = path.join(dir, 'cycle-transcript.jsonl');
  fs.writeFileSync(transcript, [...['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan'].map(name => ev('skill', { name })),
    ...[['market-structure-analyst', 10, 20], ['trend-momentum-analyst', 10, 20], ['volume-liquidity-analyst', 10, 20], ['risk-manager', 10, 18], ['risk-manager', 30, 40]]
      .map(([subagent_type, s, e]) => ev('task', { subagent_type }, { start: T + s, end: T + e }))].join('\n'));
  const look = (role, skill, at) => recordLookup({ FTH_CYCLE_TRANSCRIPT: transcript }, { role, skill }, T + at);
  look('market-structure-analyst', 'rejection', 11);
  look('market-structure-analyst', 'pullback-vs-reversal', 12);
  look('trend-momentum-analyst', 'pullback-vs-reversal', 11);
  const run = (extra, order = orderPayload()) => gate({ ...order, transcript_path: transcript }, { ...env, ...extra });
  const BARS = { FTH_CYCLE_BARS: JSON.stringify({ MNQ: BAR_T }) };
  // The cycle's bar named: its briefing's reversal candidate requires the lookups made, nothing more.
  assert.doesNotMatch(run(BARS).stderr, /roles-ran/);
  // None named, or another bar named: the expired briefing is no facts, every situational lookup required (fails closed).
  for (const extra of [{}, { FTH_CYCLE_BARS: JSON.stringify({ MNQ: '2026-10-07T14:27:00.000Z' }) }]) {
    const r = run(extra);
    assert.strictEqual(r.code, 2, JSON.stringify(extra));
    assert.match(r.stderr, /\[roles-ran\][^\n]*market-structure-analyst reported without looking up [^)]*breakout/, JSON.stringify(extra));
  }
  // A later bar's briefing written mid-cycle is not the cycle's: refused.
  brief('2026-10-07T14:27:00.000Z');
  assert.match(run(BARS).stderr, /\[roles-ran\]/);
  brief(BAR_T);
  // Served from the cache: the cached report's lookups count under the cycle's key past validUntil.
  const p2 = path.join(dir, 'cycle-transcript-p2.jsonl');
  fs.writeFileSync(p2, [...['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan'].map(name => ev('skill', { name })),
    ev('task', { subagent_type: 'risk-manager' }, { start: T + 30, end: T + 40 })].join('\n'));
  const cached = key => ({ ...BARS, FTH_CYCLE_CACHED: 'market-structure-analyst,trend-momentum-analyst,volume-liquidity-analyst,risk-manager',
    FTH_CYCLE_CACHED_LOOKUPS: JSON.stringify({ 'market-structure-analyst': { skills: ['pullback-vs-reversal', 'rejection'], key }, 'trend-momentum-analyst': { skills: ['pullback-vs-reversal'], key } }) });
  assert.doesNotMatch(gate({ ...orderPayload(), transcript_path: p2 }, { ...env, ...cached(`m3@${BAR_T}`) }).stderr, /roles-ran/);
  assert.match(gate({ ...orderPayload(), transcript_path: p2 }, { ...env, ...cached(`m3@${BAR_T}`), FTH_CYCLE_BARS: '' }).stderr, /market-structure-analyst was served from the report cache/);
  const exit = run({}, orderPayload({ ...ORDER, side: 'sell', rationale: '[exit] flatten' }));
  assert.strictEqual(exit.code, 0, exit.stderr);
});

test('order gate hook, briefing-age: an autonomous entry on a bar briefing older than 3 of its bars is refused with the bar\'s age, in the gate log too; a fresh one is not; an exit is never held', () => {
  const { writeBriefing } = require('../../scripts/lib/trading/briefing');
  const BAR_T = '2026-10-07T14:24:00.000Z';
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }],
    { FTH_AUTONOMOUS: '1', FTH_CYCLE: 'full', FTH_SYMBOLS: 'MNQ', FTH_ROLE_SKILLS: 'full', FTH_CYCLE_BARS: JSON.stringify({ MNQ: BAR_T }) });
  // An autonomous gate reads the wall clock: the bar closed 12 minutes ago on 3m bars (limit 9).
  const brief = minAgo => writeBriefing(env.FTH_HOME, { symbol: 'MNQ', minutes: 3, asOf: BAR_T, closedAt: new Date(Date.now() - minAgo * 60000).toISOString(), sections: { m3: { validUntil: new Date(Date.now() + 3600000).toISOString(), data: { candidates: [] } } } });
  brief(12);
  const r = gate(orderPayload(), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[briefing-age\][^\n]*Stale data: the MNQ bar briefing's bar \(at 2026-10-07T14:24:00.000Z\) closed 12\.\d min ago, over the 9 min limit/);
  const log = fs.readFileSync(env.FTH_GATE_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
  assert.ok(log.violations.some(v => v.check === 'briefing-age' && /closed 12\.\d min ago/.test(v.message)), JSON.stringify(log));
  const exit = gate(orderPayload({ ...ORDER, side: 'sell', rationale: '[exit] flatten' }), env);
  assert.strictEqual(exit.code, 0, exit.stderr);
  brief(1);
  assert.doesNotMatch(gate(orderPayload(), env).stderr, /briefing-age/);
});

// ---- trade_lifecycle (composed-reads) wiring: the hook and the gateway ----
const LC = require('../fixtures/lifecycle');
const LC_AT = '2026-10-07T14:00:02.000Z';
// A plugin root whose only strategy is the shipped trade_lifecycle, for the hook.
const LC_ROOT = (() => {
  const root = tmpDir();
  fs.symlinkSync(path.join(REPO, 'scripts'), path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'strategies'));
  fs.symlinkSync(path.join(REPO, 'strategies', 'trade_lifecycle'), path.join(root, 'strategies', 'trade_lifecycle'));
  return root;
})();
const lcPlan = { ts: '2026-10-07T13:59:30.000Z', kind: 'plan', contractId: 'MNQ', text: 'composed long, stop 21512.50, target 21598.00' };

test('order gate (hook): a trade_lifecycle entry is judged on its compose record ([composed-reads]); an exit always goes', () => {
  const home = trendHome();
  const lc = (entries, input, extra = {}) => gate(orderPayload(input), setup(entries, { FTH_HOME: home, FTH_TEST_NOW: LC_AT, CLAUDE_PLUGIN_ROOT: LC_ROOT, FTH_CYCLE_BARS: JSON.stringify({ MNQ: LC.BAR }), ...extra }).env);
  // No record yet: refused by composed-reads, and by it alone.
  require('../../scripts/lib/trading/briefing').writeBriefing(home, LC.briefing());
  let r = lc([lcPlan], LC.order());
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[composed-reads\] setup:trade_lifecycle: no compose record for the MNQ bar opened 2026-10-07T13:57:00.000Z/);
  assert.doesNotMatch(r.stderr, /\[strategy\]/);
  // The record: the entry goes.
  LC.writeScenario(home, { write: false });
  r = lc([lcPlan], LC.order());
  assert.strictEqual(r.code, 0, r.stderr);
  // The record's side is long: a short is refused naming it.
  assert.match(lc([lcPlan], LC.order({ side: 'sell', limitPrice: 21540.25, rationale: 'setup:trade_lifecycle short' })).stderr, /\[composed-reads\] setup:trade_lifecycle: the compose record for this bar is for a long, not this short/);
  // Not in a runner's cycle (no FTH_CYCLE_BARS): refused.
  assert.match(lc([lcPlan], LC.order(), { FTH_CYCLE_BARS: '' }).stderr, /\[composed-reads\] .*no cycle bar for MNQ/);
  // An exit and a protective stop go with nothing: no record, no briefing, no cycle bar.
  fs.unlinkSync(path.join(home, 'briefing', 'MNQ.json'));
  for (const rationale of ['[exit] flatten the composed long', '[protect] stop for the composed long']) {
    assert.strictEqual(lc([], { ...EXIT_BASE, side: 'sell', type: 'stop', stopPrice: 21512.5, rationale }, { FTH_CYCLE_BARS: '' }).code, 0, rationale);
  }
});

test('order gate (hook): a composed long fading a 4h down trend needs a 4h rejection of a key level; a gap edge is none ([mtf-trend]); an exit goes', () => {
  // The briefing: a 1h CHoCH up, and a 4h candle that rejected both the previous 4h low and a 15m gap's low, up.
  const b = LC.briefing();
  b.sections.h1.data.lastBreak = { last: { kind: 'CHoCH', direction: 'up', level: 21500 }, previous: null };
  b.sections.m3.data.candles['4h'] = { closedAt: '2026-10-07T10:00:00.000Z', o: 21480, h: 21560, l: 21470, c: 21540, closeLocation: 'top',
    relations: [{ name: 'previous 4h low', price: 21475, rel: 'rejected', dir: 'up' }],
    fvgRelations: [{ name: '15m fvg low', price: 21472, side: 'bullish', rel: 'rejected', dir: 'up' }] };
  const run = rejection => {
    const home = trendHome(tmpDir(), { biases: { 240: -1, 60: -1, 15: -1 } });
    const reads = [{ step: 'bias', skill: 'bos-vs-choch', read: '1h choch up' }, ...LC.READS.filter(x => x.step !== 'bias'),
      { step: 'setup', skill: 'rejection', read: rejection }];
    LC.writeScenario(home, { reads, b });
    return gate(orderPayload(LC.order()), setup([lcPlan], { FTH_HOME: home, FTH_TEST_NOW: LC_AT, CLAUDE_PLUGIN_ROOT: LC_ROOT, FTH_CYCLE_BARS: JSON.stringify({ MNQ: LC.BAR }) }).env);
  };
  // The gap edge's rejection is true (the record stands), but it is no 4h rejection of a level: the trend rule refuses.
  const gap = run('4h rejected 15m fvg low up');
  assert.strictEqual(gap.code, 2);
  assert.match(gap.stderr, /\[mtf-trend\]/);
  assert.doesNotMatch(gap.stderr, /\[composed-reads\]/);
  // A real 4h rejection of a key level with the 1h CHoCH: it goes.
  const level = run('4h rejected previous 4h low up');
  assert.strictEqual(level.code, 0, level.stderr);
  // An exit against the same trend always goes.
  const home = trendHome(tmpDir(), { biases: { 240: -1, 60: -1, 15: -1 } });
  const exit = gate(orderPayload({ ...EXIT_BASE, side: 'sell', type: 'stop', stopPrice: 21512.5, rationale: '[exit] flatten the composed long' }),
    setup([], { FTH_HOME: home, FTH_TEST_NOW: LC_AT, CLAUDE_PLUGIN_ROOT: LC_ROOT }).env);
  assert.strictEqual(exit.code, 0, exit.stderr);
});

test('MCP gateway wiring, replay: a trade_lifecycle entry on its record goes to the broker; a record for the other side or a false read never reaches it; an exit goes', async () => {
  const { spawn } = require('child_process');
  const run = async (prepare, messages, extra = {}) => {
    const dir = tmpDir();
    const home = path.join(dir, '.futures-trading-harness');
    fs.mkdirSync(home, { recursive: true });
    trendHome(home, { specs: false });
    fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, path.join(REPO, 'tests', 'fixtures', 'fake-mcp-server.js')], journal: writeJournal(dir, [lcPlan]), allowedAccountsEnv: 'SIM_ALLOWED_ACCOUNTS', replay: true } } }));
    prepare(home);
    const argsFile = path.join(dir, 'args.jsonl');
    const gw = spawn(process.execPath, [path.join(REPO, 'scripts', 'mcp-gateway.js')], { env: {
      PATH: process.env.PATH, HOME: dir, FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', NODE_ENV: 'test',
      SIM_ALLOWED_ACCOUNTS: '1,7', FAKE_ARGS: argsFile, FTH_REPLAY_NOW: LC_AT, FTH_CYCLE_BARS: JSON.stringify({ MNQ: LC.BAR }),
      FAKE_SERVER_CONFIG: JSON.stringify({ tradingEnabled: true, maxOrderSize: 5, serverTime: LC_AT, replay: true }),
      FAKE_CONTRACTS: JSON.stringify([{ id: 'sim-Z6', name: 'MNQZ6', tickSize: 0.25, tickValue: 0.5, activeContract: true }]), ...extra,
    } });
    let out = '';
    gw.stdout.on('data', c => { out += c; });
    const replies = () => out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    for (const m of messages) {
      gw.stdin.write(`${JSON.stringify(m)}\n`);
      for (let t = 0; t < 400 && !replies().some(r => r.id === m.id); t += 1) await new Promise(r => setTimeout(r, 25));
    }
    gw.stdin.end();
    await new Promise(r => gw.on('close', r));
    const texts = Object.fromEntries(replies().map(r => [r.id, r.result.content[0].text]));
    const sent = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(c => c.name === 'place_order') : [];
    return { texts, sent };
  };
  const msgs = input => [call(0, 'search_contracts', { searchText: 'MNQ' }), call(1, 'place_order', input)];
  // The record, every read true: the entry reaches the broker as the record says (a limit at 21540.25, 111 / 231 ticks).
  const ok = await run(home => LC.writeScenario(home), msgs(LC.order()));
  assert.strictEqual(ok.sent.length, 1, ok.texts[1]);
  assert.deepStrictEqual([ok.sent[0].args.type, ok.sent[0].args.limitPrice, ok.sent[0].args.stopLossBracket.ticks, ok.sent[0].args.takeProfitBracket.ticks], ['limit', 21540.25, 111, 231]);
  // Only a short record: refused, never sent.
  const other = await run(home => LC.writeScenario(home, { side: 'short' }), msgs(LC.order()));
  assert.deepStrictEqual(other.sent, []);
  assert.match(other.texts[1], /\[composed-reads\] setup:trade_lifecycle: the compose record for this bar is for a short/);
  // A false read now: the briefing on disk says the 1h trend is down, whatever the record says.
  const down = LC.briefing();
  down.sections.h1.data.h1.trend = 'down';
  const falseRead = await run(home => { LC.writeScenario(home); require('../../scripts/lib/trading/briefing').writeBriefing(home, down); }, msgs(LC.order()));
  assert.deepStrictEqual(falseRead.sent, []);
  assert.match(falseRead.texts[1], /\[composed-reads\] .*false by the briefing: "1h up"/);
  // An exit with no record and no briefing goes.
  const exit = await run(() => {}, msgs({ ...EXIT_BASE, side: 'sell', type: 'market', rationale: '[exit] flatten the composed long' }), { FAKE_POSITIONS: JSON.stringify([{ contractId: 'sim-Z6', type: 1, size: 1 }]) });
  assert.strictEqual(exit.sent.length, 1, exit.texts[1]);
});

test('order gate (hook): modify_order may not reprice a working trade_lifecycle entry worse than its record\'s entry; a better price and a stop move go', () => {
  const home = trendHome();
  fs.writeFileSync(path.join(home, 'entry-orders.json'), JSON.stringify([{ orderId: 21, contractId: 'MNQ', side: 'buy', setup: 'trade_lifecycle', composed: { record: 'r', expiresAt: LC.EXPIRES, entry: 21540.25, side: 'long' } }]));
  const { env } = setup([], { FTH_HOME: home });
  const modify = args => gate({ tool_name: 'mcp__broker__modify_order', tool_input: { accountId: 1, ...args } }, env);
  const worse = modify({ orderId: 21, limitPrice: 21542 });
  assert.strictEqual(worse.code, 2);
  assert.match(worse.stderr, /\[composed-reprice\]/);
  assert.strictEqual(modify({ orderId: 21, limitPrice: 21538 }).code, 0);
  assert.strictEqual(modify({ orderId: 22, stopPrice: 21500 }).code, 0);
});
