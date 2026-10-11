'use strict';

/**
 * Reading a headless harness run's transcript, shared by the cycle log
 * (cycle-log.js) and the headless check (headless-check.js):
 *
 *   documents(text)          every JSON value in it: one document (Qwen's JSON
 *                            array, after any warning lines it prints first),
 *                            or one per line (Claude stream-json, Codex --json)
 *   parsed(v)                a JSON string's value (else null); a non-string as is
 *   BRIDGE_TOOLS             the bridge wrappers harnesses reach deferred tools through
 *   unwrap(name, input)      a tool_use as the tool it reaches: { name, input, bridge? }
 *   SHELL_TOOLS              shell tool names across harnesses
 *
 * Never throws on a malformed transcript: what it can't parse it skips.
 */

const parsed = v => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_err) { return null; }
};

/** Every JSON value in a transcript: the whole text, else each line that parses. */
function documents(text) {
  const s = String(text || '').trim();
  try {
    return [JSON.parse(s)];
  } catch (_err) {
    return s.split('\n').map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(v => v !== null && typeof v === 'object');
  }
}

/**
 * Bridge wrappers: a harness that defers its MCP tools reaches them through one generic tool whose
 * input names the real tool. Each entry: the wrapper's tool name, the real tool's name and arguments
 * from its input, and how the wrapper says it refused (a refusal never reached the tool, is_error or not).
 *   Qwen Code (0.25+): tool_call {"name": "mcp__harness__blackouts_list", "arguments": {...}};
 *   refused until tool_search reviewed the schema: "[tool_call bridge refused] Deferred tool ...".
 */
const BRIDGE_TOOLS = [
  { name: 'tool_call', target: i => i.name, args: i => i.arguments, refused: /\[tool_call bridge refused\]/ },
];

/** A tool_use as the tool it reaches: the real tool behind a bridge wrapper, else itself. */
function unwrap(name, input) {
  const bridge = BRIDGE_TOOLS.find(b => b.name === name);
  const i = bridge ? parsed(input) : null;
  const target = i && typeof i === 'object' ? bridge.target(i) : null;
  if (typeof target !== 'string' || !target) return { name, input: input || {} };
  const args = parsed(bridge.args(i));
  return { name: target, input: args && typeof args === 'object' ? args : {}, bridge };
}

const SHELL_TOOLS = new Set(['Bash', 'run_shell_command', 'shell', 'exec_command', 'local_shell']);

module.exports = { documents, parsed, BRIDGE_TOOLS, unwrap, SHELL_TOOLS };
