#!/usr/bin/env node
/**
 * Prop-challenge attempts (accounts/<name>/ACCOUNT.md):
 *
 *   node scripts/combine.js start  --account topstep_100k [--force]  # start an attempt (--force restarts one)
 *   node scripts/combine.js status [--account <name>] [--json]
 *   node scripts/combine.js record-day --account <name> --day YYYY-MM-DD --balance <dollars>
 *                                                           # a close the runner missed
 *   node scripts/combine.js stop   --account <name>         # end the attempt (kept, renamed)
 *   node scripts/combine.js accounts                        # the account profiles
 *
 * The runner snapshots the balance every bar and records each day's close;
 * the order gate refuses entries for an account's strategies without a
 * started attempt and a fresh snapshot.
 */

'use strict';

const path = require('path');
const { loadAccounts, accountNamed } = require('./lib/trading/accounts');
const prop = require('./lib/trading/prop-state');
const combine = require('./lib/trading/combine');
const { harnessHome } = require('./lib/paths');
const { loadStrategies } = require('./lib/trading/strategies');

const ROOT = path.resolve(__dirname, '..');

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** The policy strategies' latest verdicts that haven't expired: what an entry may be. */
function liveVerdicts(home, now) {
  const latest = new Map();
  for (const v of prop.readVerdicts(home)) latest.set(`${v.strategy}`, v);
  return [...latest.values()].filter(v => Date.parse(v.expiresAt) > now.getTime());
}

/**
 * An attempt's state. The size budget is each policy strategy's own (its
 * `sizing`), as the gate and the verdicts compute it; with no policy strategy
 * on the account, the default sizing's, labelled so.
 */
function statusOf(home, account, now, strategies = []) {
  const r = prop.readAttempt(home, account.name);
  if (!r) return { account: account.name, started: false };
  const s = r.snapshot;
  const cs = prop.stateFrom(account, r, s ? s.balance : NaN);
  const policies = strategies.filter(x => x.valid && x.signal === 'policy' && x.account === account.name && x.status !== 'disabled');
  const budgets = policies.length
    ? policies.map(x => ({ strategy: x.name, budgetUsd: combine.budget(cs, x.sizing || {}) }))
    : [{ strategy: null, budgetUsd: combine.budget(cs) }];
  return {
    account: account.name, started: true, startedAt: r.startedAt, days: r.days.length, ...combine.summary(cs),
    budgets, budgetUsd: budgets[0].budgetUsd, snapshotAt: s ? s.at : null, entryBlock: prop.combineBlock(home, account.name, now),
  };
}

const budgetText = r => r.budgets.map(b => (b.strategy ? `${b.strategy} size budget $${b.budgetUsd}` : `size budget $${b.budgetUsd} (default sizing; no policy strategy trades this account)`)).join('; ');

function main(argv, out = s => process.stdout.write(s)) {
  const cmd = argv[0];
  const home = harnessHome();
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
    if (had) prop.endAttempt(home, account.name);
    prop.startAttempt(home, account);
    out(`${had ? 'restarted' : 'started'} a ${account.name} attempt: $${account.profit_target} target, $${account.max_loss} max loss, ${account.sessions} sessions. The runner snapshots the balance each bar.\n`);
    return 0;
  }
  if (cmd === 'status') {
    const name = arg(argv, '--account');
    const accounts = name ? [accountNamed(ROOT, name, process.env)] : loadAccounts(ROOT, process.env).accounts.filter(a => a.valid);
    const { strategies } = loadStrategies(ROOT, process.env);
    const rows = accounts.map(a => statusOf(home, a, new Date(), strategies)).filter(r => name || r.started);
    const verdicts = liveVerdicts(home, new Date());
    if (argv.includes('--json')) out(`${JSON.stringify({ attempts: rows, verdicts }, null, 2)}\n`);
    else if (!rows.length) out('no attempt is started (node scripts/combine.js start --account <name>)\n');
    else {
      for (const r of rows) {
        out(!r.started ? `${r.account}: no attempt started\n`
          : `${r.account}: ${r.status}, balance $${r.balance} (floor $${r.floor}, cushion $${r.cushion}), profit $${r.profit} of $${r.target}, `
            + `day $${r.dayPnl}, ${r.sessionsDone} sessions done, ${r.sessionsLeft} left; ${budgetText(r)}; `
            + `${r.entryBlock ? `entries blocked: ${r.entryBlock}` : 'entries allowed'}\n`);
      }
      for (const v of verdicts) {
        out(v.action === 'skip'
          ? `${v.strategy}: ${v.direction} setup from ${v.component} skipped (${v.reason || 'the policy'}), until ${v.expiresAt}\n`
          : `${v.strategy}: ${v.direction} setup from ${v.component}: ${v.action}, at most ${v.maxSize} ${v.contract} with a ${v.stopTicks}-tick stop `
            + `(stopLossBracket.ticks ${v.stopTicks}, rationale "setup:${v.strategy} ..."), until ${v.expiresAt}\n`);
      }
    }
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
    const dest = prop.endAttempt(home, name);
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
