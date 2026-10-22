'use strict';

/**
 * The runner's entry (docs/TOOL-CALLS-AND-ORCHESTRATION.md, "The entry, the second workflow"; workflows/entry): in a
 * cycle where the runner runs the entry (runner.js entryCycle: a harness that runs a role on its own, autotrader.js
 * ROLE_RUNS; one symbol, a full trade cycle that is not
 * manage-only or paper, started flat with no working orders, its desk complete in the runner's role record or the
 * report cache), the head trader's job ends at its decision: an OK compose_check, then `CYCLE RESULT: planned`. The
 * runner then runs, in code, with the same roles (the design stays multi-agent; only the sequence is code):
 *
 *   1. the compose record the decision rests on: the latest record on the cycle's briefing bar for the root
 *      (lifecycle-gate.js recordsAt), which must be OK; `planned` without one is a process failure, logged, and
 *      nothing runs (the cycle's result stays the head trader's);
 *   2. the head trader's loaded skills, derived in code from its run's transcript (skills-loaded.js
 *      skillsInTranscript), recorded in the cycle's role record (runner-roles.js appendHeadSkills): the trade-executor
 *      is a session of its own, so the gate counts the decider's loads from the record;
 *   3. phase `review`: risk-manager phase 2 on the record (orchestrate/requests.js review), its run recorded with its
 *      wall-clock times (the gate orders it after phase 1 and the analysts, as a launch);
 *   4. between the phases, in code: phase 2's verdict (roles-ran.js verdictOf: anything but APPROVE stops the entry, a
 *      VETO is the cycle's no-trade with its line); the order by order_plan's own path (harness-tools/order-plan.js:
 *      trading/lifecycle-order.js composedOrder, and in a prop attempt the policy verdict it records), so its
 *      rationale and brackets are exactly what the gate checks; the journal plan for this bar (kind plan, contractId)
 *      through the broker adapter (journalAdd), which the gate's plan-required check reads;
 *      and, just before the executor, no late entry (trading/late-entry.js, the gate's own check): the newest closed 1m
 *      bar read through the adapter (`now`: the harness clock) is recorded for the gate, and a price beyond the plan's
 *      stop, past its entry against it by more than gate.lateEntryDriftShare of the stop distance, or no current price
 *      is a pass: outcome `late`, the cycle's no-trade with why, no executor run;
 *   5. phase `execute`: the trade-executor with those exact arguments and phase 2's verdict line, never run again (the
 *      workflow's orders phase: retries 0), its run recorded (it ends the round, as a launch does);
 *   6. the after-order read through the adapter (accountState): the cycle's outcome. Executed when the account shows a
 *      position on the root's family or the gateway recorded this record's entry (entry-orders.json); else blocked with
 *      the gate's refusal (its log, this cycle's id) or the executor's own BLOCKED or ABORTED report; else a failed
 *      run, a no-trade with why. A lost or late broker reply never sends a second entry: nothing here retries the order.
 *
 *   entryDue(records)        { run: true, record } | { run: false, why }: the latest record on the bar, OK or not
 *   plannedDrift(result, rec)  why the head trader's planned line (its side, its size) isn't the record's, or null
 *   verdictLine(text)        phase 2's VERDICT line, as written
 *   entryOutcome({ ... })    { outcome, result, why } from the after-order facts
 *   runEntry(deps, cycle)    null (the result isn't `planned`: nothing for the runner) or { result, entry }
 *     deps:  { workflow, runRole, client, home, cfg, root, env, log, wallNow, now, perRoleMs, childEnv, lookups, orderPlan }
 *            (`orderPlan`: harness-tools/order-plan.js plan, the order_plan tool's own operation; a test's stand-in)
 *     cycle: { result, output, headEnv, symbol, contractId, bar, bars, at, accountId, context, rolesFile, reports, budgetMs,
 *              startedWall (the wall ms the head trader's run began) }
 *   The cycle log's `entry.timing`: barClose, headMs (bar close to the head trader's planned), phase2Ms, executorMs,
 *   orderMs (bar close to the order sent: the gate log's allowed decision of this cycle's order; for an expired record,
 *   to order_plan's refusal; else null); outcome `expired`: the record ran out first.
 */

const fs = require('fs');
const { outcomeOf } = require('./autotrader');
const { verdictOf } = require('./trading/roles-ran');
const { recordsAt } = require('./trading/lifecycle-gate');
const { renderRecord } = require('./trading/trade-lifecycle');
const { skillsInTranscript, claudeLookupsInTranscript } = require('./trading/skills-loaded');
const { familyRoot } = require('./trading/contracts');
const { contractRoot } = require('./trading/journal');
const { isOpen } = require('./trading/positions');
const RR = require('./trading/runner-roles');
const { ORDER_REFUSED } = require('./orchestrate/checks');
const LE = require('./trading/late-entry');

const STRATEGY = 'trade_lifecycle';
const famOf = id => familyRoot(contractRoot(id));
// A refusal or report as the result line and the logs carry it: one line, cut at the plan's length (config/runner.json).
const CUT = () => require('./tunables').runner().prompt.planChars;
// The 1m bars read for the latest price before the order, as many as the signal age limit counts (config/runner.json);
// the newest closed one is the price.
const LE_BARS = require('./tunables').runner().gate.signalMaxAgeBars;
const short = text => { const n = CUT(); const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };

/** The decision's record: the latest compose record on the cycle's bar for the root (any side); it must be OK. */
function entryDue(records) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return { run: false, why: 'planned without a compose record on the cycle\'s bar' };
  const rec = list[list.length - 1];
  if (!rec || rec.ok !== true) return { run: false, why: `planned without an OK compose record on the cycle's bar (the latest, ${rec && rec.id}, is not OK)` };
  if (rec.side !== 'long' && rec.side !== 'short') return { run: false, why: `the compose record ${rec.id} has no side` };
  return { run: true, record: rec };
}

/**
 * Why the head trader's `planned` line isn't the record's decision, or null: the side it names (the first "long" or
 * "short" in its reason) must be the record's, and a size it states right after the side the record's size. A line
 * that names no side can't be matched (a model may drift between sides: the record alone never decides).
 */
function plannedDrift(result, rec) {
  const reason = String(result || '').replace(/^[^-]*-/, '');
  const m = /\b(long|short)\b(?:\s+(\d+)\b)?/i.exec(reason);
  if (!m) return `the planned line names no side, so it can't be matched to the compose record ${rec.id} (${rec.side})`;
  if (m[1].toLowerCase() !== rec.side) return `the planned line says ${m[1].toLowerCase()}, the latest OK compose record ${rec.id} is a ${rec.side}`;
  const size = rec.plan && Number.isInteger(rec.plan.size) ? rec.plan.size : null;
  if (m[2] !== undefined && Number(m[2]) !== size) return `the planned line says size ${m[2]}, the compose record ${rec.id} states ${size}`;
  return null;
}

/** Phase 2's VERDICT line, as written (the first line stating a verdict: "VERDICT: ..." or "Verdict - ..."), or ''. */
const verdictLine = text => (String(text || '').split('\n').find(l => /\bverdict\b[*_`\s]*[:-]/i.test(l)) || '').trim();

/**
 * The gate's last refusal of a place_order in this cycle (the gate log, stamped with the cycle's id: check-order.js
 * cycleId), at or after `sinceMs`: { checks, message } or null. Never throws.
 */
function gateRefusal(env, id, sinceMs) {
  const d = gateDecision(env, id, sinceMs);
  return d && d.decision === 'blocked' ? { checks: d.checks, message: d.message } : null;
}

/**
 * The gate's last place_order decision of this cycle at or after `sinceMs`: { decision: allowed | blocked, checks,
 * message } or null. `allowed` means the order went to the broker (whatever its reply). Never throws.
 */
function gateDecision(env, id, sinceMs) {
  try {
    const { gateLogPath } = require('./trading/check-order');
    const file = gateLogPath(env);
    const max = require('./tunables').runner().limits.gateTailBytes;
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    let text;
    try {
      const len = Math.min(size, max);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    let last = null;
    for (const line of text.split('\n')) {
      let e;
      try { e = JSON.parse(line); } catch (_err) { continue; }
      if (!e || e.cycle !== id || e.tool !== 'place_order' || !['allowed', 'blocked'].includes(e.decision) || !(Date.parse(e.ts) >= sinceMs)) continue;
      last = e;
    }
    if (!last) return null;
    const v = Array.isArray(last.violations) ? last.violations : [];
    return { decision: last.decision, ts: last.ts, checks: v.map(x => x.check), message: v.map(x => `[${x.check}] ${x.message}`).join(' ') || String(last.message || '') };
  } catch (_err) {
    return null;
  }
}

/**
 * The cycle's outcome after the executor's run: { outcome: executed | blocked | no-trade, result, why }.
 *   entered   the account shows a position on the family, or the gateway recorded this record's entry
 *   refusal   the gate's refusal this cycle ({ checks, message }) or null
 *   report    the executor's report (its BLOCKED or ABORTED line), or ''
 *   failed    the executor's run didn't count (its stop and why), or null
 *   sent      its place_order call completed (the gate let it through): with nothing on the account, the broker took none
 *   allowed   the gate let a place_order of this cycle through (its log), whatever the broker's reply
 * The gate let it through and its call never completed (a lost or late reply, a timeout): the order's outcome is
 * unknown, never a refusal (the gateway's order tracker holds new entries as pending until it settles). The result
 * word is `executed`, so the next cycles treat it as possibly placed; the outcome is `unknown`.
 */
function entryOutcome({ entered, filled = false, refusal = null, report = '', failed = null, sent = false, allowed = false, label }) {
  if (entered) return { outcome: 'executed', result: `CYCLE RESULT: executed - ${label} (the runner's entry: phase 2 approved, the order ${filled ? 'filled' : 'went'})`, why: null };
  if (refusal) return { outcome: 'blocked', result: `CYCLE RESULT: blocked - the order gate refused the ${label}: ${short(refusal.message)}`, why: refusal.message };
  if (allowed && !sent) return { outcome: 'unknown', result: `CYCLE RESULT: executed - ${label}: unknown, the order's outcome couldn't be read (its reply never came and the account doesn't show it): treat it as possibly placed`, why: short(report) || 'no reply' };
  const said = ORDER_REFUSED.exec(String(report || ''));
  if (said) return { outcome: 'blocked', result: `CYCLE RESULT: blocked - the ${label} was ${said[1] === 'BLOCKED' ? 'blocked' : 'refused by the broker'}: ${short(report)}`, why: short(report) };
  // Its order call went (the gate let it through) and the account shows nothing of it: the broker took no order.
  if (sent) return { outcome: 'blocked', result: `CYCLE RESULT: blocked - the ${label} was refused by the broker: the order went and the account shows no position or entry (the executor's report: ${short(report) || 'none'})`, why: short(report) };
  return { outcome: 'no-trade', result: `CYCLE RESULT: no-trade - the runner's entry: the trade-executor ${failed ? `${failed.stop}${failed.why ? ` (${failed.why})` : ''}` : 'sent no order'}: no order`, why: failed ? failed.why : 'no order' };
}

async function runEntry(deps, c) {
  const { workflow, runRole, client, home, cfg, root, env, log = () => {}, wallNow = Date.now, now = () => new Date(), perRoleMs, childEnv, lookups = {} } = deps;
  const orderPlan = deps.orderPlan || require('./harness-tools/order-plan').plan;
  if (outcomeOf(c.result) !== 'planned') return null;
  const info = { ran: [], phases: [] };
  const say = (outcome, result, more = {}) => ({ result, entry: { ...info, outcome, ...more } });
  // 1. The record the decision rests on.
  let due;
  try { due = entryDue(recordsAt(home, c.symbol, c.bar)); } catch (err) { due = { run: false, why: `the compose records can't be read (${err.message})` }; }
  if (!due.run) {
    log(`the entry: ${due.why}: a process failure; nothing runs`, 'error');
    return say('process-failure', c.result, { failure: due.why });
  }
  const rec = due.record;
  // The decision as the head trader wrote it: its side (and size, when it says one) must be the record's.
  const drift = plannedDrift(c.result, rec);
  if (drift) {
    log(`the entry: ${drift}: a process failure; nothing runs`, 'error');
    return say('process-failure', c.result, { failure: drift, record: rec.id });
  }
  const label = `${STRATEGY} ${rec.side} ${rec.plan && rec.plan.size} ${rec.symbol || c.symbol}`;
  info.record = rec.id;
  if (!c.rolesFile) {
    log('the entry: no role record for the cycle: nothing runs', 'error');
    return say('process-failure', c.result, { failure: 'no role record' });
  }
  // 2. The head trader's loads, for the gate's skills checks in the executor's run. A Claude Code head trader in index
  // mode (attested by the runner: autotrader.js claudeHeadOn, this machine's opt-in) also read skills whole with
  // skill_lookup; those are its loads too. Without that attestation, as before.
  const headAtt = require('./head-prompt').parseAttestation((c.headEnv || {}).FTH_HEAD_PROMPT);
  const claudeHead = Boolean(headAtt && headAtt.harness === 'claude');
  try {
    RR.appendHeadSkills(c.rolesFile, [...skillsInTranscript(c.output), ...(claudeHead ? claudeLookupsInTranscript(c.output) : [])].filter(Boolean));
  } catch (err) {
    log(`the entry: the head trader's skills could not be recorded (${err.message}): the gate sees none`, 'error');
  }
  const { createRun } = require('./orchestrate/engine');
  const { runWorkflow } = require('./orchestrate/workflows');
  const { cycleId } = require('./trading/check-order');
  const id = cycleId(c.headEnv || {});
  // The roles' runs get the cycle's own context (its bars, lanes, cached roles, the role record) and its id.
  // A Claude Code head trader in index mode: its attestation goes with the cycle's id, so the executor's gate counts what
  // the head trader's prompt embedded (autotrader.js claudeHeadAttestation checks it is this cycle's).
  const roleContext = { ...(c.context || {}), entry: false, rolesFile: c.rolesFile, ...(id ? { cycleId: id } : {}), ...(claudeHead && id ? { headPrompt: c.headEnv.FTH_HEAD_PROMPT } : {}) };
  const deadline = wallNow() + Math.max(0, Number(c.budgetMs) || 0);
  // The budget's timings (the cycle log's entry.timing): from the bar's close, in the harness's time up to the cycle's
  // start (c.at), then the wall clock since the head trader's run began (c.startedWall).
  const closeMs = Date.parse(c.bar) + cfg.timeframe * 60000;
  const lagMs = Number.isFinite(closeMs) && Number.isFinite(Date.parse(c.at)) ? Math.max(0, Date.parse(c.at) - closeMs) : null;
  const sinceClose = wall => (lagMs !== null && Number.isFinite(c.startedWall) ? lagMs + Math.max(0, wall - c.startedWall) : null);
  info.timing = { barClose: Number.isFinite(closeMs) ? new Date(closeMs).toISOString() : null, headMs: sinceClose(wallNow()) };
  const times = new Map();
  const engine = {
    run: async (role, request, { timeoutMs }) => {
      const left = deadline - wallNow();
      if (left <= 0) return { ok: false, timedOut: true, text: '', tools: [], output: '' };
      const start = wallNow();
      try { return await runRole(role, request, { timeoutMs: Math.min(timeoutMs || left, left), context: roleContext }); } finally { times.set(role, { start, end: wallNow() }); }
    },
  };
  const record = r => {
    try {
      RR.appendRoleRun(c.rolesFile, { role: r.role, ...times.get(r.role), text: r.text || '', lookups: r.lookups || [], ok: r.ok });
      info.ran.push({ role: r.role, stop: r.stop, attempts: r.attempts, ms: r.ms, ...(r.why ? { why: r.why } : {}) });
      return true;
    } catch (err) {
      log(`the entry: ${r.role}'s run could not be recorded for the gate (${err.message})`, 'error');
      info.ran.push({ role: r.role, stop: r.stop, unrecorded: err.message });
      return false;
    }
  };
  const ctx = {
    symbol: c.symbol, contractId: c.contractId || null, at: c.at, timeframe: cfg.timeframe, bars: c.bars || null, lookups,
    strategy: STRATEGY, side: rec.side, accountId: Number.isInteger(c.accountId) ? c.accountId : null,
    record: renderRecord(rec), reports: c.reports || [],
  };
  let stop = null;
  let order = null;
  // 4. Between the phases: the verdict, the order built in code, the journal plan.
  const before = async (p, phases) => {
    if (p.orders !== true) return null;
    const rev = (phases[0] && phases[0].results[0]) || null;
    if (!rev) { stop = { outcome: 'no-trade', why: 'phase 2 did not run' }; return { stop: stop.why }; }
    const held = record(rev);
    if (!rev.ok) { stop = { outcome: 'no-trade', why: `risk-manager phase 2 ${rev.stop}${rev.why ? ` (${rev.why})` : ''}` }; return { stop: stop.why }; }
    if (!held) { stop = { outcome: 'no-trade', why: 'risk-manager phase 2 could not be recorded for the gate' }; return { stop: stop.why }; }
    const line = verdictLine(rev.text);
    if (verdictOf(rev.text) !== 'APPROVE') { stop = { outcome: 'vetoed', why: line || 'phase 2 did not approve' }; return { stop: stop.why }; }
    const roleEnv = childEnv(cfg, root, env, roleContext);
    try {
      order = orderPlan({ file: c.bars, symbol: c.symbol, strategy: STRATEGY, side: rec.side, ...(Number.isInteger(c.accountId) ? { accountId: c.accountId } : {}) }, { env: roleEnv, root, tool: true });
    } catch (err) {
      // Only an expired record's refusal is timed as the order's moment (the record ran out by then).
      if (/\bexpired\b/.test(err.message)) info.timing.orderMs = sinceClose(wallNow());
      // The record ran out before the order: its own reason, so it can be counted.
      stop = /\bexpired\b/.test(err.message) ? { outcome: 'expired', why: `the composed record expired before the order (${short(err.message)})` } : { outcome: 'no-trade', why: `order_plan refused the composed plan: ${short(err.message)}` };
      return { stop: stop.why };
    }
    // No late entry (late-entry.js): the market at the order's moment, from the newest closed 1m bar read now and
    // recorded for the gate, else the local bars; left the plan (or no current price): a pass, no executor run.
    const late = await lateCheck(order, roleEnv);
    if (late) {
      info.timing.orderMs = sinceClose(wallNow());
      stop = { outcome: 'late', why: late };
      return { stop: stop.why };
    }
    try {
      const tag = (/^\s*setup:([a-z0-9_-]+)/i.exec(order.args.rationale) || [])[1] || STRATEGY;
      const p = order.plan;
      await client.journalAdd({
        kind: 'plan', contractId: order.args.contractId, ...(Number.isInteger(c.accountId) ? { accountId: c.accountId } : {}), tags: [`setup:${tag}`, contractRoot(order.args.contractId)],
        text: `${tag} ${p.side} ${p.size} ${p.contract}: limit ${p.entry}, stop ${p.stopPrice}, target ${p.targetPrice}, risk $${p.riskUsd}; compose record ${p.record}; phase 2: ${short(line)}`,
      });
    } catch (err) {
      stop = { outcome: 'no-trade', why: `the journal plan could not be written (${err.message})` };
      return { stop: stop.why };
    }
    return { ctx: { args: order.args, verdict: line } };
  };
  // The latest price before the executor runs: the newest closed 1m bar through the adapter, recorded locally (the gate
  // reads only local state); a failed read leaves the local bars to decide. The check is the gate's own.
  const lateCheck = async (o, roleEnv) => {
    const root = c.symbol;
    if (client && typeof client.closedBars === 'function') {
      try {
        const got = await client.closedBars(o.args.contractId, { minutes: 1, limit: LE_BARS, now: now() });
        const last = Array.isArray(got) && got.length ? got[got.length - 1] : null;
        const closedAt = last ? Date.parse(last.t) + 60000 : NaN;
        if (last && Number.isFinite(Number(last.c)) && Number.isFinite(closedAt) && closedAt <= now().getTime()) LE.recordPrice(home, root, { price: Number(last.c), closedAt: new Date(closedAt).toISOString(), minutes: 1, source: 'runner-entry' }, { now: now(), log: m => log(`the entry: ${m}`) });
      } catch (err) {
        log(`the entry: the latest 1m bar can't be read (${err.message}): the local bars decide`, 'error');
      }
    }
    let config;
    try { config = require('./trading/config').loadConfig(roleEnv); } catch (_err) { config = null; }
    const G = require('./tunables').runner().gate;
    const maxAgeMin = LE.ageLimitOf(config || { signalMaxAgeBars: G.signalMaxAgeBars, signalMaxAgeCeilingMin: G.signalMaxAgeCeilingMin });
    const { readBriefing } = require('./trading/briefing');
    return LE.lateEntryRefusal({ home, root, side: rec.side, entry: o.plan.entry, stop: o.plan.stopPrice, briefing: readBriefing(home, root), now: now(), share: G.lateEntryDriftShare, maxAgeMin });
  };
  const sentAt = Date.now();
  let res;
  try {
    res = await runWorkflow(workflow, { run: createRun({ engine, onEvent: e => { if (e.type === 'agent-end' && e.stop !== 'completed') log(`the entry: ${e.role} ${e.stop}${e.why ? ` (${e.why})` : ''}`, 'error'); } }), ctx, concurrency: 1, timeoutMs: perRoleMs, before });
  } catch (err) {
    log(`the entry failed (${err.message}): no order`, 'error');
    return say('error', `CYCLE RESULT: no-trade - the runner's entry failed (${short(err.message)}): no order`, { failure: err.message });
  }
  info.phases = res.phases.map(p => ({ name: p.name, roles: p.results.map(r => ({ role: r.role, stop: r.stop })) }));
  const ran = role => (times.has(role) ? Math.max(0, times.get(role).end - times.get(role).start) : null);
  info.timing.phase2Ms = ran('risk-manager');
  info.timing.executorMs = ran('trade-executor');
  if (stop) {
    if (stop.outcome === 'expired') {
      log(`the entry: ${stop.why}: no order`, 'error');
      return say('expired', 'CYCLE RESULT: no-trade - the composed record expired before the order', { why: stop.why });
    }
    if (stop.outcome === 'late') {
      log(`the entry: ${stop.why}: a pass, no executor run`);
      return say('late', `CYCLE RESULT: no-trade - the runner's entry: ${short(stop.why)}`, { why: stop.why });
    }
    if (stop.outcome === 'vetoed') return say('vetoed', `CYCLE RESULT: no-trade - risk-manager vetoed the ${label}: ${short(stop.why)}`, { why: stop.why });
    log(`the entry: ${stop.why}: no order`, 'error');
    return say('no-trade', `CYCLE RESULT: no-trade - the runner's entry: ${short(stop.why)}: no order`, { why: stop.why });
  }
  // 5. The executor's run is recorded: it ends the round, whatever it did.
  const exec = (res.phases[1] && res.phases[1].results[0]) || null;
  if (exec) record(exec);
  // 6. The after-order read.
  let entered = false;
  let filled = false;
  try {
    const { entryOrders } = require('./harness-run');
    entered = entryOrders(home).some(e => e && e.composed && e.composed.record === rec.id);
  } catch (_err) { /* none recorded */ }
  let account = null;
  if (Number.isInteger(c.accountId) && client && typeof client.accountState === 'function') {
    try {
      const st = await client.accountState(c.accountId);
      const fam = famOf(order.args.contractId);
      const pos = (st.positions || []).filter(isOpen).filter(p => famOf(p.contractId) === fam);
      filled = pos.length > 0;
      entered = entered || filled;
      account = { positions: pos.length, orders: (st.orders || []).filter(o => famOf(o.contractId) === fam).length };
    } catch (err) {
      log(`the entry: the account can't be read after the order (${err.message}): the outcome from the gateway's record and the executor's report`, 'error');
      account = { error: err.message };
    }
  }
  const sent = gateDecision(env, id, sentAt - require('./tunables').runner().session.gateSlackMs);
  // The order's moment: the gate's decision that let it go to the broker (its log's time, the wall clock); none, null.
  info.timing.orderMs = sent && sent.decision === 'allowed' ? sinceClose(Date.parse(sent.ts)) : null;
  const decision = entered ? null : sent;
  const out = entryOutcome({
    entered, filled, refusal: decision && decision.decision === 'blocked' ? decision : null, allowed: Boolean(decision && decision.decision === 'allowed'), report: exec ? exec.text : '',
    failed: exec && !exec.ok ? { stop: exec.stop, why: exec.why } : null, label,
    sent: Boolean(exec && Array.isArray(exec.tools) && exec.tools.includes(`${require('./broker/config').SERVER_NAME}_place_order`)),
  });
  if (out.outcome !== 'executed') log(`the entry: ${out.result}`, out.outcome === 'blocked' ? 'info' : 'error');
  return say(out.outcome, out.result, { account, ...(out.why ? { why: short(out.why) } : {}) });
}

module.exports = { STRATEGY, entryDue, plannedDrift, verdictLine, gateRefusal, gateDecision, entryOutcome, runEntry };
