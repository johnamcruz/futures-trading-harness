#!/usr/bin/env node
'use strict';

// Setup capture (docs/TRAINING.md, "Setup capture"): whether a run's arm catches the census's trend legs and the setups
// its briefings list, and two arms compared. Read only: it reads run homes and the leg census, and writes only --out.
//
//   node scripts/setup-capture.js report --census <leg-census.json> --a <home|folder>... [--b <home|folder>...]
//        [--names a,b] [--json] [--out <file>]
//   node scripts/setup-capture.js accept --census <leg-census.json> --a <home|folder>... --b <home|folder>...
//        --criteria <criteria.json> [--names a,b] [--out <report.json>]
//
// A folder holds run homes (each a replay run's home). accept exits 0 on PASS, 1 on FAIL, 2 on insufficient data, 3 on
// a usage or criteria error; its thresholds come from the criteria file only (scripts/lib/analysis/capture-compare.js).
// The report's Wilson level is the keep rule's (config/training.json keepRule.level); accept's is the criteria file's.

const fs = require('fs');
const path = require('path');
const SC = require('./lib/analysis/setup-capture');
const CC = require('./lib/analysis/capture-compare');
const { readCensus } = require('./lib/learning/leg-census');

const ERROR = CC.EXIT.length;
const USAGE = 'usage: setup-capture.js report|accept --census <file> --a <home|folder>... [--b <home|folder>...] [--criteria <file>] [--names a,b] [--json] [--out <file>]';

/** The flags: values of a list flag run to the next flag. */
function parse(argv) {
  const out = { cmd: argv[0], a: [], b: [] };
  let key = null;
  for (const x of argv.slice(1)) {
    if (x.startsWith('--')) {
      key = x.replace(/^--/, '');
      if (key === 'json') { out.json = true; key = null; }
      continue;
    }
    if (key === 'a' || key === 'b') out[key].push(x);
    else if (key) { out[key] = x; key = null; } else throw new Error(`${x}: an argument with no flag`);
  }
  return out;
}

function write(file, doc) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 1)}\n`);
}

function main(argv) {
  const o = parse(argv);
  if (!['report', 'accept'].includes(o.cmd) || !o.census || !o.a.length) throw new Error(USAGE);
  if (o.cmd === 'accept' && (!o.b.length || !o.criteria)) throw new Error(`${USAGE}\naccept: --b and --criteria are needed`);
  const [na, nb] = (o.names || 'a,b').split(',');
  // The criteria first: a malformed file refuses before any home is read.
  let criteria = null;
  if (o.cmd === 'accept') {
    criteria = JSON.parse(fs.readFileSync(o.criteria, 'utf8'));
    CC.checkCriteria(criteria);
  }
  const census = readCensus(o.census);
  const a = SC.readArm(o.a, { census });
  const b = o.b.length ? SC.readArm(o.b, { census }) : null;
  const sa = SC.armSummary(a);
  const sb = b ? SC.armSummary(b) : null;
  const level = criteria ? criteria.level : require('./lib/tunables').training().keepRule.level;
  const cmp = b ? CC.compare(a, b, { level }) : null;
  if (o.cmd === 'report') {
    const doc = { a: sa, ...(sb ? { b: sb, compare: { ...cmp, arms: undefined } } : {}) };
    if (o.out) write(o.out, doc);
    if (o.json) { process.stdout.write(`${JSON.stringify(doc, null, 1)}\n`); return 0; }
    const lines = [...SC.armLines(sa, na), ...(sb ? [...SC.armLines(sb, nb), `== ${na} against ${nb}`, ...CC.compareLines(cmp, { a: na, b: nb })] : [])];
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }
  const r = CC.evaluate(cmp, criteria);
  if (o.out) write(o.out, { verdict: r.verdict, results: r.results, a: sa, b: sb, compare: { ...cmp, arms: undefined } });
  process.stdout.write(`${r.lines.join('\n')}\n`);
  return CC.EXIT.indexOf(r.verdict);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = ERROR;
}
