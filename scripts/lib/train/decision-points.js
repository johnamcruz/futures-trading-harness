'use strict';

/**
 * The decision-point replay mode (docs/LEARNED-RULEBOOK.md R30 items 2-3): re-run only chosen decision
 * points of a replay, each from its reference state (the account, the position, the journal and the
 * runner's state as the champion's continuous run had them), with a given tree of the harness (the
 * champion's or a candidate's). The replay driver runs whole windows only; this is the simplest correct
 * version of the new mode, built on the driver's own step:
 *
 * 1. Checkpoints. The champion's continuous run (driver.js runReplay) runs with checkpointDeps: before each
 *    trade decision's step, after the driver set the replay clock to its time, the run home is copied to
 *    <checkpoints>/<time>/ (the broker's state, the clock, the runner's state, the journal, the logs; the
 *    step logs, archived bars and cycle files are left out). A retried time overwrites its checkpoint.
 * 2. A point run copies one checkpoint into a fresh home, re-bases the run's paths and runner config on it,
 *    puts the given tree's workspace operator files in it (the tree's generated adapters), and runs the
 *    driver's step there (autotrader.js --once from the given tree, at the point's time, through the
 *    order gate to the replay broker), then records the line as the driver does (store.appendRecord).
 *    A point inside a trade runs on, at the champion's later decision times that day, until the day's
 *    end of day (the trade ends by then at the latest), so its management is judged (R30 item 3).
 * 3. Seeds. Each point and repeat has its own seed, the same for the champion and every candidate
 *    (pointSeed), given to the harness process as FTH_TRAIN_SEED for a harness CLI config that uses one.
 *
 *   checkpointDeps(deps, { run, dir })              the driver's deps, taking a checkpoint before each trade step
 *   checkpointOf(dir, t)                            the checkpoint folder for a decision time
 *   choosePanel({ decisions, used, maxFlagged, control, seed })   { flagged, control, points }
 *   followersOf(runDir, point)                      the champion's later times on the point's day (in a trade)
 *   pointSeed(seed, t, repeat)                      a whole number, the same for both sides of a pair
 *   runPoint({ run, checkpoint, home, tree, point, followers, repeat, seed, baseEnv, stepDeps, onCall })
 *                                                   { t, repeat, seed, runDir, times, error }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic, TRUSTED_WORKSPACE_FILES } = require('../harness-run');
const { replayEnv } = require('../replay/config');
const store = require('../replay/store');
const { decisionRecord } = require('../session/record');

// Left out of a checkpoint: what a step writes for people (its log), the archived bars, and old cycle files.
const EXCLUDE = [/^replay\/[^/]+\/steps\.log$/, /^replay\/[^/]+\/bars-[^/]*\.jsonl\.gz$/, /^logs\/cycles(\/|$)/];

const stamp = t => new Date(t).toISOString().replace(/:/g, '-');
const checkpointOf = (dir, t) => path.join(dir, stamp(t));

function snapshot(runHome, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(runHome, dest, {
    recursive: true, verbatimSymlinks: true,
    filter: src => !EXCLUDE.some(re => re.test(path.relative(runHome, src).split(path.sep).join('/'))),
  });
}

function checkpointDeps(deps, { run, dir }) {
  return {
    ...deps,
    async step(point, env, timeoutMs) {
      if (point.kind === 'trade') snapshot(run.paths.runHome, checkpointOf(dir, point.t));
      return deps.step(point, env, timeoutMs);
    },
  };
}

function hashInt(...parts) {
  return crypto.createHash('sha256').update(parts.map(String).join('|')).digest().readUInt32BE(0);
}

const pointSeed = (seed, t, repeat) => hashInt(seed, new Date(t).toISOString(), repeat) % 2147483647;

/** A seeded shuffle (mulberry32): the same seed gives the same order. */
function shuffled(list, seed) {
  let a = hashInt(seed) || 1;
  const rand = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The panel: up to maxFlagged flagged decisions (a failure category) not targeted before (`used`: their keys),
 * in time order, and up to `control` decisions scored right, drawn by the seed, so a candidate that breaks a
 * right decision is seen. Points are decision times (a time with several symbols is one point).
 */
function choosePanel({ decisions, used = [], maxFlagged, control, seed, failures }) {
  const usedSet = new Set(used);
  const byTime = (a, b) => Date.parse(a.t) - Date.parse(b.t) || String(a.key).localeCompare(String(b.key));
  const flagged = decisions.filter(d => failures.includes(d.category) && !usedSet.has(d.key)).sort(byTime).slice(0, maxFlagged);
  const flaggedTimes = new Set(flagged.map(d => d.t));
  const right = decisions.filter(d => d.category === 'right' && !flaggedTimes.has(d.t)).sort(byTime);
  const ctl = shuffled(right, seed).slice(0, control).sort(byTime);
  const points = new Map();
  for (const d of [...flagged, ...ctl]) {
    const p = points.get(d.t) || { t: d.t, day: d.day, inTrade: false, flagged: false };
    p.inTrade = p.inTrade || d.inTrade === true;
    p.flagged = p.flagged || flaggedTimes.has(d.t);
    points.set(d.t, p);
  }
  return { flagged, control: ctl, points: [...points.values()].sort(byTime) };
}

/** The champion's trade and end-of-day times after the point on its day, in order (a point in a trade runs on through them). */
function followersOf(runDir, point) {
  const { days } = store.readRun(runDir);
  return (days[point.day] || []).filter(l => Date.parse(l.t) > Date.parse(point.t) && ['trade', 'eod'].includes(l.kind))
    .map(l => ({ t: l.t, day: l.day, kind: l.kind }));
}

/** The run with its paths re-based from its home onto `home`. */
function rebase(run, home) {
  const paths = Object.fromEntries(Object.entries(run.paths).map(([k, v]) => [k, path.join(home, path.relative(run.paths.runHome, v))]));
  // The runner config's own folders are the run home's (replay/config.js), so they move with it.
  const own = { dataDir: paths.bars, workdir: paths.workspace };
  return { ...run, paths, derived: { ...run.derived, ...own }, cfg: { ...run.cfg, ...own } };
}

/** The point home as the tree runs it: its runner config re-based, and the tree's own workspace operator files. */
function seedPointHome(pr, tree) {
  writeJsonAtomic(pr.paths.autotrader, pr.derived);
  for (const f of TRUSTED_WORKSPACE_FILES.filter(x => !x.startsWith('.qwen/'))) {
    const src = path.join(tree, 'workspace', f);
    const dest = path.join(pr.paths.workspace, f);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    } else fs.rmSync(dest, { force: true });
  }
}

async function runPoint({ run, checkpoint, home, tree, point, followers = [], repeat, seed, baseEnv = process.env, stepDeps, onCall = () => {} }) {
  if (!fs.existsSync(checkpoint)) throw new Error(`no checkpoint for ${point.t} (${checkpoint}): the champion's run must be taken with checkpoints`);
  fs.rmSync(home, { recursive: true, force: true });
  fs.cpSync(checkpoint, home, { recursive: true, verbatimSymlinks: true });
  const pr = rebase(run, home);
  seedPointHome(pr, tree);
  const deps = stepDeps(pr, tree);
  const manifest = readJson(pr.paths.manifest, null);
  if (!manifest) throw new Error(`${checkpoint}: no run manifest in the checkpoint`);
  delete manifest.pending;
  const times = [{ t: point.t, day: point.day, kind: 'trade' }, ...(point.inTrade ? followers : [])];
  const env0 = { ...replayEnv(baseEnv, pr, { at: new Date(times[0].t) }), FTH_TRAIN_SEED: String(seed) };
  writeJsonAtomic(pr.paths.clockFile, { now: new Date(times[0].t).toISOString() });
  const why = await deps.serverCheck(env0, new Date(times[0].t));
  if (why) throw new Error(`decision-point replay refused: ${why}`);
  const timeoutMs = (pr.cfg.cycleTimeoutMinutes * Math.max(1, pr.cfg.symbols.length) + 2) * 60000;
  const done = [];
  let error = null;
  for (const x of times) {
    const at = new Date(x.t);
    writeJsonAtomic(pr.paths.clockFile, { now: at.toISOString() });
    const env = { ...replayEnv(baseEnv, pr, { at }), FTH_TRAIN_SEED: String(seed) };
    const started = Date.now();
    onCall();
    const res = await deps.step({ t: at, kind: x.kind, day: x.day }, env, timeoutMs);
    const pass = store.parseStep(res.output);
    if (!pass) {
      error = `the runner could not run at ${x.t} (exit ${res.code}${res.timedOut ? ', timed out' : ''})`;
      break;
    }
    // The broker's fills since the last time read, as the driver reads them (a failed read is the line's error).
    const since = manifest.tradesSince ? new Date(manifest.tradesSince) : at;
    let trades = null;
    if (pr.cfg.account && deps.trades) {
      try {
        trades = await deps.trades(env, pr.cfg.account, since, at);
        manifest.tradesSince = at.toISOString();
      } catch (err) {
        trades = { error: err.message };
      }
    }
    const rec = decisionRecord({
      t: at.toISOString(), day: x.day, kind: x.kind, pass, step: { code: res.code, timedOut: Boolean(res.timedOut) },
      cycles: store.cycleLogsSince(pr.paths.runHome, started).map(store.cycleSummary), refusals: store.refusalsSince(pr.paths.runHome, started),
      trades, since: since.toISOString(),
    });
    store.appendRecord(pr.paths, manifest, rec);
    done.push(rec.t);
  }
  return { t: new Date(point.t).toISOString(), repeat, seed, runDir: pr.paths.runDir, times: done, error };
}

module.exports = { EXCLUDE, checkpointDeps, checkpointOf, choosePanel, followersOf, pointSeed, rebase, runPoint, shuffled };
