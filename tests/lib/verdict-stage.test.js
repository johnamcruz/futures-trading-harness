'use strict';

// The early phase 2's policy verdicts, staged (scripts/lib/trading/verdict-stage.js, prop-state.js): written to its
// stage, read back only where the stage is in force, promoted to the real file in one write, dropped otherwise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const VS = require('../../scripts/lib/trading/verdict-stage');
const prop = require('../../scripts/lib/trading/prop-state');
const { tmpDir } = require('../helpers');

const V = (o = {}) => ({ at: '2026-10-07T14:00:00.000Z', strategy: 'prop_portfolio', component: 'trade_lifecycle', symbol: 'MNQ', contract: 'MNQ', bar: '2026-10-07T13:57:00.000Z', direction: 'long', action: 'full', multiplier: 1, maxSize: 5, record: 'r1', expiresAt: '2026-10-07T14:06:00.000Z', ...o });

test('verdict stage: a staged verdict is read only where the stage is in force; the real file and every other reader never see it', () => {
  const home = tmpDir();
  prop.appendVerdict(home, V({ record: 'r0' }));
  const stage = VS.newStage(home);
  assert.strictEqual(path.dirname(stage), path.resolve(home, 'logs'));
  VS.withStage(stage, () => prop.appendVerdict(home, V()));
  // The head trader's view (no stage): the real file only.
  assert.deepStrictEqual(prop.readVerdicts(home).map(v => v.record), ['r0']);
  assert.strictEqual(prop.latestVerdict(home, 'prop_portfolio', 'MNQ').record, 'r0');
  assert.deepStrictEqual(fs.readFileSync(prop.verdictsFile(home), 'utf8').trim().split('\n').map(l => JSON.parse(l).record), ['r0']);
  // The early run's own view (its stage in force): the real file, then its stage.
  assert.deepStrictEqual(VS.withStage(stage, () => prop.readVerdicts(home).map(v => v.record)), ['r0', 'r1']);
  assert.strictEqual(VS.withStage(stage, () => prop.latestVerdict(home, 'prop_portfolio', 'MNQ').record), 'r1');
  // By the environment, as the early run's own processes have it.
  const was = process.env[VS.ENV];
  process.env[VS.ENV] = stage;
  try {
    assert.deepStrictEqual(prop.readVerdicts(home).map(v => v.record), ['r0', 'r1']);
  } finally {
    if (was === undefined) delete process.env[VS.ENV]; else process.env[VS.ENV] = was;
  }
});

test('verdict stage: promoted at once to the real file (a record the real file already holds left out), the stage removed; dropped, nothing reaches it', () => {
  const home = tmpDir();
  const stage = VS.newStage(home);
  VS.withStage(stage, () => { prop.appendVerdict(home, V()); prop.appendVerdict(home, V({ record: 'r2' })); });
  prop.appendVerdict(home, V({ record: 'r2', at: '2026-10-07T14:01:00.000Z' }));
  assert.strictEqual(prop.promoteVerdicts(home, stage), 1);
  assert.deepStrictEqual(prop.readVerdicts(home).map(v => [v.record, v.at]), [['r2', '2026-10-07T14:01:00.000Z'], ['r1', '2026-10-07T14:00:00.000Z']]);
  assert.ok(!fs.existsSync(stage));
  const other = VS.newStage(home);
  VS.withStage(other, () => prop.appendVerdict(home, V({ record: 'r3' })));
  VS.dropStage(other);
  assert.ok(!prop.readVerdicts(home).some(v => v.record === 'r3'));
  assert.ok(!fs.existsSync(other));
});

test('verdict stage fails closed: a named stage that is not a stage file stages nothing (an append refuses) and reads no verdicts; a new stage sweeps this process\'s leftovers', () => {
  const home = tmpDir();
  prop.appendVerdict(home, V({ record: 'r0' }));
  for (const bad of [path.join(home, 'policy-verdicts.jsonl'), 'relative.jsonl', path.join(tmpDir(), 'logs', 'verdict-stage-1-000000000000.jsonl')]) {
    assert.throws(() => VS.withStage(bad, () => prop.appendVerdict(home, V())), /names no verdict stage/, bad);
    assert.deepStrictEqual(VS.withStage(bad, () => prop.readVerdicts(home)), [], bad);
  }
  assert.deepStrictEqual(prop.readVerdicts(home).map(v => v.record), ['r0'], 'the real file untouched');
  const left = VS.newStage(home);
  fs.mkdirSync(path.dirname(left), { recursive: true });
  fs.writeFileSync(left, `${JSON.stringify(V())}\n`);
  VS.newStage(home);
  assert.ok(!fs.existsSync(left), 'swept');
});
