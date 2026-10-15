'use strict';

// An adapter's validation, derived from the A/B of its named runs (scripts/lib/learning/adapter-validation.js): never a
// result written by hand.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const A = require('../../scripts/lib/learning/adapter-validation');

const H = { skills: '1'.repeat(64), prompt: '2'.repeat(64) };
const manifest = (over = {}) => ({
  v: 1, name: 'm1', base: { model: 'the-base', folder: 'base-folder' }, harness: { commit: 'c'.repeat(40), ...H },
  dataset: { fingerprint: 'd'.repeat(64) }, training: { step: 1, method: 'lora', seed: 1, settings: { iters: 600 } },
  validation: { kind: 'stage-1-exit-test', window: 'practice-validate', status: 'pending' }, ...over,
});
const step2 = () => manifest({ training: { step: 2, method: 'lora', seed: 1, settings: { iters: 400 }, stage1Mix: 0.2, parent: 'sha256:0123456789abcdef' }, validation: { kind: 'prop-keep-rule', window: 'practice-validate', status: 'pending' } });

// deriveValidation: the A/B of the named runs, never a result written by hand.
const TAG = 'sha256:0123456789abcdef';
const VAL = { start: '2024-08-05T00:00:00Z', end: '2024-08-10T00:00:00Z' };
const sideOf = (runId, over = {}) => ({
  runDir: `/runs/${runId}`, runId, manifest: { runId, ...VAL, finished: true }, gate: { role: 'practice-validate' },
  setup: { config: runId === 'adapted' ? { adapter: JSON.stringify(TAG) } : {} }, decisions: [], scorecard: [], ...over,
});
const row = (measure, verdict, a = 0.1, b = 0.2) => ({ measure, verdict, a, b, test: 'x' });
const report = (rows, over = {}) => ({ a: 'base', b: 'adapted', refused: false, refusals: [], differs: [`adapter: (unset) vs "${TAG}"`], rows, result: 'B better', ...over });
const PASSING = [{ test: 'planned-rr', status: 'SANITY' }, { test: 'avg-winner', status: 'PASS' }, { test: 'expectancy', status: 'PASS' }, { test: 'correct-reads', status: 'PASS' }, { test: 'process-adherence', status: 'PASS' }];
function derive({ m = manifest({ validation: { kind: 'stage-1-exit-test', window: 'practice-validate', status: 'pending' } }), sides = {}, rep = report([row('correct-rate', 'B better')]), tests = PASSING } = {}) {
  const calls = [];
  const deps = {
    readSide: dir => { const id = path.basename(dir); if (!['base', 'adapted'].includes(id)) throw new Error('not a replay run home or run dir'); return sides[id] || sideOf(id); },
    compareRuns: (a, b, o) => { calls.push(o.field); return rep; },
    exitTest: () => tests,
  };
  return { v: A.deriveValidation({ manifest: m, tag: TAG, base: '/runs/base', adapted: '/runs/adapted', deps }), calls };
}

test('deriveValidation: step 1 passes only on the A/B with no measure worse and every exit-test criterion passing', () => {
  const { v, calls } = derive();
  assert.deepStrictEqual([v.status, v.runs, calls], ['passed', ['base', 'adapted'], ['adapter']]);
  assert.strictEqual(v.result.kind, 'stage-1-exit-test');
  assert.strictEqual(derive({ rep: report([row('process', 'B worse')], { result: 'B worse' }) }).v.status, 'failed');
  assert.strictEqual(derive({ tests: [...PASSING.slice(0, 4), { test: 'process-adherence', status: 'FAIL' }] }).v.status, 'failed');
  assert.throws(() => derive({ tests: [...PASSING.slice(0, 4), { test: 'process-adherence', status: 'INSUFFICIENT' }] }), /stays pending/);
  assert.throws(() => derive({ tests: [] }), /stays pending/);
});

test('deriveValidation: step 2 passes only with the Monte Carlo pass rate better, zero blows and no measure worse', () => {
  const m = step2();
  const mc = (pass, blowB) => report([row('MC pass within 30 days', pass), row('MC blow rate', pass, 0, blowB)]);
  assert.strictEqual(derive({ m, rep: mc('B better', 0) }).v.status, 'passed');
  assert.strictEqual(derive({ m, rep: mc('B better', 0.01) }).v.status, 'failed', 'a blow');
  assert.strictEqual(derive({ m, rep: mc('no significant difference', 0) }).v.status, 'failed', 'no gain is not kept');
  assert.throws(() => derive({ m, rep: report([row('MC pass within 30 days', 'N/A'), row('MC blow rate', 'N/A', null, null)]) }), /no paired Monte Carlo/);
});

test('deriveValidation: refused unless the runs exist, lie on practice-validate, differ only in the adapter, and ran this manifest', () => {
  const m = manifest({ validation: { kind: 'stage-1-exit-test', window: 'practice-validate', status: 'pending' } });
  assert.throws(() => A.deriveValidation({ manifest: m, tag: TAG, base: '/runs/nope', adapted: '/runs/adapted', deps: { readSide: () => { throw new Error('not a replay run home or run dir'); } } }), /the base run: not a replay run/);
  const train = { start: '2022-03-07T00:00:00Z', end: '2022-03-12T00:00:00Z' };
  assert.throws(() => derive({ sides: { base: sideOf('base', { manifest: { runId: 'base', ...train } }) } }), /not on practice-validate/);
  assert.throws(() => derive({ sides: { adapted: sideOf('adapted', { gate: { role: 'practice-train' } }) } }), /no practice-validate learning decision/);
  assert.throws(() => derive({ sides: { adapted: sideOf('adapted', { setup: { config: { adapter: '"sha256:ffffffffffffffff"' } } }) } }), /not this manifest/);
  assert.throws(() => derive({ sides: { base: sideOf('base', { setup: { config: { adapter: JSON.stringify(TAG) } } }) } }), /the base runs without one/);
  assert.throws(() => derive({ rep: report([], { refused: true, refusals: ['run base is not finished'] }) }), /refused the pair: run base is not finished/);
  assert.throws(() => derive({ rep: report([], { differs: ['adapter: a vs b', 'harness digest x vs y'] }) }), /more than the adapter/);
  assert.throws(() => derive({ m: { ...m, training: {} } }), /no training step/);
});
