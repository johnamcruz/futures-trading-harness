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
 *     refused and never reaches the tool: a tool_use answered by the CLI's denial (an error tool_result), recorded in
 *     `refused` and in the result event's permission_denials, as the CLI reports them.
 *   - PreToolUse hooks fire on EVERY call, allowed or not, before the permission check (measured: plan section 9), with
 *     the session's file as it stands as transcript_path; a hook's refusal (exit 2) blocks the call (a tool_use answered
 *     by the hook's reason, an error), never reaching the tool.
 *   - The session file is the CLI's shape: one event a line at the top level (type, message, ...) with its uuid,
 *     parentUuid and sessionId, written as the run goes; the stream (stdout, the runner's live file) names the session.
 *
 * The run plays `script(prompt, env, { resumed })` with the scripted model (tests/fixtures/scripted-model.js, Claude's
 * stream-json), so every allowed tool goes to the real harness tools server and the real order gateway.
 *   fakeClaude({ dir, script, preHooks }) -> run, with run.calls [{ argv, env, session, source, refused, hooked }]
 *   preHooks: true (the default, as the real CLI: the plugin's own PreToolUse hooks, hooks/hooks.json), false (none), or
 *   (name, input, payload, env) -> { code, stderr } in their place
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
    // The session file as the CLI writes it: the history first (as kept), then each of this run's lines as it is printed.
    const own = [];
    let parent = kept.length ? kept[kept.length - 1].uuid : null;
    const write = () => fs.writeFileSync(file(id), `${[...kept, ...own].map(l => JSON.stringify(l)).join('\n')}\n`);
    write();
    const onLine = line => {
      let e;
      try { e = JSON.parse(line); } catch (_err) { return; }
      const u = uuid();
      own.push({ ...e, uuid: u, parentUuid: parent, sessionId: id });
      parent = u;
      write();
    };
    // The plugin's PreToolUse hooks (hooks/hooks.json: the order gate on place_order and modify_order, the tool-call
    // rules on every call), with the run's environment and the session's file as it stands; what they say is the run's
    // (call.hooked). A test's own function stands in for them.
    call.hooked = [];
    const preHooks = (name, input) => {
      const payload = { hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, session_id: id, transcript_path: file(id) };
      if (runHooks === false) return { code: 0, stderr: '' };
      if (typeof runHooks === 'function') { const r = runHooks(name, input, payload, opts.env) || { code: 0, stderr: '' }; call.hooked.push({ hook: 'test', name, code: r.code }); return r; }
      const hooks = [...(/^mcp__.*__(place_order|modify_order)$/.test(name) ? [['pre:trading:order-gate', 'scripts/hooks/trading-order-gate.js', 'minimal,standard,strict']] : []), ['pre:toolcall:rules', 'scripts/hooks/toolcall.js', 'standard,strict']];
      for (const [hook, script, profiles] of hooks) {
        const r = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', 'run-with-flags.js'), hook, script, profiles], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...opts.env, CLAUDE_PLUGIN_ROOT: ROOT } });
        call.hooked.push({ hook, name, code: r.status });
        if (r.status === 2) return { code: 2, stderr: String(r.stderr || '').trim() };
      }
      return { code: 0, stderr: '' };
    };
    call.ran = [];
    const denial = name => `Permission to use ${name} has been denied because Claude Code is running in don't ask mode.`;
    const held = steps.map(s => {
      const name = toolOf(s);
      if (!name) return s;
      // At its turn (its arguments may read what came before): the hooks first, then the permission check, then the tool.
      return { then: ctx => {
        const input = name === 'Bash' ? { command: s.bash } : typeof s.args === 'function' ? s.args(ctx) : (s.args || (s.load ? { skill: s.load } : s.lookup ? { skill: s.lookup } : s.role ? { subagent_type: s.role } : {}));
        const hooked = preHooks(name, input);
        if (hooked.code === 2) return [{ refused: name, input, text: hooked.stderr || 'refused by a PreToolUse hook' }];
        // A shell command: approved read-only or by an allow rule (noted as run), else refused; no shell is run here.
        if (name === 'Bash') {
          if (!dontAsk || bashAllowed(allowed, s.bash)) { call.ran.push(s.bash); return []; }
          call.refused.push('Bash');
          return [{ refused: 'Bash', input, text: denial('Bash') }];
        }
        if (!dontAsk || allowedBy(allowed, name)) return [typeof s.args === 'function' ? { ...s, args: input } : s];
        call.refused.push(name);
        return [{ refused: name, input, text: denial(name) }];
      } };
    });
    const model = scriptedModel(held, { format: 'claude', session: id });
    // Stopped (its signal: what runHarness kills the process group on, the deadline's abort): it ends at once, cancelled,
    // as a killed CLI ends; nothing more is written for it.
    const stopped = opts.signal ? new Promise(resolve => { const end = () => resolve({ cancelled: true }); if (opts.signal.aborted) end(); else opts.signal.addEventListener('abort', end, { once: true }); }) : new Promise(() => {});
    const raced = await Promise.race([model(argv, { ...opts, stream: line => { onLine(line); if (opts.stream) opts.stream(line); } }), stopped]);
    if (raced && raced.cancelled) {
      call.cancelled = true;
      return { ok: false, timedOut: false, cancelled: true, code: 143, output: '\n[autotrader] run cancelled; killing run\n', stdout: '' };
    }
    const res = raced;
    // The CLI's result event names each call dontAsk refused (permission_denials).
    const output = res.output.split('\n').map(l => {
      let e;
      try { e = JSON.parse(l); } catch (_err) { return l; }
      return e && e.type === 'result' ? JSON.stringify({ ...e, permission_denials: call.refused.map((n, k) => ({ tool_name: n, tool_use_id: `denied_${k}` })) }) : l;
    }).join('\n');
    // The session file's result line as the stream's (the denials named), its uuid kept.
    for (const l of own) if (l.type === 'result') l.permission_denials = call.refused.map((n, k) => ({ tool_name: n, tool_use_id: `denied_${k}` }));
    write();
    return { ...res, output, stdout: output };
  };
  run.calls = calls;
  run.file = file;
  return run;
}

module.exports = { fakeClaude, toolOf, allowedBy, bashAllowed };
