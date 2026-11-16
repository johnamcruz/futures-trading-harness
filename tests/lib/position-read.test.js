'use strict';

// The Position line (scripts/lib/trading/position-read.js, DESIGN 4.1-4.3 with the review's R1): one code-computed line
// per open position, every number from the runner's held trade (one R basis), or folded from the bars when the runner
// holds none for it (said so); total: a failure is a line that says so, never a throw.

const test = require('node:test');
const assert = require('node:assert');
const { heldFor, positionRead, positionLine } = require('../../scripts/lib/trading/position-read');

const TICK = 0.25;
const level = x => String(Math.round(x / TICK) * TICK);
const PLAN = { afterTarget: { lockGivebackR: 1.5, trailBy: 'structure', trailR: 1, swingMinutes: 15 } };

// 2021-09-01 13:54Z (the mt343 run's long, DESIGN 4.1): entry 15659.5, 1R 9.5 pts (38 ticks, $19.00 per MNQ); the fill
// bar's low 15656.75 is 11 ticks under the entry (MAE -0.29R); target 15677 (1.84R): lock +0.34R = 15662.75, 13 ticks over.
const LONG_T = { contractId: 'MNQ', side: 'long', sign: 1, size: 1, entry: 15659.5, averagePrice: 15659.5, risk: 9.5, riskFrom: 'journal', stop: 15662.75, stops: [15662.75], target: null, openedAt: '2021-09-01T13:41:20.000Z' };
const LONG_H = {
  key: 'p1', entry: 15659.5, risk: 9.5, plan: PLAN, target: 15677, armed: true, peakR: 39.5 / 9.5, troughR: -2.75 / 9.5,
  bestPrice: 15699, bestBarT: '2021-09-01T13:48:00.000Z', worstPrice: 15656.75, lastClose: 15691.25, lastBarT: '2021-09-01T13:51:00.000Z',
  swingClass: { cls: 'C', trailBy: 'structure', swing: 15620.5, swingStop: 15620.25, lock: 15662.75, binds: 'lock', trailStop: null, wrongSide: false },
};
const L1354 = 'Position (code facts): MNQ long 1 @ 15659.5, 1R 9.5 pts; now +3.34R at 15691.25; MFE +4.16R at 15699 (09:48 ET bar); MAE -0.29R; giveback 0.82R (20% of MFE); working stop 15662.75 (+0.34R; a fill there is 3.82R off the best); target reached (lock +0.34R); code floor: last confirmed 15m swing 15620.5 is behind the lock: the stop rests at the lock.';
const L1357 = 'Position (code facts): MNQ long 1 @ 15659.5, 1R 9.5 pts; now +1.39R at 15672.75; MFE +4.16R at 15699 (09:48 ET bar); MAE -0.29R; giveback 2.77R (67% of MFE); working stop 15662.75 (+0.34R; a fill there is 3.82R off the best); target reached (lock +0.34R); code floor: last confirmed 15m swing 15620.5 is behind the lock: the stop rests at the lock.';
// 2022-03-07 15:36Z: the short before its target.
const SHORT_T = { contractId: 'MNQ', side: 'short', sign: -1, size: 1, entry: 13674, averagePrice: 13674, risk: 82.25, riskFrom: 'journal', stop: 13756.25, stops: [13756.25], target: null, openedAt: '2022-03-07T14:51:00.000Z' };
const SHORT_H = {
  key: 'p2', entry: 13674, risk: 82.25, plan: PLAN, target: 13500, armed: false, peakR: 110.5 / 82.25, troughR: -19.75 / 82.25,
  bestPrice: 13563.5, bestBarT: '2022-03-07T15:30:00.000Z', worstPrice: 13693.75, lastClose: 13606.75, lastBarT: '2022-03-07T15:33:00.000Z',
  swingClass: { cls: 'A', trailBy: 'structure', swing: null, swingStop: null, lock: 13554.75, binds: null, trailStop: null, wrongSide: false },
};
const L0307 = 'Position (code facts): MNQ short 1 @ 13674, 1R 82.25 pts; now +0.82R at 13606.75; MFE +1.34R at 13563.5 (10:30 ET bar); MAE -0.24R; giveback 0.52R (39% of MFE); working stop 13756.25 (-1R; a fill there is 2.34R off the best); target not reached; code floor: before the target: the initial stop holds.';

const line = (t, h, extra = {}) => positionLine(positionRead(t, { held: h, tick: TICK, ...extra }), { level });

test('the three examples of DESIGN 4.1, exactly (the 09-01 hold at 13:54Z and 13:57Z, the 03-07 short before its target)', () => {
  assert.strictEqual(line(LONG_T, LONG_H), L1354);
  assert.strictEqual(line(LONG_T, { ...LONG_H, lastClose: 15672.75, lastBarT: '2021-09-01T13:54:00.000Z' }), L1357);
  assert.strictEqual(line(SHORT_T, SHORT_H), L0307);
  // Tick check: 1R 9.5 pts = 38 ticks; MAE 11 ticks under the entry; the lock 13 ticks over it.
  assert.deepStrictEqual([9.5 / TICK, (15659.5 - 15656.75) / TICK, (15662.75 - 15659.5) / TICK], [38, 11, 13]);
});

test('the read: MAE never above 0; MFE 0 says so (no share); a share above 100% when now is under the entry; short symmetry', () => {
  const r = positionRead(LONG_T, { held: { ...LONG_H, troughR: 0.4 }, tick: TICK });
  assert.strictEqual(r.maeR, 0, 'a positive trough (an old record) is clamped to 0');
  assert.match(positionLine(r, { level }), /MAE 0R \(never below the entry on a closed bar\)/);
  const s = positionLine(positionRead(SHORT_T, { held: { ...SHORT_H, troughR: 0, worstPrice: null }, tick: TICK }), { level });
  assert.match(s, /MAE 0R \(never above the entry on a closed bar\)/);
  const flat = positionLine(positionRead(LONG_T, { held: { ...LONG_H, peakR: 0, bestPrice: null, bestBarT: null, armed: false, lastClose: 15655, swingClass: { ...LONG_H.swingClass, cls: 'A' } }, tick: TICK }), { level });
  assert.match(flat, /MFE 0R \(no closed bar beyond the entry yet\); MAE -0\.29R; giveback: none; /);
  const under = positionRead(LONG_T, { held: { ...LONG_H, lastClose: 15650 }, tick: TICK });
  assert.deepStrictEqual([under.nowR, under.give, under.giveShare], [-1, 5.16, 124]);
  // A short giving back: same numbers, signs through the side.
  const back = positionRead(SHORT_T, { held: { ...SHORT_H, lastClose: 13690.5 }, tick: TICK });
  assert.deepStrictEqual([back.nowR, back.mfeR, back.give, back.giveShare], [-0.2, 1.34, 1.54, 115]);
});

test('the working stop: none, several (the loosest is the exposure), a tightened one above the lock as it rests', () => {
  assert.match(line({ ...LONG_T, stop: null, stops: [] }, LONG_H), /; NO working stop; /);
  assert.match(line({ ...LONG_T, stops: [15662.75, 15660] }, LONG_H), /; 2 stop orders, the loosest 15660 \(\+0\.05R; a fill there is 4\.11R off the best\); /);
  assert.match(line({ ...LONG_T, stop: 15683.25, stops: [15683.25] }, LONG_H), /working stop 15683\.25 \(\+2\.5R; a fill there is 1\.66R off the best\); target reached \(lock \+0\.34R\); code floor: /);
});

test('the code floor\'s class: B, C, D (lock or R trail binding; none or the wrong side), A, a trail by R; modes target and trail', () => {
  const cls = c => line(LONG_T, { ...LONG_H, swingClass: { ...LONG_H.swingClass, ...c } });
  assert.match(cls({ cls: 'B', swing: 15670.5, swingStop: 15670.25, binds: 'swing' }), /code floor: the stop trails the 15m swing 15670\.5 \(stop 15670\.25\)\.$/);
  assert.match(cls({ cls: 'D', swing: null, binds: 'lock', trailStop: 15660 }), /code floor: no 15m swing in the bars: the stop rests at the lock\.$/);
  assert.match(cls({ cls: 'D', swing: null, binds: 'trail', trailStop: 15689.5 }), /code floor: no 15m swing in the bars: the stop trails 1R behind the best \(15689\.5\)\.$/);
  // A swing on the wrong side of the price: never "no swing in the bars".
  const wrong = cls({ cls: 'D', swing: 15695, binds: 'lock', wrongSide: true });
  assert.match(wrong, /code floor: last 15m swing 15695 is on the wrong side of the price: the stop rests at the lock\.$/);
  assert.doesNotMatch(wrong, /no 15m swing/);
  assert.match(cls({ cls: 'D', trailBy: 'r', swing: null, binds: 'trail', trailStop: 15689.5 }), /code floor: the stop trails 1R behind the best \(15689\.5\)\.$/);
  // Same-bar target and swing: the step read both at that close, so the class is whatever it said (B).
  assert.match(cls({ cls: 'B', swing: 15670.5, swingStop: 15670.25, binds: 'swing' }), /target reached \(lock \+0\.34R\); code floor: the stop trails/);
  // A target under 1.5R: the lock is the entry (0R).
  assert.match(line(LONG_T, { ...LONG_H, target: 15668, swingClass: { ...LONG_H.swingClass, lock: 15659.5 } }), /target reached \(lock \+0R\)/);
  // Mode target (no afterTarget): the target order and no class; mode trail: its trail.
  const tgt = line({ ...LONG_T, target: 15697.5 }, { ...LONG_H, plan: { afterTarget: undefined, trailActivateR: null }, swingClass: null });
  assert.match(tgt, /; target order 15697\.5 \(\+4R\)\.$/);
  const trl = line(LONG_T, { ...LONG_H, plan: { trailActivateR: 1, trailGivebackR: 0.5 }, swingClass: null });
  assert.match(trl, /; trail 0\.5R behind the best from \+1R\.$/);
});

test('one basis: the held trade\'s entry and risk; the broker\'s average price apart from it by a tick or more is said', () => {
  const avg = line({ ...LONG_T, averagePrice: 15661 }, LONG_H);
  assert.match(avg, /@ 15659\.5, 1R 9\.5 pts \(average price now 15661; R from the runner's entry 15659\.5\); /);
  assert.doesNotMatch(line({ ...LONG_T, averagePrice: 15659.6 }, LONG_H), /average price/);
});

test('heldFor: the held trade only when its key is the position\'s, it is managed, and its last bar is the last closed bar', () => {
  assert.deepStrictEqual(heldFor(LONG_H, { key: 'p1', lastBarT: LONG_H.lastBarT }), { held: LONG_H });
  assert.match(heldFor(LONG_H, { key: 'p9', lastBarT: LONG_H.lastBarT }).why, /another position/);
  assert.match(heldFor({ key: 'p1', skip: true }, { key: 'p1', lastBarT: null }).why, /not managed/);
  assert.match(heldFor(LONG_H, { key: 'p1', lastBarT: '2021-09-01T13:54:00.000Z' }).why, /not updated to the last closed bar/);
  assert.match(heldFor(null, { key: 'p1', lastBarT: null }).why, /no held trade/);
  // No bar this pass (premarket, end of day): the held trade as of its last bar, said so.
  assert.deepStrictEqual(heldFor(LONG_H, { key: 'p1', lastBarT: undefined }), { held: LONG_H, asOf: LONG_H.lastBarT });
  assert.match(line(LONG_T, LONG_H, { asOf: LONG_H.lastBarT }), /now \+3\.34R at 15691\.25 \(the 09:51 ET bar's close\); /);
});

test('not held: the line is folded from the bars with the journal\'s or the working stop\'s risk, and says so', () => {
  const bars = [
    { t: '2021-09-01T13:39:00.000Z', o: 1, h: 99999, l: 0, c: 1 }, // opened before the fill less the grace: not counted
    { t: '2021-09-01T13:41:00.000Z', o: 15660, h: 15665, l: 15656.75, c: 15664 }, // opened 20 s before the fill: counted (the runner's rule)
    { t: '2021-09-01T13:44:00.000Z', o: 15664, h: 15699, l: 15662, c: 15690 },
  ];
  const l = line(LONG_T, null, { bars, why: 'no held trade', graceMs: 30000 });
  assert.strictEqual(l, 'Position (code facts): MNQ long 1 @ 15659.5, 1R 9.5 pts; now +3.21R at 15690; MFE +4.16R at 15699 (09:44 ET bar); MAE -0.29R; giveback 0.95R (23% of MFE); working stop 15662.75 (+0.34R; a fill there is 3.82R off the best); no target order (not runner-managed: no held trade; risk from the journal stop).');
  assert.match(line({ ...LONG_T, riskFrom: 'working' }, null, { bars, why: 'no held trade', graceMs: 30000 }), /risk from the working stop\)\.$/);
});

test('total: no risk, no bars, a bad held record: "Position: unavailable (...)", never a throw', () => {
  assert.strictEqual(line({ ...LONG_T, risk: null }, null, { bars: [], why: 'no held trade' }), 'Position: unavailable (no initial risk: no R to state).');
  assert.strictEqual(line(LONG_T, null, { bars: [], why: 'no held trade' }), 'Position: unavailable (no closed bar since the fill yet).');
  assert.match(line(LONG_T, null, { bars: null, why: 'no held trade' }), /^Position: unavailable \(/);
  assert.match(positionLine(null, { level }), /^Position: unavailable \(not computed\)\.$/);
  assert.match(positionLine(positionRead(null, {}), { level }), /^Position: unavailable \(/);
  assert.doesNotThrow(() => positionLine(positionRead(LONG_T, { held: { ...LONG_H, swingClass: 'garbage', bestBarT: 'not a time' }, tick: TICK }), { level }));
});

test('readable without the skill: plain labels, no code words or class letters, the R unit defined on the line', () => {
  for (const l of [L1354, L1357, L0307]) {
    assert.match(l, /^Position \(code facts\): /);
    assert.match(l, /1R [\d.]+ pts/, 'what 1R is, in points');
    assert.doesNotMatch(l, /\b[a-z]+[A-Z]\w*\b/, 'no camelCase identifiers');
    assert.doesNotMatch(l, /\b(class|cls) [A-D]\b|\(?\b[A-D]\)/, 'no class letters');
    assert.doesNotMatch(l, /\b(hold|exit|tighten|close it|should|consider)\b/i, 'facts only, no instruction');
    assert.doesNotMatch(l, /stall/i, 'no stall clause (review B4)');
  }
});

// Parity with the simulators' excursions (review B1.3, DESIGN 4.7, section 10 item 2): the line's MFE and MAE are the
// runner's bar rule (a bar that opened at most fillGraceMs before the fill counts); bracketExit never counts the fill bar.
test('parity: the line\'s MFE/MAE equal bracketExit\'s for a fill outside the grace, and differ by exactly the fill bar inside it (the runner counts it, the simulators never do)', () => {
  const { bracketExit } = require('../../scripts/lib/learning/experience-log');
  const { tradeFold } = require('../../scripts/lib/trading/exit-trail');
  const GRACE = require('../../scripts/lib/tunables').runner().runner.fillGraceMs;
  const TF = 180000;
  const t0 = Date.parse('2026-10-07T14:00:00.000Z');
  const path = [[100, 103, 97, 101], [101, 104, 100, 103], [103, 106, 102, 104], [104, 105, 99.5, 100], [100, 102, 99, 101]];
  const bars = path.map(([o, h, l, c], k) => ({ t: new Date(t0 + k * TF).toISOString(), ms: t0 + k * TF, o, h, l, c }));
  const fold = fillMs => tradeFold({ sign: 1, entry: 100, risk: 20 }, bars.filter(b => b.ms >= fillMs - GRACE), null, 0.25);
  const sim = () => bracketExit({ bars, i: 0, partial: true, tfMs: TF, side: 'long', fill: 100, risk: 20, eodMs: bars[4].ms + TF, tick: 0.25 });
  const r2 = x => Math.round(x * 100) / 100;
  // Outside the grace (40 s into the first bar): neither counts the fill bar: equal.
  const out = fold(t0 + 40000);
  assert.deepStrictEqual([r2(out.peakR), r2(out.troughR)], [sim().mfeR, sim().maeR]);
  // Inside it (5 s into the first bar): the runner counts the fill bar's extremes (103 and 97), the simulator never.
  const inside = fold(t0 + 5000);
  assert.deepStrictEqual([r2(inside.peakR), r2(inside.troughR)], [0.3, -0.15]);
  assert.deepStrictEqual([sim().mfeR, sim().maeR], [0.3, -0.05], 'the best 106 is after the fill bar; the worst without it 99');
  assert.notStrictEqual(r2(inside.troughR), sim().maeR, 'the fill bar\'s low 97 is the difference');
});
