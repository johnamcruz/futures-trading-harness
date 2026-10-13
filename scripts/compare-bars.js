#!/usr/bin/env node
/**
 * Compare the bars two sources give for the same span, field by field: how far apart the broker's own
 * fields on them are (any dotted path), after aligning the bars by time and checking their prices.
 * The harness gives the fields no meaning. See docs/BACKTESTING.md ("Comparing bar sources").
 *
 *   node scripts/compare-bars.js --a <bars.jsonl|bars.json|broker:<name>> --b <...>
 *       [--contract MNQ --from <ISO> --to <ISO> [--timeframe 1]]   a broker source's span; --from/--to also cut files
 *       [--fields a.b,c.d[1]] [--prefix a]                         default: every numeric or boolean leaf field
 *       [--tol 0] [--rtol 0] [--ohlcv-tol 0] [--by hour] [--worst 5]
 *       [--fail-below corr=0.95,within=0.99,sign=..,coverage=..,bars=..] [--out report.json]
 *
 * Prints the Markdown report; --out writes the JSON report there and the Markdown next to it (.md).
 * Exit 0: every field meets the --fail-below thresholds (or none set); 1: some field misses them, or no bar was compared;
 * 2: a usage error; 3: a source could not be read or fetched, or --out could not be written.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib/compare-bars');

const ROOT = path.resolve(__dirname, '..');

async function load(source, span) {
  // A file is cut to --from/--to when given, as a broker source's span is.
  if (source.kind === 'file') return lib.clip(lib.readBarsFile(path.resolve(source.file)), span);
  return lib.fetchBrokerBars({ broker: source.broker, ...span, root: ROOT, env: process.env });
}

async function main(argv) {
  let opts;
  try {
    opts = lib.parseArgs(argv);
  } catch (err) {
    if (!(err instanceof lib.UsageError)) throw err;
    process.stderr.write(`[compare-bars] ${err.message}\n`);
    return 2;
  }
  // Credentials and settings for a broker source's server, from the user's .env (key names only, to stderr).
  if (Object.values(opts.sources).some(s => s.kind === 'broker')) require('./lib/env-file').loadEnvForCli('compare-bars');
  let a;
  let b;
  try {
    a = await load(opts.sources.a, opts.span);
    b = await load(opts.sources.b, opts.span);
  } catch (err) {
    process.stderr.write(`[compare-bars] ${err.message}\n`);
    return 3;
  }
  let report;
  try {
    report = lib.compareBars(a, b, opts.compare);
  } catch (err) {
    process.stderr.write(`[compare-bars] ${err.message}\n`);
    return 2;
  }
  const md = lib.toMarkdown(report);
  process.stdout.write(md);
  if (opts.out) {
    const out = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(out.replace(/\.json$/, '.md'), md);
  }
  return report.pass ? 0 : 1;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[compare-bars] ${err.message}\n`);
  process.exitCode = 3;
});
