'use strict';

/**
 * Account states for practice: the states a curated practice window could start from, drawn from the Monte Carlo's own
 * attempt paths (prop/attempts.js runAttempt, `onDay`: the account as each day opened, on the resampled paths of the
 * model's trade stream, as prop/evaluator.js draws them), bucketed by prop/risk-attribution.js stateOf (fresh, mid,
 * near-target, near-mll), seeded, and hashed so a run can pin the draw.
 *
 * Each state: { bucket, day (the session of the attempt it opens), sessionsDone, balance, floor, peak, eodHigh,
 * roomToMll (the cushion), roomToTarget (the profit still needed), days (each closed day's P&L), facts (the attempt
 * line's facts at that open, combine.attemptFacts) }, and `record`: the prop-state attempt record that would start
 * an attempt there (its days' closing balances), which stateFrom reads back to the same balance, floor and day.
 *
 * Not wired into a replay: the model sees the account through the broker's balance (prop-state stateFrom reads the
 * balance the broker reports), and a replay broker starts at the account's starting balance; showing a drawn state
 * needs the replay broker to start at that balance (a broker setting) and the run to seed its attempt record from
 * `record` (replay/driver.js), a design change for the owner (the PR says so).
 *
 *   sampleAccountStates(stream, { account, sizing, contracts, seed, paths, perBucket, meanBlock })
 *       { states, counts, hash, seed, account }
 */

const crypto = require('crypto');
const combine = require('../trading/combine');
const at = require('./attempts');
const stats = require('./stats');
const { STATES, stateOf } = require('./risk-attribution');

const r2 = x => Math.round(x * 100) / 100;

function stateRecord(cs, account, days) {
  let bal = account.starting_balance;
  return {
    account: account.name, startDay: null,
    days: cs.days.map((pnl, k) => { bal = r2(bal + pnl); return { day: days[k] || `S${k + 1}`, balance: bal, pnl }; }),
    peak: cs.peak, snapshot: null,
  };
}

function sampleAccountStates(stream, { account, sizing = {}, contracts = 'auto', seed = 1, paths = 500, perBucket = 5, meanBlock = 7 } = {}) {
  if (!account || !Number.isInteger(account.sessions)) throw new Error('account: an account profile with sessions');
  if (!Number.isInteger(seed)) throw new Error('seed: a whole number');
  if (!(Number.isInteger(perBucket) && perBucket >= 1)) throw new Error('perBucket: 1 or more');
  const days = stream.days;
  if (!days.length) throw new Error('the stream has no days to draw attempt paths from');
  const legs = new Map();
  const ctx = {
    account, sizing: { ...combine.DEFAULT_SIZING, ...sizing }, mode: contracts, gate: at.gateLimits(),
    legsOf: t => { if (!legs.has(t.symbol)) legs.set(t.symbol, at.legsFor(account, t.symbol, { tickValue: t.tickValue, ...(Number.isFinite(t.feesPerSide) ? { feesPerSide: t.feesPerSide } : {}) })); return legs.get(t.symbol); },
  };
  const regimes = days.map(d => d.regime || 'normal');
  const byRegime = stats.groupBy(regimes);
  const prand = stats.streamFor(seed, 'account-states:paths');
  const pool = Object.fromEntries(STATES.map(s => [s, []]));
  for (let p = 0; p < paths; p += 1) {
    const list = stats.stationaryPath(days.length, account.sessions, { meanBlock, rand: prand, regimes, byRegime }).map(k => days[k]);
    at.runAttempt(list, {
      ...ctx,
      onDay: (cs, d) => {
        if (cs.status !== 'active') return;
        pool[stateOf(cs)].push({
          bucket: stateOf(cs), day: d + 1, sessionsDone: cs.days.length, balance: r2(cs.balance), floor: r2(cs.floor), peak: r2(cs.peak), eodHigh: r2(cs.eodHigh),
          roomToMll: r2(combine.cushion(cs)), roomToTarget: r2(Math.max(0, combine.profitNeeded(cs) - combine.profit(cs))), days: [...cs.days],
          facts: combine.attemptFacts(cs, { tradesToday: 0, lossesToday: 0 }), record: stateRecord(cs, account, list.map(x => x.day)),
        });
      },
    });
  }
  const pick = stats.streamFor(seed, 'account-states:pick');
  const states = [];
  for (const b of STATES) {
    const xs = pool[b];
    for (let k = 0; k < perBucket && xs.length; k += 1) states.push(xs[stats.pick(pick, xs.length)]);
  }
  const counts = Object.fromEntries(STATES.map(s => [s, pool[s].length]));
  const hash = crypto.createHash('sha256').update(JSON.stringify({ account: account.name, seed, paths, perBucket, states })).digest('hex');
  return { states, counts, hash, seed, account: account.name };
}

module.exports = { sampleAccountStates };
