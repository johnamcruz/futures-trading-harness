#!/usr/bin/env node
/**
 * The curated training lists (scripts/lib/learning/curated-lists.js, curated-moments.js): code scans history for the
 * setup moments, with their trend, true reads and the library's standard outcome, then selects seeded, year-balanced
 * lists and a run mix (in time order), fingerprinted. A practice replay pins one (its config's curatedList) and runs
 * only its windows. The user's to run, between sessions, like the history library.
 *
 *   node scripts/curated-lists.js scan --bars <file> --root MNQ --from YYYY-MM-DD --to YYYY-MM-DD --use practice|validate
 *       --out <moments.jsonl> [--minutes 3] [--tick 0.25] [--setup-tf 15] [--window-bars N] [--jobs N]
 *       every reaction moment in [from, to) (practice: practice-train only; validate: practice-validate only); --jobs
 *       scans whole session dates in N processes at once (the same moments, in order)
 *   node scripts/curated-lists.js build <moments.jsonl> ... --use practice|validate [--total 200] [--seed 1]
 *       [--min-skill 3] [--mix trend-up=0.35,trend-down=0.35,trend-end=0.1,chop=0.1,counter-trend=0.1]
 *       [--pass-share trend-end=0.6,chop=0.7,counter-trend=0.7] [--legs-bars <file> [--legs-sessions spec]] [--out dir]
 *       the lists, the mix and their coverage -> <out>/curated-<use>-<fingerprint>.json (default <FTH_HOME>/experience);
 *       --legs-bars: the scan's bars, its trend legs (the capture report's detector, in --legs-sessions, by default
 *       config/replay.json trendCapture.curationSessions) label the trend lists and each leg gets a moment first
 *   node scripts/curated-lists.js census <moments.jsonl> ... --use practice --legs-bars <file> [--legs-sessions spec]
 *       [--seed N] [--out dir]   the trend-leg census (learning/leg-census.js): every leg, its first with-leg moment, one
 *       seeded order -> <out>/leg-census-<use>-<fingerprint>.json (default <FTH_HOME>/experience)
 *   node scripts/curated-lists.js build --census <file> --batch <k> --use practice [--out dir]   batch k of a census as
 *       the trend lists of one hashed list document
 *   node scripts/curated-lists.js show <lists file>       the coverage report
 */

'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { harnessHome } = require('./lib/paths');
const { loadBars } = require('./lib/backtest/data');
const { baseBars, runnerClock } = require('./lib/learning/setup-library');
const M = require('./lib/learning/curated-moments');
const C = require('./lib/learning/curated-lists');
const LC = require('./lib/learning/leg-census');

const USAGE = 'usage: curated-lists.js scan --bars <file> --root <ROOT> --from YYYY-MM-DD --to YYYY-MM-DD --use practice|validate --out <moments.jsonl> [--minutes 3] [--tick 0.25] [--setup-tf 15] [--window-bars N] [--jobs N] | build <moments.jsonl> ... --use practice|validate [--total N] [--seed N] [--min-skill N] [--mix list=share,...] [--pass-share list=share,...] [--legs-bars <file> [--legs-sessions spec]] [--out dir] | census <moments.jsonl> ... --use practice --legs-bars <file> [--seed N] [--out dir] | build --census <file> --batch <k> --use practice [--out dir] | show <lists file>';
const VALUE_FLAGS = ['--bars', '--root', '--from', '--to', '--use', '--out', '--minutes', '--tick', '--setup-tf', '--window-bars', '--total', '--seed', '--min-skill', '--mix', '--pass-share', '--jobs', '--legs-bars', '--legs-sessions', '--census', '--batch'];

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name}: give its value (${USAGE})`);
  return v;
}

const positional = argv => argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]));
const numberOpt = (argv, name, dflt, { integer = false, min = 0 } = {}) => {
  const v = opt(argv, name);
  const n = v === undefined ? dflt : Number(v);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) throw new Error(`${name}: ${integer ? 'a whole number' : 'a number'} of at least ${min}`);
  return n;
};
const say = msg => process.stdout.write(`[curated-lists] ${msg}\n`);

/** One scan in a child process per run of whole dates (C.dayChunks), their moments joined in order. */
async function scanJobs(argv, from, to, out, jobs) {
  const parts = C.dayChunks(from, to, jobs);
  const set = (args, name, v) => { const a = [...args]; a[a.indexOf(name) + 1] = v; return a; };
  const runs = parts.map(([a, b], k) => new Promise(resolve => {
    const file = `${path.resolve(out)}.part${k}`;
    const args = set(set(set(set(argv, '--from', a), '--to', b), '--out', file), '--jobs', '1');
    const child = spawn(process.execPath, [__filename, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => resolve({ file, code: null, err: `the scan of ${a}..${b} could not start (${e.message})` }));
    child.on('close', (code, signal) => resolve({ file, code, err: signal ? `the scan of ${a}..${b} was stopped by ${signal}` : err }));
  }));
  const done = await Promise.all(runs);
  let text;
  try {
    const bad = done.find(r => r.code !== 0);
    if (bad) throw new Error(String(bad.err).trim().replace(/^\[curated-lists\] /, '') || `the scan of a part failed (exit ${bad.code})`);
    text = done.map(r => fs.readFileSync(r.file, 'utf8')).join('');
  } finally {
    for (const r of done) fs.rmSync(r.file, { force: true });
  }
  fs.writeFileSync(path.resolve(out), text);
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

async function scan(argv) {
  const [file, root, from, to, use, out] = ['--bars', '--root', '--from', '--to', '--use', '--out'].map(f => opt(argv, f));
  if (!file || !root || !from || !to || !use || !out) throw new Error(USAGE);
  C.assertWithinData(from);
  if (!/^[A-Z0-9]{1,8}$/.test(root)) throw new Error('--root: a contract root, e.g. MNQ');
  const minutes = numberOpt(argv, '--minutes', 3, { integer: true, min: 1 });
  const setupTf = numberOpt(argv, '--setup-tf', 15, { integer: true, min: 1 });
  const tick = numberOpt(argv, '--tick', 0.25, { min: 1e-9 });
  const windowBars = opt(argv, '--window-bars') === undefined ? undefined : numberOpt(argv, '--window-bars', 0, { integer: true, min: 1 });
  const jobs = numberOpt(argv, '--jobs', 1, { integer: true, min: 1 });
  const started = Date.now();
  const stats = {};
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  let moments;
  if (jobs > 1) {
    moments = await scanJobs(argv, from, to, out, jobs);
  } else {
    const bars = baseBars(loadBars(path.resolve(file)), minutes);
    const clock = runnerClock({ from, to });
    // The standard's limit window: the shipped trade_lifecycle strategy's valid_bars (setup-library.js, as the library).
    const validBars = require('./lib/learning/setup-library').strategyValidBars(path.resolve(__dirname, '..'), process.env);
    moments = M.scanMoments({ bars, root, minutes, tick, from, to, use, setupTf, eodOf: clock.eodOf, inSession: clock.inSession, stats, validBars, ...(windowBars ? { windowBars } : {}) });
    fs.writeFileSync(path.resolve(out), moments.map(m => JSON.stringify(m)).join('\n') + (moments.length ? '\n' : ''));
  }
  const secs = (Date.now() - started) / 1000;
  say(`${secs.toFixed(1)}s${stats.briefings ? `, ${stats.briefings} briefing(s), ${((secs * 1000) / stats.briefings).toFixed(0)} ms each` : ` in ${jobs} process(es)`}`);
  const lists = {};
  for (const m of moments) lists[m.list || 'none'] = (lists[m.list || 'none'] || 0) + 1;
  say(`${moments.length} moment(s) of ${root} ${from}..${to} (${use}): ${Object.entries(lists).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  say(`wrote ${path.resolve(out)}`);
  return 0;
}

function mixOpt(argv, name = '--mix', dflt = C.DEFAULTS.mix) {
  const v = opt(argv, name);
  if (v === undefined) return dflt;
  const mix = {};
  for (const part of v.split(',')) {
    const [k, w] = part.split('=');
    if (!k || w === undefined || !Number.isFinite(Number(w))) throw new Error(`${name}: list=share,... (e.g. trend-up=0.35,trend-down=0.35,trend-end=0.1,chop=0.1,counter-trend=0.1)`);
    mix[k.trim()] = Number(w);
  }
  return mix;
}

/** The moments files given: { sources, moments }. */
function readMoments(files) {
  const sources = [];
  const moments = [];
  for (const f of files.map(x => path.resolve(x))) {
    const text = fs.readFileSync(f, 'utf8');
    sources.push({ file: f, sha256: crypto.createHash('sha256').update(text).digest('hex') });
    moments.push(...text.split('\n').filter(Boolean).map(l => JSON.parse(l)));
  }
  return { sources, moments };
}

const legsArg = (argv, moments) => C.legsFor(baseBars(loadBars(path.resolve(opt(argv, '--legs-bars'))), (moments[0] || {}).minutes), { session: opt(argv, '--legs-sessions'), use: opt(argv, '--use') });
const outDir = argv => (opt(argv, '--out') ? path.resolve(opt(argv, '--out')) : path.join(harnessHome(), 'experience'));

function census(argv) {
  const { sources, moments } = readMoments(positional(argv.slice(1)));
  if (!sources.length || !opt(argv, '--use') || !opt(argv, '--legs-bars')) throw new Error(USAGE);
  const doc = LC.buildCensus(moments, legsArg(argv, moments), { use: opt(argv, '--use'), seed: numberOpt(argv, '--seed', C.DEFAULTS.seed, { integer: true, min: -Number.MAX_SAFE_INTEGER }), sources });
  say(`${doc.legs} leg(s), ${doc.withMoment} with a moment; seed ${doc.seed}; fingerprint ${doc.fingerprint}`);
  say(`wrote ${LC.writeCensus(outDir(argv), doc)}`);
  return 0;
}

function build(argv) {
  const use = opt(argv, '--use');
  const cen = opt(argv, '--census') ? LC.readCensus(path.resolve(opt(argv, '--census'))) : null;
  const k = cen ? numberOpt(argv, '--batch', 0, { integer: true }) : null;
  const read = cen ? { sources: [{ file: opt(argv, '--census'), sha256: cen.fingerprint }], moments: LC.batch(cen, k).map(e => e.moment) } : readMoments(positional(argv.slice(1)));
  const { sources, moments } = read;
  if (!sources.length || !use) throw new Error(USAGE);
  const doc = C.buildLists(moments, {
    use, sources, mix: mixOpt(argv), passShare: mixOpt(argv, '--pass-share', C.DEFAULTS.passShare),
    seed: numberOpt(argv, '--seed', C.DEFAULTS.seed, { integer: true, min: -Number.MAX_SAFE_INTEGER }),
    total: numberOpt(argv, '--total', C.DEFAULTS.total, { integer: true, min: 1 }),
    minSkill: numberOpt(argv, '--min-skill', C.DEFAULTS.minSkill, { integer: true }),
    legs: !cen && opt(argv, '--legs-bars') ? legsArg(argv, moments) : null,
    census: cen ? { fingerprint: cen.fingerprint, seed: cen.seed, batch: k, size: moments.length } : null,
  });
  const out = C.writeLists(outDir(argv), doc);
  process.stdout.write(C.coverageText(doc));
  say(`${doc.mix.length} moment(s) from ${sources.length} file(s); fingerprint ${doc.fingerprint.slice(0, 16)}`);
  say(`wrote ${out}`);
  return 0;
}

function show(argv) {
  const [file] = positional(argv.slice(1));
  if (!file) throw new Error(USAGE);
  process.stdout.write(C.coverageText(C.readLists(path.resolve(file))));
  return 0;
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === 'scan') return scan(argv);
  if (cmd === 'build') return build(argv);
  if (cmd === 'census') return census(argv);
  if (cmd === 'show') return show(argv);
  throw new Error(USAGE);
}

if (require.main === module) {
  Promise.resolve().then(() => main(process.argv.slice(2))).then(code => { process.exitCode = code; }, err => {
    process.stderr.write(`[curated-lists] ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
