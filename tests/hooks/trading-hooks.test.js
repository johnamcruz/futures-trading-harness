'use strict';

// Integration tests: run hooks through run-with-flags.js exactly as hooks.json does.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, trendHome, writeJournal, minutesAgo, placed, entryOrder } = require('../helpers');

// The gate's clock for these end-to-end runs: a Wednesday at 10:30 ET, inside
// market hours whenever the tests run (FTH_TEST_NOW is ignored in autonomous runs).
const TEST_NOW = '2026-10-07T14:30:00.000Z';

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
  const prop = path.join(root, 'strategies', 'propped');
  fs.mkdirSync(prop, { recursive: true });
  fs.writeFileSync(path.join(prop, 'STRATEGY.md'), [
    '---', 'name: propped', 'description: Test policy strategy that trades the topstep_50k combine in MNQ micros, any time.',
    'status: active', 'instruments: [MNQ, NQ]', 'timeframe: 3m', 'signal: policy', 'strategies: [crossing]', 'account: topstep_50k', 'contracts: micro',
    'exit:', '  trail_activate_r: 2', '  trail_giveback_r: 0.5', 'risk:', '  stop: strategy', '  min_rr: 2', '---',
    '## When to Use', '## How It Works', '## Examples', '',
  ].join('\n'));
  const rules = path.join(root, 'strategies', 'crossing');
  fs.mkdirSync(rules, { recursive: true });
  fs.writeFileSync(path.join(rules, 'STRATEGY.md'), [
    '---', 'name: crossing', 'description: Test rules strategy, an EMA cross on MNQ, traded only through the propped policy strategy.',
    'status: active', 'instruments: [MNQ]', 'timeframe: 3m', 'signal: rules', 'rules:', '  long:', '    - ema(9) crosses_above ema(20)',
    'risk:', '  stop: atr:0.5', '  min_rr: 2', '---', '## When to Use', '## How It Works', '## Examples', '',
  ].join('\n'));
  return root;
})();
const ORDER = entryOrder({ rationale: 'setup:anytime long, stop 21480, target 21540, risk $40' });
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
      PROJECTX_JOURNAL_PATH: writeJournal(dir, entries),
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
  const raw = { ts: at(30), kind: 'order_placed', contractId: 'CON.F.US.MNQ.Z26', text: 'setup:anytime long, stop 21480', data: { result: { success: true } } };
  const { env } = setup([raw, { ts: at(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const r = gate(orderPayload(), env);
  assert.strictEqual(r.code, 2, 'no translator cache in this home: the id may be MNQ, so it counts');
  assert.match(r.stderr, /\[review-before-next-entry\]/);
  const reviewed = setup([raw, { ts: at(10), kind: 'review', contractId: raw.contractId, text: 'closed', tags: ['result:win'] },
    { ts: at(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  assert.strictEqual(gate(orderPayload(), reviewed.env).code, 0, 'reviewed under the id journal_read shows: cleared');
  // With the translator's lookup on file, it counts as MNQ (and still needs the review); on another root it wouldn't.
  fs.writeFileSync(path.join(env.FTH_HOME, 'contracts-topstepx.json'), JSON.stringify({ ids: { 'CON.F.US.MNQ.Z26': { root: 'MES', month: '2026-12' } }, front: {} }));
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
  const { env } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const r = gate(orderPayload(entryOrder({ rationale: 'long setup:orb, stop 21480' })), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[setup-tag\] Rationale must start with the strategy as setup:<name>/);
});

test('order gate: an order that contradicts its rationale is refused with what disagrees', () => {
  const { env } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
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

test('order gate: with a Claude transcript, an entry needs the trading skills loaded in the session', () => {
  const { env, dir } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const skill = name => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: name } }] } });
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, skill('trade-session'));
  const r = gate({ ...orderPayload(), transcript_path: transcript }, env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[skills-loaded\] Load the trading skills before an entry; not loaded in this session: multi-timeframe-analysis, strategy-library/);
  fs.writeFileSync(transcript, ['trade-session', 'multi-timeframe-analysis', 'strategy-library'].map(skill).join('\n'));
  const ok = gate({ ...orderPayload(), transcript_path: transcript }, env);
  assert.strictEqual(ok.code, 0, ok.stderr);
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

test('order gate fails closed on malformed input', () => {
  const { env } = setup([]);
  const r = gate('{not json', env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /could not run/);
});

test('order gate fails closed when the journal is unreadable', () => {
  const { dir, env } = setup([]);
  const r = gate(orderPayload(), { ...env, PROJECTX_JOURNAL_PATH: dir });
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
    PROJECTX_JOURNAL_PATH: writeJournal(dir, []),
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
    PROJECTX_JOURNAL_PATH: writeJournal(dir, []), FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
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
      PROJECTX_JOURNAL_PATH: writeJournal(dir, []), FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
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
  fs.writeFileSync(path.join(dir, 'brokers.json'), JSON.stringify({ broker: 'fake', brokers: { fake: { command: [process.execPath, path.join(REPO, 'tests', 'fixtures', 'fake-mcp-server.js')] } } }));
  const env = {
    PATH: process.env.PATH, HOME: dir, FTH_HOME: dir, PROJECTX_JOURNAL_PATH: writeJournal(dir, []),
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
    call(5, 'close_position', { accountId: 7, contractId: 'CON.F.US.MNQ.Z26' }),
  ].join('\n')}\n`);
  await new Promise(r => setTimeout(r, 2500));
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
  assert.strictEqual(placed.args.contractId, 'CON.F.US.MNQ.Z26');
  assert.ok(!seen.some(c => c.args && c.args.contractId === 'MNQ'), 'no standard name reached the server');
  assert.ok(seen.some(c => c.name === 'close_position' && c.args.contractId === 'CON.F.US.MNQ.Z26'), 'a broker id still closes: it goes through as is');
  assert.ok(!byId[5].result.isError, byId[5].result.content && byId[5].result.content[0].text);
});

async function gatewayRun(extraEnv, messages, { gapMs = 0, dir = tmpDir() } = {}) {
  const { spawn } = require('child_process');
  const env = {
    PATH: process.env.PATH, HOME: dir, PROJECTX_JOURNAL_PATH: writeJournal(dir, []),
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
  const { byId } = await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_ARGS: argsFile }, [
    call(2, 'place_order', { ...ORDER, customTag: 'orb-1' }),
    // An exit reusing it still goes, under a fresh tag, so the first order's record survives.
    call(3, 'place_order', { ...EXIT_BASE, side: 'sell', type: 'limit', limitPrice: 21600, rationale: '[exit] target', customTag: 'orb-1' }),
  ], { dir });
  assert.match(byId[2].result.content[0].text, /\[order-pending\]/);
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
    PROJECTX_JOURNAL_PATH: writeJournal(dir, []), FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
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
    PROJECTX_JOURNAL_PATH: writeJournal(dir, []), FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
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
    const { env } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: order.contractId, text: 'plan' }], { FTH_HOME: tmpDir(), FTH_ACCOUNTS_DIRS: path.join(REPO, 'accounts') });
    prop.startAttempt(env.FTH_HOME, account, new Date('2026-10-02T14:00:00Z'));
    for (const [day, close] of days) prop.recordEndOfDay(env.FTH_HOME, account, close, day);
    prop.snapshot(env.FTH_HOME, account, 53100, new Date(Date.parse(TEST_NOW) - 60000));
    prop.appendVerdict(env.FTH_HOME, {
      strategy: 'propped', component: 'crossing', contractId: order.contractId, contract: 'MNQ', direction: 'long', action: 'full', stopTicks: 40, maxSize: 19,
      policy: null, at: new Date(Date.parse(TEST_NOW) - 60000).toISOString(), expiresAt: new Date(Date.parse(TEST_NOW) + 120000).toISOString(),
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
  const { env } = setup([{ ts: minutesAgo(5), kind: 'plan', contractId: order.contractId, text: 'plan' }], { FTH_HOME: tmpDir(), FTH_ACCOUNTS_DIRS: path.join(REPO, 'accounts') });
  prop.startAttempt(env.FTH_HOME, account, new Date('2026-08-01T14:00:00Z'));
  for (let d = 0; d < 32; d += 1) {
    const day = new Date(Date.UTC(2026, 7, 3) + d * 86400000).toISOString().slice(0, 10);
    prop.recordEndOfDay(env.FTH_HOME, account, 50000 + 10 * (d + 1), day);
  }
  prop.snapshot(env.FTH_HOME, account, 50320, new Date(Date.parse(TEST_NOW) - 60000));
  prop.appendVerdict(env.FTH_HOME, {
    strategy: 'propped', component: 'crossing', contractId: order.contractId, contract: 'MNQ', direction: 'long', action: 'full', stopTicks: 40, maxSize: 19,
    policy: null, at: new Date(Date.parse(TEST_NOW) - 60000).toISOString(), expiresAt: new Date(Date.parse(TEST_NOW) + 120000).toISOString(),
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
    FTH_HOME: tmpDir(), FTH_ACCOUNTS_DIRS: path.join(REPO, 'accounts'), FTH_ORDER_GATE_SKIP: 'combine,policy',
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
    strategy: 'propped', component: 'crossing', contractId: order.contractId, contract: 'MNQ', direction: 'long', action: 'full', stopTicks: 40, maxSize: 19,
    policy: null, at: new Date(Date.parse(TEST_NOW) - 60000).toISOString(), expiresAt: new Date(Date.parse(TEST_NOW) + 120000).toISOString(),
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
  // 0.2 x $2,000 cushion = $400; 40 ticks = $20.74 a contract: at most 19.
  r = gate(orderPayload({ ...order, size: 20 }), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /20 MNQ is not within the account's size budget/);
  assert.ok(fs.existsSync(dir));
});

test('order gate hook: an entry on another market since the account snapshot holds a prop entry, even with the checks skipped', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const order = entryOrder({ rationale: 'setup:propped long, stop 21480, target 21540', size: 2 });
  const journal = extra => [{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: order.contractId, text: 'plan' }, ...extra];
  const base = setup(journal([]), { FTH_HOME: tmpDir(), FTH_ACCOUNTS_DIRS: path.join(REPO, 'accounts'), FTH_ORDER_GATE_SKIP: 'combine,policy' });
  const account = accountNamed(REPO, 'topstep_50k', {});
  prop.startAttempt(base.env.FTH_HOME, account);
  prop.snapshot(base.env.FTH_HOME, account, 50000, new Date(Date.parse(TEST_NOW) - 90000));
  prop.appendVerdict(base.env.FTH_HOME, {
    strategy: 'propped', component: 'crossing', contractId: order.contractId, contract: 'MNQ', direction: 'long', action: 'full', stopTicks: 40, maxSize: 19,
    policy: null, at: new Date(Date.parse(TEST_NOW) - 30000).toISOString(), expiresAt: new Date(Date.parse(TEST_NOW) + 120000).toISOString(),
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
    PROJECTX_JOURNAL_PATH: writeJournal(dir, []),
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
    PROJECTX_JOURNAL_PATH: writeJournal(dir, []),
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

/** brokers.json in `home` selecting "sim" (journal: the test's), a replay broker or not. */
function simBroker(home, journal, { replay = true } = {}) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'sim.js'], journal, ...(replay ? { replay: true } : {}) } } }));
}

test('order gate hook: with a replay broker it judges the order at FTH_REPLAY_NOW, not the wall clock', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  simBroker(env.FTH_HOME, env.PROJECTX_JOURNAL_PATH);
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
    assert.match(r.stderr, /\[replay-clock\] FTH_REPLAY_NOW is set but the selected broker "topstepx" is not a replay broker/);
    assert.match(r.stderr, /close_position still go/);
    for (const payload of [exit, protect, modify]) {
      const ok = gate(payload, { ...env, ...extra });
      assert.strictEqual(ok.code, 0, `${payload.tool_name} ${JSON.stringify(extra)}: ${ok.stderr}`);
    }
  }
  simBroker(env.FTH_HOME, env.PROJECTX_JOURNAL_PATH);
  const garbage = gate(orderPayload(), { ...env, FTH_REPLAY_NOW: 'now' });
  assert.strictEqual(garbage.code, 2);
  assert.match(garbage.stderr, /\[replay-clock\] FTH_REPLAY_NOW "now" is not an ISO 8601 UTC time/);
  // A replay broker that reads a shipped live broker's credentials is refused too (the hook can't ask the server).
  fs.writeFileSync(path.join(env.FTH_HOME, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'sim.js'], journal: env.PROJECTX_JOURNAL_PATH, replay: true, env: ['PROJECTX_USERNAME', 'PROJECTX_API_KEY'] } } }));
  const twin = gate(orderPayload(), { ...env, FTH_REPLAY_NOW: TEST_NOW });
  assert.strictEqual(twin.code, 2);
  assert.match(twin.stderr, /\[replay-clock\] .*"sim" looks live: it reads the live broker "topstepx"'s variables \(PROJECTX_USERNAME, PROJECTX_API_KEY\)/);
  const log = fs.readFileSync(env.FTH_GATE_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(log.some(e => e.decision === 'blocked' && e.violations.some(v => v.check === 'replay-clock')), 'logged');
});

test('session-start and stop hooks read the trading day at the replayed time with a replay broker; a refused clock is said', () => {
  const replay = '2026-03-04T15:00:00.000Z'; // Wednesday 10:00 ET
  const { env } = setup([{ ts: '2026-03-04T14:50:00.000Z', kind: 'order_placed', contractId: 'MNQ', text: 'setup:anytime long, stop 21480', data: { result: { success: true } } }]);
  simBroker(env.FTH_HOME, env.PROJECTX_JOURNAL_PATH);
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
const serverSays = (serverTime, replay = true) => JSON.stringify({ tradingEnabled: true, serverTime, ...(replay ? { replay: true } : {}) });

/** A harness home under `dir` whose broker "sim" runs the fake server; returns its brokers.json path. */
function simHome(dir, { replay = true, journalEntries = [] } = {}) {
  const home = path.join(dir, '.futures-trading-harness');
  fs.mkdirSync(path.join(dir, 'sim'), { recursive: true });
  const journal = writeJournal(path.join(dir, 'sim'), journalEntries);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'brokers.json');
  fs.writeFileSync(file, JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, FAKE_MCP], journal, ...(replay ? { replay: true } : {}) } } }));
  return { home, file, journal };
}

/** The gateway as registered (no server command: the configured broker). Items: messages, or functions run between them. */
async function gatewayCfg(extraEnv, items, { dir }) {
  const { spawn } = require('child_process');
  const env = {
    PATH: process.env.PATH, HOME: dir, FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '',
    FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test', FAKE_CONTRACTS: CONTRACTS, ...extraEnv,
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
  }, [call(1, 'place_order', ORDER)], { dir });
  assert.match(textOf(byId[1]), /"orderId":\s*5/, textOf(byId[1]));
  const entries = JSON.parse(fs.readFileSync(path.join(home, 'entry-orders.json'), 'utf8'));
  assert.deepStrictEqual(entries.map(e => [e.orderId, e.at]), [[5, TEST_NOW]]);
});
