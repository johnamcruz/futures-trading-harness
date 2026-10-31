'use strict';

const test = require('node:test');
const assert = require('node:assert');
const GC = require('../../scripts/lib/eval/goal-check');

const half = o => ({ trades: 10, meanR: 0.1, falseStartShare: 0.4, maxDrawdownR: 5, caught: { share: 0.1, caught: 3, legs: 9 }, mc: { pass: 0.2, blow: 0, blows: 0, meanDaysToPass: 20 }, ...o });
const doc = (a = {}, b = {}) => ({ fixture: 'f1', halves: { A: half(a), B: half(b) } });
const TOL = { passRate: 0.02, meanR: 0.03, rCaught: 0.02 };

test('compare: the gated metrics in the goal\'s order, each half; one more blow fails, the rest past their tolerance', () => {
  const rows = GC.compare(doc(), doc(), TOL);
  assert.deepStrictEqual(rows.filter(r => r.gated && r.half === 'A').map(r => r.key), ['mc.blows', 'mc.pass', 'meanR', 'caught.share']);
  assert.deepStrictEqual(GC.regressions(rows), []);
  const k = now => GC.regressions(GC.compare(doc(), now, TOL)).map(r => `${r.half} ${r.key}`);
  assert.deepStrictEqual(k(doc({ mc: { pass: 0.2, blow: 0.001, blows: 1 } })), ['A mc.blows']);
  assert.deepStrictEqual(k(doc({}, { mc: { pass: 0.181, blows: 0 } })), [], 'within the tolerance');
  assert.deepStrictEqual(k(doc({}, { mc: { pass: 0.179, blows: 0 } })), ['B mc.pass']);
  assert.deepStrictEqual(k(doc({ meanR: 0.069 })), ['A meanR']);
  assert.deepStrictEqual(k(doc({ caught: { share: 0.079 } })), ['A caught.share']);
  assert.deepStrictEqual(k(doc({ meanR: null })), ['A meanR'], 'a missing metric fails');
});

test('riseProblems: a baseline only improves on the same fixture; a new fixture starts over only with its change recorded', () => {
  assert.deepStrictEqual(GC.riseProblems(doc(), doc({ mc: { pass: 0.3, blows: 0 } })), []);
  assert.match(GC.riseProblems(doc(), doc({ meanR: 0.09 })).join(), /half A mean R per trade: 0.09 in the new baseline, 0.1 on the base branch/);
  assert.match(GC.riseProblems(doc(), doc({}, { mc: { pass: 0.2, blows: 2 } })).join(), /half B combine blows/);
  assert.match(GC.riseProblems(doc(), { ...doc({ meanR: -1 }), fixture: 'f2' }).join(), /the fixture changed .* no fixtureChange/, 'a new fixture without its change recorded');
  assert.deepStrictEqual(GC.riseProblems(doc(), { ...doc({ meanR: -1 }), fixture: 'f2', fixtureChange: { from: 'f1', why: 'more sessions' } }), []);
  assert.ok(GC.riseProblems(doc(), { ...doc(), fixture: 'f2', fixtureChange: { from: 'f0', why: 'x' } }).length, 'the change must name the hash it replaces');
});

test('renderTable: metric, main, this PR, allowed, and which fail', () => {
  const text = GC.renderTable(GC.compare(doc(), doc({ meanR: 0 }), TOL));
  const lines = text.split('\n');
  assert.match(lines[0], /^half\s+metric\s+main\s+this PR\s+allowed/);
  assert.ok(lines.some(l => /^A\s+mean R per trade\s+0\.1\s+0\s+>= 0\.07\s+FAIL$/.test(l)), text);
  assert.ok(lines.some(l => /^A\s+combine blows \(paths\)\s+0\s+0\s+<= 0\s+ok$/.test(l)), text);
});
