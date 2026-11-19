#!/usr/bin/env node
'use strict';

/**
 * P1: the SELECTION scorecard of replay runs (lib/replay/selection-score.js pickTable: every MTF candidate by the
 * model's decision, took / enter-no-order / waited / passed / unlabelled, on one ruler, the shipped trail's R and points
 * from the printed structural stop, with by-session intervals). After the run only; never shown to the model.
 *
 *   node scripts/selection-score.js <run home> [<run home> ...] [--minutes 3] [--symbol MNQ]
 *
 * A run home is the replay's FTH_HOME (<workDir>/<runId>); its replay folder is <home>/replay/<runId> (the served bars).
 * Prints one JSON document: each run's table, its order counts (read, joined, orphaned; atCap: the gateway's order file
 * at its retention cap, so earlier takes may be missing) and its rows.
 */

const path = require('path');
const FP = require('./lib/replay/selection-score');
const RUN = require('./lib/replay/selection-run');

const USAGE = 'usage: selection-score.js <run home> [<run home> ...] [--minutes 3] [--symbol MNQ]';

function parse(argv) {
  // The defaults are config's: the runner's bar timeframe.
  const o = { homes: [], minutes: require('./lib/tunables').runner().bars.timeframe, symbol: 'MNQ' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => { const v = argv[i += 1]; if (v === undefined) throw new Error(`${a}: give its value (${USAGE})`); return v; };
    if (a === '--minutes') o.minutes = Number(val());
    else if (a === '--symbol') o.symbol = val();
    else if (a.startsWith('--')) throw new Error(`unknown argument ${a} (${USAGE})`);
    else o.homes.push(a);
  }
  if (!o.homes.length || !(o.minutes > 0)) throw new Error(USAGE);
  return o;
}

function main(argv) {
  const o = parse(argv);
  const boot = (({ bootstrapReps, ci, seed, intervalMinRows, intervalMinSessions }) => ({ reps: bootstrapReps, ci, seed, minRows: intervalMinRows, minSessions: intervalMinSessions }))(require('./lib/tunables').replay().selection);
  const runs = o.homes.map(home => {
    const runId = path.basename(path.resolve(home));
    const got = RUN.readRun({ home, runDir: path.join(home, 'replay', runId), minutes: o.minutes, symbol: o.symbol });
    // REVIEW-4 minor 3: the orders read, joined to a candidate and orphaned, and whether the order file is at its cap (the
    // gateway keeps the last runner.limits.entryOrdersKept: at the cap, earlier takes may be missing).
    const atCap = got.orderCounts.read >= require('./lib/tunables').runner().limits.entryOrdersKept;
    return { runId, selection: FP.pickTable(got.rows, boot), orders: { ...got.orderCounts, atCap }, rows: got.rows.map(r => ({ key: r.key, at: r.at, state: r.state, orders: r.orders, outcome: r.outcome, firstOutcome: r.firstOutcome })) };
  });
  return { minutes: o.minutes, runs };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 1)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
}

module.exports = { main, parse };
