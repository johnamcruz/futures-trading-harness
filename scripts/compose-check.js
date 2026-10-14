#!/usr/bin/env node
/**
 * A trade-lifecycle combination checked against this cycle's bar briefing, its plan worked out in code and recorded
 * (the harness tool compose_check):
 *
 *   node scripts/compose-check.js --symbol MNQ --side long --size 1 --reads '[{"step":"bias","skill":"bos-vs-choch","read":"1h bos up"}, ...]'
 *
 * The operation lives in scripts/lib/harness-tools/compose.js.
 */

'use strict';

const { composeCheck, parseArgv } = require('./lib/harness-tools/compose');
const { runCli } = require('./lib/harness-tools/cli');

/** Run with argv (after the script name): prints and sets the exit code. */
const main = argv => runCli('compose-check', () => composeCheck(parseArgv(argv)));

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
