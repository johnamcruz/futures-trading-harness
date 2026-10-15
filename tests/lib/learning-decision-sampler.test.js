'use strict';

// The decision sampler (scripts/lib/learning/decision-sampler.js): curated practice-train moments re-run K times with
// sampling on, from their checkpoints, each sample seeded and recorded.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SM = require('../../scripts/lib/learning/decision-sampler');
const D = require('../../scripts/lib/train/decision-points');
const { tmpDir } = require('../helpers');

test('samplingSettings: model-neutral settings from local config, sampling on, each as FTH_SAMPLING_<NAME>', () => {
  const s = SM.samplingSettings({ top_p: 0.95, temperature: 0.8 });
  assert.deepStrictEqual(s.settings, { temperature: 0.8, top_p: 0.95 });
  assert.deepStrictEqual(s.env, { FTH_SAMPLING_TEMPERATURE: '0.8', FTH_SAMPLING_TOP_P: '0.95' });
  assert.match(s.digest, /^[0-9a-f]{16}$/);
  assert.strictEqual(SM.samplingSettings({ temperature: 0.8, top_p: 0.95 }).digest, s.digest, 'key order is no setting');
  assert.notStrictEqual(SM.samplingSettings({ temperature: 0.7 }).digest, s.digest);
  assert.throws(() => SM.samplingSettings({ top_p: 0.9 }), /temperature \(above 0\)/);
  assert.throws(() => SM.samplingSettings({ temperature: 0 }), /out of range: temperature 0/, 'greedy is no sampling');
  assert.throws(() => SM.samplingSettings({ temperature: 0.8, model: 'x' }), /unknown setting\(s\) model/, 'never a model');
  assert.throws(() => SM.samplingSettings([]), /a JSON object/);
  assert.throws(() => SM.samplingSettings({ temperature: 0.8, top_k: 0.5 }), /top_k 0\.5/);
});

test('checkBaseRun: a curated practice-train learning run only', () => {
  const run = { runId: 'b', curated: { fingerprint: 'f' }, learning: true, start: new Date('2022-03-07T00:00:00Z'), end: new Date('2022-03-12T00:00:00Z') };
  assert.doesNotThrow(() => SM.checkBaseRun(run));
  assert.throws(() => SM.checkBaseRun({ ...run, curated: null }), /names a curated list/);
  assert.throws(() => SM.checkBaseRun({ ...run, learning: false }), /declared not learning/);
  assert.throws(() => SM.checkBaseRun({ ...run, start: new Date('2024-08-05T00:00:00Z'), end: new Date('2024-08-10T00:00:00Z') }), /practice-train moments only: practice refused: .*practice-validate/);
  assert.throws(() => SM.checkBaseRun({ ...run, start: new Date('2025-03-03T00:00:00Z'), end: new Date('2025-03-08T00:00:00Z') }), /sealed/);
});

test('planSamples: K per moment, each seeded as the decision-point replay seeds a point and repeat', () => {
  const plan = SM.planSamples({ times: ['2022-03-07T14:33:00Z', '2022-03-07T14:33:00.000Z', '2022-03-07T14:36:00Z'], k: 3, seed: 5 });
  assert.strictEqual(plan.length, 6, 'a time given twice is one moment');
  assert.deepStrictEqual(plan[1], { t: '2022-03-07T14:33:00.000Z', repeat: 1, seed: D.pointSeed(5, '2022-03-07T14:33:00.000Z', 1) });
  assert.strictEqual(new Set(plan.map(p => p.seed)).size, 6, 'every sample its own seed');
  assert.notDeepStrictEqual(SM.planSamples({ times: ['2022-03-07T14:33:00Z'], k: 1, seed: 6 })[0].seed, plan[0].seed);
  assert.throws(() => SM.planSamples({ times: [], k: 0, seed: 1 }), /k: a whole number/);
  assert.throws(() => SM.planSamples({ times: [], k: 1, seed: 1.5 }), /seed: a whole number/);
});

test('runSamples: each sample from its checkpoint with the sampling env and its seed, recorded once (a resume runs none twice)', async () => {
  const out = tmpDir();
  const run = { runId: 'base1', paths: { runDir: path.join(out, 'rd') } };
  const sampling = SM.samplingSettings({ temperature: 0.9 });
  const plan = SM.planSamples({ times: ['2022-03-07T14:33:00Z', '2022-03-08T14:33:00Z'], k: 2, seed: 1 });
  const calls = [];
  const deps = {
    followersOf: () => [{ t: '2022-03-07T14:36:00.000Z', kind: 'trade' }],
    stepDeps: () => ({}),
    runPoint: async a => {
      calls.push(a);
      return { runDir: path.join(a.home, 'replay', 'base1'), times: [a.point.t], error: a.repeat === 1 && a.point.t.startsWith('2022-03-08') ? 'the runner could not run' : null };
    },
  };
  const res = await SM.runSamples({ run, checkpoints: path.join(out, 'cp'), tree: '/tree', plan, outDir: out, sampling, baseEnv: { KEEP: '1' }, deps });
  assert.strictEqual(calls.length, 4);
  assert.deepStrictEqual(calls.map(c => c.seed), plan.map(p => p.seed));
  assert.strictEqual(calls[0].checkpoint, D.checkpointOf(path.join(out, 'cp'), plan[0].t));
  assert.strictEqual(calls[0].baseEnv.FTH_SAMPLING_TEMPERATURE, '0.9');
  assert.strictEqual(calls[0].baseEnv.KEEP, '1');
  assert.notStrictEqual(calls[0].home, calls[1].home, 'each sample its own home');
  assert.strictEqual(calls[0].followers.length, 1, 'a trade it opens is followed');
  const recorded = SM.readSamples(path.join(out, SM.FILE));
  assert.deepStrictEqual(recorded.map(r => [r.t, r.repeat, r.seed, r.sampling, r.base]), plan.map(p => [p.t, p.repeat, p.seed, sampling.digest, 'base1']));
  assert.strictEqual(recorded[3].error, 'the runner could not run');
  assert.deepStrictEqual(res, recorded);
  // A resume: nothing recorded runs again.
  await SM.runSamples({ run, checkpoints: path.join(out, 'cp'), tree: '/tree', plan, outDir: out, sampling, deps });
  assert.strictEqual(calls.length, 4);
  assert.strictEqual(SM.readSamples(path.join(out, SM.FILE)).length, 4);
  assert.deepStrictEqual(SM.readSamples(path.join(out, 'none.jsonl')), []);
});

test('samplerDir: beside the run home, never inside it (a checkpoint copies the run home)', () => {
  const run = { runId: 'b1', paths: { runHome: path.join('/w', 'b1') } };
  assert.strictEqual(SM.samplerDir(run), path.join('/w', 'b1.samples'));
  assert.ok(!SM.samplerDir(run).startsWith(`${run.paths.runHome}${path.sep}`));
});

test('sourceFromSamples: each sample\'s decisions at the times it ran, each naming its sample', () => {
  const DS = require('../../scripts/lib/learning/decision-dataset');
  const F = require('../fixtures/decision-run');
  const home = tmpDir();
  const rec = { ok: true, side: 'long', entry: 21000, stop: 20990, target: 21025, size: 5, tick: 0.25, tickValue: 0.5, reads: [{ step: 'setup', skill: 's', check: true }] };
  const runs = [0, 1].map(k => F.writeRun(path.join(home, `p${k}`), {
    runId: 'base1', start: '2022-03-07T00:00:00Z', end: '2022-03-12T00:00:00Z', stage: 1,
    decisions: [{ t: '2022-03-07T14:30:00.000Z', kind: 'pass', prompt: 'earlier', headText: ['old'] }, { t: '2022-03-07T14:33:00.000Z', kind: 'take', record: rec, prompt: 'p', headText: [`sample ${k}`] }],
  }));
  const file = path.join(home, SM.FILE);
  fs.writeFileSync(file, runs.map((r, k) => JSON.stringify({ base: 'base1', t: '2022-03-07T14:33:00.000Z', repeat: k, seed: 10 + k, runDir: r.runDir, times: ['2022-03-07T14:33:00.000Z'], error: null, sampling: 'abc' })).join('\n'));
  const byDir = new Map(runs.map(r => [r.runDir, r.records]));
  const src = DS.sourceFromSamples(file, { score: dir => byDir.get(dir) });
  assert.strictEqual(src.samples, 2);
  assert.deepStrictEqual(src.decisions.map(d => [d.kind, d.sample.repeat, d.sample.seed, d.turns[0].messages.at(-1).content]), [['take', 0, 10, 'sample 0'], ['take', 1, 11, 'sample 1']], 'the checkpoint\'s earlier decisions are not the sample\'s');
  fs.writeFileSync(file, JSON.stringify({ t: 'x', repeat: 0, error: 'failed', times: [] }));
  assert.throws(() => DS.sourceFromSamples(file, { score: () => [] }), /no sample that ran/);
});
