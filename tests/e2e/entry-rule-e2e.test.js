'use strict';

/**
 * The owner's top-down bias end to end (2026-10-29: "Don't counter trade against the prevailing trend"; BG, the owner's
 * pick from the alignment study): in a running prop attempt on the shipped prop_portfolio and its account's rulebook
 * (bias_frames [4h, 1h], bias_agree neutral-15m-declared), the real runner, compose_check, the real gateway and gate and
 * the hook.
 *
 * The decision-path world's fired bar (tests/fixtures/decision-path.js) has the 4h up, the 1h ranging and the 15m down,
 * outside RTH (no Trend declared? facts).
 *   - Aligned (BG: the 4h trends the long's way, the 1h ranging is not against it): the runner's entry places the long
 *     at the broker, and its exits go through the gateway a bar later.
 *   - A trending HTF against: a short sent directly through the gateway is refused ([entry-rule]: the 4h is up), and
 *     the hook refuses it on its own; an exit goes.
 *   - Neutral: a copy of the shipped policy and account whose rulebook lists only the 1h (BG on a ranging 1h: the 15m
 *     and the declared trend set the side): the long is NOT OK at compose_check (the 15m down) and the runner sends
 *     nothing; a short (the 15m its way) is refused at the gateway and the hook, the Trend declared? facts not in the
 *     briefing (fails closed); an exit goes. The neutral bar with the declared trend the side's way, which goes, is the
 *     hook and gateway wiring's (tests/hooks/trading-hooks.test.js) and the gate's (tests/lib/order-gate.test.js).
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
  { harness: 'skill_lookup', args: { skill: 'candle-reading' } }, { harness: 'compose_check', args: { symbol: 'MNQ', side: 'long', reads: READS, size } },
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

test('entry rule e2e: aligned under the shipped BG (the 4h up, the 1h ranging): the long is placed at the broker; its exits go', async () => {
  const w = attemptWorld();
  const r = await D.pass(w, decisionAt(FIRED_BAR), planned(6), { runRole: roles(w).runRole, prop: true });
  const rec = TL.readRecords(w.home, 'MNQ').at(-1);
  assert.strictEqual(rec.ok, true, (rec.problems || []).join('; '));
  assert.match(r.ran[0].result, /^CYCLE RESULT: executed - trade_lifecycle long \d+ MNQ/, r.ran[0].result);
  assert.strictEqual(placed(w).length, 1);
  assert.match(placed(w)[0].args.rationale, /^setup:prop_portfolio long trade_lifecycle/);
  const exits = await D.pass(w, decisionAt(NEXT_BAR), [{ broker: 'place_order', args: exitArgs(1) }, { result: 'CYCLE RESULT: managed - trimmed 1' }], { prop: true });
  assert.ok(exits.ran.length);
  assert.deepStrictEqual(D.placedAtBroker(w).filter(c => /^\s*\[exit\]/.test(c.args.rationale)).map(c => c.args.size), [1], 'the exit reached the broker');
});

/** A short at the fired bar sent directly through the real gateway in a cycle, then by the hook: { gated, hook }. */
async function directShort(w, policy) {
  const order = { accountId: 7, contractId: 'MNQ', side: 'sell', type: 'limit', limitPrice: 27427.5, size: 6, stopLossBracket: { ticks: 92, type: 'stop' }, rationale: `setup:${policy} short trade_lifecycle, stop 27450.50` };
  const direct = await D.pass(w, decisionAt(FIRED_BAR), [{ broker: 'place_order', args: order }, { result: ctx => `CYCLE RESULT: blocked - ${ctx.calls.at(-1).text.slice(0, 400)}` }], { prop: true });
  assert.match(direct.ran[0].result, /CYCLE RESULT: blocked - .*Blocked by trading harness/s);
  const gated = D.gateLog(w).filter(e => e.source === 'gateway' && e.tool === 'place_order' && e.decision !== 'allowed').flatMap(e => e.violations || []);
  const env = D.passEnv(w, decisionAt(FIRED_BAR));
  return { gated, hook: hook(env, order), exit: hook(env, { ...exitArgs(1), side: 'buy', rationale: '[exit] cover the composed short' }) };
}

test('entry rule e2e: a trending HTF against (a short under the 4h up): the gateway and the hook refuse it [entry-rule]; nothing at the broker; an exit goes', async () => {
  const w = attemptWorld();
  const AGAINST = /entry rule: the 4h trend is up, against the short: the bias frames \(4h, 1h\) set the side/;
  const { gated, hook: h, exit } = await directShort(w, 'prop_portfolio');
  assert.ok(gated.some(v => v.check === 'entry-rule' && AGAINST.test(v.message)), JSON.stringify(gated));
  assert.deepStrictEqual(placed(w), [], 'nothing reached the broker');
  assert.strictEqual(h.code, 2);
  assert.match(h.stderr, AGAINST);
  assert.strictEqual(exit.code, 0, exit.stderr);
});

test('entry rule e2e: neutral (a copy listing only the 1h, ranging): the long against the 15m is NOT OK and never sent; the short with the 15m but no declared facts is refused at the gateway and the hook; an exit goes', async () => {
  const copy = policyCopy(require('../helpers').tmpDir(), { policy: 'pmc_neutral', account: 'pmc_neutral_100k', rulebook: t => t.replace(/^( {6}bias_frames: )\[4h, 1h\]/m, '$1[1h]') });
  const w = attemptWorld(copy);
  const r = await D.pass(w, decisionAt(FIRED_BAR), planned(6), { runRole: roles(w).runRole, prop: true });
  const rec = TL.readRecords(w.home, 'MNQ').at(-1);
  assert.strictEqual(rec.ok, false);
  assert.ok((rec.problems || []).some(p => /entry rule: no higher-timeframe trend \(1h range\) and the 15m is down, not up/.test(p)), JSON.stringify(rec.problems));
  assert.deepStrictEqual(placed(w), [], 'nothing reached the broker');
  assert.doesNotMatch(r.ran[0].result || '', /^CYCLE RESULT: executed/);
  const UNDECLARED = /entry rule: no higher-timeframe trend \(1h range\), the 15m down: the Trend declared\? facts are not in the briefing, so it can't be read: no entry/;
  const { gated, hook: h, exit } = await directShort(w, 'pmc_neutral');
  assert.ok(gated.some(v => v.check === 'entry-rule' && UNDECLARED.test(v.message)), JSON.stringify(gated));
  assert.deepStrictEqual(placed(w), [], 'still nothing at the broker');
  assert.strictEqual(h.code, 2);
  assert.match(h.stderr, UNDECLARED);
  assert.strictEqual(exit.code, 0, exit.stderr);
});

test('entry rule e2e: the trail target through the real runner on a BG-only bar (the 4h up, the 1h ranging): the record plans the trail and the long reaches the broker', async () => {
  // The owner: always trail; never block a trend entry for want of a fixed target. The shipped rule allows the long on
  // the fired bar (the 4h trends its way, the 1h ranging is not against it), so its trail target stands too.
  const w = attemptWorld();
  const trail = READS.map(x => (x.step === 'target' ? { ...x, read: 'target trail' } : x));
  const r = await D.pass(w, decisionAt(FIRED_BAR), [{ harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } }, { harness: 'skill_lookup', args: { skill: 'candle-reading' } }, { harness: 'compose_check', args: { symbol: 'MNQ', side: 'long', reads: trail, size: 6 } }, { result: 'CYCLE RESULT: planned - trade_lifecycle long 6' }], { runRole: roles(w).runRole, prop: true });
  const rec = TL.readRecords(w.home, 'MNQ').at(-1);
  assert.strictEqual(rec.ok, true, (rec.problems || []).join('; '));
  assert.match(rec.reads.find(x => x.step === 'target').fact, /the entry rule allows the long: the target is the trail/);
  assert.strictEqual(rec.plan.target.trail, true);
  assert.match(r.ran[0].result, /^CYCLE RESULT: executed - trade_lifecycle long \d+ MNQ/, r.ran[0].result);
  assert.strictEqual(placed(w).length, 1);
});

test('entry rule e2e: the setup is the 15m or higher: a 1h setup the long\'s way goes through the real runner to the broker (the HTF agreement held)', async () => {
  const copy = policyCopy(require('../helpers').tmpDir(), { policy: 'pmc_setup', account: 'pmc_setup_100k', rulebook: t => t.replace(/^( {6}bias_frames: )\[4h, 1h\]/m, '$1[4h]') });
  const w = attemptWorld(copy);
  // The fired bar's TRUE setups the long's way are a 1h and a 15m one (no 3m one there): the 1h one, alone.
  const reads = READS.map(x => (x.step === 'setup' ? { ...x, skill: 'breakout', read: '1h broke round number 27400 up' } : x));
  const r = await D.pass(w, decisionAt(FIRED_BAR), [{ harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } }, { harness: 'skill_lookup', args: { skill: 'candle-reading' } }, { harness: 'compose_check', args: { symbol: 'MNQ', side: 'long', reads, size: 6 } }, { result: 'CYCLE RESULT: planned - trade_lifecycle long 6' }], { runRole: roles(w).runRole, prop: true });
  const rec = TL.readRecords(w.home, 'MNQ').at(-1);
  assert.strictEqual(rec.ok, true, rec.problems.join('; '));
  assert.match(r.ran[0].result, /^CYCLE RESULT: executed - trade_lifecycle long \d+ MNQ/, r.ran[0].result);
  assert.strictEqual(placed(w).length, 1);
});
