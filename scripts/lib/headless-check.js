'use strict';

/**
 * The headless check (scripts/check-headless.js): one real headless run per
 * harness, as the autonomous runner starts it (autotrader.js buildCommand and
 * childEnv: the same argv, allowlist, workspace and lock-down), with a probe
 * prompt that calls two harness tools, delegates once to a harness role by
 * name, and tries a shell command. The run's transcript (Claude stream-json,
 * Codex --json events, Qwen JSON) says what each step reached:
 *
 *   harness tools  blackouts_list and strategies_list: answered, errored, or not called
 *   subagent       the role delegated to, and whether it answered
 *   shell          `node -e 1`: ran, refused, or not attempted
 *
 * It places no orders and changes nothing (the probe says so, and the order
 * gate and the allowlists hold as in any autonomous run).
 *
 *   probePrompt()                                   the prompt
 *   probeCommand(harness, root, env, { bin })       { argv, cwd, env } as the runner runs it
 *   analyze(text)                                   { tools, subagent, shell }
 *   runProbe({ harness, root, env, bin, timeoutMs, spawn })  { harness, status, error, analysis }
 *   formatReport(result)                            text lines
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { validateConfig, buildCommand, childEnv } = require('./autotrader');

const MARKER = 'FTH-HEADLESS-PROBE';
const PROBE_TOOLS = ['blackouts_list', 'strategies_list'];
const PROBE_ROLE = 'risk-manager';
const PROBE_SHELL = 'node -e 1';
const ROLE_REPLY = 'PROBE-ROLE-OK';
const HARNESSES = ['claude', 'codex', 'qwen'];

function probePrompt() {
  return [
    `${MARKER}: a harness self-check. Place no orders, change nothing, and load no trading skill.`,
    `1) Call the harness MCP tools ${PROBE_TOOLS.join(' and ')} (no arguments) and note whether each answered.`,
    `2) Delegate once to the harness role ${PROBE_ROLE}, by that agent name, with the task: "Reply exactly ${ROLE_REPLY} and nothing else; call no tools."`,
    `3) Try once to run the shell command \`${PROBE_SHELL}\` and note whether it ran or was refused. Do not retry anything refused.`,
    'End with one line: PROBE DONE, then what each step did.',
  ].join('\n');
}

/** argv, working directory and environment of the probe, exactly as the runner would start a cycle. */
function probeCommand(harness, root, env = process.env, { bin = null } = {}) {
  if (!HARNESSES.includes(harness)) throw new Error(`unknown harness "${harness}" (${HARNESSES.join(', ')})`);
  const cfg = validateConfig({ harness });
  const argv = buildCommand(cfg, probePrompt(), root, env);
  // A stand-in for the harness CLI (tests): its path replaces the program, node runs a .js one.
  if (bin) argv.splice(0, 1, ...(/\.[cm]?js$/.test(bin) ? [process.execPath, bin] : [bin]));
  return { argv, cwd: path.resolve(root, cfg.workdir), env: childEnv(cfg, root, env) };
}

/** Every JSON value in a transcript: one document (Qwen's JSON array), or one per line (stream-json, Codex events). */
function documents(text) {
  const s = String(text || '').trim();
  try {
    return [JSON.parse(s)];
  } catch (_err) {
    return s.split('\n').map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(v => v !== null);
  }
}

const SHELL_TOOLS = new Set(['Bash', 'run_shell_command', 'shell', 'exec_command', 'local_shell']);
const AGENT_TOOLS = new Set(['Agent', 'Task', 'agent', 'task', 'spawn_agent']);
const roleOf = input => (input && typeof input === 'object' ? String(input.subagent_type || input.agent_type || input.agent || input.role || '') : '');
const textOf = v => (typeof v === 'string' ? v : JSON.stringify(v === undefined ? '' : v));
const normRole = r => String(r).toLowerCase().replace(/_/g, '-');

/** What the probe reached, from a transcript. */
function analyze(text) {
  const calls = [];
  const results = new Map();
  const walk = (v, depth) => {
    if (depth > 40 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (v.type === 'tool_use' && typeof v.name === 'string') calls.push({ id: v.id, name: v.name, input: v.input || {} });
    else if (v.type === 'tool_result' && v.tool_use_id !== undefined) results.set(v.tool_use_id, { isError: v.is_error === true, text: textOf(v.content) });
    else if (v.type === 'mcp_tool_call') calls.push({ name: `mcp__${v.server}__${v.tool}`, input: v.arguments || {}, done: { isError: v.status !== 'completed' || Boolean(v.error), text: textOf(v.error || v.result) } });
    else if (v.type === 'command_execution') calls.push({ name: 'shell', input: { command: v.command }, done: { isError: !(v.status === 'completed' && v.exit_code === 0), text: textOf(v.aggregated_output || v.status) } });
    else if (typeof v.type === 'string' && /agent/i.test(v.type) && roleOf(v)) calls.push({ name: 'spawn_agent', input: v, done: { isError: Boolean(v.error) || (v.status !== undefined && v.status !== 'completed'), text: textOf(v.error || '') } });
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  documents(text).forEach(d => walk(d, 0));
  const outcome = c => c.done || results.get(c.id) || null;

  const tools = {};
  for (const t of PROBE_TOOLS) {
    const hits = calls.filter(c => new RegExp(`(^|__)harness__${t}$`).test(c.name));
    const res = hits.map(outcome);
    tools[t] = !hits.length ? 'not called' : res.some(r => r && !r.isError) ? 'answered' : res.some(r => r) ? 'errored' : 'called (no result seen)';
  }
  const agent = calls.find(c => AGENT_TOOLS.has(c.name) && roleOf(c.input));
  let subagent = null;
  if (agent) {
    const r = outcome(agent);
    // Its own result (the prompt also carries the reply word, so the whole transcript can't tell).
    subagent = { role: roleOf(agent.input), harnessRole: normRole(roleOf(agent.input)) === PROBE_ROLE, ok: Boolean(r && !r.isError), replied: Boolean(r && r.text.includes(ROLE_REPLY)), detail: r && r.isError ? r.text.slice(0, 160) : '' };
  }
  const sh = calls.find(c => (SHELL_TOOLS.has(c.name)) && String((c.input && (c.input.command || c.input.cmd)) || '').includes(PROBE_SHELL));
  let shell = 'not attempted';
  if (sh) {
    const r = outcome(sh);
    shell = !r ? 'attempted (no result seen)' : r.isError ? `refused (${r.text.replace(/\s+/g, ' ').slice(0, 120)})` : 'ran';
  }
  return { tools, subagent, shell };
}

function runProbe({ harness, root, env = process.env, bin = null, timeoutMs = 10 * 60000, spawn = spawnSync }) {
  const { argv, cwd, env: runEnv } = probeCommand(harness, root, env, { bin });
  const r = spawn(argv[0], argv.slice(1), { cwd, env: runEnv, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { harness, status: null, error: r.error.code === 'ENOENT' ? `${argv[0]} is not installed (not on PATH)` : r.error.message, analysis: null };
  return { harness, status: r.status, error: r.status === 0 ? null : `exit ${r.status}${r.stderr ? `: ${String(r.stderr).trim().split('\n').filter(l => /error|refus|denied|not /i.test(l)).slice(-2).join(' | ').slice(0, 300) || String(r.stderr).trim().split('\n').pop().slice(0, 200)}` : ''}`, analysis: analyze(r.stdout) };
}

/** True when the probe reached every harness tool and its role. */
const passed = res => Boolean(res.analysis) && !res.error && PROBE_TOOLS.every(t => res.analysis.tools[t] === 'answered')
  && Boolean(res.analysis.subagent && res.analysis.subagent.harnessRole && res.analysis.subagent.ok);

function formatReport(res) {
  const lines = [`${res.harness}: ${passed(res) ? 'ok' : 'NOT ok'}${res.error ? ` (${res.error})` : ''}`];
  if (!res.analysis) return lines;
  const a = res.analysis;
  for (const t of PROBE_TOOLS) lines.push(`  harness tool ${t}: ${a.tools[t]}`);
  lines.push(`  subagent: ${!a.subagent ? 'none delegated' : `${a.subagent.role} (${a.subagent.harnessRole ? 'the harness role' : `not the harness role ${PROBE_ROLE}`}), ${a.subagent.ok ? `answered${a.subagent.replied ? ` ${ROLE_REPLY}` : ''}` : `no answer${a.subagent.detail ? `: ${a.subagent.detail}` : ''}`}`}`);
  lines.push(`  shell \`${PROBE_SHELL}\`: ${a.shell}`);
  return lines;
}

module.exports = { MARKER, PROBE_TOOLS, PROBE_ROLE, PROBE_SHELL, ROLE_REPLY, HARNESSES, probePrompt, probeCommand, analyze, runProbe, passed, formatReport };
