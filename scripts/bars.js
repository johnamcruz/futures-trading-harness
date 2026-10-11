#!/usr/bin/env node
/**
 * Fetch closed bars for a symbol into a file for the harness scripts
 * (market-snapshot, mtf, strategies scan), without pasting them through a
 * tool reply. Credentials come from the user's .env (never printed).
 *
 *   node scripts/bars.js --symbol MNQ [--timeframe 3] [--count N] [--out /tmp/fth/MNQ-3m.json] [--record]
 *   (default count: what the runner keeps, 250 hours of bars, enough for the 4h trend: 5000 3m bars)
 *   node scripts/bars.js --symbol MNQ --daily [--count 60]          daily bars for mtf.js --daily
 *
 * --out takes a .json file under /tmp/fth/ (and nothing else). --record also
 * records the multi-timeframe read for the order gate (as mtf.js --record);
 * refused in autonomous runs, where the runner records it. Prints one line:
 * the file, the contract, the bar count, and when the last bar closed.
 * The operation lives in scripts/lib/harness-tools/bars.js.
 */

'use strict';

const { fetch, parseArgv } = require('./lib/harness-tools/bars');
const { runCli } = require('./lib/harness-tools/cli');

/** Run with argv (after the script name): loads the user's .env, prints, and sets the exit code. */
function main(argv) {
  require('./lib/env-file').loadEnvForCli('bars');
  return runCli('bars', () => fetch(parseArgv(argv)));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
