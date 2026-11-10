#!/usr/bin/env node
'use strict';

// The leg ledger (docs/TRAINING.md, "The leg ledger"): per trend leg of a training round's champion trend runs, what the
// model read over the leg's window (each refusal's class and stated reason, the scorecard's verdict) and what the leg
// did; aggregates by class with n. Information only and read only: it reads a training home (and, for the timeframe,
// the run homes) and writes only --out (scripts/lib/train/leg-ledger.js).
//
//   node scripts/leg-ledger.js --home <training home> [--iteration <n>] [--runs <runs folder>] [--minutes <tf>]
//        [--before YYYY-MM-DD] [--json] [--out <file>]
//
// --runs: the folder holding the round's run homes (each run's timeframe from its autotrader.json, to join the
// scorecard's rows to the cycles); --minutes: the timeframe when a run's is not found (none: those rows unjoined, said).
// --before: only the aggregates of days strictly before that day (priorOnly).

const fs = require('fs');
const path = require('path');
const LL = require('./lib/train/leg-ledger');

const USAGE = 'usage: leg-ledger.js --home <training home> [--iteration <n>] [--runs <folder>] [--minutes <tf>] [--before YYYY-MM-DD] [--json] [--out <file>]';
const FLAGS = new Set(['home', 'iteration', 'runs', 'minutes', 'before', 'out']);

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i].replace(/^--/, '');
    if (argv[i] === '--json') { out.json = true; continue; }
    if (!argv[i].startsWith('--') || !FLAGS.has(k) || argv[i + 1] === undefined) throw new Error(`${argv[i]}: unknown or missing a value\n${USAGE}`);
    out[k] = argv[i + 1];
    i += 1;
  }
  return out;
}

function main(argv) {
  const o = parse(argv);
  if (!o.home) throw new Error(USAGE);
  const iteration = o.iteration === undefined ? 1 : Number(o.iteration);
  const minutes = o.minutes === undefined ? null : Number(o.minutes);
  if (!Number.isInteger(iteration) || iteration < 1) throw new Error(`--iteration ${o.iteration}: a whole number from 1`);
  if (minutes !== null && !(minutes > 0)) throw new Error(`--minutes ${o.minutes}: a timeframe in minutes`);
  const round = LL.readRound(path.resolve(o.home), { iteration, runs: o.runs ? path.resolve(o.runs) : null, minutes });
  const ledger = LL.buildLedger(round.runs);
  const doc = o.before ? LL.priorOnly(ledger, o.before) : { ...ledger, missingDays: round.missingDays, unfinished: round.unfinished, duplicates: round.duplicates };
  if (o.out) {
    fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    fs.writeFileSync(o.out, `${JSON.stringify(doc, null, 1)}\n`);
  }
  if (o.json) { process.stdout.write(`${JSON.stringify(doc, null, 1)}\n`); return 0; }
  const lines = o.before
    ? LL.ledgerLines({ rows: [], ...doc, byHalf: {} }).filter(l => !/^legs \(outcome\)/.test(l)).concat(`(aggregates of the days before ${o.before} only)`)
    : [...LL.ledgerLines(ledger),
      `listed days with no champion probe doc: ${round.missingDays.map(d => `${d.half} ${d.day}`).join(', ') || 'none'}`,
      `listed legs on a unit the run did not finish (left out, as the screens leave them): ${round.unfinished.map(d => `${d.half} ${d.id}`).join(', ') || 'none'}`,
      `listed legs in more than one probe doc (kept once, from the first by name): ${round.duplicates.map(d => `${d.half} ${d.id} (${d.file})`).join(', ') || 'none'}`];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
