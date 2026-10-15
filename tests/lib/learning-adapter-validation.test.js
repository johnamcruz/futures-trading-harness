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
// The paired Monte Carlo (prop/evaluator.js scorePaired's shape; A the base, B the adapted, differences A minus B), as
// tests/lib/train-model-verifier.test.js scripts it.
const MV = require('../../scripts/lib/train/model-verifier');
const iv = (diff, lo, hi) => ({ diff, lo, hi, level: 0.9, n: 60 });
const ZERO = iv(0, -0.05, 0.05);
const startsOf = (n, aEvery = 6, bEvery = 6) => Array.from({ length: n }, (_, i) => ({ start: `s${i}`, a: aEvery && i % aEvery === 0 ? 'passed' : 'timeout', b: bEvery && i % bEvery === 0 ? 'passed' : 'timeout' }));
function mcOf({ blowsB = 0, starts = startsOf(60), real = {}, rs = {}, sessions = 30, days = 90 } = {}) {
  const side = { passRate: 0.3, blowRate: 0, medianDaysToPass: 20, blown: 0 };
  return {
    a: { real: side, resampled: side, score: 'real' }, b: { real: { ...side, blown: 0 }, resampled: side, score: 'real' }, starts,
    diff: { real: { passRate: ZERO, blowRate: ZERO, timeoutRate: ZERO, medianDaysToPass: iv(null, null, null), ...real }, resampled: { passRate: ZERO, blowRate: ZERO, timeoutRate: ZERO, medianDaysToPass: iv(null, null, null), ...rs } },
    blows: { a: 0, b: blowsB }, inputs: { sessions, days, level: 0.9, seed: 3, reps: 400 },
  };
}
// Scorecards of 30 decisions each, every one right: adherence pairs and is not worse; reads the same.
const SCORED = Array.from({ length: 30 }, (_, i) => ({ t: `2024-08-0${5 + (i % 5)}T14:${String(i).padStart(2, '0')}:00Z`, symbol: 'MNQ', category: 'right', agrees: true }));
const READS = new Map(Array.from({ length: 30 }, (_, i) => [`MNQ|${i}`, [{ check: true }]]));
function derive({ m = manifest({ validation: { kind: 'stage-1-exit-test', window: 'practice-validate', status: 'pending' } }), sides = {}, rep = report([row('correct-rate', 'B better')]), tests = PASSING, mc = mcOf() } = {}) {
  const calls = [];
  const deps = {
    readSide: dir => { const id = path.basename(dir); if (!['base', 'adapted'].includes(id)) throw new Error('not a replay run home or run dir'); return sides[id] || sideOf(id, { scorecard: SCORED }); },
    compareRuns: (a, b, o) => { calls.push(o.field); return rep; },
    exitTest: () => tests,
    pair: (a, b) => { calls.push(`pair ${a.runId} ${b.runId}`); if (mc instanceof Error) throw mc; return mc; },
    readsOf: () => READS,
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

test('deriveValidation: step 2 is the full keep rule (model-verifier decide): kept is passed, inconclusive pending, else failed', () => {
  const m = step2();
  // The adapted run passes on 30 of 60 real start days, the base on 10: the pooled pass rate better, zero blows.
  const kept = derive({ m, mc: mcOf({ starts: startsOf(60, 6, 2) }) });
  assert.strictEqual(kept.v.status, 'passed', JSON.stringify(kept.v.result.keep));
  assert.strictEqual(kept.v.result.keep.verdict, 'kept');
  assert.deepStrictEqual(kept.calls, ['adapter', 'pair base adapted']);
  assert.strictEqual(MV.decide([{ label: 'w', mc: mcOf({ starts: startsOf(60, 6, 2) }), adherence: MV.adherence([], []), reads: null }]).verdict, 'inconclusive', 'the decision measures are read, not assumed');
  // A resampled-only gain from one short window: the real attempts too few to show anything. Never passed: pending.
  const short = mcOf({ starts: startsOf(20, 6, 2), days: 50, rs: { passRate: iv(-0.3, -0.35, -0.25) } });
  assert.throws(() => derive({ m, mc: short }), /keep rule is inconclusive .*stays pending/);
  // A blow on the adapted side, real or resampled: failed, whatever it gains.
  assert.strictEqual(derive({ m, mc: mcOf({ starts: startsOf(60, 6, 2), blowsB: 1 }) }).v.status, 'failed');
  const realBlow = mcOf({ starts: startsOf(60, 6, 2) });
  realBlow.b.real.blown = 1;
  assert.match(derive({ m, mc: realBlow }).v.result.why, /zero blows is a hard rule/);
  // No gain on the real attempts (the same pass rate): rejected by the keep rule, failed.
  const none = derive({ m, mc: mcOf() });
  assert.strictEqual(none.v.status, 'failed');
  assert.match(none.v.result.why, /the keep rule: rejected/);
  // A measure worse on the A/B fails first; a Monte Carlo that can't be scored stays pending.
  assert.strictEqual(derive({ m, rep: report([row('process', 'B worse')]), mc: mcOf({ starts: startsOf(60, 6, 2) }) }).v.status, 'failed');
  assert.throws(() => derive({ m, mc: new Error('no account') }), /paired Monte Carlo can't be scored \(no account\)/);
  assert.throws(() => derive({ m, mc: { ...mcOf(), blows: {} } }), /no blow count/);
});

test('deriveValidation: the result carries its evidence: each run\'s id, dir and setup record digest', () => {
  const A2 = require('../../scripts/lib/learning/adapter');
  const { v } = derive();
  assert.deepStrictEqual(v.evidence, {
    base: { runId: 'base', dir: '/runs/base', setup: A2.recordDigest(sideOf('base').setup) },
    adapted: { runId: 'adapted', dir: '/runs/adapted', setup: A2.recordDigest(sideOf('adapted').setup) },
  });
  // Sealed as adapter.js validated records it, it is backed by its evidence.
  const m = manifest({ harness: { commit: 'c'.repeat(40), ...H, code: '3'.repeat(64) }, validation: A2.sealValidation({ kind: 'stage-1-exit-test', window: 'practice-validate', status: v.status, runs: v.runs, evidence: v.evidence, result: v.result }) });
  assert.deepStrictEqual(A2.evidenceErrors(m, { read: { runSetup: dir => sideOf(path.basename(dir)).setup } }), []);
  assert.match(A2.evidenceErrors(m, { read: { runSetup: () => ({ runId: 'base', config: {} }) } }).join(), /not the one the validation read/);
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
