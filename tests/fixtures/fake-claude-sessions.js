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
 *   - `--permission-mode dontAsk` with `--allowedTools`: a tool call not allowed (by name, or its whole MCP server) is
 *     refused and never reaches the tool; it is recorded in `refused`.
 *
 * The run plays `script(prompt, env, { resumed })` with the scripted model (tests/fixtures/scripted-model.js, Claude's
 * stream-json), so every allowed tool goes to the real harness tools server and the real order gateway.
 *   fakeClaude({ dir, script }) -> run, with run.calls [{ argv, env, session, source, refused }]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scriptedModel } = require('./scripted-model');

const ROOT = path.resolve(__dirname, '..', '..');
const flagOf = (argv, f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const uuid = () => crypto.randomUUID();

/** The Claude Code name a scripted step calls, or null (a step that calls no tool). */
function toolOf(step) {
  if (step.load) return 'Skill';
  if (step.lookup) return 'mcp__harness__skill_lookup';
  if (step.harness) return `mcp__harness__${step.harness}`;
  if (step.broker) return `mcp__broker__${step.broker}`;
  if (step.role || step.executor) return 'Agent';
  return null;
}
const allowedBy = (list, name) => list.includes(name) || list.some(a => /^mcp__[a-z]+$/.test(a) && name.startsWith(`${a}__`));

function fakeClaude({ dir, script }) {
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
    const held = steps.map(s => {
      const name = toolOf(s);
      if (!name || !dontAsk || allowedBy(allowed, name)) return s;
      return { act: () => { call.refused.push(name); } };
    });
    const model = scriptedModel(held, { format: 'claude' });
    const res = await model(argv, opts);
    const output = res.output.replace(/"session_id":"ses_scripted"/g, `"session_id":"${id}"`);
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

module.exports = { fakeClaude, toolOf, allowedBy };
