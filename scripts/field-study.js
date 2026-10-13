#!/usr/bin/env node
/**
 * The field-forward study: does a broker bar field at bar t predict the price move after t?
 * Logic in lib/field-study.js; docs/BACKTESTING.md ("The field-forward study").
 *
 *   node scripts/field-study.js --data <file.jsonl|file.json|dir> [--data ...] --symbol MNQ
 *       --fields a.b,a.c[1] [--horizons 1,3,5,15] [--timeframe 1] [--tick 0.25] [--cost-ticks 2]
 *       [--thresholds 0.2,0.4] [--by hour,session] [--reps 1000] [--seed 1]
 *       [--held-out-look "<reason>"] [--out <dir>]
 *   node scripts/field-study.js --contract MNQ --from <ISO> --to <ISO> --timeframe 3 --fields ... (bars from the broker)
 *
 * Each file (or each file in a directory, in name order) is its own chunk: no pair spans two files.
 * Spans with months outside Train are refused without --held-out-look (lib/prop/splits.js roleOf).
 */

'use strict';

require('./lib/env-file').loadEnvForCli('field-study');

const fs = require('fs');
const path = require('path');
const fsy = require('./lib/field-study');
const { loadBars, barMinutes } = require('./lib/backtest/data');
const { specFor } = require('./lib/trading/contracts');
const { normalizeBars } = require('./lib/trading/indicators');
const { parseStandardName } = require('./lib/broker/translator');

const ROOT = path.resolve(__dirname, '..');
const VALUE_FLAGS = ['--data', '--contract', '--from', '--to', '--symbol', '--fields', '--horizons', '--timeframe', '--tick', '--cost-ticks', '--thresholds', '--by', '--reps', '--seed', '--held-out-look', '--out'];

function parseArgs(argv) {
  const a = { data: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!VALUE_FLAGS.includes(flag)) throw new Error(`unknown argument: ${flag} (flags: ${VALUE_FLAGS.join(' ')})`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--data') a.data.push(v);
    else if (a[flag.slice(2)] !== undefined) throw new Error(`${flag} given twice`);
    else a[flag.slice(2)] = v;
  }
  return a;
}

const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
function num(a, key, { min = -Infinity, int = false } = {}) {
  if (a[key] === undefined) return undefined;
  const v = Number(a[key]);
  if (!Number.isFinite(v) || v < min || (int && !Number.isInteger(v))) throw new Error(`--${key}: not a valid number`);
  return v;
}

/** The files named by --data: files as given, directories as their .jsonl/.json files in name order. */
function dataFiles(items) {
  return items.flatMap(item => {
    const p = path.resolve(item);
    if (!fs.statSync(p).isDirectory()) return [p];
    // A report this tool wrote (field-study.json) is never read back as bars.
    return fs.readdirSync(p).filter(f => /\.(jsonl|ndjson|json)$/i.test(f) && f !== 'field-study.json').sort().map(f => path.join(p, f));
  });
}

async function brokerBars(a, timeframe) {
  const { withAdapter } = require('./lib/broker/adapter');
  const from = new Date(a.from || '');
  const to = new Date(a.to || '');
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || !(from < to)) throw new Error('--from and --to: ISO times, from before to');
  // The split check runs on the requested span before anything is fetched.
  fsy.splitCheck(fsy.monthsBetween(from.getTime(), to.getTime()), { heldOutLook: a['held-out-look'] });
  const bars = await withAdapter({ root: ROOT, env: process.env }, b => b.history(a.contract, { from, to, timeframe }));
  return normalizeBars(bars).map(b => ({ ...b, ms: Date.parse(b.t) }));
}

/** One chunk: its columns, first and last time, and bar size; the bars themselves are dropped. */
function chunkOf(bars, fields) {
  if (!bars.length) return null;
  const ms = bars.map(b => b.ms);
  return { cols: fsy.columns(bars, fields), first: ms.reduce((x, y) => (y < x ? y : x)), last: ms.reduce((x, y) => (y > x ? y : x)), tf: barMinutes(bars), n: bars.length };
}

async function main(argv) {
  const a = parseArgs(argv);
  const fields = list(a.fields).map(fsy.parseFieldSpec);
  if (!fields.length) throw new Error('--fields: one or more dotted paths, e.g. a.b,a.c[1]');
  const horizons = fsy.parseHorizons(a.horizons || '1,3,5,15');
  const by = list(a.by);
  if (!by.every(b => b === 'hour' || b === 'session')) throw new Error('--by: hour and/or session');
  if (!a.data.length && !a.contract) throw new Error('give --data <bars file or dir> or --contract <name> --from --to --timeframe');
  if (a.data.length && a.contract) throw new Error('use --data or --contract, not both');
  const symbol = (a.symbol || (a.contract && (parseStandardName(a.contract) || {}).root) || '').toUpperCase();
  const tick = num(a, 'tick', { min: 0 }) ?? (specFor(symbol) || {}).tickSize;
  if (!(tick > 0)) throw new Error('the tick size: give --symbol (a known contract root) or --tick');
  const thresholds = a.thresholds === undefined ? null : list(a.thresholds).map(Number);
  if (thresholds && !thresholds.every(v => Number.isFinite(v) && v >= 0)) throw new Error('--thresholds: non-negative numbers');

  let timeframe = num(a, 'timeframe', { min: 1, int: true });
  const chunks = (a.contract ? [chunkOf(await brokerBars(a, timeframe || 1), fields)] : dataFiles(a.data).map(f => chunkOf(loadBars(f), fields))).filter(Boolean);
  const source = a.contract ? `broker history (${process.env.FTH_BROKER || 'the configured broker'}), ${a.contract}` : `files: ${a.data.join(', ')}`;
  if (!chunks.length) throw new Error('no bars');
  const seen = chunks.reduce((x, y) => (y.n > x.n ? y : x)).tf;
  if (!timeframe) timeframe = seen;
  else if (seen !== null && seen !== timeframe) process.stderr.write(`[field-study] WARNING: --timeframe ${timeframe} but the bars are mostly ${seen} minutes apart\n`);
  // Overlapping chunks (two files over the same minutes) would count those minutes twice.
  const byTime = chunks.slice().sort((x, y) => x.first - y.first);
  const overlap = byTime.findIndex((c, i) => i > 0 && c.first <= byTime[i - 1].last);
  if (overlap > 0) throw new Error(`two bar files overlap in time (at ${new Date(byTime[overlap].first).toISOString()}): give each minute once`);
  const first = Math.min(...chunks.map(c => c.first));
  const last = Math.max(...chunks.map(c => c.last));
  // The split check on the bars' own months, before any forward move is read.
  const check = fsy.splitCheck(fsy.monthsBetween(first, last + 1), { heldOutLook: a['held-out-look'] });
  if (check.warning) process.stderr.write(`[field-study] ${check.warning}\n`);
  const t = fsy.joinChunks(chunks.map(c => c.cols), { timeframeMin: timeframe });
  const costTicks = num(a, 'cost-ticks', { min: 0 }) ?? 2;
  const results = fsy.study(t, { fields, horizons, tick, thresholds, costTicks, by, reps: num(a, 'reps', { min: 10, int: true }) ?? 1000, seed: num(a, 'seed', { int: true }) ?? 1 });
  const header = {
    span: { from: new Date(first).toISOString(), to: new Date(last).toISOString() }, source, symbol,
    timeframeMin: timeframe, tick, costTicks, months: check.months, warning: check.warning, bars: t.n, segments: t.segments,
  };
  const md = fsy.toMarkdown(header, results);
  if (a.out) {
    const dir = path.resolve(a.out);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'field-study.md'), md);
    fs.writeFileSync(path.join(dir, 'field-study.json'), `${JSON.stringify({ header, results }, null, 1)}\n`);
    process.stdout.write(`[field-study] ${t.n} bars, ${results.length} field x horizon results: ${path.join(dir, 'field-study.md')}\n`);
  } else {
    process.stdout.write(md);
  }
  return 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[field-study] ${err.message}\n`);
  process.exitCode = 1;
});
