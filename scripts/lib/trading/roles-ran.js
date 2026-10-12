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
 * Only calls that started after the last trade-executor launch ended count (a
 * launch still running or in the background ends it at its start; the one
 * placing this order excepted), so each entry has its own round of reports.
 * opencode prints a call when it ends, so two trade-executors launched at once
 * both see the same round. The gateway covers the second entry. On the same
 * root (account-gate.js counts MNQ and NQ as one root), the account gate's
 * position-open (counting orders sent moments ago) and working-orders refuse
 * it, and order-gate.js's review-before-next-entry does once the first entry,
 * on that exact contract root, is journalled. On another root, prop-one-position
 * refuses it on a prop attempt (any open position, recent order, or working
 * order), and correlated-exposure refuses a same-direction equity-index entry
 * once the first position shows. Otherwise only the autonomous-trading skill's
 * one-entry rule and max-entries limit it.
 *
 * Roles the runner served from its report cache this cycle (FTH_CYCLE_CACHED, report-cache.js: an analyst's report
 * built on the briefing parts still current, risk-manager phase 1 on the account unchanged) count as returned;
 * phase 2 is never cached and still starts after every analyst that ran.
 *
 *   roleCalls(text)                              { calls: [{ role, start, end, text }] that count, launches: trade-executor launches }
 *   rolesInTranscript(text)                      Map role -> calls that count
 *   missingRoles(calls, cycle, cached)           what a cycle still lacks, as text, [] when complete
 *   checkRolesRan(transcriptPath, cycle, cached) the gate's message, or null
 */

const fs = require('fs');
const { transcriptFiles } = require('./skills-loaded');

const ANALYSTS = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst'];
const CYCLES = ['full', 'lean'];
const TASK_TOOLS = new Set(['task', 'Task', 'Agent']);
const MAX_BYTES = 50 * 1024 * 1024;
const PHASE2 = 'risk-manager phase 2 (a second call, started after phase 1';
const EXECUTOR = 'trade-executor';
// Claude Code's answer when a subagent was launched in the background instead of run.
const LAUNCHED = /^\s*Async agent launched\b/i;
// The result's first text (an acknowledgment opens it; a report that merely mentions the words doesn't).
const resultText = c => (typeof c === 'string' ? c : Array.isArray(c) ? String((c.find(x => isObj(x) && typeof x.text === 'string') || {}).text || '') : '');

const roleOf = v => (typeof v === 'string' && v.trim() ? v.trim().split(':').pop() : null);
const isObj = v => Boolean(v) && typeof v === 'object';
const num = v => (Number.isFinite(v) ? v : null);
// A subagent's report: opencode wraps it in <task ...><task_result>...</task_result></task>; Claude's tool result is
// a string or text blocks; Qwen's response carries an output string.
const allText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => isObj(x) && typeof x.text === 'string').map(x => x.text).join('\n') : '');
const taskResult = o => { const m = /<task_result>\n?([^]*?)\n?<\/task_result>/.exec(String(o || '')); return m ? m[1] : String(o || ''); };

/** The subagent calls that returned in the foreground without an error, with their start and end, in order. */
function roleCalls(text) {
  const calls = [];
  const launches = []; // trade-executor launches: { start, end (null while running or in the background), background, pending }
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
      const role = roleOf(input.subagent_type);
      const t = isObj(st.time) ? st.time : {};
      const background = input.background === true || meta.background === true || /<task\b[^>]*\bstate="(?!completed")/.test(String(st.output || ''));
      if (role === EXECUTOR) {
        // Every launch ends the round, whatever its state; without times it ends every round so far (fails closed).
        launches.push({ start: num(t.start) ?? Infinity, end: background ? null : (num(t.end) ?? Infinity), background });
      } else if (st.status === 'completed' && !background) {
        calls.push({ role, start: num(t.start) ?? i, end: num(t.end) ?? i, text: taskResult(st.output) });
      }
    }
    const msg = isObj(ev.message) ? ev.message : {};
    for (const c of Array.isArray(msg.content) ? msg.content : []) {
      if (!isObj(c)) continue;
      if (c.type === 'tool_use' && TASK_TOOLS.has(c.name) && typeof c.id === 'string' && isObj(c.input)) {
        claude.set(c.id, { role: roleOf(c.input.subagent_type), start: i, background: c.input.run_in_background === true });
      }
      if (c.type === 'tool_result' && claude.has(c.tool_use_id)) {
        const call = claude.get(c.tool_use_id);
        // A launch acknowledgment (a subagent run in the background, by request or by default) is not a report.
        const ack = call.background || LAUNCHED.test(resultText(c.content));
        if (call.role === EXECUTOR) launches.push({ start: call.start, end: ack ? null : i, background: ack });
        else if (c.is_error !== true && !ack) calls.push({ role: call.role, start: call.start, end: i, text: allText(c.content) });
        claude.delete(c.tool_use_id);
      }
    }
    for (const p of Array.isArray(msg.parts) ? msg.parts : []) {
      const fc = isObj(p) ? p.functionCall : null;
      const fr = isObj(p) ? p.functionResponse : null;
      if (msg.role === 'model' && isObj(fc) && TASK_TOOLS.has(fc.name) && typeof fc.id === 'string' && isObj(fc.args)) {
        qwen.set(fc.id, { role: roleOf(fc.args.subagent_type), start: i, background: fc.args.run_in_background === true });
      }
      if (msg.role === 'user' && isObj(fr) && qwen.has(fr.id)) {
        const call = qwen.get(fr.id);
        const r = fr.response;
        if (call.role === EXECUTOR) launches.push({ start: call.start, end: call.background ? null : i, background: call.background });
        else if (!call.background && isObj(r) && !Object.prototype.hasOwnProperty.call(r, 'error')) calls.push({ role: call.role, start: call.start, end: i, text: typeof r.output === 'string' ? r.output : '' });
        qwen.delete(fr.id);
      }
    }
  }
  for (const m of [claude, qwen]) {
    for (const c of m.values()) if (c.role === EXECUTOR) launches.push({ start: c.start, end: null, background: c.background, pending: !c.background });
  }
  return { calls: calls.filter(c => c.role), launches };
}

function rolesInTranscript(text) {
  const counts = new Map();
  for (const c of roleCalls(text).calls) counts.set(c.role, (counts.get(c.role) || 0) + 1);
  return counts;
}

/** What the cycle still lacks before this entry, from the calls since the last trade-executor call ended. */
function missingRoles({ calls = [], launches = [] }, cycle, cached = []) {
  if (!CYCLES.includes(cycle)) return [];
  // The trade-executor launch placing this order may still be running (Claude, Qwen: no result yet); any other
  // launch, finished, errored, running or in the background, ends the round: its end, else its start.
  const pending = launches.filter(l => l.pending);
  if (pending.length > 1) return [`one trade-executor at a time (${pending.length} running)`];
  const current = pending[0] || null;
  const lastExec = Math.max(-Infinity, ...launches.filter(l => l !== current).map(l => (l.end ?? l.start)));
  const fresh = calls.filter(c => c.start > lastExec);
  const firstEnd = role => Math.min(...fresh.filter(c => c.role === role).map(c => c.end));
  const missing = [];
  // Roles served from the report cache count in the cycle's first round only: after a trade-executor launch (an
  // entry, or an attempt at one) the account and the plan changed, so every role runs again.
  const counted = lastExec === -Infinity ? cached : [];
  const needed = cycle === 'full' ? ANALYSTS.filter(r => !counted.includes(r)) : [];
  for (const r of needed) if (!fresh.some(c => c.role === r)) missing.push(r);
  const rm = fresh.filter(c => c.role === 'risk-manager');
  const ranAfter = needed.filter(r => fresh.some(c => c.role === r)).map(firstEnd);
  if (counted.includes('risk-manager')) {
    // Phase 1 served from the cache: phase 2 is a risk-manager call started after every analyst that ran.
    if (!rm.some(c => c.start > Math.max(-Infinity, ...ranAfter))) missing.push(`risk-manager phase 2 (started after ${needed.length ? 'the analysts' : 'the cached reports were given'})`);
    return missing;
  }
  if (!rm.length) return [...missing, 'risk-manager phase 1', `${PHASE2}${cycle === 'full' ? ' and the analysts' : ''} returned)`];
  // Phase 2 reviews the plan: it starts once phase 1 (and every analyst) has returned.
  const phase1End = Math.min(...rm.map(c => c.end));
  const after = Math.max(phase1End, ...ranAfter);
  if (!rm.some(c => c.start > after)) missing.push(`${PHASE2}${cycle === 'full' ? ' and the analysts' : ''} returned)`);
  return missing;
}

/**
 * The gate's check: a message naming what hasn't returned, or null. No
 * transcript or no cycle (an interactive session) -> null. A transcript the
 * runner named but that can't be read -> refused (fails closed).
 */
function checkRolesRan(transcriptPath, cycle, cached = []) {
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
  const missing = missingRoles(roleCalls(texts.join('\n')), cycle, cached);
  return missing.length
    ? `A ${cycle} cycle enters only after its roles report, in the foreground, since the last trade-executor call (trade-session skill); not returned yet: ${missing.join(', ')}. This refused trade-executor call ends the round: report the block and end the cycle (trade-session step 6); the next entry needs every role again (a role whose report the cycle prompt gave from the cache counts), then risk-manager phase 2, before its trade-executor call.`
    : null;
}

module.exports = { ANALYSTS, roleCalls, rolesInTranscript, missingRoles, checkRolesRan };
