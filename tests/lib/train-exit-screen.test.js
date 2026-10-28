'use strict';

// The probe screen's exit target (train/screen.js exitTargetTest): an edit made from an exit finding is judged on the
// trades both sides opened (the curated moments and the trend set's scored exits), by the R banked, never by read claims.
const test = require('node:test');
const assert = require('node:assert');
const SC = require('../../scripts/lib/train/screen');
const EF = require('../../scripts/lib/train/exit-findings');
const T = require('../../scripts/lib/tunables');

const STEP = 3 * 60000;
const T0 = Date.parse('2021-06-01T14:00:00.000Z');
const trade = (i, x = {}) => ({ root: 'MNQ', side: 'long', entryAt: new Date(T0 + i * 10 * STEP).toISOString(), exitBy: 'model-exit', cls: 'right', late: false, r: 1, peakR: 1.5, ...x });
const side = (decisions = []) => ({ decisions, exitPlans: [], scorecard: [], usage: [] });
const exits = (champion, probe) => ({ champion, probe, stepMs: STEP });
const run = (champion, probe, curated = [side(), side()]) => {
  const m = SC.measure(curated[0], curated[1], { skill: 'manage-position', kind: EF.KIND, exits: exits(champion, probe) });
  return { m, s: SC.screen(m) };
};
const better = (n, d = 0.5, x = {}) => Array.from({ length: n }, (_, i) => [trade(i), trade(i, { r: 1 + d, ...x })]);
const split = pairs => [pairs.map(p => p[0]), pairs.map(p => p[1])];

test('exit screen: config holds its epsilon and runner mark; minPairs and the gain rule are the screen\'s', () => {
  assert.deepStrictEqual(Object.keys(T.training().exitScreen).sort(), ['epsR', 'runnerMfeR']);
  assert.ok(T.training().screen.minPairs > 6, 'the too-few case below sits under minPairs');
});

test('exit screen: paired gains on the trades both sides opened pass (an exit edit is never judged by read claims)', () => {
  const [a, b] = split([...better(8), ...better(4, 0)]);
  const { m, s } = run(a, b);
  assert.deepStrictEqual([m.target.pairs, m.target.b, m.target.c, m.target.enough], [12, 8, 0, true]);
  assert.strictEqual(m.target.meanDiff, 0.3333);
  assert.strictEqual(s.verdict, 'helped', JSON.stringify(m.target));
});

test('exit screen: paired losses fail', () => {
  const [a, b] = split([...better(8, -0.5), ...better(4, 0)]);
  const { m, s } = run(a, b);
  assert.deepStrictEqual([m.target.b, m.target.c], [0, 8]);
  assert.strictEqual(s.verdict, 'hurt');
  assert.match(s.harms.join(';'), /^target: worse/);
});

test('exit screen: too few pairs is no effect, however one-sided', () => {
  const [a, b] = split(better(6));
  const { m, s } = run(a, b);
  assert.deepStrictEqual([m.target.pairs, m.target.b, m.target.enough], [6, 6, false]);
  assert.strictEqual(s.verdict, 'no effect');
});

test('exit screen: cutting the champion\'s runners fails whatever the mean', () => {
  const runners = [0, 1].map(i => [trade(100 + i, { peakR: 4, r: 2 }), trade(100 + i, { peakR: 4, r: 2.6, cls: 'cut' })]);
  const [a, b] = split([...better(8), ...better(4, 0), ...runners]);
  const { m, s } = run(a, b);
  assert.deepStrictEqual(m.target.runners, { pairs: 2, newCuts: 2, fixedCuts: 0 });
  assert.ok(m.target.b > m.target.c, 'the mean is better');
  assert.strictEqual(s.verdict, 'hurt');
  assert.match(s.harms.join(';'), /target: cut 2 runner\(s\) the champion rode \(un-cut 0; MFE at least 3R\)/);
  // The class change, tagged by who exited on the probe's side.
  assert.deepStrictEqual(m.target.classes, { 'right->cut (model-exit)': 2 });
  // Un-cutting as many as it cuts: no runner harm.
  const back = [trade(200, { peakR: 4, cls: 'cut' }), trade(200, { peakR: 4, r: 1.6 })];
  const [c, d] = split([...better(8), ...better(4, 0), ...runners, [back[0], back[1]], [trade(201, { peakR: 5, cls: 'cut' }), trade(201, { peakR: 5, r: 1.6 })]]);
  assert.deepStrictEqual(run(c, d).m.target.runners, { pairs: 4, newCuts: 2, fixedCuts: 2 });
  assert.strictEqual(run(c, d).s.verdict, 'helped');
});

test('exit screen: trades whose entries differ are unmatched, reported, never paired', () => {
  const [a, b] = split(better(12));
  const champion = [...a, trade(300), trade(301), trade(302)];
  const probe = [...b,
    { ...trade(300), side: 'short', r: 9 }, // another side
    { ...trade(301), entryAt: new Date(Date.parse(trade(301).entryAt) + 3 * STEP).toISOString(), r: 9 }, // past matchBars
    { ...trade(302), root: 'MES', r: 9 }, // another root
    { ...trade(303), root: null }]; // no root: no trade
  const { m } = run(champion, probe);
  assert.deepStrictEqual([m.target.pairs, m.target.b, m.target.unmatched], [12, 12, { champion: 3, probe: 3 }]);
  // Within matchBars, the nearest entry pairs.
  const near = run([trade(0)], [{ ...trade(0), entryAt: new Date(T0 + 2 * STEP).toISOString(), r: 3 }, { ...trade(0), entryAt: new Date(T0 + STEP).toISOString(), r: 2 }]).m.target;
  assert.deepStrictEqual([near.pairs, near.meanDiff, near.unmatched], [1, 1, { champion: 0, probe: 1 }]);
  // The curated set: a moment both entered, the same side; a pass (never entered) and another side never pair.
  const cur = (key, R, x = {}) => ({ key, day: '2021-06-01', R, entered: true, side: 'long', reads: [], relevant: [], ...x });
  const curated = [side([cur('MNQ|1', 1), cur('MNQ|2', 1), cur('MNQ|3', 0, { entered: false }), cur('MNQ|4', 1)]),
    side([cur('MNQ|1', 2), cur('MNQ|2', 0.5), cur('MNQ|3', 2), cur('MNQ|4', 3, { side: 'short' }), cur('MNQ|5', 1)])];
  const t = run([], [], curated).m.target;
  assert.deepStrictEqual([t.pairs, t.b, t.c, t.unmatched], [2, 1, 1, { champion: 1, probe: 3 }]);
});

test('exit screen: a read finding\'s edit keeps the read target test', () => {
  const d = { key: 'MNQ|1', day: '2021-06-01', R: 1, entered: true, side: 'long', relevant: ['rejection'], reads: [{ skill: 'rejection', check: true, ok: true }] };
  const m = SC.measure(side([{ ...d, reads: [] }]), side([d]), { skill: 'rejection', kind: 'missed', exits: exits(...split(better(12))) });
  assert.match(m.target.measure, /^rejection: reads right where relevant$/);
  assert.strictEqual(m.target.enough, undefined);
  assert.deepStrictEqual([m.target.pairs, m.target.b], [1, 1]);
});

test('exit screen: the curated side records each entered moment\'s side', () => {
  const s = SC.sideOf({ decisions: [
    { root: 'MNQ', bar: '2021-06-01T14:00:00.000Z', decision: 'entered', side: 'short', outcome: { R: 1.5 }, reads: [] },
    { root: 'MNQ', bar: '2021-06-01T14:03:00.000Z', decision: 'refused', side: 'long', reads: [] },
  ] });
  assert.deepStrictEqual(s.decisions.map(d => [d.R, d.entered, d.side]), [[1.5, true, 'short'], [0, false, undefined]]);
});
