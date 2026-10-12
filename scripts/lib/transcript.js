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
 *   resultText(content)      a tool_result's content as text (a string, or its text blocks)
 *   bridgeRefused(call, result)  the bridge refused this call (it never reached the tool)
 *   SHELL_TOOLS              shell tool names across harnesses
 *   isOpencodeEvent(ev)      an opencode `run --format json` event
 *   opencodeStopped(part)    opencode stopped the call itself (an unavailable tool, a permission rule)
 *   opencodeCall(part)       an opencode tool part as { name, input, result }, MCP tools named
 *                            mcp__<server>__<tool> as on the other harnesses
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
  // Anchored: the refusal is the whole reply's start, never text a real tool's reply carries.
  { name: 'tool_call', target: i => i.name, args: i => i.arguments, refused: /^\s*\[tool_call bridge refused\]/ },
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

/** A tool_result's content as text: a string as is, text blocks joined, anything else as JSON. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(x => (x && typeof x.text === 'string' ? x.text : '')).join('\n');
  return JSON.stringify(content === undefined ? '' : content);
}

/** A bridged call the bridge itself refused: an error result that starts with the bridge's refusal. */
const bridgeRefused = (call, result) => Boolean(call && call.bridge && result && result.is_error === true && call.bridge.refused.test(resultText(result.content)));

const SHELL_TOOLS = new Set(['Bash', 'run_shell_command', 'shell', 'exec_command', 'local_shell', 'bash']);

/**
 * opencode `run --format json`: one event per line for the main session (a subagent's own calls are
 * not in it), { type, timestamp, sessionID, part } (or { ..., error } for an error). Recognized by that
 * whole envelope, so another JSON line with a "type" (an echoed broker reply) stays plain text.
 */
const OPENCODE_EVENTS = new Set(['text', 'tool_use', 'step_start', 'step_finish', 'reasoning', 'error']);
const isOpencodeEvent = ev => Boolean(ev) && typeof ev === 'object' && !Array.isArray(ev) && OPENCODE_EVENTS.has(ev.type)
  && typeof ev.sessionID === 'string' && Number.isFinite(ev.timestamp)
  && (ev.type === 'error' ? ev.error !== undefined : Boolean(ev.part) && typeof ev.part === 'object');

/** The MCP servers the harness registers: opencode names their tools <server>_<tool>. */
const OPENCODE_SERVERS = [require('./broker/config').SERVER_NAME, require('./harness-tools/registry').SERVER_NAME];

/**
 * A tool part (a tool_use event's part: { tool, state: { status, input, output | error } }) as
 * { name, input, result: { isError, text } | null }: completed answered, error errored (a refused
 * permission included), anything else has no result yet.
 */
function opencodeCall(part) {
  const tool = String((part && part.tool) || '');
  const server = OPENCODE_SERVERS.find(s => tool.startsWith(`${s}_`) && tool.length > s.length + 1);
  const state = (part && part.state) || {};
  const input = state.input && typeof state.input === 'object' ? state.input : {};
  const result = state.status === 'completed' ? { isError: false, text: resultText(state.output) }
    : state.status === 'error' ? { isError: true, text: resultText(state.error) } : null;
  return { name: server ? `mcp__${server}__${tool.slice(server.length + 1)}` : tool, input, result };
}

/**
 * A call opencode itself stopped before any tool ran: a tool it doesn't have ("Model tried to call
 * unavailable tool"), one its permission rules deny, or one the user rejected when asked. Not a call to
 * the tool (a broker never saw it).
 */
const OPENCODE_STOPPED = /^\s*(Model tried to call unavailable tool|The user has specified a rule which prevents you from using this specific tool call|The user rejected permission to use this specific tool call)/;
const opencodeStopped = part => Boolean(part && part.state && part.state.status === 'error' && OPENCODE_STOPPED.test(resultText(part.state.error)));

/** The harnesses' subagent tools: Claude's Agent (Task before), Qwen Code's agent, opencode's task, Codex's spawn_agent. */
const SUBAGENT_CALLS = new Set(['Agent', 'Task', 'agent', 'task', 'spawn_agent']);
/** The role a subagent call names (its input), '' when none. */
const subagentRole = input => {
  const i = parsed(input);
  return i && typeof i === 'object' ? String(i.subagent_type || i.agent_type || i.agent_name || i.agent || i.role || '') : '';
};
/** A Codex item that spawns a subagent (not its own messages, agent_message). */
const codexSubagentItem = v => Boolean(v) && typeof v.type === 'string' && v.type !== 'agent_message' && (/agent/i.test(v.type) || v.tool === 'spawn_agent') && Boolean(subagentRole(v) || subagentRole(v.arguments));

module.exports = { SUBAGENT_CALLS, subagentRole, codexSubagentItem, documents, parsed, BRIDGE_TOOLS, unwrap, resultText, bridgeRefused, SHELL_TOOLS, isOpencodeEvent, opencodeCall, opencodeStopped, OPENCODE_SERVERS };
