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
 * event per line, tool calls included); Codex with --json; others as text.
 * The parser reads what it recognizes and never throws.
 */

const fs = require('fs');
const path = require('path');
const { tradingDayKey } = require('./trading/clock');
const { REQUIRED_FOR_ENTRY, skillName } = require('./trading/skills-loaded');

const ENTRY_TOOL = /(^|__)place_order$/;
const RISK_REDUCING = /^\s*\[(exit|protect)\]/i;

/** Every tool call in a stream-json / JSONL transcript: [{ name, input }]. */
function toolCalls(output) {
  const calls = [];
  for (const line of String(output || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(t); } catch (_err) { continue; }
    // Claude Code: { type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }
    const content = ev && ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
    for (const c of content) if (c && c.type === 'tool_use') calls.push({ name: String(c.name || ''), input: c.input || {} });
    // Codex --json: { type: 'item.completed', item: { type: 'command_execution' | 'mcp_tool_call', ... } }
    const item = ev && ev.item;
    if (item && item.type === 'command_execution') calls.push({ name: 'Bash', input: { command: item.command } });
    if (item && item.type === 'mcp_tool_call') calls.push({ name: `mcp__${item.server}__${item.tool}`, input: item.arguments || {} });
  }
  return calls;
}

/** The parsed summary of one cycle's transcript. */
function summarize(output) {
  const calls = toolCalls(output);
  const tools = {};
  for (const c of calls) tools[c.name] = (tools[c.name] || 0) + 1;
  const skills = [...new Set(calls.filter(c => c.name === 'Skill').map(c => skillName(c.input.skill || c.input.command || c.input.name)).filter(Boolean))];
  // Plain-text or single-JSON transcripts: skill names written as "skill": "<name>".
  for (const m of String(output || '').matchAll(/"skill"\s*:\s*"([^"]+)"/g)) if (!skills.includes(skillName(m[1]))) skills.push(skillName(m[1]));
  const commands = calls.filter(c => c.name === 'Bash' && c.input.command).map(c => String(c.input.command).slice(0, 300));
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
