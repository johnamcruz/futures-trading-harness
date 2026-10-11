#!/usr/bin/env node
/**
 * Strategy registry CLI (any harness can run it from a shell tool).
 *
 *   node scripts/strategies.js list [--json]
 *   node scripts/strategies.js show <name>
 *   node scripts/strategies.js validate
 *   node scripts/strategies.js scan <bars file|-> --symbol MNQ [--now ISO] [--record]   (default now: the harness clock)
 *   node scripts/strategies.js recent <bars file> --symbol MNQ [--bars 5]   what fired on each of the last bars
 *   node scripts/strategies.js plan <bars file> --symbol MNQ --strategy <name> --side long|short [--account-id <id>]
 *     the order arithmetic for the strategy and side you chose, when it is a candidate now (never placed)
 *
 * The operations live in scripts/lib/harness-tools/strategies.js.
 */

'use strict';

const { OPS, parseArgv } = require('./lib/harness-tools/strategies');
const { OpError } = require('./lib/harness-tools/cli');

/** Run one command; prints with `out` and returns the exit code (throws on failure, after any output). */
function run(argv, { env = process.env, out = s => process.stdout.write(s) } = {}) {
  const { op, args } = parseArgv(argv);
  let r;
  try {
    r = OPS[op](args, { env });
  } catch (err) {
    if (err instanceof OpError && err.text) out(err.text);
    throw err;
  }
  if (r.text) out(r.text);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.code || 0;
}

if (require.main === module) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[strategies] ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run };
