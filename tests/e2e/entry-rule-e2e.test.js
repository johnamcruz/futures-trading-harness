'use strict';

/**
 * The owner's top-down bias end to end (2026-10-29: "Don't counter trade against the prevailing trend"; "No trade if
 * there is no agreement between the two"): in a running prop attempt on the shipped prop_portfolio and its account's
 * rulebook (bias_frames [4h, 1h], bias_agree on), the real runner, compose_check, the real gateway and gate and the hook.
 *
 * The decision-path world's fired bar (tests/fixtures/decision-path.js) has the 4h up and the 1h ranging: no agreement.
 *   - The head trader composes the long and says planned: compose_check says NOT OK naming the rule, the runner's entry
 *     never sends it; the same order sent directly through the gateway is refused, and the hook refuses it on its own;
 *     an exit at the same moment goes (the hook).
 *   - Agreeing: the parity bars hold no bar whose 1h trends, so the agreeing long runs on a copy of the shipped policy
 *     and account whose rulebook lists only the 4h (bias_agree on: every listed frame must trend the side's way, the
 *     same check): the runner's entry places it at the broker, and its exits go through the gateway a bar later.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const exchange = require('../fixtures/mock-exchange');
const D = require('../fixtures/decision-path');
const { scriptedModel } = require('../fixtures/scripted-model');
const { runRole: realRunRole } = require('../../scripts/lib/cycle-run');
const prop = require('../../scripts/lib/trading/prop-state');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { loadAccounts } = require('../../scripts/lib/trading/accounts');
const TL = require('../../scripts/lib/trading/trade-lifecycle');
const { policyCopy } = require('../helpers');

const { FIRED_BAR, NEXT_BAR, decisionAt } = D;
const POLICY = loadStrategies(D.ROOT, {}).strategies.find(s => s.name === 'prop_portfolio');
const NO = /entry rule: the 4h and 1h must each trend up for a long \(4h up, 1h range\): no agreement, no trade/;

const READS = [
  { step: 'bias', skill: 'multi-timeframe-analysis', read: '4h up', why: 'the 4h trend is up' },
  { step: 'location', skill: 'vwap-volume-profile', read: 'value above', why: 'above the prior value area' },
  { step: 'bias', skill: 'htf-to-ltf', read: 'trend long allowed', why: 'the trend rule takes the long' },
  { step: 'setup', skill: 'rejection', read: '15m rejected prior VAH up', why: 'the 15m dipped under the prior VAH and closed back above' },
  { step: 'entry', skill: 'candle-reading', read: '3m close top', why: 'the 3m bar closed at its high' },
  { step: 'stop', skill: 'invalidation', read: 'stop swing low 27404.75', why: 'under the last swing low it is wrong' },
  { step: 'target', skill: 'top-down-entry', read: 'target 1h swing 27512.00', why: 'the next 1h swing high' },
];
const planned = size => [
  { harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } },
  { harness: 'compose_check', args: { symbol: 'MNQ', side: 'long', reads: READS, size } },
  { result: `CYCLE RESULT: planned - trade_lifecycle long ${size}` },
];
const deskReport = role => ({
  ok: true, timedOut: false, output: '', lookups: D.REQUIRED_LOOKUPS[role] || [],
  tools: [role === 'risk-manager' ? 'broker_get_account_snapshot' : 'harness_bar_briefing'],
  text: role === 'risk-manager' ? '## Risk state: account 7 @ now\nTradable: yes' : `## ${role}\nData: bar_briefing m3@x\nBias: long`,
});
const named = prompt => { const m = /The entry's size is (\d+) MNQ/.exec(prompt); return m ? Number(m[1]) : null; };
const phase2 = w => prompt => {
  const bars = /are in (\S+) \(get_bars format\)/.exec(prompt)[1];
  return [
    { harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } },
    { harness: 'order_plan', args: { bars, symbol: 'MNQ', strategy: 'trade_lifecycle', side: 'long', accountId: 7 } },
    { result: () => `Phase 2 on the trade_lifecycle long plan for MNQ.\nVERDICT: APPROVE - size ${named(prompt)}, the composed long\nFACTS: ${D.trueFacts(w).join('; ')}` },
  ];
};
const requestedArgs = prompt => JSON.parse(/built by the runner from this bar's compose record: (\{.*\})\. Send them as given/.exec(prompt)[1]);
const executor = prompt => [
  { broker: 'get_account_snapshot', args: { accountId: 7 } },
  { broker: 'place_order', args: requestedArgs(prompt) },
  { result: ctx => { const c = ctx.calls.filter(x => x.tool === 'place_order').at(-1); return c && c.ok ? `EXECUTED\nOrders: ${c.text.slice(0, 120)}` : `BLOCKED\n${c ? c.text.slice(0, 600) : 'no reply'}`; } },
];
function roles(w) {
  const runRole = async (role, request, limits) => {
    const isPhase2 = role === 'risk-manager' && /^Phase 2, plan verdict/.test(request);
    if (!isPhase2 && role !== 'trade-executor') return deskReport(role);
    const model = scriptedModel(isPhase2 ? phase2(w) : executor, { format: 'opencode' });
    return realRunRole(w.cfg, role, request, limits, { root: D.ROOT, home: w.home, env: D.passEnv(w, decisionAt(FIRED_BAR)), run: (argv, opts) => model(argv, opts) });
  };
  return { runRole };
}
/** A world on the decision-path replay with an attempt running on `account` (the broker's max order size 50). */
function attemptWorld(copy = null) {
  const w = D.world();
  w.env.MOCK_MAX_ORDER_SIZE = '50';
  if (copy) {
    w.env.FTH_STRATEGIES_DIRS = [w.env.FTH_STRATEGIES_DIRS, copy.strategies].filter(Boolean).join(',');
    w.env.FTH_ACCOUNTS_DIRS = copy.accounts;
  }
  exchange.update(w.state, s => { s.balance = 100000; });
  const account = loadAccounts(D.ROOT, w.env).accounts.find(a => a.name === (copy ? copy.account : POLICY.account));
  prop.startAttempt(w.home, account, new Date('2026-04-24T14:00:00Z'));
  return w;
}
const placed = w => D.placedAtBroker(w).filter(c => !/^\s*\[(exit|protect)\]/.test(String(c.args.rationale || '')));
function hook(env, input) {
  const res = spawnSync(process.execPath, [path.join(D.ROOT, 'scripts', 'hooks', 'run-with-flags.js'), 'pre:trading:order-gate', 'scripts/hooks/trading-order-gate.js', 'minimal,standard,strict'], {
    input: JSON.stringify({ tool_name: 'mcp__broker__place_order', tool_input: input }), encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_ROOT: D.ROOT },
  });
  return { code: res.status, stderr: String(res.stderr) };
}
const exitArgs = n => ({ accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: n, rationale: '[exit] trim the composed long' });

test('entry rule e2e: the 4h up and the 1h ranging, the shipped rule refuses the long: compose_check NOT OK, the runner sends nothing, the gateway and the hook refuse a direct order; an exit goes', async () => {
  const w = attemptWorld();
  const r = await D.pass(w, decisionAt(FIRED_BAR), planned(6), { runRole: roles(w).runRole, prop: true });
  const rec = TL.readRecords(w.home, 'MNQ').at(-1);
  assert.strictEqual(rec.ok, false);
  assert.ok((rec.problems || []).some(p => NO.test(p)), JSON.stringify(rec.problems));
  assert.deepStrictEqual(placed(w), [], 'nothing reached the broker');
  assert.doesNotMatch(r.ran[0].result || '', /^CYCLE RESULT: executed/);
  // The same plan sent directly (a limit at the record's entry, its brackets), through the real gateway in a cycle.
  const order = { accountId: 7, contractId: 'MNQ', side: 'buy', type: 'limit', limitPrice: 27427.5, size: 6, stopLossBracket: { ticks: 92, type: 'stop' }, takeProfitBracket: { ticks: 338, type: 'limit' }, rationale: 'setup:prop_portfolio long trade_lifecycle, stop 27404.50, target 27512.00' };
  const direct = await D.pass(w, decisionAt(FIRED_BAR), [{ broker: 'place_order', args: order }, { result: ctx => `CYCLE RESULT: blocked - ${ctx.calls.at(-1).text.slice(0, 400)}` }], { prop: true });
  assert.match(direct.ran[0].result, /CYCLE RESULT: blocked - .*Blocked by trading harness/s);
  const gated = D.gateLog(w).filter(e => e.source === 'gateway' && e.tool === 'place_order' && e.decision !== 'allowed').flatMap(e => e.violations || []);
  // No verdict stands on a NOT OK record, so the order names no composed record: the policy's entry rule is checked on
  // the briefing itself ([entry-rule], the route for any policy entry that isn't a composed one).
  assert.ok(gated.some(v => v.check === 'entry-rule' && NO.test(v.message)), JSON.stringify(gated));
  assert.deepStrictEqual(placed(w), [], 'still nothing at the broker');
  const env = D.passEnv(w, decisionAt(FIRED_BAR));
  const h = hook(env, order);
  assert.strictEqual(h.code, 2);
  assert.match(h.stderr, NO);
  // A risk-reducing order is never judged by the rule.
  assert.strictEqual(hook(env, exitArgs(1)).code, 0);
});

test('entry rule e2e: every listed frame agreeing (a copy listing only the 4h, bias_agree on) the long is placed at the broker; its exits go', async () => {
  const copy = policyCopy(require('../helpers').tmpDir(), { policy: 'pmc_agree', account: 'pmc_agree_100k', rulebook: t => t.replace(/^( {6}bias_frames: )\[4h, 1h\]/m, '$1[4h]') });
  const w = attemptWorld(copy);
  const r = await D.pass(w, decisionAt(FIRED_BAR), planned(6), { runRole: roles(w).runRole, prop: true });
  assert.match(r.ran[0].result, /^CYCLE RESULT: executed - trade_lifecycle long \d+ MNQ/, r.ran[0].result);
  assert.strictEqual(placed(w).length, 1);
  assert.match(placed(w)[0].args.rationale, /^setup:pmc_agree long trade_lifecycle/);
  const exits = await D.pass(w, decisionAt(NEXT_BAR), [{ broker: 'place_order', args: exitArgs(1) }, { result: 'CYCLE RESULT: managed - trimmed 1' }], { prop: true });
  assert.ok(exits.ran.length);
  assert.deepStrictEqual(D.placedAtBroker(w).filter(c => /^\s*\[exit\]/.test(c.args.rationale)).map(c => c.args.size), [1], 'the exit reached the broker');
});

test('entry rule e2e: the trail target through the real runner needs the 4h and the 1h both the trade\'s way: with the 1h ranging the record is NOT OK and nothing is sent', async () => {
  // The copy's rule lists only the 4h (so the entry rule holds here); the trail target reads the 4h and 1h itself.
  const copy = policyCopy(require('../helpers').tmpDir(), { policy: 'pmc_trail', account: 'pmc_trail_100k', rulebook: t => t.replace(/^( {6}bias_frames: )\[4h, 1h\]/m, '$1[4h]') });
  const w = attemptWorld(copy);
  const trail = READS.map(x => (x.step === 'target' ? { ...x, read: 'target trail' } : x));
  const r = await D.pass(w, decisionAt(FIRED_BAR), [{ harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } }, { harness: 'compose_check', args: { symbol: 'MNQ', side: 'long', reads: trail, size: 6 } }, { result: 'CYCLE RESULT: planned - trade_lifecycle long 6' }], { runRole: roles(w).runRole, prop: true });
  const rec = TL.readRecords(w.home, 'MNQ').at(-1);
  assert.strictEqual(rec.ok, false);
  assert.match(rec.reads.find(x => x.step === 'target').fact, /the trail target needs the 4h and the 1h both up/);
  assert.deepStrictEqual(placed(w), []);
  assert.doesNotMatch(r.ran[0].result || '', /^CYCLE RESULT: executed/);
});
