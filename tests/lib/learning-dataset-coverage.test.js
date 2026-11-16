'use strict';

// The verified-decision dataset's coverage (scripts/lib/learning/dataset-coverage.js): examples per skill (by the
// crosswalk's skill of each verified read), per read type, kind and role, and the GAPS under the spec's floor.

const test = require('node:test');
const assert = require('node:assert');
const C = require('../../scripts/lib/learning/dataset-coverage');
const { READ_SKILL, SHAPE_SKILL } = require('../../scripts/lib/learning/curated-moments');

const ex = (role, kind, reads) => ({ role, decision: { kind, record: reads ? { reads } : null } });

test('TAUGHT_SKILLS: every skill the crosswalk gives a read, and the shape skill', () => {
  for (const s of Object.values(READ_SKILL).flatMap(k => Object.values(k))) assert.ok(C.TAUGHT_SKILLS.includes(s), s);
  assert.ok(C.TAUGHT_SKILLS.includes(SHAPE_SKILL));
  assert.deepStrictEqual([...C.TAUGHT_SKILLS], [...C.TAUGHT_SKILLS].sort());
});

test('skillsOf: the crosswalk\'s skill of each verified read (not the label the model gave), else the one it named; unverified reads count for none', () => {
  const d = { record: { reads: [
    { step: 'setup', read: '15m broke prior rth low down', skill: 'rejection', check: true },
    { step: 'bias', read: '1h down', skill: 'multi-timeframe-analysis', check: 'true' },
    { step: 'entry', read: '3m close top', skill: 'candle-reading', check: false },
    { step: 'setup', read: 'something unparsed', skill: 'pullback-vs-reversal', check: true },
  ] } };
  assert.deepStrictEqual(C.skillsOf(d), ['breakout', 'multi-timeframe-analysis', 'pullback-vs-reversal']);
  assert.deepStrictEqual(C.skillsOf({ record: null }), []);
});

test('coverageOf: per skill, read type, kind and role; the GAPS under the floor; no floor, no gaps', () => {
  const xs = [
    ex('fth-head-trader', 'take', [{ step: 'setup', read: '15m broke prior rth low down', check: true }, { step: 'bias', read: '1h down', check: true }]),
    ex('fth-head-trader', 'take', [{ step: 'setup', read: '15m broke prior rth low down', check: true }, { step: 'setup', read: '15m broke prior rth high up', check: true }]),
    ex('fth-head-trader', 'pass', null),
    ex('risk-manager', 'take', [{ step: 'bias', read: '1h down', check: true }]),
  ];
  const c = C.coverageOf(xs, { minExamplesPerSkill: 2 });
  assert.strictEqual(c.n, 4);
  assert.deepStrictEqual(c.kind, { pass: 1, take: 3 });
  assert.deepStrictEqual(c.role, { 'fth-head-trader': 3, 'risk-manager': 1 });
  assert.deepStrictEqual(c.readType, { bias: 2, setup: 2 }, 'once per example per step');
  assert.strictEqual(c.skill.breakout, 2, 'once per example');
  assert.strictEqual(c.skill['multi-timeframe-analysis'], 2);
  assert.ok(!c.gaps.some(g => g.skill === 'breakout'));
  assert.ok(c.gaps.some(g => g.skill === 'cisd' && g.n === 0), 'a skill with no example is a gap');
  assert.strictEqual(c.gaps.length, C.TAUGHT_SKILLS.length - 2);
  assert.ok(c.notMeasured.includes('position-sizing'));
  assert.deepStrictEqual(C.coverageOf(xs).gaps, []);
});
