'use strict';

/**
 * The prop size end to end (the owner, 2026-10-23: "1 sizing should be translated to standard correct sizing"): in a
 * running prop attempt on the shipped prop_portfolio and its account's rulebook, the head trader composes and says
 * planned with a size of its own (a suggestion), and the real runner's entry reads code's translation
 * (prop/size-translate.js through order_plan), names it in phase 2's request, runs phase 2 and the trade-executor (each
 * its own scripted run), and the order goes through the real gateway and gate to the replay mock broker. The hook judges
 * the same arguments on its own. Every expected size is worked out here by hand from the rulebook's and the account
 * profile's numbers, never by calling the code under test.
 *
 * The scenario's composed long (the decision-path world's fired bar, tests/e2e/entry-workflow-e2e.test.js): entry
 * 27427.50, stop 27404.50 (one tick under the 27404.75 swing low) = 23 points = 92 ticks, on MNQ (the selected micro).
 *   a contract's all-in risk (the budget's and the cap's, "risk is good by calculating tick cost"):
 *                                          (92 + 1 slippage tick) x $0.50 + 2 x $0.37 fees = $46.50 + $0.74 = $47.24
 *   the composed cap ($300):               floor(300 / 47.24)                 = 6 ($283.44 all in)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const exchange = require('../fixtures/mock-exchange');
const D = require('../fixtures/decision-path');
const { scriptedModel } = require('../fixtures/scripted-model');
const { runRole: realRunRole } = require('../../scripts/lib/cycle-run');
const prop = require('../../scripts/lib/trading/prop-state');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { loadAccounts } = require('../../scripts/lib/trading/accounts');
const { loadRulebookFile } = require('../../scripts/lib/trading/rulebook');
const TL = require('../../scripts/lib/trading/trade-lifecycle');

const { FIRED_BAR, NEXT_BAR, decisionAt } = D;
const POLICY = loadStrategies(D.ROOT, {}).strategies.find(s => s.name === 'prop_portfolio');
const ACCOUNT = loadAccounts(D.ROOT, {}).accounts.find(a => a.name === POLICY.account);
const LC = loadStrategies(D.ROOT, {}).strategies.find(s => s.name === 'trade_lifecycle');

// The numbers this test works the sizes out from, checked against their homes (the rulebook, the profile, the strategy).
const N = { start: 100000, maxLoss: 3000, cushionFrac: 0.3, capUsd: 1000, halveUsd: 1500, slip: 1, floor: 3, fee: 0.37, composedCap: 300, tickValue: 0.5, tick: 0.25 };
const STOP_TICKS = (27427.5 - 27404.5) / N.tick; // 92
const BUDGET_RISK = (STOP_TICKS + N.slip) * N.tickValue + 2 * N.fee; // $47.24, the cap's per contract too
const capSize = Math.floor(N.composedCap / BUDGET_RISK); // 6
const budgetSize = dollars => Math.floor(dollars / BUDGET_RISK + 1e-9);

test('the hand-worked numbers are the shipped rulebook\'s, the profile\'s and the composed strategy\'s', () => {
  const book = loadRulebookFile(path.join(D.ROOT, 'accounts', ACCOUNT.name, 'RULEBOOK.md'));
  const z = book.policies.prop_portfolio.sizing;
  assert.deepStrictEqual([z.cushion_frac, z.cap_usd, z.drawdown_halve_usd, z.stop_slippage_ticks, z.min_contracts, z.clock_k], [N.cushionFrac, N.capUsd, N.halveUsd, N.slip, N.floor, 'off']);
  assert.deepStrictEqual([ACCOUNT.starting_balance, ACCOUNT.max_loss, ACCOUNT.fees_per_side.MNQ], [N.start, N.maxLoss, N.fee]);
  assert.strictEqual(LC.risk.max_risk_usd, N.composedCap);
  assert.deepStrictEqual([STOP_TICKS, Number(BUDGET_RISK.toFixed(2)), capSize], [92, 47.24, 6]);
});

// The head trader's planned cycle: the briefing, the composed reads at the suggested size, then `planned`.
const READS = [
  { step: 'bias', skill: 'multi-timeframe-analysis', read: '4h up', why: 'the 4h trend is up' },
  { step: 'location', skill: 'vwap-volume-profile', read: 'value above', why: 'above the prior value area' },
  { step: 'bias', skill: 'htf-to-ltf', read: 'trend long allowed', why: 'the trend rule takes the long' },
  { step: 'setup', skill: 'rejection', read: '15m rejected prior VAH up', why: 'the 15m dipped under the prior VAH and closed back above' },
  { step: 'entry', skill: 'candle-reading', read: '3m close top', why: 'the 3m bar closed at its high' },
  { step: 'stop', skill: 'invalidation', read: 'stop swing low 27404.75', why: 'under the last swing low it is wrong' },
  { step: 'target', skill: 'top-down-entry', read: 'target 1h swing 27512.00', why: 'the next 1h swing high' },
];
const planned = (w, size) => [
  { harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } },
  { harness: 'compose_check', args: { symbol: 'MNQ', side: 'long', reads: READS, size } },
  { result: `CYCLE RESULT: planned - trade_lifecycle long ${size}` },
];
const deskReport = role => ({
  ok: true, timedOut: false, output: '', lookups: D.REQUIRED_LOOKUPS[role] || [],
  tools: [role === 'risk-manager' ? 'broker_get_account_snapshot' : 'harness_bar_briefing'],
  text: role === 'risk-manager' ? '## Risk state: account 7 @ now\nTradable: yes' : `## ${role}\nData: bar_briefing m3@x\nBias: long`,
});
/** The size phase 2's request names ("The entry's size is <n> MNQ"), or null (outside an attempt: none). */
const named = prompt => { const m = /The entry's size is (\d+) MNQ/.exec(prompt); return m ? Number(m[1]) : null; };
/** Phase 2 as scripted: `verdict(prompt)` its VERDICT line (approve the named size, cut, echo, veto). */
const phase2 = (w, verdict) => prompt => {
  const bars = /are in (\S+) \(get_bars format\)/.exec(prompt)[1];
  return [
    { harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } },
    { harness: 'order_plan', args: { bars, symbol: 'MNQ', strategy: 'trade_lifecycle', side: 'long', accountId: 7 } },
    { result: () => `Phase 2 on the trade_lifecycle long plan for MNQ.\nVERDICT: ${verdict(prompt)}\nFACTS: ${D.trueFacts(w).join('; ')}` },
  ];
};
const requestedArgs = prompt => JSON.parse(/built by the runner from this bar's compose record: (\{.*\})\. Send them as given/.exec(prompt)[1]);
/**
 * The trade-executor as scripted. `hooked` (an object): just before it sends, the hook judges the same arguments in its
 * run's environment (the order as given, the model's raw 1, and exits and a protective stop at 1 and 2): its sizing refusals.
 */
const exitArgs = n => ({ accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: n, rationale: '[exit] trim the composed long' });
const executor = hooked => prompt => [
  { broker: 'get_account_snapshot', args: { accountId: 7 } },
  ...(hooked ? [{ act: ctx => {
    const args = requestedArgs(prompt);
    Object.assign(hooked, {
      given: hook(ctx.env, args), raw: hook(ctx.env, { ...args, size: 1 }),
      exits: [1, 2].map(n => hook(ctx.env, exitArgs(n))), protect: hook(ctx.env, { ...exitArgs(2), type: 'stop', stopPrice: 27404.5, rationale: '[protect] stop for the composed long' }),
    });
  } }] : []),
  { broker: 'place_order', args: requestedArgs(prompt) },
  { result: ctx => { const c = ctx.calls.filter(x => x.tool === 'place_order').at(-1); return c && c.ok ? `EXECUTED\nOrders: ${c.text.slice(0, 120)}` : `BLOCKED\n${c ? c.text.slice(0, 600) : 'no reply'}`; } },
];
function roles(w, verdict, hooked = null) {
  const runs = [];
  const runRole = async (role, request, limits) => {
    const isPhase2 = role === 'risk-manager' && /^Phase 2, plan verdict/.test(request);
    runs.push({ role: isPhase2 ? 'phase2' : role, request });
    if (!isPhase2 && role !== 'trade-executor') return deskReport(role);
    const model = scriptedModel(isPhase2 ? phase2(w, verdict) : executor(hooked), { format: 'opencode' });
    const r = await realRunRole(w.cfg, role, request, limits, { root: D.ROOT, home: w.home, env: D.passEnv(w, decisionAt(FIRED_BAR)), run: (argv, opts) => model(argv, opts) });
    runs.at(-1).env = model.last && model.last.env;
    return r;
  };
  return { runRole, runs };
}

/**
 * A world on the decision-path replay with the shipped policy's attempt running (none with `attempt: false`): the
 * broker's balance, yesterday's close (the floor trails the end-of-day high from the starting balance) and the
 * broker's max order size as set.
 */
function attemptWorld({ attempt = true, balance = N.start, close = null, orderMax = 50 } = {}) {
  const w = D.world();
  // The broker's max order size (the mock's own default is 5; 50 here, so the rulebook's limits bind but where a row sets it).
  w.env.MOCK_MAX_ORDER_SIZE = String(orderMax);
  exchange.update(w.state, s => { s.balance = balance; });
  if (attempt) {
    prop.startAttempt(w.home, ACCOUNT, new Date('2026-04-24T14:00:00Z'));
    if (close !== null) prop.recordEndOfDay(w.home, ACCOUNT, close, '2026-04-27');
  }
  return { ...w, attempt };
}
const placed = w => D.placedAtBroker(w).filter(c => !/^\s*\[(exit|protect)\]/.test(String(c.args.rationale || '')));
const entryOf = w => { const l = D.cycleLines(w).at(-1); return l && l.file ? JSON.parse(fs.readFileSync(l.file, 'utf8')).entry : null; };
const SIZING = ['composed-reads', 'min-contracts', 'max-risk', 'policy', 'combine', 'max-order-size', 'phase2-size'];

/** One planned cycle: the suggestion, phase 2's verdict. { r, R, sent, entry }. */
async function cycle(w, { suggest, verdict = p => `APPROVE - size ${named(p) ?? suggest}, the composed long`, hooked = null }) {
  const R = roles(w, verdict, hooked);
  const r = await D.pass(w, decisionAt(FIRED_BAR), planned(w, suggest), { runRole: R.runRole, prop: Boolean(w.attempt) });
  return { r, R, sent: placed(w).map(c => c.args.size), entry: entryOf(w), result: r.ran[0].result };
}
/** The hook on the exact arguments the executor got, in its run's environment: the sizing checks it refuses with. */
function hook(env, input) {
  const res = spawnSync(process.execPath, [path.join(D.ROOT, 'scripts', 'hooks', 'run-with-flags.js'), 'pre:trading:order-gate', 'scripts/hooks/trading-order-gate.js', 'minimal,standard,strict'], {
    input: JSON.stringify({ tool_name: 'mcp__broker__place_order', tool_input: input }), encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_ROOT: D.ROOT },
  });
  return [...String(res.stderr).matchAll(/\[([a-z0-9-]+)\]/g)].map(m => m[1]).filter(c => SIZING.includes(c));
}
// The gateway's refusals of any check (the hook's own, judged above, log beside them).
const sizingRefusals = w => D.gateLog(w).filter(e => e.source === 'gateway' && e.decision !== 'allowed').flatMap(e => (e.violations || []).map(v => v.check));

test('prop size e2e: the suggestion is ignored: 1, 3 and 20 all order the translated 6 (the $300 cap all in: floor(300 / 47.24)); phase 2 is asked for 6; the all-in loss at the stop within $300', async () => {
  // A fresh attempt: cushion $3,000 x 0.3 = $900 (under cap_usd $1,000): floor(900 / 47.24) = 19 by the budget and the
  // verdict; the composed cap binds: 6.
  assert.strictEqual(budgetSize(N.cushionFrac * N.maxLoss), 19);
  for (const suggest of [1, 3, 20]) {
    const w = attemptWorld();
    const hooked = suggest === 1 ? {} : null;
    const { R, sent, entry, result } = await cycle(w, { suggest, hooked });
    assert.match(R.runs.find(x => x.role === 'phase2').request, new RegExp(`The entry's size is ${capSize} MNQ: code's translation of the record's suggested ${suggest} `));
    assert.deepStrictEqual(sent, [capSize], `suggested ${suggest}`);
    // The all-in loss at the stop (the stop, a tick of slippage and fees both ways, per contract) within the $300 cap.
    assert.ok(sent[0] * BUDGET_RISK <= N.composedCap, `${sent[0]} x $47.24 = $${(sent[0] * BUDGET_RISK).toFixed(2)}`);
    assert.deepStrictEqual([entry.translated.suggested, entry.translated.size, entry.size.approved, entry.size.ordered], [suggest, capSize, capSize, capSize]);
    assert.match(result, new RegExp(`^CYCLE RESULT: executed - trade_lifecycle long ${capSize} MNQ`));
    assert.deepStrictEqual(sizingRefusals(w), []);
    assert.deepStrictEqual(TL.readRecords(w.home, 'MNQ').at(-1).plan.size, suggest, 'the record keeps the suggestion');
    if (suggest === 1) {
      // The hook on the same arguments, just before the executor sent them: the translated size passes its sizing
      // checks; the model's raw 1 is refused; exits and a protective stop at 1 and 2 never are.
      assert.deepStrictEqual(hooked.given, [], 'the hook takes the translated size');
      assert.ok(hooked.raw.includes('composed-reads'), `the hook refuses the raw 1: ${hooked.raw}`);
      assert.deepStrictEqual([hooked.exits, hooked.protect], [[[], []], []]);
      // Exits at 1 and 2 through the gateway, after the fill.
      const exits = await D.pass(w, decisionAt(NEXT_BAR), [
        { broker: 'place_order', args: exitArgs(1) }, { broker: 'place_order', args: exitArgs(2) }, { result: 'CYCLE RESULT: managed - trimmed 3' },
      ], { prop: true });
      assert.ok(exits.ran.length);
      const out = D.placedAtBroker(w).filter(c => /^\s*\[exit\]/.test(c.args.rationale)).map(c => c.args.size);
      assert.deepStrictEqual(out, [1, 2], 'both exits reached the broker');
      assert.strictEqual(D.position(w).size, capSize - 3);
    }
  }
});

test('prop size e2e: the binding limit, one row each: the broker\'s max, the drawdown halving, the cushion, the floor', async () => {
  const rows = [
    // The broker's max order size 4 (fresh: 6 by the cap): 4.
    { name: 'broker max 4', world: { orderMax: 4 }, want: 4 },
    // $1,500 below the peak (yesterday's close $98,500; the floor $97,000): cushion $1,500 x 0.3 = $450, halved $225:
    // floor(225 / 47.24) = 4.
    { name: 'drawdown halving', world: { balance: 98500, close: 98500 }, want: budgetSize((N.cushionFrac * 1500) / 2) },
    // A $1,000 cushion ($98,000): $300, halved (2,000 below the peak) $150: floor(150 / 47.24) = 3, at the floor.
    { name: 'cushion', world: { balance: 98000, close: 98000 }, want: budgetSize((N.cushionFrac * 1000) / 2) },
    // A $700 cushion ($97,700): $210, halved $105: floor(105 / 47.24) = 2, under the floor of 3: a skip, no order.
    { name: 'floor', world: { balance: 97700, close: 97700 }, want: 0 },
  ];
  assert.deepStrictEqual(rows.map(x => x.want), [4, 4, 3, 0]);
  for (const row of rows) {
    const w = attemptWorld(row.world);
    const { sent, entry, result } = await cycle(w, { suggest: 1 });
    if (row.want) {
      assert.deepStrictEqual(sent, [row.want], row.name);
      assert.deepStrictEqual([entry.translated.size, entry.size.ordered], [row.want, row.want], row.name);
      assert.match(result, new RegExp(`^CYCLE RESULT: executed - trade_lifecycle long ${row.want} MNQ`), row.name);
      assert.deepStrictEqual(sizingRefusals(w), [], row.name);
    } else {
      assert.deepStrictEqual(sent, [], `${row.name}: no order`);
      assert.strictEqual(entry.translated, undefined, `${row.name}: no translation to name`);
      // 3 contracts at $47.24 = $141.72, over the $105.00 budget: the verdict skips (2 would fit, under the floor).
      assert.match(result, /^CYCLE RESULT: no-trade - .*order_plan refused the composed plan: prop_portfolio skipped the setup \(3 MNQ at this stop risk \$141\.72, over the \$105\.00 budget/, row.name);
    }
  }
});

test('prop size e2e: phase 2: the named 6 orders 6; on a healthy account a cut (to 3, 2, or an echo of the record\'s 1) with no pacing rule orders the translated 6, a process note; in a drawdown a cut to 3 is 3 and to 2 no trade; a veto, no trade; above the translation, the translation', async () => {
  // Healthy: the attempt at its start and peak, no loss today; `dd`: the balance $100 under the start (a drawdown, the
  // budget still over the $300 cap: the translation is 6 either way). Phase 2's cut stands only in the drawdown.
  const dd = N.start - 100;
  const rows = [
    { name: 'approves the named size', verdict: p => `APPROVE - size ${named(p)}, the composed long`, want: 6, approved: 6 },
    { name: 'cuts to 3, healthy', verdict: () => 'APPROVE - size 3, the composed long', want: 6, approved: 6, restored: 3 },
    { name: 'cuts to 2, healthy', verdict: () => 'APPROVE - size 2, the composed long', want: 6, approved: 6, restored: 2 },
    { name: 'echoes the record\'s 1, healthy', verdict: () => 'APPROVE - size 1, the composed long', want: 6, approved: 6, restored: 1 },
    { name: 'cuts to 3 in a drawdown', balance: dd, verdict: () => 'APPROVE - size 3, the composed long', want: 3, approved: 3 },
    { name: 'cuts to 2 in a drawdown', balance: dd, verdict: () => 'APPROVE - size 2, the composed long', want: 0, approved: 2 },
    { name: 'vetoes', verdict: () => 'VETO - the room is short: stand aside', want: 0, approved: null },
    { name: 'approves above the translation', verdict: () => 'APPROVE - size 9, the composed long', want: 6, approved: 9 },
  ];
  for (const row of rows) {
    const w = attemptWorld(row.balance ? { balance: row.balance } : {});
    const { sent, entry, result } = await cycle(w, { suggest: 1, verdict: row.verdict });
    assert.deepStrictEqual(sent, row.want ? [row.want] : [], row.name);
    assert.deepStrictEqual(entry.translated.size, capSize, row.name);
    assert.deepStrictEqual(entry.cutRestored && entry.cutRestored.note, row.restored ? `phase-2 cut ${row.restored} -> 6: no pacing rule applies` : undefined, row.name);
    if (row.want) {
      assert.deepStrictEqual([entry.size.suggested, entry.size.translated, entry.size.approved, entry.size.ordered], [1, capSize, row.approved, row.want], row.name);
      assert.match(result, new RegExp(`^CYCLE RESULT: executed - trade_lifecycle long ${row.want} MNQ`), row.name);
      assert.deepStrictEqual(sizingRefusals(w), [], row.name);
    } else if (row.approved === null) {
      assert.match(result, /^CYCLE RESULT: no-trade - .*VETO/, row.name);
    } else {
      assert.match(result, new RegExp(`order_plan refused the composed plan: \\[min-contracts\\] setup:prop_portfolio: size ${row.approved} MNQ is under the floor of 3 contracts`), row.name);
    }
  }
});

test('prop size e2e: outside an attempt (stage 1) the record\'s size stands, as on main: a suggestion of 2 orders 2; phase 2\'s request names no translated size', async () => {
  const w = attemptWorld({ attempt: false });
  const { R, sent, entry, result } = await cycle(w, { suggest: 2 });
  assert.strictEqual(named(R.runs.find(x => x.role === 'phase2').request), null);
  assert.deepStrictEqual(sent, [2]);
  assert.deepStrictEqual([entry.translated, entry.size], [undefined, { approved: 2, record: 2, ordered: 2 }]);
  assert.match(result, /^CYCLE RESULT: executed - trade_lifecycle long 2 MNQ/);
  assert.match(requestedArgs(R.runs.at(-1).request).rationale, /^setup:trade_lifecycle long/);
});
