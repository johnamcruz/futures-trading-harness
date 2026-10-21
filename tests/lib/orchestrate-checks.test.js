'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CHECKS, readData } = require('../../scripts/lib/orchestrate/checks');
const { REQUESTS } = require('../../scripts/lib/orchestrate/requests');

test('read-data: a broker call, a file read or a market/account harness tool; never a skill or a past-decision lookup', () => {
  for (const t of ['harness_bar_briefing', 'harness_combine_status', 'broker_get_account_snapshot', 'read']) assert.strictEqual(readData([t]), true, t);
  assert.strictEqual(readData(['harness_skill_lookup', 'harness_experience_lookup', 'skill', 'glob']), false);
  assert.strictEqual(readData(null), false);
  assert.strictEqual(CHECKS['read-data']('x', { tools: [] }), 'read no data');
  assert.strictEqual(CHECKS['read-data']('x', { tools: ['harness_mtf_read'] }), null);
});

test('report-shape: an analyst\'s report names its Data line, phase 1 is a risk state, never empty', () => {
  const shape = CHECKS['report-shape'];
  assert.strictEqual(shape('market-structure-analyst', { text: '## Structure\nData: bar_briefing m3@1\nBias: long' }), null);
  assert.match(shape('trend-momentum-analyst', { text: 'Bias: long' }), /no Data line/);
  assert.strictEqual(shape('risk-manager', { text: '## Risk state: account 1' }), null);
  assert.match(shape('risk-manager', { text: 'fine' }), /not a phase 1 risk state/);
  assert.strictEqual(shape('volume-liquidity-analyst', { text: ' ' }), 'no report');
});

test('the desk request: the symbol, the bar, read your own data; phase 1 for the risk manager; never "already provided"', () => {
  const a = REQUESTS.desk('market-structure-analyst', { symbol: 'MNQ', contractId: 'MNQ', at: '10:03 ET', timeframe: 3 });
  assert.match(a, /MNQ \(contractId MNQ\) at the 3-minute bar that closed by 10:03 ET/);
  assert.match(a, /Read your own data first \(bar_briefing for MNQ/);
  const r = REQUESTS.desk('risk-manager', { symbol: 'MNQ', at: '10:03 ET', timeframe: 3 });
  assert.match(r, /^Phase 1, risk state, for MNQ/);
  for (const s of [a, r]) assert.doesNotMatch(s, /already provided/i);
  // The cycle's bars file, named exactly: a role never guesses the path (a relative one resolved in its workspace).
  const f = REQUESTS.desk('volume-liquidity-analyst', { symbol: 'MNQ', at: '10:03 ET', timeframe: 3, bars: '/h/bars/MNQ-3m.json' });
  assert.match(f, /Closed 3-minute bars, oldest first, are in \/h\/bars\/MNQ-3m\.json \(get_bars format\): pass that exact path/);
  assert.doesNotMatch(a, /Closed 3-minute bars/, 'no file given: none named');
});

test('lookups: a run counts only with every skill its bar requires of its role (the ctx\'s, the gate\'s requirement); none required, nothing checked', () => {
  const ctx = { lookups: { 'market-structure-analyst': ['breakout-vs-fakeout', 'breakout'] } };
  const msa = 'market-structure-analyst';
  assert.strictEqual(CHECKS.lookups(msa, { lookups: ['breakout', 'breakout-vs-fakeout', 'cisd'] }, ctx), null);
  assert.strictEqual(CHECKS.lookups(msa, { lookups: ['breakout-vs-fakeout'] }, ctx), 'didn\'t look up breakout (this bar requires it of its role)');
  assert.match(CHECKS.lookups(msa, {}, ctx), /didn't look up breakout-vs-fakeout, breakout/);
  assert.strictEqual(CHECKS.lookups('risk-manager', { lookups: [] }, ctx), null, 'nothing required of the role');
  assert.strictEqual(CHECKS.lookups(msa, { lookups: [] }, {}), null, 'full mode: none required');
  assert.strictEqual(CHECKS.lookups(msa, { lookups: [] }), null);
});

test('the desk request names the lookups the bar requires of the role, with its role name for skill_lookup; none, nothing said', () => {
  const ctx = { symbol: 'MNQ', at: '10:03 ET', timeframe: 3, lookups: { 'market-structure-analyst': ['breakout'] } };
  assert.match(REQUESTS.desk('market-structure-analyst', ctx), /This bar requires you to look up `breakout` before your report: `skill_lookup \{"skill": "<skill>", "role": "market-structure-analyst"\}`/);
  assert.doesNotMatch(REQUESTS.desk('trend-momentum-analyst', ctx), /look up/);
  assert.doesNotMatch(REQUESTS.desk('market-structure-analyst', { ...ctx, lookups: undefined }), /look up/);
});

test('verdict-facts: phase 2\'s report has its verdict and its FACTS line, read by the gate\'s own readers (a VETO is a report); order-sent: the executor\'s order call completed, or it reported the refusal', () => {
  const vf = CHECKS['verdict-facts'];
  assert.strictEqual(vf('risk-manager', { text: 'VERDICT: APPROVE - size 1\nFACTS: window asia; trend long allowed' }), null);
  assert.strictEqual(vf('risk-manager', { text: 'VERDICT: VETO - room: stand aside\nFACTS: window asia; trend long allowed' }), null);
  assert.match(vf('risk-manager', { text: 'VERDICT: APPROVE - size 1' }), /no FACTS line/);
  assert.match(vf('risk-manager', { text: 'FACTS: window asia\nlooks fine' }), /no VERDICT line/);
  assert.match(vf('risk-manager', { text: '  ' }), /no report/);
  assert.match(vf('risk-manager', null), /no report/);
  // The same readers as the gate's: an approval the gate reads as none is none here.
  const { verdictOf } = require('../../scripts/lib/trading/roles-ran');
  const { factsLines } = require('../../scripts/lib/trading/fact-claims');
  for (const text of ['Verdict - approve\nFACTS: news clear; entries allowed', 'decision: take it\nFACTS: news clear']) assert.strictEqual(vf('risk-manager', { text }) === null, verdictOf(text) !== null && factsLines(text) !== null, text);
  const sent = CHECKS['order-sent'];
  assert.strictEqual(sent('trade-executor', { tools: ['broker_get_account_snapshot', 'broker_place_order'], text: 'EXECUTED' }), null);
  assert.strictEqual(sent('trade-executor', { tools: ['broker_get_account_snapshot'], text: 'BLOCKED\nBlocked by trading harness' }), null);
  assert.strictEqual(sent('trade-executor', { tools: [], text: '**ABORTED**\nOrderRejected' }), null);
  assert.match(sent('trade-executor', { tools: ['broker_get_account_snapshot'], text: 'EXECUTED (it says)' }), /no order call and no refusal reported/);
  assert.match(sent('trade-executor', { tools: ['harness_place_order'], text: 'done' }), /no order call/, 'only the broker server\'s order tool');
  assert.strictEqual(sent('trade-executor', { tools: ['b2_place_order'], text: '' }, { brokerServer: 'b2' }), null);
});

test('review and execute requests: phase 2 gets the record, the reports and the bars, the order_plan call to make and its output; the executor the exact arguments and the verdict line', () => {
  const ctx = { symbol: 'MNQ', contractId: 'MNQ', at: '2026-10-07T13:57:02.000Z', timeframe: 3, bars: '/b/MNQ-3m.json', strategy: 'trade_lifecycle', side: 'long', accountId: 7, record: 'compose_check MNQ long ... OK', reports: [{ role: 'risk-manager', text: '## Risk state: account 7' }, { role: 'market-structure-analyst', text: 'Data: x' }, { role: 'trend-momentum-analyst', text: ' ' }], lookups: { 'risk-manager': ['order-types'] } };
  const r = REQUESTS.review('risk-manager', ctx);
  assert.match(r, /^Phase 2, plan verdict, for MNQ \(contractId MNQ\) at the 3-minute bar that closed by 2026-10-07T13:57:02\.000Z\./);
  assert.ok(r.includes('`order_plan {"bars":"/b/MNQ-3m.json","symbol":"MNQ","strategy":"trade_lifecycle","side":"long","accountId":7}`'), r);
  assert.match(r, /are in \/b\/MNQ-3m\.json \(get_bars format\)/);
  assert.match(r, /look up `order-types` before your report: `skill_lookup \{"skill": "<skill>", "role": "risk-manager"\}`/);
  assert.match(r, /End with your VERDICT line, then your FACTS line last/);
  assert.match(r, /--- compose record \(MNQ long\) ---\ncompose_check MNQ long \.\.\. OK\n--- end of compose record \(MNQ long\) ---/);
  assert.match(r, /--- risk-manager phase 1 report ---\n## Risk state: account 7\n--- end of risk-manager phase 1 report ---/);
  assert.match(r, /--- market-structure-analyst report ---\nData: x/);
  assert.doesNotMatch(r, /trend-momentum-analyst report/, 'an empty report is left out');
  assert.doesNotMatch(r, /already provided/i);
  const args = { accountId: 7, contractId: 'MNQ', side: 'buy', type: 'limit', limitPrice: 21500, size: 1, stopLossBracket: { ticks: 40, type: 'stop' }, rationale: 'setup:trade_lifecycle long' };
  const x = REQUESTS.execute('trade-executor', { ...ctx, args, verdict: ' VERDICT: APPROVE - size 1, risk $20.00 ' });
  assert.ok(x.includes(`built by the runner from this bar's compose record: ${JSON.stringify(args)}. Send them as given`), x);
  assert.match(x, /The risk manager's line: VERDICT: APPROVE - size 1, risk \$20\.00\./);
  assert.match(x, /once; never resize, reprice or relabel them/);
  assert.match(x, /EXECUTED, BLOCKED or ABORTED first/);
});
