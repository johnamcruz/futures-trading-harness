'use strict';

// P1, the selection scorecard (scripts/lib/replay/selection-score.js): the pick table, every candidate by the model's
// decision x one ruler's R and points, with by-session intervals.

const test = require('node:test');
const assert = require('node:assert/strict');
const FP = require('../../scripts/lib/replay/selection-score');

test('pickTable (the SELECTION scorecard): took / enterNoOrder / waited / passed x the ruler\'s R and points (mean, median, total), the mean\'s by-session interval, took minus passed; unlabelled and unfilled counted; reproducible from its seed; config required', () => {
  const rows = [
    { key: 'a', day: 'd1', state: 'took', outcome: { R: 2, points: 20, filled: true } }, { key: 'b', day: 'd1', state: 'passed', outcome: { R: -1, points: -10, filled: true } },
    { key: 'c', day: 'd2', state: 'passed', outcome: { R: -1, points: -8, filled: true } }, { key: 'e', day: 'd2', state: 'took', outcome: { R: 1, points: 5, filled: true } },
    { key: 'w', day: 'd3', state: 'waited', outcome: { R: 0.5, points: 3, filled: true } }, { key: 'u', day: 'd3', state: 'unlabelled', outcome: null },
    { key: 'n', day: 'd3', state: 'enterNoOrder', outcome: { R: 3, points: 30, filled: true } }, { key: 'f', day: 'd4', state: 'passed', outcome: { R: 0, points: 0, filled: false } },
  ];
  const cfg = { reps: 500, seed: 7, ci: 0.9, minRows: 1, minSessions: 1 };
  const t = FP.pickTable(rows, cfg);
  assert.deepEqual([t.candidates, t.scored, t.unlabelled, t.unfilled], [8, 7, 1, 1]);
  assert.deepEqual([t.states.took.n, t.states.took.meanR, t.states.took.medianR, t.states.took.totalR, t.states.took.totalPts], [2, 1.5, 1.5, 3, 25]);
  assert.deepEqual([t.states.passed.n, t.states.passed.meanR, t.states.passed.meanPts, t.states.waited.n, t.states.enterNoOrder.n, t.states.enterNoOrder.meanR], [3, -0.67, -6, 1, 1, 3]);
  // took minus passed: (1.5) - (-2/3); an ENTER that placed no order is never a take
  assert.deepEqual([t.tookMinusPassed.R, t.tookMinusPassed.points], [2.17, 18.5]);
  assert.ok(t.tookMinusPassed.Rci[0] <= 2.17 && t.tookMinusPassed.Rci[1] >= 2.17, JSON.stringify(t.tookMinusPassed));
  assert.deepEqual(FP.pickTable(rows, cfg), t, 'the same seed, the same intervals');
  assert.throws(() => FP.pickTable(rows, {}), /reps, seed, ci, minRows and minSessions are required/);
  assert.throws(() => FP.pickTable(rows, { reps: 5, seed: 1, ci: 0.9 }), /minRows and minSessions/);
  assert.deepEqual(FP.pickTable([], cfg).states.took, { n: 0, sessions: 0, meanR: null, medianR: null, totalR: 0, meanPts: null, medianPts: null, totalPts: 0, meanRci: null, meanRdraws: 0 });
});

test('intervalOf: the two-sided interval is the (1-ci)/2 and (1+ci)/2 quantiles of the draws', () => {
  const xs = Array.from({ length: 100 }, (_, i) => 100 - i); // 1..100, unsorted
  assert.deepEqual(FP.intervalOf(xs, 0.9), [6, 96]);
  assert.deepEqual(FP.intervalOf(xs, 0.5), [26, 76]);
  assert.equal(FP.intervalOf([], 0.9), null);
});

test('pickTable gives no interval under the floor of rows and sessions (REVIEW-4 major 1): one take of +2.06R among 30 passed sessions has its mean, never an interval, and took minus passed none either; the floor and the draws used are reported', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ key: `p${i}`, day: `d${i}`, state: 'passed', outcome: { R: i % 3 ? -1 : 2, points: 1, filled: true } }));
  rows.push({ key: 't', day: 'd7', state: 'took', outcome: { R: 2.06, points: 20, filled: true } });
  const cfg = { reps: 400, seed: 3, ci: 0.9, minRows: 5, minSessions: 5 };
  const t = FP.pickTable(rows, cfg);
  assert.deepEqual([t.states.took.n, t.states.took.meanR, t.states.took.meanRci, t.states.took.meanRdraws], [1, 2.06, null, 0]);
  assert.deepEqual([t.tookMinusPassed.R, t.tookMinusPassed.Rci, t.tookMinusPassed.pointsCi, t.tookMinusPassed.draws], [2.06, null, null, 0]);
  assert.deepEqual(t.floor, { minRows: 5, minSessions: 5 });
  assert.ok(Array.isArray(t.states.passed.meanRci) && t.states.passed.meanRdraws === 400, 'the passed cell is over the floor');
  // Five takes in five sessions: over the floor, an interval, and the draws used (a draw with no take is never counted).
  for (let i = 0; i < 4; i += 1) rows.push({ key: `t${i}`, day: `d${i * 5 + 1}`, state: 'took', outcome: { R: -1, points: -5, filled: true } });
  const u = FP.pickTable(rows, cfg);
  assert.ok(Array.isArray(u.states.took.meanRci) && Array.isArray(u.tookMinusPassed.Rci));
  assert.equal(u.tookMinusPassed.draws, 399, 'one of the 400 draws held no take session: it is not counted (seed 3)');
  // four takes, or five takes in four sessions: under the floor again
  assert.equal(FP.pickTable(rows.slice(0, -1), cfg).tookMinusPassed.Rci, null);
  assert.equal(FP.pickTable(rows.map(r => (r.key === 't0' ? { ...r, day: 'd7' } : r)), cfg).states.took.meanRci, null);
});
