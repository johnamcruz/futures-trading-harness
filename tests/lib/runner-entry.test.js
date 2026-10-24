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
  assert.strictEqual(E.verdictLine('Phase 2 notes only'), '');
  const label = 'trade_lifecycle long 1 MNQ';
  assert.match(E.entryOutcome({ entered: true, filled: true, label }).result, /^CYCLE RESULT: executed - trade_lifecycle long 1 MNQ \(the runner's entry: phase 2 approved, the order filled\)$/);
  assert.match(E.entryOutcome({ entered: true, label }).result, /the order went\)$/);
  assert.strictEqual(E.entryOutcome({ entered: false, refusal: { checks: ['briefing-age'], message: '[briefing-age] Stale data' }, label }).outcome, 'blocked');
  // ABORTED after its order went (the gate let it through, the broker refused): the broker's refusal.
  for (const went of [{ allowed: true, sent: true }, { sent: true }, { attempted: true, sent: true }]) {
    const o = E.entryOutcome({ entered: false, report: 'ABORTED\nOrderRejected', label, ...went });
    assert.deepStrictEqual([o.outcome, o.result], ['blocked', 'CYCLE RESULT: blocked - the trade_lifecycle long 1 MNQ was refused by the broker: ABORTED OrderRejected'], JSON.stringify(went));
  }
  // ABORTED with no order call at all: the executor's own abort, no broker and no gate in it; a no-trade.
  const aborted = E.entryOutcome({ entered: false, report: 'ABORTED\nThe precondition for an entry is not met.', label });
  assert.deepStrictEqual([aborted.outcome, aborted.result], ['aborted', 'CYCLE RESULT: no-trade - the trade-executor aborted the trade_lifecycle long 1 MNQ with no order sent (no order call in its run, none in the gate log): ABORTED The precondition for an entry is not met.']);
  assert.doesNotMatch(aborted.result, /refused/);
  // The gate's refusal is its own wording.
  assert.match(E.entryOutcome({ entered: false, refusal: { checks: ['briefing-age'], message: '[briefing-age] Stale data' }, report: 'BLOCKED', label }).result, /^CYCLE RESULT: blocked - the order gate refused the trade_lifecycle long 1 MNQ: \[briefing-age\] Stale data$/);
  // The decisive line: a heading naming a verdict is never it.
  assert.strictEqual(E.verdictLine('## Phase 2 verdict: MNQ long\nVERDICT: VETO - room\nFACTS: x'), 'VERDICT: VETO - room');
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

test('gateDecision: the hook\'s records by their tool like the gateway\'s; place_order only (a refused modify_order or cancel_order naming a contract and a rationale is none); a record naming no tool is none', () => {
  const home = tmpDir();
  const env = { FTH_GATE_LOG: path.join(home, 'gate.jsonl') };
  const now = Date.now();
  const line = o => JSON.stringify({ ts: new Date(now).toISOString(), source: 'hook', decision: 'blocked', cycle: 'c1', violations: [{ check: 'plan-required', message: 'No plan' }], contractId: 'MNQ', rationale: 'setup:trade_lifecycle long', ...o });
  fs.writeFileSync(env.FTH_GATE_LOG, `${[line({ tool: 'modify_order' }), line({ tool: 'cancel_order' }), line({})].join('\n')}\n`);
  assert.strictEqual(E.gateDecision(env, 'c1', now - 1000), null, 'a modify, a cancel, an old hook record without a tool: none is the entry\'s');
  fs.appendFileSync(env.FTH_GATE_LOG, `${line({ tool: 'place_order' })}\n`);
  assert.deepStrictEqual(E.gateDecision(env, 'c1', now - 1000), { decision: 'blocked', ts: new Date(now).toISOString(), checks: ['plan-required'], message: '[plan-required] No plan', refusedAfter: null });
});

test('gateDecision: an allowed place_order of the cycle wins over a refusal before or after it (the first allowed, the later refusal named); blocked only is the last refusal; nothing is null', () => {
  const home = tmpDir();
  const env = { FTH_GATE_LOG: path.join(home, 'gate.jsonl') };
  const now = Date.now();
  const at = s => new Date(now + s * 1000).toISOString();
  const allowed = s => JSON.stringify({ ts: at(s), source: 'gateway', tool: 'place_order', decision: 'allowed', cycle: 'c1', violations: [] });
  const blocked = (s, check, source = 'gateway') => JSON.stringify({ ts: at(s), source, tool: 'place_order', decision: 'blocked', cycle: 'c1', violations: [{ check, message: 'no' }] });
  const read = lines => { fs.writeFileSync(env.FTH_GATE_LOG, `${lines.join('\n')}\n`); return E.gateDecision(env, 'c1', now - 1000); };
  assert.deepStrictEqual(read([allowed(1), blocked(2, 'exposure', 'hook')]), { decision: 'allowed', ts: at(1), checks: [], message: '', refusedAfter: { checks: ['exposure'], message: '[exposure] no' } });
  assert.deepStrictEqual(read([blocked(1, 'plan-required'), allowed(2)]), { decision: 'allowed', ts: at(2), checks: [], message: '', refusedAfter: null });
  assert.deepStrictEqual([read([allowed(1), allowed(3)]).ts], [at(1)], 'the order\'s moment: the first that went');
  assert.deepStrictEqual(read([blocked(1, 'plan-required'), blocked(2, 'exposure')]), { decision: 'blocked', ts: at(2), checks: ['exposure'], message: '[exposure] no', refusedAfter: null });
  assert.strictEqual(read(['']), null);
  // gateRefusal stays the last decision's refusal.
  read([allowed(1), blocked(2, 'exposure')]);
  assert.deepStrictEqual(E.gateRefusal(env, 'c1', now - 1000), { checks: ['exposure'], message: '[exposure] no' });
});

test('runEntry: each role run in the entry record carries its own skills record (phase 2\'s and the executor\'s), never the head trader\'s loads', async () => {
  const rec = (role, missing) => ({ expected: [`${role}-skill`], embedded: [], loaded: [], had: [], missing });
  const s = setup({
    roles: {
      phase2: { ok: true, timedOut: false, text: P2, tools: ['harness_order_plan'], lookups: [], output: '', skills: rec('rm', ['position-sizing']) },
      'trade-executor': { ok: true, timedOut: false, text: 'EXECUTED\nOrders: 1', tools: ['broker_place_order'], lookups: [], output: '', skills: rec('ex', []) },
    },
  });
  const r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual(r.entry.ran.map(x => [x.role, x.skills && x.skills.missing]), [['risk-manager', ['position-sizing']], ['trade-executor', []]]);
  // The head trader's load (trade-lifecycle, in its cycle output) is in no role's record.
  assert.ok(r.entry.ran.every(x => !x.skills.loaded.includes('trade-lifecycle')));
  const { withSkillsMissing } = require('../../scripts/lib/role-skills-record');
  assert.deepStrictEqual(withSkillsMissing(r.entry.ran), { skillsMissing: { 'risk-manager': ['position-sizing'] } });
});

test('runEntry: the hook refused the executor\'s place_order and it reported nothing: blocked with the gate\'s refusal, never "trade-executor invalid"', async () => {
  const s = setup({ roles: { 'trade-executor': { ok: true, timedOut: false, text: '', tools: [], output: '' } }, state: { positions: [], orders: [] } });
  const id = require('../../scripts/lib/trading/check-order').cycleId(s.cycle().headEnv);
  const hookLine = (tool, cycle = id) => JSON.stringify({ ts: new Date(Date.now() + 5000).toISOString(), source: 'hook', tool, decision: 'blocked', cycle, violations: [{ check: 'plan-required', message: 'No plan' }], contractId: 'MNQ', rationale: ARGS.rationale });
  // A refused modify_order with the entry's contract and rationale is never the entry's refusal.
  fs.writeFileSync(s.deps.env.FTH_GATE_LOG, `${hookLine('modify_order')}\n`);
  let r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, r.result], ['no-trade', 'CYCLE RESULT: no-trade - the runner\'s entry: the trade-executor invalid (no order call and no refusal reported): no order']);
  const t = setup({ roles: { 'trade-executor': { ok: true, timedOut: false, text: '', tools: [], output: '' } }, state: { positions: [], orders: [] } });
  const tid = require('../../scripts/lib/trading/check-order').cycleId(t.cycle().headEnv);
  fs.writeFileSync(t.deps.env.FTH_GATE_LOG, `${hookLine('place_order', tid)}\n`);
  r = await E.runEntry(t.deps, t.cycle());
  assert.deepStrictEqual([r.entry.outcome, r.result], ['blocked', 'CYCLE RESULT: blocked - the order gate refused the trade_lifecycle long 1 MNQ: [plan-required] No plan']);
});

test('runEntry: a refused retry never hides the order that went: allowed then blocked is the order\'s outcome, the retry\'s refusal logged; blocked then allowed the order\'s; blocked only blocked', async () => {
  const lost = { ok: true, timedOut: false, text: 'BLOCKED\nthe retry was refused', tools: [], output: '' };
  const run = async (decisions, roles = { 'trade-executor': lost }) => {
    const s = setup({ roles, state: { positions: [], orders: [] } });
    const id = require('../../scripts/lib/trading/check-order').cycleId(s.cycle().headEnv);
    fs.writeFileSync(s.deps.env.FTH_GATE_LOG, `${decisions.map((d, i) => JSON.stringify({ ts: new Date(Date.now() + 5000 + i * 1000).toISOString(), source: i ? 'hook' : 'gateway', tool: 'place_order', decision: d, cycle: id, violations: d === 'blocked' ? [{ check: 'exposure', message: 'One entry at a time' }] : [] })).join('\n')}\n`);
    const r = await E.runEntry(s.deps, s.cycle());
    return { r, logs: s.logs };
  };
  // Its reply never came, its retry refused: unknown (executed, possibly placed), never blocked.
  let { r, logs } = await run(['allowed', 'blocked']);
  assert.strictEqual(r.entry.outcome, 'unknown');
  assert.match(r.result, /^CYCLE RESULT: executed - trade_lifecycle long 1 MNQ: unknown/);
  assert.ok(logs.some(l => /^error the entry: a later place_order of the cycle \(a retry\) was refused by the order gate after the order went: \[exposure\] One entry at a time$/.test(l)), logs.join('\n'));
  // Its call completed, its retry refused, the executor says BLOCKED: the order went (the broker's to answer), not the gate's refusal.
  ({ r } = await run(['allowed', 'blocked'], { 'trade-executor': { ...lost, tools: ['broker_place_order'] } }));
  assert.deepStrictEqual([r.entry.outcome, /was refused by the broker: the order went/.test(r.result)], ['blocked', true]);
  ({ r } = await run(['blocked', 'allowed']));
  assert.strictEqual(r.entry.outcome, 'unknown');
  ({ r } = await run(['blocked']));
  assert.deepStrictEqual([r.entry.outcome, r.result], ['blocked', 'CYCLE RESULT: blocked - the order gate refused the trade_lifecycle long 1 MNQ: [exposure] One entry at a time']);
  // The account shows the position: executed, whatever the log says.
  const s = setup();
  const id = require('../../scripts/lib/trading/check-order').cycleId(s.cycle().headEnv);
  fs.writeFileSync(s.deps.env.FTH_GATE_LOG, `${JSON.stringify({ ts: new Date(Date.now() + 5000).toISOString(), source: 'hook', tool: 'place_order', decision: 'blocked', cycle: id, violations: [{ check: 'exposure', message: 'x' }] })}\n`);
  assert.strictEqual((await E.runEntry(s.deps, s.cycle())).entry.outcome, 'executed');
});

test('workingEntry: the account\'s working order on the entry\'s own contract (root, and month when both name one), side and type, open or pending; another contract of the family, a protective leg, a stop, a filled or cancelled order is not it', () => {
  const mine = { id: 41, contractId: 'MNQ', side: 0, type: 1, status: 1, limitPrice: 21500 };
  assert.strictEqual(E.workingEntry([mine], ARGS), mine);
  const named = { id: 42, contractId: 'MNQ', side: 'buy', type: 'limit', status: 'pending' };
  assert.strictEqual(E.workingEntry([named], ARGS), named, 'the codes\' names too');
  assert.strictEqual(E.workingEntry([{ ...mine, status: undefined }], ARGS).id, 41, 'no status stated: listed open orders are working');
  for (const [other, why] of [
    [{ ...mine, contractId: 'NQ' }, 'the mini of the family'], [{ ...mine, contractId: 'MES' }, 'another root'],
    [{ ...mine, side: 1 }, 'the other side (a target of a long)'], [{ ...mine, type: 4, stopPrice: 21490 }, 'a stop (a protective stop of a short)'],
    [{ ...mine, status: 2 }, 'filled'], [{ ...mine, status: 3 }, 'cancelled'], [null, 'junk'],
  ]) assert.strictEqual(E.workingEntry([other], ARGS), null, why);
  const dated = { ...ARGS, contractId: 'MNQ:2026-12' };
  assert.strictEqual(E.workingEntry([{ ...mine, contractId: 'MNQ:2027-03' }], dated), null, 'another month');
  assert.strictEqual(E.workingEntry([{ ...mine, contractId: 'MNQ:2026-12' }], dated).id, 41);
  assert.strictEqual(E.workingEntry([mine], dated).id, 41, 'a month named on one side only: the root decides');
  assert.strictEqual(E.workingEntry('x', ARGS), null);
});

test('runEntry: the order went: a working entry order on the account is executed (working, unfilled); one on another contract is not counted; an unreadable account is unknown; a readable empty account is the broker\'s refusal', async () => {
  const went = { ok: true, timedOut: false, text: 'EXECUTED\nOrders: 1', tools: ['broker_place_order'], lookups: [], output: '' };
  const run = async o => {
    const s = setup({ roles: { 'trade-executor': went }, ...o });
    const id = require('../../scripts/lib/trading/check-order').cycleId(s.cycle().headEnv);
    fs.writeFileSync(s.deps.env.FTH_GATE_LOG, `${JSON.stringify({ ts: new Date(Date.now() + 5000).toISOString(), source: 'gateway', tool: 'place_order', decision: 'allowed', cycle: id, violations: [] })}\n`);
    return E.runEntry(s.deps, s.cycle());
  };
  const resting = { id: 41, contractId: 'MNQ', side: 0, type: 1, status: 1, limitPrice: 21500 };
  let r = await run({ state: { positions: [], orders: [resting] } });
  assert.deepStrictEqual([r.entry.outcome, r.result], ['executed', 'CYCLE RESULT: executed - trade_lifecycle long 1 MNQ (the runner\'s entry: phase 2 approved, the order is working, unfilled: order 41, limit 21500)']);
  r = await run({ state: { positions: [], orders: [{ ...resting, contractId: 'NQ' }, { ...resting, id: 9, side: 1, type: 4, stopPrice: 21600 }] } });
  assert.strictEqual(r.entry.outcome, 'blocked');
  assert.match(r.result, /was refused by the broker: the order went and the account shows no position or entry/);
  r = await run({ readFails: true });
  assert.deepStrictEqual([r.entry.outcome, r.result], ['unknown', 'CYCLE RESULT: executed - trade_lifecycle long 1 MNQ: unknown, the order\'s outcome couldn\'t be read (the order went and the account can\'t be read after it): treat it as possibly placed']);
  // No account to read (no account id): unread too.
  const s = setup({ roles: { 'trade-executor': went } });
  const sid = require('../../scripts/lib/trading/check-order').cycleId(s.cycle().headEnv);
  fs.writeFileSync(s.deps.env.FTH_GATE_LOG, `${JSON.stringify({ ts: new Date(Date.now() + 5000).toISOString(), source: 'gateway', tool: 'place_order', decision: 'allowed', cycle: sid, violations: [] })}\n`);
  assert.strictEqual((await E.runEntry(s.deps, s.cycle({ accountId: null }))).entry.outcome, 'unknown');
  r = await run({ state: { positions: [], orders: [] } });
  assert.deepStrictEqual([r.entry.outcome, r.result], ['blocked', 'CYCLE RESULT: blocked - the trade_lifecycle long 1 MNQ was refused by the broker: the order went and the account shows no position or entry (the executor\'s report: EXECUTED Orders: 1)']);
  // A filled entry is filled, whatever rests beside it.
  r = await run({ state: { positions: [{ contractId: 'MNQ', type: 1, size: 1 }], orders: [resting] } });
  assert.match(r.result, /the order filled\)$/);
});

test('workingEntry: codes sent as digit strings are codes', () => {
  const o = { id: 43, contractId: 'MNQ', side: '0', type: '1', status: '1', limitPrice: 21500 };
  assert.strictEqual(E.workingEntry([o], ARGS), o);
  assert.strictEqual(E.workingEntry([{ ...o, side: '1' }], ARGS), null);
  assert.strictEqual(E.workingEntry([{ ...o, status: '3' }], ARGS), null);
});

test('entryOutcome and runEntry: the order went and the account can\'t be read: unknown whatever the executor says (ABORTED too); a gate refusal with nothing allowed is still blocked', async () => {
  const label = 'trade_lifecycle long 1 MNQ';
  const o = E.entryOutcome({ entered: false, allowed: true, sent: true, unread: true, report: 'ABORTED\nUnknownError: no answer', label });
  assert.deepStrictEqual([o.outcome, /couldn't be read \(the order went and the account can't be read after it\)/.test(o.result)], ['unknown', true]);
  assert.strictEqual(E.entryOutcome({ entered: false, refusal: { checks: ['x'], message: '[x] no' }, unread: true, label }).outcome, 'blocked');
  assert.strictEqual(E.entryOutcome({ entered: false, unread: true, report: 'ABORTED\nOrderRejected', label }).outcome, 'aborted', 'no order went: the executor\'s own abort');
  const s = setup({ roles: { 'trade-executor': { ok: true, timedOut: false, text: 'ABORTED\nUnknownError: no answer', tools: ['broker_place_order'], output: '' } }, readFails: true });
  const id = require('../../scripts/lib/trading/check-order').cycleId(s.cycle().headEnv);
  fs.writeFileSync(s.deps.env.FTH_GATE_LOG, `${JSON.stringify({ ts: new Date(Date.now() + 5000).toISOString(), source: 'gateway', tool: 'place_order', decision: 'allowed', cycle: id, violations: [] })}\n`);
  const r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, /^CYCLE RESULT: executed - .*: unknown/.test(r.result)], ['unknown', true]);
});

test('gateDecision and runEntry: the gateway\'s allowed record and its order tracker\'s refusal of the same call are one refusal (nothing sent): blocked, no order time, no retry logged; a real retry refusal still leaves the order', async () => {
  const s = setup({ roles: { 'trade-executor': { ok: true, timedOut: false, text: 'BLOCKED\nthe gateway refused it', tools: [], output: '' } }, state: { positions: [], orders: [] } });
  const id = require('../../scripts/lib/trading/check-order').cycleId(s.cycle().headEnv);
  const t0 = Date.now() + 5000;
  const rec = (ms, o) => JSON.stringify({ ts: new Date(ms).toISOString(), source: 'gateway', tool: 'place_order', cycle: id, contractId: 'MNQ', rationale: ARGS.rationale, ...o });
  const tracker = { decision: 'blocked', violations: [{ check: 'order-pending', message: 'customTag fth-1 is in use by an order of unknown outcome' }] };
  fs.writeFileSync(s.deps.env.FTH_GATE_LOG, `${[rec(t0, { decision: 'allowed', violations: [] }), rec(t0 + 200, tracker)].join('\n')}\n`);
  assert.deepStrictEqual(E.gateDecision(s.deps.env, id, 0).checks, ['order-pending']);
  const r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, r.entry.timing.orderMs], ['blocked', null]);
  assert.match(r.result, /^CYCLE RESULT: blocked - the order gate refused the .*\[order-pending\]/);
  assert.ok(!s.logs.some(l => /a later place_order of the cycle \(a retry\)/.test(l)), s.logs.join('\n'));
  // The same contract and rationale, refused by another check: a retry; the order that went stands.
  fs.writeFileSync(s.deps.env.FTH_GATE_LOG, `${[rec(t0, { decision: 'allowed', violations: [] }), rec(t0 + 200, { decision: 'blocked', violations: [{ check: 'exposure', message: 'One entry at a time' }] })].join('\n')}\n`);
  const d = E.gateDecision(s.deps.env, id, 0);
  assert.deepStrictEqual([d.decision, d.refusedAfter.checks], ['allowed', ['exposure']]);
});

test('runEntry: a place_order call made with no gate decision of it and no reply is unknown (possibly placed); no call at all stays a no-trade', async () => {
  const call = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p1', name: 'mcp__broker__place_order', input: ARGS }] } });
  const s = setup({ roles: { 'trade-executor': { ok: true, timedOut: false, text: 'ABORTED\nno reply', tools: [], output: call } }, state: { positions: [], orders: [] } });
  const r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, /a place_order call was made, its reply never came and the gate log has no decision of it/.test(r.result)], ['unknown', true]);
  const t = setup({ roles: { 'trade-executor': { ok: true, timedOut: false, text: 'ABORTED\nno reply', tools: [], output: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'none' }] } }) } }, state: { positions: [], orders: [] } });
  const tr = await E.runEntry(t.deps, t.cycle());
  assert.deepStrictEqual([tr.entry.outcome, /^CYCLE RESULT: no-trade - the trade-executor aborted /.test(tr.result)], ['aborted', true], 'no call: the executor\'s own abort, a no-trade');
  // A call its harness stopped itself (opencode: an unavailable tool) never reached a tool: no call.
  const stopped = JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'broker_place_order', state: { status: 'error', input: ARGS, error: 'Model tried to call unavailable tool broker_place_order' } } });
  const v = setup({ roles: { 'trade-executor': { ok: true, timedOut: false, text: '', tools: [], output: stopped } }, state: { positions: [], orders: [] } });
  assert.strictEqual((await E.runEntry(v.deps, v.cycle())).entry.outcome, 'no-trade', 'a stopped call: no-trade');
  const u = setup({ roles: { 'trade-executor': { ok: true, timedOut: false, text: '', tools: [], output: '' } }, state: { positions: [], orders: [] } });
  assert.strictEqual((await E.runEntry(u.deps, u.cycle())).entry.outcome, 'no-trade', 'no call, no report: no-trade');
});

test('entryOutcome: a refusal passed with an allowed order is never the outcome; a BLOCKED report after an allowed order is a retry\'s', () => {
  const label = 'trade_lifecycle long 1 MNQ';
  assert.strictEqual(E.entryOutcome({ entered: false, refusal: { checks: ['x'], message: '[x] no' }, allowed: true, sent: false, label }).outcome, 'unknown');
  assert.match(E.entryOutcome({ entered: false, allowed: true, sent: true, report: 'BLOCKED\nretry', label }).result, /was refused by the broker: the order went/);
  assert.match(E.entryOutcome({ entered: false, allowed: false, sent: false, report: 'BLOCKED\nx', label }).result, /was blocked: BLOCKED x$/);
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

test('runEntry: an APPROVE line the gate\'s reading takes as a veto stops as vetoed, with the reading\'s reason (never the APPROVE line as a veto); a genuine VETO is unchanged; phase 2\'s report is kept in the entry record', async () => {
  const misread = 'Phase 2.\nDecision: cut to size 1\nVERDICT: APPROVE - size 1, risk $20.00\nFACTS: window opening drive; trend long allowed';
  let built = false;
  let s = setup({ roles: { phase2: { ok: true, timedOut: false, text: misread, tools: ['harness_order_plan'], lookups: [], output: '' } }, plan: () => { built = true; return null; } });
  let r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([s.calls.map(c => c.role), built, s.journal], [['phase2'], false, []]);
  assert.strictEqual(r.entry.outcome, 'vetoed', 'learning counts the same outcome');
  assert.strictEqual(r.entry.why, 'phase 2\'s report reads as a veto: a decision line decides cut, not APPROVE ("Decision: cut to size 1")');
  assert.strictEqual(r.result, 'CYCLE RESULT: no-trade - risk-manager phase 2\'s report reads as a veto (a decision line decides cut, not APPROVE): VERDICT: APPROVE - size 1, risk $20.00');
  assert.deepStrictEqual(r.entry.phase2, { chars: misread.length, text: misread });
  assert.ok(s.logs.some(l => l === 'error the entry: phase 2\'s report reads as a veto: a decision line decides cut, not APPROVE ("Decision: cut to size 1"): no order'), s.logs.join('\n'));
  // The VERDICT line is the approving one, though a looser verdict line comes first.
  s = setup({ roles: { phase2: { ok: true, timedOut: false, text: `Sizing verdict: skip x0.5\n${P2}`, tools: ['harness_order_plan'], lookups: [], output: '' } } });
  r = await E.runEntry(s.deps, s.cycle());
  assert.strictEqual(r.result, 'CYCLE RESULT: no-trade - risk-manager phase 2\'s report reads as a veto (a verdict line decides skip, not APPROVE): VERDICT: APPROVE - size 1, risk $20.00');
  // A genuine VETO: its line, as before; its report kept too.
  const veto = 'Phase 2.\nVERDICT: VETO - room: stand aside\nFACTS: window asia; trend long allowed';
  s = setup({ roles: { phase2: { ok: true, timedOut: false, text: veto, tools: ['harness_order_plan'], lookups: [], output: '' } } });
  r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, r.entry.why, r.result], ['vetoed', 'VERDICT: VETO - room: stand aside', 'CYCLE RESULT: no-trade - risk-manager vetoed the trade_lifecycle long 1 MNQ: VERDICT: VETO - room: stand aside']);
  assert.deepStrictEqual(r.entry.phase2, { chars: veto.length, text: veto });
  assert.ok(!s.logs.some(l => /reads as a veto/.test(l)));
  // An approval: its report kept; over the limit (config/runner.json prompt.reportMaxText), cut and marked.
  s = setup();
  r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, r.entry.phase2], ['executed', { chars: P2.length, text: P2 }]);
  const max = require('../../scripts/lib/tunables').runner().prompt.reportMaxText;
  const long = `${'x'.repeat(max)}\n${P2}`;
  s = setup({ roles: { phase2: { ok: true, timedOut: false, text: long, tools: ['harness_order_plan'], lookups: [], output: '' } } });
  r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.phase2.chars, r.entry.phase2.text.length, r.entry.phase2.cut], [long.length, max, true]);
});

test('runEntry: the trade-executor gets the decisive VERDICT line phase 2 approved on, never a markdown heading naming a verdict (the live smoke: "## Phase 2 verdict: MNQ long ..." handed over, the approved trade lost)', async () => {
  const p2 = text => ({ roles: { phase2: { ok: true, timedOut: false, text, tools: ['harness_order_plan'], lookups: [], output: '' } } });
  const FACTS = 'FACTS: window opening drive; trend long allowed';
  const HEAD = '## Phase 2 verdict: MNQ long, 3m bar closed 11:00 ET (15:00 UTC)';
  const APPROVE = 'VERDICT: APPROVE - size 5, risk $100';
  for (const [label, text] of [
    ['the heading first', `${HEAD}\n\nThe plan checks out.\n${APPROVE}\n${FACTS}`],
    ['the heading after the line', `${APPROVE}\n${HEAD}\n${FACTS}`],
    ['two headings', `${HEAD}\n## Verdict check: plan vs briefing\n${APPROVE}\n${FACTS}`],
  ]) {
    const s = setup(p2(text));
    const r = await E.runEntry(s.deps, s.cycle());
    assert.deepStrictEqual(s.calls.map(c => c.role), ['phase2', 'trade-executor'], label);
    assert.strictEqual(r.entry.outcome, 'executed', label);
    assert.ok(s.calls[1].request.includes(`The risk manager's line: ${APPROVE}.`), `${label}: ${s.calls[1].request}`);
    assert.ok(!s.calls[1].request.includes('## '), `${label}: no heading handed over`);
    assert.strictEqual(E.verdictLine(text), APPROVE, label);
  }
});

test('runEntry: phase 2\'s approved size sets the order: exactly the smaller of it and the record\'s (a cut built by order_plan); no readable size, or order_plan over it, no order', async () => {
  const p2 = text => ({ roles: { phase2: { ok: true, timedOut: false, text, tools: ['harness_order_plan'], lookups: [], output: '' } } });
  const FACTS = 'FACTS: window opening drive; trend long allowed';
  // Equal: the record's size, the journal saying why.
  let s = setup();
  let r = await E.runEntry(s.deps, s.cycle());
  assert.strictEqual(r.entry.outcome, 'executed');
  assert.deepStrictEqual(r.entry.size, { approved: 1, record: 1, ordered: 1 });
  assert.match(s.journal[0].text, /risk \$20; size 1: phase 2 approved the record's 1; compose record/);
  assert.strictEqual(JSON.parse(/built by the runner from this bar's compose record: (\{.*\})\. Send them as given/.exec(s.calls[1].request)[1]).size, 1);
  // More than the record's: capped at it (phase 2 never adds risk).
  s = setup(p2(`VERDICT: APPROVE - size 3, risk $60\n${FACTS}`));
  r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, r.entry.size], ['executed', { approved: 3, record: 1, ordered: 1 }]);
  assert.match(s.journal[0].text, /size 1: phase 2 approved 3, capped at the record's 1;/);
  assert.strictEqual(JSON.parse(/built by the runner from this bar's compose record: (\{.*\})\. Send them as given/.exec(s.calls[1].request)[1]).size, 1);
  // Under the record's (record 8, phase 2 at 1): order_plan is asked for the cut, and the order is exactly 1, its risk
  // and the journal plan for 1, the executor sent those arguments.
  const asked = [];
  const cutPlan = a => {
    asked.push(a.size);
    const n = a.size || 8;
    return { args: { ...ARGS, size: n }, plan: { strategy: 'trade_lifecycle', side: 'long', contract: 'MNQ', size: n, ...(n < 8 ? { recordSize: 8 } : {}), entry: 21500, stopPrice: 21490, stopTicks: 40, targetPrice: 21520, targetTicks: 80, riskUsd: 20 * n, record: 'rec0000000000001' } };
  };
  s = setup({ ...p2(`Size: 1 (record 8 cut to 1: no reviewed trades yet)\nVERDICT: APPROVE - size 1, risk $20\n${FACTS}`), records: [record({ plan: { ...PLAN, size: 8 } })], plan: cutPlan });
  r = await E.runEntry(s.deps, s.cycle({ result: 'CYCLE RESULT: planned - trade_lifecycle long 8' }));
  assert.deepStrictEqual([asked, r.entry.outcome, r.entry.size], [[1], 'executed', { approved: 1, record: 8, ordered: 1 }]);
  assert.match(r.result, /^CYCLE RESULT: executed - trade_lifecycle long 1 MNQ \(phase 2 cut the record's 8\) \(the runner's entry: phase 2 approved/);
  assert.match(s.journal[0].text, /long 1 MNQ: limit 21500, stop 21490, target 21520, risk \$20; size 1: phase 2 cut the record's 8;/);
  assert.strictEqual(JSON.parse(/built by the runner from this bar's compose record: (\{.*\})\. Send them as given/.exec(s.calls[1].request)[1]).size, 1);
  // Phase 2 at or over the record's: no cut asked for.
  asked.length = 0;
  s = setup({ ...p2(`VERDICT: APPROVE - size 9, risk $180\n${FACTS}`), records: [record({ plan: { ...PLAN, size: 8 } })], plan: cutPlan });
  r = await E.runEntry(s.deps, s.cycle({ result: 'CYCLE RESULT: planned - trade_lifecycle long 8' }));
  assert.deepStrictEqual([asked, r.entry.size], [[undefined], { approved: 9, record: 8, ordered: 8 }]);
  assert.match(r.result, /^CYCLE RESULT: executed - trade_lifecycle long 8 MNQ \(the runner's entry/);
  // order_plan giving more than phase 2 approved (it ignored the cut): no order, never sent (fails closed).
  s = setup({ ...p2(`VERDICT: APPROVE - size 1, risk $20\n${FACTS}`), records: [record({ plan: { ...PLAN, size: 8 } })], plan: () => cutPlan({}) });
  r = await E.runEntry(s.deps, s.cycle({ result: 'CYCLE RESULT: planned - trade_lifecycle long 8' }));
  assert.deepStrictEqual([r.entry.outcome, s.calls.map(c => c.role), s.journal, r.entry.size], ['no-trade', ['phase2'], [], { approved: 1, record: 8, ordered: null }]);
  assert.match(r.result, /order_plan's size 8 is over the 1 risk-manager phase 2 approved/);
  // The Size line's smaller size binds too.
  s = setup(p2(`Size: 0 (none)\nVERDICT: APPROVE - size 1, risk $20\n${FACTS}`));
  r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, s.calls.length], ['no-trade', 1]);
  // No readable size on the approval: no order built, no executor.
  for (const v of ['VERDICT: APPROVE - risk $20', 'VERDICT: APPROVE - size 0, risk $0', 'VERDICT: APPROVE - size 1.5', 'VERDICT: APPROVE - size <n>']) {
    let built = false;
    s = setup({ ...p2(`${v}\n${FACTS}`), plan: () => { built = true; return null; } });
    r = await E.runEntry(s.deps, s.cycle());
    assert.deepStrictEqual([r.entry.outcome, built, s.calls.length], ['no-trade', false, 1], v);
    assert.match(r.result, /risk-manager phase 2 approved without a size the runner can read \(no whole size of 1 or more in /, v);
  }
});

test('runEntry in a prop attempt: the record suggests 1, the order is the translated size; phase 2\'s cut to 3 is 3; a cut under the floor (min_contracts) is no trade, nothing sent', async () => {
  // order_plan's own composed path (lifecycle-order.js composedOrder) on a prop attempt whose policy has a floor of 3:
  // the record suggests 1; the translation (prop/size-translate.js) is 5 (the $300 cap at 111 ticks, $55.50 a contract).
  const P = require('../fixtures/lifecycle-prop');
  const LC = require('../fixtures/lifecycle');
  const { composedOrder } = require('../../scripts/lib/trading/lifecycle-order');
  const strategies = P.registry({ sizing: require('../helpers').testSizing({ min_contracts: 3 }) });
  const real = () => {
    const { home } = P.propHome({ size: 1 });
    return a => composedOrder({ home, root: 'MNQ', side: 'long', now: P.NOW, cycleBars: { MNQ: LC.BAR }, strategy: P.LC_DOC, strategies, accounts: [P.MINI], specOf: () => ({ tickSize: 0.25, tickValue: 0.5 }), accountId: 7, selected: ['MNQ'], size: a.size ?? null, approved: a.approved ?? null });
  };
  const FACTS = 'FACTS: window opening drive; trend long allowed';
  const p2 = text => ({ ok: true, timedOut: false, text, tools: ['harness_order_plan'], lookups: [], output: '' });
  // The runner's home runs the attempt too: the runner reads the translated size before phase 2 (order_plan's path).
  const run = async (verdict, before = '') => {
    const s = setup({ roles: { phase2: typeof verdict === 'function' ? (request => p2(`${before}VERDICT: ${verdict(request)}\n${FACTS}`)) : p2(`${before}VERDICT: ${verdict}\n${FACTS}`) }, records: [record({ plan: { ...PLAN, size: 1 } })], plan: real(), market: 21540.25 });
    require('../../scripts/lib/trading/prop-state').startAttempt(s.home, P.MINI);
    const r = await E.runEntry(s.deps, s.cycle({ result: 'CYCLE RESULT: planned - trade_lifecycle long 1' }));
    return { s, r };
  };
  // Phase 2's request names the translated 5 as the size to approve; phase 2 approving the size its request names: 5.
  let { s, r } = await run(request => `APPROVE - size ${/The entry's size is (\d+) MNQ/.exec(request)[1]}, risk $277.50`);
  assert.match(s.calls[0].request, /The entry's size is 5 MNQ: code's translation of the record's suggested 1 under the account rulebook \(the rulebook's size at this stop: 5 MNQ \(risk.max_risk_usd \$300.00 at \$56.74 a contract all in\)\)\. Approve that size \(your VERDICT line's size 5\), or cut it, never under 3 MNQ \(a cut below it is 3, never a veto\); the record's size is a suggestion, never the one to approve\. State only the final size \(already floored\) on your VERDICT and Size lines; never write the number before the floor or the cut arithmetic: every size on them binds\./);
  assert.deepStrictEqual([r.entry.outcome, r.entry.size], ['executed', { suggested: 1, translated: 5, approved: 5, record: 5, ordered: 5 }]);
  assert.strictEqual(JSON.parse(/built by the runner from this bar's compose record: (\{.*\})\. Send them as given/.exec(s.calls[1].request)[1]).size, 5);
  assert.match(s.journal[0].text, /size 5: phase 2 approved the translated 5 \(the record suggested 1\)/);
  assert.match(r.result, /^CYCLE RESULT: executed - trade_lifecycle long 5 MNQ \(the runner's entry/);
  // Phase 2's cut to 3: exactly 3.
  ({ r } = await run('APPROVE - size 3, risk $166.50', 'Size: 3 (cut to 3)\n'));
  assert.deepStrictEqual([r.entry.outcome, r.entry.size], ['executed', { suggested: 1, translated: 5, approved: 3, record: 5, ordered: 3 }]);
  assert.match(r.result, /^CYCLE RESULT: executed - trade_lifecycle long 3 MNQ \(phase 2 cut the translated 5\)/);
  // A cut to 2, or phase 2 echoing the record's 1 although its request named 5: a cut under the floor, no trade,
  // nothing sent or journaled.
  for (const n of [2, 1]) {
    ({ s, r } = await run(`APPROVE - size ${n}, risk $${(55.5 * n).toFixed(2)}`));
    assert.strictEqual(r.entry.outcome, 'no-trade', String(n));
    assert.match(r.result, new RegExp(`order_plan refused the composed plan: \\[min-contracts\\] setup:prop_portfolio: size ${n} MNQ is under the floor of 3 contracts`));
    assert.deepStrictEqual(s.calls.map(c => c.role), ['phase2'], 'no trade-executor run: nothing sent');
    assert.deepStrictEqual(s.journal, [], 'no plan journaled');
  }
});

test('runEntry: the live smoke\'s long (entry 13853.00, stop 13838.75) with the market at 13840.75 (86% of the risk toward the stop) is skipped late, never sent; the skip is logged with the plan\'s prices and the price', async () => {
  const plan = { strategy: 'trade_lifecycle', side: 'long', contract: 'MNQ', size: 1, entry: 13853, stopPrice: 13838.75, stopTicks: 57, targetPrice: 13895.5, targetTicks: 170, riskUsd: 28.5, record: 'rec0000000000001' };
  const s = setup({ plan: () => ({ args: { ...ARGS, limitPrice: 13853, stopLossBracket: { ticks: 57, type: 'stop' }, takeProfitBracket: { ticks: 170, type: 'limit' } }, plan }), market: 13840.75 });
  const r = await E.runEntry(s.deps, s.cycle());
  assert.strictEqual(r.entry.outcome, 'late');
  assert.match(r.result, /missed the plan's entry 13853 \(price 13840\.75 is 12\.25 points past it against the long: 86% of the 14\.25-point risk toward the stop, over 0\.25R/);
  assert.deepStrictEqual(s.calls.map(c => c.role), ['phase2'], 'no trade-executor: nothing sent');
  const { at, ...late } = r.entry.late;
  assert.deepStrictEqual(late, { side: 'long', entry: 13853, stop: 13838.75, target: 13895.5, share: 0.25, kind: 'missed-entry', price: 13840.75, closedAt: '2026-10-07T13:57:00.000Z', source: 'runner-entry', movedR: 0.86, root: 'MNQ', record: 'rec0000000000001' });
  assert.ok(Number.isFinite(Date.parse(at)));
  // The mirror short (entry 13853.00, stop 13867.25, the market at 13865.25): skipped the same way.
  const short = { ...plan, side: 'short', stopPrice: 13867.25, targetPrice: 13810.5 };
  const s2 = setup({ records: [record({ side: 'short' })], plan: () => ({ args: { ...ARGS, side: 'sell', limitPrice: 13853 }, plan: short }), market: 13865.25 });
  const r2 = await E.runEntry(s2.deps, s2.cycle({ result: 'CYCLE RESULT: planned - trade_lifecycle short 1' }));
  assert.deepStrictEqual([r2.entry.outcome, r2.entry.late.movedR], ['late', 0.86]);
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
  // It reports the broker's refusal of the order it sent (its place_order call completed): blocked, the broker's refusal.
  s = setup({ roles: { 'trade-executor': { ok: true, timedOut: false, text: 'ABORTED\nOrderRejected', tools: ['broker_place_order'], output: '' } }, state: flat });
  r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, s.calls.length, /was refused by the broker: ABORTED OrderRejected/.test(r.result)], ['blocked', 2, true], r.result);
  // The same report with no order call in its run and none in the gate log: the executor's own abort, a no-trade.
  s = setup({ roles: { 'trade-executor': { ok: true, timedOut: false, text: 'ABORTED\nOrderRejected', tools: [], output: '' } }, state: flat });
  r = await E.runEntry(s.deps, s.cycle());
  assert.deepStrictEqual([r.entry.outcome, s.calls.length], ['aborted', 2]);
  assert.match(r.result, /^CYCLE RESULT: no-trade - the trade-executor aborted the .* with no order sent/);
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
