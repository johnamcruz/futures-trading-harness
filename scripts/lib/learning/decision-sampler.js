'use strict';

/**
 * The decision sampler (docs/TRAINING.md, "Fine-tuning on verified decisions"): each curated practice-train moment
 * re-run K times with sampling on, so the verified-decision dataset (learning/decision-dataset.js) sees more than one
 * decision per moment. Built on the decision-point replay (train/decision-points.js): the base run (a curated
 * practice-train replay, taken with checkpoints) gives each trade time's reference state; each sample is runPoint from
 * that checkpoint, seeded (pointSeed(seed, t, k)), with the sampling settings in its environment.
 *
 * Sampling settings come from the user's local config (a JSON file, never the repository), model-neutral: temperature
 * (above 0: sampling on), and optionally top_p, top_k, min_p, repetition_penalty. Each reaches the harness process as
 * FTH_SAMPLING_<NAME> (FTH_SAMPLING_TEMPERATURE, ...), beside FTH_TRAIN_SEED, for a harness CLI or model server config
 * that reads them; nothing here names or picks a model.
 *
 * Each sample's result is recorded (samples.jsonl in the sampler's folder): the moment's time, the repeat, its seed,
 * the point run's folder, the times it ran, its error, and the sampling settings' digest, so every decision in the
 * dataset names the sample that produced it. A sample already recorded is not run again (resume).
 *
 *   SETTINGS
 *   samplingSettings(raw)                         { settings, digest, env } (throws on an invalid or greedy config)
 *   checkBaseRun(run)                             throws unless a curated practice-train run
 *   planSamples({ times, k, seed })               [{ t, repeat, seed }]
 *   runSamples({ run, checkpoints, tree, plan, outDir, sampling, baseEnv, deps })   [result], appended to samples.jsonl
 *   readSamples(file)                             the recorded results
 *   samplerDir(run)                               <workDir>/<runId>.samples (beside the run home, never inside it)
 *   runBase(run, { root, env, barsFiles, checkpoints, log })   the base run as scripts/replay.js run starts it (the
 *                                                 training preflight, the learning gate, the pins), with checkpoints
 *   sampleTimes(run, checkpoints)                 the base run's curated trade times (no management time) with a checkpoint
 *   stepDeps(run, tree)                           the driver's step deps, and whether the side's account is in a trade
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { assertUse } = require('./splits');
const D = require('../train/decision-points');

const SETTINGS = Object.freeze({
  temperature: x => typeof x === 'number' && x > 0 && x <= 2,
  top_p: x => typeof x === 'number' && x > 0 && x <= 1,
  top_k: x => Number.isInteger(x) && x >= 1,
  min_p: x => typeof x === 'number' && x >= 0 && x < 1,
  repetition_penalty: x => typeof x === 'number' && x >= 1 && x <= 2,
});
const FILE = 'samples.jsonl';

function samplingSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('sampling: a JSON object of sampling settings (temperature, top_p, top_k, min_p, repetition_penalty)');
  const bad = Object.keys(raw).filter(k => !SETTINGS[k]);
  if (bad.length) throw new Error(`sampling: unknown setting(s) ${bad.join(', ')} (model-neutral settings only: ${Object.keys(SETTINGS).join(', ')})`);
  if (raw.temperature === undefined) throw new Error('sampling: temperature (above 0): the sampler samples, it never decodes greedily');
  const wrong = Object.keys(raw).filter(k => !SETTINGS[k](raw[k]));
  if (wrong.length) throw new Error(`sampling: out of range: ${wrong.map(k => `${k} ${JSON.stringify(raw[k])}`).join(', ')}`);
  const settings = Object.fromEntries(Object.keys(raw).sort().map(k => [k, raw[k]]));
  const env = Object.fromEntries(Object.entries(settings).map(([k, v]) => [`FTH_SAMPLING_${k.toUpperCase()}`, String(v)]));
  return { settings, digest: crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 16), env };
}

function checkBaseRun(run) {
  if (!run.curated) throw new Error(`run ${run.runId}: the sampler re-runs curated moments: the base run names a curated list (curatedList)`);
  if (run.learning === false) throw new Error(`run ${run.runId} is declared not learning: no samples`);
  try {
    assertUse('practice', run.start, run.end);
  } catch (err) {
    throw new Error(`run ${run.runId}: samples come from practice-train moments only: ${err.message}`, { cause: err });
  }
}

function planSamples({ times, k, seed }) {
  if (!(Number.isInteger(k) && k >= 1)) throw new Error('k: a whole number of samples per moment, from 1');
  if (!Number.isInteger(seed)) throw new Error('seed: a whole number');
  const ts = [...new Set(times.map(t => new Date(t).toISOString()))].sort();
  return ts.flatMap(t => Array.from({ length: k }, (_, repeat) => ({ t, repeat, seed: D.pointSeed(seed, t, repeat) })));
}

function readSamples(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Each planned sample from its checkpoint (D.runPoint), in the order planned; one already in samples.jsonl is kept.
 * deps: { runPoint (D.runPoint), followersOf (D.followersOf), stepDeps (the driver's step deps), onCall }.
 */
async function runSamples({ run, checkpoints, tree, plan, outDir, sampling, baseEnv = process.env, deps }) {
  const file = path.join(outDir, FILE);
  const done = new Map(readSamples(file).map(r => [`${r.t}|${r.repeat}`, r]));
  const out = [];
  fs.mkdirSync(outDir, { recursive: true });
  for (const [i, s] of plan.entries()) {
    const key = `${s.t}|${s.repeat}`;
    if (done.has(key)) { out.push(done.get(key)); continue; }
    const day = require('../trading/clock').tradingDayKey(new Date(s.t));
    const point = { t: s.t, day, inTrade: false };
    const res = await deps.runPoint({
      run, checkpoint: D.checkpointOf(checkpoints, s.t), home: path.join(outDir, 'points', `${i}-r${s.repeat}`), tree, point,
      followers: deps.followersOf(run.paths.runDir, point), repeat: s.repeat, seed: s.seed, baseEnv: { ...baseEnv, ...sampling.env },
      stepDeps: deps.stepDeps, onCall: deps.onCall || (() => {}),
    });
    const rec = { base: run.runId, t: s.t, repeat: s.repeat, seed: s.seed, runDir: res.runDir, times: res.times, error: res.error || null, sampling: sampling.digest };
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
    out.push(rec);
  }
  return out;
}

const samplerDir = run => path.join(path.dirname(run.paths.runHome), `${run.runId}.samples`);

async function runBase(run, { root, env = process.env, barsFiles = {}, checkpoints, log = () => {} }) {
  const P = require('./preflight');
  const G = require('./run-gate');
  const driver = require('../replay/driver');
  const gate = P.gateOptions(run, {});
  const pre = P.preflightForRun(run, gate, { root, env, barsFiles, log });
  G.checkLearningRun(gate);
  const fresh = driver.seedRunHome(run, { root, userEnv: env });
  if (pre) pre.record(run.paths.runHome);
  G.startLearningRun(run.paths.runHome, gate);
  for (const line of require('./run-pins').pinForRun(run, { fresh, arm: gate.arm, setup: { env } })) log(line);
  return driver.runReplay({ run, baseEnv: env, root, log, deps: D.checkpointDeps(driver.defaultDeps(run, root), { run, dir: checkpoints }) });
}

function sampleTimes(run, checkpoints) {
  const { decisionPoints } = require('../replay/schedule');
  const { curatedPoints } = require('./curated-lists');
  const all = decisionPoints(run.cfg, { start: run.start, end: run.end, everyNth: run.everyNth });
  const moments = new Set(curatedPoints(all, run.curated, (run.cfg.barDelaySeconds || 0) * 1000).filter(p => !p.manage && p.kind === 'trade').map(p => new Date(p.t).toISOString()));
  const { days } = require('../replay/store').readRun(run.paths.runDir);
  return Object.values(days).flat().filter(l => l && l.kind === 'trade' && moments.has(new Date(l.scheduled || l.t).toISOString()))
    .map(l => new Date(l.t).toISOString()).filter(t => fs.existsSync(D.checkpointOf(checkpoints, t)));
}

/** The driver's step, plus whether the side's replay account holds a position or a working order (as the training loop's). */
function stepDeps(run, tree) {
  const { withAdapter } = require('../broker/adapter');
  return {
    ...require('../replay/driver').defaultDeps(run, tree),
    inTrade: (env, account) => withAdapter({ root: tree, env }, async a => {
      const s = await a.accountState(account);
      return s.positions.length > 0 || s.orders.length > 0;
    }),
  };
}

module.exports = { SETTINGS, FILE, samplingSettings, checkBaseRun, planSamples, runSamples, readSamples, samplerDir, runBase, sampleTimes, stepDeps };
