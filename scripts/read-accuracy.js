#!/usr/bin/env node
'use strict';

/**
 * The head trader's STATE reads over a run (scripts/lib/learning/read-accuracy.js): per field and frame, how often the
 * read agrees with the bar briefing's own label, with n and day-clustered intervals, and the read-by-fact table. Read
 * only: it measures the model's stated reads, it changes nothing.
 *
 *   node scripts/read-accuracy.js <replay run dir> [--json]
 *   node scripts/read-accuracy.js --home <run home> [--json]      (its cycle logs: a live or a replay home)
 */

const fs = require('fs');
const path = require('path');
const RA = require('./lib/learning/read-accuracy');

const USAGE = 'usage: read-accuracy.js <replay run dir> | --home <run home> [--json]';

function main(argv) {
  const at = argv.indexOf('--home');
  const home = at >= 0 ? argv[at + 1] : null;
  const dir = argv.find((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1)) || null;
  let cycles;
  if (home) {
    if (!fs.existsSync(path.join(home, 'logs'))) { process.stderr.write(`read-accuracy: no cycle logs under ${home} (logs)\n${USAGE}\n`); return 1; }
    cycles = RA.homeCycles(home);
  } else if (dir) {
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) { process.stderr.write(`read-accuracy: no replay run at ${dir} (manifest.json)\n${USAGE}\n`); return 1; }
    cycles = RA.runCycles(dir);
  } else {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const t = RA.tally(cycles);
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(t, null, 2)}\n` : `${RA.renderReads(t)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
