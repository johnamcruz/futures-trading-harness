'use strict';

/**
 * When a cycle acted relative to its bar, for the cycle log (cycle-log.js `timing`) and the replay report
 * (replay/report.js): measurement only, nothing here changes what a cycle does.
 *
 * The timeline, on the cycle's own clock (the replay clock's in a replay, as the gate reads it: harness-now.js; the
 * wall clock live): the cycle starts at its time (`cycleAtMs`), and every later moment is that time plus the wall time
 * the run had taken by then. In a replay that is the projected live latency: the replay clock is pinned at the decision
 * time and the replay broker fills at the bar, so only the run's own time is added. Times read from the transcript,
 * each event's own when it carries one:
 *
 *   - opencode `run --format json`: a task call's state.time {start, end}; the head trader's text event's part.time.end
 *     or the event's timestamp
 *   - Claude stream-json / Qwen Code: a Task/Agent tool_use (start) answered by its tool_result (end); Qwen's session
 *     parts: functionCall answered by functionResponse; the event's `timestamp` (ms or ISO) when it has one
 *   - otherwise the time the run's line arrived (harness-run.js `lineTimes`, standard output's lines in order);
 *     a whole-document transcript (Qwen's JSON array) has neither, so its roles carry no times
 *
 * The decision on the bar: the first of an ENTRY order call (a place_order whose rationale isn't [exit] or [protect],
 * cycle-log.js RISK_REDUCING) and the head trader's last CYCLE RESULT line with an outcome other than error
 * (autotrader.js outcomeOf); a trade-executor launch is not one (it may only trail a stop). With none timed, the
 * cycle's end, when the run finished and wrote such a result. The order: the first entry place_order the gate logged
 * (gate log, wall `ts`) during the run, else one in the transcript, with the gate's answer (allowed or refused).
 * The gate log's records are this cycle's by its id (check-order.js cycleId, stamped by the gateway), within the run's
 * window (its wall start to its end and the log write's slack).
 *
 * The deadline: a setup's bar is superseded when the next bar closes. When that next bar falls outside the session
 * (trading/clock.js inMarketHours: the daily halt, the weekend; or after the runner's end of day, context.eodAt) there
 * is no deadline: neither overran nor missed is counted.
 *
 *   transcriptTimes(text, lineTimes)   { roles: [{ role, start, end, ok }], resultAt, orders: [{ ms, entry }] } (wall ms)
 *   gateEntries(env, fromMs, toMs)     [{ ms, decision, entry }] this cycle's place_order decisions in the gate log
 *   barWindow(context, minutes)        { barClose, nextClose, setup, deadline } (ms; nulls without bars or a session)
 *   cycleTiming(input)                 the cycle log's `timing` record
 *   runTiming(run)                     cycleTiming for a run as cycle-run.js ran it (its clock, its gate log), or null
 *   timingReport(cycles)               { all, setup, quiet }: latencies, overruns, setups decided/entered in time or
 *                                      missed, per-role median
 *
 * Never throws on a malformed transcript or gate log: what it can't read it leaves out.
 */

const { inMarketHours } = require('./trading/clock');
const { RISK_REDUCING } = require('./cycle-log');

const TASK_TOOLS = new Set(['task', 'Task', 'Agent']);
const RESULT_LINE = /CYCLE RESULT:[^\n]*/g;
const ORDER_TOOL = /(^|__|_)place_order$/;
// After the run's end, the slack for the gate log's write (cycle-log.js, replay/labels.js GATE_SLACK_MS).
const GATE_SLACK_MS = 2000;

const isObj = v => Boolean(v) && typeof v === 'object';
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const msOf = v => num(v) ?? (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const roleOf = v => (typeof v === 'string' && v.trim() ? v.trim().split(':').pop() : null);
const minOf = xs => { const v = xs.filter(x => x !== null && x !== undefined); return v.length ? Math.min(...v) : null; };
const isEntry = rationale => !RISK_REDUCING.test(String(rationale || ''));

/** A text that holds a decision: a CYCLE RESULT line with an outcome other than error ("(none reported)" has none). */
function decides(text) {
  const { outcomeOf } = require('./autotrader');
  return (String(text || '').match(RESULT_LINE) || []).some(l => { const o = outcomeOf(l); return Boolean(o) && o !== 'error'; });
}

/** The transcript's events with the line each came from (null for a whole-document transcript). */
function events(text) {
  const s = String(text || '');
  try {
    const doc = JSON.parse(s.trim());
    return (Array.isArray(doc) ? doc : [doc]).filter(isObj).map(ev => ({ ev, line: null }));
  } catch (_err) {
    const out = [];
    s.split('\n').forEach((l, line) => {
      if (!l.trim().startsWith('{')) return;
      try { const ev = JSON.parse(l); if (isObj(ev)) out.push({ ev, line }); } catch (_e) { /* not an event */ }
    });
    return out;
  }
}

/** The role calls, the last decision line and the order calls a transcript shows, in wall ms. */
function transcriptTimes(text, lineTimes = null) {
  const roles = [];
  const orders = [];
  const decided = [];
  const pending = new Map(); // a Claude/Qwen call's id -> { role, start }
  for (const { ev, line } of events(text)) {
    const at = msOf(ev.timestamp) ?? (line !== null && Array.isArray(lineTimes) ? num(lineTimes[line]) : null);
    const part = isObj(ev.part) ? ev.part : null;
    // opencode: a finished call with its own times; the head trader's text.
    if (part && ev.type === 'tool_use' && isObj(part.state)) {
      const st = part.state;
      const t = isObj(st.time) ? st.time : {};
      const input = isObj(st.input) ? st.input : {};
      if (TASK_TOOLS.has(part.tool)) roles.push({ role: roleOf(input.subagent_type), start: num(t.start) ?? at, end: num(t.end) ?? at, ok: st.status === 'completed' });
      else if (ORDER_TOOL.test(String(part.tool || ''))) orders.push({ ms: num(t.start) ?? at, entry: isEntry(input.rationale) });
    }
    if (part && ev.type === 'text' && decides(part.text)) decided.push(num(isObj(part.time) ? part.time.end : null) ?? at);
    // Claude stream-json and Qwen Code: tool_use answered by tool_result; text with the result line.
    const msg = isObj(ev.message) ? ev.message : {};
    for (const c of Array.isArray(msg.content) ? msg.content : []) {
      if (!isObj(c)) continue;
      if (c.type === 'tool_use' && TASK_TOOLS.has(c.name) && isObj(c.input)) pending.set(c.id, { role: roleOf(c.input.subagent_type), start: at });
      else if (c.type === 'tool_use' && ORDER_TOOL.test(String(c.name || ''))) orders.push({ ms: at, entry: isEntry(isObj(c.input) ? c.input.rationale : '') });
      else if (c.type === 'tool_result' && pending.has(c.tool_use_id)) {
        roles.push({ ...pending.get(c.tool_use_id), end: at, ok: c.is_error !== true });
        pending.delete(c.tool_use_id);
      } else if (c.type === 'text' && ev.type === 'assistant' && decides(c.text)) decided.push(at);
    }
    if (ev.type === 'result' && decides(ev.result)) decided.push(at);
    // Qwen's session parts.
    for (const p of Array.isArray(msg.parts) ? msg.parts : []) {
      if (!isObj(p)) continue;
      const fc = isObj(p.functionCall) ? p.functionCall : null;
      const fr = isObj(p.functionResponse) ? p.functionResponse : null;
      if (fc && TASK_TOOLS.has(fc.name) && isObj(fc.args)) pending.set(fc.id, { role: roleOf(fc.args.subagent_type), start: at });
      else if (fc && ORDER_TOOL.test(String(fc.name || ''))) orders.push({ ms: at, entry: isEntry(isObj(fc.args) ? fc.args.rationale : '') });
      if (fr && pending.has(fr.id)) {
        roles.push({ ...pending.get(fr.id), end: at, ok: !(isObj(fr.response) && Object.prototype.hasOwnProperty.call(fr.response, 'error')) });
        pending.delete(fr.id);
      }
      if (msg.role === 'model' && decides(p.text)) decided.push(at);
    }
    // Codex: the agent's message item.
    if (isObj(ev.item) && ev.item.type === 'agent_message' && decides(ev.item.text)) decided.push(at);
  }
  // A call still running when the run ended: started, never answered.
  for (const c of pending.values()) roles.push({ ...c, end: null, ok: false });
  // The head trader's last decision line (a later one restates or replaces an earlier one).
  const resultAt = decided.length ? decided.at(-1) : null;
  return { roles: roles.filter(r => r.role), resultAt, orders: orders.filter(o => o.ms !== null) };
}

/**
 * This cycle's place_order decisions in the gate log between fromMs and toMs, as the cycle log reads them
 * (cycle-log.js gateOrders: the gateway's records stamped with this cycle's id, check-order.js cycleId from the run's
 * env; a tracker refusal folded into the allowed record it follows): [{ ms, decision, entry }], in order. Another
 * cycle's, home's or session's orders in the same window are never this cycle's; no cycle id, none.
 */
function gateEntries(env, fromMs, toMs) {
  return require('./cycle-log').gateOrders(env, fromMs, toMs)
    .map(e => ({ ms: e.ms, decision: e.decision || null, entry: isEntry(e.rationale) }))
    .sort((a, b) => a.ms - b.ms);
}

/** The next bar is in the session: the market is open from the bar's close to the next close, before the end of day. */
function nextBarInSession(close, next, eodAt) {
  const eod = Date.parse(String(eodAt || ''));
  return inMarketHours(new Date(close)) && inMarketHours(new Date(next - 1)) && !(Number.isFinite(eod) && next > eod);
}

/**
 * The cycle's bars (context.symbols, runner.js): the latest bar close, the next bar close (the earliest symbol's bar
 * after its own: the bar is superseded then), whether a setup is on the table (a fired candidate) and its deadline
 * (the next close of a symbol with one). `minutes`: the runner's timeframe; a lane's ("3m") wins. A next close outside
 * the session (nextBarInSession) is null, and so is a deadline on it.
 */
function barWindow(context, minutes) {
  const syms = ((context && context.symbols) || []).filter(x => isObj(x) && isObj(x.bar) && Number.isFinite(Date.parse(x.bar.t)));
  const eodAt = context && context.eodAt;
  const rows = syms.map(x => {
    const m = /^(\d+)m$/.exec(String(x.lane || ''));
    const mins = m ? Number(m[1]) : num(minutes);
    const close = mins ? Date.parse(x.bar.t) + mins * 60000 : null;
    const next = close === null ? null : close + mins * 60000;
    return { close, next: next !== null && nextBarInSession(close, next, eodAt) ? next : null, setup: Array.isArray(x.fired) && x.fired.length > 0 };
  }).filter(r => r.close !== null);
  if (!rows.length) return { barClose: null, nextClose: null, setup: false, deadline: null };
  const setups = rows.filter(r => r.setup);
  const earliest = rs => (rs.some(r => r.next === null) ? null : Math.min(...rs.map(r => r.next)));
  return { barClose: Math.max(...rows.map(r => r.close)), nextClose: earliest(rows), setup: setups.length > 0, deadline: setups.length ? earliest(setups) : null };
}

const iso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/**
 * The cycle's timing record. Input: { text (the transcript), lineTimes, context, minutes, startedMs and endedMs (the
 * run's wall start and end), cycleAtMs (the cycle's own time at its start), replay, gate ([{ ms, decision, entry }] from
 * gateEntries), ok, timedOut, result }.
 */
function cycleTiming({ text = '', lineTimes = null, context = null, minutes = null, startedMs, endedMs, cycleAtMs = startedMs, replay = false, gate = [], ok = null, timedOut = false, result = null }) {
  const onClock = w => (w === null || w === undefined ? null : cycleAtMs + (w - startedMs));
  const t = transcriptTimes(text, lineTimes);
  // The gate's records when it logged any order (it sees the executor's too), else the transcript's calls.
  const gated = (gate || []).length > 0;
  const entries = (gated ? gate : t.orders).filter(o => o.entry).sort((a, b) => a.ms - b.ms);
  const first = entries[0] || null;
  const orderDecision = !first || !gated ? null : first.decision === 'allowed' ? 'allowed' : 'refused';
  let decision = minOf([first && first.ms, t.resultAt]);
  let decisionFrom = decision === null ? null : 'transcript';
  if (decision === null && ok && !timedOut && decides(result)) [decision, decisionFrom] = [endedMs, 'end'];
  const bars = barWindow(context, minutes);
  const at = { decision: onClock(decision), order: onClock(first && first.ms), end: onClock(endedMs) };
  const since = x => (x === null || bars.barClose === null ? null : x - bars.barClose);
  const record = {
    clock: replay ? 'replay' : 'wall',
    barClose: iso(bars.barClose), nextBarClose: iso(bars.nextClose),
    start: iso(cycleAtMs), decision: iso(at.decision), decisionFrom, order: iso(at.order), orderDecision, orders: entries.length, end: iso(at.end),
    roles: t.roles.map(r => ({ role: r.role, start: iso(onClock(r.start)), end: iso(onClock(r.end)), ms: r.start !== null && r.end !== null ? r.end - r.start : null, ...(r.ok ? {} : { ok: false }) })),
    cycleMs: endedMs - startedMs,
    latencyMs: { start: since(cycleAtMs), decision: since(at.decision), order: since(at.order) },
    // The decision came after the next bar closed (no decision: the cycle's end did); null without a next bar in session.
    overran: bars.nextClose === null ? null : (at.decision ?? at.end) > bars.nextClose,
    setup: bars.setup,
  };
  if (bars.setup) {
    // Decided in time (an entry order or the decision line before the bar was superseded); entered in time (an entry
    // the gate allowed before then). No deadline (the next bar outside the session): neither is counted.
    const due = bars.deadline;
    record.setupCaught = due === null ? null : at.decision !== null && at.decision <= due;
    record.enteredInTime = due === null ? null : at.order !== null && at.order <= due && orderDecision !== 'refused';
    record.setupMissed = due === null || record.setupCaught ? null : timedOut ? 'timeout' : at.decision !== null ? 'overran' : 'error';
  }
  return record;
}

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};

function group(timings) {
  const lat = k => timings.map(x => x.latencyMs && num(x.latencyMs[k])).filter(x => x !== null);
  const roles = {};
  for (const r of timings.flatMap(x => x.roles || [])) if (r && r.role && num(r.ms) !== null) (roles[r.role] = roles[r.role] || []).push(r.ms);
  const missedBy = {};
  for (const x of timings) if (x.setupMissed) missedBy[x.setupMissed] = (missedBy[x.setupMissed] || 0) + 1;
  const stat = xs => ({ n: xs.length, median: quantile(xs, 0.5), p90: quantile(xs, 0.9) });
  return {
    cycles: timings.length, replay: timings.filter(x => x.clock === 'replay').length,
    decision: stat(lat('decision')), order: stat(lat('order')), overran: timings.filter(x => x.overran).length,
    decidedInTime: timings.filter(x => x.setupCaught === true).length, enteredInTime: timings.filter(x => x.enteredInTime === true).length,
    missed: timings.filter(x => x.setupCaught === false).length, missedBy, noDeadline: timings.filter(x => x.setup && x.setupCaught === null).length,
    roleMedianMs: Object.fromEntries(Object.entries(roles).sort().map(([k, v]) => [k, quantile(v, 0.5)])),
  };
}

/** The cycles' timing, over the cycles with a bar: all of them, setup bars and quiet bars. `cycles`: [{ timing }]. */
function timingReport(cycles) {
  const timed = (cycles || []).map(c => c && c.timing).filter(x => isObj(x) && x.barClose);
  return { all: group(timed), setup: group(timed.filter(x => x.setup)), quiet: group(timed.filter(x => !x.setup)) };
}

/**
 * The timing of one run as cycle-run.js ran it: `res` (the run's result: stdout/output, lineTimes, env), the cycle's
 * `context` and `result`, `startedMs`/`endedMs` (wall), `now` (the cycle's time the runner gave it). The cycle's own
 * clock is the replay clock's when one is in force in the run's env (as the gate reads it), else `now`; the gate log's
 * records are the run's own (its env's cycle id). Null when it can't be built (logging never stops a cycle).
 */
function runTiming({ res, cfg, context, env, startedMs, endedMs, now, result }) {
  try {
    const runEnv = (res && res.env) || env || {};
    // The cycle's own time as the cycle log files it (cycle-log.js cycleClock: the replay clock's in a replay).
    const clock = require('./cycle-log').cycleClock(runEnv, now);
    const cycleAtMs = clock.cycleAt.getTime();
    const lineTimes = Array.isArray(res.lineTimes) ? res.lineTimes : null;
    const gate = gateEntries(runEnv, startedMs, endedMs + GATE_SLACK_MS);
    return cycleTiming({
      text: lineTimes ? res.stdout : res.output, lineTimes, context, minutes: cfg && cfg.timeframe, startedMs, endedMs, cycleAtMs,
      replay: clock.replay, gate, ok: res.ok, timedOut: res.timedOut, result,
    });
  } catch (_err) {
    return null;
  }
}

module.exports = { transcriptTimes, gateEntries, barWindow, cycleTiming, runTiming, timingReport };
