'use strict';

/**
 * The tool-call layer's dispatcher for a harness whose hooks start a process per call (Claude Code: hooks/hooks.json
 * `PreToolUse` / `PostToolUse`, docs/TOOL-CALLS-AND-ORCHESTRATION.md): it runs the layer's rules (toolcall/rules.js,
 * through the pipeline) on the call. Before: a refusal blocks it (exit 2, the reason the model reads). After: a note
 * goes back as the result's added context. The call log is an append-only file per session under the harness home's
 * logs (call-log.js: each call one line, the rules' state rebuilt by replaying the lines before it). A
 * repair (an argument change) is opencode's: Claude's role launch has no task_id. Only in the runner's autonomous
 * sessions (FTH_AUTONOMOUS=1). A crash or a timeout of this hook passes the call (run-with-flags: it isn't one of
 * FAIL_CLOSED_HOOKS); the order gate, which is, still refuses an entry without the desk.
 */

const path = require('path');
const { createPipeline } = require('../lib/toolcall/pipeline');
const { createCallLog, readEvents, appendEvent, replayEvents, compact } = require('../lib/toolcall/call-log');
const { fromClaude, toClaude } = require('../lib/toolcall/names');
const { harnessHome } = require('../lib/paths');

function run(rawInput, _ctx = {}, deps = {}) {
  let payload;
  try {
    payload = JSON.parse(rawInput || '{}');
  } catch (_err) {
    return '';
  }
  const env = deps.env || process.env;
  // The runner's autonomous sessions only (FTH_AUTONOMOUS=1), as the rules run in opencode's runs: a person's own
  // Claude Code session (the plugin installs for anyone) is never held or reminded.
  if (String(env.FTH_AUTONOMOUS || '') !== '1') return '';
  const session = String(payload.session_id || 'session').replace(/[^A-Za-z0-9_-]/g, '_');
  const file = path.join(harnessHome(env), 'logs', 'toolcall', `${session}.jsonl`);
  // The rules' state: this session's calls before this one, replayed through the same rules at their own times.
  const clock = { at: 0 };
  const pipeline = createPipeline({ log: createCallLog(), env, now: () => clock.at, native: toClaude });
  replayEvents(pipeline, readEvents(file), clock);
  clock.at = (deps.now || (() => Date.now()))();
  // Judged and logged compact (call-log.js): the same values the replay of this line will give the rules.
  const call = { tool: fromClaude(payload.tool_name), name: payload.tool_name, args: compact(payload.tool_input || {}), session, id: payload.tool_use_id || null };
  const record = { ...call, args: compact(call.args) };
  if (payload.hook_event_name === 'PostToolUse') {
    const r = payload.tool_response;
    const text = compact(typeof r === 'string' ? r : (r && typeof r === 'object' ? JSON.stringify(r) : undefined));
    const { note } = pipeline.after(call, { text });
    appendEvent(file, { event: 'post', call: record, result: { text }, at: clock.at });
    return note ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } }) : '';
  }
  const { refuse } = pipeline.before(call);
  appendEvent(file, { event: 'pre', call: record, at: clock.at });
  return refuse ? { stderr: refuse, exitCode: 2 } : '';
}

module.exports = { run };
