'use strict';

// Stand-in for a harness CLI: echoes the prompt and a cycle result, or fails on demand.
// With FAKE_HARNESS_ORDERS=1 it also acts through the harness's order gateway, as an
// agent's broker tools do: an entry (which the gate refuses: no plan) and a close of MNQ.
const fs = require('fs');
const path = require('path');

const prompt = process.argv.slice(2).join(' ');
// FAKE_QWEN_SETTINGS_VERSION=N: as Qwen Code does on start, stamp the workspace settings file it loads
// (.qwen/settings.json in its working directory) with "$version": N when it has none, and write it back.
if (process.env.FAKE_QWEN_SETTINGS_VERSION) {
  const file = path.join(process.cwd(), '.qwen', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!('$version' in settings)) fs.writeFileSync(file, `${JSON.stringify({ ...settings, $version: Number(process.env.FAKE_QWEN_SETTINGS_VERSION) }, null, 2)}\n`);
  } catch (_err) {
    // no settings file: nothing to migrate
  }
}
// The headless probe prints only its transcript.
if (!prompt.includes('FTH-HEADLESS-PROBE')) process.stdout.write(`cwd=${process.cwd()} FTH_ROOT=${process.env.FTH_ROOT}\nFTH_CYCLE_BARS=${process.env.FTH_CYCLE_BARS || ''}\nprompt=${prompt}\n`);
if (prompt.includes('FAIL')) process.exit(3);

async function orders() {
  const root = process.env.FTH_ROOT;
  const { createMcpClient } = require(path.join(root, 'scripts', 'lib', 'broker', 'mcp-client'));
  const gw = createMcpClient({ command: process.execPath, args: [path.join(root, 'scripts', 'mcp-gateway.js')], env: process.env, cwd: root, timeoutMs: 20000 });
  const tryCall = async (tool, args) => {
    try {
      return `ok ${JSON.stringify(await gw.call(tool, args)).slice(0, 120)}`;
    } catch (err) {
      return `refused ${err.message.slice(0, 200)}`;
    }
  };
  try {
    const entry = await tryCall('place_order', { accountId: 7, contractId: 'MNQ', side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 20, type: 'stop' }, rationale: 'setup:orb long, stop 21495' });
    const close = await tryCall('close_position', { accountId: 7, contractId: 'MNQ', reason: '[exit] fake harness' });
    process.stdout.write(`entry: ${entry}\nclose: ${close}\n`);
  } finally {
    gw.close();
  }
}

/**
 * The headless check's probe (scripts/lib/headless-check.js): calls the real harness tools server
 * from FTH_ROOT with the run's environment, and prints a transcript in the format the argv asks for
 * (Claude stream-json, Codex --json events, Qwen JSON, opencode JSON events). FAKE_PROBE=no-role skips the delegation.
 */
async function probe(argv) {
  const root = process.env.FTH_ROOT;
  const { createMcpClient } = require(path.join(root, 'scripts', 'lib', 'broker', 'mcp-client'));
  const tools = createMcpClient({ command: process.execPath, args: [path.join(root, 'scripts', 'harness-tools-mcp.js')], env: process.env, timeoutMs: 20000 });
  const results = {};
  try {
    for (const t of ['blackouts_list', 'strategies_list']) results[t] = await tools.request('tools/call', { name: t, arguments: {} });
  } finally {
    tools.close();
  }
  const role = process.env.FAKE_PROBE !== 'no-role';
  const format = argv[0] === 'exec' ? 'codex' : argv[0] === 'run' ? 'opencode' : argv.includes('stream-json') ? 'claude' : 'qwen';
  if (format === 'opencode') {
    // As opencode 1.x prints with run --format json (tests/fixtures/opencode-probe-transcript.jsonl is a real one).
    // The run's own config must deny the order tools (the probe's read-only broker), or there is no run.
    const run = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
    if (!run.permission || run.permission.broker_place_order !== 'deny' || run.agent['trade-executor'].permission.broker_place_order !== 'deny') throw new Error('order tools not denied');
    const ev = (type, part) => process.stdout.write(`${JSON.stringify({ type, timestamp: Date.now(), sessionID: 'ses_fake', part: { sessionID: 'ses_fake', ...part } })}\n`);
    const call = (tool, input, done) => ev('tool_use', { type: 'tool', tool, callID: tool, state: { input, ...done } });
    ev('step_start', { type: 'step-start' });
    for (const [t, r] of Object.entries(results)) call(`harness_${t}`, {}, r.isError ? { status: 'error', error: JSON.stringify(r.content) } : { status: 'completed', output: r.content.map(c => c.text).join('\n') });
    if (role) call('task', { description: 'probe', prompt: 'Reply exactly PROBE-ROLE-OK', subagent_type: 'risk-manager' }, { status: 'completed', output: '<task_result>\nPROBE-ROLE-OK\n</task_result>' });
    call('bash', { command: 'node -e 1' }, { status: 'error', error: "Model tried to call unavailable tool 'invalid'." });
    ev('text', { type: 'text', text: 'PROBE DONE', time: { start: 1, end: 2 } });
    return;
  }
  if (format === 'codex') {
    const item = x => process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: x })}\n`);
    for (const [t, r] of Object.entries(results)) item({ type: 'mcp_tool_call', server: 'harness', tool: t, status: r.isError ? 'failed' : 'completed', result: r });
    if (role) item({ type: 'collab_agent_call', tool: 'spawn_agent', agent_type: 'risk_manager', status: 'completed' });
    item({ type: 'command_execution', command: "bash -lc 'node -e 1'", aggregated_output: '', exit_code: 0, status: 'completed' });
    return;
  }
  const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id, r, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: r }] } });
  const events = [{ type: 'system', subtype: 'init' }];
  Object.entries(results).forEach(([t, r], i) => events.push(use(`t${i}`, `mcp__harness__${t}`, {}), res(`t${i}`, r.content, Boolean(r.isError))));
  if (role) events.push(use('a1', format === 'claude' ? 'Agent' : 'agent', { subagent_type: 'risk-manager', prompt: 'Reply exactly PROBE-ROLE-OK' }), res('a1', 'PROBE-ROLE-OK'));
  events.push(use('s1', format === 'claude' ? 'Bash' : 'run_shell_command', { command: 'node -e 1' }), res('s1', 'Permission to use this tool has been denied.', true));
  events.push({ type: 'result', result: 'PROBE DONE' });
  if (format === 'claude') events.forEach(e => process.stdout.write(`${JSON.stringify(e)}\n`));
  else process.stdout.write(`${JSON.stringify(events)}\n`);
}

if (prompt.includes('FTH-HEADLESS-PROBE')) {
  probe(process.argv.slice(2)).catch(err => {
    process.stderr.write(`fake harness probe: ${err.message}\n`);
    process.exit(5);
  });
} else {
  (process.env.FAKE_HARNESS_ORDERS === '1' ? orders() : Promise.resolve()).then(() => {
    // FAKE_HARNESS_NO_RESULT=<text>: a prompt with that text gets a summary instead of the result line.
    const noResult = process.env.FAKE_HARNESS_NO_RESULT && prompt.includes(process.env.FAKE_HARNESS_NO_RESULT);
    process.stdout.write(noResult ? '**Cycle Complete:** Decision: NO TRADE (stand aside)\n' : 'CYCLE RESULT: no-trade - fake harness\n');
  }, err => {
    process.stdout.write(`fake harness: ${err.message}\n`);
    process.exit(4);
  });
}
