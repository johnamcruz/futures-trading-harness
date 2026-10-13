#!/usr/bin/env node
/**
 * The reason check: the reasons stated for a decision, each checked against
 * the facts of the bar it decides (the bar briefing, the policy verdicts on
 * that bar, the started prop attempts): true, false, or unchecked, and each
 * setup's priority-order steps as the facts answer them.
 *
 *   node scripts/reason-check.js --symbol MNQ --reasons "<the stated decision>" [--json]
 *
 * The operation lives in scripts/lib/harness-tools/reasons.js.
 */

'use strict';

const { check, parseArgv } = require('./lib/harness-tools/reasons');
const { runCli } = require('./lib/harness-tools/cli');

/** Run with argv (after the script name): prints and sets the exit code. */
const main = argv => runCli('reason-check', () => check(parseArgv(argv)));

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
