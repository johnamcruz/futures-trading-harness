#!/usr/bin/env node
/**
 * The structure-read dataset for a LoRA adapter (adapters/README.md, "Structure reads"; docs/TRAINING.md). Nothing here
 * calls or names a model; the files it writes are local, never the repository's.
 *
 *   node scripts/structure-read-dataset.js prompts --run <run dir> ... --out <prompts.jsonl>
 *       each recorded bar's prompts (its briefing and each fixed instruction) with their ids: answer them with any
 *       model, outside the harness, as { id, text } lines
 *   node scripts/structure-read-dataset.js build --train <run dir> ... [--validate <run dir> ...] [--answers <file> ...]
 *       --out <new dir> [--spec file] [--include-digest any|<hex prefix> ...] [--no-gold]
 *       one example per bar and instruction: an answer that verified on every field against the code's facts, else the
 *       code-built answer (none with --no-gold); train from practice-train only, validate from practice-validate only;
 *       test and final refused; only bars made under the harness's code digest now unless --include-digest names
 *       others; balanced by case and regime (the spec's structureRead); train.jsonl, valid.jsonl, meta.jsonl and
 *       dataset.json (its fingerprint)
 *   node scripts/structure-read-dataset.js show <dataset dir>
 *       its fingerprint (checked against its files), counts, coverage and balance
 *
 * The logic lives in scripts/lib/learning/ (structure-read.js, structure-dataset.js).
 */

'use strict';

require('./lib/env-file').loadEnvForCli('structure-read-dataset');

const fs = require('fs');
const path = require('path');
const { expandHome } = require('./lib/paths');
const SD = require('./lib/learning/structure-dataset');
const { validateSpec, SPEC_FILE } = require('./lib/learning/adapter');

const ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: structure-read-dataset.js prompts --run <run dir> ... --out <file> | build --train <run dir> ... [--validate <run dir> ...] [--answers <file> ...] --out <dir> [--spec file] [--include-digest any|<hex prefix> ...] [--no-gold] | show <dataset dir>';
const say = msg => process.stdout.write(`[structure-read-dataset] ${msg}\n`);
const abs = p => path.resolve(expandHome(p));

/** Flags: each value flag once, the repeatable ones a list, the switches true. */
function parse(argv, { single = [], repeat = [], flags = [] }) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const name = a.replace(/^--/, '');
    if (!a.startsWith('--')) { out._.push(a); continue; }
    if (flags.includes(name)) { out[name] = true; continue; }
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

function prompts(argv) {
  const o = parse(argv, { single: ['out'], repeat: ['run'] });
  if (!o.run || !o.out || o._.length) throw new Error(USAGE);
  const out = abs(o.out);
  if (fs.existsSync(out)) throw new Error(`${out} exists: write the prompts to a new file`);
  const lines = SD.promptLines(o.run.map(r => SD.sourceFromRun(abs(r))));
  fs.writeFileSync(out, lines.map(l => `${JSON.stringify(l)}\n`).join(''));
  say(`${lines.length} prompt(s) from ${o.run.length} run(s): ${out} (answer each as { "id": ..., "text": ... })`);
  return 0;
}

function build(argv) {
  const o = parse(argv, { single: ['out', 'spec'], repeat: ['train', 'validate', 'answers', 'include-digest'], flags: ['no-gold'] });
  if (!o.train || !o.out || o._.length) throw new Error(USAGE);
  const spec = JSON.parse(fs.readFileSync(o.spec ? abs(o.spec) : path.join(ROOT, SPEC_FILE), 'utf8'));
  const errs = validateSpec(spec);
  if (errs.length) throw new Error(`the training spec is invalid: ${errs.join('; ')}`);
  const answers = SD.readAnswers((o.answers || []).map(f => fs.readFileSync(abs(f), 'utf8')));
  const current = require('./lib/learning/adapter').currentDigests(ROOT);
  const built = SD.buildStructureDataset({
    train: o.train.map(r => SD.sourceFromRun(abs(r))), validate: (o.validate || []).map(r => SD.sourceFromRun(abs(r))),
    spec, current, include: o['include-digest'] || [], answers, gold: !o['no-gold'],
  });
  const file = SD.writeDataset(abs(o.out), built);
  return show([null, path.dirname(file)]);
}

function show(argv) {
  if (!argv[1]) throw new Error(USAGE);
  const d = SD.readDataset(abs(argv[1]));
  say(`dataset ${d.fingerprint} (${d.type}; instructions ${Object.entries(d.instructions).map(([k, h]) => `${k} ${h}`).join(', ')}; code ${d.harness.code}; gold ${d.gold ? 'on' : 'off'})`);
  for (const set of ['train', 'validate']) {
    const c = d.counts[set];
    const cov = d.coverage[set];
    say(`${set}: ${cov.n} example(s) from ${c.bars} bar(s); sources ${JSON.stringify(cov.source)}; cases ${JSON.stringify(cov.case)}; regimes ${JSON.stringify(cov.regime)}`);
    say(`  answers: ${c.answers.seen} seen, ${c.answers.verified} verified on every field, ${c.answers.rejected} rejected, ${c.answers.extraVerified} more verified for a prompt already kept; wrong fields ${JSON.stringify(c.wrongFields)}${Object.keys(c.rejectedWhy).length ? `; ${JSON.stringify(c.rejectedWhy)}` : ''}`);
    say(`  dropped: ${c.stale} bar(s) under another code digest, ${c.duplicates} duplicate prompt(s), unreadable facts ${JSON.stringify(c.unreadable)}`);
  }
  say(`balance (train bars): ${d.balance.before.n} -> ${d.balance.after.n}; cases ${JSON.stringify(d.balance.after.case)}; regimes ${JSON.stringify(d.balance.after.regime)}; answers for no prompt: ${d.counts.unmatchedAnswers}`);
  say(`sources: ${d.sources.map(s => `${s.set} ${s.runId} (${s.bars} bars)`).join(', ')}`);
  return 0;
}

function main(argv) {
  if (argv[0] === 'prompts') return prompts(argv.slice(1));
  if (argv[0] === 'build') return build(argv.slice(1));
  if (argv[0] === 'show') return show(argv);
  throw new Error(USAGE);
}

try {
  const [, , ...args] = process.argv;
  process.exitCode = main(args);
} catch (err) {
  process.stderr.write(`[structure-read-dataset] ${err.message}\n`);
  process.exitCode = 1;
}
