#!/usr/bin/env node
'use strict';

/**
 * The recognition test over recorded runs (scripts/lib/learning/recognition/, docs/TRAINING.md "The recognition test"):
 * per frozen case (a census trend leg or a chop day), candle by candle from what was visible then, the model's first
 * recognition against the first candle the evidence supports the class (with the coded read's beside it), the evidence
 * then, the entry against the harness's confirmation, the chop-day naming and entries, and the misses. Read only: it
 * measures, it changes nothing, and it asks the model nothing.
 *
 *   node scripts/recognition.js --run <run home | runs folder | replay run dir>... [--bars SYMBOL=<file>]...
 *                               [--cases <file> --cases-sha <sha256>] [--tree <harness tree>] [--json]
 *
 * --run: repeatable (the cases' days may sit in several runs). --bars: the data the runs replayed (1m bars give the 1m
 * lane), else each run home's own bars. --cases: another frozen case list, taken only with its sha256 (default the
 * committed config/recognition-cases.json, checked against config/recognition.json). --tree: the harness tree the runs
 * traded (its strategies: the plan and entry rule the confirmation reads), default this one.
 */

const fs = require('fs');
const path = require('path');
const RC = require('./lib/learning/recognition/config');
const R = require('./lib/learning/recognition/run');
const P = require('./lib/learning/recognition/report');

const USAGE = 'usage: recognition.js --run <run home | runs folder | replay run dir>... [--bars SYMBOL=<file>]... [--cases <file> --cases-sha <sha256>] [--tree <dir>] [--json]';

function args(argv) {
  const out = { runs: [], barsFiles: {}, cases: null, casesSha: null, tree: path.resolve(__dirname, '..'), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--run') out.runs.push(argv[(i += 1)]);
    else if (a === '--cases') out.cases = argv[(i += 1)];
    else if (a === '--cases-sha') out.casesSha = argv[(i += 1)];
    else if (a === '--tree') out.tree = argv[(i += 1)];
    else if (a === '--bars') {
      const m = /^([A-Za-z0-9]+)=(.+)$/.exec(String(argv[(i += 1)] || ''));
      if (!m) return { error: '--bars takes SYMBOL=<file>' };
      out.barsFiles[m[1].toUpperCase()] = m[2];
    } else return { error: `unknown argument ${a}` };
  }
  return out;
}

function main(argv) {
  const o = args(argv);
  const fail = why => { process.stderr.write(`recognition: ${why}\n${USAGE}\n`); return 1; };
  if (o.error) return fail(o.error);
  if (!o.runs.length) return fail('no --run');
  const missing = [...o.runs, ...Object.values(o.barsFiles), ...(o.cases ? [o.cases] : []), o.tree].find(p => !p || !fs.existsSync(p));
  if (missing !== undefined) return fail(`no such path ${missing}`);
  let frozen;
  try { frozen = RC.load(o.cases ? { casesFile: o.cases, casesSha: o.casesSha } : {}); } catch (e) { return fail(e.message); }
  const doc = R.recognitionReport({ targets: o.runs, barsFiles: o.barsFiles, tree: o.tree, ...frozen });
  if (!doc.runs.length) return fail(`no replay run (manifest.json) under ${o.runs.join(', ')}`);
  process.stdout.write(o.json ? `${JSON.stringify(doc, null, 1)}\n` : `${P.renderReport(doc)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
