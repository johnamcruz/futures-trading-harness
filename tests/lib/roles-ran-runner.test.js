'use strict';

// The roles the runner ran itself (its role record, runner-roles.js) judged with the transcript's calls (roles-ran.js):
// the same ordering, verdict and lookup rules; fails closed on a record that isn't there.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ANALYSTS, checkRolesRan, approvedPhase2, assessRound, cycleCalls, withRunnerRuns, roleCalls } = require('../../scripts/lib/trading/roles-ran');
const RR = require('../../scripts/lib/trading/runner-roles');
const { tmpDir } = require('../helpers');

const T = 1.7e12; // wall-clock ms: opencode's call times and the runner's record share the clock
const oc = (subagent_type, [start, end], output = 'VERDICT: APPROVE - size 1') => JSON.stringify({
  type: 'tool_use', timestamp: 1, sessionID: 'ses_main',
  part: { type: 'tool', tool: 'task', state: { status: 'completed', input: { description: 'x', prompt: 'y', subagent_type }, output: `<task id="s" state="completed"><task_result>${output}</task_result></task>`, time: { start, end } } },
});
const run = (role, [start, end], o = {}) => ({ role, start: T + start, end: T + end, text: o.text || (role === 'risk-manager' ? '## Risk state: account 1' : `## ${role}\nBias: long`), lookups: o.lookups || [], ok: o.ok !== false });
// The runner's desk: the three analysts and risk-manager phase 1, 0-1000 ms.
const DESK = [...ANALYSTS.map(r => run(r, [0, 1000])), run('risk-manager', [0, 800])];
const P2 = 'risk-manager phase 2 (a second call, started after phase 1';

/** A cycle: the record's runs and the transcript's lines, written as the runner writes them. */
function cycle(runs, lines) {
  const dir = tmpDir();
  const transcript = path.join(dir, 'cycle-transcript.jsonl');
  fs.writeFileSync(transcript, lines.join('\n'));
  const rolesFile = path.join(dir, 'cycle-roles.jsonl');
  for (const r of runs) RR.appendRoleRun(rolesFile, r);
  return { transcript, rolesFile };
}
const phase2 = ([s, e], verdict = 'APPROVE') => oc('risk-manager', [T + s, T + e], `Phase 2.\nVERDICT: ${verdict} - size 1`);

test('the runner\'s desk counts as the roles\' calls: phase 2 in the transcript after it completes the round and approves', () => {
  const c = cycle(DESK, [phase2([2000, 3000])]);
  assert.strictEqual(checkRolesRan(c.transcript, 'full', [], null, c.rolesFile), null);
  assert.match(approvedPhase2(c.transcript, 'full', [], null, c.rolesFile).text, /VERDICT: APPROVE/);
  // Control: without the record the same transcript lacks every desk role.
  assert.match(checkRolesRan(c.transcript, 'full', [], null, null), /not returned yet: market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst/);
});

test('the same ordering: phase 2 starting before the runner\'s phase 1 ended, or before a runner analyst ended, doesn\'t count', () => {
  const early = cycle(DESK, [phase2([500, 3000])]);
  assert.match(checkRolesRan(early.transcript, 'full', [], null, early.rolesFile), new RegExp(`not returned yet: ${P2.replace(/[()]/g, '\\$&')}`));
  assert.strictEqual(approvedPhase2(early.transcript, 'full', [], null, early.rolesFile), null);
  // Phase 1 ended at 800, an analyst at 1500: phase 2 at 900 reviews no plan built from that analyst's report.
  const slow = [...DESK.slice(0, 2), run(ANALYSTS[2], [0, 1500]), DESK[3]];
  const beforeAnalyst = cycle(slow, [phase2([900, 3000])]);
  assert.match(checkRolesRan(beforeAnalyst.transcript, 'full', [], null, beforeAnalyst.rolesFile), /risk-manager phase 2/);
  const after = cycle(slow, [phase2([1600, 3000])]);
  assert.strictEqual(checkRolesRan(after.transcript, 'full', [], null, after.rolesFile), null);
});

test('a runner-run phase 2 is judged by its report: a VETO refuses, an APPROVE passes; a failed run is no call', () => {
  const veto = cycle([...DESK, run('risk-manager', [2000, 3000], { text: 'Phase 2.\nVERDICT: VETO - no room' })], []);
  assert.match(checkRolesRan(veto.transcript, 'full', [], null, veto.rolesFile), /its latest verdict is not "VERDICT: APPROVE"/);
  assert.strictEqual(approvedPhase2(veto.transcript, 'full', [], null, veto.rolesFile), null);
  const ok = cycle([...DESK, run('risk-manager', [2000, 3000], { text: 'Phase 2.\nVERDICT: APPROVE - size 1' })], []);
  assert.strictEqual(checkRolesRan(ok.transcript, 'full', [], null, ok.rolesFile), null);
  // A later runner veto (uncounted: it started before phase 1 ended) still refuses the transcript's approval.
  const late = cycle([...DESK, run('risk-manager', [700, 4000], { text: 'VERDICT: VETO' })], [phase2([2000, 3000])]);
  assert.match(checkRolesRan(late.transcript, 'full', [], null, late.rolesFile), /not "VERDICT: APPROVE"/);
  const failed = cycle([...DESK.slice(0, 3), run('risk-manager', [0, 800], { ok: false })], [phase2([2000, 3000])]);
  assert.match(checkRolesRan(failed.transcript, 'full', [], null, failed.rolesFile), /risk-manager phase 2/, 'phase 1 failed: the transcript\'s call is phase 1, no phase 2');
});

test('index mode: a runner run counts only with the lookups its role\'s bar requires, as a task call', () => {
  // The rule's shape (skill-lookups.js lookupRule): the market-structure analyst must have looked up breakout.
  const rule = c => (c.role === ANALYSTS[0] && !(Array.isArray(c.lookups) && c.source === 'runner' && c.lookups.includes('breakout')) ? ['breakout'] : []);
  const without = cycle(DESK, [phase2([2000, 3000])]);
  const msg = checkRolesRan(without.transcript, 'full', [], rule, without.rolesFile);
  assert.match(msg, /not returned yet: market-structure-analyst/);
  assert.match(msg, /market-structure-analyst reported without looking up breakout/);
  const withIt = cycle([run(ANALYSTS[0], [0, 1000], { lookups: ['breakout'] }), ...DESK.slice(1)], [phase2([2000, 3000])]);
  assert.strictEqual(checkRolesRan(withIt.transcript, 'full', [], rule, withIt.rolesFile), null);
  // The real rule reads the runner's lookups the same way (skill-lookups.test.js); the call reaching it is the runner's.
  const seen = [];
  checkRolesRan(withIt.transcript, 'full', [], c => { seen.push(c); return []; }, withIt.rolesFile);
  assert.ok(seen.some(c => c.role === ANALYSTS[0] && RR.isRunnerCall(c) && c.lookups.includes('breakout')));
});

test('a recorded trade-executor run ends the round as a transcript launch does: the desk before it counts no more', () => {
  const c = cycle([...DESK, run('trade-executor', [3500, 4000], { text: '', ok: false })], [phase2([2000, 3000]), phase2([5000, 6000])]);
  assert.match(checkRolesRan(c.transcript, 'full', [], null, c.rolesFile), /not returned yet: market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst/);
  // A transcript launch after the desk ends it too.
  const t = cycle(DESK, [phase2([2000, 3000]), oc('trade-executor', [T + 3500, T + 4000], 'placed'), phase2([5000, 6000])]);
  assert.match(checkRolesRan(t.transcript, 'full', [], null, t.rolesFile), /not returned yet: market-structure-analyst/);
});

test('fails closed: a missing, unreadable or torn record adds nothing; transcript calls without wall-clock times can\'t be ordered against it', () => {
  const c = cycle(DESK, [phase2([2000, 3000])]);
  assert.match(checkRolesRan(c.transcript, 'full', [], null, path.join(path.dirname(c.rolesFile), 'none.jsonl')), /not returned yet: market-structure-analyst/);
  assert.match(checkRolesRan(c.transcript, 'full', [], null, path.dirname(c.rolesFile)), /not returned yet: market-structure-analyst/, 'a directory');
  fs.writeFileSync(c.rolesFile, fs.readFileSync(c.rolesFile, 'utf8').split('\n').map(l => l.slice(0, 20)).join('\n'));
  assert.match(checkRolesRan(c.transcript, 'full', [], null, c.rolesFile), /not returned yet: market-structure-analyst/, 'every line torn');
  // A transcript call timed by line position, beside the record: refused.
  const untimed = JSON.stringify({ type: 'tool_use', part: { tool: 'task', state: { status: 'completed', input: { subagent_type: 'risk-manager' }, output: 'VERDICT: APPROVE' } } });
  const u = cycle(DESK, [untimed]);
  assert.match(checkRolesRan(u.transcript, 'full', [], null, u.rolesFile), /without wall-clock times/);
  assert.strictEqual(approvedPhase2(u.transcript, 'full', [], null, u.rolesFile), null);
  // A Claude launch (line positions) beside the record ends every round.
  const found = withRunnerRuns({ calls: [], launches: [{ start: 3, end: 4, background: false }] }, DESK);
  assert.deepStrictEqual(found.launches[0], { start: Infinity, end: Infinity, background: false });
  assert.match(assessRound(found, 'full').missing.join(', '), /market-structure-analyst/);
  // No record: the transcript is judged as it always was.
  assert.strictEqual(cycleCalls([phase2([1, 2])].join('\n'), null).unordered, undefined);
  assert.deepStrictEqual(cycleCalls('', null), roleCalls(''));
});
