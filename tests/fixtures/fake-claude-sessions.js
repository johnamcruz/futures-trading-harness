'use strict';

/**
 * A stand-in for Claude Code's sessions, for prepare ahead's shadow runs (scripts/lib/cycle-run.js runPrepare's `run`,
 * the runHarness shape): it keeps each session's transcript under `dir`, and behaves as the spike measured the CLI
 * (docs/PREPARE-AHEAD.md, plan section 8):
 *
 *   - `-p` alone starts a new session; `--resume <id> --fork-session` starts a new one whose transcript copies the
 *     original's lines with their original uuids and its own sessionId stamped on every line, then its own lines (new
 *     uuids, the first one's parentUuid the original's last); `--resume <id>` alone continues that session. A resume of a
 *     session with no transcript fails (exit 1, an error result), as the CLI does.
 *   - SessionStart runs the plugin's real hook (scripts/hooks/trading-session-start.js) with { source: startup | fork |
 *     resume, session_id, transcript_path }, with the run's environment.
 *   - Its run's signal (opts.signal, the deadline's abort) stops it at once, cancelled, as a killed CLI.
 *   - `--permission-mode dontAsk` with `--allowedTools`: a tool call not allowed (by name, or its whole MCP server) is
 *     refused and never reaches the tool; it is recorded in `refused`.
 *
 * The run plays `script(prompt, env, { resumed })` with the scripted model (tests/fixtures/scripted-model.js, Claude's
 * stream-json), so every allowed tool goes to the real harness tools server and the real order gateway.
 *   fakeClaude({ dir, script, preHooks }) -> run, with run.calls [{ argv, env, session, source, refused, hooked }]
 *   (preHooks, on by default as the real CLI does: the plugin's PreToolUse hooks run on a call before dontAsk refuses
 *   it; the refused calls are the result event's permission_denials, as the CLI reports them)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scriptedModel } = require('./scripted-model');

const ROOT = path.resolve(__dirname, '..', '..');
const flagOf = (argv, f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const uuid = () => crypto.randomUUID();

// The shell commands Claude Code approves without a rule (read-only), as dontAsk leaves them: any other command needs an
// allow rule (Bash(<prefix>:*)) or is refused.
const READ_ONLY = /^(echo|ls|pwd|cat|head|tail|wc|grep|date)(\s|$)/;
const bashAllowed = (list, cmd) => READ_ONLY.test(cmd) || list.some(a => { const m = /^Bash\((.*):\*\)$/.exec(a); return m && (cmd === m[1] || cmd.startsWith(`${m[1]} `)); });

/** The Claude Code name a scripted step calls, or null (a step that calls no tool). */
function toolOf(step) {
  if (step.bash) return 'Bash';
  if (step.load) return 'Skill';
  if (step.lookup) return 'mcp__harness__skill_lookup';
  if (step.harness) return `mcp__harness__${step.harness}`;
  if (step.broker) return `mcp__broker__${step.broker}`;
  if (step.role || step.executor) return 'Agent';
  return null;
}
const allowedBy = (list, name) => list.includes(name) || list.some(a => /^mcp__[a-z]+$/.test(a) && name.startsWith(`${a}__`));

function fakeClaude({ dir, script, preHooks: runHooks = true }) {
  fs.mkdirSync(dir, { recursive: true });
  const calls = [];
  const file = id => path.join(dir, `${id}.jsonl`);
  const run = async (argv, opts) => {
    const resume = flagOf(argv, '--resume');
    const fork = argv.includes('--fork-session');
    const allowed = String(flagOf(argv, '--allowedTools') || '').split(',').filter(Boolean);
    const dontAsk = flagOf(argv, '--permission-mode') === 'dontAsk';
    const call = { argv, env: opts.env, refused: [] };
    calls.push(call);
    if (resume && !fs.existsSync(file(resume))) {
      const out = `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${resume}` })}\n`;
      return { ok: false, timedOut: false, code: 1, output: out, stdout: out };
    }
    const id = resume && !fork ? resume : uuid();
    const source = !resume ? 'startup' : fork ? 'fork' : 'resume';
    const history = resume ? fs.readFileSync(file(resume), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const kept = history.map(l => ({ ...l, sessionId: id }));
    Object.assign(call, { session: id, source });
    // SessionStart: the plugin's own hook, with the run's environment.
    require(path.join(ROOT, 'scripts', 'hooks', 'trading-session-start.js')).run(JSON.stringify({ source, session_id: id, transcript_path: file(id), hook_event_name: 'SessionStart' }), { pluginRoot: ROOT }, { env: opts.env });
    // The script, each tool call held to the allowed list (dontAsk refuses the rest, never reaching the tool).
    const steps = script(String(argv[argv.indexOf('-p') + 1] || ''), opts.env, { resumed: Boolean(resume), history });
    // `preHooks` (the CLI's order: hooks fire before the dontAsk denial): the plugin's PreToolUse hooks (hooks/hooks.json: the order gate
    // on place_order and modify_order, the tool-call rules on every call) run on a call before the permission check
    // refuses it, with the run's environment; what they write is the run's (call.hooked).
    call.hooked = [];
    const preHooks = (name, input) => {
      const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, session_id: id, transcript_path: file(id) });
      const hooks = [...(/^mcp__.*__(place_order|modify_order)$/.test(name) ? [['pre:trading:order-gate', 'scripts/hooks/trading-order-gate.js', 'minimal,standard,strict']] : []), ['pre:toolcall:rules', 'scripts/hooks/toolcall.js', 'standard,strict']];
      for (const [hook, script, profiles] of hooks) {
        const r = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', 'run-with-flags.js'), hook, script, profiles], { input: payload, encoding: 'utf8', env: { ...opts.env, CLAUDE_PLUGIN_ROOT: ROOT } });
        call.hooked.push({ hook, name, code: r.status });
      }
    };
    call.ran = [];
    const held = steps.map(s => {
      const name = toolOf(s);
      // A shell command: approved read-only or by an allow rule (noted as run), else refused; no shell is run here.
      if (name === 'Bash') return { act: () => { if (!dontAsk || bashAllowed(allowed, s.bash)) call.ran.push(s.bash); else call.refused.push('Bash'); } };
      if (!name || !dontAsk || allowedBy(allowed, name)) return s;
      return { act: () => { if (runHooks) preHooks(name, typeof s.args === 'function' ? {} : (s.args || {})); call.refused.push(name); } };
    });
    const model = scriptedModel(held, { format: 'claude' });
    // Stopped (its signal: what runHarness kills the process group on, the deadline's abort): it ends at once, cancelled,
    // as a killed CLI ends; nothing more is written for it.
    const stopped = opts.signal ? new Promise(resolve => { const end = () => resolve({ cancelled: true }); if (opts.signal.aborted) end(); else opts.signal.addEventListener('abort', end, { once: true }); }) : new Promise(() => {});
    const raced = await Promise.race([model(argv, opts), stopped]);
    if (raced && raced.cancelled) {
      call.cancelled = true;
      return { ok: false, timedOut: false, cancelled: true, code: 143, output: '\n[autotrader] run cancelled; killing run\n', stdout: '' };
    }
    const res = raced;
    // The CLI's result event names each call dontAsk refused (permission_denials).
    const output = res.output.replace(/"session_id":"ses_scripted"/g, `"session_id":"${id}"`).split('\n').map(l => {
      let e;
      try { e = JSON.parse(l); } catch (_err) { return l; }
      return e && e.type === 'result' ? JSON.stringify({ ...e, permission_denials: call.refused.map((n, k) => ({ tool_name: n, tool_use_id: `denied_${k}` })) }) : l;
    }).join('\n');
    // The transcript: the history (as kept), then this run's own lines.
    let parent = kept.length ? kept[kept.length - 1].uuid : null;
    const own = output.trim().split('\n').filter(Boolean).map(l => { const u = uuid(); const e = { uuid: u, parentUuid: parent, sessionId: id, event: JSON.parse(l) }; parent = u; return e; });
    fs.writeFileSync(file(id), `${[...kept, ...own].map(l => JSON.stringify(l)).join('\n')}\n`);
    return { ...res, output, stdout: output };
  };
  run.calls = calls;
  run.file = file;
  return run;
}

module.exports = { fakeClaude, toolOf, allowedBy, bashAllowed };
