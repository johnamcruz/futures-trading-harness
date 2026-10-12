#!/usr/bin/env node
/**
 * The bar briefing the autonomous runner builds after each closed bar
 * (scripts/lib/trading/briefing.js): the analysis by timeframe, each part
 * with its version and how long it holds.
 *
 *   node scripts/briefing.js --symbol MNQ [--json]
 *
 * The operation lives in scripts/lib/harness-tools/briefing.js.
 */

'use strict';

const { barBriefing, parseArgv } = require('./lib/harness-tools/briefing');
const { runCli } = require('./lib/harness-tools/cli');

/** Run with argv (after the script name): prints and sets the exit code. */
const main = argv => runCli('briefing', () => barBriefing(parseArgv(argv)));

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
