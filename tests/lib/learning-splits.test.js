'use strict';

const test = require('node:test');
const assert = require('node:assert');
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

