'use strict';

// Integration tests: run hooks through run-with-flags.js exactly as hooks.json does.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, writeJournal, minutesAgo, placed, entryOrder } = require('../helpers');

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
  return {
    dir,
    env: {
      PROJECTX_JOURNAL_PATH: writeJournal(dir, entries),
      FTH_BLACKOUTS_FILE: path.join(dir, 'blackouts.json'),
      FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, NODE_ENV: 'test',
      FTH_KILL_SWITCH_FILE: path.join(dir, 'STOP'),
      FTH_GATE_LOG: path.join(dir, 'gate.jsonl'),
      ...extraEnv,
    },
  };
}

const orderPayload = (input = ORDER) => ({ tool_name: 'mcp__projectx__place_order', tool_input: input });

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

test('order gate ignores other tools and plugin-scoped tool names still match', () => {
  const { env } = setup([]);
  assert.strictEqual(gate({ tool_name: 'mcp__projectx__get_bars', tool_input: {} }, env).code, 0);
  assert.strictEqual(gate({ tool_name: 'mcp__plugin_fth_projectx__place_order', tool_input: ORDER }, env).code, 2);
});

test('order gate blocks unknown strategies and instruments the strategy does not trade', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date(TEST_NOW)), kind: 'plan', contractId: 'CON.F.US.MES.Z26', text: 'plan' }]);
  const unknown = gate(orderPayload({ ...ORDER, rationale: 'setup:nosuch long, stop 1' }), env);
  assert.strictEqual(unknown.code, 2);
  assert.match(unknown.stderr, /\[strategy\] setup:nosuch is not a known strategy/);
  const mes = gate(orderPayload({ ...ORDER, contractId: 'CON.F.US.MES.Z26' }), env);
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
  prop.snapshot(home, account, 101250, new Date());
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
  prop.snapshot(old, account, 99000, new Date(Date.now() - 3 * 3600000));
  const b = runHook('session-start:trading:briefing', 'scripts/hooks/trading-session-start.js', 'minimal,standard,strict', {}, setup([], { FTH_HOME: old }).env);
  assert.match(b.stdout, /- topstep_100k \(active\) as of .* \(180 min ago\): balance \$99,000, .*profit -\$1,000 of \$6,000.*; entries blocked: the topstep_100k account snapshot is missing or older than 10 minutes/);
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
  const now = new Date();
  const { env } = setup([placed(1, 'setup:orb long stop 1', true)].map(e => ({ ...e, ts: new Date(now.getTime() - 60000).toISOString() })));
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
    FAKE_POSITIONS: JSON.stringify([{ contractId: 'CON.F.US.MNQ.Z26', type: 1, size: 1 }]),
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

async function gatewayRun(extraEnv, messages, { gapMs = 0 } = {}) {
  const { spawn } = require('child_process');
  const dir = tmpDir();
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
  const all = out.trim().split('\n').map(l => JSON.parse(l));
  return { byId: Object.fromEntries(all.map(r => [r.id, r])), all, dir };
}

const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const LONG1 = JSON.stringify([{ contractId: 'CON.F.US.MNQ.Z26', type: 1, size: 1 }]);

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

test('MCP gateway: no order calls while an earlier one has gone unanswered', async () => {
  const { byId } = await gatewayRun({ FAKE_POSITIONS: LONG1, FAKE_DELAY_MS: '1500', FTH_LANE_TIMEOUT_MS: '300' }, [
    call(1, 'place_order', { ...EXIT_BASE, side: 'sell', type: 'limit', limitPrice: 21600, rationale: '[exit] target' }),
    call(2, 'place_order', { ...EXIT_BASE, side: 'sell', rationale: '[exit] flatten' }),
  ]);
  assert.strictEqual(byId[1].result.content[0].text, 'forwarded:tools/call:place_order');
  assert.match(byId[2].result.content[0].text, /\[order-pending\]/);
});

test('MCP gateway: a protective stop can be tightened but not widened', async () => {
  const stop = JSON.stringify([{ id: 9, contractId: 'CON.F.US.MNQ.Z26', side: 1, type: 4, size: 1, stopPrice: 21480 }]);
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
  gw.stdin.write(`${JSON.stringify(call(1, 'close_position', { accountId: 1, contractId: 'CON.F.US.MNQ.Z26' }))}\n`);
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

test('MCP gateway: while a prop attempt runs, no entry while any position is open on the account', async () => {
  const { spawn } = require('child_process');
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const dir = tmpDir();
  const home = tmpDir();
  prop.startAttempt(home, accountNamed(REPO, 'topstep_50k', {}));
  const env = {
    PATH: process.env.PATH, HOME: dir, FTH_HOME: home,
    FAKE_POSITIONS: JSON.stringify([{ contractId: 'CON.F.US.MES.Z26', type: 1, size: 1 }]),
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
  assert.match(r.result.content[0].text, /\[prop-one-position\] A topstep_50k attempt trades one position at a time: CON.F.US.MES.Z26 is open/);
});
