'use strict';

/**
 * The runner's entry end to end (workflows/entry, scripts/lib/runner-entry.js), in replay: the decision-path world
 * (tests/fixtures/decision-path.js: the live runner as the harness wires it, at a replayed time on the parity bars, the
 * mock exchange as a replay broker behind the real adapter and the real order gateway). The runner runs the desk (each
 * role's run scripted), the head trader composes with the real compose_check and ends with `CYCLE RESULT: planned`;
 * then the runner runs risk-manager phase 2 and the trade-executor through the production glue (cycle-run.js runRole:
 * the role's own environment, its own transcript), each played by the scripted model, the order through the real
 * gateway and gate. What reached the broker, what the gate decided, and what the runner recorded are asserted.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const exchange = require('../fixtures/mock-exchange');
const D = require('../fixtures/decision-path');
const { scriptedModel } = require('../fixtures/scripted-model');
const { runRole: realRunRole } = require('../../scripts/lib/cycle-run');
const { ENTRY_TEXT } = require('../../scripts/lib/autotrader');
const { REQUIRED_FOR_COMPOSED } = require('../../scripts/lib/trading/skills-loaded');
const TL = require('../../scripts/lib/trading/trade-lifecycle');

const { FIRED_BAR, NEXT_BAR, decisionAt, MNQ_ID } = D;

// The composed long on the fired bar's real facts (as tests/e2e/decision-path-e2e.test.js composes it).
const LC_READS = [
  { step: 'bias', skill: 'multi-timeframe-analysis', read: '4h up', why: 'the 4h trend is up' },
  { step: 'location', skill: 'vwap-volume-profile', read: 'value above', why: 'above the prior value area' },
  { step: 'bias', skill: 'htf-to-ltf', read: 'trend long allowed', why: 'the trend rule takes the long' },
  { step: 'setup', skill: 'rejection', read: '15m rejected prior VAH up', why: 'the 15m dipped under the prior VAH and closed back above' },
  { step: 'entry', skill: 'candle-reading', read: '3m close top', why: 'the 3m bar closed at its high' },
  { step: 'stop', skill: 'invalidation', read: 'stop swing low 27404.75', why: 'under the last swing low it is wrong' },
  { step: 'target', skill: 'top-down-entry', read: 'target 1h swing 27512.00', why: 'the next 1h swing high' },
];

/** The head trader's cycle when the runner runs the entry: its loads, the briefing, compose_check, then `planned`. */
function headPlanned(w, o = {}) {
  return [
    ...(o.pre ? [{ act: o.pre }] : []),
    // Full mode: the head trader loads the composed entry's skills with its skill tool (index: embedded in its prompt).
    ...(w.mode === 'full' ? [...new Set([...D.headLoads(w), ...REQUIRED_FOR_COMPOSED])].map(s => ({ load: s })) : []),
    { harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } },
    ...D.entryLoads(w).map(s => ({ load: s })),
    { harness: 'compose_check', args: { symbol: 'MNQ', side: 'long', reads: LC_READS, size: o.size || 1 } },
    { result: o.result || `CYCLE RESULT: planned - trade_lifecycle long ${o.size || 1}` },
  ];
}

// The desk the runner runs: each role's scripted run (its report, its reads, the lookups its bar requires).
const deskReport = role => ({
  ok: true, timedOut: false, output: '', lookups: D.REQUIRED_LOOKUPS[role] || [],
  tools: [role === 'risk-manager' ? 'broker_get_account_snapshot' : 'harness_bar_briefing'],
  text: role === 'risk-manager' ? '## Risk state: account 7 @ now\nTradable: yes' : `## ${role}\nData: bar_briefing m3@x\nBias: long`,
});

/** Phase 2 as the risk manager plays it: the briefing, order_plan on the record, then its verdict and FACTS. */
const phase2 = (w, { verdict = 'APPROVE - size 1, risk $46.00, trade_lifecycle long with the trend', facts = null } = {}) => prompt => {
  const bars = /are in (\S+) \(get_bars format\)/.exec(prompt)[1];
  return [
    { harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } },
    { harness: 'order_plan', args: { bars, symbol: 'MNQ', strategy: 'trade_lifecycle', side: 'long', accountId: 7 } },
    { result: () => `Phase 2 on the trade_lifecycle long plan for MNQ.\nVERDICT: ${verdict}\nFACTS: ${facts || D.trueFacts(w).join('; ')}` },
  ];
};

/** The order the runner's request names (order_plan's place_order arguments, built in code). */
const requestedArgs = prompt => JSON.parse(/built by the runner from this bar's compose record: (\{.*\})\. Send them as given/.exec(prompt)[1]);

/** The trade-executor as it plays it: the account, place_order with the arguments as given, its report. */
const executor = (o = {}) => prompt => [
  ...(o.pre ? [{ act: o.pre }] : []),
  { broker: 'get_account_snapshot', args: { accountId: 7 } },
  { broker: 'place_order', args: requestedArgs(prompt) },
  { result: ctx => {
    const c = ctx.calls.filter(x => x.tool === 'place_order').at(-1);
    let reply = null;
    try { reply = c ? JSON.parse(c.text) : null; } catch (_err) { /* text */ }
    const refused = Boolean(c && c.ok && reply && reply.success === false);
    return c && c.ok && !refused ? `EXECUTED\nOrders: ${c.text.slice(0, 120)}` : `${/Blocked by/.test(c ? c.text : '') ? 'BLOCKED' : 'ABORTED'}\n${c ? c.text.slice(0, 600) : 'no reply'}`;
  } },
];

/**
 * The runner's runRole: the desk scripted (deskReport), phase 2 and the trade-executor through the production glue
 * (cycle-run.js runRole: the role's own run and environment) played by the scripted model. `o.phase2`, `o.executor`:
 * their scripts; `o.fail`: { role: result } a role's run that fails (as the harness returns it), every attempt.
 */
function roles(w, at, o = {}) {
  const runs = [];
  const runRole = async (role, request, limits) => {
    const isPhase2 = role === 'risk-manager' && /^Phase 2, plan verdict/.test(request);
    runs.push({ role: isPhase2 ? 'risk-manager phase 2' : role, request, context: limits.context, timeoutMs: limits.timeoutMs });
    const failed = o.fail && o.fail[isPhase2 ? 'phase2' : role];
    if (failed) return failed;
    if (!isPhase2 && role !== 'trade-executor') return deskReport(role);
    const model = scriptedModel(isPhase2 ? (o.phase2 || phase2(w)) : (o.executor || executor()));
    const r = await realRunRole(w.cfg, role, request, limits, { root: D.ROOT, home: w.home, env: D.passEnv(w, at), run: model });
    runs[runs.length - 1].env = model.last && model.last.env;
    runs[runs.length - 1].calls = model.last ? model.last.calls : [];
    return r;
  };
  return { runRole, runs };
}

/** The gate's place_order decisions. */
const entries = w => D.gateLog(w).filter(x => /place_order/.test(String(x.tool || '')) && x.source === 'gateway');
const journal = w => fs.readFileSync(w.journal, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

for (const mode of ['index', 'full']) {
  test(`entry workflow, replay (${mode} mode): the desk runs, the head trader composes and says planned, the runner runs phase 2 and the trade-executor with the code-built order; the gate allows it, it fills, the runner manages it, it exits at its stop, end of day finds it flat`, async () => {
    const w = D.world({ mode });
    const at = decisionAt(FIRED_BAR);
    const R = roles(w, at);
    const r = await D.pass(w, at, headPlanned(w), { runRole: R.runRole });
    // The order of the round: the desk, then phase 2 on the plan, then the trade-executor.
    assert.deepStrictEqual(R.runs.map(x => x.role).slice(-2), ['risk-manager phase 2', 'trade-executor']);
    assert.deepStrictEqual(R.runs.slice(0, -2).map(x => x.role).sort(), ['market-structure-analyst', 'risk-manager', 'trend-momentum-analyst', 'volume-liquidity-analyst']);
    // The head trader was told the route, and its run carries the entry's rule switch; the roles' runs never do.
    const { prompt, context } = r.ran[0];
    assert.ok(prompt.includes(ENTRY_TEXT), 'the head prompt says the route');
    assert.doesNotMatch(prompt, /then risk-manager phase 2 on your plan, if any/, 'not the roster\'s phase 2');
    assert.strictEqual(r.ctx.env.FTH_CYCLE_ENTRY, '1');
    assert.strictEqual(context.entry, true);
    const exec = R.runs.at(-1);
    assert.strictEqual(exec.env.FTH_CYCLE_ENTRY, undefined);
    assert.strictEqual(exec.env.FTH_CYCLE_ROLES, context.rolesFile, 'the executor\'s gate reads the cycle\'s role record');
    assert.strictEqual(exec.env.FTH_CYCLE_ID, require('../../scripts/lib/trading/check-order').cycleId(r.ctx.env), 'its orders are the cycle\'s');
    assert.notStrictEqual(exec.env.FTH_CYCLE_TRANSCRIPT, r.ctx.env.FTH_CYCLE_TRANSCRIPT, 'its own transcript');
    assert.strictEqual(exec.env.FTH_CYCLE_BARS, r.ctx.env.FTH_CYCLE_BARS, 'the cycle\'s bar');
    // Phase 2's request carries the record, the desk's reports with phase 1, and the cycle's bars file.
    const p2 = R.runs.at(-2).request;
    const rec = TL.readRecords(w.home, 'MNQ').at(-1);
    assert.ok(rec.ok && p2.includes(rec.id), 'the compose record');
    assert.match(p2, /--- risk-manager phase 1 report ---\n## Risk state: account 7/);
    assert.match(p2, /--- market-structure-analyst report ---/);
    assert.match(p2, /are in \/\S+MNQ-3m\.json \(get_bars format\)/);
    // The order: order_plan's arguments, built in code, sent as they are; the gate allowed it.
    const sent = D.placedAtBroker(w);
    assert.strictEqual(sent.length, 1);
    const args = requestedArgs(exec.request);
    assert.deepStrictEqual([args.type, args.limitPrice, args.size, args.stopLossBracket.ticks, args.takeProfitBracket.ticks], ['limit', 27427.5, 1, 92, 338]);
    assert.match(args.rationale, new RegExp(`^setup:trade_lifecycle long limit 27427.50 .* record ${rec.id}$`));
    assert.deepStrictEqual(entries(w).map(e => [e.decision, (e.violations || []).map(v => v.check)]), [['allowed', []]]);
    // The plan journal the runner wrote through the adapter, for this bar.
    const plan = journal(w).filter(e => e.kind === 'plan');
    assert.strictEqual(plan.length, 1);
    assert.deepStrictEqual([plan[0].contractId, plan[0].tags], ['MNQ', ['setup:trade_lifecycle', 'MNQ']]);
    assert.ok(plan[0].text.includes(rec.id) && Date.parse(plan[0].ts) >= Date.parse(FIRED_BAR) + D.STEP, plan[0].text);
    // Filled, its stop working.
    assert.strictEqual(D.position(w).size, 1);
    assert.ok(D.working(w).some(o2 => o2.type === 4), 'the stop bracket works');
    // The cycle's outcome, the history and the cycle log.
    assert.match(r.ran[0].result, /^CYCLE RESULT: executed - trade_lifecycle long 1 MNQ \(the runner's entry: phase 2 approved, the order filled\)$/);
    assert.strictEqual(r.state.history.at(-1).action, D.RESULT_ACTION.executed);
    assert.strictEqual(r.state.history.at(-1).setup, 'trade_lifecycle');
    const line = D.cycleLines(w).at(-1);
    assert.deepStrictEqual([line.result, line.entry.outcome, line.entry.ran, line.entry.record], [r.ran[0].result, 'executed', ['risk-manager', 'trade-executor'], rec.id]);
    assert.deepStrictEqual([line.desk.complete, line.desk.missing], [true, []]);
    assert.strictEqual(line.orders.length, 1, 'the executor\'s order is the cycle\'s');
    assert.deepStrictEqual(line.missingSkills, []);
    // Phase 2's facts are checked and logged from the role record.
    assert.deepStrictEqual([line.factCheck.reports, line.factCheck.false], [1, 0], JSON.stringify(line.factCheck));
    assert.ok(!fs.existsSync(context.rolesFile), 'the role record ends with the cycle');

    // The next bar: a position, so no entry this cycle; the runner keeps it protected (the head trader manages).
    const R2 = roles(w, decisionAt(NEXT_BAR));
    const next = await D.pass(w, decisionAt(NEXT_BAR), [{ result: 'CYCLE RESULT: managed - holding the long, stop working' }], { runRole: R2.runRole });
    assert.strictEqual(next.ran[0].context.entry, undefined, 'not an entry cycle with a position open');
    assert.ok(!R2.runs.some(x => x.role === 'trade-executor' || x.role === 'risk-manager phase 2'));
    assert.strictEqual(D.position(w).size, 1);
    assert.ok(next.events.some(e => e.kind === 'position_managed'), 'the runner managed it by its exit plan');
    const stop = D.working(w).find(o2 => o2.type === 4);
    assert.ok(stop && stop.stopPrice >= 27404.5, 'still protected, never loosened');
    // The market falls through its stop: out at the stop.
    exchange.setPrice(w.state, MNQ_ID, stop.stopPrice - 0.25);
    assert.strictEqual(D.position(w), null, 'out at the stop');
    assert.deepStrictEqual(D.working(w), [], 'nothing left working');
    assert.strictEqual(exchange.read(w.state).fills.at(-1).price, stop.stopPrice - 0.25);
    // End of day: the runner's flatten finds the account flat.
    const eodAt = '2026-04-28T19:52:00.000Z'; // 15:52 ET, after the 15:50 ET end of day
    const eod = await D.pass(w, eodAt, () => [{ result: 'CYCLE RESULT: flattened - end of day, flat' }]);
    assert.ok(eod.ran.some(x => x.action === 'eod'), JSON.stringify([eod.ran.map(x => x.action), eod.logs]));
    assert.strictEqual(D.position(w), null);
    assert.strictEqual(D.placedAtBroker(w).filter(c => !/^\s*\[(exit|protect)\]/.test(String(c.args.rationale || ''))).length, 1, 'one entry in all');
  });
}

test('entry workflow, full mode: the head trader\'s loads count for the trade-executor\'s run only from the runner\'s record of them; without it the gate refuses [skills-loaded] and nothing is placed', async () => {
  const RR = require('../../scripts/lib/trading/runner-roles');
  const orig = RR.appendHeadSkills;
  RR.appendHeadSkills = () => { throw new Error('disk full'); };
  try {
    const w = D.world({ mode: 'full' });
    const at = decisionAt(FIRED_BAR);
    const R = roles(w, at);
    const r = await D.pass(w, at, headPlanned(w), { runRole: R.runRole });
    const e = entries(w).at(-1);
    assert.strictEqual(e.decision, 'blocked');
    assert.deepStrictEqual(e.violations.map(v => v.check), ['skills-loaded', 'skills-at-entry'], JSON.stringify(e.violations));
    assert.deepStrictEqual(D.placedAtBroker(w), []);
    assert.match(r.ran[0].result, /^CYCLE RESULT: blocked - the order gate refused the trade_lifecycle long 1 MNQ: \[skills-loaded\]/);
    assert.ok(r.logs.some(l => /the head trader's skills could not be recorded \(disk full\)/.test(l)));
  } finally {
    RR.appendHeadSkills = orig;
  }
});

test('entry workflow: phase 2 vetoes: no trade-executor runs, nothing reaches the broker, no plan is written; the cycle is a no-trade with the veto, recorded as vetoed', async () => {
  const w = D.world();
  const at = decisionAt(FIRED_BAR);
  const R = roles(w, at, { phase2: phase2(w, { verdict: 'VETO - room: the 1h swing is too close, stand aside' }) });
  const r = await D.pass(w, at, headPlanned(w), { runRole: R.runRole });
  assert.ok(!R.runs.some(x => x.role === 'trade-executor'));
  assert.deepStrictEqual(D.placedAtBroker(w), []);
  assert.deepStrictEqual(entries(w), []);
  assert.deepStrictEqual(journal(w).filter(e => e.kind === 'plan'), []);
  assert.match(r.ran[0].result, /^CYCLE RESULT: no-trade - risk-manager vetoed the trade_lifecycle long 1 MNQ: VERDICT: VETO - room/);
  assert.strictEqual(r.state.history.at(-1).action, 'vetoed');
  const line = D.cycleLines(w).at(-1);
  assert.deepStrictEqual([line.entry.outcome, line.entry.ran], ['vetoed', ['risk-manager']]);
  assert.strictEqual(line.factCheck.reports, 1, 'a veto\'s facts are checked and logged too');
});

test('entry workflow: a stale briefing by the time the trade-executor sends (the cycle took too long): the gate refuses [briefing-age], nothing is placed, the cycle is blocked', async () => {
  const w = D.world();
  const at = decisionAt(FIRED_BAR);
  // The executor's run starts 9.5 minutes after the decision time (over the 3-bar, 9-minute limit on 3m bars).
  const late = ctx => {
    const t = new Date(Date.parse(at) + 9.5 * 60000).toISOString();
    // The replay's clock moved on with it: the server's, and the harness's.
    fs.writeFileSync(w.clock, JSON.stringify({ now: t }));
    exchange.update(w.state, s => { s.nowMs = Date.parse(t); });
    ctx.env.FTH_REPLAY_NOW = t;
  };
  const R = roles(w, at, { executor: executor({ pre: late }) });
  const r = await D.pass(w, at, headPlanned(w), { runRole: R.runRole });
  const e = entries(w).at(-1);
  assert.strictEqual(e.decision, 'blocked');
  assert.ok(e.violations.some(v => v.check === 'briefing-age'), JSON.stringify(e.violations));
  assert.deepStrictEqual(D.placedAtBroker(w), []);
  assert.strictEqual(D.position(w), null);
  assert.match(r.ran[0].result, /^CYCLE RESULT: blocked - the order gate refused the trade_lifecycle long 1 MNQ: .*\[briefing-age\] Stale data/);
  assert.strictEqual(D.cycleLines(w).at(-1).entry.outcome, 'blocked');
});

test('entry workflow: the head trader launching the trade-executor (or phase 2) itself is refused by the entry-route rule with the route, on the environment the runner gave its run; a cycle that isn\'t an entry cycle is untouched', async () => {
  const w = D.world();
  const at = decisionAt(FIRED_BAR);
  const R = roles(w, at);
  const r = await D.pass(w, at, headPlanned(w), { runRole: R.runRole });
  const { createPipeline } = require('../../scripts/lib/toolcall/pipeline');
  const { createCallLog } = require('../../scripts/lib/toolcall/call-log');
  const N = require('../../scripts/lib/toolcall/names');
  const pre = (env, args) => createPipeline({ log: createCallLog(), env, native: N.toOpencode }).before({ tool: 'task', name: 'task', args, session: 'h', id: null }).refuse;
  const route = /the runner runs (the trade-executor|risk-manager phase 2) this cycle.*call compose_check; when it is OK, end with CYCLE RESULT: planned; the runner runs risk-manager phase 2 and the trade-executor/;
  assert.match(pre(r.ctx.env, { subagent_type: 'trade-executor', prompt: 'Compose and check short trade' }) || '', route);
  assert.match(pre(r.ctx.env, { subagent_type: 'risk-manager', prompt: 'phase 2 on my plan' }) || '', route);
  // The next bar (a position open): no entry cycle, so the head trader's launches go.
  const next = await D.pass(w, decisionAt(NEXT_BAR), [{ result: 'CYCLE RESULT: managed - holding' }], { runRole: roles(w, decisionAt(NEXT_BAR)).runRole });
  assert.strictEqual(next.ctx.env.FTH_CYCLE_ENTRY, undefined);
  assert.strictEqual(pre(next.ctx.env, { subagent_type: 'trade-executor', prompt: 'tighten the stop' }), null);
});

test('entry workflow: planned without an OK compose record is a process failure, logged; nothing runs and nothing reaches the broker', async () => {
  const w = D.world();
  const at = decisionAt(FIRED_BAR);
  const R = roles(w, at);
  // 7 x 92 ticks x $0.50 = $322, over the $300 cap: compose_check says NOT OK; the head trader says planned anyway.
  const r = await D.pass(w, at, headPlanned(w, { size: 7 }), { runRole: R.runRole });
  assert.match(r.ctx.results.compose_check, /NOT OK/);
  assert.ok(!R.runs.some(x => x.role === 'trade-executor' || x.role === 'risk-manager phase 2'), JSON.stringify(R.runs.map(x => x.role)));
  assert.deepStrictEqual(D.placedAtBroker(w), []);
  assert.ok(r.logs.some(l => /^error the entry: planned without an OK compose record on the cycle's bar .*a process failure; nothing runs/.test(l)), r.logs.join('\n'));
  const line = D.cycleLines(w).at(-1);
  assert.strictEqual(line.entry.outcome, 'process-failure');
  assert.match(line.entry.failure, /planned without an OK compose record/);
  assert.strictEqual(r.ran[0].result, 'CYCLE RESULT: planned - trade_lifecycle long 7', 'its own decision kept');
});

for (const [name, fail, ran] of [
  ['phase 2 times out (every attempt)', { phase2: { ok: false, timedOut: true, text: '', tools: [], output: '' } }, ['risk-manager phase 2', 'risk-manager phase 2']],
  ['phase 2 reports no FACTS line', null, ['risk-manager phase 2', 'risk-manager phase 2']],
  ['the trade-executor\'s run fails before any order', { 'trade-executor': { ok: false, timedOut: true, text: '', tools: [], output: '' } }, ['risk-manager phase 2', 'trade-executor']],
]) {
  test(`entry workflow: ${name}: logged, no order, the cycle a no-trade naming it`, async () => {
    const w = D.world();
    const at = decisionAt(FIRED_BAR);
    const noFacts = () => [{ harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } }, { result: 'VERDICT: APPROVE - size 1' }];
    const R = roles(w, at, { fail: fail || {}, ...(fail ? {} : { phase2: noFacts }) });
    const r = await D.pass(w, at, headPlanned(w), { runRole: R.runRole });
    assert.deepStrictEqual(R.runs.map(x => x.role).filter(x => x === 'trade-executor' || x === 'risk-manager phase 2'), ran);
    assert.deepStrictEqual(D.placedAtBroker(w), []);
    assert.match(r.ran[0].result, /^CYCLE RESULT: no-trade - the runner's entry: /);
    assert.ok(r.logs.some(l => /^error the entry: /.test(l)), r.logs.join('\n'));
    assert.ok(['no-trade'].includes(D.cycleLines(w).at(-1).entry.outcome));
  });
}

test('entry workflow: the broker loses the entry\'s reply: the executor reports it unknown, the runner reads the account and finds the position (executed), no second entry is sent, and the exit still goes', async () => {
  const w = D.world();
  w.env.FTH_LANE_TIMEOUT_MS = '1500';
  const at = decisionAt(FIRED_BAR);
  exchange.update(w.state, s => { s.loseEntryReply = true; });
  const R = roles(w, at);
  const r = await D.pass(w, at, headPlanned(w), { runRole: R.runRole });
  assert.match(R.runs.at(-1).calls.find(c => c.tool === 'place_order').text, /no answer/, 'its reply never came');
  assert.strictEqual(D.placedAtBroker(w).length, 1, 'sent once');
  assert.strictEqual(D.position(w).size, 1, 'the broker took it');
  assert.match(r.ran[0].result, /^CYCLE RESULT: executed - trade_lifecycle long 1 MNQ/);
  exchange.update(w.state, s => { s.loseEntryReply = false; });
  // The next cycle closes it: an exit is never held.
  const next = await D.pass(w, decisionAt(NEXT_BAR), [
    { executor: [{ broker: 'place_order', args: { accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: '[exit] out of the long whose reply was lost' } }] },
    { result: 'CYCLE RESULT: managed - out' },
  ], { runRole: roles(w, decisionAt(NEXT_BAR)).runRole });
  assert.deepStrictEqual(next.ctx.calls.map(c => [c.tool, c.ok]), [['place_order', true]]);
  assert.strictEqual(D.position(w), null);
  assert.strictEqual(D.placedAtBroker(w).filter(c => !/^\s*\[(exit|protect)\]/.test(String(c.args.rationale || ''))).length, 1, 'no second entry');
});

test('entry workflow: a cycle that started with a position (and its working stop) is no entry cycle: the head trader runs it as before', async () => {
  const w = D.world();
  const at = decisionAt(FIRED_BAR);
  exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40 } }, {});
  const R = roles(w, at);
  const r = await D.pass(w, at, [{ result: 'CYCLE RESULT: managed - the open long' }], { runRole: R.runRole });
  assert.strictEqual(r.ran[0].context.entry, undefined);
  assert.strictEqual(r.ctx.env.FTH_CYCLE_ENTRY, undefined);
  assert.ok(!r.ran[0].prompt.includes(ENTRY_TEXT));
});

// ---- Live: the mock exchange as a live broker, on the wall clock ----
// An autonomous run never takes the harness's test clock (trading/harness-now.js wallNow: FTH_AUTONOMOUS=1 reads the
// wall clock), so the roles the runner runs judge a live entry at the real time: a decision on a bar that closed long
// ago is never entered. The fired bar's round on a live broker: the desk and phase 2 run, and the order built in code
// is refused at the wall clock before any trade-executor runs (the record expired); nothing reaches the broker.

test('entry workflow, live: on a live broker the runner\'s entry judges at the wall clock: a decision on an old bar (the record expired) is refused in code before the trade-executor; nothing reaches the broker, the cycle a no-trade naming it', async () => {
  const w = D.world({ live: true });
  const at = decisionAt(FIRED_BAR);
  const R = roles(w, at);
  const r = await D.pass(w, at, headPlanned(w), { runRole: R.runRole });
  // The live round: no replay clock anywhere; phase 2 ran (its own run at the wall clock).
  const p2 = R.runs.find(x => x.role === 'risk-manager phase 2');
  assert.ok(p2 && p2.env && p2.env.FTH_REPLAY_NOW === undefined && p2.env.FTH_AUTONOMOUS === '1', 'phase 2 ran, live and autonomous');
  assert.ok(!R.runs.some(x => x.role === 'trade-executor'), 'no trade-executor: nothing to send');
  assert.deepStrictEqual(D.placedAtBroker(w), []);
  assert.deepStrictEqual(journal(w).filter(e => e.kind === 'plan'), [], 'no plan journaled for an order that was never built');
  assert.match(r.ran[0].result, /^CYCLE RESULT: no-trade - the runner's entry: order_plan refused the composed plan: the order gate would refuse it: \[composed-reads\] .*expired/);
  assert.strictEqual(D.cycleLines(w).at(-1).entry.outcome, 'no-trade');
});

test('entry workflow: a desk the runner couldn\'t complete (an analyst missing) is no entry cycle: the head trader launches the missing role and runs its entry, as before (the executor\'s own run couldn\'t see the head trader\'s launch)', async () => {
  const w = D.world();
  const at = decisionAt(FIRED_BAR);
  const R = roles(w, at, { fail: { 'volume-liquidity-analyst': { ok: false, timedOut: true, text: '', tools: [], output: '' } } });
  const r = await D.pass(w, at, [{ result: 'CYCLE RESULT: no-trade - waiting on the desk' }], { runRole: R.runRole });
  assert.strictEqual(r.ran[0].context.entry, undefined);
  assert.strictEqual(r.ctx.env.FTH_CYCLE_ENTRY, undefined);
  assert.match(r.ctx.env.FTH_CYCLE_DESK, /volume-liquidity-analyst/);
  assert.ok(!r.ran[0].prompt.includes(ENTRY_TEXT));
  assert.match(r.ran[0].prompt, /then risk-manager phase 2 on your plan, if any/);
});

test('entry workflow: the broker refuses the entry (success: false): nothing opened, sent once, never again; the cycle blocked naming the broker\'s refusal', async () => {
  const w = D.world();
  const at = decisionAt(FIRED_BAR);
  exchange.update(w.state, s => { s.refuseEntries = true; });
  const R = roles(w, at);
  const r = await D.pass(w, at, headPlanned(w), { runRole: R.runRole });
  assert.deepStrictEqual(entries(w).map(e => e.decision), ['allowed'], 'the gate let it through; the broker refused it');
  assert.strictEqual(D.position(w), null);
  assert.deepStrictEqual(D.working(w), []);
  assert.strictEqual(R.runs.filter(x => x.role === 'trade-executor').length, 1, 'the executor runs once');
  assert.strictEqual(D.placedAtBroker(w).length, 1, 'sent once, never again');
  assert.match(r.ran[0].result, /^CYCLE RESULT: blocked - the trade_lifecycle long 1 MNQ was refused by the broker: ABORTED/, JSON.stringify(R.runs.at(-1).calls));
  assert.strictEqual(D.cycleLines(w).at(-1).entry.outcome, 'blocked');
});
