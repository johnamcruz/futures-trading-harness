#!/usr/bin/env node
'use strict';

/**
 * The read audit over a run (scripts/lib/learning/read-audit.js, docs/TRAINING.md "The read audit"): per decision, what
 * the model read (its STATE line), what the market was doing (the cycle bar's briefing labels, as recorded), and what
 * happened next (OUTCOME, hindsight); each decision sorted into misread, read right / acted wrong, market turned, small
 * loss, acted right, or passed, with unscorable counted apart. Read only: it measures, it changes nothing.
 *
 *   node scripts/read-audit.js --run <run home | runs folder | replay run dir> [--decisions <dir|file>]... [--bars SYMBOL=<file>]...
 *                              [--days d1,d2] [--json]
 *
 * --decisions: the decision records holding each entry's exact trade R (a training home's <run>-decisions.json, or a
 * scorecard.jsonl); without them an entry is unscorable (no decision record). --bars: the data the run replayed (the
 * scorecard's --bars), read for a pass's forward move in place of the run's own bars archive, which ends with the run.
 */

const fs = require('fs');
const RA = require('./lib/learning/read-audit');

const USAGE = 'usage: read-audit.js --run <run home | runs folder | replay run dir> [--decisions <dir|file>]... [--bars SYMBOL=<file>]... [--days YYYY-MM-DD,...] [--json]';

function args(argv) {
  const out = { run: null, decisions: [], barsFiles: {}, days: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--run') out.run = argv[(i += 1)];
    else if (a === '--decisions') out.decisions.push(...String(argv[(i += 1)] || '').split(',').filter(Boolean));
    else if (a === '--bars') {
      const m = /^([A-Za-z0-9]+)=(.+)$/.exec(String(argv[(i += 1)] || ''));
      if (!m) return { error: '--bars takes SYMBOL=<file>' };
      out.barsFiles[m[1].toUpperCase()] = m[2];
    } else if (a === '--days') out.days = String(argv[(i += 1)] || '').split(',').filter(Boolean);
    else return { error: `unknown argument ${a}` };
  }
  return out;
}

function main(argv) {
  const o = args(argv);
  const fail = why => { process.stderr.write(`read-audit: ${why}\n${USAGE}\n`); return 1; };
  if (o.error) return fail(o.error);
  if (!o.run || !fs.existsSync(o.run)) return fail(o.run ? `no such path ${o.run}` : 'no --run');
  const missing = [...o.decisions, ...Object.values(o.barsFiles)].find(p => !fs.existsSync(p));
  if (missing) return fail(`no such path ${missing}`);
  const dirs = RA.replayDirs(o.run);
  if (!dirs.length) return fail(`no replay run (manifest.json) under ${o.run}`);
  const decisions = o.decisions.length ? RA.loadDecisions(o.decisions) : null;
  const runs = [];
  const rows = [];
  for (const d of dirs) {
    const got = RA.runRows(d, { decisions, days: o.days, barsFiles: o.barsFiles });
    runs.push(got.runId);
    rows.push(...got.rows);
  }
  const s = { runs, ...RA.summarize(rows) };
  process.stdout.write(o.json ? `${JSON.stringify(s, null, 2)}\n` : `Runs: ${runs.length}${decisions ? '' : ' (no --decisions: entries have no trade R)'}\n${RA.renderAudit(s)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
