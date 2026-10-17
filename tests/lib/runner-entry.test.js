'use strict';

// The runner's entry (scripts/lib/runner-entry.js): the decision's record, phase 2's verdict, the order built in code,
// the journal plan, the trade-executor, the after-order read and the cycle's outcome, on a scripted runRole and broker.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const E = require('../../scripts/lib/runner-entry');
const RR = require('../../scripts/lib/trading/runner-roles');
const TL = require('../../scripts/lib/trading/trade-lifecycle');
const { workflowNamed } = require('../../scripts/lib/orchestrate/workflows');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const BAR = '2026-10-07T13:54:00.000Z';
const PLAN = { entry: { price: 21500 }, stop: { price: 21490, ticks: 40, source: 'swing', level: 21490.25, bufferTicks: 1, floorTicks: 8 }, target: { price: 21520, ticks: 80, source: 'swing', level: 21520 }, rr: 2, size: 1, riskUsd: 20, perContractUsd: 20, maxSize: 15 };
const record = (o = {}) => ({ schema: 1, id: o.id || 'rec0000000000001', at: '2026-10-07T13:57:30.000Z', strategy: 'trade_lifecycle', root: 'MNQ', symbol: 'MNQ', side: 'long', bar: BAR, expiresAt: '2026-10-07T14:03:00.000Z', ok: true, problems: [], reads: [], plan: PLAN, ...o });
const ARGS = { accountId: 7, contractId: 'MNQ', side: 'buy', type: 'limit', size: 1, limitPrice: 21500, stopLossBracket: { ticks: 40, type: 'stop' }, takeProfitBracket: { ticks: 80, type: 'limit' }, rationale: 'setup:trade_lifecycle long limit 21500.00 (the record\'s entry price), stop 21490.00, record rec0000000000001' };
const P2 = 'Phase 2.\nVERDICT: APPROVE - size 1, risk $20.00\nFACTS: window opening drive; trend long allowed';

/** A home with the records on the bar, and the deps runEntry runs on (every role and the broker scripted). */
function setup({ records = [record()], roles = {}, plan = null, journalFails = false, state = { positions: [{ contractId: 'MNQ', type: 1, size: 1 }], orders: [] }, readFails = false } = {}) {
  const home = tmpDir();
  for (const r of records) TL.appendRecord(home, r);
  const calls = [];
  const journal = [];
  const runRole = async (role, request, limits) => {
    const phase = /^Phase 2, plan verdict/.test(request) ? 'phase2' : role;
    calls.push({ role: phase, request, limits });
    const scripted = roles[phase];
    if (typeof scripted === 'function') return scripted(request, limits);
    if (scripted) return scripted;
    if (phase === 'phase2') return { ok: true, timedOut: false, text: P2, tools: ['harness_order_plan'], lookups: [], output: '' };
    return { ok: true, timedOut: false, text: 'EXECUTED\nOrders: 1', tools: ['broker_place_order'], lookups: [], output: '' };
  };
  const client = {
    journalAdd: async e => { if (journalFails) throw new Error('journal down'); journal.push(e); return { ts: new Date().toISOString(), ...e }; },
    accountState: async () => { if (readFails) throw new Error('no answer'); return state; },
  };
  const logs = [];
  const rolesFile = path.join(home, 'logs', 'cycle-roles-test.jsonl');
  const deps = {
    workflow: workflowNamed(ROOT, 'entry'), runRole, client, home, cfg: { timeframe: 3, harness: 'opencode' }, root: ROOT,
    env: { FTH_HOME: home, FTH_GATE_LOG: path.join(home, 'gate.jsonl') }, log: (m, l) => logs.push(`${l || 'info'} ${m}`), perRoleMs: 60000,
    childEnv: (cfg, root, env) => ({ ...env }), lookups: {},
    orderPlan: plan || (() => ({ args: ARGS, plan: { strategy: 'trade_lifecycle', side: 'long', contract: 'MNQ', size: 1, entry: 21500, stopPrice: 21490, stopTicks: 40, targetPrice: 21520, targetTicks: 80, riskUsd: 20, record: 'rec0000000000001' } })),
  };
  const cycle = (o = {}) => ({
    result: 'CYCLE RESULT: planned - trade_lifecycle long 1', output: JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'skill', state: { status: 'completed', input: { name: 'trade-lifecycle' } } } }),
    headEnv: { FTH_CYCLE_TRANSCRIPT: path.join(home, 'logs', 'head.jsonl') }, symbol: 'MNQ', contractId: 'MNQ', bar: BAR, bars: '/bars/MNQ-3m.json', at: '2026-10-07T13:57:02.000Z',
    accountId: 7, context: { symbols: [{ symbol: 'MNQ', bar: { t: BAR } }], entry: true }, rolesFile, reports: [{ role: 'risk-manager', text: '## Risk state: account 7' }], budgetMs: 600000, ...o,
  });
  return { home, deps, cycle, calls, journal, logs, rolesFile };
}

test('entryDue: the latest compose record on the bar decides; it must be OK and have a side', () => {
  assert.deepStrictEqual(E.entryDue([]), { run: false, why: 'planned without a compose record on the cycle\'s bar' });
  assert.strictEqual(E.entryDue([record()]).run, true);
  assert.match(E.entryDue([record(), record({ id: 'b', ok: false })]).why, /the latest, b, is not OK/, 'an OK one before a NOT OK one is not the decision');
  assert.strictEqual(E.entryDue([record({ id: 'a', ok: false }), record({ id: 'b' })]).record.id, 'b');
  assert.match(E.entryDue([record({ side: null })]).why, /has no side/);
});

test('verdictLine and entryOutcome: the line as written; executed on the account or the gateway\'s record, else the gate\'s refusal, else the executor\'s own BLOCKED or ABORTED, else no order', () => {
  assert.strictEqual(E.verdictLine('Phase 2\nVERDICT: VETO - room\nFACTS: x'), 'VERDICT: VETO - room');
  assert.strictEqual(E.verdictLine('no verdict'), '');
  const label = 'trade_lifecycle long 1 MNQ';
  assert.match(E.entryOutcome({ entered: true, filled: true, label }).result, /^CYCLE RESULT: executed - trade_lifecycle long 1 MNQ \(the runner's entry: phase 2 approved, the order filled\)$/);
  assert.match(E.entryOutcome({ entered: true, label }).result, /the order went\)$/);
  assert.strictEqual(E.entryOutcome({ entered: false, refusal: { checks: ['briefing-age'], message: '[briefing-age] Stale data' }, label }).outcome, 'blocked');
  assert.match(E.entryOutcome({ entered: false, report: 'ABORTED\nOrderRejected', label }).result, /^CYCLE RESULT: blocked - the trade_lifecycle long 1 MNQ was refused by the broker: ABORTED OrderRejected$/);
  assert.match(E.entryOutcome({ entered: false, report: '**BLOCKED**\nBlocked by trading harness', label }).result, /was blocked: /);
  // Its order call went and the account shows nothing: the broker took none, whatever the executor said.
  const took = E.entryOutcome({ entered: false, report: 'EXECUTED (it says)', sent: true, label });
  assert.deepStrictEqual([took.outcome, /was refused by the broker: the order went and the account shows no position or entry \(the executor's report: EXECUTED \(it says\)\)$/.test(took.result)], ['blocked', true]);
  const none = E.entryOutcome({ entered: false, report: 'EXECUTED (it says)', failed: { stop: 'invalid', why: 'no order call and no refusal reported' }, label });
  assert.deepStrictEqual([none.outcome, none.result], ['no-trade', 'CYCLE RESULT: no-trade - the runner\'s entry: the trade-executor invalid (no order call and no refusal reported): no order']);
});

test('gateRefusal: the gate log\'s last blocked place_order of this cycle, since the order went; another cycle\'s, an allowed one or an older one is none', () => {
  const home = tmpDir();
  const env = { FTH_GATE_LOG: path.join(home, 'gate.jsonl') };
  const now = Date.now();
  const line = o => JSON.stringify({ ts: new Date(now).toISOString(), source: 'gateway', tool: 'place_order', decision: 'blocked', cycle: 'c1', violations: [{ check: 'briefing-age', message: 'Stale data' }], ...o });
  fs.writeFileSync(env.FTH_GATE_LOG, [line({ cycle: 'c2' }), line({ decision: 'allowed', violations: [] }), line({ ts: new Date(now - 60000).toISOString() }), 'torn{'].join('\n'));
  assert.strictEqual(E.gateRefusal(env, 'c1', now - 1000), null);
  fs.appendFileSync(env.FTH_GATE_LOG, `\n${line()}\n`);
  assert.deepStrictEqual(E.gateRefusal(env, 'c1', now - 1000), { checks: ['briefing-age'], message: '[briefing-age] Stale data' });
  assert.strictEqual(E.gateRefusal({ FTH_GATE_LOG: path.join(home, 'none.jsonl') }, 'c1', 0), null, 'no log: none');
});

test('runEntry: not planned is nothing for the runner; planned without an OK record is a process failure, logged, nothing runs', async () => {
  const s = setup();
  assert.strictEqual(await E.runEntry(s.deps, s.cycle({ result: 'CYCLE RESULT: no-trade - nothing' })), null);
  assert.strictEqual(await E.runEntry(s.deps, s.cycle({ result: 'CYCLE RESULT: executed - x' })), null);
  for (const records of [[], [record({ ok: false })]]) {
    const t = setup({ records });
    const r = await E.runEntry(t.deps, t.cycle());
    assert.deepStrictEqual([r.result, r.entry.outcome], ['CYCLE RESULT: planned - trade_lifecycle long 1', 'process-failure']);
    assert.deepStrictEqual(t.calls, [], 'no role runs');
    assert.ok(t.logs.some(l => /^error the entry: planned without .*a process failure; nothing runs/.test(l)), t.logs.join('\n'));
  }
  // A record on another bar is not this cycle's.
  const other = setup({ records: [record({ bar: '2026-10-07T13:51:00.000Z' })] });
  assert.strictEqual((await E.runEntry(other.deps, other.cycle())).entry.outcome, 'process-failure');
});

test('runEntry: approved: the head trader\'s skills and phase 2 recorded before the executor runs; the order is order_plan\'s, the plan journaled for the bar; the executor gets the exact arguments and the verdict line; executed on the account read', async () => {
  const s = setup();
  let seenByExecutor = null;
  s.deps.runRole = (orig => async (role, request, limits) => {
    if (role === 'trade-executor') seenByExecutor = { runs: RR.readRoleRuns(s.rolesFile), skills: RR.readHeadSkills(s.rolesFile), journal: [...s.journal] };
    return orig(role, request, limits);
  })(s.deps.runRole);
  const r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual(s.calls.map(c => c.role), ['phase2', 'trade-executor']);
  // Phase 2's request: the record, the reports, the bars; the executor's: order_plan's arguments, phase 2's line.
  assert.match(s.calls[0].request, /rec0000000000001/);
  assert.match(s.calls[0].request, /--- risk-manager phase 1 report ---\n## Risk state: account 7/);
  assert.ok(s.calls[1].request.includes(JSON.stringify(ARGS)), s.calls[1].request);
  assert.match(s.calls[1].request, /The risk manager's line: VERDICT: APPROVE - size 1, risk \$20\.00\./);
  // The roles run with the cycle's context, its record, never the entry flag; the head trader's cycle id.
  const ctx = s.calls[1].limits.context;
  assert.deepStrictEqual([ctx.entry, ctx.rolesFile, typeof ctx.cycleId], [false, s.rolesFile, 'string']);
  assert.strictEqual(ctx.cycleId, require('../../scripts/lib/trading/check-order').cycleId(s.cycle().headEnv));
  // Before the executor: phase 2's run (wall-clock times, ok) and the head trader's loads in the record, the plan journaled.
  assert.deepStrictEqual(seenByExecutor.runs.map(x => [x.role, x.ok]), [['risk-manager', true]]);
  assert.ok(seenByExecutor.runs[0].end >= seenByExecutor.runs[0].start && seenByExecutor.runs[0].start > 1e12);
  assert.deepStrictEqual(seenByExecutor.skills, ['trade-lifecycle']);
  assert.deepStrictEqual(seenByExecutor.journal.map(e => [e.kind, e.contractId, e.accountId, e.tags]), [['plan', 'MNQ', 7, ['setup:trade_lifecycle', 'MNQ']]]);
  // After: the executor's run ends the round (a launch in the record); executed on the account read.
  assert.deepStrictEqual(RR.readRoleRuns(s.rolesFile).map(x => x.role), ['risk-manager', 'trade-executor']);
  assert.strictEqual(RR.asRoleCalls(RR.readRoleRuns(s.rolesFile)).launches.length, 1);
  assert.deepStrictEqual([r.entry.outcome, r.entry.account], ['executed', { positions: 1, orders: 0 }]);
  assert.match(r.result, /^CYCLE RESULT: executed - trade_lifecycle long 1 MNQ/);
});

test('runEntry: a VETO (or no approval) stops before the order: no order built, no plan, no executor; the cycle a no-trade with the veto line', async () => {
  for (const text of ['Phase 2.\nVERDICT: VETO - room: stand aside\nFACTS: window asia; trend long allowed', 'Phase 2.\nVERDICT: maybe\nFACTS: window asia; trend long allowed']) {
    let built = false;
    const s = setup({ roles: { phase2: { ok: true, timedOut: false, text, tools: ['harness_order_plan'], lookups: [], output: '' } }, plan: () => { built = true; return null; } });
    const r = await E.runEntry(s.deps, s.cycle());
    assert.deepStrictEqual(s.calls.map(c => c.role), ['phase2']);
    assert.strictEqual(built, false);
    assert.deepStrictEqual(s.journal, []);
    assert.strictEqual(r.entry.outcome, 'vetoed');
    assert.match(r.result, /^CYCLE RESULT: no-trade - risk-manager vetoed the trade_lifecycle long 1 MNQ: VERDICT: /);
    assert.deepStrictEqual(RR.readRoleRuns(s.rolesFile).map(x => [x.role, x.ok]), [['risk-manager', true]], 'the veto is recorded');
  }
});

test('runEntry: phase 2 failing (a timeout, no FACTS line), order_plan refusing, or the plan unjournaled: no executor, logged, a no-trade naming it; a phase 2 that reads no data doesn\'t count', async () => {
  const cases = [
    [{ roles: { phase2: { ok: false, timedOut: true, text: '', tools: [], output: '' } } }, /risk-manager phase 2 timed_out \(timed out\)/, 2],
    [{ roles: { phase2: { ok: true, timedOut: false, text: 'VERDICT: APPROVE - size 1', tools: ['harness_order_plan'], output: '' } } }, /risk-manager phase 2 invalid \(no FACTS line/, 2],
    [{ roles: { phase2: { ok: true, timedOut: false, text: P2, tools: ['harness_skill_lookup'], output: '' } } }, /risk-manager phase 2 invalid \(read no data\)/, 2],
    [{ plan: () => { throw new Error('the order gate would refuse it: [composed-reads] the plan is not the record\'s'); } }, /order_plan refused the composed plan: the order gate would refuse it: \[composed-reads\] the plan is not the record's/, 1],
    [{ journalFails: true }, /the journal plan could not be written \(journal down\)/, 1],
  ];
  for (const [o, why, p2Runs] of cases) {
    const s = setup(o);
    const r = await E.runEntry(s.deps, s.cycle());
    assert.deepStrictEqual(s.calls.map(c => c.role), Array(p2Runs).fill('phase2'), String(why));
    assert.strictEqual(r.entry.outcome, 'no-trade');
    assert.match(r.result, why);
    assert.ok(s.logs.some(l => /^error the entry: /.test(l)), s.logs.join('\n'));
  }
});

test('runEntry: the executor is never run again; its failure, a refusal it reports, or no order on the account set the outcome; an unreadable account falls back to the gateway\'s record', async () => {
  const flat = { positions: [], orders: [] };
  // Timed out without an order: one attempt, no order, a no-trade.
  let s = setup({ roles: { 'trade-executor': { ok: false, timedOut: true, text: '', tools: [], output: '' } }, state: flat });
  let r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual(s.calls.map(c => c.role), ['phase2', 'trade-executor']);
  assert.deepStrictEqual([r.entry.outcome, r.result], ['no-trade', 'CYCLE RESULT: no-trade - the runner\'s entry: the trade-executor timed_out (timed out): no order']);
  // It reports the broker's refusal: blocked.
  s = setup({ roles: { 'trade-executor': { ok: true, timedOut: false, text: 'ABORTED\nOrderRejected', tools: [], output: '' } }, state: flat });
  r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, s.calls.length], ['blocked', 2]);
  // The broker lost the reply but took it (a position shows): executed, never sent again.
  s = setup({ roles: { 'trade-executor': { ok: true, timedOut: false, text: 'ABORTED\nno reply: the outcome is unknown', tools: [], output: '' } } });
  r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, s.calls.length], ['executed', 2]);
  // The account can't be read: the gateway's record of this record's entry decides.
  s = setup({ readFails: true });
  fs.writeFileSync(path.join(s.home, 'entry-orders.json'), JSON.stringify([{ orderId: 5, composed: { record: 'rec0000000000001' } }]));
  r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, r.entry.account.error], ['executed', 'no answer']);
  assert.ok(s.logs.some(l => /the account can't be read after the order/.test(l)));
});

test('runEntry: the cycle\'s budget bounds every role\'s run; none left, no role runs (a timeout, no order)', async () => {
  const s = setup();
  const r0 = await E.runEntry({ ...s.deps, wallNow: () => 1e12 }, s.cycle({ budgetMs: 0 }));
  assert.deepStrictEqual([s.calls.length, r0.entry.outcome], [0, 'no-trade']);
  const t = setup();
  await E.runEntry(t.deps, t.cycle({ budgetMs: 30000 }));
  assert.ok(t.calls.every(c => c.limits.timeoutMs <= 30000 && c.limits.timeoutMs > 0), JSON.stringify(t.calls.map(c => c.limits.timeoutMs)));
  // No role record: nothing runs.
  const u = setup();
  const r = await E.runEntry(u.deps, u.cycle({ rolesFile: null }));
  assert.deepStrictEqual([u.calls.length, r.entry.outcome], [0, 'process-failure']);
});

test('plannedDrift: the planned line\'s side, and its size when it states one, must be the record\'s; a line naming no side can\'t be matched', () => {
  const rec = record();
  assert.strictEqual(E.plannedDrift('CYCLE RESULT: planned - trade_lifecycle long 1', rec), null);
  assert.strictEqual(E.plannedDrift('CYCLE RESULT: planned - trade_lifecycle LONG, as composed', rec), null, 'no size stated: the side alone');
  assert.match(E.plannedDrift('CYCLE RESULT: planned - trade_lifecycle short 1', rec), /says short, the latest OK compose record rec0000000000001 is a long/);
  assert.match(E.plannedDrift('CYCLE RESULT: planned - trade_lifecycle long 2', rec), /says size 2, the compose record rec0000000000001 states 1/);
  assert.match(E.plannedDrift('CYCLE RESULT: planned - the composed trade', rec), /names no side/);
});

test('runEntry: a planned line whose side or size isn\'t the record\'s is a process failure: nothing runs, logged, the head trader\'s line kept', async () => {
  for (const result of ['CYCLE RESULT: planned - trade_lifecycle short 1', 'CYCLE RESULT: planned - trade_lifecycle long 3', 'CYCLE RESULT: planned - as composed']) {
    const s = setup();
    const r = await E.runEntry(s.deps, s.cycle({ result }));
    assert.deepStrictEqual([r.result, r.entry.outcome, s.calls.length], [result, 'process-failure', 0], result);
    assert.ok(s.logs.some(l => /^error the entry: the planned line .*a process failure; nothing runs/.test(l)), s.logs.join('\n'));
  }
});

test('entryOutcome: the gate let the order through and its call never completed (a lost reply) with nothing on the account: unknown, never blocked; a report quoting BLOCKED below its first line is no refusal', () => {
  const label = 'trade_lifecycle long 1 MNQ';
  const lost = E.entryOutcome({ entered: false, allowed: true, sent: false, report: 'ABORTED\nno reply: the outcome is unknown', label });
  assert.strictEqual(lost.outcome, 'unknown');
  assert.match(lost.result, /^CYCLE RESULT: executed - trade_lifecycle long 1 MNQ: unknown, the order's outcome couldn't be read/);
  // The call completed and nothing shows: the broker refused it.
  assert.strictEqual(E.entryOutcome({ entered: false, allowed: true, sent: true, report: 'ABORTED\nOrderRejected', label }).outcome, 'blocked');
  // A refusal word only on the report's first line.
  const quoted = E.entryOutcome({ entered: false, report: 'EXECUTED\nNotes: an earlier order was BLOCKED', label });
  assert.strictEqual(quoted.outcome, 'no-trade');
  const { ORDER_REFUSED } = require('../../scripts/lib/orchestrate/checks');
  assert.ok(ORDER_REFUSED.test('\n  **BLOCKED**\nBlocked by trading harness'));
  assert.ok(!ORDER_REFUSED.test('EXECUTED\nABORTED earlier'));
});

test('runEntry: an order the gate let through whose reply was lost, and an account that can\'t be read after it: unknown, never blocked', async () => {
  const s = setup({ roles: { 'trade-executor': { ok: true, timedOut: false, text: 'ABORTED\nno reply: the outcome is unknown', tools: ['broker_get_account_snapshot'], output: '' } }, readFails: true });
  const id = require('../../scripts/lib/trading/check-order').cycleId(s.cycle().headEnv);
  fs.writeFileSync(s.deps.env.FTH_GATE_LOG, `${JSON.stringify({ ts: new Date(Date.now() + 5000).toISOString(), source: 'gateway', tool: 'place_order', decision: 'allowed', cycle: id, violations: [] })}\n`);
  const r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, r.entry.account.error], ['unknown', 'no answer']);
  assert.match(r.result, /^CYCLE RESULT: executed - .*unknown, the order's outcome couldn't be read/);
});

test('runEntry: a record that expired before the order is its own outcome (expired), counted apart; the timing from the bar\'s close is in the entry', async () => {
  const s = setup({ plan: () => { throw new Error('the order gate would refuse it: [composed-reads] setup:trade_lifecycle: the compose record expired at 2026-10-07T14:03:00.000Z'); } });
  let wall = 1e12;
  s.deps.wallNow = () => (wall += 1000);
  const r = await E.runEntry(s.deps, s.cycle({ startedWall: 1e12 - 30000 }));
  assert.deepStrictEqual([r.result, r.entry.outcome], ['CYCLE RESULT: no-trade - the composed record expired before the order', 'expired']);
  const t = r.entry.timing;
  // The bar opened 13:54 and closed 13:57; the cycle began 13:57:02 (2 s later) and the head trader ran 30 s and more.
  assert.strictEqual(t.barClose, '2026-10-07T13:57:00.000Z');
  assert.ok(t.headMs >= 32000 && t.orderMs > t.headMs && t.phase2Ms > 0, JSON.stringify(t));
  assert.strictEqual(t.executorMs, null, 'no executor ran');
});
