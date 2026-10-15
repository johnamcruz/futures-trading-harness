#!/usr/bin/env node
/**
 * The model's risk record (experience_lookup's "your risk record", shown only with the replay config's
 * riskRecordDisplay), built between sessions from finished practice-train replay runs; the runner never builds one.
 *
 *   node scripts/risk-record.js build <run home | run dir> ... --account <name> [--out dir] [--seed N] [--paths N] [--reps N] [--min-n N]
 *       per day a run's model took a risk action, what reverting that day's actions did over the Monte Carlo paths
 *       of the run's days through it (scoreRiskActions), by account state -> <out>/risk-record-<hash>.json (default
 *       <FTH_HOME>/experience); refuses an unfinished run, a run that isn't practice-train, and a day two runs hold
 *   node scripts/risk-record.js show <record file>   its fingerprint, sources and the lines the model would read
 *
 * The logic lives in scripts/lib/learning/risk-record-build.js and risk-record-index.js.
 */

'use strict';

const path = require('path');
const { harnessHome } = require('./lib/paths');
const { buildFromRuns, PATHS, REPS } = require('./lib/learning/risk-record-build');
const { writeRiskIndex, readRiskIndex, riskRecordLines } = require('./lib/learning/risk-record-index');

const ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: risk-record.js build <run home | run dir> ... --account <name> [--out dir] [--seed N] [--paths N] [--reps N] [--min-n N] | show <record file>';
const VALUE_FLAGS = ['--account', '--out', '--seed', '--paths', '--reps', '--min-n'];

function parse(argv) {
  const opts = { runs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (VALUE_FLAGS.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a}: give its value (${USAGE})`);
      opts[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--')) throw new Error(`unknown flag ${a} (${USAGE})`);
    else opts.runs.push(a);
  }
  return opts;
}

function whole(opts, key, dflt, min) {
  if (opts[key] === undefined) return dflt;
  const n = Number(opts[key]);
  if (!(Number.isInteger(n) && n >= min)) throw new Error(`--${key}: a whole number from ${min}`);
  return n;
}

function build(argv, env) {
  const opts = parse(argv);
  if (!opts.runs.length) throw new Error(USAGE);
  if (!opts.account) throw new Error('--account: the account profile the record is scored against (no default account)');
  const account = require('./lib/trading/accounts').accountNamed(ROOT, opts.account, env);
  const { strategies } = require('./lib/trading/strategies').loadStrategies(ROOT, env);
  const policy = require('./lib/prop/model-score').policyFor(strategies, account.name);
  const doc = buildFromRuns(opts.runs.map(r => path.resolve(r)), {
    root: ROOT, env, account, policy, seed: whole(opts, 'seed', 1, 0), paths: whole(opts, 'paths', PATHS, 1), reps: whole(opts, 'reps', REPS, 1),
    ...(opts['min-n'] === undefined ? {} : { minN: whole(opts, 'min-n', 1, 1) }),
  });
  const out = writeRiskIndex(opts.out ? path.resolve(opts.out) : path.join(harnessHome(env), 'experience'), doc);
  const acted = doc.sources.runs.reduce((a, r) => a + r.acted, 0);
  process.stdout.write(`[risk-record] ${doc.days} day(s) with a risk action from ${doc.sources.runs.length} run(s) (${acted} acted day(s)), ${account.name}, ${doc.sources.paths} paths, seed ${doc.sources.seed}, minN ${doc.minN}; fingerprint ${doc.hash}\n[risk-record] wrote ${out}\n`);
  return 0;
}

function show(argv) {
  const [file] = argv;
  if (!file) throw new Error(USAGE);
  const doc = readRiskIndex(path.resolve(file));
  const last = doc.entries.length ? doc.entries[doc.entries.length - 1].day : null;
  // The lines a bar after every day of the record would read.
  const after = last ? new Date(Date.parse(`${last}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : '9999-12-31';
  const src = doc.sources ? `${doc.sources.runs.map(r => r.runId).join(', ')}; ${doc.sources.account}, ${doc.sources.paths} paths, seed ${doc.sources.seed}` : 'no sources recorded';
  process.stdout.write(`risk record ${doc.hash}: ${doc.days} day(s), ${doc.entries.length ? `${doc.entries[0].day} to ${last}` : 'none'}, minN ${doc.minN}; from ${src}\n${riskRecordLines(doc, after).join('\n')}\n`);
  return 0;
}

function main(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  if (cmd === 'build') return build(rest, env);
  if (cmd === 'show') return show(rest);
  throw new Error(USAGE);
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[risk-record] ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parse };
