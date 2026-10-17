'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { deskFor, lookupsKeyOf } = require('../../scripts/lib/runner-wiring');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const cfg = (o = {}) => validateConfig({ harness: 'opencode', premarketAt: '', symbols: ['MNQ'], ...o });

test('deskFor: the runner\'s desk only with a role runner, on opencode, in a full cycle', () => {
  const runRole = async () => ({});
  assert.strictEqual(deskFor({ home: tmpDir(), cfg: cfg(), root: ROOT }), null, 'no role runner: the head trader launches its desk');
  assert.strictEqual(deskFor({ home: tmpDir(), cfg: cfg({ harness: 'claude' }), root: ROOT, runRole }), null);
  assert.strictEqual(deskFor({ home: tmpDir(), cfg: cfg({ cycle: 'lean' }), root: ROOT, runRole }), null);
  assert.strictEqual(typeof deskFor({ home: tmpDir(), cfg: cfg(), root: ROOT, runRole }).run, 'function');
  assert.strictEqual(lookupsKeyOf(tmpDir(), { MNQ: null }, [{ symbol: 'MNQ' }], new Date(), {}), null, 'no briefing: no lookups key');
});

test('the desk runs the roles still to run with their request; a report counts only from a run that read data; a role that fails is missing', async () => {
  const seen = [];
  const runRole = async (role, request, { timeoutMs, context }) => {
    seen.push({ role, request, timeoutMs, context });
    if (role === 'trend-momentum-analyst') return { ok: true, text: 'Data: bar_briefing m3@1\nBias: long', tools: ['harness_skill_lookup'] }; // no data read
    if (role === 'risk-manager') return { ok: true, text: '## Risk state: account 1', tools: ['broker_get_account_snapshot'], lookups: ['position-sizing'] };
    return { ok: true, text: 'Data: bar_briefing m3@1\nBias: long', tools: ['harness_bar_briefing'] };
  };
  const logs = [];
  const desk = deskFor({ home: tmpDir(), cfg: cfg(), root: ROOT, runRole, log: m => logs.push(m) });
  const now = new Date('2026-10-07T14:03:02Z');
  const context = { action: 'trade', symbols: [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:00:00.000Z' } }] };
  const d = await desk.run({ symbols: [{ symbol: 'MNQ', contractId: 'MNQ' }], roles: ['trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'], now, at: now.toISOString(), context });
  assert.ok(seen.every(s => s.context === context), 'each role runs with the cycle\'s own context (its bars)');
  assert.deepStrictEqual(seen.map(s => s.role).sort(), ['risk-manager', 'trend-momentum-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst'], 'only the roles still to run; the one that read nothing tried again');
  assert.ok(seen.every(s => /MNQ/.test(s.request) && s.timeoutMs === require('../../scripts/lib/tunables').runner().desk.timeoutMinutes * 60000));
  assert.deepStrictEqual(d.reports.map(r => [r.role, r.source, r.at]), [['volume-liquidity-analyst', 'desk', now.toISOString()], ['risk-manager', 'desk', now.toISOString()]]);
  assert.deepStrictEqual(d.reports[1].lookups, [], 'no lookups key (no briefing): no lookups credited');
  assert.deepStrictEqual(d.missing, [{ role: 'trend-momentum-analyst', stop: 'invalid', why: 'read no data' }]);
  assert.ok(logs.some(l => /the desk: trend-momentum-analyst invalid \(read no data\)/.test(l)));
  // The cycle's budget, spent: a role not yet started is cancelled, never run.
  const stop = new AbortController();
  stop.abort();
  const late = await desk.run({ symbols: [{ symbol: 'MNQ' }], roles: ['risk-manager'], now, at: now.toISOString(), signal: stop.signal });
  assert.deepStrictEqual(late.missing, [{ role: 'risk-manager', stop: 'cancelled', why: 'the run was cancelled' }]);
  // A budget shorter than a role's own timeout bounds each role's run.
  seen.length = 0;
  await desk.run({ symbols: [{ symbol: 'MNQ' }], roles: ['risk-manager'], now, at: now.toISOString(), budgetMs: 90000 });
  assert.strictEqual(seen[0].timeoutMs, 90000);
});
