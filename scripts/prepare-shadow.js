#!/usr/bin/env node
'use strict';

/**
 * Prepare ahead's shadow log, read back from a run home (docs/PREPARE-AHEAD.md, "Reading a shadow replay"): the agreement
 * with the full cycle, the prepare and confirm times, the void and outside-plan rates by kind, the deadline aborts and
 * the tokens (scripts/lib/prepare-shadow-report.js). Read only.
 *
 *   node scripts/prepare-shadow.js --home <run home> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
 */

const fs = require('fs');
const path = require('path');
const R = require('./lib/prepare-shadow-report');

const USAGE = 'usage: prepare-shadow.js --home <run home> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]';
const arg = (argv, k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);

function main(argv) {
  const home = arg(argv, '--home');
  if (!home) { process.stderr.write(`${USAGE}\n`); return 1; }
  if (!fs.existsSync(path.join(home, 'logs', 'cycles'))) { process.stderr.write(`prepare-shadow: no cycle records under ${home} (logs/cycles)\n`); return 1; }
  const rep = R.report(R.readRecords(home, { from: arg(argv, '--from'), to: arg(argv, '--to') }));
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(rep, null, 2)}\n` : `${R.text(rep)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
