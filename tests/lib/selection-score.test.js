'use strict';

// P1, the selection scorecard (scripts/lib/replay/selection-score.js): the pick table (primary), and the legs table
// (secondary), which scores a run leg-first from its trend
// legs (eval/goal-metrics.js trendLegs, reused), its MTF entries (rank, trigger, exit, who exited) and the model's picks
// (each cycle's chosen MTF candidate, taken or passed). Synthetic records for each measure, one real fixture's legs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const FP = require('../../scripts/lib/replay/selection-score');

const T = (hm, day = '2026-10-07') => new Date(`${day}T${hm}:00.000Z`).toISOString();
// Two long legs (from 100 to 140, 40 points; and 200 to 260, 60 points) and a short one (300 to 270, 30 points); 1R = 10.
const LEGS = [
  { id: 'L1', day: '2026-10-07', side: 'long', start: T('14:00'), end: T('15:00'), from: 100, to: 140, points: 40 },
  { id: 'L2', day: '2026-10-07', side: 'long', start: T('15:30'), end: T('16:00'), from: 200, to: 260, points: 60 },
  { id: 'L3', day: '2026-10-07', side: 'short', start: T('14:00'), end: T('14:30'), from: 300, to: 270, points: 30 },
  { id: 'L4', day: '2026-10-07', side: 'long', start: T('16:10'), end: T('16:20'), from: 400, to: 415, points: 15 },
];
const E = o => ({ side: 'long', rank: 1, riskPts: 10, exitBy: 'trail', ...o });

test('legs: 2R+ only (points over the reference risk); an entry its way inside the leg enters it; at rank #1 and how early (entry lag)', () => {
  const s = FP.score({ legs: LEGS, entries: [E({ at: T('14:06'), entry: 110, exit: 130, exitAt: T('15:10'), r: 2, peakR: 3 })], picks: [], refRiskPts: 10, minLegR: 2 });
  assert.deepEqual(s.legs.map(g => g.id), ['L1', 'L2', 'L3'], 'L4 is 1.5R: not a trend leg');
  const g = s.legs.find(x => x.id === 'L1');
  assert.deepEqual([g.entered, g.atFirst, g.entryLag], [true, true, 0.25]);
  assert.equal(s.headline.legs, 3);
  assert.equal(s.headline.enteredAtFirst, 1);
});

test('ride: the share of the leg\'s points banked, and where the rest went: shaken out mid-leg, given back at the end, exited early by the model', () => {
  const run = e => FP.score({ legs: LEGS, entries: [e], picks: [], refRiskPts: 10, minLegR: 2 }).legs.find(x => x.id === 'L1');
  // Out at 130 after the leg's extreme (140 at 15:00): banked 20 of 40 (0.5); 10 before the entry, 10 given back.
  const back = run(E({ at: T('14:06'), entry: 110, exit: 130, exitAt: T('15:10'), r: 2, peakR: 3 }));
  assert.deepEqual([back.banked, back.lost], [0.5, { beforeEntry: 0.25, shakenOut: 0, givenBack: 0.25, modelEarly: 0 }]);
  // Stopped (trail) at 112 mid-leg (14:30, before its extreme): the rest of the leg after the exit is shaken out.
  const shaken = run(E({ at: T('14:06'), entry: 110, exit: 112, exitAt: T('14:30'), r: 0.2, peakR: 1.2 }));
  assert.deepEqual([shaken.banked, shaken.lost], [0.05, { beforeEntry: 0.25, shakenOut: 0.7, givenBack: 0, modelEarly: 0 }]);
  // The model closed it at 120 mid-leg.
  const early = run(E({ at: T('14:06'), entry: 110, exit: 120, exitAt: T('14:40'), r: 1, peakR: 1.5, exitBy: 'model' }));
  assert.deepEqual(early.lost, { beforeEntry: 0.25, shakenOut: 0, givenBack: 0, modelEarly: 0.5 });
  // Short: the mirror (from 300 down to 270; in at 294, out at 280 after the extreme).
  const s = FP.score({ legs: LEGS, entries: [E({ side: 'short', at: T('14:03'), entry: 294, exit: 280, exitAt: T('14:40'), r: 1.4, peakR: 2.4 })], picks: [], refRiskPts: 10, minLegR: 2 }).legs.find(x => x.id === 'L3');
  assert.deepEqual([s.banked, s.lost.beforeEntry, s.lost.givenBack], [0.47, 0.2, 0.33]);
  // Still open at the run's end: banked unknown, nothing split.
  assert.equal(run(E({ at: T('14:06'), entry: 110, exit: null, exitAt: null, exitBy: 'open', r: null })).banked, null);
});

test('false firsts: rank #1 entries in no 2R leg their way, with their R; a later rank is not a first', () => {
  const s = FP.score({ legs: LEGS, entries: [E({ at: T('17:00'), entry: 500, exit: 490, exitAt: T('17:10'), r: -1 }), E({ at: T('17:30'), rank: 2, entry: 500, exit: 490, exitAt: T('17:40'), r: -1 }), E({ side: 'short', at: T('14:45'), entry: 120, exit: 130, exitAt: T('14:55'), r: -1 })], picks: [], refRiskPts: 10, minLegR: 2 });
  assert.equal(s.falseFirsts.n, 2, 'the long at 17:00 (no leg) and the short inside L1 (a leg the other way)');
  assert.equal(s.falseFirsts.r, -2);
});

test('passed firsts: a 2R leg whose rank #1 candidate printed inside it and the model passed (no entry its way)', () => {
  const picks = [{ at: T('15:33'), side: 'long', rank: 1, model: 'aggressive', took: false }, { at: T('14:09'), side: 'long', rank: 1, model: 'aggressive', took: true }];
  const s = FP.score({ legs: LEGS, entries: [E({ at: T('14:09'), entry: 112, exit: 135, exitAt: T('15:05'), r: 2.3 })], picks, refRiskPts: 10, minLegR: 2 });
  assert.deepEqual(s.passedFirsts.map(g => g.id), ['L2']);
});

test('the pick table: took or passed x a 2R leg its way came or not (the pick inside the leg); and the headline', () => {
  const picks = [
    { at: T('14:09'), side: 'long', rank: 1, took: true }, { at: T('15:33'), side: 'long', rank: 1, took: false },
    { at: T('17:00'), side: 'long', rank: 1, took: true }, { at: T('17:20'), side: 'long', rank: 2, took: false },
  ];
  const entries = [E({ at: T('14:09'), entry: 112, exit: 135, exitAt: T('15:05'), r: 2.3 }), E({ at: T('17:00'), entry: 500, exit: 490, exitAt: T('17:10'), r: -1 })];
  const s = FP.score({ legs: LEGS, entries, picks, refRiskPts: 10, minLegR: 2, blows: 0 });
  assert.deepEqual(s.pickTable, { tookTrend: 1, tookNone: 1, passedTrend: 1, passedNone: 1 });
  assert.deepEqual(s.headline, { legs: 3, enteredAtFirst: 1, bankedShare: 0.57, trades: 2, rPerTrade: 0.65, passRate: 0.5, blows: 0 });
});

test('paired: two runs on the same legs, side by side (the headline deltas, and the legs one entered at #1 and the other did not)', () => {
  const a = FP.score({ legs: LEGS, entries: [E({ at: T('14:06'), entry: 110, exit: 130, exitAt: T('15:10'), r: 2 })], picks: [], refRiskPts: 10, minLegR: 2 });
  const b = FP.score({ legs: LEGS, entries: [], picks: [], refRiskPts: 10, minLegR: 2 });
  const p = FP.paired(a, b);
  assert.equal(p.delta.enteredAtFirst, 1);
  assert.deepEqual(p.onlyA, ['L1']);
  assert.deepEqual(p.onlyB, []);
});

test('a real fixture: the goal fixture\'s trend legs (eval/goal-metrics.js trendLegs) score, an entry placed on a real leg\'s start enters it at #1', () => {
  const GF = require('../../scripts/lib/eval/goal-fixture');
  const GM = require('../../scripts/lib/eval/goal-metrics');
  const DOC = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'goal', 'bars.json.gz'))));
  const blk = DOC.blocks[0];
  const bars = GF.decodeBars(blk.bars);
  const legs = FP.legsFrom(GM.trendLegs(bars, blk.sessions, { session: '09:30-12:00@America/New_York', minutes: 3 }));
  assert.ok(legs.length > 0, 'the block holds trend legs');
  const g = legs[0];
  const sign = g.side === 'long' ? 1 : -1;
  const e = E({ side: g.side, at: g.start, entry: g.from, exit: g.to - sign * 1, exitAt: new Date(Date.parse(g.end) + 600000).toISOString(), r: 2 });
  const s = FP.score({ legs, entries: [e], picks: [], refRiskPts: Math.abs(g.to - g.from) / 3, minLegR: 2 });
  const got = s.legs.find(x => x.id === g.id);
  assert.equal(got.atFirst, true);
  assert.ok(got.banked > 0.9);
});

test('pickTable (the SELECTION scorecard, primary): took / waited / passed x the ruler\'s R and points (mean, median, total), the mean\'s by-session interval, took minus passed; reproducible from its seed; config required', () => {
  const rows = [
    { key: 'a', day: 'd1', state: 'took', outcome: { R: 2, points: 20 } }, { key: 'b', day: 'd1', state: 'passed', outcome: { R: -1, points: -10 } },
    { key: 'c', day: 'd2', state: 'passed', outcome: { R: -1, points: -8 } }, { key: 'e', day: 'd2', state: 'took', outcome: { R: 1, points: 5 } },
    { key: 'w', day: 'd3', state: 'waited', outcome: { R: 0.5, points: 3 } }, { key: 'u', day: 'd3', state: 'unlabelled', outcome: null },
  ];
  const cfg = { reps: 500, seed: 7, ci: 0.9 };
  const t = FP.pickTable(rows, cfg);
  assert.deepEqual([t.candidates, t.scored, t.unlabelled], [6, 5, 1]);
  assert.deepEqual([t.states.took.n, t.states.took.meanR, t.states.took.medianR, t.states.took.totalR, t.states.took.totalPts], [2, 1.5, 1.5, 3, 25]);
  assert.deepEqual([t.states.passed.meanR, t.states.passed.meanPts, t.states.waited.n], [-1, -9, 1]);
  assert.deepEqual([t.tookMinusPassed.R, t.tookMinusPassed.points], [2.5, 21.5]);
  assert.ok(t.tookMinusPassed.Rci[0] <= 2.5 && t.tookMinusPassed.Rci[1] >= 2.5, JSON.stringify(t.tookMinusPassed));
  assert.deepEqual(FP.pickTable(rows, cfg), t, 'the same seed, the same intervals');
  assert.throws(() => FP.pickTable(rows, {}), /reps, seed and ci are required/);
});
