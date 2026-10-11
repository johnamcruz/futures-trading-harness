'use strict';

/**
 * What the model saw and did in each autonomous cycle, for debugging and for
 * reviews:
 *
 *   <FTH_HOME>/logs/cycles/<day>/<HHMMSS>-<action>.json   the whole cycle: the
 *       prompt it was given and what it was built from (context: each symbol's
 *       bar, trend, day, plan, what fired with its record; the account and open
 *       trades; news; the sections that were unavailable), the harness argv
 *       (prompt elided), the raw
 *       transcript, and the parsed summary
 *   <FTH_HOME>/logs/cycles-<day>.jsonl   one summary line per cycle: result,
 *       skills loaded, tool calls by name, shell commands, orders sent, and
 *       the skills an entry needed but the model never loaded
 *
 * Transcripts: Claude Code runs with --output-format stream-json (one JSON
 * event per line, tool calls included); Codex with --json; Qwen Code with
 * --output-format json (one array, tool calls included, often through its
 * tool_call bridge: counted as the tool reached); opencode with run --format
 * json (one event per line, the main session's tool calls only: a subagent's
 * own calls, the trade-executor's orders among them, are not in it); others as text. The parser
 * (transcript.js) reads what it recognizes and never throws.
 */

const fs = require('fs');
const path = require('path');
const { tradingDayKey } = require('./trading/clock');
const { REQUIRED_FOR_ENTRY, skillName } = require('./trading/skills-loaded');
const { documents, unwrap, bridgeRefused, resultText, SHELL_TOOLS, isOpencodeEvent, opencodeCall, opencodeStopped } = require('./transcript');

const ENTRY_TOOL = /(^|__)place_order$/;
const RISK_REDUCING = /^\s*\[(exit|protect)\]/i;

/**
 * Every tool call in a transcript (Claude stream-json, Codex --json, Qwen's JSON array, opencode's JSON
 * events, its MCP tools named mcp__<server>__<tool>): [{ name, input, failed?, error?, stopped? }] (error: the
 * failed call's answer, cut to 300 characters).
 * A call through a bridge wrapper (Qwen's tool_call, transcript.js BRIDGE_TOOLS) counts as the tool it
 * reaches, with that tool's arguments; one the bridge refused never reached the tool and isn't counted.
 */
function toolCalls(output) {
  const calls = [];
  const byId = new Map();
  for (const doc of documents(output)) {
    for (const ev of Array.isArray(doc) ? doc : [doc]) {
      if (!ev || typeof ev !== 'object') continue;
      // opencode: { type: 'tool_use', part: { tool, state: { input } } } once a call completed or errored.
      if (isOpencodeEvent(ev)) {
        if (ev.type === 'tool_use' && ev.part.type === 'tool') {
          const { name, input, result } = opencodeCall(ev.part);
          calls.push({ name, input, ...(result && result.isError ? { failed: true, error: String(result.text || '').slice(0, 300) } : {}), ...(opencodeStopped(ev.part) ? { stopped: true } : {}) });
        }
        continue;
      }
      // Claude Code and Qwen Code: { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } },
      // answered by { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id, content }] } }.
      const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const c of content) {
        if (c && c.type === 'tool_use') {
          const call = unwrap(String(c.name || ''), c.input);
          calls.push(call);
          if (c.id !== undefined && c.id !== null) byId.set(c.id, call);
        } else if (c && c.type === 'tool_result' && byId.has(c.tool_use_id)) {
          if (bridgeRefused(byId.get(c.tool_use_id), c)) byId.get(c.tool_use_id).refused = true;
          else if (c.is_error === true) Object.assign(byId.get(c.tool_use_id), { failed: true, error: resultText(c.content).slice(0, 300) });
        }
      }
      // Codex --json: { type: 'item.completed', item: { type: 'command_execution' | 'mcp_tool_call', ... } }. Each
      // item is also announced (item.started, item.updated) before it completes: counted once, when it completed.
      const item = ev.type === 'item.completed' || ev.type === undefined ? ev.item : null;
      if (item && item.type === 'command_execution') calls.push({ name: 'Bash', input: { command: item.command } });
      if (item && item.type === 'mcp_tool_call') {
        // An error: a failed status, an error, or a result the tool marked as one (isError).
        const failed = item.status === 'failed' || Boolean(item.error) || Boolean(item.result && typeof item.result === 'object' && (item.result.isError || item.result.is_error));
        const error = failed ? String((item.error && (item.error.message || item.error)) || '').slice(0, 300) : '';
        calls.push({ name: `mcp__${item.server}__${item.tool}`, input: item.arguments || {}, ...(failed ? { failed: true, error } : {}) });
      }
    }
  }
  // failed: the call came back an error (opencode's error status, a Claude/Qwen is_error result, a Codex
  // failed status, error or isError result): still a call; a skill load that failed isn't counted from the
  // calls (summarize's text fallback may still find its name in the transcript). stopped: opencode stopped it
  // itself (an unavailable tool, a permission rule), so no tool (no broker) ever saw it; still counted here.
  return calls.filter(c => !c.refused).map(c => ({ name: c.name, input: c.input && typeof c.input === 'object' ? c.input : {}, ...(c.failed ? { failed: true, error: c.error || '' } : {}), ...(c.stopped ? { stopped: true } : {}) }));
}

/** The parsed summary of one cycle's transcript. */
function summarize(output) {
  const calls = toolCalls(output);
  const tools = {};
  for (const c of calls) tools[c.name] = (tools[c.name] || 0) + 1;
  const skills = [...new Set(calls.filter(c => (c.name === 'Skill' || c.name === 'skill') && !c.failed).map(c => skillName(c.input.skill || c.input.command || c.input.name)).filter(Boolean))];
  // Plain-text or single-JSON transcripts: skill names written as "skill": "<name>".
  for (const m of String(output || '').matchAll(/"skill"\s*:\s*"([^"]+)"/g)) if (!skills.includes(skillName(m[1]))) skills.push(skillName(m[1]));
  const commands = calls.filter(c => SHELL_TOOLS.has(c.name) && c.input.command).map(c => String(c.input.command).slice(0, 300));
  const orders = calls.filter(c => ENTRY_TOOL.test(c.name)).map(c => ({
    contractId: c.input.contractId, side: c.input.side, size: c.input.size, type: c.input.type, rationale: String(c.input.rationale || '').slice(0, 200),
  }));
  const entries = orders.filter(o => !RISK_REDUCING.test(o.rationale));
  return {
    skills,
    tools,
    commands,
    orders,
    // An entry sent without the skills a trade decision needs (a Claude transcript lists every Skill load).
    missingSkills: entries.length && calls.length ? REQUIRED_FOR_ENTRY.filter(s => !skills.includes(s)) : [],
  };
}

/**
 * Write the cycle record and its summary line. Returns { file, summary }.
 * Never throws (logging must not stop trading).
 */
function writeCycleLog(home, { at = new Date(), action, harness, prompt, context = null, argv = [], output = '', result = null, ok = null, timedOut = false, durationMs = null }) {
  const day = tradingDayKey(at);
  const summary = summarize(output);
  const stamp = at.toISOString().slice(11, 19).replace(/:/g, '');
  const file = path.join(home, 'logs', 'cycles', day, `${stamp}-${action}.json`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      at: at.toISOString(), action, harness, ok, timedOut, durationMs, result, summary,
      // context: what the prompt was built from (runner.js), so a line can be checked against its inputs.
      prompt, context, argv: argv.map(a => (a === prompt ? '<prompt>' : a)), transcript: output,
    }, null, 2));
    fs.appendFileSync(path.join(home, 'logs', `cycles-${day}.jsonl`), `${JSON.stringify({
      at: at.toISOString(), action, harness, ok, timedOut, durationMs, result, file,
      promptChars: String(prompt || '').length, ...summary, commands: summary.commands.length,
    })}\n`);
  } catch (_err) {
    // best effort
  }
  return { file, summary };
}

module.exports = { toolCalls, summarize, writeCycleLog };
