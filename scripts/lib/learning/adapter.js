'use strict';

/**
 * Fine-tuning adapters (adapters/README.md, docs/TRAINING.md "Fine-tuning on verified decisions"): the model-neutral
 * training spec (adapters/spec.json), each adapter's manifest, and how a run declares the adapter it runs with. The
 * weights, checkpoints, datasets and manifests stay on the user's machine (gitignored); nothing in the harness needs an
 * adapter to be there: a run without one is a base run, and the runner never reads the selection.
 *
 * The spec (validateSpec):
 *   v 1; dataset { format 'chat-jsonl', version 2 (with the head trader's tool calls), fingerprint (the expected dataset's, sha256 hex, or null before one is built),
 *   train 'practice-train', validate 'practice-validate', refused ['test', 'final'] }; balance { seed, takeShare [lo, hi],
 *   maxSkillShare, maxYearShare, minYears, minNearMllShare }; steps: step 1 { stages [1], mixStage1 0, validation
 *   'stage-1-exit-test' } and step 2 { stages [2], mixStage1 (0 < x < 1: the slice of stage-1 data mixed back in),
 *   validation 'prop-keep-rule' }: two-step training, stage 1 alone first, then stage 2 with stage 1 mixed back in.
 *
 * The manifest (validateManifest), one per adapter, local:
 *   v 1, name, base { model, folder (its adapters/<folder>) }, harness { commit (40 hex), skills, prompt (sha256 hex: the
 *   skills digest and the documents the cycles read, session/record.js treeDigest of HARNESS_DIRS) }, dataset
 *   { fingerprint }, training { step 1 | 2, method 'lora', seed, settings {...}, stage1Mix (step 2: the spec's),
 *   parent (step 2: the step-1 adapter's manifest digest) }, validation { kind (step 1 'stage-1-exit-test', step 2
 *   'prop-keep-rule'), window 'practice-validate', status 'pending' | 'passed' | 'failed', runs [runId] and result
 *   (when not pending), at }.
 *
 * Selection: the runner config's `adapter`, the manifest's path (absolute or ~/); a declaration of what the local model
 * server runs with, read only by the training preflight (`adapter`), the run's hashes and its A/B setup record
 * (adapterTag): two replays that differ only in the adapter differ in that one declared field.
 *
 *   SPEC_FILE, VALIDATIONS, STATUSES
 *   validateSpec(spec)                         [error]
 *   validateManifest(m, { spec })              [error]
 *   readJsonFile(file)                         the parsed file, or throws with why
 *   currentDigests(root)                       { skills, prompt, code } of the harness tree (code: session/record.js CODE_DIRS)
 *   adapterFile(cfg, { home })                 the selected manifest's path, or null (none selected)
 *   adapterTag(cfg, { home })                  null (none), else 'sha256:<16 hex of the manifest's bytes>' or 'unreadable'
 *   adapterCheck({ cfg, role, read, home })    { status: 'PASS' | 'FAIL' | 'N/A', detail } (the preflight's `adapter`)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { expandHome } = require('../paths');

const SPEC_FILE = path.join('adapters', 'spec.json');
const VALIDATIONS = Object.freeze({ 1: 'stage-1-exit-test', 2: 'prop-keep-rule' });
const STATUSES = Object.freeze(['pending', 'passed', 'failed']);
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const share = x => typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 1;

function validateSpec(spec) {
  const e = [];
  if (!isObj(spec)) return ['the spec: a JSON object'];
  if (spec.v !== 1) e.push('v: 1');
  const d = spec.dataset;
  if (!isObj(d)) e.push('dataset: an object');
  else {
    if (d.format !== 'chat-jsonl') e.push('dataset.format: "chat-jsonl"');
    if (d.version !== 2) e.push('dataset.version: 2 (chat JSONL with the head trader\'s tool calls and their results)');
    if (!(d.fingerprint === null || HEX64.test(String(d.fingerprint)))) e.push('dataset.fingerprint: the expected dataset\'s sha256 (64 hex), or null before one is built');
    if (d.train !== 'practice-train') e.push('dataset.train: "practice-train" (train only on practice-train)');
    if (d.validate !== 'practice-validate') e.push('dataset.validate: "practice-validate"');
    if (!(Array.isArray(d.refused) && ['test', 'final'].every(r => d.refused.includes(r)))) e.push('dataset.refused: ["test", "final"] (sealed)');
  }
  const b = spec.balance;
  if (!isObj(b)) e.push('balance: an object');
  else {
    if (!Number.isInteger(b.seed)) e.push('balance.seed: a whole number');
    if (!(Array.isArray(b.takeShare) && b.takeShare.length === 2 && b.takeShare.every(share) && b.takeShare[0] < b.takeShare[1])) e.push('balance.takeShare: [lo, hi], 0 < lo < hi < 1 (takes among takes and passes)');
    for (const k of ['maxSkillShare', 'maxYearShare', 'minNearMllShare']) if (!share(b[k])) e.push(`balance.${k}: a share above 0 and under 1`);
    if (!(Number.isInteger(b.minYears) && b.minYears >= 1)) e.push('balance.minYears: a whole number from 1');
  }
  const steps = Array.isArray(spec.steps) ? spec.steps : null;
  if (!steps || steps.length !== 2) e.push('steps: two (step 1 on stage-1 data, step 2 on stage-2 data with stage 1 mixed back in)');
  else {
    const [s1, s2] = steps;
    if (!(isObj(s1) && s1.step === 1 && JSON.stringify(s1.stages) === '[1]' && s1.mixStage1 === 0 && s1.validation === VALIDATIONS[1])) e.push(`steps[0]: { step 1, stages [1], mixStage1 0, validation "${VALIDATIONS[1]}" }`);
    if (!(isObj(s2) && s2.step === 2 && JSON.stringify(s2.stages) === '[2]' && share(s2.mixStage1) && s2.validation === VALIDATIONS[2])) e.push(`steps[1]: { step 2, stages [2], mixStage1 (a share above 0 and under 1), validation "${VALIDATIONS[2]}" }`);
  }
  return e;
}

function validateManifest(m, { spec = null } = {}) {
  const e = [];
  if (!isObj(m)) return ['the manifest: a JSON object'];
  if (m.v !== 1) e.push('v: 1');
  if (!NAME.test(String(m.name || ''))) e.push('name: letters, digits, ".", "_", "-" (up to 64)');
  if (!(isObj(m.base) && typeof m.base.model === 'string' && m.base.model.trim() && NAME.test(String(m.base.folder || '')))) e.push('base: { model (the base model), folder (its folder under adapters/) }');
  const h = m.harness;
  if (!(isObj(h) && HEX40.test(String(h.commit)) && HEX64.test(String(h.skills)) && HEX64.test(String(h.prompt)))) e.push('harness: { commit (40 hex), skills and prompt (sha256 digests, 64 hex) }');
  if (!(isObj(m.dataset) && HEX64.test(String(m.dataset.fingerprint)))) e.push('dataset.fingerprint: the dataset\'s sha256 (64 hex)');
  const t = m.training;
  const step = isObj(t) ? t.step : null;
  if (!isObj(t)) e.push('training: an object');
  else {
    if (step !== 1 && step !== 2) e.push('training.step: 1 or 2');
    if (t.method !== 'lora') e.push('training.method: "lora"');
    if (!Number.isInteger(t.seed)) e.push('training.seed: a whole number');
    if (!isObj(t.settings) || !Object.keys(t.settings).length) e.push('training.settings: the settings it trained with');
    if (step === 2 && !share(t.stage1Mix)) e.push('training.stage1Mix: step 2\'s slice of stage-1 data (above 0, under 1)');
    if (step === 2 && !/^sha256:[0-9a-f]{16}$/.test(String(t.parent || ''))) e.push('training.parent: step 2 starts from a step-1 adapter: its manifest\'s tag (sha256:<16 hex>)');
    if (step === 1 && t.stage1Mix !== undefined && t.stage1Mix !== 0) e.push('training.stage1Mix: step 1 trains on stage-1 data only');
  }
  const v = m.validation;
  if (!isObj(v)) e.push('validation: missing (the validation result: pending, passed or failed)');
  else {
    if (step && v.kind !== VALIDATIONS[step]) e.push(`validation.kind: step ${step} is validated by "${VALIDATIONS[step]}"`);
    if (v.window !== 'practice-validate') e.push('validation.window: "practice-validate"');
    if (!STATUSES.includes(v.status)) e.push(`validation.status: one of ${STATUSES.join(', ')}`);
    if (v.status && v.status !== 'pending' && !(Array.isArray(v.runs) && v.runs.length && isObj(v.result))) e.push('validation: a result names its runs and holds its result');
  }
  if (spec && isObj(spec.dataset) && spec.dataset.fingerprint && isObj(m.dataset) && m.dataset.fingerprint !== spec.dataset.fingerprint) e.push(`dataset.fingerprint: ${String(m.dataset.fingerprint).slice(0, 12)} is not the spec's ${String(spec.dataset.fingerprint).slice(0, 12)}`);
  if (spec && step === 2 && Array.isArray(spec.steps) && isObj(spec.steps[1]) && isObj(t) && t.stage1Mix !== spec.steps[1].mixStage1) e.push(`training.stage1Mix: ${t.stage1Mix}, not the spec's ${spec.steps[1].mixStage1}`);
  return e;
}

function readJsonFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { throw new Error(`${file}: ${err.code === 'ENOENT' ? 'missing' : err.message}`, { cause: err }); }
  try { return JSON.parse(text); } catch (err) { throw new Error(`${file}: not JSON (${err.message})`, { cause: err }); }
}

function currentDigests(root) {
  const { treeDigest, HARNESS_DIRS } = require('../session/record');
  const { CODE_DIRS } = require('../session/record');
  return { skills: treeDigest(root, ['skills']), prompt: treeDigest(root, HARNESS_DIRS), code: treeDigest(root, CODE_DIRS) };
}

function adapterFile(cfg, { home = os.homedir() } = {}) {
  const sel = isObj(cfg) ? cfg.adapter : undefined;
  if (sel === undefined || sel === null || sel === '') return null;
  return path.resolve(expandHome(String(sel), home));
}

function adapterTag(cfg, { home = os.homedir() } = {}) {
  const file = adapterFile(cfg, { home });
  if (!file) return null;
  try { return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)}`; } catch (_err) { return 'unreadable'; }
}

const res = (status, detail) => ({ status, detail });

/**
 * The preflight's `adapter` check: N/A with none selected; FAIL on a missing or invalid manifest, a stale one (its
 * skills or prompt digest isn't the harness's now), or a missing validation result; a pending validation runs only on
 * practice-validate (its own evaluation), a failed one never.
 */
function adapterCheck({ cfg, role, read, home = os.homedir() }) {
  const file = adapterFile(cfg, { home });
  if (!file) return res('N/A', 'no adapter selected (the runner config names none): a base run');
  if (!/^(\/|~\/)/.test(String(cfg.adapter))) return res('FAIL', `adapter: "${cfg.adapter}" is not an absolute or ~/ path to the adapter's manifest`);
  let m;
  try { m = read.adapterManifest(file); } catch (err) { return res('FAIL', `the selected adapter's manifest can't be read: ${err.message}`); }
  let spec = null;
  try { spec = read.adapterSpec(); } catch (_err) { /* checked by its own test; the manifest alone is checked */ }
  const errors = validateManifest(m, { spec });
  if (errors.some(x => x.startsWith('validation: missing'))) return res('FAIL', `adapter ${m && m.name}: the validation result is missing (record it, or "status": "pending" for its practice-validate evaluation)`);
  if (errors.length) return res('FAIL', `adapter manifest invalid: ${errors.join('; ')}`);
  const now = read.harnessDigests();
  const stale = ['skills', 'prompt'].filter(k => m.harness[k] !== now[k]);
  if (stale.length) return res('FAIL', `adapter ${m.name} is stale: its ${stale.join(' and ')} digest${stale.length > 1 ? 's' : ''} ${stale.map(k => m.harness[k].slice(0, 12)).join(', ')} ${stale.length > 1 ? 'are' : 'is'} not the harness's now (${stale.map(k => now[k].slice(0, 12)).join(', ')}): retrain it on this harness`);
  if (m.validation.status === 'failed') return res('FAIL', `adapter ${m.name} failed its ${m.validation.kind} validation: never run`);
  if (m.validation.status === 'pending' && role !== 'practice-validate') return res('FAIL', `adapter ${m.name} is not validated yet: it runs only in its practice-validate evaluation (this run is ${role || 'outside the split'})`);
  return res('PASS', `adapter ${m.name} (step ${m.training.step}, base ${m.base.model}): current skills and prompt, validation ${m.validation.status}`);
}

module.exports = { SPEC_FILE, VALIDATIONS, STATUSES, validateSpec, validateManifest, readJsonFile, currentDigests, adapterFile, adapterTag, adapterCheck };
