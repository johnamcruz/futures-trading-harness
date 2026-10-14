#!/usr/bin/env node
/**
 * A whole skill by name, as a role's skill index points to it
 * (scripts/lib/role-skills.js).
 *
 *   node scripts/skill-lookup.js --skill liquidity-concepts [--role volume-liquidity-analyst]
 *
 * The operation lives in scripts/lib/harness-tools/skills.js.
 */

'use strict';

const { skillLookup, parseArgv } = require('./lib/harness-tools/skills');
const { runCli } = require('./lib/harness-tools/cli');

/** Run with argv (after the script name): prints and sets the exit code. */
const main = argv => runCli('skill-lookup', () => skillLookup(parseArgv(argv)));

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
