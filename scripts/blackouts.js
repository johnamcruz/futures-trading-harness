#!/usr/bin/env node
/**
 * Append-only news blackouts for the order gate. Agents add windows with this
 * script; it can't remove a future window, so writing blackouts only ever
 * restricts trading. Windows that ended more than a day ago are pruned.
 *
 *   node scripts/blackouts.js add --start 2026-10-14T12:25:00Z --end 2026-10-14T12:40:00Z --reason "CPI"
 *   node scripts/blackouts.js list
 *
 * The operations live in scripts/lib/harness-tools/blackouts.js.
 */

'use strict';

const { addWindow, list, add } = require('./lib/harness-tools/blackouts');
const { loadConfig } = require('./lib/trading/config');
const { harnessNow } = require('./lib/trading/harness-now');

function option(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** Run one command; prints with `out` and returns the exit code (throws on failure). */
function run(argv, { env = process.env, now = harnessNow(env), out = s => process.stdout.write(s) } = {}) {
  const [cmd, ...args] = argv;
  loadConfig(env);
  const ctx = { env, now: () => now };
  let r;
  if (cmd === 'list') r = list({}, ctx);
  else if (cmd === 'add') r = add({ start: option(args, '--start'), end: option(args, '--end'), reason: option(args, '--reason') }, ctx);
  else throw new Error('usage: blackouts.js add --start <ISO> --end <ISO> --reason <text> | list');
  out(r.text);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[blackouts] ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { addWindow, run };
