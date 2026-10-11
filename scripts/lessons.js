#!/usr/bin/env node
/**
 * What the journal has taught so far (scripts/lib/trading/instincts.js): each
 * setup's record by regime, recurring mistakes, and the reviewer's lessons,
 * strongest evidence first, with a confidence from 0.3 to 0.9.
 *
 *   node scripts/lessons.js [--top 10] [--json]
 *
 * The operation lives in scripts/lib/harness-tools/lessons.js.
 */

'use strict';

const { lessons, parseArgv } = require('./lib/harness-tools/lessons');
const { runCli } = require('./lib/harness-tools/cli');

/** Run with argv (after the script name): prints and sets the exit code. */
const main = argv => runCli('lessons', () => lessons(parseArgv(argv)));

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
