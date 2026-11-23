#!/usr/bin/env node
'use strict';

/**
 * The pooled combine score of many replay runs (lib/prop/pooled-score.js): each run's trades, sides, gross R and dollars,
 * then every run's trades pooled into one stream in date order through the 30-day Monte Carlo combine, labelled
 * `diagnostic (picked days)` (never a promotion score), with no pass rate below the score's minimum of independent
 * attempts. Two or more groups are scored each on their own and printed side by side. Reads the runs only.
 *
 *   node scripts/pooled-score.js <run home> [<run home> ...] [--account <name>] [--bars SYM=file ...]
 *   node scripts/pooled-score.js --group G=<home> [<home> ...] --group N=<home> [<home> ...] [--account <name>]
 *
 * A run home is the replay's FTH_HOME (its run in <home>/replay/<runId>); a run's folder works too. The account: the one
 * the runs name (runs naming two never pool); --account names it only for runs that name none; the sizing: the policy's.
 */

const path = require('path');
const P = require('./lib/prop/pooled-score');

const ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: pooled-score.js <run home> [<run home> ...] | --group NAME=<home> [<home> ...] [--group NAME=<home> ...] [--account <name>] [--bars SYM=file ...]';

function parse(argv) {
  const o = { groups: [], account: null, barsFiles: {} };
  const loose = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => { const v = argv[i += 1]; if (v === undefined) throw new Error(`${a}: give its value (${USAGE})`); return v; };
    if (a === '--group') {
      const m = /^([^=\s]+)=(.+)$/.exec(val());
      if (!m) throw new Error(`--group NAME=<home> [<home> ...] (${USAGE})`);
      if (o.groups.some(g => g.name === m[1])) throw new Error(`group ${m[1]} given twice`);
      o.groups.push({ name: m[1], homes: [m[2]] });
    } else if (a === '--account') o.account = val();
    else if (a === '--bars') {
      const m = /^([A-Z0-9]+)=(.+)$/.exec(val());
      if (!m) throw new Error('--bars: SYMBOL=file');
      o.barsFiles[m[1]] = m[2];
    } else if (a.startsWith('--')) throw new Error(`unknown argument ${a} (${USAGE})`);
    else if (o.groups.length) o.groups[o.groups.length - 1].homes.push(a);
    else loose.push(a);
  }
  if (loose.length && o.groups.length) throw new Error(`homes before the first --group: put every home in a group (${USAGE})`);
  if (loose.length) o.groups.push({ name: 'all', homes: loose });
  if (!o.groups.length) throw new Error(USAGE);
  return o;
}

function main(argv, { env = process.env } = {}) {
  const o = parse(argv);
  const { loadAccounts, accountNamed } = require('./lib/trading/accounts');
  const { loadStrategies } = require('./lib/trading/strategies');
  const { runningAttempts } = require('./lib/trading/prop-state');
  const { resolveAccount, policyFor, liveSizing } = require('./lib/prop/model-score');
  const fs = require('fs');
  const read = o.groups.map(g => ({ name: g.name, entries: g.homes.map(h => P.readGroupRun(h, { root: ROOT, barsFiles: o.barsFiles })) }));
  const all = read.flatMap(g => g.entries);
  const { strategies } = loadStrategies(ROOT, env);
  const accounts = loadAccounts(ROOT, env).accounts;
  const runnerOf = e => { try { return JSON.parse(fs.readFileSync(path.join(e.dir, 'autotrader.json'), 'utf8')) || {}; } catch (_err) { return {}; } };
  // Each run's own account (its attempt, its runner config); --account only names it for runs that name none.
  const own = all.map(e => resolveAccount({ attempts: runningAttempts(e.home), runnerAccount: runnerOf(e).account, strategies: [], accounts }));
  const name = P.agreeAccount(own, { override: o.account, fallback: resolveAccount({ strategies, accounts }) });
  const account = accountNamed(ROOT, name, env);
  const policy = policyFor(strategies, account.name);
  // The live entry's limits and contract (model-score.js liveSizing), one for every run: else the arms aren't sized alike.
  const sized = [...new Set(all.map(e => JSON.stringify(liveSizing({ policy, strategies, home: e.home, runner: runnerOf(e), env }))))];
  if (sized.length !== 1) throw new Error(`the runs were sized differently (${sized.join(' vs ')}): pool runs of one setup`);
  const live = JSON.parse(sized[0]);
  const groups = read.map(g => P.scoreGroup(g.name, g.entries, { account, policy, limits: live.limits, contracts: live.contracts, env }));
  return P.pooledText(groups, { account: account.name, sizingFrom: `${policy ? policy.name : 'no policy'}'s rulebook`, sessions: account.sessions });
}

if (require.main === module) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
}

module.exports = { main, parse };
