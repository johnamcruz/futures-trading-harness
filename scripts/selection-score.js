#!/usr/bin/env node
'use strict';

/**
 * P1: the SELECTION scorecard of replay runs (lib/replay/selection-score.js pickTable, primary: every candidate by the
 * model's decision, took / waited / passed, on one ruler, the shipped trail's R and points, with by-session intervals),
 * then the first-pullback legs table (secondary). After the run only; never shown to the model.
 *
 *   node scripts/selection-score.js <run home> [<run home> ...] [--min-leg-r 2] [--minutes 3] [--session <spec>] [--symbol MNQ]
 *
 * A run home is the replay's FTH_HOME (<workDir>/<runId>); its replay folder is <home>/replay/<runId> (the served bars).
 * Prints one JSON document: each run's scorecard, and with two runs or more, each run paired against the first (the same
 * days: the legs are each run's own served bars). Every run is scored on one reference 1R (--ref-risk-pts, else the
 * median of the runs' own: an arm's wider stops must not shrink its legs).
 */

const path = require('path');
const FP = require('./lib/replay/selection-score');
const RUN = require('./lib/replay/selection-run');

const USAGE = 'usage: selection-score.js <run home> [<run home> ...] [--min-leg-r 2] [--ref-risk-pts <points>] [--minutes 3] [--session 09:30-12:00@America/New_York] [--symbol MNQ]';

function parse(argv) {
  // The defaults are config's: config/replay.json selection.minLegR, the runner's bar timeframe, the curation session.
  const T = require('./lib/tunables');
  const o = { homes: [], refRiskPts: null, minLegR: T.replay().selection.minLegR, minutes: T.runner().bars.timeframe, session: T.replay().trendCapture.curationSessions[0], symbol: 'MNQ' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => { const v = argv[i += 1]; if (v === undefined) throw new Error(`${a}: give its value (${USAGE})`); return v; };
    if (a === '--min-leg-r') o.minLegR = Number(val());
    else if (a === '--ref-risk-pts') o.refRiskPts = Number(val());
    else if (a === '--minutes') o.minutes = Number(val());
    else if (a === '--session') o.session = val();
    else if (a === '--symbol') o.symbol = val();
    else if (a.startsWith('--')) throw new Error(`unknown argument ${a} (${USAGE})`);
    else o.homes.push(a);
  }
  if (!o.homes.length || !Number.isFinite(o.minLegR) || !(o.minutes > 0)) throw new Error(USAGE);
  return o;
}

function main(argv) {
  const o = parse(argv);
  const read = o.homes.map(home => {
    const runId = path.basename(path.resolve(home));
    return { runId, got: RUN.readRun({ home, runDir: path.join(home, 'replay', runId), session: o.session, minutes: o.minutes, symbol: o.symbol }) };
  });
  // One reference 1R for every run (a leg is a leg whatever an arm's own stops): the flag, else the median of the runs'.
  const own = read.map(r => r.got.refRiskPts).filter(x => x > 0).sort((a, b) => a - b);
  const ref = o.refRiskPts > 0 ? o.refRiskPts : own.length ? own[Math.floor((own.length - 1) / 2)] : null;
  const boot = (({ bootstrapReps, ci, seed }) => ({ reps: bootstrapReps, ci, seed }))(require('./lib/tunables').replay().selection);
  const runs = read.map(({ runId, got }) => {
    const selection = FP.pickTable(got.rows || [], boot);
    return !ref ? { runId, selection, error: 'no reference 1R for the legs table (no MTF entry and no candidate line with its stop points; give --ref-risk-pts)' }
      : { runId, selection, refRiskPts: ref, ownRefRiskPts: got.refRiskPts, ...FP.score({ ...got, refRiskPts: ref, minLegR: o.minLegR }) };
  });
  const ok = runs.filter(r => !r.error);
  const pairs = ok.slice(1).map(r => ({ a: ok[0].runId, b: r.runId, ...FP.paired(ok[0], r) }));
  return { minLegR: o.minLegR, refRiskPts: ref, runs, pairs };
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
