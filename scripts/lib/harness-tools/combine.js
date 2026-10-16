'use strict';

/**
 * The prop-challenge status operation (scripts/combine.js status): each started
 * attempt's balance, floor, cushion, progress, size budget and whether entries
 * are allowed, and the policy strategies' live verdicts.
 *
 *   status { account, json }   account: one profile (default: every started attempt)
 *
 * Only status is an agent operation. Starting, stopping, and recording a day's
 * close change the attempt the gate trades under: they are the user's, and stay
 * in scripts/combine.js.
 */

const { loadAccounts, accountNamed } = require('../trading/accounts');
const prop = require('../trading/prop-state');
const combine = require('../trading/combine');
const { harnessHome } = require('../paths');
const { loadStrategies } = require('../trading/strategies');
const { context, say } = require('./cli');

/** The policy strategies' latest verdicts that haven't expired: what an entry may be. */
function liveVerdicts(home, now) {
  const latest = new Map();
  for (const v of prop.readVerdicts(home)) latest.set(`${v.strategy}`, v);
  return [...latest.values()].filter(v => Date.parse(v.expiresAt) > now.getTime());
}

/**
 * An attempt's state. The size budget is each policy strategy's own (its
 * `sizing`, its account's rulebook entry), as the gate and the verdicts compute it; with no policy strategy
 * on the account, none (budgetUsd null): sizing lives only in a policy's rulebook entry, never a code default.
 */
function statusOf(home, account, now, strategies = []) {
  const r = prop.readAttempt(home, account.name);
  if (!r) return { account: account.name, started: false };
  const s = r.snapshot;
  const cs = prop.stateFrom(account, r, s ? s.balance : NaN);
  const policies = strategies.filter(x => x.valid && x.signal === 'policy' && x.account === account.name && x.status !== 'disabled');
  const budgets = policies.length
    ? policies.map(x => ({ strategy: x.name, budgetUsd: combine.budget(cs, x.sizing || {}) }))
    : [{ strategy: null, budgetUsd: null }];
  return {
    account: account.name, started: true, startedAt: r.startedAt, days: r.days.length, ...combine.summary(cs),
    budgets, budgetUsd: budgets[0].budgetUsd, snapshotAt: s ? s.at : null, entryBlock: prop.combineBlock(home, account.name, now),
  };
}

const budgetText = r => r.budgets.map(b => (b.strategy ? `${b.strategy} size budget $${b.budgetUsd}` : 'no size budget (no policy strategy trades this account; sizing lives only in a policy\'s rulebook entry)')).join('; ');

function status({ account: name, json = false } = {}, ctx) {
  const c = context(ctx);
  const home = harnessHome(c.env);
  const now = c.now(); // the harness clock: a replay broker's replayed time, else the wall clock
  // An account name that isn't a profile (a run id, a broker account) reads every started attempt, and says so.
  let known = name;
  let note = '';
  if (name) {
    try { accountNamed(c.root, name, c.env); } catch (_err) { known = null; note = `no account profile named ${name}: every started attempt\n`; }
  }
  const accounts = known ? [accountNamed(c.root, known, c.env)] : loadAccounts(c.root, c.env).accounts.filter(a => a.valid);
  const { strategies } = loadStrategies(c.root, c.env);
  const rows = accounts.map(a => statusOf(home, a, now, strategies)).filter(r => known || r.started);
  const verdicts = liveVerdicts(home, now);
  if (json) return { text: `${JSON.stringify({ attempts: rows, verdicts, ...(note ? { note: note.trim() } : {}) }, null, 2)}\n` };
  // To the agent, with no attempt running: what that blocks and what it doesn't (a model read "no attempt" as "no
  // entries" and passed every setup): a composed entry trades under its own strategy's cap; a policy sizes none.
  const noneNote = say(c, '', NO_ATTEMPT_ENTRIES);
  if (!rows.length) return { text: note + say(c, 'no attempt is started (node scripts/combine.js start --account <name>)\n', 'no attempt is started (starting one is the user\'s: combine.js start --account <name>)\n') + noneNote };
  let text = note;
  for (const r of rows) {
    text += !r.started ? `${r.account}: no attempt started\n`
      : `${r.account}: ${r.status}, balance $${r.balance} (floor $${r.floor}, cushion $${r.cushion}), profit $${r.profit} of $${r.target}, `
        + `day $${r.dayPnl}, ${r.sessionsDone} sessions done, ${r.sessionsLeft} left; ${budgetText(r)}; `
        + `${r.entryBlock ? `entries blocked: ${r.entryBlock}` : 'entries allowed'}\n`;
  }
  if (!rows.some(r => r.started)) text += noneNote;
  for (const v of verdicts) {
    text += v.action === 'skip'
      ? `${v.strategy}: ${v.direction} setup from ${v.component} skipped (${v.reason || 'the policy'}), until ${v.expiresAt}\n`
      : `${v.strategy}: ${v.direction} setup from ${v.component}: ${v.action}, at most ${v.maxSize} ${v.contract} with a ${v.stopTicks}-tick stop `
        + `(stopLossBracket {ticks: ${v.stopTicks}, type: "stop"}, rationale "setup:${v.strategy} ..."), until ${v.expiresAt}\n`;
  }
  return { text };
}

/** What no running attempt means for entries, as the agent reads it (combine_status with none running). */
const NO_ATTEMPT_ENTRIES = 'entries: not blocked by this; a composed entry trades under its own strategy\'s cap; a policy strategy sizes entries only in an attempt\n';

const OPS = { status };

module.exports = { OPS, liveVerdicts, statusOf, status, NO_ATTEMPT_ENTRIES };
