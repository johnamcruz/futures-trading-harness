#!/usr/bin/env node
/**
 * Account states for stage-2 practice (scripts/lib/prop/account-states.js): the states a curated practice day starts
 * from, drawn from the 30-day Monte Carlo paths of the model's own trades (practice-train runs), near-limit states
 * oversampled, each draw's sampling weight recorded, hashed. A replay config names the document (accountStates); the
 * run seeds its attempt and the replay broker's balance from each day's draw and reweights its scores. The user's to
 * run, between sessions.
 *
 *   node scripts/account-states.js draw --run <run dir> [--run <run dir> ...] --account <profile> [--lists <curated lists>]
 *       [--bars SYMBOL=file] [--seed 1] [--paths 500] [--count 200] [--oversample near-mll=3,after-losses=3] [--out dir]
 *       -> <out>/account-states-<hash>.json (default <FTH_HOME>/experience)
 *   node scripts/account-states.js show <file>
 */

'use strict';

const path = require('path');
const { harnessHome } = require('./lib/paths');
const S = require('./lib/prop/account-states');
const { accountNamed } = require('./lib/trading/accounts');
const { loadStrategies } = require('./lib/trading/strategies');
const { policyFor } = require('./lib/prop/model-score');

const ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: account-states.js draw --run <run dir> ... --account <profile> [--lists <curated lists>] [--bars SYMBOL=file] [--seed N] [--paths N] [--count N] [--oversample bucket=x,...] [--out dir] | show <file>';

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name}: give its value (${USAGE})`);
  return v;
}

const all = (argv, name) => argv.map((a, i) => (a === name ? argv[i + 1] : null)).filter(v => v !== null);

function whole(argv, name, dflt) {
  const v = opt(argv, name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name}: a whole number, 1 or more`);
  return n;
}

function oversampleOf(text) {
  if (text === undefined) return null;
  const out = {};
  for (const part of String(text).split(',')) {
    const m = /^\s*([a-z-]+)\s*=\s*([0-9.]+)\s*$/.exec(part);
    if (!m) throw new Error(`--oversample: bucket=factor,... (${S.PRACTICE_BUCKETS.join(', ')})`);
    out[m[1]] = Number(m[2]);
  }
  return out;
}

function barsOf(argv) {
  const out = {};
  for (const v of all(argv, '--bars')) {
    const m = /^([A-Z0-9]+)=(.+)$/.exec(String(v));
    if (!m) throw new Error('--bars: SYMBOL=file');
    out[m[1]] = m[2];
  }
  return out;
}

function draw(argv) {
  const runs = all(argv, '--run');
  const name = opt(argv, '--account');
  if (!runs.length || !name) throw new Error(USAGE);
  const account = accountNamed(ROOT, name, process.env);
  const policy = policyFor(loadStrategies(ROOT, process.env).strategies, account.name);
  const seed = whole(argv, '--seed', S.DEFAULTS.seed);
  const { stream, source } = S.sourceStream(runs, { root: ROOT, barsFiles: barsOf(argv), lists: opt(argv, '--lists') || null, seed });
  const doc = S.drawDocument(stream, {
    account, sizing: policy ? policy.sizing || {} : {}, contracts: (policy && policy.contracts) || 'auto', seed,
    paths: whole(argv, '--paths', S.DEFAULTS.paths), count: whole(argv, '--count', S.DEFAULTS.count), oversample: oversampleOf(opt(argv, '--oversample')), source,
  });
  const file = S.writeDocument(opt(argv, '--out') || path.join(harnessHome(process.env), 'experience'), doc);
  process.stdout.write(S.documentText(doc));
  process.stdout.write(`wrote ${file}${policy ? '' : ` (no policy strategy trades ${account.name}: the default sizing)`}\n`);
  return 0;
}

function main(argv) {
  if (argv[0] === 'draw') return draw(argv);
  if (argv[0] === 'show' && argv[1]) { process.stdout.write(S.documentText(S.readDocument(argv[1]))); return 0; }
  throw new Error(USAGE);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`[account-states] ${err.message}\n`);
  process.exitCode = 1;
}
