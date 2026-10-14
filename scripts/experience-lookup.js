#!/usr/bin/env node
/**
 * The model's own record for the candidate it composed (the learning loop): the run's pinned experience index
 * for the latest verified trade_lifecycle record of the root.
 *
 *   node scripts/experience-lookup.js --symbol MNQ [--alternative setup:breakout-vs-fakeout] [--role risk-manager]
 *
 * The operation lives in scripts/lib/harness-tools/experience.js.
 */

'use strict';

const { experienceLookup, parseArgv } = require('./lib/harness-tools/experience');
const { runCli } = require('./lib/harness-tools/cli');

/** Run with argv (after the script name): prints and sets the exit code. */
const main = argv => runCli('experience-lookup', () => experienceLookup(parseArgv(argv)));

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
