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
  const cfg = { reps: 500, seed: 7, ci: 0.9 };
  const t = FP.pickTable(rows, cfg);
  assert.deepEqual([t.candidates, t.scored, t.unlabelled, t.unfilled], [8, 7, 1, 1]);
  assert.deepEqual([t.states.took.n, t.states.took.meanR, t.states.took.medianR, t.states.took.totalR, t.states.took.totalPts], [2, 1.5, 1.5, 3, 25]);
  assert.deepEqual([t.states.passed.n, t.states.passed.meanR, t.states.passed.meanPts, t.states.waited.n, t.states.enterNoOrder.n, t.states.enterNoOrder.meanR], [3, -0.67, -6, 1, 1, 3]);
  // took minus passed: (1.5) - (-2/3); an ENTER that placed no order is never a take
  assert.deepEqual([t.tookMinusPassed.R, t.tookMinusPassed.points], [2.17, 18.5]);
  assert.ok(t.tookMinusPassed.Rci[0] <= 2.17 && t.tookMinusPassed.Rci[1] >= 2.17, JSON.stringify(t.tookMinusPassed));
  assert.deepEqual(FP.pickTable(rows, cfg), t, 'the same seed, the same intervals');
  assert.throws(() => FP.pickTable(rows, {}), /reps, seed and ci are required/);
  assert.deepEqual(FP.pickTable([], cfg).states.took, { n: 0, meanR: null, medianR: null, totalR: 0, meanPts: null, medianPts: null, totalPts: 0, meanRci: null });
});

test('intervalOf: the two-sided interval is the (1-ci)/2 and (1+ci)/2 quantiles of the draws', () => {
  const xs = Array.from({ length: 100 }, (_, i) => 100 - i); // 1..100, unsorted
  assert.deepEqual(FP.intervalOf(xs, 0.9), [6, 96]);
  assert.deepEqual(FP.intervalOf(xs, 0.5), [26, 76]);
  assert.equal(FP.intervalOf([], 0.9), null);
});
