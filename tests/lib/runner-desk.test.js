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

test('the desk\'s results carry each role run\'s own skills record (role-skills-record.js), and skillsMissing names the roles lacking any; a failed run\'s too', async () => {
  const { withSkillsMissing } = require('../../scripts/lib/role-skills-record');
  const rec = missing => ({ expected: ['a', 'b'], embedded: [], loaded: ['a', 'b'].filter(s => !missing.includes(s)), had: ['a', 'b'].filter(s => !missing.includes(s)), missing });
  const runRole = async role => (role === 'risk-manager'
    ? { ok: true, text: '## Risk state: account 1', tools: ['broker_get_account_snapshot'], skills: rec(['b']) }
    : { ok: false, text: '', tools: [], skills: rec(['a', 'b']) });
  const desk = deskFor({ home: tmpDir(), cfg: cfg(), root: ROOT, runRole });
  const now = new Date('2026-10-07T14:03:02Z');
  const d = await desk.run({ symbols: [{ symbol: 'MNQ' }], roles: ['volume-liquidity-analyst', 'risk-manager'], now, at: now.toISOString() });
  assert.deepStrictEqual(d.results.map(r => [r.role, r.skills.missing]), [['volume-liquidity-analyst', ['a', 'b']], ['risk-manager', ['b']]]);
  assert.deepStrictEqual(withSkillsMissing(d.results), { skillsMissing: { 'volume-liquidity-analyst': ['a', 'b'], 'risk-manager': ['b'] } });
  // A run that returns no record: none in its result (as before).
  const bare = deskFor({ home: tmpDir(), cfg: cfg(), root: ROOT, runRole: async () => ({ ok: true, text: '## Risk state', tools: ['broker_get_account_snapshot'] }) });
  const b = await bare.run({ symbols: [{ symbol: 'MNQ' }], roles: ['risk-manager'], now, at: now.toISOString() });
  assert.deepStrictEqual([Object.keys(b.results[0]).includes('skills'), withSkillsMissing(b.results)], [false, {}]);
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
  // Phase 2 at the compose (entry.overlapPhase2): on where the desk runs two or more at once; a machine whose model
  // server answers one at a time (deskConcurrency 1) or a caller's `overlap: false` runs phase 2 after the head trader.
  assert.strictEqual(require('../../scripts/lib/tunables').runner().entry.overlapPhase2, true);
  assert.strictEqual(typeof e.overlap, 'function');
  assert.strictEqual(typeof entryFor({ home, cfg: cfg({ deskConcurrency: 2 }), root: ROOT, runRole }).overlap, 'function');
  assert.strictEqual(entryFor({ home, cfg: cfg({ deskConcurrency: 1 }), root: ROOT, runRole }).overlap, undefined);
  assert.strictEqual(entryFor({ home, cfg: cfg(), root: ROOT, runRole, overlap: false }).overlap, undefined);
});

test('the desk\'s concurrency: config/runner.json\'s, lowered by the runner config\'s deskConcurrency (this machine\'s); a higher or invalid value is refused', async () => {
  const { deskConcurrencyOf } = require('../../scripts/lib/runner-wiring');
  const committed = require('../../scripts/lib/tunables').runner().desk.concurrency;
  assert.ok(committed >= 2, 'the committed value runs roles at once (this test lowers it)');
  // The most roles in flight at once, the four desk roles each taking a moment.
  const inFlight = async c => {
    let now = 0;
    let most = 0;
    const runRole = async () => {
      now += 1; most = Math.max(most, now);
      await new Promise(r => setTimeout(r, 20));
      now -= 1;
      return { ok: true, text: 'Data: bar_briefing m3@1\nBias: long', tools: ['harness_bar_briefing'] };
    };
    const at = new Date();
    await deskFor({ home: tmpDir(), cfg: c, root: ROOT, runRole }).run({ symbols: [{ symbol: 'MNQ' }], roles: ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'], now: at, at: at.toISOString() });
    return most;
  };
  // Absent (or null): the harness's own default (config/runner.json desk.harnessConcurrency): Claude Code the committed
  // value, the whole desk at once; opencode (a local model server) 2.
  const byHarness = require('../../scripts/lib/tunables').runner().desk.harnessConcurrency;
  assert.deepStrictEqual([committed, byHarness], [4, { opencode: 2 }]);
  assert.strictEqual(deskConcurrencyOf(cfg({ harness: 'claude' })), committed);
  assert.strictEqual(await inFlight(cfg({ harness: 'claude' })), committed);
  assert.strictEqual(cfg().deskConcurrency, 2, 'opencode: its own default, set when the key is absent');
  assert.strictEqual(deskConcurrencyOf(cfg()), 2);
  assert.strictEqual(await inFlight(cfg()), 2);
  assert.strictEqual(cfg({ deskConcurrency: null }).deskConcurrency, 2, 'null is absent');
  // Lowered: one at a time.
  assert.strictEqual(deskConcurrencyOf(cfg({ deskConcurrency: 1 })), 1);
  assert.strictEqual(await inFlight(cfg({ deskConcurrency: 1 })), 1);
  assert.strictEqual(deskConcurrencyOf(cfg({ deskConcurrency: committed })), committed);
  // Higher than the committed value, or not a whole number from 1: the runner config is refused (no run starts).
  for (const bad of [committed + 1, 0, -1, 1.5, '1', true, {}]) {
    assert.throws(() => cfg({ deskConcurrency: bad }), /deskConcurrency: a whole number from 1 to \d+ \(config\/runner\.json desk\.concurrency; this machine may only lower it\)/, JSON.stringify(bad));
    assert.throws(() => deskConcurrencyOf({ deskConcurrency: bad }), /deskConcurrency/, JSON.stringify(bad));
  }
});

test('deskOnManagedCycles (this machine\'s opt-in): absent by default; true or false accepted; anything else refuses the runner config', () => {
  assert.strictEqual(cfg().deskOnManagedCycles, undefined, 'absent: a managed cycle runs as before');
  assert.strictEqual(cfg({ harness: 'claude' }).deskConcurrency, undefined, 'absent on Claude Code: the committed concurrency');
  for (const ok of [true, false]) assert.strictEqual(cfg({ deskOnManagedCycles: ok }).deskOnManagedCycles, ok);
  for (const bad of ['true', 1, null, {}]) assert.throws(() => cfg({ deskOnManagedCycles: bad }), /deskOnManagedCycles: true or false, or absent/, JSON.stringify(bad));
});

test('deskConcurrency null is the committed value (as absent); managedDeskNote: a line only where deskOnManagedCycles does nothing', () => {
  const { deskConcurrencyOf, managedDeskNote } = require('../../scripts/lib/runner-wiring');
  const committed = require('../../scripts/lib/tunables').runner().desk.concurrency;
  assert.strictEqual(cfg({ harness: 'claude', deskConcurrency: null }).deskConcurrency, null, 'accepted');
  assert.strictEqual(deskConcurrencyOf(cfg({ harness: 'claude', deskConcurrency: null })), committed);
  assert.strictEqual(managedDeskNote(cfg()), null, 'absent: nothing said');
  assert.strictEqual(managedDeskNote(cfg({ harness: 'claude', deskOnManagedCycles: false })), null);
  assert.strictEqual(managedDeskNote(cfg({ harness: 'claude', deskOnManagedCycles: true })), null, 'where it applies: nothing said');
  for (const o of [{ harness: 'opencode' }, { harness: 'codex' }, { harness: 'qwen' }, { harness: 'claude', cycle: 'lean' }]) {
    assert.match(managedDeskNote(cfg({ ...o, deskOnManagedCycles: true })), /deskOnManagedCycles is set but does nothing here/, JSON.stringify(o));
  }
  // Said once, at the runner's start (deskFor), never a refusal.
  const logs = [];
  deskFor({ home: tmpDir(), cfg: cfg({ harness: 'codex', deskOnManagedCycles: true }), root: ROOT, log: m => logs.push(m) });
  assert.strictEqual(logs.filter(l => /deskOnManagedCycles/.test(l)).length, 1);
});

test('the desk\'s results keep each role\'s report: an accepted one\'s text; a rejected one\'s every attempt with why the checks refused it; cut at prompt.reportMaxText', async () => {
  const max = require('../../scripts/lib/tunables').runner().prompt.reportMaxText;
  let n = 0;
  const runRole = async role => {
    if (role === 'risk-manager') return { ok: true, text: '## Risk state: account 1', tools: ['broker_get_account_snapshot'] };
    n += 1;
    // The analyst never names its data: rejected on each attempt (the second over the limit).
    return { ok: true, text: n === 1 ? 'Bias: long' : `Bias: long ${'x'.repeat(max)}`, tools: ['harness_bar_briefing'] };
  };
  const desk = deskFor({ home: tmpDir(), cfg: cfg(), root: ROOT, runRole });
  const now = new Date('2026-10-07T14:03:02Z');
  const d = await desk.run({ symbols: [{ symbol: 'MNQ' }], roles: ['volume-liquidity-analyst', 'risk-manager'], now, at: now.toISOString() });
  const rm = d.results.find(r => r.role === 'risk-manager');
  assert.deepStrictEqual([rm.stop, rm.text, 'tries' in rm], ['completed', '## Risk state: account 1', false]);
  const va = d.results.find(r => r.role === 'volume-liquidity-analyst');
  assert.strictEqual(va.stop, 'invalid');
  assert.strictEqual(va.tries.length, va.attempts, 'one per attempt, bounded by the workflow\'s retries');
  assert.ok(va.attempts >= 2);
  assert.deepStrictEqual(va.tries[0], { text: 'Bias: long', rejected: d.missing[0].why });
  assert.match(va.tries[0].rejected, /no Data line/);
  assert.deepStrictEqual([va.tries[1].text.length, va.tries[1].cut, va.cut, va.text.length], [max, true, true, max]);
});
