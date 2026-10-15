#!/usr/bin/env node
'use strict';

/**
 * The skill-usage report of a replay run (scripts/lib/learning/skill-usage.js): for each skill, how often the model
 * claimed one of its reads where one was true, how many it got right and wrong (with the top refusals), what it
 * missed, and the outcomes by skill and skill combination. An operator report: printed or written for people, never
 * shown to the model. `replay.js report` adds it to report.md.
 *
 *   node scripts/skill-usage.js <run dir> [--bars SYM=file ...] [--json] [--out file]
 *     <run dir>   <run home>/replay/<runId>, as `replay.js report` takes it
 *     --bars      the data the run replayed (as for labels), else the run home's bars
 *     --json      the report as JSON; else Markdown
 *     --out       write it to a file (else stdout)
 */

const fs = require('fs');
const path = require('path');
const { readSkillUsage, skillUsageMarkdown } = require('./lib/learning/skill-usage');

const USAGE = 'usage: skill-usage.js <run dir> [--bars SYM=file ...] [--json] [--out file]';

function args(argv) {
  const out = { dir: null, bars: {}, json: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--out') out.out = argv[(i += 1)];
    else if (a === '--bars') {
      const m = /^([A-Za-z0-9]+)=(.+)$/.exec(String(argv[(i += 1)] || ''));
      if (!m) throw new Error('--bars takes SYMBOL=file');
      out.bars[m[1].toUpperCase()] = m[2];
    } else if (!a.startsWith('--') && !out.dir) out.dir = a;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.dir || (out.out !== null && !out.out)) throw new Error(USAGE);
  return out;
}

function main(argv) {
  let o;
  try { o = args(argv); } catch (err) { process.stderr.write(`${err.message}\n`); return 2; }
  if (!fs.existsSync(o.dir)) { process.stderr.write(`no run dir ${o.dir}\n`); return 2; }
  let u;
  try { u = readSkillUsage(o.dir, { barsFiles: o.bars }); } catch (err) { process.stderr.write(`${err.message}\n`); return 1; }
  const text = o.json ? `${JSON.stringify(u, null, 2)}\n` : skillUsageMarkdown(u);
  if (o.out) {
    fs.writeFileSync(path.resolve(o.out), text);
    process.stdout.write(`wrote ${o.out}\n`);
  } else process.stdout.write(text);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, args };
