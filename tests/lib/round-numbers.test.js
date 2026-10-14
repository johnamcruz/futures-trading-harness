'use strict';

// Round-number steps (trading/round-numbers.js): config, shipped defaults under the harness home's file, each
// step a whole number of its family's ticks from 1 to MAX_STEP_TICKS, a refused entry's family off, an unlisted
// family none, and a seeded run home read back exactly.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../../scripts/lib/trading/round-numbers');
const { loadConfig } = require('../../scripts/lib/trading/config');
const { tmpDir } = require('../helpers');

const home = (doc, raw = null) => {
  const dir = tmpDir();
  if (doc !== undefined || raw !== null) fs.writeFileSync(path.join(dir, R.FILE_NAME), raw !== null ? raw : JSON.stringify(doc));
  return { FTH_HOME: dir };
};

test('the shipped defaults: NQ 100, ES 25, YM 100, RTY 10, GC 10, SI 0.5; the micro and the mini share one', () => {
  const rs = R.loadRoundSteps(home(undefined));
  assert.deepStrictEqual(rs.errors, []);
  assert.deepStrictEqual(['MNQ', 'NQ', 'MES', 'ES', 'MYM', 'YM', 'M2K', 'RTY', 'MGC', 'GC', 'SIL', 'SI'].map(r => R.roundStepFor(r, rs)), [100, 100, 25, 25, 100, 100, 10, 10, 10, 10, 0.5, 0.5]);
  assert.strictEqual(R.roundStepFor('es', rs), 25, 'case-insensitive');
  assert.strictEqual(R.roundStepFor('ES:2026-06', rs), null, 'the caller passes the root, not a contract by month');
  // The same through the trading config every process loads, and the defaults alone (no home).
  assert.deepStrictEqual(loadConfig(home(undefined)).roundSteps, rs);
  assert.deepStrictEqual(R.defaultRoundSteps().steps, rs.steps);
  assert.strictEqual(path.relative(path.join(__dirname, '..', '..'), R.DEFAULTS_FILE), path.join('config', 'round-numbers.json'));
  // The defaults ignore a home's override.
  assert.strictEqual(R.roundStepFor('ES', R.defaultRoundSteps()), 25);
});

test('a local override changes a family, adds nothing it can\'t check, and null turns a family off', () => {
  const rs = R.loadRoundSteps(home({ steps: { MES: 50, NQ: null } }));
  assert.deepStrictEqual(rs.errors, []);
  assert.strictEqual(R.roundStepFor('ES', rs), 50, 'by the micro root, for the whole family');
  assert.strictEqual(R.roundStepFor('MNQ', rs), null);
  assert.strictEqual(R.roundStepError('MNQ', rs), null, 'off on purpose is no error');
  assert.strictEqual(R.roundStepFor('RTY', rs), 10, 'the others keep their default');
});

test('an invalid step is refused with its reason, and its family gets none (never the default in its place)', () => {
  // Not a number, not positive, off the tick grid (by any amount over float error), or under one tick.
  for (const bad of [0, -25, 10.1, '25', true, 0.3, 1e-300, 0.25000000001, 0.1]) {
    const rs = R.loadRoundSteps(home({ steps: { ES: bad } }));
    assert.strictEqual(R.roundStepFor('MES', rs), null, JSON.stringify(bad));
    assert.match(R.roundStepError('MES', rs), /MES step .* is not a whole number of its 0\.25 ticks of at least one tick; it gets no round numbers/);
    assert.strictEqual(R.roundStepFor('NQ', rs), 100, 'the other families are untouched');
    assert.strictEqual(R.roundStepError('NQ', rs), null);
  }
  // One tick is the smallest step; float error in a whole number of ticks is no reason to refuse.
  assert.strictEqual(R.roundStepFor('ES', R.loadRoundSteps(home({ steps: { ES: 0.25 } }))), 0.25);
  assert.strictEqual(R.roundStepFor('RTY', R.loadRoundSteps(home({ steps: { RTY: 0.30000000000000004 } }))), 0.3);
  // Over MAX_STEP_TICKS (2000) ticks: refused, with the cap in points.
  assert.strictEqual(R.MAX_STEP_TICKS, 2000);
  assert.strictEqual(R.roundStepFor('ES', R.loadRoundSteps(home({ steps: { ES: 500 } }))), 500, '2000 ticks: the cap itself');
  for (const big of [500.25, 1e12]) {
    const rs = R.loadRoundSteps(home({ steps: { ES: big } }));
    assert.strictEqual(R.roundStepFor('ES', rs), null, String(big));
    assert.match(R.roundStepError('ES', rs), /MES step .* is over 2000 ticks \(500 points\); it gets no round numbers/);
  }
  // SI's tick is 0.005: 0.5 is 100 ticks, 0.0025 is half a tick.
  assert.strictEqual(R.roundStepFor('SI', R.loadRoundSteps(home({ steps: { SI: 0.0025 } }))), null);
  // One family given twice (by its micro and its mini) with different steps: refused, not a guess.
  const twice = R.loadRoundSteps(home({ steps: { ES: 25, MES: 50 } }));
  assert.strictEqual(R.roundStepFor('ES', twice), null);
  assert.match(R.roundStepError('ES', twice), /MES is given twice/);
});

test('an unknown family: none, and adding one the contract table has no tick for is refused', () => {
  const rs = R.loadRoundSteps(home(undefined));
  assert.strictEqual(R.roundStepFor('XYZ', rs), null);
  assert.strictEqual(R.roundStepError('XYZ', rs), null);
  const added = R.loadRoundSteps(home({ steps: { XYZ: 1 } }));
  assert.strictEqual(R.roundStepFor('XYZ', added), null);
  assert.match(R.roundStepError('XYZ', added), /XYZ has no tick size in the contract table/);
});

test('a file that can\'t be read or parsed, or a bad shape, turns every family off and says why', () => {
  for (const env of [home(undefined, '{ not json'), home({ steps: [1] }), home({ steps: 'x' })]) {
    const rs = R.loadRoundSteps(env);
    assert.strictEqual(R.roundStepFor('NQ', rs), null);
    assert.ok(R.roundStepError('ES', rs), JSON.stringify(rs.errors));
  }
  const noDefaults = R.loadRoundSteps(home(undefined), { defaultsFile: path.join(tmpDir(), 'missing.json') });
  assert.strictEqual(R.roundStepFor('NQ', noDefaults), null);
  assert.match(R.roundStepError('NQ', noDefaults), /unreadable/);
});

test('resolveRoundSteps is pure: the defaults under the overrides', () => {
  assert.deepStrictEqual(R.resolveRoundSteps({ steps: { NQ: 100 } }, { steps: { ES: 25 } }), { steps: { MNQ: 100, MES: 25 }, errors: [] });
  assert.deepStrictEqual(R.resolveRoundSteps({ steps: { NQ: 100 } }, null), { steps: { MNQ: 100 }, errors: [] });
  // A refused default replaced by a valid override: the override's step, no error left for it.
  assert.deepStrictEqual(R.resolveRoundSteps({ steps: { NQ: 0.1 } }, { steps: { MNQ: 50 } }), { steps: { MNQ: 50 }, errors: [] });
  // Values JSON can't carry, given directly: refused too.
  for (const bad of [Infinity, NaN, -Infinity]) assert.strictEqual(R.resolveRoundSteps(null, { steps: { ES: bad } }).steps.MES, null, String(bad));
});

test('a run home seeded with the resolved steps reads back the same steps and refusals (replay shows what live does)', () => {
  const live = R.loadRoundSteps(home({ steps: { ES: 50, NQ: 0.1 } }));
  assert.ok(R.roundStepError('NQ', live));
  const run = home(R.seedFile(live));
  const replay = R.loadRoundSteps(run);
  assert.deepStrictEqual(replay, live);
  // Changing the shipped defaults later changes nothing in a seeded home: it is pinned.
  assert.deepStrictEqual(R.loadRoundSteps(run, { defaultsFile: path.join(tmpDir(), 'missing.json') }), live);
  // A file-wide refusal stays file-wide.
  const broken = R.loadRoundSteps(home(undefined, '{ not json'));
  assert.deepStrictEqual(R.loadRoundSteps(home(R.seedFile(broken))), broken);
  // A hand-edited seed: a file-wide refusal turns every family off, whatever its steps say.
  const allOff = R.loadRoundSteps(home({ resolved: true, steps: { ES: 25, NQ: 100 }, errors: [{ family: '*', message: 'x: unreadable' }] }));
  assert.deepStrictEqual([R.roundStepFor('ES', allOff), R.roundStepFor('NQ', allOff)], [null, null]);
  assert.strictEqual(R.roundStepError('ES', allOff), 'x: unreadable');
  // A family with both a step and a refusal: the refusal wins (never levels and "none" together).
  const both = R.loadRoundSteps(home({ resolved: true, steps: { ES: 25, NQ: 100 }, errors: [{ family: 'MES', message: 'MES refused' }] }));
  assert.deepStrictEqual([R.roundStepFor('ES', both), R.roundStepError('ES', both)], [null, 'MES refused']);
  assert.deepStrictEqual([R.roundStepFor('NQ', both), R.roundStepError('NQ', both)], [100, null], 'the others untouched');
  // A seeded step is still checked: an edited seed can't smuggle in a bad step.
  const edited = R.loadRoundSteps(home({ resolved: true, steps: { ES: 0.1 }, errors: [] }));
  assert.strictEqual(R.roundStepFor('ES', edited), null);
  assert.ok(R.roundStepError('ES', edited));
});
