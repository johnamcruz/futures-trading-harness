#!/usr/bin/env node
/**
 * The two-layer evaluator (docs/LEARNED-RULEBOOK.md R6-R9): a policy strategy's combine attempts on bar files
 * over one window of the schedule, with pass, blow and timeout rates, their intervals, the effective sample
 * size, resampled paths and expectancy cuts. Prints the result as JSON (or writes it with --out). Logic:
 * scripts/lib/prop/evaluate-run.js.
 *
 *   node scripts/evaluate.js --prop prop_portfolio --data MNQ=data/MNQ-3m.jsonl --from 2021-06-01 --to 2021-09-01
 *       [--seed 1] [--paths 2000] [--mean-block 7] [--reps 2000] [--every 1] [--entry-delay-ms 0]
 *       [--stop-fault-rate 0] [--outage-rate 0] [--no-facts] [--no-gate] [--out result.json]
 *       [--look-candidate <name> --look-purpose tuning|judging --ledger <ledger.jsonl> [--new-ledger]]   outside train
 *   node scripts/evaluate.js --config evaluate.json
 *
 * Train windows run freely. Any other window needs a look the ledger allows; it is appended to the ledger
 * before a bar is read. The windows are session dates, `to` exclusive, inside one unit of the schedule.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { runEvaluation } = require('./lib/prop/evaluate-run');

const ROOT = path.resolve(__dirname, '..');
const FLAGS = new Set(['--config', '--prop', '--data', '--from', '--to', '--seed', '--paths', '--mean-block', '--reps', '--every', '--entry-delay-ms',
  '--stop-fault-rate', '--outage-rate', '--out', '--look-candidate', '--look-purpose', '--ledger', '--new-ledger', '--no-facts', '--no-gate', '--help']);
const BOOLEAN = new Set(['--new-ledger', '--no-facts', '--no-gate', '--help']);

function parse(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!FLAGS.has(a)) throw new Error(`unknown argument: ${a} (see the usage at the top of scripts/evaluate.js)`);
    if (out.has(a) && a !== '--data') throw new Error(`${a} is given twice`);
    if (BOOLEAN.has(a)) { out.set(a, true); continue; }
    if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) throw new Error(`${a} needs a value`);
    if (!out.has(a)) out.set(a, []);
    out.get(a).push(argv[(i += 1)]);
  }
  return out;
}

function configFrom(args) {
  const one = name => (args.has(name) ? args.get(name)[args.get(name).length - 1] : undefined);
  const num = name => {
    const v = one(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name}: a number, not ${v}`);
    return n;
  };
  const cfg = one('--config') ? JSON.parse(fs.readFileSync(one('--config'), 'utf8')) : {};
  if (one('--prop')) cfg.prop = one('--prop');
  for (const d of args.get('--data') || []) {
    const m = /^([A-Z0-9]+)=(.+)$/.exec(d);
    if (!m) throw new Error(`--data: SYMBOL=file, not ${d}`);
    cfg.data = { ...(cfg.data || {}), [m[1]]: path.resolve(m[2]) };
  }
  if (args.get('--data')) cfg.symbols = args.get('--data').map(d => d.split('=')[0]);
  for (const k of ['from', 'to']) if (one(`--${k}`)) cfg[k] = one(`--${k}`);
  for (const [flag, key] of [['--seed', 'seed'], ['--paths', 'paths'], ['--mean-block', 'meanBlock'], ['--reps', 'reps'], ['--every', 'every'], ['--entry-delay-ms', 'entryDelayMs']]) {
    if (num(flag) !== undefined) cfg[key] = num(flag);
  }
  if (num('--stop-fault-rate') !== undefined || num('--outage-rate') !== undefined) {
    cfg.faults = { ...(cfg.faults || {}), ...(num('--stop-fault-rate') !== undefined ? { stopFault: num('--stop-fault-rate') } : {}), ...(num('--outage-rate') !== undefined ? { outage: num('--outage-rate') } : {}) };
  }
  if (args.has('--no-facts')) cfg.facts = false;
  if (args.has('--no-gate')) cfg.gate = false;
  if (one('--look-candidate') || one('--look-purpose')) cfg.look = { candidate: one('--look-candidate'), purpose: one('--look-purpose') };
  if (one('--ledger')) cfg.ledger = path.resolve(one('--ledger'));
  if (args.has('--new-ledger')) cfg.newLedger = true;
  return cfg;
}

function main(argv) {
  const args = parse(argv);
  if (args.has('--help')) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 16).map(l => l.replace(/^ \* ?/, '')).join('\n') + '\n');
    return 0;
  }
  const cfg = configFrom(args);
  const log = msg => process.stderr.write(`[evaluate] ${msg}\n`);
  const baseDir = args.has('--config') ? path.dirname(path.resolve(args.get('--config')[0])) : process.cwd();
  const result = runEvaluation(cfg, { root: ROOT, baseDir, env: process.env, log });
  const text = `${JSON.stringify(result, null, 2)}\n`;
  const out = args.has('--out') ? path.resolve(args.get('--out')[0]) : null;
  if (out) {
    fs.writeFileSync(out, text);
    log(`wrote ${out}`);
  } else process.stdout.write(text);
  const iv = result.intervals.pass;
  log(`pass ${result.passRate} [${iv.lo}, ${iv.hi}] over ${result.attempts} attempts (ESS ${result.ess}); blows ${result.blown}; timeout ${result.timeoutRate}; gate: ${result.promotion.passes ? 'passes' : result.promotion.failures.join('; ')}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[evaluate] ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parse, configFrom, main };
