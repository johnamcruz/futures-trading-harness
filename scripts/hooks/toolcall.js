'use strict';

/**
 * The tool-call layer's dispatcher for a harness whose hooks start a process per call (Claude Code: hooks/hooks.json
 * `PreToolUse` / `PostToolUse`, docs/TOOL-CALLS-AND-ORCHESTRATION.md): it runs the layer's rules (toolcall/rules.js,
 * through the pipeline) on the call. Before: a refusal blocks it (exit 2, the reason the model reads). After: a note
 * goes back as the result's added context. The call log is a file per session under the harness home's logs. A
 * repair (an argument change) is opencode's: Claude's role launch has no task_id. Only in the runner's autonomous
 * sessions (FTH_AUTONOMOUS=1). A crash or a timeout of this hook passes the call (run-with-flags: it isn't one of
 * FAIL_CLOSED_HOOKS); the order gate, which is, still refuses an entry without the desk.
 */

const path = require('path');
const { createPipeline } = require('../lib/toolcall/pipeline');
const { createCallLog } = require('../lib/toolcall/call-log');
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
  const log = createCallLog({ file: path.join(harnessHome(env), 'logs', 'toolcall', `${session}.json`) });
  const pipeline = createPipeline({ log, env, now: deps.now || (() => Date.now()), native: toClaude });
  const call = { tool: fromClaude(payload.tool_name), name: payload.tool_name, args: payload.tool_input || {}, session, id: payload.tool_use_id || null };
  if (payload.hook_event_name === 'PostToolUse') {
    const r = payload.tool_response;
    const text = typeof r === 'string' ? r : (r && typeof r === 'object' ? JSON.stringify(r) : undefined);
    const { note } = pipeline.after(call, { text });
    return note ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } }) : '';
  }
  const { refuse } = pipeline.before(call);
  return refuse ? { stderr: refuse, exitCode: 2 } : '';
}

module.exports = { run };
