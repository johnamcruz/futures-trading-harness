'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('../../scripts/lib/learning/looks');

const look = (from, to, o = {}) => ({ evaluation: 'ev1', candidate: 'champ', purpose: 'judging', runId: 'r1', from, to, ...o });
const TEST = ['2025-02-03', '2025-03-01'];
const FINAL = ['2026-03-02', '2026-04-01'];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-learn-looks-'));

test('the owner\'s defaults: test 3 looks per evaluation, final 1 after a test pass', () => {
  assert.deepStrictEqual(K.LOOK_BUDGETS, { test: 3, final: 1 });
  assert.strictEqual(K.FINAL_NEEDS_TEST_PASS, true);
  assert.deepStrictEqual([...K.PURPOSES], ['judging', 'reasoning-fix', 'validate']);
});

test('test: the arms of one evaluation share a look; three evaluations spend it; a fourth is refused', () => {
  const ledger = [];
  for (const arm of ['with', 'without', 'shuffled']) {
    const r = K.checkLook(look(...TEST, { runId: `ev1-${arm}` }), ledger);
    assert.ok(r.ok, r.refusals.join());
    ledger.push({ kind: 'look', ...look(...TEST, { runId: `ev1-${arm}` }), role: 'test' });
  }
  assert.strictEqual(K.checkLook(look(...TEST, { runId: 'x' }), ledger).spent, 1, 'three arms, one look');
  for (const ev of ['ev2', 'ev3']) ledger.push({ kind: 'look', ...look(...TEST, { evaluation: ev, runId: ev }), role: 'test' });
  const fourth = K.checkLook(look(...TEST, { evaluation: 'ev4', runId: 'ev4' }), ledger);
  assert.deepStrictEqual([fourth.ok, fourth.spent, fourth.remaining], [false, 3, 0]);
  assert.match(fourth.refusals[0], /test: its 3 look\(s\) are spent \(counted per evaluation\)/);
  const arm = K.checkLook(look(...TEST, { evaluation: 'ev2', runId: 'ev2-shuffled' }), ledger);
  assert.deepStrictEqual([arm.ok, arm.shared], [true, true], 'another arm of a spent evaluation runs');
  assert.strictEqual(K.checkLook(look(...TEST, { evaluation: 'ev2', runId: 'ev2' }), ledger).repeat, true);
  // Reasoning-fix: free, outcomes hidden.
  const fix = K.checkLook(look(...TEST, { evaluation: 'fix1', runId: 'fix1', purpose: 'reasoning-fix' }), ledger);
  assert.deepStrictEqual([fix.ok, fix.hideOutcomes], [true, true]);
});

test('final: one look, only for a candidate with a test pass; the June 2026 replay is recorded and free', () => {
  const noPass = K.checkLook(look(...FINAL), []);
  assert.strictEqual(noPass.ok, false);
  assert.match(noPass.refusals.join(), /final: candidate champ has no test pass/);
  const passed = [{ kind: 'result', evaluation: 'ev1', candidate: 'champ', role: 'test', result: 'pass' }];
  assert.deepStrictEqual([K.checkLook(look(...FINAL), passed).ok, K.checkLook(look(...FINAL), passed).remaining], [true, 1]);
  assert.strictEqual(K.checkLook(look(...FINAL), [{ ...passed[0], result: 'fail' }]).ok, false);
  assert.strictEqual(K.checkLook(look(...FINAL), [{ ...passed[0], candidate: 'other' }]).ok, false);
  const spent = [...passed, { kind: 'look', ...look(...FINAL, { evaluation: 'fin1', runId: 'fin1' }), role: 'final' }];
  assert.match(K.checkLook(look(...FINAL, { evaluation: 'fin2', runId: 'fin2' }), spent).refusals.join(), /final: its 1 look/);
  assert.ok(K.checkLook(look(...FINAL, { evaluation: 'fin1', runId: 'fin1-without' }), spent).ok, 'its other arms');
});

test('validate: counted, never budgeted; purposes per window; refusals', () => {
  const v = K.checkLook(look('2024-08-01', '2024-09-03', { purpose: 'validate' }), []);
  assert.deepStrictEqual([v.ok, v.role, v.budget, v.spent], [true, 'practice-validate', null, null]);
  assert.match(K.checkLook(look('2024-08-01', '2024-09-03'), []).refusals.join(), /practice-validate takes validate looks only/);
  assert.match(K.checkLook(look(...TEST, { purpose: 'validate' }), []).refusals.join(), /test is sealed/);
  assert.match(K.checkLook(look('2023-02-01', '2023-03-01'), []).refusals.join(), /practice-train is practice: no look/);
  assert.match(K.checkLook(look('2025-12-01', '2026-01-10'), []).refusals.join(), /inside one window, not test \+ final/);
  assert.match(K.checkLook(look(...TEST, { evaluation: '' }), []).refusals.join(), /evaluation id/);
  assert.match(K.checkLook(look(...TEST, { candidate: ' ' }), []).refusals.join(), /candidate/);
  assert.match(K.checkLook(look(...TEST, { purpose: 'tuning' }), []).refusals.join(), /purpose/);
  assert.match(K.checkLook(look(...TEST), null).refusals.join(), /ledger is required/);
  const usage = K.lookUsage([{ kind: 'look', ...look('2024-08-01', '2024-09-03', { purpose: 'validate' }), role: 'practice-validate' }, { kind: 'look', ...look(...TEST), role: 'test' }, { kind: 'look', ...look(...TEST, { runId: 'r2' }), role: 'test' }]);
  assert.deepStrictEqual(usage['practice-validate'], { looks: 1, runs: 1, evaluations: 0 });
  assert.deepStrictEqual(usage.test, { looks: 2, runs: 2, evaluations: 1 });
  assert.deepStrictEqual(usage.final, { looks: 1, runs: 1, evaluations: 0 }, 'the recorded June 2026 replay');
});

test('recordLook and recordResult: the file under its lock; a missing ledger only on purpose; a result follows its look', () => {
  const file = path.join(tmp(), 'learning', 'looks.jsonl');
  assert.throws(() => K.recordLook(file, look(...TEST)), /no ledger/);
  const a = K.recordLook(file, look(...TEST), { create: true, now: new Date('2026-10-14T00:00:00Z') });
  assert.deepStrictEqual([a.ok, a.appended, a.role], [true, true, 'test']);
  assert.strictEqual(K.recordLook(file, look(...TEST)).appended, false, 'a resume');
  assert.throws(() => K.recordResult(file, { evaluation: 'nope', candidate: 'champ', result: 'pass' }), /a result follows its look/);
  assert.throws(() => K.recordResult(file, { evaluation: 'ev1', candidate: 'champ', result: 'maybe' }), /pass or fail/);
  K.recordResult(file, { evaluation: 'ev1', candidate: 'champ', result: 'pass' });
  assert.strictEqual(K.recordLook(file, look(...FINAL, { evaluation: 'fin', runId: 'fin' })).role, 'final');
  assert.throws(() => K.recordLook(file, look(...FINAL, { evaluation: 'fin2', runId: 'fin2' })), /look refused: final/);
  assert.ok(!fs.existsSync(`${file}.lock`));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(lines.map(l => [l.kind, l.role]), [['look', 'test'], ['result', 'test'], ['look', 'final']]);
  assert.strictEqual(K.ledgerPath({ FTH_HOME: '/h' }), path.join('/h', 'learning', 'looks.jsonl'));
});
