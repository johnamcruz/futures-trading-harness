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

const { FIRED_BAR, NEXT_BAR, QUIET_BAR, decisionAt, MNQ_ID } = D;

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
    // The live path of the reaction read: compose, and on compose_check's READ FIRST line (a rejection read, candle-reading
    // neither looked up nor embedded this cycle) look it up and compose again (reaction-lookup.js).
    { harness: 'compose_check', args: { symbol: 'MNQ', side: 'long', reads: LC_READS, size: o.size || 1 } },
    { then: ctx => (/READ FIRST: [^\n]*candle-reading/.test(String(ctx.results.compose_check || '')) ? [{ harness: 'skill_lookup', args: { skill: 'candle-reading' } }, { harness: 'compose_check', args: { symbol: 'MNQ', side: 'long', reads: LC_READS, size: o.size || 1 } }] : []) },
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
const phase2 = (w, { verdict = 'APPROVE - size 1, risk $46.00, trade_lifecycle long with the trend', facts = null, before = '' } = {}) => prompt => {
  const bars = /are in (\S+) \(get_bars format\)/.exec(prompt)[1];
  return [
    { harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } },
    { harness: 'order_plan', args: { bars, symbol: 'MNQ', strategy: 'trade_lifecycle', side: 'long', accountId: 7 } },
    { result: () => `Phase 2 on the trade_lifecycle long plan for MNQ.\n${before}VERDICT: ${verdict}\nFACTS: ${facts || D.trueFacts(w).join('; ')}` },
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
  // Each run's transcript in the harness's own format (Claude Code's stream-json, else opencode's JSON events).
  const format = w.harness === 'claude' ? 'claude' : 'opencode';
  const runRole = async (role, request, limits) => {
    const isPhase2 = role === 'risk-manager' && /^Phase 2, plan verdict/.test(request);
    // Phase 2's restatement (runner-entry.js: its approval unreadable), played by `o.restate` through the same glue.
    if (role === 'risk-manager' && o.restate && /^Phase 2, restate/.test(request)) {
      runs.push({ role: 'risk-manager restate', request, context: limits.context, timeoutMs: limits.timeoutMs });
      const model = scriptedModel(o.restate, { format });
      return realRunRole(w.cfg, role, request, limits, { root: D.ROOT, home: w.home, env: D.passEnv(w, at), run: (argv, opts) => model(argv, opts) });
    }
    runs.push({ role: isPhase2 ? 'risk-manager phase 2' : role, request, context: limits.context, timeoutMs: limits.timeoutMs });
    const failed = o.fail && o.fail[isPhase2 ? 'phase2' : role];
    if (failed) return failed;
    // `o.deskRuns`: the desk's roles through the production glue too (their own runs, deskScript), not scripted results.
    if (!isPhase2 && role !== 'trade-executor' && !o.deskRuns) return o.cacheable ? cacheableReport(w, role) : deskReport(role);
    const model = scriptedModel(isPhase2 ? (o.phase2 || phase2(w)) : role === 'trade-executor' ? (o.executor || executor()) : deskScript(role), { format });
    const run = (argv, opts) => { runs.find(x => x.request === request && !x.argv).argv = argv; return model(argv, opts); };
    const r = await realRunRole(w.cfg, role, request, limits, { root: D.ROOT, home: w.home, env: D.passEnv(w, at), run });
    const mine = runs.find(x => x.request === request && x.argv && !x.done);
    Object.assign(mine, { done: true, env: model.last && model.last.env, calls: model.last ? model.last.calls : [], result: r });
    return r;
  };
  return { runRole, runs };
}

/** `o.cacheable`: an analyst's report naming the bar briefing's current versions, which the report cache keeps. */
function cacheableReport(w, role) {
  if (role === 'risk-manager') return deskReport(role);
  const b = require('../../scripts/lib/trading/briefing').readBriefing(w.home, 'MNQ');
  return { ...deskReport(role), text: `## ${role}\nData: bar_briefing ${['m3', 'm15', 'h1', 'day'].map(p => b.sections[p].version).join(', ')}\nBias: long` };
}

/** A desk role as it plays its own run: the bar briefing (an analyst) or the account (phase 1), then its report. */
const deskScript = role => () => [
  role === 'risk-manager' ? { broker: 'get_account_snapshot', args: { accountId: 7 } } : { harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } },
  { result: deskReport(role).text },
];

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
    // candle-reading embedded in the cycle's situational section, attested: no READ FIRST, no lookup, the entry goes.
    assert.deepStrictEqual(r.ctx.calls.filter(x => ['compose_check', 'skill_lookup'].includes(x.tool)).map(x => x.tool), ['compose_check'], mode);
    assert.doesNotMatch(r.ctx.calls.find(x => x.tool === 'compose_check').text, /READ FIRST/, mode);
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

test('entry workflow, index mode, no room for the situational section: compose_check says READ FIRST (candle-reading), the head looks it up and composes again, and the gate allows the entry', async () => {
  const w = D.world({ mode: 'index' });
  const at = decisionAt(FIRED_BAR);
  const R = roles(w, at);
  const r = await D.pass(w, at, headPlanned(w), { runRole: R.runRole, maxPromptBytes: 1 });
  assert.doesNotMatch(r.ran[0].prompt, /<skill name="candle-reading">/, 'not embedded');
  assert.deepStrictEqual(r.ctx.calls.filter(x => ['compose_check', 'skill_lookup'].includes(x.tool)).map(x => x.tool), ['compose_check', 'skill_lookup', 'compose_check']);
  assert.deepStrictEqual(r.ctx.calls.filter(x => x.tool === 'compose_check').map(x => /READ FIRST: [^\n]*candle-reading/.test(x.text)), [true, false]);
  assert.deepStrictEqual(entries(w).map(e => [e.decision, (e.violations || []).map(v => v.check)]), [['allowed', []]]);
  assert.strictEqual(R.runs.slice(-1)[0].role, 'trade-executor');
});

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
  // The cycle's record keeps phase 2's report, for the next diagnosis.
  const rec = JSON.parse(fs.readFileSync(line.file, 'utf8')).entry;
  assert.match(rec.phase2.text, /VERDICT: VETO - room: the 1h swing is too close, stand aside/);
  assert.strictEqual(rec.phase2.chars, rec.phase2.text.length);
});

test('entry workflow: an APPROVE line the gate\'s reading takes as a veto ("Decision: cut to size 1"): no executor, nothing at the broker; recorded as vetoed, the result naming the reading\'s reason', async () => {
  const w = D.world();
  const at = decisionAt(FIRED_BAR);
  const R = roles(w, at, { phase2: phase2(w, { before: 'Decision: cut to size 1\n' }) });
  const r = await D.pass(w, at, headPlanned(w), { runRole: R.runRole });
  assert.ok(!R.runs.some(x => x.role === 'trade-executor'));
  assert.deepStrictEqual(D.placedAtBroker(w), []);
  assert.deepStrictEqual(journal(w).filter(e => e.kind === 'plan'), []);
  assert.strictEqual(r.ran[0].result, 'CYCLE RESULT: no-trade - risk-manager phase 2\'s report reads as a veto (a decision line decides cut, not APPROVE): VERDICT: APPROVE - size 1, risk $46.00, trade_lifecycle long with the trend');
  assert.strictEqual(r.state.history.at(-1).action, 'vetoed', 'the history reads it as the gate does');
  const line = D.cycleLines(w).at(-1);
  assert.strictEqual(line.entry.outcome, 'vetoed');
  const rec = JSON.parse(fs.readFileSync(line.file, 'utf8')).entry;
  assert.strictEqual(rec.why, 'phase 2\'s report reads as a veto: a decision line decides cut, not APPROVE ("Decision: cut to size 1")');
  assert.match(rec.phase2.text, /^Phase 2 on the trade_lifecycle long plan for MNQ\.\nDecision: cut to size 1\nVERDICT: APPROVE/);
});

test('entry workflow: phase 2 restated (its Size line in prose): one restatement through the same glue, the order at the restated size through the real gateway and gate; a restated size over the VERDICT line\'s is bound to it', async () => {
  for (const [restated, sent] of [[2, 2], [5, 2]]) {
    const w = D.world();
    const at = decisionAt(FIRED_BAR);
    // Its VERDICT line approves 2; its Size line is a sentence holding a count under it: no size the reading takes.
    const R = roles(w, at, {
      phase2: phase2(w, { before: 'Size: the record\'s 2, since 1 category against is minor\n', verdict: 'APPROVE - size 2, risk $92.00, trade_lifecycle long with the trend' }),
      restate: () => [{ result: `Size: ${restated}\nVERDICT: APPROVE - size ${restated}, risk $${46 * restated}.00` }],
    });
    const r = await D.pass(w, at, headPlanned(w, { size: 2 }), { runRole: R.runRole });
    assert.deepStrictEqual(R.runs.map(x => x.role).filter(x => !/analyst|^risk-manager$/.test(x)), ['risk-manager phase 2', 'risk-manager restate', 'trade-executor'], String(restated));
    assert.match(R.runs.find(x => x.role === 'risk-manager restate').request, /^Phase 2, restate, for MNQ .*your size can't be read as one whole number \(the line "Size: the record's 2, since 1 category against is minor"\)/);
    assert.match(r.ran[0].result, /^CYCLE RESULT: executed - trade_lifecycle long 2 MNQ/, String(restated));
    assert.deepStrictEqual(D.placedAtBroker(w).map(c => c.args.size), [sent], String(restated));
    assert.deepStrictEqual(entries(w).map(e => [e.decision, e.size]), [['allowed', sent]], String(restated));
    const line = D.cycleLines(w).at(-1);
    assert.deepStrictEqual(line.entry.restated, { kind: 'size-unreadable', outcome: 'approved', size: sent }, String(restated));
    const rec = JSON.parse(fs.readFileSync(line.file, 'utf8')).entry;
    assert.deepStrictEqual([rec.restated.ceiling, rec.restated.outcome], [2, 'approved']);
  }
});

test('entry workflow: phase 2\'s approved size sets the order: over the record\'s 2 the broker gets 2; at 1 (its cut) exactly 1, the gate allowing it', async () => {
  // Phase 2 approves 5 on a record of 2: the order is the record's 2, at the broker.
  let w = D.world();
  let at = decisionAt(FIRED_BAR);
  let R = roles(w, at, { phase2: phase2(w, { verdict: 'APPROVE - size 5, risk $230.00, trade_lifecycle long with the trend' }) });
  const first = await D.pass(w, at, headPlanned(w, { size: 2 }), { runRole: R.runRole });
  assert.match(first.ran[0].result, /^CYCLE RESULT: executed - trade_lifecycle long 2 MNQ/);
  const sent = D.placedAtBroker(w);
  assert.deepStrictEqual(sent.map(c => c.args.size), [2]);
  assert.strictEqual(requestedArgs(R.runs.at(-1).request).size, 2);
  assert.deepStrictEqual(entries(w).map(e => [e.decision, e.size]), [['allowed', 2]]);
  assert.match(journal(w).filter(e => e.kind === 'plan')[0].text, /risk \$92; size 2: phase 2 approved 5, capped at the record's 2;/);
  assert.strictEqual(D.position(w).size, 2);
  // Phase 2 approves 1 on a record of 2 (its cut, owner-approved 2026-10-22): the broker gets exactly 1, the record's
  // brackets, the gate's composed-reads allowing it; the journal plan and the trade's records say the cut.
  w = D.world();
  at = decisionAt(FIRED_BAR);
  R = roles(w, at, { phase2: phase2(w, { before: 'Size: 1 (record 2 cut to 1: no reviewed trades yet)\n', verdict: 'APPROVE - size 1, risk $46.00, trade_lifecycle long with the trend' }) });
  const r = await D.pass(w, at, headPlanned(w, { size: 2 }), { runRole: R.runRole });
  const cut = D.placedAtBroker(w);
  assert.deepStrictEqual(cut.map(c => [c.args.size, c.args.stopLossBracket.ticks, c.args.takeProfitBracket.ticks]), [[1, 92, 338]]);
  const args = requestedArgs(R.runs.at(-1).request);
  assert.strictEqual(args.size, 1);
  assert.match(args.rationale, /, 1 MNQ risks \$46\.00, record /);
  const rec = TL.readRecords(w.home, 'MNQ').at(-1);
  assert.strictEqual(rec.plan.size, 2, 'the record keeps its own size');
  assert.deepStrictEqual(entries(w).map(e => [e.decision, e.size, (e.violations || []).map(v => v.check)]), [['allowed', 1, []]]);
  assert.match(journal(w).filter(e => e.kind === 'plan')[0].text, /long 1 MNQ: .*risk \$46; size 1: phase 2 cut the record's 2; compose record /);
  assert.strictEqual(D.position(w).size, 1);
  assert.match(r.ran[0].result, /^CYCLE RESULT: executed - trade_lifecycle long 1 MNQ \(phase 2 cut the record's 2\) \(the runner's entry: phase 2 approved, the order filled\)$/);
  const line = D.cycleLines(w).at(-1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(line.file, 'utf8')).entry.size, { approved: 1, record: 2, ordered: 1 });
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
  assert.strictEqual(r.ran[0].result, 'CYCLE RESULT: no-trade - the composed record expired before the order');
  const line = D.cycleLines(w).at(-1);
  assert.strictEqual(line.entry.outcome, 'expired', 'counted as its own outcome');
  assert.ok(Number.isFinite(line.entry.timing.orderMs) && line.entry.timing.executorMs === null, JSON.stringify(line.entry.timing));
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

// ---- The owner's runner config: one symbol, the 3m lane and a 1m data lane, a 20-minute cycle ----

/** The world with the owner's lanes: timeframe 3, lanes [{3, bar}, {1, data}], cycleTimeoutMinutes 20. */
function ownerWorld(o = {}) {
  const w = D.world({ dataLane: true, ...o });
  w.cfg = require('../../scripts/lib/autotrader').validateConfig({ harness: 'opencode', cycle: 'full', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], dataDir: w.cfg.dataDir, bars: 1400, cycleTimeoutMinutes: 20, lanes: [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'data' }] });
  return w;
}

test('entry workflow, the owner\'s lanes (3m bar lane + 1m data lane, 20 min): the 3m close is one cycle with one item; the runner runs the desk and the entry on the 3m record\'s bar; the gate allows the code-built order; it fills', async () => {
  const w = ownerWorld();
  const at = decisionAt(FIRED_BAR);
  const R = roles(w, at);
  const r = await D.pass(w, at, headPlanned(w), { runRole: R.runRole });
  assert.strictEqual(r.ran.length, 1, 'one cycle at the 3m close (the data lane never cycles)');
  assert.deepStrictEqual(r.ran[0].context.symbols.map(x => [x.symbol, x.bar.t]), [['MNQ', FIRED_BAR]], 'one item: the 3m bar');
  assert.deepStrictEqual(R.runs.map(x => x.role).slice(0, 4).sort(), ['market-structure-analyst', 'risk-manager', 'trend-momentum-analyst', 'volume-liquidity-analyst'], 'the runner ran the desk');
  assert.deepStrictEqual(R.runs.map(x => x.role).slice(-2), ['risk-manager phase 2', 'trade-executor'], 'and the entry');
  assert.strictEqual(r.ctx.env.FTH_CYCLE_ENTRY, '1');
  const rec = TL.readRecords(w.home, 'MNQ').at(-1);
  assert.deepStrictEqual([rec.ok, rec.bar, rec.lane], [true, FIRED_BAR, '3m'], 'the record is on the 3m setup bar');
  assert.ok(R.runs.at(-2).request.includes(rec.id));
  assert.deepStrictEqual(entries(w).map(e => [e.decision, (e.violations || []).map(v => v.check)]), [['allowed', []]]);
  assert.strictEqual(D.position(w).size, 1);
  assert.match(r.ran[0].result, /^CYCLE RESULT: executed - trade_lifecycle long 1 MNQ/);
  const line = D.cycleLines(w).at(-1);
  assert.strictEqual(line.entry.outcome, 'executed');
  // The budget's timings, from the 3m bar's close.
  const t = line.entry.timing;
  for (const k of ['headMs', 'phase2Ms', 'executorMs', 'orderMs']) assert.ok(Number.isFinite(t[k]) && t[k] >= 0, `${k}: ${JSON.stringify(t)}`);
  assert.ok(t.orderMs >= t.headMs, JSON.stringify(t));
});

test('entry workflow: the head trader composes a long and writes planned short (the side drifted): a process failure, logged; no phase 2, nothing reaches the broker', async () => {
  const w = D.world();
  const at = decisionAt(FIRED_BAR);
  const R = roles(w, at);
  const r = await D.pass(w, at, headPlanned(w, { result: 'CYCLE RESULT: planned - trade_lifecycle short 1' }), { runRole: R.runRole });
  assert.ok(!R.runs.some(x => x.role === 'trade-executor' || x.role === 'risk-manager phase 2'));
  assert.deepStrictEqual(D.placedAtBroker(w), []);
  assert.ok(r.logs.some(l => /the planned line says short, the latest OK compose record \S+ is a long: a process failure/.test(l)), r.logs.join('\n'));
  assert.strictEqual(r.ran[0].result, 'CYCLE RESULT: planned - trade_lifecycle short 1');
  assert.strictEqual(D.cycleLines(w).at(-1).entry.outcome, 'process-failure');
});

// ---- Claude Code: the same workflows, every role its own `claude -p --agent <plugin>:<role>` run ----
// The runner runs the desk and the entry on Claude Code as on opencode (autotrader.js ROLE_RUNS): each role's run goes
// through the production glue (cycle-run.js runRole: buildCommand's Claude argv, childEnv), played by the scripted model
// in Claude Code's stream-json; the head trader's run too. Claude Code's roles load every skill (FTH_ROLE_SKILLS full,
// whatever the runner's own mode), so the head trader loads its skills with the Skill tool and no lookup is required.

/** Claude Code's head trader when the runner runs the entry: its loads with the Skill tool, the briefing, compose_check, planned. */
function claudeHeadPlanned(w, o = {}) {
  const full = { ...w, mode: 'full' };
  return [
    ...[...new Set([...D.headLoads(full), ...REQUIRED_FOR_COMPOSED, ...D.entryLoads(full)])].map(s => ({ load: s })),
    { harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } },
    { harness: 'skill_lookup', args: { skill: 'candle-reading' } }, { harness: 'compose_check', args: { symbol: 'MNQ', side: 'long', reads: LC_READS, size: o.size || 1 } },
    { result: o.result || `CYCLE RESULT: planned - trade_lifecycle long ${o.size || 1}` },
  ];
}

const flagOf = (argv, f) => argv[argv.indexOf(f) + 1];

test('entry workflow, Claude Code: the runner runs the desk (each role its own claude -p --agent run), the head trader composes and says planned, the runner runs phase 2 and the trade-executor with the code-built order; the gate allows it, it fills; the cycle log shows the desk and the entry complete', async () => {
  const w = D.world({ harness: 'claude' });
  const at = decisionAt(FIRED_BAR);
  const R = roles(w, at, { deskRuns: true });
  const r = await D.pass(w, at, claudeHeadPlanned(w), { runRole: R.runRole });
  // The round: the desk's four roles, then phase 2, then the trade-executor, each its own Claude Code run as that role.
  assert.deepStrictEqual(R.runs.slice(0, 4).map(x => x.role).sort(), ['market-structure-analyst', 'risk-manager', 'trend-momentum-analyst', 'volume-liquidity-analyst']);
  assert.deepStrictEqual(R.runs.map(x => x.role).slice(4), ['risk-manager phase 2', 'trade-executor']);
  for (const x of R.runs) {
    const role = x.role.replace(' phase 2', '');
    assert.deepStrictEqual([x.argv[0], x.argv[1], x.argv[2], flagOf(x.argv, '--agent'), flagOf(x.argv, '--output-format')], ['claude', '-p', x.request, `futures-trading-harness:${role}`, 'stream-json'], x.role);
    const allowed = flagOf(x.argv, '--allowedTools').split(',');
    assert.strictEqual(allowed.includes('mcp__broker__place_order'), role === 'trade-executor', `${x.role}: only the trade-executor holds the order tool`);
    assert.ok(flagOf(x.argv, '--disallowedTools').split(',').includes('Agent'), `${x.role} launches no role`);
    assert.ok(x.argv.includes('--strict-mcp-config'), `${x.role}: a replay's own MCP servers only`);
    assert.strictEqual(x.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
    assert.strictEqual(x.env.FTH_ROLE_SKILLS, 'full');
    assert.ok(x.result.ok, `${x.role}: ${JSON.stringify(x.result)}`);
  }
  // The desk's reports were read from each role's stream-json (read-data: its own call; report-shape: its text).
  assert.deepStrictEqual(R.runs.find(x => x.role === 'market-structure-analyst').result.tools, ['harness_bar_briefing']);
  // The head trader: Claude Code's run, told the route, its run carrying the entry's rule switch; the roles' never do.
  const { prompt, context } = r.ran[0];
  assert.ok(prompt.includes(ENTRY_TEXT), 'the head prompt says the route');
  assert.match(prompt, /The desk ran for this bar: the runner ran /);
  assert.strictEqual(r.ctx.env.FTH_CYCLE_ENTRY, '1');
  const exec = R.runs.at(-1);
  assert.strictEqual(exec.env.FTH_CYCLE_ENTRY, undefined);
  // The gate's evidence in the executor's own run: the cycle's role record, the cycle's id, its own transcript, the bar.
  assert.strictEqual(exec.env.FTH_CYCLE_ROLES, context.rolesFile);
  assert.strictEqual(exec.env.FTH_CYCLE_ID, require('../../scripts/lib/trading/check-order').cycleId(r.ctx.env));
  assert.notStrictEqual(exec.env.FTH_CYCLE_TRANSCRIPT, r.ctx.env.FTH_CYCLE_TRANSCRIPT, 'its own transcript');
  assert.strictEqual(exec.env.FTH_CYCLE_BARS, r.ctx.env.FTH_CYCLE_BARS);
  // The order: order_plan's arguments, built in code, sent as they are; the gate allowed it; filled with its stop.
  const sent = D.placedAtBroker(w);
  assert.strictEqual(sent.length, 1);
  const args = requestedArgs(exec.request);
  assert.deepStrictEqual([args.type, args.limitPrice, args.size, args.stopLossBracket.ticks, args.takeProfitBracket.ticks], ['limit', 27427.5, 1, 92, 338]);
  assert.deepStrictEqual(entries(w).map(e => [e.decision, (e.violations || []).map(v => v.check)]), [['allowed', []]]);
  assert.strictEqual(D.position(w).size, 1);
  assert.ok(D.working(w).some(o2 => o2.type === 4), 'the stop bracket works');
  assert.deepStrictEqual(exec.result.tools, ['broker_get_account_snapshot', 'broker_place_order'], 'read from its stream-json');
  // The cycle's outcome and log: the desk complete, the entry executed, the order the cycle's.
  assert.match(r.ran[0].result, /^CYCLE RESULT: executed - trade_lifecycle long 1 MNQ \(the runner's entry: phase 2 approved, the order filled\)$/);
  assert.strictEqual(r.state.history.at(-1).action, D.RESULT_ACTION.executed);
  const line = D.cycleLines(w).at(-1);
  assert.strictEqual(line.harness, 'claude');
  assert.deepStrictEqual([line.desk.complete, line.desk.missing], [true, []]);
  assert.deepStrictEqual([line.entry.outcome, line.entry.ran], ['executed', ['risk-manager', 'trade-executor']]);
  assert.strictEqual(line.orders.length, 1);
  assert.deepStrictEqual(line.missingSkills, []);
  assert.deepStrictEqual([line.factCheck.reports, line.factCheck.false], [1, 0], JSON.stringify(line.factCheck));
});

test('entry workflow, Claude Code: the gate still holds on the runner\'s path: the head trader\'s loads count only from the runner\'s record of them [skills-loaded]; a phase-2 VETO runs no trade-executor and sends nothing', async () => {
  const RR = require('../../scripts/lib/trading/runner-roles');
  const orig = RR.appendHeadSkills;
  RR.appendHeadSkills = () => { throw new Error('disk full'); };
  try {
    const w = D.world({ harness: 'claude' });
    const at = decisionAt(FIRED_BAR);
    const r = await D.pass(w, at, claudeHeadPlanned(w), { runRole: roles(w, at, { deskRuns: true }).runRole });
    const e = entries(w).at(-1);
    assert.strictEqual(e.decision, 'blocked');
    assert.deepStrictEqual(e.violations.map(v => v.check), ['skills-loaded', 'skills-at-entry'], JSON.stringify(e.violations));
    assert.deepStrictEqual(D.placedAtBroker(w), []);
    assert.match(r.ran[0].result, /^CYCLE RESULT: blocked - the order gate refused the trade_lifecycle long 1 MNQ: \[skills-loaded\]/);
  } finally {
    RR.appendHeadSkills = orig;
  }
  const v = D.world({ harness: 'claude' });
  const at = decisionAt(FIRED_BAR);
  const R = roles(v, at, { deskRuns: true, phase2: phase2(v, { verdict: 'VETO - room: the 1h swing is too close' }) });
  const r = await D.pass(v, at, claudeHeadPlanned(v), { runRole: R.runRole });
  assert.ok(!R.runs.some(x => x.role === 'trade-executor'));
  assert.deepStrictEqual(D.placedAtBroker(v), []);
  assert.match(r.ran[0].result, /^CYCLE RESULT: no-trade - risk-manager vetoed the trade_lifecycle long 1 MNQ: VERDICT: VETO - room/);
});

// Claude Code's stream-json doesn't time the head trader's own launches (autotrader.js TIMED_LAUNCHES), so the gate
// can't order a phase 2 it launched itself against the runner's record: there the runner runs the desk only in a cycle
// whose entry it runs, and drops a desk it couldn't complete.

test('entry workflow, Claude Code: a cycle that started with a position runs no desk of the runner\'s (no entry cycle): the head trader launches its roles in its session, as before', async () => {
  const w = D.world({ harness: 'claude' });
  const at = decisionAt(FIRED_BAR);
  exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40 } }, {});
  const R = roles(w, at, { deskRuns: true });
  const r = await D.pass(w, at, [{ result: 'CYCLE RESULT: managed - the open long' }], { runRole: R.runRole });
  assert.deepStrictEqual(R.runs, [], 'no role run by the runner');
  assert.strictEqual(r.ran[0].context.desk, undefined);
  assert.strictEqual(r.ctx.env.FTH_CYCLE_ROLES, undefined);
  assert.strictEqual(r.ctx.env.FTH_CYCLE_ENTRY, undefined);
  assert.doesNotMatch(r.ran[0].prompt, /The desk ran for this bar/);
});

// This machine's opt-in (the runner config's deskOnManagedCycles, absent by default): the runner runs the desk in a
// managed cycle too (it started with a position or working order open: no entry that cycle).
const managedOptIn = w => Object.assign(w, { cfg: { ...w.cfg, deskOnManagedCycles: true } });

test('entry workflow, Claude Code, deskOnManagedCycles absent: a managed cycle gives the head trader the roster to launch its desk, as before', async () => {
  const { MANAGED_DESK_TEXT } = require('../../scripts/lib/autotrader');
  const w = D.world({ harness: 'claude' });
  assert.strictEqual(w.cfg.deskOnManagedCycles, undefined, 'absent by default');
  const at = decisionAt(FIRED_BAR);
  exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40 } }, {});
  const R = roles(w, at, { deskRuns: true });
  const r = await D.pass(w, at, [{ result: 'CYCLE RESULT: managed - the open long' }], { runRole: R.runRole });
  assert.deepStrictEqual(R.runs, [], 'no role run by the runner');
  assert.match(r.ran[0].prompt, /as parallel subagents, plan from their reports, then risk-manager phase 2 on your plan, if any/);
  assert.ok(!r.ran[0].prompt.includes(MANAGED_DESK_TEXT));
  assert.deepStrictEqual(r.ctx.env.FTH_CYCLE_DESK.split(',').sort(), ['market-structure-analyst', 'risk-manager', 'trend-momentum-analyst', 'volume-liquidity-analyst']);
  assert.strictEqual(r.ctx.env.FTH_CYCLE_MANAGE, undefined, 'never the managed-cycle flag with the key absent');
  assert.strictEqual(r.ran[0].context.manage, undefined);
});

test('entry workflow, Claude Code, deskOnManagedCycles on: a cycle that started with a position runs the runner\'s desk and keeps its record: the prompt carries the reports and no roster, the desk check is complete, the exit goes; an entry is refused [managed-cycle]', async () => {
  const { MANAGED_DESK_TEXT } = require('../../scripts/lib/autotrader');
  const w = managedOptIn(D.world({ harness: 'claude' }));
  const at = decisionAt(FIRED_BAR);
  exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40 } }, {});
  const R = roles(w, at, { deskRuns: true });
  const r = await D.pass(w, at, [
    { executor: [{ broker: 'close_position', args: { accountId: 7, contractId: MNQ_ID } }] },
    { result: 'CYCLE RESULT: managed - closed the open long' },
  ], { runRole: R.runRole });
  assert.deepStrictEqual(R.runs.map(x => x.role).sort(), ['market-structure-analyst', 'risk-manager', 'trend-momentum-analyst', 'volume-liquidity-analyst'], 'the runner ran the desk');
  const { prompt, context } = r.ran[0];
  assert.strictEqual(r.ctx.env.FTH_CYCLE_ROLES, context.rolesFile, 'the record is kept for the head trader\'s gate');
  assert.strictEqual(r.ctx.env.FTH_CYCLE_ENTRY, undefined, 'no entry route');
  assert.strictEqual(r.ctx.env.FTH_CYCLE_DESK, undefined, 'no role to launch');
  assert.strictEqual(r.ctx.env.FTH_CYCLE_MANAGE, '1', 'the gate refuses any entry this cycle');
  assert.ok(prompt.includes(MANAGED_DESK_TEXT), 'the prompt says the cycle manages, no entry');
  assert.match(prompt, /The desk ran for this bar: the runner ran /);
  assert.doesNotMatch(prompt, /as parallel subagents|then risk-manager phase 2 on your plan/, 'no roster');
  assert.ok(!prompt.includes(ENTRY_TEXT));
  const line = D.cycleLines(w).at(-1);
  assert.deepStrictEqual([line.desk.complete, line.desk.missing], [true, []]);
  assert.strictEqual(D.position(w), null, 'the exit went');
  assert.ok(!r.logs.some(l => /the head trader runs its desk this cycle/.test(l)), r.logs.join('\n'));

  // An entry in such a cycle (the head trader's own phase 2 and trade-executor) is refused: a managed cycle enters
  // nothing (and its own launches can't be ordered against the runner's record either).
  const v = managedOptIn(D.world({ harness: 'claude' }));
  exchange.handle(v.state, 'place_order', { accountId: 7, contractId: 'fake:MES:Z26', side: 'buy', type: 'limit', limitPrice: 1, size: 1, stopLossBracket: { ticks: 40 } }, {});
  const R2 = roles(v, at, { deskRuns: true });
  const r2 = await D.pass(v, at, [
    { role: 'risk-manager', lookups: [], report: 'Phase 2.\nVERDICT: APPROVE - size 1' },
    { executor: [{ broker: 'place_order', args: D.manualArgs('setup:fx_break long') }] },
    { result: 'CYCLE RESULT: blocked - refused' },
  ], { runRole: R2.runRole });
  assert.strictEqual(R2.runs.length, 4, 'the runner ran the desk (a working order open: a managed cycle)');
  assert.ok(r2.ran[0].prompt.includes(MANAGED_DESK_TEXT) && r2.ctx.env.FTH_CYCLE_ROLES);
  const e = entries(v).at(-1);
  assert.strictEqual(e.decision, 'blocked');
  assert.ok(e.violations.some(x => x.check === 'managed-cycle'), JSON.stringify(e.violations));
  const rr = e.violations.find(x => x.check === 'roles-ran');
  assert.ok(rr && /without wall-clock times/.test(rr.message), JSON.stringify(e.violations));
  assert.deepStrictEqual(D.placedAtBroker(v).filter(c => c.args.contractId !== 'fake:MES:Z26'), [], 'nothing reached the broker');
});

test('entry workflow, Claude Code, deskOnManagedCycles on: the next managed cycle with the desk all served from the report cache: the managed text, no roster, an entry refused [managed-cycle], an exit still goes', async () => {
  const { MANAGED_DESK_TEXT } = require('../../scripts/lib/autotrader');
  const w = managedOptIn(D.world({ harness: 'claude' }));
  exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40 } }, {});
  const first = roles(w, decisionAt(QUIET_BAR), { cacheable: true });
  await D.pass(w, decisionAt(QUIET_BAR), [{ result: 'CYCLE RESULT: managed - holding the long' }], { runRole: first.runRole });
  assert.strictEqual(first.runs.length, 4, 'the first managed cycle ran the desk');
  const at = decisionAt(FIRED_BAR);
  const R = roles(w, at, { cacheable: true });
  const r = await D.pass(w, at, [
    { executor: [{ broker: 'place_order', args: D.manualArgs('setup:fx_break long') }] },
    { executor: [{ broker: 'close_position', args: { accountId: 7, contractId: MNQ_ID } }] },
    { result: 'CYCLE RESULT: managed - closed the long' },
  ], { runRole: R.runRole });
  assert.deepStrictEqual(R.runs, [], 'the report cache served the whole desk');
  const { prompt } = r.ran[0];
  assert.ok(prompt.includes(MANAGED_DESK_TEXT), prompt);
  assert.doesNotMatch(prompt, /as parallel subagents|then risk-manager phase 2 on your plan/, 'no roster');
  assert.strictEqual(r.ctx.env.FTH_CYCLE_MANAGE, '1');
  const e = entries(w).filter(x => !/^\s*\[(exit|protect)\]/.test(String((x.input || x.args || {}).rationale || ''))).at(-1);
  assert.strictEqual(e.decision, 'blocked');
  assert.ok(e.violations.some(x => x.check === 'managed-cycle'), JSON.stringify(e.violations));
  assert.strictEqual(D.position(w), null, 'the exit went');
});

test('entry workflow, Claude Code, deskOnManagedCycles on: a managed cycle\'s desk that didn\'t complete is dropped (the head trader runs its desk, as before), and an entry is still refused [managed-cycle]', async () => {
  const { MANAGED_DESK_TEXT, MANAGED_NO_ENTRY_TEXT } = require('../../scripts/lib/autotrader');
  const w = managedOptIn(D.world({ harness: 'claude' }));
  const at = decisionAt(FIRED_BAR);
  exchange.handle(w.state, 'place_order', { accountId: 7, contractId: 'fake:MES:Z26', side: 'buy', type: 'limit', limitPrice: 1, size: 1, stopLossBracket: { ticks: 40 } }, {});
  const R = roles(w, at, { deskRuns: true, fail: { 'volume-liquidity-analyst': { ok: false, timedOut: true, text: '', tools: [], output: '' } } });
  const r = await D.pass(w, at, [
    { executor: [{ broker: 'place_order', args: D.manualArgs('setup:fx_break long') }] },
    { result: 'CYCLE RESULT: blocked - refused' },
  ], { runRole: R.runRole });
  assert.strictEqual(r.ctx.env.FTH_CYCLE_ROLES, undefined, 'dropped');
  assert.match(r.ran[0].prompt, /then risk-manager phase 2 on your plan, if any/, 'the roster, as before');
  assert.ok(r.ran[0].prompt.includes(MANAGED_NO_ENTRY_TEXT) && !r.ran[0].prompt.includes(MANAGED_DESK_TEXT));
  assert.strictEqual(r.ctx.env.FTH_CYCLE_MANAGE, '1');
  const e = entries(w).at(-1);
  assert.ok(e.violations.some(x => x.check === 'managed-cycle'), JSON.stringify(e.violations));
});

test('entry workflow, deskOnManagedCycles on: a managed cycle\'s desk gets at most half the cycle\'s time; an entry cycle\'s desk keeps its budget; opencode\'s managed cycle is unchanged by the key', async () => {
  const at = decisionAt(FIRED_BAR);
  const minHeadMs = require('../../scripts/lib/tunables').runner().cycle.timeoutMinMinutes * 60000;
  const perRoleMs = require('../../scripts/lib/tunables').runner().desk.timeoutMinutes * 60000;
  // The flat entry cycle: the desk's budget is the cycle's less the head trader's minimum (each role within it).
  // A cycle long enough that half of it is less than a role's own limit (the cap binds).
  const T = require('../../scripts/lib/tunables').runner();
  const longer = w2 => Object.assign(w2, { cfg: { ...w2.cfg, cycleTimeoutMinutes: T.desk.timeoutMinutes + T.cycle.timeoutMinMinutes + 1 } });
  const flat = longer(managedOptIn(D.world({ harness: 'claude' })));
  const F = roles(flat, at, { deskRuns: true });
  await D.pass(flat, at, [{ result: 'CYCLE RESULT: no-trade - nothing' }], { runRole: F.runRole });
  const cycleMs = flat.cfg.cycleTimeoutMinutes * 60000;
  assert.strictEqual(F.runs[0].timeoutMs, Math.min(perRoleMs, cycleMs - minHeadMs), 'the default budget');
  // The managed cycle: at most half.
  const w = longer(managedOptIn(D.world({ harness: 'claude' })));
  exchange.handle(w.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40 } }, {});
  const R = roles(w, at, { deskRuns: true });
  await D.pass(w, at, [{ result: 'CYCLE RESULT: managed - holding' }], { runRole: R.runRole });
  assert.strictEqual(R.runs.length, 4);
  assert.strictEqual(T.desk.managedBudgetShare, 0.5, 'half, as the owner set it');
  for (const x of R.runs) assert.ok(x.timeoutMs <= Math.floor(cycleMs * T.desk.managedBudgetShare), `${x.role}: ${x.timeoutMs} > half of ${cycleMs}`);
  assert.ok(Math.floor(cycleMs * T.desk.managedBudgetShare) < Math.min(perRoleMs, cycleMs - minHeadMs), 'the cap binds here');
  // opencode (its launches timed): the key changes nothing: the desk runs as before, no managed text, no flag.
  const { MANAGED_DESK_TEXT } = require('../../scripts/lib/autotrader');
  const runOc = async optIn => {
    const o = D.world();
    if (optIn) managedOptIn(o);
    exchange.handle(o.state, 'place_order', { accountId: 7, contractId: MNQ_ID, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40 } }, {});
    const O = roles(o, at);
    const r = await D.pass(o, at, [{ result: 'CYCLE RESULT: managed - holding' }], { runRole: O.runRole });
    return { roles: O.runs.map(x => [x.role, x.timeoutMs]), prompt: r.ran[0].prompt.split(o.home).join('<home>'), manage: r.ctx.env.FTH_CYCLE_MANAGE, logs: r.logs };
  };
  const off = await runOc(false);
  const on = await runOc(true);
  assert.deepStrictEqual(on.roles, off.roles);
  assert.strictEqual(on.manage, undefined);
  assert.ok(!on.prompt.includes(MANAGED_DESK_TEXT));
  assert.strictEqual(on.prompt.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, ''), off.prompt.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, ''));
  assert.ok(on.logs.some(l => /deskOnManagedCycles is set but does nothing here \(harness opencode/.test(l)), on.logs.join('\n'));
  assert.ok(!off.logs.some(l => /deskOnManagedCycles/.test(l)));
});

test('entry workflow, Claude Code: a desk the runner couldn\'t complete (an analyst missing) is dropped, record and reports: the head trader runs its whole desk, phase 2 and the trade-executor in its session, as before', async () => {
  const w = D.world({ harness: 'claude' });
  const at = decisionAt(FIRED_BAR);
  const R = roles(w, at, { deskRuns: true, fail: { 'volume-liquidity-analyst': { ok: false, timedOut: true, text: '', tools: [], output: '' } } });
  const r = await D.pass(w, at, [{ result: 'CYCLE RESULT: no-trade - running the desk' }], { runRole: R.runRole });
  assert.ok(R.runs.some(x => x.role === 'market-structure-analyst'), 'the runner ran the desk');
  assert.ok(!R.runs.some(x => x.role === 'trade-executor' || x.role === 'risk-manager phase 2'));
  assert.strictEqual(r.ctx.env.FTH_CYCLE_ROLES, undefined, 'no role record for the head trader\'s gate');
  assert.strictEqual(r.ctx.env.FTH_CYCLE_ENTRY, undefined);
  assert.deepStrictEqual(r.ctx.env.FTH_CYCLE_DESK.split(',').sort(), ['market-structure-analyst', 'risk-manager', 'trend-momentum-analyst', 'volume-liquidity-analyst'], 'its whole desk to launch');
  assert.doesNotMatch(r.ran[0].prompt, /The desk ran for this bar/);
  assert.match(r.ran[0].prompt, /then risk-manager phase 2 on your plan, if any/);
  assert.ok(r.logs.some(l => /^error the desk: volume-liquidity-analyst missing: the head trader runs its desk this cycle/.test(l)), r.logs.join('\n'));
  const files = fs.readdirSync(require('path').join(w.home, 'logs')).filter(f => /^cycle-roles/.test(f));
  assert.deepStrictEqual(files, [], 'the dropped record is removed');
});

test('entry workflow, Claude Code with headSkillsInPrompt (this machine\'s opt-in): the head trader gets its index-mode skills as a system-prompt file, loads none, composes and says planned; the runner\'s entry places the order (the gate counts the attested skills for the executor); without the key the same head trader is refused [skills-loaded]', async () => {
  const H = require('../../scripts/lib/head-prompt');
  const headScript = [
    { harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } },
    { harness: 'skill_lookup', args: { skill: 'candle-reading' } }, { harness: 'compose_check', args: { symbol: 'MNQ', side: 'long', reads: LC_READS, size: 1 } },
    { result: 'CYCLE RESULT: planned - trade_lifecycle long 1' },
  ];
  const w = D.world({ harness: 'claude' });
  w.cfg = { ...w.cfg, headSkillsInPrompt: true };
  const at = decisionAt(FIRED_BAR);
  const R = roles(w, at, { deskRuns: true });
  const r = await D.pass(w, at, headScript, { runRole: R.runRole });
  // The head trader's run: told its skills are in its prompt, the file attested for its cycle.
  assert.match(r.ran[0].prompt, /are in your prompt, already loaded \(don't load them again\)/);
  const att = H.parseAttestation(r.ctx.env.FTH_HEAD_PROMPT);
  assert.ok(att && att.harness === 'claude', r.ctx.env.FTH_HEAD_PROMPT);
  assert.strictEqual(att.cycle, require('../../scripts/lib/trading/check-order').cycleId(r.ctx.env));
  assert.ok(fs.readFileSync(att.config, 'utf8').includes('<skill name="trade-lifecycle">'));
  const { buildCommand } = require('../../scripts/lib/autotrader');
  const argv = buildCommand(w.cfg, r.ran[0].prompt, D.ROOT, D.passEnv(w, at));
  assert.strictEqual(argv[argv.indexOf('--append-system-prompt-file') + 1], att.config, 'the head trader\'s argv names the attested file');
  // The roles' runs: no prompt addition; the trade-executor carries the head trader's attestation.
  for (const x of R.runs) assert.ok(!x.argv.includes('--append-system-prompt-file'), x.role);
  const exec = R.runs.at(-1);
  assert.strictEqual(exec.role, 'trade-executor');
  assert.strictEqual(exec.env.FTH_HEAD_PROMPT, r.ctx.env.FTH_HEAD_PROMPT);
  // The desk's runs (before the head trader, no cycle id): none.
  for (const x of R.runs.slice(0, 4)) assert.ok(!('FTH_HEAD_PROMPT' in x.env), x.role);
  // The order went, allowed by the gate, and filled.
  assert.deepStrictEqual(entries(w).map(e => [e.decision, (e.violations || []).map(v => v.check)]), [['allowed', []]]);
  assert.strictEqual(D.placedAtBroker(w).length, 1);
  assert.match(r.ran[0].result, /^CYCLE RESULT: executed - trade_lifecycle long 1 MNQ/);
  // The same head trader without the key: it loaded nothing, so the gate refuses the executor's order.
  const v = D.world({ harness: 'claude' });
  const r2 = await D.pass(v, at, headScript, { runRole: roles(v, at, { deskRuns: true }).runRole });
  assert.ok(!('FTH_HEAD_PROMPT' in r2.ctx.env));
  assert.ok(!require('../../scripts/lib/autotrader').buildCommand(v.cfg, r2.ran[0].prompt, D.ROOT, D.passEnv(v, at)).includes('--append-system-prompt-file'));
  const e = entries(v).at(-1);
  assert.strictEqual(e.decision, 'blocked');
  assert.deepStrictEqual(e.violations.map(x => x.check), ['skills-loaded', 'skills-at-entry']);
  assert.deepStrictEqual(D.placedAtBroker(v), []);
  assert.match(r2.ran[0].result, /^CYCLE RESULT: blocked - the order gate refused the trade_lifecycle long 1 MNQ: \[skills-loaded\]/);
});
