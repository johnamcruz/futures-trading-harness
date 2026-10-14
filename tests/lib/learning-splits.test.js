'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../../scripts/lib/learning/splits');
const prop = require('../../scripts/lib/prop/splits');

test('learning split: the owner\'s windows, contiguous, train and validate inside 2020-2024, test 2025, final 2026', () => {
  assert.deepStrictEqual(L.WINDOWS, {
    'practice-train': ['2020-01-01', '2024-07-01'], 'practice-validate': ['2024-07-01', '2025-01-01'],
    test: ['2025-01-01', '2026-01-01'], final: ['2026-01-01', '2027-01-01'],
  });
  const w = L.ROLES.map(r => L.WINDOWS[r]);
  for (let i = 1; i < w.length; i += 1) assert.strictEqual(w[i][0], w[i - 1][1], 'no gap, no overlap');
  assert.ok(Object.isFrozen(L.WINDOWS) && Object.isFrozen(L.WINDOWS.test));
  assert.deepStrictEqual([...L.SEALED], ['test', 'final']);
  // The prop schedule (the promotion gate's) is untouched.
  assert.deepStrictEqual(prop.SPLITS.train, ['2021-01-01', '2023-07-01']);
});

test('roleOf: session dates, timestamps by their session, and nothing outside the schedule', () => {
  assert.strictEqual(L.roleOf('2020-01-02'), 'practice-train');
  assert.strictEqual(L.roleOf('2024-06-28'), 'practice-train');
  assert.strictEqual(L.roleOf('2024-07-01'), 'practice-validate');
  assert.strictEqual(L.roleOf('2024-12-31'), 'practice-validate');
  assert.strictEqual(L.roleOf('2025-01-02'), 'test');
  assert.strictEqual(L.roleOf('2026-07-20'), 'final');
  // 2024-12-31 at 23:30 UTC is 18:30 ET: the 2025-01-02 session (the 1st is closed), so test, never validate.
  assert.strictEqual(L.roleOf(Date.parse('2024-12-31T23:30:00Z')), 'test');
  assert.strictEqual(L.roleOf(new Date('2024-12-31T15:00:00Z')), 'practice-validate');
  assert.throws(() => L.roleOf('2019-12-31'), /no learning role/);
  assert.throws(() => L.roleOf('2027-01-04'), /no learning role/);
  assert.throws(() => L.roleOf('2024-02-30'), /not an ISO date/);
  assert.throws(() => L.roleOf('2024-07'), /not an ISO date/);
});

test('assertUse: practice and the index take practice-train only; sealed months are refused by name', () => {
  assert.deepStrictEqual(L.assertUse('practice', '2021-03-01', '2021-04-01'), ['practice-train']);
  assert.deepStrictEqual(L.assertUse('index', '2020-01-01', '2024-07-01'), ['practice-train'], 'the whole window, to exclusive');
  assert.throws(() => L.assertUse('index', '2024-06-03', '2024-07-02'), /index refused: .*practice-validate/);
  assert.throws(() => L.assertUse('practice', '2025-03-03', '2025-03-08'), /practice refused: .*test \(sealed/);
  assert.throws(() => L.assertUse('index', '2026-06-01', '2026-06-06'), /sealed/);
  assert.throws(() => L.assertUse('practice', '2024-12-30', '2025-01-03'), /practice-validate, test/);
  assert.deepStrictEqual(L.assertUse('validate', '2024-07-01', '2025-01-01'), ['practice-validate']);
  assert.throws(() => L.assertUse('validate', '2024-06-28', '2024-07-03'), /validate refused: .*practice-train/);
  assert.throws(() => L.assertUse('training', '2021-03-01', '2021-04-01'), /no learning use/);
  assert.throws(() => L.assertUse('practice', '2021-03-01', '2021-03-01'), /empty range/);
  // Timestamps: a range ending inside a session holds that session.
  assert.throws(() => L.assertUse('practice', Date.parse('2024-06-28T14:00:00Z'), Date.parse('2024-07-01T14:00:00Z')), /practice-validate/);
});

const look = (from, to, purpose = 'judging', candidate = 'champion-a', runId = 'r1') => ({ candidate, purpose, from, to, runId });

test('sealed looks: test has three judging looks, final one; reasoning-fix spends none; a repeat is free', () => {
  const ledger = [];
  for (let i = 1; i <= 3; i += 1) {
    const r = L.checkSealedLook(look('2025-02-03', '2025-03-01', 'judging', 'c', `r${i}`), ledger);
    assert.ok(r.ok, r.refusals.join());
    assert.strictEqual(r.remaining, 4 - i);
    ledger.push(look('2025-02-03', '2025-03-01', 'judging', 'c', `r${i}`));
  }
  const fourth = L.checkSealedLook(look('2025-04-01', '2025-05-01', 'judging', 'c', 'r4'), ledger);
  assert.strictEqual(fourth.ok, false);
  assert.match(fourth.refusals[0], /test: its 3 look\(s\) are spent/);
  assert.ok(L.checkSealedLook(look('2025-02-03', '2025-03-01', 'judging', 'c', 'r2'), ledger).repeat, 'the same run again');
  assert.ok(L.checkSealedLook(look('2025-04-01', '2025-05-01', 'reasoning-fix', 'c', 'r5'), ledger).ok);
  // Final: the June 2026 replay is recorded (reasoning-fix: no spend); one judging look, then sealed.
  assert.strictEqual(L.checkSealedLook(look('2026-03-02', '2026-04-01'), []).remaining, 1);
  const done = [look('2026-03-02', '2026-04-01')];
  assert.match(L.checkSealedLook(look('2026-05-01', '2026-06-01', 'judging', 'x', 'r9'), done).refusals.join(), /final: its 1 look/);
});

test('sealed looks: refused outside test and final, across two windows, without a candidate, purpose or ledger', () => {
  assert.match(L.checkSealedLook(look('2023-02-01', '2023-03-01'), []).refusals.join(), /inside test or final alone, not practice-train/);
  assert.match(L.checkSealedLook(look('2025-12-01', '2026-01-10'), []).refusals.join(), /not test \+ final/);
  assert.match(L.checkSealedLook(look('2025-02-03', '2025-03-01', 'tuning'), []).refusals.join(), /purpose/);
  assert.match(L.checkSealedLook(look('2025-02-03', '2025-03-01', 'judging', ' '), []).refusals.join(), /candidate/);
  assert.match(L.checkSealedLook(look('2025-02-03', '2025-03-01'), null).refusals.join(), /ledger is required/);
  assert.match(L.checkSealedLook(look('2019-02-03', '2019-03-01'), []).refusals.join(), /no learning role/);
});

test('recordSealedLook: the ledger file, locked; a missing ledger is refused unless created; a repeat is not appended', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-learn-ledger-'));
  const file = path.join(dir, 'learning', 'looks.jsonl');
  assert.throws(() => L.recordSealedLook(file, look('2025-02-03', '2025-03-01')), /no ledger/);
  const a = L.recordSealedLook(file, look('2025-02-03', '2025-03-01'), { create: true, now: new Date('2026-10-14T00:00:00Z') });
  assert.deepStrictEqual([a.ok, a.appended, a.role], [true, true, 'test']);
  const b = L.recordSealedLook(file, look('2025-02-03', '2025-03-01'));
  assert.deepStrictEqual([b.repeat, b.appended], [true, false]);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual([lines[0].role, lines[0].candidate, lines[0].at], ['test', 'champion-a', '2026-10-14T00:00:00.000Z']);
  L.recordSealedLook(file, look('2026-02-02', '2026-03-02', 'judging', 'c', 'f1'));
  assert.throws(() => L.recordSealedLook(file, look('2026-03-02', '2026-04-01', 'judging', 'c', 'f2')), /sealed look refused: final/);
  assert.ok(!fs.existsSync(`${file}.lock`), 'the lock is released after a refusal');
  assert.strictEqual(L.ledgerPath({ FTH_HOME: dir }), path.join(dir, 'learning', 'looks.jsonl'));
});
