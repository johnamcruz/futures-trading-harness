'use strict';

/**
 * The training loop's day attempts (the owner, 2026-10-24: "We should using translation on ppc as well as live"): every
 * session day of a loop run trades inside a combine attempt of the account the active policy strategy trades, started
 * fresh at the profile's starting balance before the day's first step. So a composed entry is sized by the live path of
 * a running attempt (prop/size-translate.js: the rulebook's verdict, the size budget, the cap, the floor and the floor
 * stretch; order_plan, phase 2's request, compose_check's no-size-fits and the gate's checks), and no day's trades (a
 * loss, a blow) reach another day: the champion and every edit size the same window from the same state. The day's own
 * trades update its attempt as live (the runner's snapshots and its end of day), so the daily loss limit, the soft stop
 * and the floor stretch's "no loss today" work as live.
 *
 * Config (the replay config's `dayAttempts`, replay/config.js): { account: <profile> }, the account the active policy
 * strategy trades (the runner keeps that account's attempt record only). Set by the training loop's code for its runs
 * (train/loop.js windowRun), never by a replay config of its own: the training preflight's day-attempts check refuses it
 * on any other learning run and requires it on every loop run. Part of both run hashes.
 *
 * In the driver (replay/driver.js), before a day's first step (a managing step aside), once per day (a resume included):
 *   - a position or working order still open (from an earlier day's window): the day goes on from the attempt it has
 *     (carried, as live); refused without one;
 *   - flat: the earlier day's record ended (prop-state endAttempt: kept, renamed), the replay broker's balance set to the
 *     profile's starting balance through the balance schedule (today's P&L 0), a fresh attempt record started at the
 *     step's time (prop-state startAttempt, as `scripts/combine.js start` starts one live: no history scope, so the
 *     prompt's history is what it was), and the broker's balance checked to be the starting balance (else refused: a
 *     broker that doesn't apply the schedule never trades a day on the wrong account).
 * Each start and each carried day is a line of the run's day-attempts.jsonl (never shown to the model).
 *
 *   LOG                                          the log's file name in the run's folder
 *   validateDayAttempts(raw)                     { dayAttempts: { account } | null, errors }
 *   startDay(run, point, ranAt, env, deps, { root, log })   'start' | 'carried' | null (the day already has one)
 *   readLog(runDir)                              the log's lines
 */

const fs = require('fs');
const path = require('path');

const LOG = 'day-attempts.jsonl';
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function validateDayAttempts(raw) {
  if (raw === undefined) return { dayAttempts: null, errors: [] };
  if (!(raw && typeof raw === 'object' && !Array.isArray(raw))) return { dayAttempts: null, errors: ['dayAttempts: { "account": "<profile>" } (set by the training loop for its runs)'] };
  const errors = Object.keys(raw).filter(k => k !== 'account').map(k => `dayAttempts.${k}: unknown (account)`);
  if (!(typeof raw.account === 'string' && NAME.test(raw.account))) errors.push('dayAttempts.account: an account profile name (accounts/<name>/ACCOUNT.md)');
  return errors.length ? { dayAttempts: null, errors } : { dayAttempts: { account: raw.account }, errors };
}

function readLog(runDir) {
  try {
    return fs.readFileSync(path.join(runDir, LOG), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (_err) {
    return [];
  }
}

const refused = msg => new Error(`replay refused: ${msg}`);
const firstLine = err => String((err && err.message) || err).split('\n')[0];

async function startDay(run, point, ranAt, env, deps, { root, log = () => {} } = {}) {
  const { readJson, writeJsonAtomic } = require('../harness-run');
  const ps = require('../trading/prop-state');
  const { runDir, runHome, balanceSchedule } = run.paths;
  if (readLog(runDir).some(x => x.day === point.day)) return null;
  if (!run.cfg.account) throw refused('a run with day attempts needs the replay broker\'s account (the runner config\'s account)');
  const account = require('../trading/accounts').accountNamed(root || run.root, run.dayAttempts.account, env);
  const at = ranAt.toISOString();
  const append = line => fs.appendFileSync(path.join(runDir, LOG), `${JSON.stringify(line)}\n`);
  // A broker error is not "open": the day can't be started or carried on a guess (fail closed).
  const open = await Promise.resolve().then(() => deps.open(env, run.cfg.account)).then(Boolean, err => {
    throw refused(`can't read the account to start the day's attempt (${firstLine(err)})`);
  });
  if (open) {
    if (!ps.readAttempt(runHome, account.name)) throw refused(`${point.day} opens with a position or working order but the run has no attempt to carry`);
    append({ kind: 'carried', day: point.day, at });
    log(`${point.day}: a position or working order is still open; the day goes on from the attempt it has`);
    return 'carried';
  }
  const schedule = readJson(balanceSchedule, []) || [];
  if (!schedule.some(e => e.day === point.day)) {
    schedule.push({ at, day: point.day, balance: account.starting_balance, dayPnl: 0 });
    writeJsonAtomic(balanceSchedule, schedule);
  }
  // An earlier day's record is ended (kept); one started today (a start cut short before its log line) is started again.
  const prior = ps.readAttempt(runHome, account.name);
  if (prior && prior.startDay !== point.day) ps.endAttempt(runHome, account.name, ranAt);
  ps.startAttempt(runHome, account, ranAt);
  const balance = await Promise.resolve().then(() => deps.balance(env, run.cfg.account)).then(Number, err => {
    throw refused(`can't read the account's balance for the day's attempt (${firstLine(err)})`);
  });
  // To the cent, as a broker reports a balance.
  if (!(Number.isFinite(balance) && Math.round(balance * 100) === Math.round(account.starting_balance * 100))) {
    throw refused(`the replay broker reports a balance of ${balance}, not ${account.name}'s starting ${account.starting_balance}: it doesn't apply the balance schedule (${run.brokerEnv.balanceSchedule || 'brokerEnv.balanceSchedule'})`);
  }
  append({ kind: 'start', day: point.day, at, account: account.name, balance });
  log(`${point.day}: a fresh ${account.name} attempt at its starting balance`);
  return 'start';
}

module.exports = { LOG, validateDayAttempts, startDay, readLog };
