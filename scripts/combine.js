#!/usr/bin/env node
/**
 * Prop-challenge attempts (accounts/<name>/ACCOUNT.md):
 *
 *   node scripts/combine.js start  --account <account> [--force]  # start an attempt (--force restarts one)
 *   node scripts/combine.js status [--account <name>] [--json]
 *   node scripts/combine.js record-day --account <name> --day YYYY-MM-DD --balance <dollars>
 *                                                           # a close the runner missed
 *   node scripts/combine.js stop   --account <name>         # end the attempt (kept, renamed)
 *   node scripts/combine.js accounts                        # the account profiles
 *
 * The runner snapshots the balance every bar and records each day's close;
 * the order gate refuses entries for an account's strategies without a
 * started attempt and a fresh snapshot.
 *
 * status is also an agent operation (scripts/lib/harness-tools/combine.js);
 * start, record-day and stop are the user's: they change the attempt the gate
 * trades under.
 */

'use strict';

const path = require('path');
const { loadAccounts, accountNamed } = require('./lib/trading/accounts');
const prop = require('./lib/trading/prop-state');
const { harnessHome } = require('./lib/paths');
const { status } = require('./lib/harness-tools/combine');
const { harnessNow } = require('./lib/trading/harness-now');

const ROOT = path.resolve(__dirname, '..');

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function main(argv, out = s => process.stdout.write(s)) {
  const cmd = argv[0];
  const home = harnessHome();
  const now = harnessNow(); // the harness clock: a replay broker's replayed time, else the wall clock
  if (cmd === 'accounts') {
    const { accounts } = loadAccounts(ROOT, process.env);
    for (const a of accounts) {
      out(a.valid
        ? `${a.name}: $${a.starting_balance} start, $${a.profit_target} target, $${a.max_loss} max loss (${a.max_loss_mode}), daily limit $${a.daily_loss_limit || 0}, ${a.sessions} sessions\n`
        : `${a.name}: INVALID (${a.errors[0]})\n`);
    }
    return 0;
  }
  if (cmd === 'start') {
    const name = arg(argv, '--account');
    if (!name) throw new Error('usage: combine.js start --account <name>');
    const account = accountNamed(ROOT, name, process.env);
    const had = prop.readAttempt(home, account.name);
    if (had && !argv.includes('--force')) {
      throw new Error(`a ${account.name} attempt is already running (started ${had.startedAt}, ${had.days.length} closes recorded); --force restarts it from $${account.starting_balance}`);
    }
    if (had) prop.endAttempt(home, account.name, now);
    prop.startAttempt(home, account, now);
    out(`${had ? 'restarted' : 'started'} a ${account.name} attempt: $${account.profit_target} target, $${account.max_loss} max loss, ${account.sessions} sessions. The runner snapshots the balance each bar.\n`);
    return 0;
  }
  if (cmd === 'status') {
    const r = status({ account: arg(argv, '--account'), json: argv.includes('--json') }, { env: process.env, now: () => now, root: ROOT });
    out(r.text);
    return 0;
  }
  if (cmd === 'record-day') {
    const account = accountNamed(ROOT, arg(argv, '--account'), process.env);
    const day = arg(argv, '--day');
    const balance = Number(arg(argv, '--balance'));
    if (!prop.readAttempt(home, account.name)) throw new Error(`no ${account.name} attempt is running`);
    prop.recordEndOfDay(home, account, balance, day);
    out(`${account.name}: close of ${day} recorded at $${balance}\n`);
    return 0;
  }
  if (cmd === 'stop') {
    const name = arg(argv, '--account');
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(String(name || ''))) throw new Error('usage: combine.js stop --account <name> (an account profile name)');
    const dest = prop.endAttempt(home, name, now);
    out(dest ? `${name}: attempt ended (kept as ${dest})\n` : `${name}: no attempt is running\n`);
    return 0;
  }
  throw new Error('usage: combine.js start --account <name> [--force] | status [--account <name>] [--json] | record-day --account <name> --day YYYY-MM-DD --balance <dollars> | stop --account <name> | accounts');
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[combine] ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
