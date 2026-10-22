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
// The harness clock at the order's moment, and the newest closed 1m bar then (13:56 opened, closed 13:57): the market.
const NOW = new Date('2026-10-07T13:57:40.000Z');
function setup({ records = [record()], roles = {}, plan = null, journalFails = false, state = { positions: [{ contractId: 'MNQ', type: 1, size: 1 }], orders: [] }, readFails = false, market = 21500, barsFail = false } = {}) {
  const home = tmpDir();
  for (const r of records) TL.appendRecord(home, r);
  const calls = [];
  const barReads = [];
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
    closedBars: async (contractId, o) => { barReads.push({ contractId, ...o }); if (barsFail) throw new Error('HTTP 503'); return [{ t: '2026-10-07T13:55:00.000Z', o: 21500, h: 21501, l: 21499, c: 21500, v: 1 }, { t: '2026-10-07T13:56:00.000Z', o: 21500, h: Math.max(21500, market), l: Math.min(21500, market), c: market, v: 1 }]; },
  };
  const logs = [];
  const rolesFile = path.join(home, 'logs', 'cycle-roles-test.jsonl');
  const deps = {
    workflow: workflowNamed(ROOT, 'entry'), runRole, client, home, cfg: { timeframe: 3, harness: 'opencode' }, root: ROOT,
    env: { FTH_HOME: home, FTH_GATE_LOG: path.join(home, 'gate.jsonl') }, log: (m, l) => logs.push(`${l || 'info'} ${m}`), perRoleMs: 60000, now: () => NOW,
    childEnv: (cfg, root, env) => ({ ...env }), lookups: {},
    orderPlan: plan || (() => ({ args: ARGS, plan: { strategy: 'trade_lifecycle', side: 'long', contract: 'MNQ', size: 1, entry: 21500, stopPrice: 21490, stopTicks: 40, targetPrice: 21520, targetTicks: 80, riskUsd: 20, record: 'rec0000000000001' } })),
  };
  const cycle = (o = {}) => ({
    result: 'CYCLE RESULT: planned - trade_lifecycle long 1', output: JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'skill', state: { status: 'completed', input: { name: 'trade-lifecycle' } } } }),
    headEnv: { FTH_CYCLE_TRANSCRIPT: path.join(home, 'logs', 'head.jsonl') }, symbol: 'MNQ', contractId: 'MNQ', bar: BAR, bars: '/bars/MNQ-3m.json', at: '2026-10-07T13:57:02.000Z',
    accountId: 7, context: { symbols: [{ symbol: 'MNQ', bar: { t: BAR } }], entry: true }, rolesFile, reports: [{ role: 'risk-manager', text: '## Risk state: account 7' }], budgetMs: 600000, ...o,
  });
  return { home, deps, cycle, calls, barReads, journal, logs, rolesFile };
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

test('runEntry: timing.orderMs is the order actually sent: the gate log\'s allowed decision of this cycle (from the bar\'s close), never the executor\'s end; a refused order has none; executorMs is the executor\'s run', async () => {
  const id = require('../../scripts/lib/trading/check-order').cycleId({ FTH_CYCLE_TRANSCRIPT: 'x' });
  const run = async decision => {
    const s = setup();
    const cyc = s.cycle({ headEnv: { FTH_CYCLE_TRANSCRIPT: 'x' } });
    const started = Date.now();
    const sentTs = new Date(started + 40000).toISOString(); // the gate's decision, 40 s after the head trader began
    s.deps.runRole = (orig => async (role, request, limits) => {
      if (role === 'trade-executor') fs.writeFileSync(s.deps.env.FTH_GATE_LOG, `${JSON.stringify({ ts: sentTs, source: 'gateway', tool: 'place_order', decision, cycle: id, violations: decision === 'blocked' ? [{ check: 'briefing-age', message: 'Stale data' }] : [] })}\n`);
      return orig(role, request, limits);
    })(s.deps.runRole);
    return (await E.runEntry(s.deps, { ...cyc, startedWall: started })).entry.timing;
  };
  const t = await run('allowed');
  // The cycle began 2 s after the bar's close (13:57:00 -> 13:57:02): 2 s + 40 s.
  assert.strictEqual(t.orderMs, 42000, JSON.stringify(t));
  assert.ok(Number.isFinite(t.executorMs) && Number.isFinite(t.phase2Ms));
  assert.strictEqual((await run('blocked')).orderMs, null, 'refused: no order sent');
});

test('runEntry: no late entry: the newest closed 1m bar, read just before the executor and recorded for the gate, beyond the plan\'s stop or past its entry against it over the share is a pass: no executor run, no journal plan, outcome late', async () => {
  const LE = require('../../scripts/lib/trading/late-entry');
  // The plan: a long, limit 21500, stop 21490 (10 points): 0.25 of it = 2.5 points under the entry.
  for (const [market, why] of [[21488, /^CYCLE RESULT: no-trade - the runner's entry: the setup was invalidated before the order went \(price 21488 beyond the plan's stop 21490\): no late entry/], [21497.25, /^CYCLE RESULT: no-trade - the runner's entry: missed the plan's entry 21500 \(price 21497\.25 is 2\.75 points past it against the long/]]) {
    const s = setup({ market });
    const r = await E.runEntry(s.deps, s.cycle({ startedWall: Date.now() }));
    assert.deepStrictEqual(s.calls.map(c => c.role), ['phase2'], 'phase 2 ran; the executor never did');
    assert.deepStrictEqual([r.entry.outcome, s.journal], ['late', []]);
    assert.match(r.result, why);
    assert.match(r.entry.why, /no late entry/);
    assert.ok(Number.isFinite(r.entry.timing.orderMs), 'the order\'s moment: the refusal');
    // The bar read at the harness's clock, on the order's contract, and recorded for the gate (its close at 13:57).
    assert.deepStrictEqual([s.barReads[0].contractId, s.barReads[0].minutes, s.barReads[0].now], ['MNQ', 1, NOW]);
    assert.deepStrictEqual(LE.readPrice(s.home, 'MNQ'), { price: market, closedAt: '2026-10-07T13:57:00.000Z', minutes: 1, source: 'runner-entry' });
    assert.ok(s.logs.some(l => /^info the entry: .*no late entry.*a pass, no executor run$/.test(l)), s.logs.join('\n'));
  }
  // Within the share, and the trade's way past the entry: the executor runs (the limit rests at the plan's price).
  for (const market of [21497.5, 21530]) {
    const s = setup({ market });
    const r = await E.runEntry(s.deps, s.cycle());
    assert.deepStrictEqual([s.calls.map(c => c.role), r.entry.outcome], [['phase2', 'trade-executor'], 'executed'], String(market));
  }
});

test('runEntry: no late entry, the replay\'s short (2021-08-18): sell limit 14979.5, stop 14986.5, the market at 14997.5 when the order would go: refused, never sent', async () => {
  const BAR21 = '2021-08-18T17:33:00.000Z';
  const rec = record({ side: 'short', bar: BAR21, plan: { ...PLAN, entry: { price: 14979.5 }, stop: { ...PLAN.stop, price: 14986.5, ticks: 28 }, target: { ...PLAN.target, price: 14960, ticks: 78 } } });
  const s = setup({ records: [rec], market: 14997.5, plan: () => ({ args: { ...ARGS, side: 'sell', limitPrice: 14979.5, stopLossBracket: { ticks: 28, type: 'stop' }, takeProfitBracket: { ticks: 78, type: 'limit' } }, plan: { strategy: 'trade_lifecycle', side: 'short', contract: 'MNQ', size: 1, entry: 14979.5, stopPrice: 14986.5, stopTicks: 28, targetPrice: 14960, targetTicks: 78, riskUsd: 14, record: rec.id } }) });
  s.deps.now = () => new Date('2021-08-18T17:37:30.000Z');
  s.deps.client.closedBars = async () => [{ t: '2021-08-18T17:36:00.000Z', o: 14990, h: 14998, l: 14989, c: 14997.5, v: 1 }];
  const r = await E.runEntry(s.deps, s.cycle({ result: 'CYCLE RESULT: planned - trade_lifecycle short 1', bar: BAR21, at: '2021-08-18T17:36:02.000Z' }));
  assert.deepStrictEqual([r.entry.outcome, s.calls.map(c => c.role)], ['late', ['phase2']]);
  assert.match(r.result, /the setup was invalidated before the order went \(price 14997\.5 beyond the plan's stop 14986\.5\): no late entry/);
});

test('runEntry: no late entry fails closed: the 1m bar unreadable and no local bar is a pass (logged); a fresh local briefing at the plan decides when the read fails', async () => {
  const s = setup({ barsFail: true });
  const r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, s.calls.map(c => c.role)], ['late', ['phase2']]);
  assert.match(r.result, /no current price for MNQ from local bars \(no local bar\).*fails closed/);
  assert.ok(s.logs.some(l => /^error the entry: the latest 1m bar can't be read \(HTTP 503\): the local bars decide$/.test(l)), s.logs.join('\n'));
  // The cycle bar's own briefing (closed 13:57, its close at the plan's entry): it decides; the entry goes on.
  const t = setup({ barsFail: true });
  require('../../scripts/lib/trading/briefing').writeBriefing(t.home, { symbol: 'MNQ', minutes: 3, asOf: BAR, closedAt: '2026-10-07T13:57:00.000Z', price: 21500, sections: {} });
  const ok = await E.runEntry(t.deps, t.cycle());
  assert.deepStrictEqual([ok.entry.outcome, t.calls.map(c => c.role)], ['executed', ['phase2', 'trade-executor']]);
});

test('runEntry: a Claude Code head trader the runner attested in index mode: its skill_lookup reads recorded as its loads, and its attestation passed to the roles\' runs with the cycle\'s id; without it, as before', async () => {
  const lookup = (id, skill) => [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__harness__skill_lookup', input: { skill } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `<skill name="${skill}">\n...\n</skill>\n` }] }] } }),
  ].join('\n');
  const skill = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'trade-lifecycle' } }] } });
  const output = [skill, lookup('l1', 'strategy-scan')].join('\n');
  const att = { harness: 'claude', config: '/h/head-prompt/claude-head-0123456789abcdef.md', sha256: 'a'.repeat(64), skills: ['trade-session'], cycle: null };
  // Without the attestation: the Skill load only, no headPrompt in the roles' context.
  let s = setup();
  s.deps.cfg = { timeframe: 3, harness: 'claude' };
  await E.runEntry(s.deps, s.cycle({ output }));
  assert.deepStrictEqual(RR.readHeadSkills(s.rolesFile), ['trade-lifecycle']);
  assert.ok(!('headPrompt' in s.calls[1].limits.context));
  // With it: the lookups too, and the attestation as the head trader's run had it.
  s = setup();
  s.deps.cfg = { timeframe: 3, harness: 'claude' };
  const headEnv = s.cycle().headEnv;
  const id = require('../../scripts/lib/trading/check-order').cycleId(headEnv);
  const value = JSON.stringify({ ...att, cycle: id });
  await E.runEntry(s.deps, s.cycle({ output, headEnv: { ...headEnv, FTH_HEAD_PROMPT: value } }));
  assert.deepStrictEqual(RR.readHeadSkills(s.rolesFile), ['strategy-scan', 'trade-lifecycle']);
  assert.deepStrictEqual([s.calls[1].limits.context.cycleId, s.calls[1].limits.context.headPrompt], [id, value]);
  // opencode's attestation (no harness): as before.
  s = setup();
  await E.runEntry(s.deps, s.cycle({ output, headEnv: { ...headEnv, FTH_HEAD_PROMPT: JSON.stringify({ config: '/w/opencode.json', sha256: 'a'.repeat(64), skills: ['trade-session'] }) } }));
  assert.deepStrictEqual(RR.readHeadSkills(s.rolesFile), ['trade-lifecycle']);
  assert.ok(!('headPrompt' in s.calls[1].limits.context));
});
