#!/usr/bin/env node
/**
 * Indicator and level snapshot for the analyst agents.
 *
 *   node scripts/market-snapshot.js bars.json [--orbMinutes=30 --emaSlow=50 ...]
 *   cat bars.json | node scripts/market-snapshot.js -
 *
 * Input: the JSON returned by get_bars ({ bars: [{t,o,h,l,c,v}] })
 * or a bare array of bars. Output: JSON (see scripts/lib/trading/market-snapshot.js).
 * Use closed bars only (includePartialBar=false), oldest first.
 * The operation lives in scripts/lib/harness-tools/market-snapshot.js.
 */

'use strict';

const { snapshot, parseArgv } = require('./lib/harness-tools/market-snapshot');
const { runCli } = require('./lib/harness-tools/cli');

/** Run with argv (after the script name): prints and sets the exit code. */
const main = argv => runCli('market-snapshot', () => snapshot(parseArgv(argv)));

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
