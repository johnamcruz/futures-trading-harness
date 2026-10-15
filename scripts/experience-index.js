#!/usr/bin/env node
/**
 * The experience index (the learning loop, the composed-entry design, section 4.3), built between sessions from
 * practice runs' experience logs; the runner never builds one. The user's to run, like replays.
 *
 *   node scripts/experience-index.js build <run home | decisions.jsonl> ... [--out dir] [--seed N] [--shuffle N]
 *       every practice-train decision of the runs (any other month refuses the build) -> <out>/index-<hash>.json
 *       (default <FTH_HOME>/experience)
 *   node scripts/experience-index.js pin <index file> <run home>   the run's own frozen copy and its hash
 *   node scripts/experience-index.js show <index file> [--top N]   the cells with enough samples (every day), best mean R first;
 *       the shuffled arm's index (--shuffle: its rows permuted across cells) is built from the same runs
 *
 * The logic lives in scripts/lib/learning/experience-index.js.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { harnessHome } = require('./lib/paths');
const { readDecisions, logFile } = require('./lib/learning/experience-log');
const { buildIndex, writeIndex, readIndex, pinIndex, cellAt } = require('./lib/learning/experience-index');

const USAGE = 'usage: experience-index.js build <run home | decisions.jsonl> ... [--out dir] [--seed N] [--shuffle N] | pin <index file> <run home> | show <index file> [--top N]';

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name}: give its value (${USAGE})`);
  return v;
}

/** The positional arguments (flags and their values left out). */
const positional = (argv, flags) => argv.filter((a, i) => !a.startsWith('--') && !flags.includes(argv[i - 1]));

function build(argv) {
  const sources = positional(argv.slice(1), ['--out', '--seed', '--shuffle']);
  if (!sources.length) throw new Error(USAGE);
  const seed = opt(argv, '--seed') !== undefined ? Number(opt(argv, '--seed')) : 1;
  if (!Number.isInteger(seed)) throw new Error('--seed: a whole number');
  const runs = [];
  const decisions = [];
  for (const s of sources) {
    const file = fs.existsSync(s) && fs.statSync(s).isDirectory() ? logFile(path.resolve(s)) : path.resolve(s);
    if (!fs.existsSync(file)) throw new Error(`no experience log at ${file}`);
    const lines = readDecisions(file);
    runs.push({ runId: lines.length ? lines[0].runId : null, file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    decisions.push(...lines);
  }
  const shuffle = opt(argv, '--shuffle') !== undefined ? Number(opt(argv, '--shuffle')) : null;
  if (shuffle !== null && !Number.isInteger(shuffle)) throw new Error('--shuffle: a whole-number seed');
  const doc = buildIndex(decisions, { runs, seed, shuffle });
  const out = writeIndex(opt(argv, '--out') ? path.resolve(opt(argv, '--out')) : path.join(harnessHome(), 'experience'), doc);
  const enough = Object.keys(doc.cells).filter(k => cellAt(doc, k).enough).length;
  process.stdout.write(`[experience-index] ${doc.decisions} decision(s) from ${runs.length} run(s), ${Object.keys(doc.cells).length} cells (${enough} with enough samples), ${doc.months.from || '-'} to ${doc.months.to || '-'}; hash ${doc.hash.slice(0, 16)}\n[experience-index] wrote ${out}\n`);
  return 0;
}

function pin(argv) {
  const [file, home] = positional(argv.slice(1), []);
  if (!file || !home) throw new Error(USAGE);
  const r = pinIndex(path.resolve(home), path.resolve(file));
  process.stdout.write(`[experience-index] pinned ${r.hash.slice(0, 16)} for ${path.resolve(home)}: ${r.file}\n`);
  return 0;
}

const fix = x => (x === null || x === undefined ? '-' : Number(x).toFixed(2));

function show(argv) {
  const [file] = positional(argv.slice(1), ['--top']);
  if (!file) throw new Error(USAGE);
  const top = opt(argv, '--top') !== undefined ? Number(opt(argv, '--top')) : 20;
  if (!(Number.isInteger(top) && top > 0)) throw new Error('--top: a positive whole number');
  const doc = readIndex(path.resolve(file));
  const rows = Object.keys(doc.cells).map(k => [k, cellAt(doc, k)]).filter(([, c]) => c.enough).sort((a, b) => b[1].meanR.mean - a[1].meanR.mean).slice(0, top);
  process.stdout.write(`index ${doc.hash.slice(0, 16)}: ${doc.decisions} decisions, ${doc.months.from || '-'} to ${doc.months.to || '-'}, min ${doc.minN} decisions over ${doc.minDays} days\n`);
  for (const [k, c] of rows) process.stdout.write(`${fix(c.meanR.mean)}R [${fix(c.meanR.lo)}, ${fix(c.meanR.hi)}] win ${fix(c.winRate.rate)} n ${c.n} (${c.days} days)${c.shifted ? ' shifted' : ''}  ${k}\n`);
  if (!rows.length) process.stdout.write('no cell has enough samples yet\n');
  return 0;
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === 'build') return build(argv);
  if (cmd === 'pin') return pin(argv);
  if (cmd === 'show') return show(argv);
  throw new Error(USAGE);
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[experience-index] ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
