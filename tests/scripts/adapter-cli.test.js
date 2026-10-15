'use strict';

// The dataset and adapter CLIs end to end (scripts/decision-dataset.js build and show, scripts/adapter.js init, check
// and validated) on fixture runs whose scorecards are written: the files land where asked, never in the repository.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const F = require('../fixtures/decision-run');

const ROOT = path.resolve(__dirname, '..', '..');
const run = (script, args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FTH_HOME: tmpDir(), ...env } });
const rec = skill => ({ ok: true, side: 'long', entry: 21000, stop: 20990, target: 21025, size: 5, tick: 0.25, tickValue: 0.5, reads: [{ step: 'setup', skill, check: true }] });

/** A practice-train run with its scorecard written (scorecard.jsonl, after its last step). */
const NOW = require('../../scripts/lib/learning/adapter').currentDigests(ROOT);
function scoredRun(home, { documents = { harness: NOW.prompt, skills: NOW.skills }, runId = 'r1', tag = 'CLI' } = {}) {
  const r = F.writeRun(home, {
    runId, documents, start: '2022-03-07T00:00:00Z', end: '2022-03-12T00:00:00Z', stage: 1,
    decisions: [
      { t: '2022-03-07T14:33:00.000Z', kind: 'take', record: rec('fair-value-gaps'), prompt: `${tag}-TAKE`, headText: ['take'] },
      { t: '2022-03-08T14:33:00.000Z', kind: 'pass', composed: [{ symbol: 'MNQ', ok: false, reads: [] }], prompt: `${tag}-PASS`, headText: ['pass'] },
    ],
  });
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(r.runDir, 'manifest.json'), past, past);
  fs.writeFileSync(path.join(r.runDir, 'scorecard.jsonl'), r.records.map(x => JSON.stringify(x)).join('\n'));
  return r;
}

test('decision-dataset.js build and show; adapter.js init, check and validated', () => {
  const dir = tmpDir();
  const r = scoredRun(path.join(dir, 'home'));
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'spec.json'), 'utf8'));
  const specFile = path.join(dir, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify({ ...spec, balance: { ...spec.balance, maxSkillShare: 0.9, maxYearShare: 0.95, minYears: 1 } }));
  const out = path.join(dir, 'ds');
  const b = run('decision-dataset.js', ['build', '--train', r.runDir, '--out', out, '--spec', specFile]);
  assert.strictEqual(b.status, 0, b.stderr + b.stdout);
  assert.match(b.stdout, /dataset [0-9a-f]{64}/);
  assert.match(b.stdout, /train labels: 2 correct, 0 incorrect, 0 unverifiable/);
  assert.ok(fs.readFileSync(path.join(out, 'step1', 'train.jsonl'), 'utf8').includes('CLI-TAKE'));
  assert.strictEqual(run('decision-dataset.js', ['show', out]).status, 0);
  // A run made under other skills: its examples dropped and counted; included only by name, marked.
  const old = scoredRun(path.join(dir, 'old'), { documents: { harness: NOW.prompt, skills: '0'.repeat(64) }, runId: 'r0', tag: 'OLD' });
  const both = run('decision-dataset.js', ['build', '--train', r.runDir, '--train', old.runDir, '--out', path.join(dir, 'ds2'), '--spec', specFile]);
  assert.strictEqual(both.status, 0, both.stderr);
  assert.match(both.stdout, /dropped for a stale digest: [1-9]\d* train, 0 validate example/);
  assert.ok(!fs.readFileSync(path.join(dir, 'ds2', 'step1', 'train.jsonl'), 'utf8').includes('OLD-TAKE'));
  const inc = run('decision-dataset.js', ['build', '--train', r.runDir, '--train', old.runDir, '--out', path.join(dir, 'ds3'), '--spec', specFile, '--include-digest', '00000000']);
  assert.match(inc.stdout, /included under other digests \(00000000\): [1-9]/);
  assert.ok(fs.readFileSync(path.join(dir, 'ds3', 'meta.jsonl'), 'utf8').includes('"current":false'));
  assert.match(run('decision-dataset.js', ['build', '--train', r.runDir, '--out', out, '--spec', specFile]).stderr, /already holds a dataset/);
  assert.match(run('decision-dataset.js', ['build', '--validate', r.runDir, '--out', path.join(dir, 'x')]).stderr, /usage/);
  assert.match(run('decision-dataset.js', ['build', '--train', r.runDir, '--bogus', 'x']).stderr, /unknown flag --bogus/);

  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ iters: 600, num_layers: 16 }));
  const m = path.join(dir, 'adapter', 'manifest.json');
  const init = run('adapter.js', ['init', '--name', 'm1', '--base-model', 'the-base', '--folder', 'base-folder', '--dataset', out, '--step', '1', '--settings', settings, '--out', m]);
  assert.strictEqual(init.status, 0, init.stderr);
  const doc = JSON.parse(fs.readFileSync(m, 'utf8'));
  assert.strictEqual(doc.validation.status, 'pending');
  assert.strictEqual(doc.dataset.fingerprint, JSON.parse(fs.readFileSync(path.join(out, 'dataset.json'), 'utf8')).fingerprint);
  assert.deepStrictEqual({ skills: doc.harness.skills, prompt: doc.harness.prompt }, require('../../scripts/lib/learning/adapter').currentDigests(ROOT));
  assert.match(doc.harness.commit, /^[0-9a-f]{40}$/);
  const c = run('adapter.js', ['check', m]);
  assert.strictEqual(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /m1: step 1 on the-base, .*validation pending; current/);
  const result = path.join(dir, 'result.json');
  fs.writeFileSync(result, JSON.stringify({ exitTest: 'PASS' }));
  assert.strictEqual(run('adapter.js', ['validated', m, '--status', 'passed', '--runs', 'base1,adapted1', '--result', result]).status, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(m, 'utf8')).validation.runs, ['base1', 'adapted1']);
  // Stale: a manifest trained on other skills.
  fs.writeFileSync(m, JSON.stringify({ ...doc, harness: { ...doc.harness, skills: '0'.repeat(64) } }));
  const stale = run('adapter.js', ['check', m]);
  assert.strictEqual(stale.status, 1);
  assert.match(stale.stdout, /STALE \(skills changed since it was trained\)/);
  assert.match(run('adapter.js', ['init', '--name', 'm2']).stderr, /--base-model: required/);
  assert.match(run('adapter.js', ['init', '--name', 'm2', '--base-model', 'b', '--folder', 'f', '--dataset', out, '--step', '2', '--settings', settings, '--out', path.join(dir, 'm2.json')]).stderr, /--parent: step 2 starts from a step-1 adapter/);
});
