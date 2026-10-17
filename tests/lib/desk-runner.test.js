'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { deskRequest, readData, finalText, reportProblem, runDesk } = require('../../scripts/lib/desk-runner');

const tool = (name, status = 'completed') => JSON.stringify({ type: 'tool_use', part: { tool: name, state: { status, input: {} } } });
const text = t => JSON.stringify({ type: 'text', part: { type: 'text', text: t } });
const run = (...lines) => lines.join('\n');
const ANALYST_REPORT = '## Structure: MNQ @ 10:03 ET\nData: bar_briefing m3@1, m15@2, h1@3, day@4\nBias: long';
const PHASE1 = '## Risk state: account 1 @ 10:03 ET\nTradable: yes';

test('deskRequest: one request per role, built in code: the symbol, the bar, read your own data; phase 1 for the risk manager; never "already provided"', () => {
  const a = deskRequest('trend-momentum-analyst', { symbol: 'MNQ', contractId: 'MNQ', at: '10:03 ET', timeframe: 3 });
  assert.match(a, /MNQ \(contractId MNQ\) at the 3-minute bar that closed by 10:03 ET/);
  assert.match(a, /Read your own data first \(bar_briefing for MNQ/);
  const r = deskRequest('risk-manager', { symbol: 'MNQ', at: '10:03 ET', timeframe: 3 });
  assert.match(r, /^Phase 1, risk state, for MNQ at the 3-minute bar/);
  for (const s of [a, r]) assert.doesNotMatch(s, /already provided/i);
});

test('readData: a completed broker call, a file read or a market/account harness tool; never a skill, a past-decision lookup, or a call that failed', () => {
  assert.strictEqual(readData(run(tool('harness_bar_briefing'))), true);
  assert.strictEqual(readData(run(tool('broker_get_account_snapshot'))), true);
  assert.strictEqual(readData(run(tool('read'))), true);
  assert.strictEqual(readData(run(tool('harness_skill_lookup'), tool('harness_experience_lookup'), tool('skill'))), false);
  assert.strictEqual(readData(run(tool('harness_bar_briefing', 'error'))), false);
  assert.strictEqual(readData(''), false);
  assert.strictEqual(readData('not json\n{bad'), false);
});

test('finalText and reportProblem: the run\'s last message; an analyst\'s needs its Data line, phase 1 its risk state', () => {
  assert.strictEqual(finalText(run(text('thinking'), tool('harness_bar_briefing'), text(ANALYST_REPORT))), ANALYST_REPORT);
  assert.strictEqual(reportProblem('market-structure-analyst', ANALYST_REPORT), null);
  assert.match(reportProblem('market-structure-analyst', 'Bias: long'), /no Data line/);
  assert.strictEqual(reportProblem('risk-manager', PHASE1), null);
  assert.match(reportProblem('risk-manager', 'all good'), /not a phase 1 risk state/);
  assert.strictEqual(reportProblem('volume-liquidity-analyst', '  '), 'no report');
});

test('runDesk: every role run with its request, at most `concurrency` at once; a bad run is retried, then missing; it never rejects', async () => {
  let running = 0;
  let most = 0;
  const calls = [];
  const runRole = async (role, req) => {
    calls.push([role, req]);
    running += 1; most = Math.max(most, running);
    await new Promise(r => setTimeout(r, 5));
    running -= 1;
    if (role === 'risk-manager') return { ok: true, output: run(tool('broker_get_account_snapshot'), text(PHASE1)) };
    if (role === 'volume-liquidity-analyst' && calls.filter(c => c[0] === role).length === 1) return { ok: true, output: run(text('Data: bar_briefing m3@1')) }; // read nothing: retried
    if (role === 'trend-momentum-analyst') throw new Error('spawn failed');
    return { ok: true, output: run(tool('harness_bar_briefing'), text(ANALYST_REPORT)), transcript: `/t/${role}` };
  };
  const roles = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'];
  const d = await runDesk({ roles, runRole, concurrency: 2, retries: 1, request: role => `req ${role}` });
  assert.ok(most <= 2, `at most 2 at once (${most})`);
  assert.deepStrictEqual(d.reports.map(r => r.role), ['market-structure-analyst', 'volume-liquidity-analyst', 'risk-manager']);
  assert.deepStrictEqual(d.reports.map(r => r.tries), [1, 2, 1]);
  assert.deepStrictEqual(d.missing, [{ role: 'trend-momentum-analyst', why: 'the run failed (spawn failed)', tries: 2 }]);
  assert.ok(calls.every(([role, req]) => req === `req ${role}`));
  assert.strictEqual(d.reports[0].transcript, '/t/market-structure-analyst');
  // A timed-out or failed run, and nothing to run.
  const t = await runDesk({ roles: ['risk-manager'], runRole: async () => ({ ok: false, timedOut: true, output: '' }), retries: 0 });
  assert.deepStrictEqual(t.missing, [{ role: 'risk-manager', why: 'timed out', tries: 1 }]);
  assert.deepStrictEqual(await runDesk({ roles: [], runRole: async () => { throw new Error('never'); } }), { reports: [], missing: [] });
});
