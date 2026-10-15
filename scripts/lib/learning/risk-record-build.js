'use strict';

/**
 * Building the model's risk record (learning/risk-record-index.js) from finished practice-train replay runs
 * (scripts/risk-record.js build). For each day a run's model took a risk action (a pass on a valid setup, a stop for the
 * day, a size under the ceiling, an early exit), prop/risk-actions.js scoreRiskActions reverts that day's actions only,
 * over Monte Carlo paths drawn from the run's days up to and including that day: so a day's entry holds what that
 * day's own decisions changed, and nothing from the days after it (the index shows it only to bars after its day:
 * walk-forward twice). riskDayEntry turns each result into the day's entry; buildRiskIndex fingerprints the whole,
 * with the runs, the account and the Monte Carlo settings it was built from in the hash.
 *
 * Refused: a run that isn't finished, isn't a learning run, or isn't practice-train (a held-out run's outcomes are
 * judged, never shown); a setup-focused or curated run (its setups at practice density: full-day runs only); a run with
 * an entry it couldn't settle; a day two runs both hold.
 *
 *   dayStream(stream, day)                       the stream through `day`, only `day`'s risk actions kept
 *   actedDays(stream)                            the days with a risk action, in order
 *   runRiskEntries(runDir, opts)                 { run, entries }: one run's per-day entries
 *   buildFromRuns(runDirs, opts)                 the index document (buildRiskIndex), its sources in the hash
 *     opts: { root, env, account (profile), policy (its sizing, contracts; or null), seed, paths, reps, minN, barsFiles,
 *             now, readRun (tests: runDir -> { stream, run, finished }) }
 */

const fs = require('fs');
const path = require('path');
const { riskDayEntry, buildRiskIndex } = require('./risk-record-index');

const { MC_SIZE } = require('../prop/mc-size');
// The Monte Carlo's one default size (prop/mc-size.js).
const PATHS = MC_SIZE.paths;
const REPS = MC_SIZE.reps;

const acted = d => (d.passed || []).length > 0 || d.trades.some(t => (t.actions || []).length > 0);

function actedDays(stream) {
  return stream.days.filter(acted).map(d => d.day);
}

/** The stream through `day`, every other day's risk actions dropped (its trades as traded, its passes gone). */
function dayStream(stream, day) {
  const days = stream.days.filter(d => d.day <= day).map(d => (d.day === day ? d : { ...d, passed: [], trades: d.trades.map(t => ({ ...t, actions: [] })) }));
  return { ...stream, days, trades: days.flatMap(d => d.trades) };
}

/** A run dir: the one given (it holds manifest.json), or the one run under a run home's replay/ (as ab-compare's). */
function runDirOf(p) {
  const abs = path.resolve(p);
  if (fs.existsSync(path.join(abs, 'manifest.json'))) return abs;
  let names = [];
  try { names = fs.readdirSync(path.join(abs, 'replay')).filter(n => fs.existsSync(path.join(abs, 'replay', n, 'manifest.json'))); } catch (_err) { /* none */ }
  if (names.length !== 1) throw new Error(`${p}: ${names.length ? `holds ${names.length} runs; give the run dir` : 'not a replay run home or run dir (no manifest.json)'}`);
  return path.join(abs, 'replay', names[0]);
}

function defaultReadRun(runDir, { root, barsFiles }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  const { stream, run } = require('../prop/model-stream').readModelStream(runDir, { root, barsFiles });
  const curated = Boolean(require('./curated-lists').loadPinnedCurated(run.home || path.resolve(runDir, '..', '..')));
  return { stream, run: { ...run, curated }, finished: manifest.finished === true };
}

function runRiskEntries(runDir, { root = null, env = process.env, account, policy = null, seed = 1, paths = PATHS, reps = REPS, barsFiles = {}, now = new Date(), readRun = null } = {}) {
  if (!account) throw new Error('an account profile to score against (--account)');
  const dir = readRun ? runDir : runDirOf(runDir);
  const { stream, run, finished } = (readRun || (d => defaultReadRun(d, { root, barsFiles })))(dir);
  const id = run.runId || dir;
  if (!finished) throw new Error(`run ${id} is not finished: build from finished runs`);
  if (run.learning !== true || run.role !== 'practice-train') throw new Error(`run ${id} is ${run.learning === true ? run.role || 'no role' : 'not a learning run'}, not practice-train: the risk record is built from practice-train runs only (a held-out run's outcomes are judged, never shown)`);
  // Full-day runs only: a setup-focused or curated run's days hold its setups at their practice density (and a curated
  // list's are outcome-balanced), so the paths its counterfactuals run on would not be the market's days. Its days are
  // its own, so they can't be reweighted here either (scoreArms needs the run's real days).
  if (run.practice || run.curated) throw new Error(`run ${id} is a ${run.curated ? 'curated' : 'setup-focused'} practice run: its risk actions come at practice density, not a live day's; the risk record is built from full-day practice-train runs only`);
  const diagnostic = null;
  if (stream.excluded.length) throw new Error(`run ${id}: ${stream.excluded.length} entr${stream.excluded.length === 1 ? 'y' : 'ies'} without a settled outcome: a full-day run's record never leaves one out`);
  const { checkModelWindow } = require('../prop/evaluator');
  const { scoreRiskActions } = require('../prop/risk-actions');
  const { gateLimits } = require('../prop/attempts');
  const entries = actedDays(stream).map(day => {
    const result = scoreRiskActions(dayStream(stream, day), {
      pass: checkModelWindow({ run, diagnostic, now }), account, rulebook: { sizing: policy ? policy.sizing || null : null },
      contracts: (policy && policy.contracts) || 'auto', gate: gateLimits(env), seed, paths, reps,
    });
    return riskDayEntry(day, result, { role: run.role });
  });
  return { run: { runId: id, from: run.from, to: run.to, days: stream.days.length, acted: entries.length }, entries };
}

function buildFromRuns(runDirs, opts = {}) {
  if (!Array.isArray(runDirs) || !runDirs.length) throw new Error('one or more finished practice-train runs');
  const { seed = 1, paths = PATHS, reps = REPS, account, policy = null, minN, now = new Date() } = opts;
  if (!(Number.isInteger(paths) && paths >= 1) || !(Number.isInteger(reps) && reps >= 1) || !Number.isInteger(seed)) throw new Error('seed: a whole number; paths and reps: whole numbers from 1');
  const runs = [];
  const entries = [];
  for (const d of runDirs) {
    const r = runRiskEntries(d, { ...opts, seed, paths, reps });
    runs.push(r.run);
    entries.push(...r.entries);
  }
  const sources = { runs, account: account.name || null, policy: policy ? policy.name || null : null, seed, paths, reps };
  return buildRiskIndex(entries, { ...(minN === undefined ? {} : { minN }), now, sources });
}

module.exports = { PATHS, REPS, actedDays, dayStream, runRiskEntries, buildFromRuns };
