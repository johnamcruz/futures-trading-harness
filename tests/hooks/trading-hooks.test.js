'use strict';

// Integration tests: run hooks through run-with-flags.js exactly as hooks.json does.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, writeJournal, minutesAgo, placed, entryOrder } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(ROOT, 'scripts', 'hooks', 'run-with-flags.js');

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
      FTH_NO_ENTRY_WINDOWS: '',
      ...extraEnv,
    },
  };
}

const orderPayload = (input = entryOrder()) => ({ tool_name: 'mcp__projectx__place_order', tool_input: input });

test('order gate blocks an unplanned entry with exit code 2', () => {
  const { env } = setup([]);
  const r = gate(orderPayload(), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\[plan-required\]/);
});

test('order gate allows a planned entry', () => {
  const { env } = setup([{ ts: minutesAgo(5, new Date()), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const r = gate(orderPayload(), env);
  assert.strictEqual(r.code, 0, r.stderr);
});

test('order gate ignores other tools and plugin-scoped tool names still match', () => {
  const { env } = setup([]);
  assert.strictEqual(gate({ tool_name: 'mcp__projectx__get_bars', tool_input: {} }, env).code, 0);
  assert.strictEqual(gate({ tool_name: 'mcp__plugin_fth_projectx__place_order', tool_input: entryOrder() }, env).code, 2);
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
  const r = gate(orderPayload(entryOrder({ rationale: `setup:orb ${'x'.repeat(5000)}` })), { ...env, FTH_HOOK_INPUT_MAX_BYTES: '1000' });
  assert.strictEqual(r.code, 2);
});

test('order gate honours an explicit disable', () => {
  const { env } = setup([]);
  assert.strictEqual(gate(orderPayload(), { ...env, FTH_DISABLED_HOOKS: 'pre:trading:order-gate' }).code, 0);
});

test('order gate reads the blackout file', () => {
  const { dir, env } = setup([{ ts: minutesAgo(5, new Date()), kind: 'plan', contractId: entryOrder().contractId, text: 'plan' }]);
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'blackouts.json'), JSON.stringify([
    { start: new Date(now - 60000).toISOString(), end: new Date(now + 600000).toISOString(), reason: 'FOMC' },
  ]));
  const r = gate(orderPayload(), env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /FOMC/);
});

test('session-start briefing lists lessons and day state', () => {
  const { env } = setup([
    { ts: minutesAgo(60 * 24 * 3, new Date()), kind: 'lesson', text: 'Skip ORB before 09:45 ET', tags: ['setup:orb'] },
    { ts: minutesAgo(1, new Date()), kind: 'note', text: 'n' },
  ]);
  const r = runHook('session-start:trading:briefing', 'scripts/hooks/trading-session-start.js', 'minimal,standard,strict', {}, env);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Trading harness briefing/);
  assert.match(r.stdout, /Skip ORB before 09:45 ET \[setup:orb\]/);
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
