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
      FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW,
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
});

test('market hours are a hard rule: no entry in the 16:00-18:00 ET break even with FTH_ENTRY_HOURS empty and the check skipped', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date('2026-10-07T21:00:00Z')), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }],
    { FTH_TEST_NOW: '2026-10-07T21:00:00Z', FTH_ORDER_GATE_SKIP: 'time-window,market-hours' });
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
    FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW,
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
    PROJECTX_JOURNAL_PATH: writeJournal(dir, []), FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW,
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
    FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW, ...extraEnv,
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
    PROJECTX_JOURNAL_PATH: writeJournal(dir, []), FTH_GATE_LOG: path.join(dir, 'gate.jsonl'), FTH_NO_ENTRY_WINDOWS: '', FTH_ENTRY_HOURS: '', FTH_TEST_NOW: TEST_NOW,
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
