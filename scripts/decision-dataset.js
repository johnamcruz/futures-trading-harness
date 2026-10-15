#!/usr/bin/env node
/**
 * The verified-decision dataset for a LoRA adapter (docs/TRAINING.md, "Fine-tuning on verified decisions";
 * adapters/README.md). Nothing here trains or names a model; the files it writes are local, never the repository's.
 *
 *   node scripts/decision-dataset.js sample --config <replay.json> --k K --sampling <local sampling file> [--seed N] [--bars SYM=file ...]
 *       a curated practice-train replay (run, or resumed, with checkpoints), then each curated moment re-run K times
 *       with sampling on, seeded per moment and repeat -> <workDir>/<runId>.samples/samples.jsonl
 *   node scripts/decision-dataset.js build --train <run dir | samples.jsonl> ... [--validate <run dir> ...] --out <new dir> [--spec file]
 *       [--include-digest any|<hex prefix> ...]
 *       the correct decisions (labelled by process) as chat JSONL: step1/, step2/, meta.jsonl and dataset.json (its
 *       fingerprint and source runs); train from practice-train only, validate from practice-validate only; test and
 *       final refused; only decisions made under the harness's skills and prompt digest now (the one an adapter's
 *       manifest records), the others dropped and counted, unless --include-digest names them (any, or a digest prefix):
 *       kept and marked in meta.jsonl
 *   node scripts/decision-dataset.js show <dataset dir>
 *       its fingerprint (checked against its files), counts, labels and balance
 *
 * The logic lives in scripts/lib/learning/ (decision-label.js, decision-examples.js, decision-dataset.js,
 * decision-sampler.js, adapter.js).
 */

'use strict';

require('./lib/env-file').loadEnvForCli('decision-dataset');

const fs = require('fs');
const path = require('path');
const { expandHome } = require('./lib/paths');
const DS = require('./lib/learning/decision-dataset');
const SM = require('./lib/learning/decision-sampler');
const { validateSpec, SPEC_FILE } = require('./lib/learning/adapter');

const ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: decision-dataset.js sample --config <replay.json> --k K --sampling <file> [--seed N] [--bars SYM=file ...] | build --train <run dir | samples.jsonl> ... [--validate <run dir> ...] --out <dir> [--spec file] [--include-digest any|<hex prefix> ...] | show <dataset dir>';
const say = msg => process.stdout.write(`[decision-dataset] ${msg}\n`);

/** Flags: each value flag once, except the repeatable ones (a list). */
function parse(argv, { single = [], repeat = [] }) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const name = a.slice(2);
    if (!a.startsWith('--')) { out._.push(a); continue; }
    if (![...single, ...repeat].includes(name)) throw new Error(`unknown flag ${a} (${USAGE})`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a}: give its value (${USAGE})`);
    if (repeat.includes(name)) out[name] = [...(out[name] || []), v];
    else if (out[name] !== undefined) throw new Error(`${a}: once`);
    else out[name] = v;
    i += 1;
  }
  return out;
}

function barsOf(list = []) {
  return Object.fromEntries(list.map(x => {
    const m = /^([A-Z0-9]+)=(.+)$/.exec(x);
    if (!m) throw new Error('--bars: SYMBOL=file');
    return [m[1], m[2]];
  }));
}

const readJson = file => JSON.parse(fs.readFileSync(path.resolve(expandHome(file)), 'utf8'));

async function sample(argv) {
  const o = parse(argv, { single: ['config', 'k', 'sampling', 'seed'], repeat: ['bars'] });
  if (!o.config || !o.k || !o.sampling) throw new Error(USAGE);
  const k = Number(o.k);
  const seed = o.seed === undefined ? 1 : Number(o.seed);
  const sampling = SM.samplingSettings(readJson(o.sampling));
  const { resolveReplay } = require('./lib/replay/config');
  const run = resolveReplay(readJson(o.config), { baseDir: path.dirname(path.resolve(o.config)), env: process.env, root: ROOT });
  SM.checkBaseRun(run);
  const dir = SM.samplerDir(run);
  const checkpoints = path.join(dir, 'checkpoints');
  const manifest = fs.existsSync(run.paths.manifest) ? JSON.parse(fs.readFileSync(run.paths.manifest, 'utf8')) : null;
  if (!manifest || manifest.finished !== true) {
    if (manifest && !fs.existsSync(checkpoints)) throw new Error(`run ${run.runId} was started without checkpoints: start the base run with the sampler (a new runId)`);
    say(`base run ${run.runId}, with checkpoints in ${checkpoints}`);
    const res = await SM.runBase(run, { root: ROOT, env: process.env, barsFiles: barsOf(o.bars), checkpoints, log: say });
    if (!res.done) { say(`${res.stopped || 'not finished'}; run it again to resume`); return 1; }
  }
  const plan = SM.planSamples({ times: SM.sampleTimes(run, checkpoints), k, seed });
  if (!plan.length) throw new Error(`run ${run.runId}: no curated moment with a checkpoint in ${checkpoints}`);
  say(`${plan.length} sample(s): ${plan.length / k} moment(s) x ${k}, sampling ${sampling.digest} (${Object.keys(sampling.settings).join(', ')})`);
  const D = require('./lib/train/decision-points');
  const done = await SM.runSamples({
    run, checkpoints, tree: ROOT, plan, outDir: dir, sampling, baseEnv: process.env,
    deps: { runPoint: D.runPoint, followersOf: D.followersOf, stepDeps: SM.stepDeps },
  });
  const failed = done.filter(r => r.error);
  say(`${done.length - failed.length} sample(s) ran${failed.length ? `, ${failed.length} failed (the first: ${failed[0].error})` : ''}: ${path.join(dir, SM.FILE)}`);
  return failed.length ? 1 : 0;
}

function build(argv) {
  const o = parse(argv, { single: ['out', 'spec'], repeat: ['train', 'validate', 'include-digest'] });
  if (!o.train || !o.out || o._.length) throw new Error(USAGE);
  const spec = readJson(o.spec || path.join(ROOT, SPEC_FILE));
  const errs = validateSpec(spec);
  if (errs.length) throw new Error(`the training spec is invalid: ${errs.join('; ')}`);
  const lifecycle = require('./lib/trading/strategies').loadStrategies(ROOT, process.env).strategies.find(s => s.name === 'trade_lifecycle');
  if (!lifecycle || !lifecycle.risk) throw new Error('trade_lifecycle: its risk rules (min_rr, max_risk_usd) label the decisions');
  const rules = { minRR: lifecycle.risk.min_rr, maxRiskUsd: lifecycle.risk.max_risk_usd };
  const score = DS.scorer({ root: ROOT, env: process.env });
  const source = p => (p.endsWith('.jsonl') ? DS.sourceFromSamples(path.resolve(expandHome(p)), { score }) : DS.sourceFromRun(path.resolve(expandHome(p)), { score }));
  const current = require('./lib/learning/adapter').currentDigests(ROOT);
  const built = DS.buildDataset({ train: o.train.map(source), validate: (o.validate || []).map(source), spec, rules, current, include: o['include-digest'] || [] });
  const file = DS.writeDataset(path.resolve(expandHome(o.out)), built);
  if (spec.dataset.fingerprint && spec.dataset.fingerprint !== built.dataset.fingerprint) say(`note: the spec expects dataset ${spec.dataset.fingerprint.slice(0, 12)}, this is ${built.dataset.fingerprint.slice(0, 12)}`);
  show([null, path.dirname(file)]);
  return 0;
}

function show(argv) {
  const dir = argv[1];
  if (!dir) throw new Error(USAGE);
  const d = DS.readDataset(path.resolve(expandHome(dir)));
  say(`dataset ${d.fingerprint} (spec ${d.spec}, seed ${d.seed}; harness skills ${String(d.harness.skills).slice(0, 12)}, prompt ${String(d.harness.harness).slice(0, 12)})`);
  say(`step 1: ${d.counts.step1.train} train, ${d.counts.step1.valid} valid; step 2: ${d.counts.step2.train} train (${d.counts.step2.stage2} stage 2, ${d.counts.step2.stage1Mix} stage 1 mixed back in), ${d.counts.step2.valid} valid`);
  for (const set of ['train', 'validate']) say(`${set} labels: ${Object.entries(d.labels[set]).map(([k, n]) => `${n} ${k}`).join(', ')}; ${d.duplicates[set]} duplicate example(s) dropped`);
  const g = d.digests || { stale: {}, included: {}, include: [] };
  say(`digest: kept the harness's (skills ${String(d.harness.skills).slice(0, 12)}); dropped for a stale digest: ${g.stale.train || 0} train, ${g.stale.validate || 0} validate example(s)${g.include.length ? `; included under other digests (${g.include.join(', ')}): ${g.included.train || 0} train, ${g.included.validate || 0} validate, marked in meta.jsonl` : ''}`);
  for (const [st, b] of Object.entries(d.balance)) if (b) say(`${st} balance: ${b.before.n} -> ${b.after.n} decisions; kinds ${JSON.stringify(b.after.kind)}; years ${JSON.stringify(b.after.year)}${b.after.accountState ? `; states ${JSON.stringify(b.after.accountState)}` : ''}`);
  say(`sources: ${d.sources.map(s => `${s.set} ${s.runId}${s.samples ? ` (${s.samples} samples)` : ''}`).join(', ')}`);
  return 0;
}

async function main(argv) {
  if (argv[0] === 'sample') return sample(argv.slice(1));
  if (argv[0] === 'build') return build(argv.slice(1));
  if (argv[0] === 'show') return show(argv);
  throw new Error(USAGE);
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[decision-dataset] ${err.message}\n`);
  process.exitCode = 1;
});
