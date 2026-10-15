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
 *       valid against adapters/spec.json, and current (its skills and prompt digests the harness's now)
 *   node scripts/adapter.js validated <manifest> --status passed|failed --runs <runId,runId> --result <json file>
 *       records the validation result
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { expandHome } = require('./lib/paths');
const A = require('./lib/learning/adapter');
const { readDataset } = require('./lib/learning/decision-dataset');

const ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: adapter.js init --name N --base-model M --folder F --dataset <dir> --step 1|2 --settings <file> [--seed N] [--parent <manifest>] --out <file> | check <manifest> | validated <manifest> --status passed|failed --runs <a,b> --result <file>';
const FLAGS = ['name', 'base-model', 'folder', 'dataset', 'step', 'settings', 'seed', 'parent', 'out', 'status', 'runs', 'result'];
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
  if (JSON.stringify({ skills: dataset.harness.skills, prompt: dataset.harness.harness }) !== JSON.stringify(digests)) say('note: the dataset was built from runs on other skills or prompts than the harness now');
  const training = { step, method: 'lora', seed: o.seed === undefined ? 1 : Number(o.seed), settings: A.readJsonFile(abs(o.settings)) };
  if (step === 2) {
    if (!o.parent) throw new Error('--parent: step 2 starts from a step-1 adapter (its manifest)');
    training.stage1Mix = spec().steps[1].mixStage1;
    training.parent = A.adapterTag({ adapter: abs(o.parent) });
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
  const stale = ['skills', 'prompt'].filter(k => m.harness[k] !== now[k]);
  say(`${m.name}: step ${m.training.step} on ${m.base.model}, dataset ${m.dataset.fingerprint.slice(0, 12)}, validation ${m.validation.status}; ${stale.length ? `STALE (${stale.join(' and ')} changed since it was trained)` : 'current'}; tag ${A.adapterTag({ adapter: abs(file) })}`);
  return stale.length || m.validation.status === 'failed' ? 1 : 0;
}

function validated(file, o) {
  if (!['passed', 'failed'].includes(o.status) || !o.runs || !o.result) throw new Error(USAGE);
  const m = A.readJsonFile(abs(file));
  m.validation = { ...m.validation, status: o.status, runs: o.runs.split(',').map(s => s.trim()).filter(Boolean), result: A.readJsonFile(abs(o.result)), at: new Date().toISOString() };
  writeManifest(abs(file), m);
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
