'use strict';

/**
 * Did this autonomous cycle run its roles before an entry? The trade-session
 * skill's full cycle runs the analysts (market structure, trend and momentum,
 * volume and liquidity) and risk-manager phase 1, then risk-manager phase 2 on
 * the plan; a lean cycle runs risk-manager phase 1, then phase 2. Each analyst
 * carries skills (market-structure, liquidity-concepts, vwap-volume-profile,
 * session-timing, trend-momentum-indicators, ...), and the risk-manager
 * carries position-sizing and prop-challenge-pacing, so a cycle that skips a
 * role decides without them. The gate refuses such an entry.
 *
 * The runner writes the cycle's transcript as the harness streams it
 * (FTH_CYCLE_TRANSCRIPT, a file per run) and names the cycle (FTH_CYCLE: full |
 * lean); a hook's transcript_path is read the same way, with its main
 * session's for a Claude subagent (the trade-executor places the order).
 *
 * A call counts once it returned without an error, in the foreground (a
 * background launch returns at once, before any report), in any of these
 * shapes, each with a start and an end in the transcript's own order:
 *
 *   - opencode `run --format json`: {type:'tool_use', part:{tool:'task',
 *     state:{status:'completed', input:{subagent_type}, time:{start, end}}}}
 *   - Claude stream-json and session files: message.content[] {type:'tool_use',
 *     name:'Task'|'Agent', id, input:{subagent_type}} (its line is the start),
 *     answered by {type:'tool_result', tool_use_id, is_error:false} (the end)
 *   - Qwen Code's parts: {functionCall:{id, name:'task', args:{subagent_type}}}
 *     answered by {functionResponse:{id, response:{output}}} with no error
 *
 * Only calls that started after the last trade-executor call ended count, so
 * each entry has its own round of reports. Phase 2 is a risk-manager call that
 * started after phase 1 (and, in a full cycle, every analyst) had returned.
 *
 *   roleCalls(text)                      [{ role, start, end }] of the calls that count
 *   rolesInTranscript(text)              Map role -> calls that count
 *   missingRoles(calls, cycle)           what a cycle still lacks, as text, [] when complete
 *   checkRolesRan(transcriptPath, cycle) the gate's message, or null
 */

const fs = require('fs');
const { transcriptFiles } = require('./skills-loaded');

const ANALYSTS = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst'];
const CYCLES = ['full', 'lean'];
const TASK_TOOLS = new Set(['task', 'Task', 'Agent']);
const MAX_BYTES = 50 * 1024 * 1024;
const PHASE2 = 'risk-manager phase 2 (a second call, started after phase 1';

const roleOf = v => (typeof v === 'string' && v.trim() ? v.trim().split(':').pop() : null);
const isObj = v => Boolean(v) && typeof v === 'object';
const num = v => (Number.isFinite(v) ? v : null);

/** The subagent calls that returned in the foreground without an error, with their start and end, in order. */
function roleCalls(text) {
  const calls = [];
  const claude = new Map(); // tool_use id -> { role, start }
  const qwen = new Map(); // functionCall id -> { role, start }
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/subagent_type|tool_result|functionResponse/.test(line)) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { continue; }
    if (!isObj(ev)) continue;
    // opencode: one event per finished call, with the call's own start and end times.
    const part = isObj(ev.part) ? ev.part : null;
    if (ev.type === 'tool_use' && part && TASK_TOOLS.has(part.tool) && isObj(part.state)) {
      const st = part.state;
      const input = isObj(st.input) ? st.input : {};
      const meta = isObj(st.metadata) ? st.metadata : {};
      const running = /<task\b[^>]*\bstate="(?!completed")/.test(String(st.output || ''));
      if (st.status === 'completed' && input.background !== true && meta.background !== true && !running) {
        const t = isObj(st.time) ? st.time : {};
        calls.push({ role: roleOf(input.subagent_type), start: num(t.start) ?? i, end: num(t.end) ?? i });
      }
    }
    const msg = isObj(ev.message) ? ev.message : {};
    for (const c of Array.isArray(msg.content) ? msg.content : []) {
      if (!isObj(c)) continue;
      if (c.type === 'tool_use' && TASK_TOOLS.has(c.name) && typeof c.id === 'string' && isObj(c.input) && c.input.run_in_background !== true) {
        claude.set(c.id, { role: roleOf(c.input.subagent_type), start: i });
      }
      if (c.type === 'tool_result' && claude.has(c.tool_use_id)) {
        if (c.is_error !== true) calls.push({ ...claude.get(c.tool_use_id), end: i });
        claude.delete(c.tool_use_id);
      }
    }
    for (const p of Array.isArray(msg.parts) ? msg.parts : []) {
      const fc = isObj(p) ? p.functionCall : null;
      const fr = isObj(p) ? p.functionResponse : null;
      if (msg.role === 'model' && isObj(fc) && TASK_TOOLS.has(fc.name) && typeof fc.id === 'string' && isObj(fc.args) && fc.args.run_in_background !== true) {
        qwen.set(fc.id, { role: roleOf(fc.args.subagent_type), start: i });
      }
      if (msg.role === 'user' && isObj(fr) && qwen.has(fr.id)) {
        const r = fr.response;
        if (isObj(r) && !Object.prototype.hasOwnProperty.call(r, 'error')) calls.push({ ...qwen.get(fr.id), end: i });
        qwen.delete(fr.id);
      }
    }
  }
  return calls.filter(c => c.role);
}

function rolesInTranscript(text) {
  const counts = new Map();
  for (const c of roleCalls(text)) counts.set(c.role, (counts.get(c.role) || 0) + 1);
  return counts;
}

/** What the cycle still lacks before this entry, from the calls since the last trade-executor call ended. */
function missingRoles(calls, cycle) {
  if (!CYCLES.includes(cycle)) return [];
  const lastExec = Math.max(-Infinity, ...calls.filter(c => c.role === 'trade-executor').map(c => c.end));
  const fresh = calls.filter(c => c.start > lastExec);
  const firstEnd = role => Math.min(...fresh.filter(c => c.role === role).map(c => c.end));
  const missing = [];
  const needed = cycle === 'full' ? ANALYSTS : [];
  for (const r of needed) if (!fresh.some(c => c.role === r)) missing.push(r);
  const rm = fresh.filter(c => c.role === 'risk-manager');
  if (!rm.length) return [...missing, 'risk-manager phase 1', `${PHASE2}${cycle === 'full' ? ' and the analysts' : ''} returned)`];
  // Phase 2 reviews the plan: it starts once phase 1 (and every analyst) has returned.
  const phase1End = Math.min(...rm.map(c => c.end));
  const after = Math.max(phase1End, ...needed.filter(r => fresh.some(c => c.role === r)).map(firstEnd));
  if (!rm.some(c => c.start > after)) missing.push(`${PHASE2}${cycle === 'full' ? ' and the analysts' : ''} returned)`);
  return missing;
}

/**
 * The gate's check: a message naming what hasn't returned, or null. No
 * transcript or no cycle (an interactive session) -> null. A transcript the
 * runner named but that can't be read -> refused (fails closed).
 */
function checkRolesRan(transcriptPath, cycle) {
  if (!transcriptPath || !CYCLES.includes(cycle)) return null;
  // A Claude subagent's hook gets its own transcript: the roles ran in its main session's.
  const files = transcriptFiles(transcriptPath).reverse();
  const texts = [];
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      const len = Math.min(st.size, MAX_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      fs.closeSync(fd);
      texts.push(buf.toString('utf8'));
    } catch (err) {
      if (file === transcriptPath) return `The cycle's transcript can't be read (${err.code || err.message}), so the gate can't see which roles ran: no entry this cycle.`;
    }
  }
  const missing = missingRoles(roleCalls(texts.join('\n')), cycle);
  return missing.length
    ? `A ${cycle} cycle enters only after its roles report, in the foreground, since the last trade-executor call (trade-session skill); not returned yet: ${missing.join(', ')}. Run each as a subagent by its agent name, wait for its report, use it in the plan, then enter.`
    : null;
}

module.exports = { ANALYSTS, roleCalls, rolesInTranscript, missingRoles, checkRolesRan };
