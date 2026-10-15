#!/usr/bin/env node
/**
 * A LoRA adapter's manifest (adapters/README.md; scripts/lib/learning/adapter.js). Local files only: the manifest
 * lives beside the adapter's weights, never in the repository. Nothing here trains, serves or names a model of its own.
 *
 *   node scripts/adapter.js init --name N --base-model M --folder F --dataset <dataset dir> --step 1|2 --settings <json file>
 *       [--seed N] [--parent <step-1 manifest>] --out <manifest file>
 *       a manifest: the harness commit, its skills and prompt digests now, the dataset's fingerprint (checked against
 *       its files), the training settings, and a pending validation (step 1: the stage-1 exit test; step 2: the prop
 *       keep rule; both on practice-validate)
 *   node scripts/adapter.js check <manifest>
 *       valid against adapters/spec.json, current (its skills, prompt and code digests the harness's now), and a
 *       passed validation backed by its evidence
 *   node scripts/adapter.js validated <manifest> --base <run dir> --adapted <run dir> [--account <name>]
 *       derives the validation result from the A/B comparison of the two runs (learning/adapter-validation.js deriveValidation:
 *       both finished on practice-validate, differing only in the adapter, the adapted one this manifest; step 1 the
 *       stage-1 exit test, step 2 the training loop's full keep rule) and records it with its evidence (the runs, their
 *       setup records' digests) under a hash; never a result written by hand
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { expandHome } = require('./lib/paths');
const A = require('./lib/learning/adapter');
const { readDataset } = require('./lib/learning/decision-dataset');

const ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: adapter.js init --name N --base-model M --folder F --dataset <dir> --step 1|2 --settings <file> [--seed N] [--parent <manifest>] --out <file> | check <manifest> | validated <manifest> --base <run dir> --adapted <run dir> [--account <name>]';
const FLAGS = ['name', 'base-model', 'folder', 'dataset', 'step', 'settings', 'seed', 'parent', 'out', 'base', 'adapted', 'account'];
const say = msg => process.stdout.write(`[adapter] ${msg}\n`);
const abs = p => path.resolve(expandHome(p));

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    if (!FLAGS.includes(a.slice(2))) throw new Error(`unknown flag ${a} (${USAGE})`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${a}: give its value`);
    o[a.slice(2)] = argv[i + 1];
    i += 1;
  }
  return o;
}

const spec = () => A.readJsonFile(path.join(ROOT, A.SPEC_FILE));

function writeManifest(file, m) {
  const errors = A.validateManifest(m, { spec: spec() });
  if (errors.length) throw new Error(`the manifest is invalid: ${errors.join('; ')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  say(`wrote ${file}`);
}

function init(o) {
  for (const k of ['name', 'base-model', 'folder', 'dataset', 'step', 'settings', 'out']) if (!o[k]) throw new Error(`--${k}: required (${USAGE})`);
  const step = Number(o.step);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const digests = A.currentDigests(ROOT);
  const dataset = readDataset(abs(o.dataset));
  if (dataset.harness.skills !== digests.skills || dataset.harness.harness !== digests.prompt || dataset.harness.code !== digests.code) say('note: the dataset was built from runs on other skills, prompts or code than the harness now');
  const training = { step, method: 'lora', seed: o.seed === undefined ? 1 : Number(o.seed), settings: A.readJsonFile(abs(o.settings)) };
  if (step === 2) {
    if (!o.parent) throw new Error('--parent: step 2 starts from a step-1 adapter (its manifest)');
    training.stage1Mix = spec().steps[1].mixStage1;
    const parent = A.readJsonFile(abs(o.parent));
    if (!(parent.training && parent.training.step === 1 && parent.validation && parent.validation.status === 'passed')) throw new Error('--parent: a step-1 adapter whose validation passed');
    const pe = A.evidenceErrors(parent);
    if (pe.length) throw new Error(`--parent: its passed validation is not backed by its evidence: ${pe.join('; ')}`);
    training.parent = A.adapterTag({ adapter: abs(o.parent) });
    training.parentManifest = abs(o.parent);
  }
  writeManifest(abs(o.out), {
    v: 1, name: o.name, base: { model: o['base-model'], folder: o.folder }, harness: { commit, ...digests },
    dataset: { fingerprint: dataset.fingerprint }, training,
    validation: { kind: A.VALIDATIONS[step], window: 'practice-validate', status: 'pending' },
  });
  return 0;
}

function check(file) {
  const m = A.readJsonFile(abs(file));
  const errors = A.validateManifest(m, { spec: spec() });
  if (errors.length) { say(`invalid: ${errors.join('; ')}`); return 1; }
  const now = A.currentDigests(ROOT);
  const stale = A.DIGESTS.filter(k => m.harness[k] !== now[k]);
  const unbacked = m.validation.status === 'passed' ? A.evidenceErrors(m) : [];
  say(`${m.name}: step ${m.training.step} on ${m.base.model}, dataset ${m.dataset.fingerprint.slice(0, 12)}, validation ${m.validation.status}${unbacked.length ? ` NOT BACKED BY ITS EVIDENCE (${unbacked.join('; ')})` : ''}; ${stale.length ? `STALE (${stale.join(' and ')} changed since it was trained)` : 'current'}; tag ${A.adapterTag({ adapter: abs(file) })}`);
  return stale.length || unbacked.length || m.validation.status === 'failed' ? 1 : 0;
}

function validated(file, o) {
  if (!o.base || !o.adapted) throw new Error(USAGE);
  const m = A.readJsonFile(abs(file));
  if (m.validation && m.validation.status !== 'pending') throw new Error(`${m.name}: already ${m.validation.status} (runs ${(m.validation.runs || []).join(', ')})`);
  // The tag the adapted run declared: this manifest's bytes as they were when it ran (still pending).
  const tag = A.adapterTag({ adapter: abs(file) });
  const v = require('./lib/learning/adapter-validation').deriveValidation({ manifest: m, tag, base: abs(o.base), adapted: abs(o.adapted), env: process.env, root: ROOT, account: o.account || null });
  // Sealed: its hash binds the status to its runs, their setup records and the derived result (A.evidenceErrors).
  m.validation = { ...A.sealValidation({ kind: m.validation.kind, window: m.validation.window, status: v.status, runs: v.runs, evidence: v.evidence, result: v.result }), at: new Date().toISOString() };
  writeManifest(abs(file), m);
  say(`${m.name}: validation ${v.status} (${v.result.why})`);
  return 0;
}

function main(argv) {
  const o = parse(argv.slice(1));
  if (argv[0] === 'init') return init(o);
  if (argv[0] === 'check' && o._[0]) return check(o._[0]);
  if (argv[0] === 'validated' && o._[0]) return validated(o._[0], o);
  throw new Error(USAGE);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`[adapter] ${err.message}\n`);
  process.exitCode = 1;
}
