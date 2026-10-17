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
