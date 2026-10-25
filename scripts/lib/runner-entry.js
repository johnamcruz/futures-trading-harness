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
 *      VETO is the cycle's no-trade with its line; an APPROVE line the reading still takes as a veto, the same outcome
 *      with the reading's reason: roles-ran.js approvalReadAsVeto; but first, an approving VERDICT line the reading
 *      refuses, as a veto or for its size, is restated once: trading/phase2-restate.js, config/runner.json
 *      entry.phase2RestateRetries; approved, its size at most the first VERDICT line's, the decisive record the gate's;
 *      a veto, a veto; else the first report's outcome; the entry record's `restated`); phase 2's report kept in the entry record
 *      (`phase2`: { chars, text cut at prompt.reportMaxText, cut }); phase 2's approved size (roles-ran.js approvedSize:
 *      none readable is a no-trade) sets the order's: exactly the smaller of it and the record's (in a prop attempt the translated size's: prop/size-translate.js; a cut is built by
 *      order_plan at it, as the gate's composed-reads takes it), never more than phase 2 approved
 *      (`size`: { approved, record, ordered }, and in an attempt suggested and translated); the order by order_plan's own path (harness-tools/order-plan.js:
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
 *      position on the root's family, the entry working unfilled (workingEntry) or the gateway recorded this record's
 *      entry (entry-orders.json); else, when the
 *      gate let a place_order of this cycle through (its log, this cycle's id, the hook's records and the gateway's),
 *      the order's (a later refused retry never hides it); else blocked with the gate's refusal (the same log) or the
 *      executor's own BLOCKED or ABORTED report (an ABORTED with no order call at all is the executor's own abort: a
 *      no-trade, outcome `aborted`, never a broker's refusal); else a failed
 *      run, a no-trade with why. A lost or late broker reply never sends a second entry: nothing here retries the order.
 *
 *   entryDue(records)        { run: true, record } | { run: false, why }: the latest record on the bar, OK or not
 *   plannedDrift(result, rec)  why the head trader's planned line (its side, its size) isn't the record's, or null
 *   verdictLine(text)        phase 2's decisive VERDICT line (roles-ran.js decisiveLine), never a heading
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
const { verdictOf, approvalReadAsVeto, approvedSize, decisiveLine } = require('./trading/roles-ran');
const { restateDue, readRestatement } = require('./trading/phase2-restate');
const { restate: restateRequest } = require('./orchestrate/requests');
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

// The broker interface's codes (broker/interface.js ENUMS: docs/BROKER-MCP-INTERFACE.md): an order's side, type and
// status; a working order is open or pending. A code or its name.
const { ENUMS } = require('./broker/interface');
const SIDE_CODE = ENUMS.side;
const TYPE_CODE = ENUMS.orderType;
const WORKING = ['open', 'pending'];
const sameCode = (got, name, codes) => (typeof got === 'number' || /^\s*\d+\s*$/.test(String(got ?? '')) ? Number(got) === codes[name] : String(got ?? '').toLowerCase() === name);
const working = s => s === undefined || s === null || WORKING.some(n => sameCode(s, n, ENUMS.orderStatus));

/**
 * The account's working order that is this entry's, or null: on the entry's own contract (its root, never another of
 * the family, and its month when both name one), on the entry's side and of its order type (a protective stop or
 * target of a position is the other side, or a stop), and open or pending when the order states a status. The entry
 * starts flat with no working orders (runner.js entryCycle), so such an order is the one this cycle placed.
 */
function workingEntry(orders, args) {
  if (!Array.isArray(orders) || !args) return null;
  const { parseStandardName } = require('./broker/translator');
  const month = id => (parseStandardName(id) || {}).month || null;
  const want = { root: contractRoot(args.contractId), month: month(args.contractId), side: String(args.side || '').toLowerCase(), type: String(args.type || '').toLowerCase() };
  if (!(want.side in SIDE_CODE) || !(want.type in TYPE_CODE)) return null;
  return orders.find(o => o && typeof o === 'object' && contractRoot(o.contractId) === want.root
    && !(want.month && month(o.contractId) && month(o.contractId) !== want.month)
    && sameCode(o.side, want.side, SIDE_CODE) && sameCode(o.type, want.type, TYPE_CODE)
    && working(o.status)) || null;
}

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

/**
 * Phase 2's decisive VERDICT line (roles-ran.js decisiveLine: the line verdictOf and approvedSize decided on; never a
 * heading or another line that names a verdict), or ''.
 */
const verdictLine = text => decisiveLine(text);

/**
 * The gate's last refusal of a place_order in this cycle (the gate log, stamped with the cycle's id: check-order.js
 * cycleId), at or after `sinceMs`: { checks, message } or null (the last decision is not a refusal). Never throws.
 */
function gateRefusal(env, id, sinceMs) {
  const list = placeOrderDecisions(env, id, sinceMs);
  const last = list[list.length - 1];
  return last && last.decision === 'blocked' ? { checks: last.checks, message: last.message } : null;
}

/**
 * The gate's place_order decision of this cycle at or after `sinceMs`: { decision: allowed | blocked, ts, checks,
 * message, refusedAfter } or null. `allowed` means an order went to the broker (whatever its reply): any allowed
 * place_order of the cycle wins over a refusal, before or after it (a refused retry never hides an order that went);
 * it is the first allowed one (the order's moment), with the last refusal after it as `refusedAfter` ({ checks,
 * message }, else null). With none allowed, the last refusal. The hook's and the gateway's records alike, by the tool
 * each logged (`place_order` only: a refused modify_order or cancel_order is never the entry's); a record naming no
 * tool is none. Never throws.
 */
function gateDecision(env, id, sinceMs) {
  const list = placeOrderDecisions(env, id, sinceMs);
  const at = list.findIndex(e => e.decision === 'allowed');
  if (at < 0) return list.length ? { ...list[list.length - 1], refusedAfter: null } : null;
  const later = list.slice(at + 1).filter(e => e.decision === 'blocked').pop();
  return { ...list[at], refusedAfter: later ? { checks: later.checks, message: later.message } : null };
}

/** This cycle's place_order decisions (allowed or blocked) in the gate log's tail at or after `sinceMs`, in order. */
function placeOrderDecisions(env, id, sinceMs) {
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
    const recs = [];
    for (const line of text.split('\n')) {
      let e;
      try { e = JSON.parse(line); } catch (_err) { continue; }
      if (!e || e.cycle !== id || e.tool !== 'place_order' || !['allowed', 'blocked'].includes(e.decision) || !(Date.parse(e.ts) >= sinceMs)) continue;
      recs.push({ ...e, ms: Date.parse(e.ts) });
    }
    // One call the gateway allowed and its order tracker then refused to send (two records, nothing sent) is one refusal,
    // as the cycle log and the labels read it (replay/labels.js collapsePairs).
    return require('./replay/labels').collapsePairs(recs).map(e => {
      const v = Array.isArray(e.violations) ? e.violations : [];
      return { decision: e.decision, ts: e.ts, checks: v.map(x => x.check), message: v.map(x => `[${x.check}] ${x.message}`).join(' ') || String(e.message || '') };
    });
  } catch (_err) {
    return [];
  }
}

/**
 * The cycle's outcome after the executor's run: { outcome: executed | unknown | blocked | aborted | no-trade, result, why }
 * (aborted: the executor's ABORTED with no order call made, let through or refused: a no-trade, said as its abort).
 *   entered   the account shows a position on the family, or the gateway recorded this record's entry
 *   refusal   the gate's refusal this cycle ({ checks, message }) or null
 *   report    the executor's report (its BLOCKED or ABORTED line), or ''
 *   failed    the executor's run didn't count (its stop and why), or null
 *   working   the account's working order that is this entry's (workingEntry), or null: entered, unfilled
 *   sent      its place_order call completed (the gate let it through): with nothing on the account, the broker took none
 *   attempted it made a place_order call, completed or not (its transcript): with no gate decision of it, unknown
 *   allowed   the gate let a place_order of this cycle through (its log), whatever the broker's reply
 *   unread    the account wasn't read after the order (no account, or its read failed): a sent order is unknown
 * The gate let it through and its call never completed (a lost or late reply, a timeout): the order's outcome is
 * unknown, never a refusal (the gateway's order tracker holds new entries as pending until it settles). The result
 * word is `executed`, so the next cycles treat it as possibly placed; the outcome is `unknown`.
 */
/** A working order as the result names it: `: order <id>, <type> <price>`, as much as it states. */
function restingOf(o) {
  const type = Object.keys(TYPE_CODE).find(k => sameCode(o.type, k, TYPE_CODE)) || null;
  const price = Number.isFinite(Number(o.limitPrice)) && o.limitPrice !== null ? o.limitPrice : Number.isFinite(Number(o.stopPrice)) && o.stopPrice !== null ? o.stopPrice : null;
  const parts = [o.id !== undefined && o.id !== null ? `order ${o.id}` : null, [type, price].filter(x => x !== null).join(' ') || null].filter(Boolean);
  return parts.length ? `: ${parts.join(', ')}` : '';
}

function entryOutcome({ entered, filled = false, working = null, refusal = null, report = '', failed = null, sent = false, attempted = false, allowed = false, unread = false, label }) {
  if (entered) return { outcome: 'executed', result: `CYCLE RESULT: executed - ${label} (the runner's entry: phase 2 approved, the order ${filled ? 'filled' : working ? `is working, unfilled${restingOf(working)}` : 'went'})`, why: null };
  // A refusal never hides an order the gate let through this cycle (gateDecision: allowed wins).
  if (refusal && !allowed) return { outcome: 'blocked', result: `CYCLE RESULT: blocked - the order gate refused the ${label}: ${short(refusal.message)}`, why: refusal.message };
  if (allowed && !sent) return { outcome: 'unknown', result: `CYCLE RESULT: executed - ${label}: unknown, the order's outcome couldn't be read (its reply never came and the account doesn't show it): treat it as possibly placed`, why: short(report) || 'no reply' };
  // The order went (the gate let it through, or its call completed) and the account couldn't be read after it (nor the
  // gateway's record found): unknown, never refused, whatever the executor says.
  if ((allowed || sent) && unread) return { outcome: 'unknown', result: `CYCLE RESULT: executed - ${label}: unknown, the order's outcome couldn't be read (the order went and the account can't be read after it): treat it as possibly placed`, why: short(report) || 'the account can\'t be read' };
  // A place_order call was made, never completed, and the gate log holds no decision of it (none can be read): unknown.
  if (attempted && !sent && !allowed && !refusal) return { outcome: 'unknown', result: `CYCLE RESULT: executed - ${label}: unknown, the order's outcome couldn't be read (a place_order call was made, its reply never came and the gate log has no decision of it): treat it as possibly placed`, why: short(report) || 'no reply' };
  const said = ORDER_REFUSED.exec(String(report || ''));
  // An ABORTED report with no order call at all (none made, none let through, none refused): the trade-executor stopped
  // itself before any order, so neither the gate nor the broker refused anything. No order: a no-trade (`blocked` is a
  // refused order), its entry outcome `aborted`, said as the executor's abort, never as a broker's refusal.
  if (said && said[1] === 'ABORTED' && !attempted && !sent && !allowed) return { outcome: 'aborted', result: `CYCLE RESULT: no-trade - the trade-executor aborted the ${label} with no order sent (no order call in its run, none in the gate log): ${short(report)}`, why: short(report) };
  // A BLOCKED report after the gate let an order through is a refused retry's: the order's outcome decides.
  if (said && !(allowed && said[1] === 'BLOCKED')) return { outcome: 'blocked', result: `CYCLE RESULT: blocked - the ${label} was ${said[1] === 'BLOCKED' ? 'blocked' : 'refused by the broker'}: ${short(report)}`, why: short(report) };
  // Its order call went (the gate let it through) and the account shows nothing of it: the broker took no order.
  if (sent) return { outcome: 'blocked', result: `CYCLE RESULT: blocked - the ${label} was refused by the broker: the order went and the account shows no position or entry (the executor's report: ${short(report) || 'none'})`, why: short(report) };
  return { outcome: 'no-trade', result: `CYCLE RESULT: no-trade - the runner's entry: the trade-executor ${failed ? `${failed.stop}${failed.why ? ` (${failed.why})` : ''}` : 'sent no order'}: no order`, why: failed ? failed.why : 'no order' };
}

// A place_order call in a run's transcript (any server prefix), completed, errored or unanswered; one its harness stopped
// itself (an unavailable tool, a permission rule) never reached a tool.
const PLACE_ORDER = /(?:^|__|_)place_order$/;
function attemptedOrder(exec) {
  if (!exec) return false;
  try {
    return require('./cycle-log').toolCalls(String(exec.output || '')).some(x => PLACE_ORDER.test(x.name) && !x.stopped);
  } catch (_err) {
    return false;
  }
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
  // The entry as the results name it: the record's size until the order is built, then the size ordered (a cut named).
  let label = `${STRATEGY} ${rec.side} ${rec.plan && rec.plan.size} ${rec.symbol || c.symbol}`;
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
      info.ran.push({ role: r.role, stop: r.stop, attempts: r.attempts, ms: r.ms, ...(r.why ? { why: r.why } : {}), ...(r.skills ? { skills: r.skills } : {}) });
      return true;
    } catch (err) {
      log(`the entry: ${r.role}'s run could not be recorded for the gate (${err.message})`, 'error');
      info.ran.push({ role: r.role, stop: r.stop, unrecorded: err.message, ...(r.skills ? { skills: r.skills } : {}) });
      return false;
    }
  };
  const ctx = {
    symbol: c.symbol, contractId: c.contractId || null, at: c.at, timeframe: cfg.timeframe, bars: c.bars || null, lookups,
    strategy: STRATEGY, side: rec.side, accountId: Number.isInteger(c.accountId) ? c.accountId : null,
    record: renderRecord(rec), reports: c.reports || [],
  };
  // In a prop attempt the entry's size is code's translation (order_plan's own path: prop/size-translate.js), read
  // before phase 2 so its request names the size to approve or cut; the record's size is a suggestion. Outside an
  // attempt nothing is read and the request is as before. order_plan refusing here: phase 2 runs on the record and the
  // order is refused after it, as before.
  if (require('./trading/prop-state').runningAttempts(home).length) {
    // The broker's max order size, read through the adapter (its translator records it for this day, as the gateway's
    // own read does before the gate), so order_plan's translation and the gate's see the same limit. Unread: as it is.
    try { if (client && typeof client.serverConfig === 'function') await client.serverConfig(); } catch (_err) { /* the gate reads its own */ }
    try {
      const pre = orderPlan({ file: c.bars, symbol: c.symbol, strategy: STRATEGY, side: rec.side, ...(Number.isInteger(c.accountId) ? { accountId: c.accountId } : {}) }, { env: childEnv(cfg, root, env, roleContext), root, tool: true });
      const p = pre && pre.plan;
      if (p && Number.isInteger(p.translatedSize)) {
        ctx.entrySize = { size: p.translatedSize, contract: p.contract, suggested: p.suggestedSize, reason: p.translation, floor: p.minContracts };
        info.translated = ctx.entrySize;
      }
    } catch (err) {
      log(`the entry: order_plan before phase 2 refused (${short(err.message)}); phase 2 sees the record's size`, 'warn');
    }
  }
  let stop = null;
  let order = null;
  // Phase 2's one restatement (trading/phase2-restate.js): a run of its own (no harness here resumes a role's session),
  // given its first report, within the entry's budget (its time is the cycle's: in a replay with latency charged, the
  // clock's), recorded in the role record after the first report: approved, the decisive record the gate reads (the
  // latest phase-2 call); a veto, as written (the latest: a veto); unreadable or failed, as written but not counted
  // (ok false: the first report stays the decisive one, as before). The entry record's `restated`: { kind, why,
  // ceiling, outcome, size?, reason?, text? }.
  const restatePhase2 = async (due, rev) => {
    const role = rev.role;
    const request = restateRequest(role, { symbol: c.symbol, contractId: c.contractId || null, at: c.at, timeframe: cfg.timeframe, why: due.why, ceiling: due.ceiling, report: rev.text });
    const first = times.get(role);
    times.delete(role);
    let res;
    try { res = await engine.run(role, request, { timeoutMs: perRoleMs }); } catch (err) { res = { ok: false, why: err.message }; }
    const ran = times.get(role) || null;
    if (first) times.set(role, first); // phase2Ms stays the first report's
    info.timing.restateMs = ran ? Math.max(0, ran.end - ran.start) : null;
    const text = res && typeof res.text === 'string' ? res.text : '';
    let read = res && res.ok ? readRestatement(rev.text, text, due.ceiling) : { outcome: 'failed', why: res && res.timedOut ? 'timed out' : `the run failed${res && res.why ? ` (${res.why})` : ''}` };
    if (ran) {
      try {
        RR.appendRoleRun(c.rolesFile, { role, ...ran, text: read.outcome === 'approved' ? read.text : text, lookups: Array.isArray(res.lookups) ? res.lookups.filter(x => typeof x === 'string') : [], ok: Boolean(res.ok && text.trim()) && (read.outcome === 'approved' || read.outcome === 'vetoed') });
      } catch (err) {
        log(`the entry: phase 2's restatement could not be recorded for the gate (${err.message})`, 'error');
        if (read.outcome === 'approved') read = { outcome: 'failed', why: 'it could not be recorded for the gate' };
      }
    }
    info.ran.push({ role, restate: true, stop: res && res.ok ? 'completed' : res && res.timedOut ? 'timed_out' : 'failed', ...(ran ? { ms: Math.max(0, ran.end - ran.start) } : {}) });
    info.restated = { kind: due.kind, why: due.why, ceiling: due.ceiling, outcome: read.outcome, ...(read.outcome === 'approved' ? { size: read.size } : {}), ...(read.why ? { reason: read.why } : {}), ...(text ? { text: short(text) } : {}) };
    log(`the entry: phase 2 restated its size: ${read.outcome}${read.outcome === 'approved' ? ` ${read.size}` : read.why ? ` (${read.why})` : ''}`, read.outcome === 'approved' ? 'info' : 'error');
    return read;
  };
  // 4. Between the phases: the verdict, the order built in code, the journal plan.
  const before = async (p, phases) => {
    if (p.orders !== true) return null;
    const rev = (phases[0] && phases[0].results[0]) || null;
    if (!rev) { stop = { outcome: 'no-trade', why: 'phase 2 did not run' }; return { stop: stop.why }; }
    const held = record(rev);
    // Phase 2's report as it came, for the next diagnosis (the cycle log's entry record), cut at the report cache's
    // limit (config/runner.json prompt.reportMaxText).
    if (typeof rev.text === 'string' && rev.text) {
      const max = require('./tunables').runner().prompt.reportMaxText;
      info.phase2 = { chars: rev.text.length, text: rev.text.slice(0, max), ...(rev.text.length > max ? { cut: true } : {}) };
    }
    if (!rev.ok) { stop = { outcome: 'no-trade', why: `risk-manager phase 2 ${rev.stop}${rev.why ? ` (${rev.why})` : ''}` }; return { stop: stop.why }; }
    if (!held) { stop = { outcome: 'no-trade', why: 'risk-manager phase 2 could not be recorded for the gate' }; return { stop: stop.why }; }
    // An approving VERDICT line the strict reading refuses (it reads as a veto, or its size can't be read): phase 2 is
    // asked once to restate its Size and VERDICT lines (trading/phase2-restate.js; config/runner.json
    // entry.phase2RestateRetries, 0: off). Approved: the order's size is at most the first report's VERDICT size, and the
    // decisive record is the gate's; a veto is a veto; anything else: the first report's outcome, as before.
    const due = require('./tunables').runner().entry.phase2RestateRetries >= 1 ? restateDue(rev.text) : null;
    const restated = due ? await restatePhase2(due, rev) : null;
    let line;
    let approved;
    if (restated && restated.outcome === 'approved') {
      line = restated.line;
      approved = { size: restated.size };
    } else if (restated && restated.outcome === 'vetoed') {
      stop = { outcome: 'vetoed', why: restated.line || 'phase 2 did not approve' };
      return { stop: stop.why };
    } else {
      line = verdictLine(rev.text);
      if (verdictOf(rev.text) !== 'APPROVE') {
        // An APPROVE line the gate's reading still takes as a veto (roles-ran.js approvalReadAsVeto): the same outcome,
        // with the parser's reason, so the cause shows (never the APPROVE line as a veto's reason).
        const misread = approvalReadAsVeto(rev.text);
        stop = misread ? { outcome: 'vetoed', why: `phase 2's report reads as a veto: ${misread.why}`, readAs: misread } : { outcome: 'vetoed', why: line || 'phase 2 did not approve' };
        if (misread) log(`the entry: ${stop.why}: no order`, 'error');
        return { stop: stop.why };
      }
      // Phase 2's size caps the order (it can only shrink it): an approval without a size the runner can read orders nothing.
      approved = approvedSize(rev.text);
      if (approved.error) { stop = { outcome: 'no-trade', why: `risk-manager phase 2 approved without a size the runner can read (${approved.error})` }; return { stop: stop.why }; }
    }
    const roleEnv = childEnv(cfg, root, env, roleContext);
    // The order is exactly the smaller of the record's size and phase 2's (owner-approved 2026-10-22): a cut is built by
    // order_plan at it (the record's brackets, the risk for the size ordered), as the gate's composed-reads takes it.
    const recSize = rec.plan && Number.isInteger(rec.plan.size) ? rec.plan.size : null;
    const cutTo = recSize !== null && approved.size < recSize ? approved.size : null;
    try {
      order = orderPlan({ file: c.bars, symbol: c.symbol, strategy: STRATEGY, side: rec.side, ...(Number.isInteger(c.accountId) ? { accountId: c.accountId } : {}), ...(cutTo !== null ? { size: cutTo } : {}), approved: approved.size }, { env: roleEnv, root, tool: true });
    } catch (err) {
      // Only an expired record's refusal is timed as the order's moment (the record ran out by then).
      if (/\bexpired\b/.test(err.message)) info.timing.orderMs = sinceClose(wallNow());
      // The record ran out before the order: its own reason, so it can be counted.
      stop = /\bexpired\b/.test(err.message) ? { outcome: 'expired', why: `the composed record expired before the order (${short(err.message)})` } : { outcome: 'no-trade', why: `order_plan refused the composed plan: ${short(err.message)}` };
      return { stop: stop.why };
    }
    // Never more than phase 2 approved: order_plan's size is checked against it (fails closed).
    const ordered = order && order.args ? order.args.size : undefined;
    const recordSize = order && order.plan && Number.isInteger(order.plan.recordSize) ? order.plan.recordSize : ordered;
    if (!(Number.isInteger(ordered) && ordered >= 1)) { stop = { outcome: 'no-trade', why: `order_plan gave no size (${JSON.stringify(ordered)})` }; return { stop: stop.why }; }
    // In a prop attempt the record's size is a suggestion, translated to the rulebook's (prop/size-translate.js): both kept.
    const translated = order && order.plan && Number.isInteger(order.plan.translatedSize) ? order.plan.translatedSize : null;
    const base = translated !== null ? 'the translated' : "the record's";
    info.size = { ...(translated !== null ? { suggested: order.plan.suggestedSize, translated } : {}), approved: approved.size, record: recordSize, ordered: ordered <= approved.size ? ordered : null };
    if (ordered > approved.size) { stop = { outcome: 'no-trade', why: `order_plan's size ${ordered} is over the ${approved.size} risk-manager phase 2 approved` }; return { stop: stop.why }; }
    if (ordered < recordSize) label = `${STRATEGY} ${rec.side} ${ordered} ${rec.symbol || c.symbol} (phase 2 cut ${base} ${recordSize})`;
    else if (translated !== null) label = `${STRATEGY} ${rec.side} ${ordered} ${rec.symbol || c.symbol}`; // the size ordered, never the suggestion
    const sizeWhy = `size ${ordered}: ${ordered < recordSize ? `phase 2 cut ${base} ${recordSize}` : approved.size > ordered ? `phase 2 approved ${approved.size}, capped at ${base} ${ordered}` : `phase 2 approved ${base} ${ordered}`}${translated !== null ? ` (the record suggested ${order.plan.suggestedSize})` : ''}`;
    // No late entry (late-entry.js): the market at the order's moment, from the newest closed 1m bar read now and
    // recorded for the gate, else the local bars; left the plan (or no current price): a pass, no executor run.
    const late = await lateCheck(order, roleEnv);
    if (late) {
      info.timing.orderMs = sinceClose(wallNow());
      // The skip, logged with the plan's prices and the price at the skip (the replay report's counterfactual reads it).
      info.late = { ...late.late, root: c.symbol, at: now().toISOString(), record: rec.id };
      stop = { outcome: 'late', why: late.message };
      return { stop: stop.why };
    }
    try {
      const tag = (/^\s*setup:([a-z0-9_-]+)/i.exec(order.args.rationale) || [])[1] || STRATEGY;
      const p = order.plan;
      await client.journalAdd({
        kind: 'plan', contractId: order.args.contractId, ...(Number.isInteger(c.accountId) ? { accountId: c.accountId } : {}), tags: [`setup:${tag}`, contractRoot(order.args.contractId)],
        text: `${tag} ${p.side} ${p.size} ${p.contract}: limit ${p.entry}, stop ${p.stopPrice}, target ${p.targetPrice}, risk $${p.riskUsd}; ${sizeWhy}; compose record ${p.record}; phase 2${restated && restated.outcome === 'approved' ? ' (restated)' : ''}: ${short(line)}`,
      });
    } catch (err) {
      stop = { outcome: 'no-trade', why: `the journal plan could not be written (${err.message})` };
      return { stop: stop.why };
    }
    return { ctx: { args: order.args, verdict: line } };
  };
  // The latest price before the executor runs: the newest closed 1m bar through the adapter, recorded locally (the hook
  // reads only local state; the gateway reads the broker's bar again at the order); a failed read here leaves the local
  // bars to decide. The check is the gate's own.
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
    return LE.lateEntryCheck({ home, root, side: rec.side, entry: o.plan.entry, stop: o.plan.stopPrice, target: o.plan.targetPrice ?? null, briefing: readBriefing(home, root), now: now(), share: G.lateEntryDriftShare, maxAgeMin });
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
    // A misread approval's result names the parser's reason without its quote (the role's words aren't the result's
    // reasons, which the scorecard checks); the entry's `why` keeps the quote.
    if (stop.outcome === 'vetoed' && stop.readAs) return say('vetoed', `CYCLE RESULT: no-trade - risk-manager phase 2's report reads as a veto ${short(`(${stop.readAs.why.replace(/ \("[^]*"\)$/, '')}): ${stop.readAs.line}`)}`, { why: stop.why });
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
  let rest = null;
  if (Number.isInteger(c.accountId) && client && typeof client.accountState === 'function') {
    try {
      const st = await client.accountState(c.accountId);
      const fam = famOf(order.args.contractId);
      const pos = (st.positions || []).filter(isOpen).filter(p => famOf(p.contractId) === fam);
      filled = pos.length > 0;
      // The entry resting unfilled (a working order on its contract, side and type: workingEntry) is the broker's too.
      rest = filled ? null : workingEntry(st.orders, order.args);
      entered = entered || filled || Boolean(rest);
      account = { positions: pos.length, orders: (st.orders || []).filter(o => famOf(o.contractId) === fam).length };
    } catch (err) {
      log(`the entry: the account can't be read after the order (${err.message}): the outcome from the gateway's record and the executor's report`, 'error');
      account = { error: err.message };
    }
  }
  const sent = gateDecision(env, id, sentAt - require('./tunables').runner().session.gateSlackMs);
  // The order's moment: the gate's decision that let it go to the broker (its log's time, the wall clock); none, null.
  info.timing.orderMs = sent && sent.decision === 'allowed' ? sinceClose(Date.parse(sent.ts)) : null;
  // An order went and a later place_order of the cycle was refused: the outcome is the order's, the retry's refusal logged.
  if (sent && sent.decision === 'allowed' && sent.refusedAfter) log(`the entry: a later place_order of the cycle (a retry) was refused by the order gate after the order went: ${short(sent.refusedAfter.message)}`, 'error');
  const decision = entered ? null : sent;
  const out = entryOutcome({
    entered, filled, working: rest, unread: !account || Boolean(account.error), refusal: decision && decision.decision === 'blocked' ? decision : null, allowed: Boolean(decision && decision.decision === 'allowed'), report: exec ? exec.text : '',
    failed: exec && !exec.ok ? { stop: exec.stop, why: exec.why } : null, label,
    sent: Boolean(exec && Array.isArray(exec.tools) && exec.tools.includes(`${require('./broker/config').SERVER_NAME}_place_order`)),
    attempted: attemptedOrder(exec),
  });
  if (out.outcome !== 'executed') log(`the entry: ${out.result}`, out.outcome === 'blocked' ? 'info' : 'error');
  return say(out.outcome, out.result, { account, ...(out.why ? { why: short(out.why) } : {}) });
}

module.exports = { STRATEGY, entryDue, plannedDrift, verdictLine, gateRefusal, gateDecision, workingEntry, entryOutcome, runEntry };
