'use strict';

// Fine-tuning adapters (scripts/lib/learning/adapter.js): the training spec, the manifest and its validator, the
// declared selection, and the preflight's adapter check (N/A with none; FAIL missing, invalid, stale or unvalidated).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const A = require('../../scripts/lib/learning/adapter');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { treeDigest, HARNESS_DIRS, CODE_DIRS } = require('../../scripts/lib/session/record');
const { tmpDir } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, A.SPEC_FILE), 'utf8'));
const H = { skills: '1'.repeat(64), prompt: '2'.repeat(64), code: '3'.repeat(64) };
// A passed validation as `adapter.js validated` records it: its runs, their setup records' digests, its result, sealed.
const SETUP = { base: { runId: 'base', pinned: { stage: 1 } }, adapted: { runId: 'adapted', pinned: { stage: 1 }, config: { adapter: '"x"' } } };
const passed = (kind = 'stage-1-exit-test', result = { exitTest: [{ test: 'correct-reads', status: 'PASS' }], why: 'x' }, dirs = { base: '/no/such/run/base', adapted: '/no/such/run/adapted' }) => A.sealValidation({
  kind, window: 'practice-validate', status: 'passed', runs: ['base', 'adapted'], result,
  evidence: Object.fromEntries(['base', 'adapted'].map(k => [k, { runId: k, dir: dirs[k], setup: A.recordDigest(SETUP[k]) }])),
});
const manifest = (over = {}) => ({
  v: 1, name: 'm1', base: { model: 'the-base', folder: 'base-folder' }, harness: { commit: 'c'.repeat(40), ...H },
  dataset: { fingerprint: 'd'.repeat(64) }, training: { step: 1, method: 'lora', seed: 1, settings: { iters: 600 } },
  validation: passed(), ...over,
});
const step2 = (over = {}) => manifest({ training: { step: 2, method: 'lora', seed: 1, settings: { iters: 400 }, stage1Mix: 0.2, parent: 'sha256:0123456789abcdef', parentManifest: '/models/m1/manifest.json', ...over }, validation: { kind: 'prop-keep-rule', window: 'practice-validate', status: 'pending' } });

test('the repository\'s spec is valid: the splits, the balance, and the two steps (stage 1, then stage 2 with stage 1 mixed back in)', () => {
  assert.deepStrictEqual(A.validateSpec(SPEC), []);
  assert.strictEqual(SPEC.dataset.train, 'practice-train');
  assert.deepStrictEqual(SPEC.steps.map(s => [s.step, s.stages, s.validation]), [[1, [1], 'stage-1-exit-test'], [2, [2], 'prop-keep-rule']]);
  const bad = (patch, re) => assert.match(A.validateSpec(patch(JSON.parse(JSON.stringify(SPEC)))).join('; '), re);
  bad(s => { s.dataset.train = 'test'; return s; }, /train only on practice-train/);
  bad(s => { s.dataset.version = 1; return s; }, /dataset.version: 2/);
  bad(s => { s.dataset.refused = ['test']; return s; }, /sealed/);
  bad(s => { s.dataset.fingerprint = 'abc'; return s; }, /dataset.fingerprint/);
  bad(s => { s.steps[1].mixStage1 = 0; return s; }, /steps\[1\]/);
  bad(s => { s.steps[0].stages = [1, 2]; return s; }, /steps\[0\]/);
  bad(s => { s.steps = [s.steps[0]]; return s; }, /steps: two/);
  bad(s => { s.balance.takeShare = [0.7, 0.3]; return s; }, /takeShare/);
  bad(s => { s.balance.minNearMllShare = 1; return s; }, /minNearMllShare/);
  assert.deepStrictEqual(A.validateSpec(null), ['the spec: a JSON object']);
});

test('the manifest: commit, skills and prompt digests, dataset, base model, settings and the validation result', () => {
  assert.deepStrictEqual(A.validateManifest(manifest()), []);
  assert.deepStrictEqual(A.validateManifest(step2()), []);
  const bad = (m, re) => assert.match(A.validateManifest(m).join('; '), re);
  bad(manifest({ harness: { ...H, commit: 'abc' } }), /harness: \{ commit/);
  bad(manifest({ harness: { commit: 'c'.repeat(40), skills: H.skills } }), /harness/);
  bad(manifest({ harness: { commit: 'c'.repeat(40), skills: H.skills, prompt: H.prompt } }), /skills, prompt and code/);
  bad(step2({ parentManifest: undefined }), /training.parentManifest/);
  bad(step2({ parentManifest: 'm1/manifest.json' }), /training.parentManifest/);
  bad(manifest({ dataset: {} }), /dataset.fingerprint/);
  bad(manifest({ base: { model: '', folder: 'x' } }), /base:/);
  bad(manifest({ validation: undefined }), /validation: missing/);
  bad(manifest({ validation: { kind: 'prop-keep-rule', window: 'practice-validate', status: 'passed', runs: ['a'], result: {} } }), /step 1 is validated by "stage-1-exit-test"/);
  bad(manifest({ validation: { kind: 'stage-1-exit-test', window: 'test', status: 'pending' } }), /window: "practice-validate"/);
  bad(manifest({ validation: { kind: 'stage-1-exit-test', window: 'practice-validate', status: 'passed' } }), /names its runs/);
  bad(manifest({ training: { step: 3, method: 'lora', seed: 1, settings: { a: 1 } } }), /training.step/);
  bad(manifest({ training: { step: 1, method: 'lora', seed: 1, settings: {} } }), /training.settings/);
  bad(manifest({ training: { step: 1, method: 'lora', seed: 1, settings: { a: 1 }, stage1Mix: 0.2 } }), /step 1 trains on stage-1 data only/);
  bad(step2({ parent: undefined }), /training.parent/);
  bad(step2({ stage1Mix: undefined }), /stage1Mix/);
  // Against the spec: its dataset fingerprint (when it states one) and step 2's mix.
  assert.deepStrictEqual(A.validateManifest(step2(), { spec: SPEC }), []);
  assert.match(A.validateManifest(step2({ stage1Mix: 0.3 }), { spec: SPEC }).join(), /not the spec's 0.2/);
  assert.match(A.validateManifest(manifest(), { spec: { ...SPEC, dataset: { ...SPEC.dataset, fingerprint: 'e'.repeat(64) } } }).join(), /not the spec's/);
  assert.deepStrictEqual(A.validateManifest('x'), ['the manifest: a JSON object']);
});

test('adapterTag and adapterFile: none selected is null; a manifest by the digest of its bytes; an unreadable one says so', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, '{"a":1}\n');
  assert.strictEqual(A.adapterTag({}), null);
  assert.strictEqual(A.adapterTag({ adapter: null }), null);
  assert.strictEqual(A.adapterTag({ adapter: '' }), null);
  assert.match(A.adapterTag({ adapter: file }), /^sha256:[0-9a-f]{16}$/);
  assert.strictEqual(A.adapterTag({ adapter: path.join(dir, 'gone.json') }), 'unreadable');
  assert.strictEqual(A.adapterFile({ adapter: '~/m.json' }, { home: '/h' }), path.join('/h', 'm.json'));
});

test('the runner config: adapter is an absolute or ~/ path, or none; the runner never needs one', () => {
  const base = { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], sessions: ['09:30-15:50@America/New_York'] };
  assert.doesNotThrow(() => validateConfig(base));
  assert.doesNotThrow(() => validateConfig({ ...base, adapter: '/abs/manifest.json' }));
  assert.doesNotThrow(() => validateConfig({ ...base, adapter: '~/a/manifest.json' }));
  assert.doesNotThrow(() => validateConfig({ ...base, adapter: null }));
  assert.throws(() => validateConfig({ ...base, adapter: 'adapters/m/manifest.json' }), /adapter: the adapter's manifest, an absolute or ~\/ path/);
  assert.throws(() => validateConfig({ ...base, adapter: 3 }), /adapter:/);
  assert.strictEqual(validateConfig(base).adapter, undefined, 'no default: a base run');
});

/** The preflight check on a manifest file and the harness digests now. */
function check({ m = manifest(), now = H, role = 'practice-train', selected = true, write = true, raw = null } = {}) {
  const dir = tmpDir();
  const file = path.join(dir, 'manifest.json');
  if (write) fs.writeFileSync(file, raw === null ? JSON.stringify(m) : raw);
  const read = { adapterManifest: f => A.readJsonFile(f), adapterSpec: () => SPEC, harnessDigests: () => now };
  return A.adapterCheck({ cfg: selected ? { adapter: file } : {}, role, read });
}

test('adapterCheck: N/A with none selected; PASS current and validated; FAIL missing, invalid, stale or unvalidated', () => {
  assert.strictEqual(check({ selected: false }).status, 'N/A');
  const ok = check();
  assert.strictEqual(ok.status, 'PASS', ok.detail);
  assert.match(ok.detail, /current skills, prompt and code, validation passed/);
  assert.match(check({ write: false }).detail, /can't be read: .*missing/);
  assert.strictEqual(check({ write: false }).status, 'FAIL');
  assert.match(check({ raw: '{not json' }).detail, /not JSON/);
  assert.match(check({ m: manifest({ harness: { commit: 'x' } }) }).detail, /manifest invalid: harness/);
  // Stale: the skills or the prompt changed since it was trained.
  const skills = check({ now: { ...H, skills: '9'.repeat(64) } });
  assert.strictEqual(skills.status, 'FAIL');
  assert.match(skills.detail, /m1 is stale: its skills digest 111111111111 is not the harness's now \(999999999999\): retrain it/);
  assert.match(check({ now: { ...H, prompt: '9'.repeat(64) } }).detail, /stale: its prompt digest/);
  assert.match(check({ now: { ...H, skills: '8'.repeat(64), prompt: '9'.repeat(64) } }).detail, /skills and prompt digests/);
  // The code digest too: the harness code the adapter's examples were made under.
  const code = check({ now: { ...H, code: '9'.repeat(64) } });
  assert.strictEqual(code.status, 'FAIL');
  assert.match(code.detail, /stale: its code digest 333333333333/);
  // The validation result.
  const missing = check({ m: manifest({ validation: undefined }) });
  assert.strictEqual(missing.status, 'FAIL');
  assert.match(missing.detail, /the validation result is missing/);
  assert.match(check({ m: manifest({ validation: { kind: 'stage-1-exit-test', window: 'practice-validate', status: 'failed', runs: ['a'], result: {} } }) }).detail, /failed its stage-1-exit-test validation/);
  const pending = manifest({ validation: { kind: 'stage-1-exit-test', window: 'practice-validate', status: 'pending' } });
  assert.match(check({ m: pending }).detail, /not validated yet: it runs only in its practice-validate evaluation \(this run is practice-train\)/);
  assert.strictEqual(check({ m: pending, role: null }).status, 'FAIL');
  assert.strictEqual(check({ m: pending, role: 'practice-validate' }).status, 'PASS', 'its own evaluation');
  // A relative selection is refused (the runner config refuses it too).
  assert.strictEqual(A.adapterCheck({ cfg: { adapter: 'm.json' }, role: 'practice-train', read: {} }).status, 'FAIL');
});

test('currentDigests: the skills digest and the documents the cycles read (the setup record\'s), of this tree', () => {
  assert.deepStrictEqual(A.currentDigests(ROOT), { skills: treeDigest(ROOT, ['skills']), prompt: treeDigest(ROOT, HARNESS_DIRS), code: treeDigest(ROOT, CODE_DIRS) });
});


test('adapterCheck: a passed validation counts only with its evidence; a hand-edited passed is refused', () => {
  assert.strictEqual(check().status, 'PASS');
  const v = passed();
  // Hand-edited: a passed with no evidence, a status flipped from failed, a result edited, runs swapped.
  const edits = [
    { kind: v.kind, window: v.window, status: 'passed', runs: ['a', 'b'], result: { exitTest: [{ test: 't', status: 'PASS' }] } },
    { ...v, hash: undefined },
    { ...A.sealValidation({ ...v, status: 'failed' }), status: 'passed' },
    { ...v, result: { ...v.result, exitTest: [{ test: 'correct-reads', status: 'PASS' }, { test: 'expectancy', status: 'PASS' }] } },
    { ...v, runs: ['adapted', 'base'] },
  ];
  for (const validation of edits) {
    const r = check({ m: manifest({ validation }) });
    assert.strictEqual(r.status, 'FAIL', JSON.stringify(validation));
    assert.match(r.detail, /not backed by its evidence/);
  }
  // Sealed, but its result is no pass: step 1 every exit-test criterion PASS; step 2 the keep rule's kept.
  assert.match(check({ m: manifest({ validation: passed('stage-1-exit-test', { exitTest: [{ test: 't', status: 'FAIL' }] }) }) }).detail, /not a passed stage-1 exit test/);
  // The runs' setup records, where on this machine, must be the ones the validation read.
  const dir = tmpDir();
  for (const k of ['base', 'adapted']) { fs.mkdirSync(path.join(dir, k)); fs.writeFileSync(path.join(dir, k, 'setup.json'), JSON.stringify(SETUP[k])); }
  const local = manifest({ validation: passed(undefined, undefined, { base: path.join(dir, 'base'), adapted: path.join(dir, 'adapted') }) });
  assert.strictEqual(check({ m: local }).status, 'PASS', check({ m: local }).detail);
  fs.writeFileSync(path.join(dir, 'adapted', 'setup.json'), JSON.stringify({ ...SETUP.adapted, config: { adapter: '"y"' } }));
  const moved = check({ m: local });
  assert.strictEqual(moved.status, 'FAIL');
  assert.match(moved.detail, /the adapted run's setup record .* is not the one the validation read/);
  assert.deepStrictEqual(A.evidenceErrors(manifest()), []);
});

test('adapterCheck: a step-2 adapter needs its parent: present, the tag it was trained from, step 1 and passed with its evidence', () => {
  const dir = tmpDir();
  const parentFile = path.join(dir, 'parent.json');
  const write = p => { fs.writeFileSync(parentFile, JSON.stringify(p)); return A.adapterTag({ adapter: parentFile }); };
  const child = (tag, validation = passed('prop-keep-rule', { keep: { verdict: 'kept' }, why: 'x' })) => ({ ...step2({ parent: tag, parentManifest: parentFile }), validation });
  const tag = write(manifest());
  const ok = check({ m: child(tag) });
  assert.strictEqual(ok.status, 'PASS', ok.detail);
  // Its own evaluation (pending, practice-validate) needs the parent too.
  assert.strictEqual(check({ m: child(tag, { kind: 'prop-keep-rule', window: 'practice-validate', status: 'pending' }), role: 'practice-validate' }).status, 'PASS');
  // A step-2 passed result that is not the keep rule's kept.
  assert.match(check({ m: child(tag, passed('prop-keep-rule', { why: 'B better' })) }).detail, /keep rule's `kept`/);
  // The parent missing, changed since (its tag), pending, failed, a step-2 one, or its passed unbacked.
  fs.rmSync(parentFile);
  assert.match(check({ m: child(tag) }).detail, /parent's manifest can't be read/);
  const t2 = write(manifest());
  write({ ...manifest(), name: 'm1b' });
  assert.match(check({ m: child(t2) }).detail, /not the parent it was trained from/);
  const pending = write(manifest({ validation: { kind: 'stage-1-exit-test', window: 'practice-validate', status: 'pending' } }));
  assert.match(check({ m: child(pending) }).detail, /its parent m1 is not validated \(pending\)/);
  assert.match(check({ m: child(pending), role: 'practice-validate' }).detail, /not validated \(pending\)/, 'not even in its own evaluation');
  const failed = write(manifest({ validation: { ...passed(), status: 'failed' } }));
  assert.strictEqual(check({ m: child(failed) }).status, 'FAIL');
  const unbacked = write(manifest({ validation: { ...passed(), hash: '0'.repeat(64) } }));
  assert.match(check({ m: child(unbacked) }).detail, /its parent m1's validation: its hash does not match/);
  const two = write(step2({ parentManifest: parentFile }));
  assert.match(check({ m: child(two) }).detail, /parent/);
});
