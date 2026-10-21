'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { deskFor, lookupsKeyOf } = require('../../scripts/lib/runner-wiring');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');
const RR = require('../../scripts/lib/trading/runner-roles');

const ROOT = path.resolve(__dirname, '..', '..');
const cfg = (o = {}) => validateConfig({ harness: 'opencode', premarketAt: '', symbols: ['MNQ'], ...o });

test('deskFor: the runner\'s desk only with a role runner, on a harness that runs a role on its own (Claude Code, opencode), in a full cycle', () => {
  const runRole = async () => ({});
  assert.strictEqual(deskFor({ home: tmpDir(), cfg: cfg(), root: ROOT }), null, 'no role runner: the head trader launches its desk');
  for (const harness of ['codex', 'qwen']) assert.strictEqual(deskFor({ home: tmpDir(), cfg: cfg({ harness }), root: ROOT, runRole }), null, `${harness}: its head trader launches its desk`);
  assert.strictEqual(typeof deskFor({ home: tmpDir(), cfg: cfg({ harness: 'claude' }), root: ROOT, runRole }).run, 'function', 'Claude Code: the runner runs it');
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
  const home = tmpDir();
  const t0 = Date.now();
  const desk = deskFor({ home, cfg: cfg(), root: ROOT, runRole, log: m => logs.push(m) });
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
  // Each role's run is in the cycle's role record (runner-roles.js), for the gate: its last attempt's wall-clock times,
  // its report and lookups, and whether it counted; `recorded` the roles it credits.
  const runs = RR.readRoleRuns(d.rolesFile);
  assert.strictEqual(path.dirname(d.rolesFile), path.join(home, 'logs'));
  assert.deepStrictEqual(runs.map(r => [r.role, r.ok]).sort(), [['risk-manager', true], ['trend-momentum-analyst', false], ['volume-liquidity-analyst', true]]);
  assert.deepStrictEqual(runs.find(r => r.role === 'risk-manager').lookups, ['position-sizing'], 'its own lookups, whatever the facts key');
  assert.ok(runs.every(r => r.start >= t0 && r.end >= r.start && r.end <= Date.now()), 'wall-clock ms');
  assert.deepStrictEqual(d.recorded.slice().sort(), ['risk-manager', 'volume-liquidity-analyst']);
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

test('the desk\'s record that can\'t be written credits none: logged, and the role is not recorded', async () => {
  const home = tmpDir();
  require('fs').writeFileSync(path.join(home, 'logs'), 'a file where the logs directory goes');
  const logs = [];
  const runRole = async () => ({ ok: true, text: '## Risk state: account 1', tools: ['broker_get_account_snapshot'] });
  const d = await deskFor({ home, cfg: cfg(), root: ROOT, runRole, log: m => logs.push(m) }).run({ symbols: [{ symbol: 'MNQ' }], roles: ['risk-manager'], now: new Date(), at: new Date().toISOString() });
  assert.deepStrictEqual([d.reports.length, d.recorded], [1, []]);
  assert.ok(logs.some(l => /risk-manager's run could not be recorded for the gate/.test(l)));
});

test('entryFor: the runner\'s entry only with a role runner, on a harness that runs a role on its own (Claude Code, opencode), in a full cycle, with a valid entry workflow; its record file is a fresh one under the home\'s logs', () => {
  const { entryFor } = require('../../scripts/lib/runner-wiring');
  const runRole = async () => ({});
  assert.strictEqual(entryFor({ home: tmpDir(), cfg: cfg(), root: ROOT }), null, 'no role runner: the head trader runs its entry');
  for (const harness of ['codex', 'qwen']) assert.strictEqual(entryFor({ home: tmpDir(), cfg: cfg({ harness }), root: ROOT, runRole }), null, `${harness}: its head trader runs its entry`);
  assert.strictEqual(typeof entryFor({ home: tmpDir(), cfg: cfg({ harness: 'claude' }), root: ROOT, runRole }).run, 'function', 'Claude Code: the runner runs it');
  assert.strictEqual(entryFor({ home: tmpDir(), cfg: cfg({ cycle: 'lean' }), root: ROOT, runRole }), null);
  assert.strictEqual(entryFor({ home: tmpDir(), cfg: cfg(), root: tmpDir(), runRole }), null, 'no entry workflow: none');
  const home = tmpDir();
  const e = entryFor({ home, cfg: cfg(), root: ROOT, runRole });
  assert.strictEqual(typeof e.run, 'function');
  assert.strictEqual(path.dirname(e.recordFile()), path.join(home, 'logs'));
  // The per-role timeout is config's (config/runner.json entry.timeoutMinutes).
  assert.ok(require('../../scripts/lib/tunables').runner().entry.timeoutMinutes >= 1);
});
