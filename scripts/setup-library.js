#!/usr/bin/env node
/**
 * The history library (scripts/lib/learning/setup-library.js): code scans practice-train history for the setup
 * moments and measures one fixed standard trade at each; its index is shown by experience_lookup in a section of its
 * own, never as the model's record. The user's to run, between sessions, like the experience index.
 *
 *   node scripts/setup-library.js scan --bars <file> --root MNQ --from YYYY-MM-DD --to YYYY-MM-DD --out <file.jsonl>
 *       [--minutes 3] [--tick 0.25] [--setup-tf 15]
 *       every reaction moment of the bars in [from, to) (practice-train only; 1m bars are aggregated) -> one record a line,
 *       each limit measured over the trade_lifecycle strategy's valid_bars
 *   node scripts/setup-library.js index <library.jsonl> ... [--out dir] [--seed N]
 *       the walk-forward index of the records -> <out>/library-<hash>.json (default <FTH_HOME>/experience)
 *   node scripts/setup-library.js pin <index file> <run home>     the run's own frozen copy, hidden from the model (a
 *       replay config's setupLibrary pins it at the run's start; only its libraryDisplay shows it; a replay run home
 *       pinned by hand resumes only with the same file named in its config)
 *   node scripts/setup-library.js show <index file> [--top N]    the cells with enough samples, best mean R first
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { harnessHome } = require('./lib/paths');
const { loadBars } = require('./lib/backtest/data');
const L = require('./lib/learning/setup-library');

const USAGE = 'usage: setup-library.js scan --bars <file> --root <ROOT> --from YYYY-MM-DD --to YYYY-MM-DD --out <file.jsonl> [--minutes 3] [--tick 0.25] [--setup-tf 15] | index <library.jsonl> ... [--out dir] [--seed N] | pin <index file> <run home> | show <index file> [--top N]';
const VALUE_FLAGS = ['--bars', '--root', '--from', '--to', '--out', '--minutes', '--tick', '--setup-tf', '--seed', '--top'];

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name}: give its value (${USAGE})`);
  return v;
}

const positional = argv => argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]));
const numberOpt = (argv, name, dflt) => {
  const v = opt(argv, name);
  const n = v === undefined ? dflt : Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name}: a positive number`);
  return n;
};
const say = msg => process.stdout.write(`[setup-library] ${msg}\n`);

function scan(argv) {
  const [file, root, from, to, out] = ['--bars', '--root', '--from', '--to', '--out'].map(f => opt(argv, f));
  if (!file || !root || !from || !to || !out) throw new Error(USAGE);
  if (!/^[A-Z0-9]{1,8}$/.test(root)) throw new Error('--root: a contract root, e.g. MNQ');
  const minutes = numberOpt(argv, '--minutes', 3);
  const setupTf = numberOpt(argv, '--setup-tf', 15);
  const tick = numberOpt(argv, '--tick', 0.25);
  const bars = L.baseBars(loadBars(path.resolve(file)), minutes);
  const clock = L.runnerClock({ from, to });
  // The limit's window: the shipped trade_lifecycle strategy's valid_bars (the plan the gate allows).
  const validBars = L.strategyValidBars(path.resolve(__dirname, '..'), process.env);
  const records = L.scanLibrary({ bars, root, minutes, tick, from, to, setupTf, eodOf: clock.eodOf, inSession: clock.inSession, validBars });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  const status = {};
  for (const r of records) status[r.status] = (status[r.status] || 0) + 1;
  say(`${records.length} reaction moment(s) of ${root} ${from}..${to}: ${Object.entries(status).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  say(`wrote ${path.resolve(out)}`);
  return 0;
}

function index(argv) {
  const files = positional(argv.slice(1));
  if (!files.length) throw new Error(USAGE);
  const seed = opt(argv, '--seed') !== undefined ? Number(opt(argv, '--seed')) : 1;
  if (!Number.isInteger(seed)) throw new Error('--seed: a whole number');
  const sources = [];
  const records = [];
  for (const f of files.map(x => path.resolve(x))) {
    const text = fs.readFileSync(f, 'utf8');
    sources.push({ file: f, sha256: crypto.createHash('sha256').update(text).digest('hex') });
    records.push(...text.split('\n').filter(Boolean).map(l => JSON.parse(l)));
  }
  const doc = L.buildLibraryIndex(records, { sources, seed });
  const out = L.writeLibrary(opt(argv, '--out') ? path.resolve(opt(argv, '--out')) : path.join(harnessHome(), 'experience'), doc);
  say(`${doc.records} record(s) from ${sources.length} file(s), ${Object.keys(doc.cells).length} cells, ${doc.months.from || '-'} to ${doc.months.to || '-'}; hash ${doc.hash.slice(0, 16)}`);
  say(`wrote ${out}`);
  return 0;
}

function pin(argv) {
  const [file, home] = positional(argv.slice(1));
  if (!file || !home) throw new Error(USAGE);
  const r = L.pinLibrary(path.resolve(home), path.resolve(file));
  say(`pinned ${r.hash.slice(0, 16)} for ${path.resolve(home)}: ${r.file}`);
  return 0;
}

const fix = x => (x === null || x === undefined ? '-' : Number(x).toFixed(2));

function show(argv) {
  const [file] = positional(argv.slice(1));
  if (!file) throw new Error(USAGE);
  const top = numberOpt(argv, '--top', 20);
  const doc = L.readLibrary(path.resolve(file));
  const rows = Object.keys(doc.cells).map(k => [k, L.libraryCellAt(doc, k)]).filter(([, c]) => c.enough).sort((a, b) => b[1].meanR.mean - a[1].meanR.mean).slice(0, top);
  process.stdout.write(`history library ${doc.hash.slice(0, 16)}: ${doc.records} records, ${doc.months.from || '-'} to ${doc.months.to || '-'}; ${doc.standard}\n`);
  for (const [k, c] of rows) process.stdout.write(`${fix(c.meanR.mean)}R [${fix(c.meanR.lo)}, ${fix(c.meanR.hi)}] win ${fix(c.winRate.rate)} n ${c.n} (${c.days} days)  ${k}\n`);
  if (!rows.length) process.stdout.write('no cell has enough samples yet\n');
  return 0;
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === 'scan') return scan(argv);
  if (cmd === 'index') return index(argv);
  if (cmd === 'pin') return pin(argv);
  if (cmd === 'show') return show(argv);
  throw new Error(USAGE);
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[setup-library] ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
