'use strict';

/**
 * The headless check (scripts/check-headless.js): one real headless run per
 * harness, as the autonomous runner starts it (autotrader.js buildCommand and
 * childEnv: the same argv, allowlist, workspace and lock-down), with a probe
 * prompt that calls two harness tools, delegates once to a harness role by
 * name, and tries a shell command. The run's transcript (Claude stream-json,
 * Codex --json events, Qwen JSON, opencode JSON events) says what each step reached, whether a tool
 * was called directly or through a harness's bridge wrapper (BRIDGE_TOOLS):
 *
 *   harness tools  blackouts_list and strategies_list: answered, errored, or not called
 *   subagent       the role delegated to, and whether it answered
 *   shell          `node -e 1`: ran, refused, or not attempted
 *
 * It places no orders and changes nothing: it runs in paper mode with the
 * broker narrowed to its read tools (no order or journal-write tool on any
 * harness), and the order gate holds as in any autonomous run.
 *
 *   probePrompt()                                   the prompt
 *   probeCommand(harness, root, env, { bin })       { argv, cwd, env } as the runner runs it
 *   analyze(text)                                   { tools, subagent, shell }
 *   runProbe({ harness, root, env, bin, timeoutMs, spawn })  { harness, status, error, analysis, transcript }
 *   formatReport(result)                            text lines
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateConfig, buildCommand, childEnv, resolveDataDir, DEFAULTS, isReplay } = require('./autotrader');
const { qwenWorkspaceSettings } = require('./install');
const { harnessHome } = require('./paths');
const { TOOLS: BROKER_TOOLS } = require('./broker/interface');
const { SERVER_NAME: BROKER_SERVER } = require('./broker/config');
// Transcript parsing and the bridge wrappers (Qwen's tool_call), shared with the cycle log.
const { documents, parsed, BRIDGE_TOOLS, unwrap, resultText, SHELL_TOOLS, isOpencodeEvent, opencodeCall } = require('./transcript');
const { denyTools } = require('./opencode');

const MARKER = 'FTH-HEADLESS-PROBE';
const PROBE_TOOLS = ['blackouts_list', 'strategies_list'];
const PROBE_ROLE = 'risk-manager';
const PROBE_SHELL = 'node -e 1';
const ROLE_REPLY = 'PROBE-ROLE-OK';
const HARNESSES = ['claude', 'codex', 'qwen', 'opencode'];
// The role's exact names: as given, as a Codex role ([agents.risk_manager]), and as a Claude plugin agent.
const ROLE_NAMES = new Set([PROBE_ROLE, PROBE_ROLE.replace(/-/g, '_'), `futures-trading-harness:${PROBE_ROLE}`]);

function probePrompt() {
  return [
    `${MARKER}: a harness self-check. Place no orders, change nothing, and load no trading skill.`,
    `1) Call the harness MCP tools ${PROBE_TOOLS.join(' and ')} (no arguments) and note whether each answered.`,
    `2) Delegate once to the harness role ${PROBE_ROLE}, by that agent name, with the task: "Reply exactly ${ROLE_REPLY} and nothing else; call no tools."`,
    `3) Try once to run the shell command \`${PROBE_SHELL}\` and note whether it ran or was refused. Do not retry anything refused.`,
    'End with one line: PROBE DONE, then what each step did.',
  ].join('\n');
}

/** The runner's config for the probe: the given one (its model, extra args, workspace, bar directory), in paper mode. */
function probeConfig(harness, config = {}) {
  if (!HARNESSES.includes(harness)) throw new Error(`unknown harness "${harness}" (${HARNESSES.join(', ')})`);
  // Another harness's model and extra arguments don't apply to this one.
  const { model: _m, extraArgs: _a, command: _c, ...shared } = config || {};
  // A config without a harness runs the runner's default one.
  const own = config && (config.harness || DEFAULTS.harness) === harness ? config : shared;
  // Paper: the broker server itself refuses every order, whatever the probe's run does.
  return validateConfig({ ...own, harness, paper: true });
}

/** argv, working directory and environment of the probe, exactly as the runner would start a cycle. */
/**
 * The probe's argv with the broker narrowed to reading: no order tool (place, modify, cancel, close,
 * partial close) and no journal write, on any harness. Paper mode refuses entries, but a broker's paper
 * switch may not stop a close or a cancel; the probe needs none of them.
 */
const PROBE_BROKER_TOOLS = Object.entries(BROKER_TOOLS).filter(([name, t]) => t.role === 'read' || name === 'journal_read').map(([name]) => name);
const PROBE_DENIED = Object.keys(BROKER_TOOLS).filter(name => !PROBE_BROKER_TOOLS.includes(name));
function readOnlyBroker(harness, argv) {
  const out = [...argv];
  if (harness === 'claude') {
    const a = out.indexOf('--allowedTools') + 1;
    out[a] = out[a].split(',').flatMap(t => (t === `mcp__${BROKER_SERVER}` ? PROBE_BROKER_TOOLS.map(n => `mcp__${BROKER_SERVER}__${n}`) : [t])).join(',');
    const d = out.indexOf('--disallowedTools') + 1;
    out[d] = [out[d], ...PROBE_DENIED.map(n => `mcp__${BROKER_SERVER}__${n}`)].filter(Boolean).join(',');
    // Again after the config's extra arguments, so none of them re-allows an order tool (deny beats allow).
    out.push('--disallowedTools', PROBE_DENIED.map(n => `mcp__${BROKER_SERVER}__${n}`).join(','));
  } else if (harness === 'codex') {
    // After the config's extra arguments (a later -c wins), before the prompt, which stays last.
    out.splice(out.length - 1, 0, '-c', `mcp_servers.${BROKER_SERVER}.disabled_tools=${JSON.stringify(PROBE_DENIED)}`);
  } else if (harness === 'qwen') {
    out.push('--exclude-tools', ...PROBE_DENIED.map(n => `mcp__${BROKER_SERVER}__${n}`));
  }
  return out;
}

/** opencode's broker narrowed in its per-run config: the tools denied for the session, the head trader and every role (merged last). */
const readOnlyOpencode = env => denyTools(env, PROBE_DENIED.map(n => `${BROKER_SERVER}_${n}`));

function probeCommand(harness, root, env = process.env, { bin = null, config = {} } = {}) {
  const cfg = probeConfig(harness, config);
  // The prompt stays last for Codex (buildCommand puts it there); Qwen's flags may follow -p.
  const argv = readOnlyBroker(harness, buildCommand(cfg, probePrompt(), root, env));
  // A stand-in for the harness CLI (tests): its path replaces the program, node runs a .js one.
  if (bin) argv.splice(0, 1, ...(/\.[cm]?js$/.test(bin) ? [process.execPath, bin] : [bin]));
  const runEnv = childEnv(cfg, root, env);
  return { argv, cwd: path.resolve(root, cfg.workdir), env: harness === 'opencode' ? readOnlyOpencode(runEnv) : runEnv };
}

const AGENT_TOOLS = new Set(['Agent', 'Task', 'agent', 'task', 'spawn_agent']);
const roleOf = input => {
  const i = parsed(input);
  return i && typeof i === 'object' ? String(i.subagent_type || i.agent_type || i.agent_name || i.agent || i.role || '') : '';
};
const textOf = v => (typeof v === 'string' ? v : JSON.stringify(v === undefined ? '' : v));

/** What the probe reached, from a transcript. */
function analyze(text) {
  const calls = [];
  // A result answers the latest call with its id (an id a provider reuses can't pass one call's answer to another).
  const latest = new Map();
  // Codex reports an item when it starts (in progress) and again when it completes: the last report counts.
  const items = new Map();
  const item = (v, call) => {
    const seen = v.id === undefined ? null : items.get(v.id);
    if (!seen) {
      if (v.id !== undefined) items.set(v.id, call);
      calls.push(call);
    } else if (call.done || !seen.done) Object.assign(seen, call); // a late "started" never undoes a result
  };
  const pending = st => st === 'in_progress' || st === 'started';
  const walk = (v, depth) => {
    if (depth > 40 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    // opencode: a finished call (its main session's only), MCP tools as mcp__<server>__<tool>.
    if (isOpencodeEvent(v)) {
      if (v.type === 'tool_use' && v.part.type === 'tool') {
        const { name, input, result } = opencodeCall(v.part);
        calls.push({ id: v.part.callID, name, input, done: result });
      }
      return;
    }
    if (v.type === 'tool_use' && typeof v.name === 'string') {
      const call = { id: v.id, ...unwrap(v.name, v.input) };
      calls.push(call);
      if (v.id !== undefined && v.id !== null) latest.set(v.id, call);
    } else if (v.type === 'tool_result' && latest.has(v.tool_use_id)) latest.get(v.tool_use_id).result = { isError: v.is_error === true, text: resultText(v.content) };
    else if (v.type === 'mcp_tool_call') {
      item(v, { name: `mcp__${v.server}__${v.tool}`, input: v.arguments || {}, done: pending(v.status) ? null : { isError: v.status !== 'completed' || Boolean(v.error), text: textOf(v.error || v.result) } });
    } else if (v.type === 'command_execution') {
      item(v, { name: 'shell', input: { command: v.command }, done: pending(v.status) ? null : { isError: !(v.status === 'completed' && v.exit_code === 0), text: textOf(v.aggregated_output || v.status) } });
    } else if (typeof v.type === 'string' && (/agent/i.test(v.type) || v.tool === 'spawn_agent') && (roleOf(v) || roleOf(v.arguments))) {
      item(v, { name: 'spawn_agent', input: roleOf(v) ? v : parsed(v.arguments), done: pending(v.status) ? null : { isError: Boolean(v.error) || (v.status !== undefined && v.status !== 'completed'), text: textOf(v.error || '') } });
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  documents(text).forEach(d => walk(d, 0));
  const outcome = c => {
    const r = c.done || c.result || null;
    // Through a bridge, its refusal is the bridge's, not the tool's answer.
    return r && c.bridge && c.bridge.refused.test(r.text) ? { ...r, isError: true } : r;
  };

  const tools = {};
  for (const t of PROBE_TOOLS) {
    // A name the model wrote into a bridge must be the tool's exact name.
    const hits = calls.filter(c => new RegExp(c.bridge ? `^(mcp__)?harness__${t}$` : `(^|__)harness__${t}$`).test(c.name));
    const res = hits.map(outcome);
    tools[t] = !hits.length ? 'not called' : res.some(r => r && !r.isError) ? 'answered' : res.some(r => r) ? 'errored' : 'called (no result seen)';
  }
  // Every delegation; the best one counts (the harness role, answered), so a first try elsewhere doesn't hide it.
  const agents = calls.filter(c => AGENT_TOOLS.has(c.name) && roleOf(c.input)).map(c => {
    const r = outcome(c);
    // Its own result (the prompt also carries the reply word, so the whole transcript can't tell).
    return { role: roleOf(c.input), harnessRole: ROLE_NAMES.has(roleOf(c.input)), ok: Boolean(r && !r.isError), replied: Boolean(r && r.text.includes(ROLE_REPLY)), detail: r && r.isError ? r.text.slice(0, 160) : '' };
  });
  const subagent = agents.find(a => a.harnessRole && a.ok) || agents.find(a => a.harnessRole) || agents[0] || null;
  // Every shell attempt; any that ran counts as ran (reported in the unsafe direction, never hidden).
  const shells = calls.filter(c => SHELL_TOOLS.has(c.name) && String((c.input && (c.input.command || c.input.cmd)) || '').includes(PROBE_SHELL)).map(outcome);
  const refusal = shells.find(r => r && r.isError);
  const shell = !shells.length ? 'not attempted' : shells.some(r => r && !r.isError) ? 'ran'
    : refusal ? `refused (${refusal.text.replace(/\s+/g, ' ').slice(0, 120)})` : 'attempted (no result seen)';
  return { tools, subagent, shell };
}

/**
 * Qwen runs headless on workspace/.qwen/settings.json: the allowlist the runner writes at start
 * (scripts/autotrader.js writeQwenSettings), written the same way, so the probe tests that one.
 */
function qwenAllowlist(cfg, root, env = process.env) {
  const file = path.resolve(root, cfg.workdir, '.qwen', 'settings.json');
  const content = `${JSON.stringify(qwenWorkspaceSettings(root, os.homedir(), { dataDir: resolveDataDir(cfg, os.homedir(), env), stateDir: harnessHome(env), replay: isReplay(env) }), null, 2)}\n`;
  return { file, content };
}

function runProbe({ harness, root, env = process.env, bin = null, config = {}, timeoutMs = 10 * 60000, spawn = spawnSync, writeAllowlist = false, writeFile = null, saveFile = null, now = () => new Date() }) {
  const { argv, cwd, env: runEnv } = probeCommand(harness, root, env, { bin, config });
  if (harness === 'qwen') {
    // The workspace allowlist is one of the runner's watched files: changing it switches a running
    // runner's trading off. So only on request; otherwise a missing or different one is reported.
    const { file, content } = qwenAllowlist(probeConfig(harness, config), root, env);
    const current = (() => { try { return fs.readFileSync(file, 'utf8'); } catch (_err) { return null; } })();
    if (current !== content) {
      if (!writeAllowlist) {
        return { harness, status: null, analysis: null, error: `${file} is ${current === null ? 'missing' : 'not the allowlist the runner writes for this config'}: start the runner once (it writes it), pass --config <the runner's config>, or pass --write-qwen-allowlist (with no runner trading: a running runner sees the change and turns trading off)` };
      }
      (writeFile || ((f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); }))(file, content);
    }
  }
  const r = spawn(argv[0], argv.slice(1), { cwd, env: runEnv, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.error && r.error.code === 'ENOENT') return { harness, status: null, error: `${argv[0]} is not installed (not on PATH)`, analysis: null };
  const transcript = keepTranscript(harness, r, env, saveFile, now);
  if (r.error) return { harness, status: null, error: r.error.message, analysis: null, transcript };
  return { harness, status: r.status, error: r.status === 0 ? null : `exit ${r.status}${r.stderr ? `: ${String(r.stderr).trim().split('\n').filter(l => /error|refus|denied|not /i.test(l)).slice(-2).join(' | ').slice(0, 300) || String(r.stderr).trim().split('\n').pop().slice(0, 200)}` : ''}`, analysis: analyze(r.stdout), transcript };
}

/**
 * The probe's raw transcript, kept at FTH_HOME/logs/headless-<harness>-<time>.json (its stderr beside
 * it as .stderr.log when there is any), so a failure can be diagnosed without another run.
 * Returns the path, or { error } when it couldn't be written (the check itself goes on).
 */
function keepTranscript(harness, r, env, saveFile, now) {
  const file = path.join(harnessHome(env), 'logs', `headless-${harness}-${now().toISOString().replace(/[:.]/g, '-')}.json`);
  const save = saveFile || ((f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); });
  try {
    save(file, String(r.stdout || ''));
  } catch (err) {
    return { error: `${file}: ${err.message}` };
  }
  try {
    if (r.stderr && String(r.stderr).trim()) save(file.replace(/\.json$/, '.stderr.log'), String(r.stderr));
  } catch (_err) { /* the transcript is kept; its stderr is a bonus */ }
  return file;
}

/** True when the probe reached every harness tool and its role. */
const passed = res => Boolean(res.analysis) && !res.error && PROBE_TOOLS.every(t => res.analysis.tools[t] === 'answered')
  && Boolean(res.analysis.subagent && res.analysis.subagent.harnessRole && res.analysis.subagent.ok);

function formatReport(res) {
  const lines = [`${res.harness}: ${passed(res) ? 'ok' : 'NOT ok'}${res.error ? ` (${res.error})` : ''}`];
  if (res.transcript) lines.push(`  transcript: ${typeof res.transcript === 'string' ? res.transcript : `not kept (${res.transcript.error})`}`);
  if (!res.analysis) return lines;
  const a = res.analysis;
  for (const t of PROBE_TOOLS) lines.push(`  harness tool ${t}: ${a.tools[t]}`);
  lines.push(`  subagent: ${!a.subagent ? 'none delegated' : `${a.subagent.role} (${a.subagent.harnessRole ? 'the harness role' : `not the harness role ${PROBE_ROLE}`}), ${a.subagent.ok ? `answered${a.subagent.replied ? ` ${ROLE_REPLY}` : ''}` : `no answer${a.subagent.detail ? `: ${a.subagent.detail}` : ''}`}`}`);
  lines.push(`  shell \`${PROBE_SHELL}\`: ${a.shell}`);
  return lines;
}

/** The harness a runner config trades with (its own, else the runner's default). */
const configHarness = config => (config && config.harness) || DEFAULTS.harness;

module.exports = { BRIDGE_TOOLS, PROBE_BROKER_TOOLS, PROBE_DENIED, readOnlyBroker, readOnlyOpencode, configHarness, MARKER, PROBE_TOOLS, PROBE_ROLE, PROBE_SHELL, ROLE_REPLY, HARNESSES, probePrompt, probeConfig, probeCommand, qwenAllowlist, analyze, runProbe, passed, formatReport };
