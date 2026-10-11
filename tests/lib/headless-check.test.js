'use strict';

// The headless check's logic (scripts/lib/headless-check.js): the probe runs as the runner runs a
// cycle, and each harness's transcript says whether the harness tools, a role and the shell were reached.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const hc = require('../../scripts/lib/headless-check');

const ROOT = path.resolve(__dirname, '..', '..');

test('probe: the prompt asks for both tools, the harness role by name, and one shell attempt; no orders', () => {
  const p = hc.probePrompt();
  for (const s of ['blackouts_list', 'strategies_list', 'risk-manager', '`node -e 1`', 'Place no orders', hc.ROLE_REPLY, hc.MARKER]) assert.ok(p.includes(s), s);
});

test('probe: started exactly as the runner starts a cycle (argv, workspace, lock-down, bar directory)', () => {
  const env = { FTH_HOME: '/srv/fth', PATH: '/bin' };
  const claude = hc.probeCommand('claude', ROOT, env);
  assert.deepStrictEqual(claude.argv.slice(0, 2), ['claude', '-p']);
  const allowed = claude.argv[claude.argv.indexOf('--allowedTools') + 1].split(',');
  assert.ok(allowed.includes('mcp__harness') && allowed.includes('mcp__broker'));
  assert.strictEqual(claude.cwd, path.join(ROOT, 'workspace'));
  assert.deepStrictEqual([claude.env.FTH_AUTONOMOUS, claude.env.FTH_ROOT, claude.env.FTH_BARS_DIR], ['1', ROOT, '/srv/fth/bars']);
  assert.deepStrictEqual(hc.probeCommand('codex', ROOT, env).argv.slice(0, 2), ['codex', 'exec']);
  assert.ok(hc.probeCommand('qwen', ROOT, env).argv.includes('--approval-mode'));
  const fake = hc.probeCommand('qwen', ROOT, env, { bin: '/x/fake.js' });
  assert.deepStrictEqual(fake.argv.slice(0, 3), [process.execPath, '/x/fake.js', '-p']);
  assert.deepStrictEqual(hc.probeCommand('claude', ROOT, env, { bin: '/x/claude2' }).argv.slice(0, 2), ['/x/claude2', '-p']);
  assert.throws(() => hc.probeCommand('cursor', ROOT, env), /unknown harness "cursor"/);
});

const use = (id, name, input = {}) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, content, isError = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } });

test('analyze: a Claude stream-json transcript', () => {
  const text = [use('1', 'mcp__harness__blackouts_list'), res('1', '[]'), use('2', 'mcp__harness__strategies_list'), res('2', 'x', true),
    use('3', 'Agent', { subagent_type: 'risk-manager' }), res('3', 'PROBE-ROLE-OK'), use('4', 'Bash', { command: 'node -e 1' }), res('4', 'denied by the allowlist', true)].join('\n');
  const a = hc.analyze(text);
  assert.deepStrictEqual(a.tools, { blackouts_list: 'answered', strategies_list: 'errored' });
  assert.deepStrictEqual(a.subagent, { role: 'risk-manager', harnessRole: true, ok: true, replied: true, detail: '' });
  assert.strictEqual(a.shell, 'refused (denied by the allowlist)');
  assert.strictEqual(hc.passed({ analysis: a, error: null }), false, 'a tool that errored fails the check');
});

test('analyze: a Qwen JSON array; a generic or forked agent is not the harness role', () => {
  const text = JSON.stringify([JSON.parse(use('1', 'mcp__harness__blackouts_list')), JSON.parse(res('1', '[]')), JSON.parse(use('2', 'mcp__harness__strategies_list')), JSON.parse(res('2', 'ok')),
    JSON.parse(use('3', 'agent', { subagent_type: 'general-purpose' })), JSON.parse(res('3', 'done')), JSON.parse(use('4', 'run_shell_command', { command: 'node -e 1' })), JSON.parse(res('4', ''))]);
  const a = hc.analyze(text);
  assert.deepStrictEqual(a.tools, { blackouts_list: 'answered', strategies_list: 'answered' });
  assert.strictEqual(a.subagent.harnessRole, false);
  assert.strictEqual(a.shell, 'ran');
  const r = { harness: 'qwen', analysis: a, error: null };
  assert.strictEqual(hc.passed(r), false);
  assert.match(hc.formatReport(r).join('\n'), /qwen: NOT ok[\s\S]*subagent: general-purpose \(not the harness role risk-manager\)/);
});

test('analyze: Codex --json events (role names underscored), and an empty transcript', () => {
  const item = x => JSON.stringify({ type: 'item.completed', item: x });
  const text = [item({ type: 'mcp_tool_call', server: 'harness', tool: 'blackouts_list', status: 'completed', result: {} }),
    item({ type: 'mcp_tool_call', server: 'harness', tool: 'strategies_list', status: 'completed', result: {} }),
    item({ type: 'collab_agent_call', agent_type: 'risk_manager', status: 'completed' }),
    item({ type: 'command_execution', command: "bash -lc 'node -e 1'", exit_code: 1, status: 'failed', aggregated_output: 'sandbox' })].join('\n');
  const a = hc.analyze(text);
  assert.deepStrictEqual(a.tools, { blackouts_list: 'answered', strategies_list: 'answered' });
  assert.deepStrictEqual([a.subagent.role, a.subagent.harnessRole, a.subagent.ok], ['risk_manager', true, true]);
  assert.match(a.shell, /^refused \(sandbox\)/);
  assert.strictEqual(hc.passed({ analysis: a, error: null }), true);
  assert.strictEqual(hc.passed({ analysis: a, error: 'exit 1' }), false, 'a failed run fails the check');
  const none = hc.analyze('not json at all');
  assert.deepStrictEqual(none, { tools: { blackouts_list: 'not called', strategies_list: 'not called' }, subagent: null, shell: 'not attempted' });
  assert.strictEqual(hc.analyze([use('1', 'mcp__other__blackouts_list'), res('1', '[]')].join('\n')).tools.blackouts_list, 'not called', 'another server\'s tool of the same name');
});

test('runProbe: a harness that is not installed, or that fails, is reported', () => {
  const missing = hc.runProbe({ harness: 'codex', root: ROOT, env: { PATH: '/bin' }, spawn: () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }) });
  assert.strictEqual(missing.error, 'codex is not installed (not on PATH)');
  assert.deepStrictEqual(hc.formatReport(missing), ['codex: NOT ok (codex is not installed (not on PATH))']);
  let seen;
  const failed = hc.runProbe({ harness: 'claude', root: ROOT, env: { PATH: '/bin' }, spawn: (cmd, args, opts) => { seen = { cmd, opts }; return { status: 2, stdout: '', stderr: 'boot\nError: not logged in\n' }; } });
  assert.strictEqual(failed.error, 'exit 2: Error: not logged in');
  assert.strictEqual(seen.cmd, 'claude');
  assert.strictEqual(seen.opts.env.FTH_AUTONOMOUS, '1');
});
