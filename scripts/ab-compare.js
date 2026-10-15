#!/usr/bin/env node
/**
 * The A/B comparison of two finished replay runs (scripts/lib/train/ab-compare.js): a skill or rulebook change is kept
 * only when two replays of the same moments, with the same seed, show it measurably better.
 *
 *   node scripts/ab-compare.js <runA home> <runB home> [--metric name[,name]] [--field <config field>] [--account <name>] [--out file]
 *
 * Refused (what differs is printed) unless both runs share their stage, curated list (or window), seed, market, data,
 * experience index and code, and differ in their documents or in one config field, declared with --field. A run on a
 * held-back window is read only through its recorded look; a reasoning-fix look hides the outcomes. Prints a table of
 * the paired differences (B minus A) and one line: B better, no significant difference, or B worse. --out writes the
 * report too (JSON for a .json file). --metric picks the measures (r-decision, r-trade, reads, process, entries,
 * skills, mc). A report, not a gate: the exit code is always 0.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { compareRuns, reportText, METRICS } = require('./lib/train/ab-compare');

const ROOT = path.resolve(__dirname, '..');
const USAGE = `usage: ab-compare.js <runA home> <runB home> [--metric ${METRICS.join(',')}] [--field <config field>] [--account <name>] [--out file]`;
const VALUE_FLAGS = ['--metric', '--field', '--account', '--out'];

function parse(argv) {
  const opts = { metrics: [], field: null, account: null, out: null, runs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (VALUE_FLAGS.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a}: give its value (${USAGE})`);
      if (a === '--metric') opts.metrics.push(...v.split(',').map(s => s.trim()).filter(Boolean));
      else opts[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--')) throw new Error(`${a}: not an option (${USAGE})`);
    else opts.runs.push(a);
  }
  if (opts.runs.length !== 2) throw new Error(USAGE);
  return opts;
}

function main(argv) {
  const o = parse(argv);
  const r = compareRuns(o.runs[0], o.runs[1], { metrics: o.metrics.length ? o.metrics : METRICS, field: o.field, account: o.account, env: process.env, root: ROOT });
  const text = reportText(r);
  process.stdout.write(text);
  if (o.out) {
    fs.writeFileSync(path.resolve(o.out), o.out.endsWith('.json') ? `${JSON.stringify(r, null, 2)}\n` : text);
    process.stdout.write(`[ab-compare] wrote ${o.out}\n`);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`[ab-compare] ${err.message}\n`);
}
process.exitCode = 0;
