'use strict';

/**
 * Did this autonomous cycle run its roles before an entry? The trade-session
 * skill's full cycle runs the analysts (market structure, trend and momentum,
 * volume and liquidity) and risk-manager phase 1 in parallel, then
 * risk-manager phase 2 on the plan; a lean cycle runs risk-manager phase 1 and
 * phase 2. Each analyst carries skills (market-structure, liquidity-concepts,
 * vwap-volume-profile, session-timing, trend-momentum-indicators, ...), and the
 * risk-manager carries position-sizing and prop-challenge-pacing, so a cycle
 * that skips a role decides without them. The gate refuses such an entry.
 *
 * The runner writes the cycle's transcript as the harness streams it
 * (FTH_CYCLE_TRANSCRIPT) and names the cycle (FTH_CYCLE: full | lean); the
 * Claude hook's transcript_path is read the same way. A subagent call counts
 * once it returned without an error, in any of these shapes:
 *
 *   - opencode `run --format json`: {type:'tool_use', part:{tool:'task',
 *     state:{status:'completed', input:{subagent_type}}}}
 *   - Claude stream-json and session files: message.content[] {type:'tool_use',
 *     name:'Task'|'Agent', id, input:{subagent_type}}, answered by a
 *     {type:'tool_result', tool_use_id, is_error:false}
 *   - Qwen Code's parts: {functionCall:{id, name:'task', args:{subagent_type}}}
 *     answered by {functionResponse:{id, response:{output}}} with no error
 *
 *   rolesInTranscript(text)              Map role -> completed calls
 *   missingRoles(counts, cycle)          ["market-structure-analyst", "risk-manager (2 calls: phase 1 and 2)", ...]
 *   checkRolesRan(transcriptPath, cycle) the gate's message, or null
 */

const fs = require('fs');

const ANALYSTS = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst'];
// Calls each role must have returned before an entry, by cycle.
const REQUIRED = {
  full: [...ANALYSTS.map(role => ({ role, calls: 1 })), { role: 'risk-manager', calls: 2 }],
  lean: [{ role: 'risk-manager', calls: 2 }],
};
const TASK_TOOLS = new Set(['task', 'Task', 'Agent']);
const MAX_BYTES = 50 * 1024 * 1024;

const role = v => (typeof v === 'string' && v.trim() ? v.trim().split(':').pop() : null);

/** Roles whose subagent call returned without an error, with how many times. */
function rolesInTranscript(text) {
  const counts = new Map();
  const done = r => { if (r) counts.set(r, (counts.get(r) || 0) + 1); };
  const claudeCalls = new Map(); // tool_use id -> role, until its tool_result
  const qwenCalls = new Map(); // functionCall id -> role, until its functionResponse
  for (const line of String(text || '').split('\n')) {
    if (!/subagent_type|tool_result|functionResponse/.test(line)) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { continue; }
    if (!ev || typeof ev !== 'object') continue;
    // opencode: one event per finished tool call.
    const part = ev.part && typeof ev.part === 'object' ? ev.part : null;
    if (ev.type === 'tool_use' && part && TASK_TOOLS.has(part.tool)) {
      const st = part.state || {};
      if (st.status === 'completed' && st.input && typeof st.input === 'object') done(role(st.input.subagent_type));
    }
    const msg = ev.message && typeof ev.message === 'object' ? ev.message : {};
    if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'tool_use' && TASK_TOOLS.has(c.name) && typeof c.id === 'string' && c.input) claudeCalls.set(c.id, role(c.input.subagent_type));
        if (c.type === 'tool_result' && claudeCalls.has(c.tool_use_id)) {
          if (c.is_error !== true) done(claudeCalls.get(c.tool_use_id));
          claudeCalls.delete(c.tool_use_id);
        }
      }
    }
    for (const p of Array.isArray(msg.parts) ? msg.parts : []) {
      const fc = p && typeof p === 'object' ? p.functionCall : null;
      const fr = p && typeof p === 'object' ? p.functionResponse : null;
      if (msg.role === 'model' && fc && TASK_TOOLS.has(fc.name) && typeof fc.id === 'string' && fc.args) qwenCalls.set(fc.id, role(fc.args.subagent_type));
      if (msg.role === 'user' && fr && qwenCalls.has(fr.id)) {
        const r = fr.response;
        if (r && typeof r === 'object' && !Object.prototype.hasOwnProperty.call(r, 'error')) done(qwenCalls.get(fr.id));
        qwenCalls.delete(fr.id);
      }
    }
  }
  return counts;
}

/** The roles (with their call counts) a cycle still lacks; an unknown cycle needs nothing. */
function missingRoles(counts, cycle) {
  return (REQUIRED[cycle] || []).filter(r => (counts.get(r.role) || 0) < r.calls)
    .map(r => (r.calls > 1 ? `${r.role} (${r.calls} calls: phase 1 and phase 2; ${counts.get(r.role) || 0} returned)` : r.role));
}

/**
 * The gate's check: a message naming the roles that haven't returned, or null.
 * No transcript or no cycle (an interactive session) -> null. A transcript the
 * runner named but that can't be read -> refused (fails closed).
 */
function checkRolesRan(transcriptPath, cycle) {
  if (!transcriptPath || !REQUIRED[cycle]) return null;
  let text;
  try {
    const st = fs.statSync(transcriptPath);
    const fd = fs.openSync(transcriptPath, 'r');
    const len = Math.min(st.size, MAX_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (err) {
    return `The cycle's transcript can't be read (${err.code || err.message}), so the gate can't see which roles ran: no entry this cycle.`;
  }
  const missing = missingRoles(rolesInTranscript(text), cycle);
  return missing.length
    ? `A ${cycle} cycle enters only after its roles report (trade-session skill); not returned yet: ${missing.join(', ')}. Run each as a subagent by its agent name, wait for its report, use it in the plan, then enter.`
    : null;
}

module.exports = { ANALYSTS, REQUIRED, rolesInTranscript, missingRoles, checkRolesRan };
