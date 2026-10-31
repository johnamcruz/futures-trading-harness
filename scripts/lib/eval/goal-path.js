'use strict';

/**
 * The goal regression's tier 2 reading (docs/TRAINING.md, "The goal regression"): a fixture day the live path played
 * with the deterministic mock policy (tests/goal/tier2-day.js), read into its trades, each trade's path trace step by
 * step, and the comparison with main's tier 2 baseline, every lost or changed trade named by the category of its
 * break. Pure: the day's facts come in as data (the runner's decisions, events and cycle log, the gate's log, the
 * compose records, the exchange's orders and fills, the attempt), never files.
 *
 * A trade's trace, in order (STEPS; each { step, ok, at, ...facts }):
 *   bias      the side the Bias line gave on the decision bar (the mock's choice)
 *   setup     the setup the mock took from the briefing (a "Setups to check" read or a cited fire)
 *   compose   compose_check's record on that bar: OK, its id
 *   phase2    risk-manager phase 2 approved, the size the runner read
 *   gate      the gate let the entry through: no refusal tags
 *   order     the order sent: seconds from the bar close to it by the replay clock (afterCloseS), and the cycle log's
 *             orderMs (the harness's own measure: the replayed decision delay plus the cycle's wall time)
 *   fill      the entry fill: price, size
 *   bracket   the stop bracket working from the fill: its price
 *   trail     each stop move (none or more): when, from, to, the peak R it was moved at (never before the target's R)
 *   exit      the exit: reason (stop, trail, target, close), price, R (of the plan's risk)
 *   eod       the day's end of day recorded (the runner's close record and the attempt's day)
 *
 * A lost or changed trade against main's (CATEGORIES, by the first break on its path):
 *   a listing   the briefing didn't list the setup (the mock saw no setup that bar)
 *   b compose   compose_check refused it (its problem quoted)
 *   c phase2    phase 2's approval unreadable or vetoed
 *   d gate      the gate refused (its tags)
 *   e timing    the runner's late-entry guard or the record expiring (the order's timing)
 *   f fill      the entry filled differently (price, size or time), or not at all
 *   g exit      the exit differs (reason, price, R)
 *   h steps     the trace's steps differ from main's (a step skipped or added)
 *
 *   STEPS, CATEGORIES
 *   pickDays(blocks, { seed, trendDays, otherDays })   tier 2's days from the fixture's blocks (seeded, both halves)
 *   dayTrades(day, { tick })        [{ key, day, side, setup, bar, record, entry, size, exitPrice, exitReason, R,
 *                                   riskPts, orderMs, steps, trace }]
 *   traceProblems(trade)            [problem]: a step missing, failed or out of order (a trail move before the target)
 *   lostWhy(day, bar, side)         { category, why }: the first break on the path of a setup at `bar` that made no trade
 *   compareTrades(main, now, days)  [{ category, key, why, main, now }]: every main trade lost or changed, every new one
 *   summarize(trades, { legs, mechanical, refRiskPts, blows })   { trades, totalR, meanR, caught, fills, blows }
 *   tier2Rows(base, now, tol)       the table's rows (goal-check.js renderTable)
 *   moveLayers(day, { tick, exit })  a catch-the-move day's layers (bias, setup, entry, stop, exit, capture), or null
 *   moveDiff(expected, got, { tick, shareTol })   ["LAYER: expected ..., got ..."] against the golden (shareTol: how far
 *                                   below the golden's capture share is still the golden's: config tier2.tolerance.moveShare)
 *   probeProblems(probes, expected)   the negative probes refused, each by its expected tag or compose problem
 *   dayBehaviour(day, trades, { maxLossR })   a day's behaviour by its label (caught, R, worst R, the loss bound, a blow)
 *   caughtLost(base, now)           main's caught trend days lost now
 *   faultChecks(day)                { problems, trace }: a broker-fault day's protection, exit, duplicate and recovery
 *                                   checks, and the fault and its recovery as trace steps
 *   tier2RiseProblems(base, next)   a tier 2 baseline only improves: blows not above, total R and fills share not below
 *   floorChecks(day, { rule, bind })   { refused, problems }: a floor day's D13 refusal (goal-synth.js floor): the compose
 *                                   record its stop floor refused, its stop the named level less the buffer (never
 *                                   widened), the binding term the day's (bind 'ticks': rule.floorTicks; 'atr': above it,
 *                                   the stop at least rule.floorTicks), and no trade that day
 *   shardOf(text)                   { k, n } from "k/n" (FTH_GOAL_SHARD), null when unset; throws on anything else
 *   shardDays(days, shard)          shard k of n's days (every n-th from the k-th), all of them with no shard
 *   shardCoverage(parts, { days, fixture })   [problem]: the shards' parts ({ shard, days, fixture }) are 1..n of one n
 *                                   once each, of this fixture, and their days are `days` exactly
 */

const crypto = require('crypto');

const STEPS = Object.freeze(['bias', 'setup', 'compose', 'phase2', 'gate', 'order', 'fill', 'bracket', 'trail', 'exit', 'eod']);
const CATEGORIES = Object.freeze({
  a: 'the briefing didn\'t list the setup', b: 'compose_check refused it', c: 'phase 2\'s approval unreadable or vetoed',
  d: 'the gate refused', e: 'the late-entry guard or the order\'s timing', f: 'a fill difference', g: 'the exit differs', h: 'the path\'s steps differ',
});
// The base bar (the runner's) and the interface's order types and statuses (broker/interface.js ENUMS).
const stepMs = () => require('../tunables').runner().bars.timeframe * 60000;
const { orderType: TYPE, orderStatus: STATUS } = require('../broker/interface').ENUMS;
const ms = t => Date.parse(t);
const r4 = x => Math.round(x * 1e4) / 1e4;
const sideOf = s => (s === 0 ? 'long' : 'short');
const barOf = closeIso => new Date(ms(closeIso) - stepMs()).toISOString();

/** The cycle (with its runner's entry) whose compose record is `id`. */
const cycleOf = (day, id) => (day.cycles || []).find(c => c.entry && c.entry.record === id) || null;

function dayTrades(day, { tick }) {
  const orders = new Map((day.orders || []).map(o => [o.id, o]));
  const fills = [...(day.fills || [])].sort((a, b) => a.id - b.id);
  // Each order the exchange took is one place_order call that reached it, in order: an entry's rationale (its record) is
  // its own call's, so an order that never filled (a limit that expired) shifts nothing; the gate's decision is the one
  // naming that record.
  const calls = (day.calls || []).filter(c => c.tool === 'place_order');
  const placedOrders = [...(day.orders || [])].filter(o => !o.parentId).sort((a, b) => a.id - b.id);
  // By the order's own tag when the call carried one (the gateway's), else by order (a refused call creates no order).
  const tagged = new Map(calls.filter(c => c.args && c.args.customTag).map(c => [c.args.customTag, c]));
  const callOf = new Map(placedOrders.map((o, k) => [o.id, o.customTag && tagged.has(o.customTag) ? tagged.get(o.customTag) : calls[k] && Number(calls[k].args.size) === (o.requested || o.size) ? calls[k] : null]));
  const gateOf = rationale => (day.gate || []).find(g => g.tool === 'place_order' && g.source === 'gateway' && g.decision === 'allowed' && String(g.rationale || '') === rationale) || null;
  const out = [];
  let open = null;
  for (const f of fills) {
    const o = orders.get(f.orderId);
    const call = o ? callOf.get(o.id) : null;
    const entry = call && !/^\s*\[(exit|protect)\]/.test(String(call.args.rationale || ''));
    if (!open && f.profitAndLoss === null && o && !o.parentId && entry) { open = { f, o, placed: gateOf(call.args.rationale) }; continue; }
    if (!open || f.profitAndLoss === null) continue;
    out.push(tradeOf(day, open, f, orders.get(f.orderId), { tick }));
    open = null;
  }
  if (open) out.push(tradeOf(day, open, null, null, { tick }));
  return out;
}

function tradeOf(day, { f, o, placed }, exitFill, exitOrder, { tick }) {
  const side = sideOf(f.side);
  const s = side === 'long' ? 1 : -1;
  const idm = placed ? /record ([0-9a-f]{16})/.exec(String(placed.rationale || '')) : null;
  const id = idm ? idm[1] : null;
  const rec = (day.records || []).find(r => r.id === id) || null;
  const cyc = id ? cycleOf(day, id) : null;
  const bar = rec ? rec.cycleBar : cyc && cyc.entry && cyc.entry.timing ? barOf(cyc.entry.timing.barClose) : null;
  const dec = (day.decisions || []).find(d => d.bar === bar && !d.pass) || null;
  const riskPts = rec && rec.plan ? rec.plan.stop.ticks * tick : null;
  const sent = bar ? (day.sent || []).find(x => x.barClose === new Date(ms(bar) + stepMs()).toISOString()) || null : null;
  const targetR = rec && rec.plan && rec.plan.stop.ticks > 0 ? rec.plan.target.ticks / rec.plan.stop.ticks : null;
  const fillMs = ms(f.creationTimestamp);
  const exitMs = exitFill ? ms(exitFill.creationTimestamp) : null;
  const legs = (day.orders || []).filter(x => x.parentId === o.id && x.type === TYPE.stop);
  const bracket = legs[0] || null;
  const moves = (day.events || []).filter(e => e.kind === 'stop_moved' && ms(e.at) >= fillMs && (exitMs === null || ms(e.at) <= exitMs + stepMs()));
  const initialStop = bracket ? f.price - s * (o.brackets && o.brackets.stop ? o.brackets.stop * tick : 0) : null;
  const exitReason = !exitFill ? 'open' : exitOrder && exitOrder.type === TYPE.limit ? 'target' : exitOrder && exitOrder.type === TYPE.stop ? (moves.length ? 'trail' : 'stop') : 'close';
  const rr = exitFill && riskPts > 0 ? r4((s * (exitFill.price - f.price)) / riskPts) : null;
  const eod = (day.events || []).find(e => e.kind === 'close_recorded' && e.day === day.day && (exitMs === null || ms(e.at) >= exitMs));
  const attemptDay = day.attempt && Array.isArray(day.attempt.days) ? day.attempt.days.find(d => d.day === day.day) : null;
  const trace = [
    { step: 'bias', ok: Boolean(dec && dec.side === side), at: bar, side: dec ? dec.side : null, line: dec ? dec.bias || null : null },
    { step: 'setup', ok: Boolean(dec && dec.setup), at: bar, setup: dec ? dec.setup : null, kind: dec ? dec.kind : null },
    { step: 'compose', ok: Boolean(rec && rec.ok), at: rec ? rec.at : null, record: id },
    { step: 'phase2', ok: Boolean(cyc && cyc.entry && cyc.entry.size && Number.isInteger(cyc.entry.size.approved)), at: cyc && cyc.timing ? cyc.timing.decision || null : null, size: cyc && cyc.entry && cyc.entry.size ? cyc.entry.size.approved : null },
    { step: 'gate', ok: Boolean(placed) && !(placed.violations || []).length, at: cyc && cyc.timing ? cyc.timing.decision || null : null, tags: placed ? (placed.violations || []).map(v => v.check) : null },
    { step: 'order', ok: Boolean(cyc && cyc.entry && cyc.entry.timing && Number.isFinite(cyc.entry.timing.orderMs)), at: sent ? sent.at : null, afterCloseS: sent ? Math.round((ms(sent.at) - ms(sent.barClose)) / 1000) : null, orderMs: cyc && cyc.entry && cyc.entry.timing ? cyc.entry.timing.orderMs : null },
    { step: 'fill', ok: true, at: f.creationTimestamp, price: f.price, size: f.size },
    { step: 'bracket', ok: Boolean(bracket), at: bracket ? bracket.creationTimestamp : null, price: initialStop },
    ...moves.map(e => ({ step: 'trail', ok: targetR === null || e.peakR >= targetR - 1e-9, at: e.at, from: e.from, to: e.to, peakR: e.peakR === undefined ? null : r4(e.peakR) })),
    { step: 'exit', ok: Boolean(exitFill), at: exitFill ? exitFill.creationTimestamp : null, reason: exitReason, price: exitFill ? exitFill.price : null, R: rr },
    { step: 'eod', ok: Boolean(eod && attemptDay), at: eod ? eod.at : null, balance: attemptDay ? attemptDay.balance : null },
  ];
  const setup = dec ? dec.setup : null;
  return {
    key: `${day.day}|${side}|${bar}`, day: day.day, side, setup, bar, record: id, entry: f.price, size: f.size, entryTime: f.creationTimestamp,
    exitTime: exitFill ? exitFill.creationTimestamp : null, exitPrice: exitFill ? exitFill.price : null, exitReason, R: rr, riskPts, stopTicks: rec && rec.plan ? rec.plan.stop.ticks : null,
    orderMs: trace[STEPS.indexOf('order')].orderMs, trail: moves.map(e => e.to), steps: trace.map(x => x.step), trace,
  };
}

function traceProblems(t) {
  const out = [];
  const order = t.trace.map(x => STEPS.indexOf(x.step));
  for (const step of STEPS.filter(x => x !== 'trail')) if (!t.steps.includes(step)) out.push(`${t.key}: no ${step} step`);
  for (let i = 1; i < order.length; i += 1) if (order[i] < order[i - 1]) out.push(`${t.key}: ${t.trace[i].step} after ${t.trace[i - 1].step}, out of order`);
  for (const x of t.trace) if (!x.ok) out.push(`${t.key}: ${x.step} failed (${JSON.stringify({ ...x, step: undefined, ok: undefined })})`);
  // Times run forward from the fill: the bracket at it, each stop move, then the exit, then the end of day.
  const timed = t.trace.filter(x => ['fill', 'bracket', 'trail', 'exit', 'eod'].includes(x.step) && x.at);
  for (let i = 1; i < timed.length; i += 1) if (ms(timed[i].at) < ms(timed[i - 1].at)) out.push(`${t.key}: ${timed[i].step} at ${timed[i].at} before ${timed[i - 1].step} at ${timed[i - 1].at}`);
  return out;
}

/** The first break on the path of a setup at `bar` (the mock's decision there and what followed) that made no trade. */
function lostWhy(day, bar, side) {
  const dec = (day.decisions || []).find(d => d.bar === bar);
  if (!dec) return { category: 'a', why: 'no decision on that bar (no pass ran, or the position was open)' };
  if (dec.pass || dec.side !== side) return { category: 'a', why: dec.pass || `the mock took the ${dec.side} side` };
  if (dec.compose && dec.compose !== 'ok') return { category: 'b', why: dec.compose };
  const rec = (day.records || []).filter(r => r.cycleBar === bar && r.side === side).at(-1);
  if (!rec || !rec.ok) return { category: 'b', why: rec ? (rec.problems || [])[0] || 'NOT OK' : 'no compose record' };
  const cyc = cycleOf(day, rec.id);
  const e = cyc ? cyc.entry : null;
  if (!e) return { category: 'c', why: 'the runner ran no entry on the record' };
  if (e.outcome === 'vetoed' || (e.outcome === 'no-trade' && /phase 2/.test(String(e.why || '')))) return { category: 'c', why: e.why || e.outcome };
  if (e.outcome === 'late' || e.outcome === 'expired') return { category: 'e', why: `${e.why || e.outcome} (order ${e.timing && e.timing.orderMs !== null ? `${e.timing.orderMs} ms` : 'never sent'} after the bar close)` };
  const refused = (day.gate || []).filter(g => g.tool === 'place_order' && g.decision !== 'allowed' && String(g.rationale || '').includes(rec.id));
  if (refused.length) {
    const tags = [...new Set(refused.flatMap(g => (g.violations || []).map(v => v.check)))];
    const message = (refused[0].violations || []).map(v => v.message).find(m => /expired|late|chase|stale|age/.test(m)) || ((refused[0].violations || [])[0] || {}).message || '';
    const timing = tags.some(x => /late|chase|stale|fresh|age/.test(x)) || /expired/.test(message);
    const sent = (day.sent || []).find(x => x.barClose === new Date(ms(bar) + stepMs()).toISOString());
    const after = sent ? ` (the order ${Math.round((ms(sent.at) - ms(sent.barClose)) / 1000)} s after the bar close)` : '';
    return { category: timing ? 'e' : 'd', why: `[${tags.join('] [')}] ${message}${timing ? after : ''}`.trim() };
  }
  if (e.outcome === 'blocked') return { category: 'd', why: e.why || 'blocked' };
  if (e.outcome === 'executed') return { category: 'f', why: 'the order went and never filled' };
  return { category: 'c', why: `${e.outcome}: ${e.why || ''}`.trim() };
}

/**
 * A fault day's checks (the broker-fault scenarios, tests/goal/tier2.goal.js): from the account after each pass
 * (`snaps`: the position and the working stops), the gate's log and the faults armed (`faults`). Problems when:
 *   - a position was left without a stop covering it (the opposite side, its whole size) for more than one pass in a row
 *     (one managed cycle), or never covered again;
 *   - an exit was refused (a close, a stop move, a cancel, an [exit] or [protect] order the gate didn't allow; a cancel
 *     refused as a working position's stop, [cancel-protection], on a late-fill day only: the gate protecting it, the
 *     runner's attempt traced as a `finding`);
 *   - a duplicate position opened (larger than the largest entry order sent, or a second entry order while one is open);
 *   - the fault left no recovery: no pass after it with the position flat or covered.
 * Returns { problems, trace }: trace the fault and its recovery, in order, as the day's path records them.
 */
function faultChecks(day) {
  const problems = [];
  const trace = [];
  const covered = sn => !sn.position || sn.stops.filter(o => (o.side === 1) === (sn.position.side === 'long')).reduce((a, o) => a + o.size, 0) >= sn.position.size;
  let run = 0;
  let worst = 0;
  for (const sn of day.snaps || []) { run = covered(sn) ? 0 : run + 1; worst = Math.max(worst, run); }
  if (worst > 1) problems.push(`a position went ${worst} passes in a row without a stop covering it (at most one managed cycle)`);
  const last = (day.snaps || []).at(-1);
  if (last && !covered(last)) problems.push(`the day ended with a position not covered by a stop (${JSON.stringify(last)})`);
  // An exit or a stop move the gate refused is a problem; a cancel it refused because the order is a working position's
  // stop ([cancel-protection]) is the gate keeping the position protected: traced, never a problem.
  const exitTools = new Set(['close_position', 'partial_close_position', 'cancel_order', 'modify_order']);
  for (const g of day.gate || []) {
    const exit = exitTools.has(g.tool) || /^\s*\[(exit|protect)\]/.test(String(g.rationale || ''));
    if (!exit || g.decision === 'allowed') continue;
    const tags = (g.violations || []).map(v => v.check);
    // Only on a day whose fault hid the position (late-fill): the runner tried to cancel a live stop it couldn't see, a
    // finding of the runner's the trace keeps; on any other day it is a problem.
    const lateDay = (day.faults || []).some(f => /^late-fill/.test(f.kind));
    if (lateDay && g.tool === 'cancel_order' && tags.length && tags.every(t => t === 'cancel-protection')) { trace.push({ step: 'finding', at: g.ts || null, how: 'the runner tried to cancel the position\'s working stop while the fill was reported late; only the gate\'s [cancel-protection] kept it' }); continue; }
    problems.push(`an exit refused: ${g.tool} [${tags.join('] [')}]`);
  }
  const entries = (day.orders || []).filter(o => !o.parentId && o.type !== TYPE.stop);
  const most = Math.max(0, ...entries.map(o => o.requested || o.size));
  for (const sn of day.snaps || []) if (sn.position && sn.position.size > most) problems.push(`a duplicate position: ${sn.position.size} held, the largest entry ${most}`);
  const placed = (day.gate || []).filter(g => g.tool === 'place_order' && g.decision === 'allowed' && !/^\s*\[(exit|protect)\]/.test(String(g.rationale || '')));
  const byCycle = new Map();
  for (const g of placed) byCycle.set(g.cycle, (byCycle.get(g.cycle) || 0) + 1);
  for (const [c, n] of byCycle) if (n > 1) problems.push(`${n} entry orders in one cycle (${c}): a duplicate entry`);
  for (const f of day.faults || []) {
    trace.push({ step: 'fault', at: f.at, kind: f.kind });
    // Recovery: a pass after the fault's own (the next managed cycle or later), covered or flat.
    const after = (day.snaps || []).filter(sn => ms(sn.at) > ms(f.at));
    const ok = after.find(sn => covered(sn));
    // The fault must have fired: its switch used up on the exchange (faultState: the switches at the day's end).
    const left = day.faultState || {};
    const fired = { 'lost-reply': true, 'late-fill': !(left.latePositions > 0), 'late-fill-long': !(left.latePositions > 0), 'partial-fill': !(left.partialEntry > 0), 'modify-refused': !(left.modifyFaults > 0), 'modify-error': !(left.modifyFaults > 0) }[f.kind];
    if (fired === false) problems.push(`${f.kind}: the fault never fired (its switch was not used up)`);
    if (/^modify-/.test(f.kind) && fired && !(day.events || []).some(e => e.kind === 'stop_moved' && !e.why && ms(e.at) > ms(f.at))) problems.push(`${f.kind}: the stop was never moved after the refused move (the trail never re-attempted)`);
    if (!ok) { problems.push(`${f.kind}: no recovery after it (no pass with the position covered by its stop, or flat)`); continue; }
    trace.push({ step: 'recovery', at: ok.at, how: ok.position ? `the position (${ok.position.size} ${ok.position.side}) covered by its stop at ${ok.stops.map(o => o.price).join(', ')}` : 'flat, nothing working' });
  }
  if (!(day.faults || []).length) problems.push('no fault was armed (the day placed no order)');
  return { problems, trace };
}

/**
 * A catch-the-move scenario's layers (the golden move days, tests/fixtures/goal/move-scenarios.json): the day's first
 * trade read layer by layer, the values the golden pins. `exit` is the policy's exit plan (evaluator.js composedExit:
 * its afterTarget lockGivebackR). null: no trade that day (every layer then says so).
 *   bias     the Bias line on the decision bar
 *   setup    the setup the briefing listed and the mock took: its read, kind and bar
 *   entry    the bar the order went on, the fill price and size
 *   stop     the bracket stop and 1R in points
 *   exit     the 2R target order cancelled at the first managed cycle (or filled before it), the stop held until the
 *            target's R, the first move at or past the +lock (the target's R less lockGivebackR), each move's price, the
 *            exit's reason, time, price and R
 *   capture  the leg (the census detector's, trend-capture.js legsOf on the curation session) the trade caught by
 *            trend-capture's rule (its way, entered in the leg's first catchShare), its available R, the share captured
 */
function moveLayers(day, { tick, exit }) {
  const t = dayTrades(day, { tick })[0] || null;
  if (!t) return null;
  const at = step => t.trace.find(x => x.step === step) || {};
  const s = t.side === 'long' ? 1 : -1;
  const plan = (day.records || []).find(r => r.id === t.record);
  const targetR = plan && plan.plan && plan.plan.stop.ticks > 0 ? plan.plan.target.ticks / plan.plan.stop.ticks : null;
  const entryOrder = (day.orders || []).find(o => !o.parentId && o.filledPrice === t.entry && o.size === t.size);
  const leg = entryOrder ? (day.orders || []).find(o => o.parentId === entryOrder.id && o.type === TYPE.limit) : null;
  const firstManaged = ms(t.entryTime) + stepMs() + stepMs();
  const targetLeg = !leg ? 'none' : leg.status === STATUS.cancelled && ms(leg.updateTimestamp) <= firstManaged ? 'cancelled at the first managed cycle'
    : leg.status === STATUS.filled ? 'filled' : leg.status === STATUS.cancelled ? `cancelled late (${leg.updateTimestamp})` : 'still working';
  const moves = t.trace.filter(x => x.step === 'trail');
  const lock = targetR !== null && t.riskPts > 0 && exit && exit.afterTarget ? t.entry + s * (targetR - exit.afterTarget.lockGivebackR) * t.riskPts : null;
  const g = (day.legs || []).find(x => x.side === t.side && x.day === t.day && ms(t.entryTime) >= ms(x.start) && ms(t.entryTime) <= ms(x.until)) || null;
  const availR = g && t.riskPts > 0 ? r4(Math.abs(g.to - g.startClose) / t.riskPts) : null;
  return {
    bias: at('bias').line || null,
    setup: { read: t.setup, kind: at('setup').kind || null, bar: t.bar },
    entry: { bar: t.bar, type: plan && plan.plan && plan.plan.entry ? plan.plan.entry.type : null, price: t.entry, size: t.size },
    stop: { price: at('bracket').price ?? null, riskPts: t.riskPts },
    exit: {
      target: targetLeg, heldToTarget: moves.every(x => x.ok), lockFirst: moves.length && lock !== null ? s * (moves[0].to - lock) >= -tick : null,
      moves: moves.map(x => x.to), reason: t.exitReason, time: t.exitTime, price: t.exitPrice, R: t.R,
    },
    capture: { caught: Boolean(g), leg: g ? `${g.side} ${g.start} to ${g.end}` : null, availR, share: availR > 0 ? r4(t.R / availR) : null },
  };
}

/** The per-layer differences of a move day against its golden: ["SETUP: expected ..., got ..."]; prices within a tick. */
function moveDiff(expected, got, { tick, shareTol = 0 }) {
  const say = x => (x === null || x === undefined ? 'none' : typeof x === 'object' ? JSON.stringify(x) : String(x));
  if (!expected && !got) return [];
  if (!expected || !got) return ['BIAS', 'SETUP', 'ENTRY', 'STOP', 'EXIT', 'CAPTURE'].map(k => `${k}: expected ${expected ? say(expected[k.toLowerCase()]) : 'no trade'}, got ${got ? say(got[k.toLowerCase()]) : 'no trade'}`);
  const near = (a, b, tol) => (a === null || b === null ? a === b : Math.abs(a - b) <= tol + 1e-9);
  const out = [];
  if (expected.bias !== got.bias) out.push(`BIAS: expected ${say(expected.bias)}, got ${say(got.bias)}`);
  if (expected.setup.read !== got.setup.read || expected.setup.kind !== got.setup.kind || expected.setup.bar !== got.setup.bar) out.push(`SETUP: expected ${say(expected.setup)}, got ${say(got.setup)}`);
  if (expected.entry.bar !== got.entry.bar || expected.entry.type !== got.entry.type || !near(expected.entry.price, got.entry.price, tick) || expected.entry.size !== got.entry.size) out.push(`ENTRY: expected ${say(expected.entry)}, got ${say(got.entry)}`);
  if (!near(expected.stop.price, got.stop.price, tick) || !near(expected.stop.riskPts, got.stop.riskPts, tick)) out.push(`STOP: expected ${say(expected.stop)}, got ${say(got.stop)}`);
  const e = expected.exit;
  const n = got.exit;
  const movesSame = e.moves.length === n.moves.length && e.moves.every((x, i) => near(x, n.moves[i], tick));
  if (e.target !== n.target || e.heldToTarget !== n.heldToTarget || e.lockFirst !== n.lockFirst || !movesSame || e.reason !== n.reason || e.time !== n.time || !near(e.price, n.price, tick)) out.push(`EXIT: expected ${say(e)}, got ${say(n)}`);
  if (!got.exit.heldToTarget) out.push('EXIT: the stop moved before the target\'s R');
  if (expected.capture.caught && !got.capture.caught) out.push(`CAPTURE: expected the leg ${expected.capture.leg} caught, got none`);
  if (expected.capture.share !== null && !(got.capture.share >= expected.capture.share - shareTol)) out.push(`CAPTURE: expected at least ${expected.capture.share} of the leg's ${expected.capture.availR}R, got ${say(got.capture.share)}`);
  return out;
}

/**
 * A day's behaviour by its label (the fixture's): a trend day catches its leg (a trade its way entered in the leg's catch
 * window, trend-capture's rule) and rides it (its R); a non-trend day has no entry, or a loss of at most maxLossR (the
 * stop's, with its slippage); no day blows. { day, kind, trades, caught, R, worstR, blown, problems }: problems only for
 * what holds on every day (the loss bound, the blow); whether a trend day is caught is judged against main's.
 */
function dayBehaviour(day, trades, { maxLossR }) {
  const kind = day.label ? day.label.kind : null;
  const mine = trades.filter(t => t.day === day.day);
  const done = mine.filter(t => t.R !== null);
  const caught = (day.legs || []).some(g => mine.some(t => t.side === g.side && ms(t.entryTime) >= ms(g.start) && ms(t.entryTime) <= ms(g.until)));
  const worstR = done.length ? Math.min(...done.map(t => t.R)) : null;
  const problems = [];
  if (day.blown) problems.push(`${day.day}: the attempt blew`);
  if (kind !== 'trend' && worstR !== null && worstR < -maxLossR) problems.push(`${day.day} (${kind || 'unlabelled'}): a loss of ${worstR}R, past the controlled -${maxLossR}R`);
  return { day: day.day, kind, trades: mine.length, caught, R: r4(done.reduce((a, t) => a + t.R, 0)), worstR, blown: Boolean(day.blown), problems };
}

/** Main's caught trend days lost now: [problem]. */
function caughtLost(base, now) {
  const was = new Map((base || []).map(b => [b.day, b]));
  return now.filter(n => n.kind === 'trend' && was.get(n.day) && was.get(n.day).caught && !n.caught).map(n => `${n.day} (trend): main caught its leg, this PR doesn't`);
}

/**
 * The negative probes' verdicts (a probe day): each probe must be refused, by its expected refusal: a gate tag (an order:
 * `[tag]` in the gateway's reply) or a compose problem (compose_check's text). expected: { name: { tag } | { says } }.
 * [problem]: a probe missing, let through, or refused without its tag.
 */
function probeProblems(probes, expected) {
  const out = [];
  for (const [name, want] of Object.entries(expected)) {
    const p = (probes || []).find(x => x.name === name);
    if (!p) { out.push(`${name}: the probe never ran`); continue; }
    const tags = [...String(p.text).matchAll(/\[([a-z0-9-]+)\]/g)].map(m => m[1]);
    if (want.tag && !(/Blocked by/.test(String(p.text)) && tags.includes(want.tag))) out.push(`${name}: not refused by [${want.tag}] (${tags.length ? `refused by [${tags.join('] [')}]` : 'let through'})`);
    if (want.says && !(/NOT OK/.test(String(p.text)) && new RegExp(want.says).test(String(p.text)))) out.push(`${name}: compose_check did not refuse it with "${want.says}"`);
  }
  return out;
}

const fillKey = t => `${t.entry}|${t.size}|${t.entryTime}`;
const exitKey = t => `${t.exitReason}|${t.exitPrice}|${t.R}|${(t.trail || []).join(',')}`;
const trailText = t => ((t.trail || []).length ? `, trailed to ${t.trail.join(' > ')}` : ', never trailed');

function compareTrades(main, now, days) {
  const out = [];
  const byKey = new Map(now.map(t => [t.key, t]));
  const seen = new Set();
  for (const m of main) {
    const n = byKey.get(m.key);
    if (!n) {
      const day = days.find(d => d.day === m.day);
      const w = day ? lostWhy(day, m.bar, m.side) : { category: 'a', why: 'the day did not run' };
      out.push({ category: w.category, key: m.key, why: `lost: ${w.why}`, main: m, now: null });
      continue;
    }
    seen.add(n.key);
    if (fillKey(m) !== fillKey(n)) out.push({ category: 'f', key: m.key, why: `fill ${m.size} at ${m.entry} (${m.entryTime}) on main, ${n.size} at ${n.entry} (${n.entryTime}) now`, main: m, now: n });
    else if (exitKey(m) !== exitKey(n)) out.push({ category: 'g', key: m.key, why: `exit ${m.exitReason} ${m.exitPrice} (${m.R}R${trailText(m)}) on main, ${n.exitReason} ${n.exitPrice} (${n.R}R${trailText(n)}) now`, main: m, now: n });
    else if (m.steps.join(',') !== n.steps.join(',')) out.push({ category: 'h', key: m.key, why: `steps ${m.steps.join(' > ')} on main, ${n.steps.join(' > ')} now`, main: m, now: n });
  }
  for (const n of now) if (!seen.has(n.key) && !main.some(m => m.key === n.key)) out.push({ category: 'new', key: n.key, why: `a new trade: ${n.setup} ${n.side} ${n.size} at ${n.entry}, ${n.exitReason} ${n.R}R`, main: null, now: n });
  return out;
}

/**
 * The mechanical tier's first entry each day (goal-trades.js) filled by tier 2: a tier 2 entry the same day and side
 * whose fill is within one setup-frame span of the mechanical entry.
 */
function fillShare(trades, mechanical, spanMs) {
  if (!mechanical.length) return null;
  const hit = mechanical.filter(m => trades.some(t => t.day === m.day && t.side === m.side && Math.abs(ms(t.entryTime) - ms(m.entryTime)) <= spanMs));
  return r4(hit.length / mechanical.length);
}

const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

function summarize(trades, { legs = [], mechanical = [], spanMs, blows = 0 }) {
  const done = trades.filter(t => t.R !== null);
  const totalR = r4(done.reduce((a, t) => a + t.R, 0));
  const refRiskPts = median(done.map(t => t.riskPts));
  let rc = 0;
  let ra = 0;
  for (const g of legs) {
    if (refRiskPts > 0) ra += Math.abs(g.to - g.startClose) / refRiskPts;
    const t = done.find(x => x.side === g.side && x.day === g.day && ms(x.entryTime) >= ms(g.start) && ms(x.entryTime) <= ms(g.until));
    if (t) rc += t.R;
  }
  return {
    trades: trades.length, totalR, meanR: done.length ? r4(totalR / done.length) : 0, caught: ra > 0 ? r4(rc / ra) : 0,
    fills: fillShare(trades, mechanical, spanMs), blows,
  };
}

const TIER2 = Object.freeze([
  Object.freeze({ key: 'blows', label: 'tier 2 blows (days)', dir: 'max', tol: null }),
  Object.freeze({ key: 'trades', label: 'tier 2 trades', dir: 'min', tol: 'trades' }),
  Object.freeze({ key: 'totalR', label: 'tier 2 total R', dir: 'min', tol: 'totalR' }),
  Object.freeze({ key: 'fills', label: 'tier 2 fills of the mechanical first entries', dir: 'min', tol: 'fills' }),
]);

function tier2Rows(base, now, tol) {
  return TIER2.map(g => {
    const main = base[g.key];
    const pr = now[g.key];
    const t = g.tol ? tol[g.tol] : 0;
    const allowed = g.dir === 'max' ? r4(main + t) : r4(main - t);
    const ok = typeof pr === 'number' && typeof main === 'number' && (g.dir === 'max' ? pr <= allowed : pr >= allowed);
    return { half: 'T2', key: g.key, label: g.label, main, pr, allowed: `${g.dir === 'max' ? '<=' : '>='} ${allowed}`, ok, gated: true };
  });
}

function tier2RiseProblems(base, next) {
  if (!base) return [];
  if (!next) return ['tier 2: the new baseline has no summary'];
  const out = [];
  if (next.blows > base.blows) out.push(`tier 2 blows: ${next.blows} in the new baseline, ${base.blows} on the base branch`);
  for (const k of ['trades', 'totalR', 'fills']) if (typeof base[k] === 'number' && !(next[k] >= base[k])) out.push(`tier 2 ${k}: ${next[k]} in the new baseline, ${base[k]} on the base branch: a baseline only improves`);
  return out;
}

/**
 * Tier 2's days: `trendDays` of the fixture's trend days and `otherDays` of its other days, each half alike (half of
 * each from half A, the rest from B), in a seeded order (a hash of the seed and the date), sorted.
 */
function pickDays(blocks, { seed, trendDays, otherDays }) {
  const order = list => [...list].sort((a, b) => crypto.createHash('sha256').update(`${seed}|${a}`).digest('hex').localeCompare(crypto.createHash('sha256').update(`${seed}|${b}`).digest('hex')));
  const out = [];
  for (const [kind, n] of [['trend', trendDays], ['other', otherDays]]) {
    const half = h => blocks.filter(b => b.half === h).flatMap(b => (kind === 'trend' ? b.trend : b.sessions.filter(d => !b.trend.includes(d))));
    const a = Math.ceil(n / 2);
    out.push(...order(half('A')).slice(0, a), ...order(half('B')).slice(0, n - a));
  }
  return out.sort();
}

/** A floor day's D13 refusal (see the header). */
function floorChecks(day, { rule, bind }) {
  const tick = day.tick;
  const rec = (day.records || []).find(r => !r.ok && r.plan && r.plan.stop && (r.problems || []).some(p => /under the minimum/.test(p)));
  if (!rec) return { refused: null, problems: [`${day.day}: no compose record refused by the stop floor (D13)`] };
  const s = rec.plan.stop;
  const problems = [];
  const named = rec.side === 'long' ? s.level - s.bufferTicks * tick : s.level + s.bufferTicks * tick;
  if (Math.round((s.price - named) / tick) !== 0) problems.push(`${day.day}: the stop ${s.price} is not the named level ${s.level} less its buffer: widened`);
  if (!(s.ticks < s.floorTicks)) problems.push(`${day.day}: refused at ${s.ticks} ticks, not under its floor ${s.floorTicks}`);
  if (bind === 'ticks' && s.floorTicks !== rule.floorTicks) problems.push(`${day.day}: the floor ${s.floorTicks} is not stop_floor_ticks ${rule.floorTicks} (the tick term must bind)`);
  if (bind === 'atr' && !(s.floorTicks > rule.floorTicks && s.ticks >= rule.floorTicks)) problems.push(`${day.day}: the ATR term must bind: the floor ${s.floorTicks} above stop_floor_ticks ${rule.floorTicks}, the stop ${s.ticks} at least it`);
  const trades = dayTrades(day, { tick });
  if (trades.length) problems.push(`${day.day}: ${trades.length} trade(s): ${trades.map(t => `${t.side} ${t.size} at ${t.entry}`).join(', ')}`);
  return { refused: rec, problems };
}

function shardOf(text) {
  if (text === undefined || text === null || text === '') return null;
  const m = /^(\d+)\/(\d+)$/.exec(String(text));
  const k = m ? Number(m[1]) : NaN;
  const n = m ? Number(m[2]) : NaN;
  if (!(k >= 1 && k <= n)) throw new Error(`FTH_GOAL_SHARD ${text}: k/n, k from 1 to n`);
  return { k, n };
}

const shardDays = (days, shard) => (shard ? days.filter((_, i) => i % shard.n === shard.k - 1) : [...days]);

function shardCoverage(parts, { days, fixture }) {
  const problems = [];
  const ns = [...new Set(parts.map(p => p.shard && p.shard.n))];
  if (!parts.length) return ['no shard results'];
  if (ns.length !== 1) problems.push(`the shards disagree on their count: ${ns.join(', ')}`);
  const n = ns[0];
  const ks = parts.map(p => p.shard.k).sort((a, b) => a - b);
  const want = Array.from({ length: n }, (_, i) => i + 1);
  if (ks.join(',') !== want.join(',')) problems.push(`shards ${ks.join(',')} of ${n}: each of ${want.join(',')} once`);
  for (const p of parts) if (p.fixture !== fixture) problems.push(`shard ${p.shard.k}/${p.shard.n}: another fixture (${p.fixture})`);
  const got = parts.flatMap(p => p.days);
  const dup = got.filter((d, i) => got.indexOf(d) !== i);
  if (dup.length) problems.push(`days run twice: ${[...new Set(dup)].join(', ')}`);
  const missing = days.filter(d => !got.includes(d));
  if (missing.length) problems.push(`days no shard ran: ${missing.join(', ')}`);
  const extra = got.filter(d => !days.includes(d));
  if (extra.length) problems.push(`days not tier 2's: ${[...new Set(extra)].join(', ')}`);
  return problems;
}

module.exports = { floorChecks, shardOf, shardDays, shardCoverage, probeProblems, dayBehaviour, caughtLost, moveLayers, moveDiff, faultChecks, pickDays, STEPS, CATEGORIES, TIER2, dayTrades, traceProblems, lostWhy, compareTrades, fillShare, summarize, tier2Rows, tier2RiseProblems };
