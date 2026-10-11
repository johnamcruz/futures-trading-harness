#!/usr/bin/env node
/**
 * The label dataset: labelled replay runs (node scripts/replay.js labels) as
 * rows the student policy trains on (the reasoning-trader design's stage 2):
 * the observation live trading builds at each decision time and the teacher's
 * decision as the student's action, with outcomes as targets only.
 *
 *   node scripts/rl-dataset.js build <run dir | labels dir> ... --out <file.jsonl>
 *       [--run <run dir> ...]        the run of a labels dir written elsewhere (labels.js --out), matched by run id
 *       [--strategy prop_portfolio]  the policy strategy (its strategies, account, sizing, params)
 *       [--mode student|env]         the design's action space (default) or today's env's
 *       [--include-refused]          keep the teacher's refused intents
 *       [--bars SYM=file ...]        the data the run replayed (one-minute or the run's bars)
 *
 * Writes <file.jsonl> (a header line, then one row per line) and
 * <file>.summary.json, never inside the repository. Logic:
 * scripts/lib/rl/label-dataset.js. The Python loader: rl/fth_rl/dataset.py.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { buildDataset, writeDataset, summaryText, MODES } = require('./lib/rl/label-dataset');
const { loadStrategies } = require('./lib/trading/strategies');
const { accountNamed } = require('./lib/trading/accounts');
const { readJson } = require('./lib/harness-run');

const ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: rl-dataset.js build <run dir | labels dir> ... --out <file.jsonl> [--run <run dir> ...] [--strategy name] [--mode student|env] [--include-refused] [--bars SYM=file ...]';
const VALUED = new Set(['--out', '--run', '--strategy', '--mode', '--bars']);

function parse(argv) {
  const o = { dirs: [], runs: [], bars: {}, strategy: 'prop_portfolio', mode: 'student', includeRefused: false, out: null };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (VALUED.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a}: a value\n${USAGE}`);
      i += 1;
      if (a === '--out') o.out = v;
      else if (a === '--run') o.runs.push(v);
      else if (a === '--strategy') o.strategy = v;
      else if (a === '--mode') o.mode = v;
      else {
        const m = /^([A-Z0-9]+)=(.+)$/.exec(v);
        if (!m) throw new Error('--bars: SYMBOL=file (e.g. MNQ=~/data/MNQ-1m.parquet)');
        o.bars[m[1]] = m[2];
      }
    } else if (a === '--include-refused') o.includeRefused = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}\n${USAGE}`);
    else o.dirs.push(a);
  }
  if (!o.dirs.length || !o.out) throw new Error(USAGE);
  if (!MODES.includes(o.mode)) throw new Error(`--mode: one of ${MODES.join(', ')}`);
  return o;
}

const runIdOf = dir => (readJson(path.join(dir, 'manifest.json'), null) || {}).runId || null;

/** Each dir's run dir and labels file: a run dir holds its labels; a labels dir names its run in labels-summary.json. */
function inputsOf(o) {
  const runs = new Map(o.runs.map(d => [runIdOf(path.resolve(d)), path.resolve(d)]));
  return o.dirs.map(d => {
    const dir = path.resolve(d);
    const labelsFile = path.join(dir, 'labels.jsonl');
    if (!fs.existsSync(labelsFile)) throw new Error(`${dir}: no labels.jsonl (node scripts/replay.js labels <run dir>)`);
    if (fs.existsSync(path.join(dir, 'manifest.json'))) return { runDir: dir, labelsFile };
    const runId = (readJson(path.join(dir, 'labels-summary.json'), null) || {}).runId;
    if (!runId || !runs.has(runId)) throw new Error(`${dir}: labels of run ${runId || '(unknown)'}; give its run dir with --run <run dir>`);
    return { runDir: runs.get(runId), labelsFile };
  });
}

function main(argv) {
  if (argv[0] !== 'build') throw new Error(USAGE);
  const o = parse(argv);
  const { strategies } = loadStrategies(ROOT, process.env);
  const strategy = strategies.find(s => s.name === o.strategy);
  if (!strategy || !strategy.valid) throw new Error(`--strategy ${o.strategy}: no valid strategy by that name`);
  const account = accountNamed(ROOT, strategy.account, process.env);
  const built = buildDataset(inputsOf(o), { strategy, account, mode: o.mode, includeRefused: o.includeRefused, barsFiles: o.bars });
  const { file, summaryFile } = writeDataset(o.out, built, { root: ROOT });
  process.stdout.write(summaryText(built.summary));
  process.stdout.write(`[rl-dataset] wrote ${file} and ${summaryFile}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`[rl-dataset] ${err.message}\n`);
  process.exitCode = 1;
}
