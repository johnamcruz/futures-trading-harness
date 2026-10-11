'use strict';

// The headless check's logic (scripts/lib/headless-check.js): the probe runs as the runner runs a
// cycle, and each harness's transcript says whether the harness tools, a role and the shell were reached.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const hc = require('../../scripts/lib/headless-check');
const { tmpDir } = require('../helpers');

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
  assert.ok(allowed.includes('mcp__harness'));
  assert.strictEqual(claude.cwd, path.join(ROOT, 'workspace'));
  assert.deepStrictEqual([claude.env.FTH_AUTONOMOUS, claude.env.FTH_ROOT, claude.env.FTH_BARS_DIR], ['1', ROOT, '/srv/fth/bars']);
  assert.deepStrictEqual(hc.probeCommand('codex', ROOT, env).argv.slice(0, 2), ['codex', 'exec']);
  assert.ok(hc.probeCommand('qwen', ROOT, env).argv.includes('--approval-mode'));
  // Paper mode, and the runner config's own settings (bar directory, model).
  const cfgRun = hc.probeCommand('claude', ROOT, env, { config: { harness: 'claude', dataDir: '/data/bars', model: 'm1', paper: false } });
  assert.deepStrictEqual([cfgRun.env.FTH_PAPER, cfgRun.env.FTH_BARS_DIR, cfgRun.argv.includes('m1')], ['1', '/data/bars', true]);
  const fake = hc.probeCommand('qwen', ROOT, env, { bin: '/x/fake.js' });
  assert.deepStrictEqual(fake.argv.slice(0, 3), [process.execPath, '/x/fake.js', '-p']);
  assert.deepStrictEqual(hc.probeCommand('claude', ROOT, env, { bin: '/x/claude2' }).argv.slice(0, 2), ['/x/claude2', '-p']);
  assert.throws(() => hc.probeCommand('cursor', ROOT, env), /unknown harness "cursor"/);
  // The broker narrowed to reading on every harness: no order tool, no journal write.
  const orderTools = ['place_order', 'modify_order', 'cancel_order', 'close_position', 'partial_close_position', 'journal_add'];
  assert.deepStrictEqual([...hc.PROBE_DENIED].sort(), [...orderTools].sort());
  assert.ok(!allowed.includes('mcp__broker'), 'Claude: not the whole broker server');
  assert.ok(allowed.includes('mcp__broker__get_account_snapshot') && allowed.includes('mcp__broker__get_bars'));
  assert.ok(!allowed.some(t => orderTools.some(o => t === `mcp__broker__${o}`)));
  const denied = claude.argv[claude.argv.indexOf('--disallowedTools') + 1].split(',');
  for (const o of orderTools) assert.ok(denied.includes(`mcp__broker__${o}`), `Claude denies ${o}`);
  const codex = hc.probeCommand('codex', ROOT, env).argv;
  assert.strictEqual(codex[codex.length - 2], `mcp_servers.broker.disabled_tools=${JSON.stringify(hc.PROBE_DENIED)}`);
  // The config's extra arguments can't re-widen it: the narrowing comes after them.
  const widen = { claude: ['--allowedTools', 'mcp__broker'], codex: ['-c', 'mcp_servers.broker.disabled_tools=[]'], qwen: ['--allowed-tools', 'mcp__broker__place_order'] };
  for (const [h, extraArgs] of Object.entries(widen)) {
    const a = hc.probeCommand(h, ROOT, env, { config: { harness: h, extraArgs } }).argv;
    const theirs = a.indexOf(h === 'qwen' ? extraArgs[0] : extraArgs[1]);
    assert.ok(theirs > 0, `${h}: the extra arguments are passed`);
    const ours = h === 'claude' ? a.lastIndexOf('--disallowedTools') : h === 'codex' ? a.lastIndexOf(`mcp_servers.broker.disabled_tools=${JSON.stringify(hc.PROBE_DENIED)}`) : a.lastIndexOf('--exclude-tools');
    assert.ok(ours > theirs, `${h}: the narrowing comes after the extra arguments`);
  }
  const lastDeny = cfgClaude => cfgClaude[cfgClaude.lastIndexOf('--disallowedTools') + 1].split(',');
  assert.deepStrictEqual(lastDeny(hc.probeCommand('claude', ROOT, env, { config: { harness: 'claude', extraArgs: widen.claude } }).argv), hc.PROBE_DENIED.map(o => `mcp__broker__${o}`));
  assert.strictEqual(codex[codex.length - 1], hc.probePrompt(), 'Codex: the prompt stays last');
  const qwenArgv = hc.probeCommand('qwen', ROOT, env).argv;
  assert.deepStrictEqual(qwenArgv.slice(qwenArgv.indexOf('--exclude-tools') + 1), hc.PROBE_DENIED.map(o => `mcp__broker__${o}`));
  // The runner's own runs are untouched (the probe narrows only its argv).
  const { buildCommand, validateConfig } = require('../../scripts/lib/autotrader');
  assert.ok(buildCommand(validateConfig({ harness: 'claude' }), 'P', ROOT, env)[buildCommand(validateConfig({ harness: 'claude' }), 'P', ROOT, env).indexOf('--allowedTools') + 1].split(',').includes('mcp__broker'));
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
  const failed = hc.runProbe({ harness: 'claude', root: ROOT, env: { PATH: '/bin', FTH_HOME: tmpDir() }, spawn: (cmd, args, opts) => { seen = { cmd, opts }; return { status: 2, stdout: '', stderr: 'boot\nError: not logged in\n' }; } });
  assert.strictEqual(failed.error, 'exit 2: Error: not logged in');
  assert.strictEqual(seen.cmd, 'claude');
  assert.strictEqual(seen.opts.env.FTH_AUTONOMOUS, '1');
});

test('analyze: Codex started-then-completed items, a first delegation elsewhere, and exact role names only', () => {
  const ev = (type, x) => JSON.stringify({ type, item: x });
  const text = [
    ev('item.started', { id: 'c1', type: 'command_execution', command: "bash -lc 'node -e 1'", exit_code: null, status: 'in_progress' }),
    ev('item.completed', { id: 'c1', type: 'command_execution', command: "bash -lc 'node -e 1'", exit_code: 0, status: 'completed' }),
    ev('item.started', { id: 'm1', type: 'mcp_tool_call', server: 'harness', tool: 'strategies_list', status: 'in_progress' }),
    ev('item.completed', { id: 'm1', type: 'mcp_tool_call', server: 'harness', tool: 'strategies_list', status: 'completed', result: {} }),
    ev('item.completed', { id: 'g1', type: 'collab_tool_call', tool: 'spawn_agent', arguments: JSON.stringify({ agent_type: 'general-purpose' }), status: 'completed' }),
    ev('item.completed', { id: 'g2', type: 'collab_tool_call', tool: 'spawn_agent', arguments: JSON.stringify({ agent_type: 'risk_manager' }), status: 'completed' }),
  ].join('\n');
  const a = hc.analyze(text);
  assert.strictEqual(a.shell, 'ran', 'the completed report counts, not the in-progress one');
  assert.strictEqual(a.tools.strategies_list, 'answered');
  assert.deepStrictEqual([a.subagent.role, a.subagent.harnessRole, a.subagent.ok], ['risk_manager', true, true]);
  for (const role of ['RISK_MANAGER', 'Risk-Manager', 'risk-manager2']) {
    assert.strictEqual(hc.analyze([use('1', 'Agent', { subagent_type: role }), res('1', 'ok')].join('\n')).subagent.harnessRole, false, role);
  }
  assert.strictEqual(hc.analyze([use('1', 'Agent', { subagent_type: 'futures-trading-harness:risk-manager' }), res('1', 'ok')].join('\n')).subagent.harnessRole, true);
  // A shell that ran on a second try is reported as ran.
  const twice = [use('1', 'Bash', { command: 'node -e 1' }), res('1', 'denied', true), use('2', 'Bash', { command: 'node -e 1' }), res('2', '')].join('\n');
  assert.strictEqual(hc.analyze(twice).shell, 'ran');
});

test('runProbe: Qwen without the runner\'s workspace allowlist stops and says so; nothing is written unless asked', () => {
  const root = tmpDir();
  let spawned = false;
  const r = hc.runProbe({ harness: 'qwen', root, env: { HOME: root, FTH_HOME: root }, spawn: () => { spawned = true; return { status: 0, stdout: '' }; } });
  assert.strictEqual(spawned, false);
  assert.match(r.error, /workspace\/\.qwen\/settings\.json is missing: start the runner once .* --write-qwen-allowlist \(with no runner trading/);
  assert.ok(!fs.existsSync(path.join(root, 'workspace', '.qwen')), 'not written');
  const { file, content } = hc.qwenAllowlist(hc.probeConfig('qwen'), root, { HOME: root, FTH_HOME: root });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.replace('mcp__harness', 'mcp__other'));
  assert.match(hc.runProbe({ harness: 'qwen', root, env: { HOME: root, FTH_HOME: root }, spawn: () => { spawned = true; return {}; } }).error, /not the allowlist the runner writes/);
  assert.strictEqual(spawned, false);
  // Another harness's model and extra arguments don't carry over; the shared settings do.
  const c = hc.probeConfig('codex', { harness: 'claude', model: 'claude-model', extraArgs: ['--x'], dataDir: '/data/bars' });
  assert.deepStrictEqual([c.model, c.extraArgs, c.dataDir, c.paper], [hc.probeConfig('codex').model, [], '/data/bars', true]);
  assert.strictEqual(hc.probeConfig('claude', { harness: 'claude', model: 'm' }).model, 'm');
  // A config with no harness key trades with the runner's default harness: its model and arguments are that one's.
  const { DEFAULTS } = require('../../scripts/lib/autotrader');
  assert.strictEqual(hc.configHarness({ model: 'm1' }), DEFAULTS.harness);
  assert.strictEqual(hc.configHarness({ harness: 'codex' }), 'codex');
  const d = hc.probeConfig(DEFAULTS.harness, { model: 'm1', extraArgs: ['--x'] });
  assert.deepStrictEqual([d.model, d.extraArgs], ['m1', ['--x']]);
});

test('runProbe: Qwen first gets the runner\'s workspace allowlist when asked, then the probe runs (stand-in CLI)', { timeout: 60000 }, () => {
  const home = tmpDir();
  const writes = [];
  const r = hc.runProbe({ harness: 'qwen', root: ROOT, env: { ...process.env, HOME: home, FTH_HOME: home, FTH_REPLAY_NOW: '' }, bin: path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js'), writeAllowlist: true, writeFile: (f, c) => writes.push([f, JSON.parse(c)]) });
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0][0], path.join(ROOT, 'workspace', '.qwen', 'settings.json'));
  assert.ok(writes[0][1].permissions.allow.includes('mcp__harness') && writes[0][1].permissions.allow.includes('Agent(risk-manager)'));
  assert.ok(!fs.existsSync(path.join(home, 'unused')));
  assert.strictEqual(hc.passed(r), true, JSON.stringify(r));
});

// A real Qwen Code 0.25 run (trimmed, anonymized): MCP tools deferred, reached through the tool_call
// bridge; the first bridge calls refused until tool_search reviewed the schema, then answered.
const QWEN_BRIDGE = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'qwen-bridge-transcript.json'), 'utf8');

test('analyze: Qwen tool_call bridge, refused then answered, counts as answered (the real transcript)', () => {
  const a = hc.analyze(QWEN_BRIDGE);
  assert.deepStrictEqual(a.tools, { blackouts_list: 'answered', strategies_list: 'answered' });
  // Everything else as before: the forked agent isn't the harness role, the shell was refused.
  assert.deepStrictEqual([a.subagent.role, a.subagent.harnessRole, a.subagent.ok], ['fork', false, false]);
  assert.match(a.shell, /^refused \(Qwen Code requires permission to use "run_shell_command"/);
  assert.match(hc.formatReport({ harness: 'qwen', analysis: a, error: null }).join('\n'), /harness tool blackouts_list: answered\n {2}harness tool strategies_list: answered/);
});

test('analyze: a bridge refusal alone is not an answer, is_error or not', () => {
  const doc = JSON.parse(QWEN_BRIDGE);
  // Up to the bridge's refusals only (the later, successful bridge calls dropped).
  const refusedOnly = doc.filter(m => !(m.message && m.message.content.some(c => ['call-7', 'call-8'].includes(c.id || c.tool_use_id))));
  assert.strictEqual(refusedOnly.length, doc.length - 3, "the successful bridge calls and their two results");
  assert.deepStrictEqual(hc.analyze(JSON.stringify(refusedOnly)).tools, { blackouts_list: 'errored', strategies_list: 'errored' });
  const quiet = [use('1', 'tool_call', { name: 'mcp__harness__blackouts_list', arguments: {} }),
    res('1', [{ type: 'text', text: '[tool_call bridge refused] Deferred tool "mcp__harness__blackouts_list" has no verified schema review.' }])].join('\n');
  assert.strictEqual(hc.analyze(quiet).tools.blackouts_list, 'errored', 'a refusal not flagged is_error, as content blocks');
  // A bridge call with no result yet.
  assert.strictEqual(hc.analyze(use('1', 'tool_call', { name: 'mcp__harness__blackouts_list' })).tools.blackouts_list, 'called (no result seen)');
});

test('analyze: bridge success, string input, and what the bridge names (not the bridge itself)', () => {
  const text = [use('1', 'tool_call', { name: 'mcp__harness__blackouts_list', arguments: {} }), res('1', '[]\n'),
    use('2', 'tool_call', JSON.stringify({ name: 'mcp__harness__strategies_list', arguments: { json: true } })), res('2', '[]')].join('\n');
  assert.deepStrictEqual(hc.analyze(text).tools, { blackouts_list: 'answered', strategies_list: 'answered' });
  for (const input of [{ name: 'mcp__other__blackouts_list' }, { tool: 'mcp__harness__blackouts_list' }, { name: '' }, 'not json', null]) {
    assert.strictEqual(hc.analyze([use('1', 'tool_call', input), res('1', '[]')].join('\n')).tools.blackouts_list, 'not called', JSON.stringify(input));
  }
  // An unknown wrapper isn't unwrapped; a direct call next to a bridge call still counts.
  assert.strictEqual(hc.analyze([use('1', 'call_tool', { name: 'mcp__harness__blackouts_list' }), res('1', '[]')].join('\n')).tools.blackouts_list, 'not called');
  const mixed = [use('1', 'tool_call', { name: 'mcp__harness__blackouts_list' }), res('1', '[tool_call bridge refused] Deferred tool', true),
    use('2', 'mcp__harness__blackouts_list'), res('2', '[]')].join('\n');
  assert.strictEqual(hc.analyze(mixed).tools.blackouts_list, 'answered');
  // A shell or a role reached through the bridge is still seen.
  const viaBridge = [use('1', 'tool_call', { name: 'run_shell_command', arguments: { command: 'node -e 1' } }), res('1', ''),
    use('2', 'tool_call', { name: 'agent', arguments: { subagent_type: 'risk-manager' } }), res('2', '[tool_call bridge refused] Deferred tool "agent"')].join('\n');
  const b = hc.analyze(viaBridge);
  assert.strictEqual(b.shell, 'ran');
  assert.deepStrictEqual([b.subagent.role, b.subagent.ok], ['risk-manager', false]);
  assert.deepStrictEqual(hc.BRIDGE_TOOLS.map(x => x.name), ['tool_call']);
  // A name the model wrote into the bridge counts only as the tool's exact name.
  assert.strictEqual(hc.analyze([use('1', 'tool_call', { name: 'mcp__x__harness__blackouts_list' }), res('1', 'Tool not found')].join('\n')).tools.blackouts_list, 'not called');
  // An id reused by a later call: the refusal stays the bridge call's, the later answer is the other call's.
  const reused = [use('call_0', 'tool_call', { name: 'mcp__harness__blackouts_list' }), res('call_0', '[tool_call bridge refused] Deferred tool', true),
    use('call_0', 'tool_search', { query: 'mcp__harness__blackouts_list' }), res('call_0', 'Reviewed 1 tool(s)')].join('\n');
  assert.strictEqual(hc.analyze(reused).tools.blackouts_list, 'errored');
  // A result for no call (or a null id) answers nothing.
  assert.strictEqual(hc.analyze([use(null, 'tool_call', { name: 'mcp__harness__blackouts_list' }), res(null, '[]')].join('\n')).tools.blackouts_list, 'called (no result seen)');
});

test('runProbe: the raw transcript is kept under FTH_HOME/logs and its path reported', () => {
  const home = tmpDir();
  const env = { PATH: '/bin', FTH_HOME: home };
  const now = () => new Date('2026-10-11T03:31:00.123Z');
  const r = hc.runProbe({ harness: 'claude', root: ROOT, env, now, spawn: () => ({ status: 1, stdout: QWEN_BRIDGE, stderr: 'Error: boom\n' }) });
  const file = path.join(home, 'logs', 'headless-claude-2026-10-11T03-31-00-123Z.json');
  assert.strictEqual(r.transcript, file);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), QWEN_BRIDGE);
  assert.strictEqual(fs.readFileSync(file.replace(/\.json$/, '.stderr.log'), 'utf8'), 'Error: boom\n');
  assert.ok(hc.formatReport(r).includes(`  transcript: ${file}`));
  // A run that timed out keeps what it printed; one that couldn't be kept says so and the check goes on.
  const timedOut = hc.runProbe({ harness: 'codex', root: ROOT, env, now, spawn: () => ({ error: Object.assign(new Error('spawnSync codex ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, stdout: 'partial', stderr: '' }) });
  assert.strictEqual(fs.readFileSync(timedOut.transcript, 'utf8'), 'partial');
  assert.ok(!fs.existsSync(timedOut.transcript.replace(/\.json$/, '.stderr.log')), 'no empty stderr file');
  const unsaved = hc.runProbe({ harness: 'claude', root: ROOT, env, now, saveFile: () => { throw new Error('EACCES'); }, spawn: () => ({ status: 0, stdout: '' }) });
  assert.match(hc.formatReport(unsaved).join('\n'), /transcript: not kept \(.*headless-claude-.*\.json: EACCES\)/);
  assert.ok(unsaved.analysis);
  // The transcript kept but not its stderr: still kept.
  const saved = [];
  const half = hc.runProbe({ harness: 'claude', root: ROOT, env, now, saveFile: f => { if (f.endsWith('.stderr.log')) throw new Error('EACCES'); saved.push(f); }, spawn: () => ({ status: 0, stdout: '', stderr: 'x' }) });
  assert.deepStrictEqual([half.transcript, saved], [file, [file]]);
  // A harness that isn't installed has no transcript.
  assert.strictEqual(hc.runProbe({ harness: 'codex', root: ROOT, env, spawn: () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }) }).transcript, undefined);
});
