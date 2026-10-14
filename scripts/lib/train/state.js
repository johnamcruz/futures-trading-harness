'use strict';

/**
 * The training loop's state on disk, in the harness home (never the repository):
 *
 *   <FTH_HOME>/training/loop.lock               one loop at a time on this home: { pid, loopId, startedAt }
 *   <FTH_HOME>/training/looks.jsonl              the look ledger the loop appends to (R16; prop/looks.js judges it)
 *   <FTH_HOME>/training/<loopId>/state.json      the loop's progress: phases done, counters, the iterations
 *   <FTH_HOME>/training/<loopId>/archive.jsonl   every proposal and its verdict (archive.js)
 *   <FTH_HOME>/training/<loopId>/iter-<n>/       each iteration's files (panel, proposals, results, verdicts)
 *
 * Resumable: every phase writes its output, then marks itself done in state.json (atomically), so a run
 * stopped anywhere picks up at the first phase not done, and a phase whose output exists is never redone.
 *
 *   loopPaths(env, loopId)                    the paths above
 *   acquireLock(paths, { loopId, pid })       a release function; refuses a live holder (a dead one's lock is taken over)
 *   lockHolder(file)                          { pid, loopId } of a live holder, or null
 *   openState(paths, { loopId, hash, now })   the state (created, or checked on resume: the same config hash)
 *   saveState(paths, state)
 *   budgetLeft(state, limits, { startedMs, nowMs })   null, or why the loop must stop now (a resource limit)
 *   spend(state, n)                           counts n model calls
 *   readLedger(file) / logLook(file, look)    the look ledger: a look is checked (prop/looks.js) before it is logged
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../harness-run');
const { harnessHome } = require('../paths');
const { checkLook } = require('../prop/looks');

const VERSION = 1;

function loopPaths(env, loopId) {
  const training = path.join(harnessHome(env), 'training');
  const dir = path.join(training, loopId);
  return {
    training, dir, lock: path.join(training, 'loop.lock'), ledger: path.join(training, 'looks.jsonl'),
    state: path.join(dir, 'state.json'), archive: path.join(dir, 'archive.jsonl'), iter: n => path.join(dir, `iter-${n}`),
  };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function lockHolder(file) {
  const lock = readJson(file, null);
  return lock && alive(lock.pid) ? lock : null;
}

function acquireLock(paths, { loopId, pid = process.pid, now = new Date() }) {
  fs.mkdirSync(paths.training, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i += 1) {
    try {
      fs.writeFileSync(paths.lock, JSON.stringify({ pid, loopId, startedAt: now.toISOString() }), { flag: 'wx' });
      return () => {
        const held = readJson(paths.lock, null);
        if (held && held.pid === pid) fs.unlinkSync(paths.lock);
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = lockHolder(paths.lock);
      if (holder) throw new Error(`another training loop (pid ${holder.pid}, ${holder.loopId}) is running on this home (${paths.lock}): one loop at a time`, { cause: err });
      fs.unlinkSync(paths.lock);
    }
  }
  throw new Error(`could not lock ${paths.lock}`);
}

function openState(paths, { loopId, hash, now = new Date() }) {
  const existing = readJson(paths.state, null);
  if (existing === null && fs.existsSync(paths.state)) throw new Error(`${paths.state} is unreadable: fix or remove it`);
  if (existing) {
    if (existing.loopId !== loopId) throw new Error(`${paths.state} belongs to loop ${existing.loopId}`);
    if (existing.hash !== hash) throw new Error(`loop ${loopId} was started with another config (hash ${existing.hash.slice(0, 12)}, now ${hash.slice(0, 12)}): a changed config is a new loopId`);
    return existing;
  }
  const state = { v: VERSION, loopId, hash, createdAt: now.toISOString(), modelCalls: 0, done: {}, iterations: [], stopped: null };
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(paths.state, state);
  return state;
}

const saveState = (paths, state) => writeJsonAtomic(paths.state, state);

/** Why the loop must stop now, or null: the iterations, model calls (counted across resumes) or wall time (this run) are spent. */
function budgetLeft(state, limits, { startedMs, nowMs = Date.now(), starting = false } = {}) {
  const finished = state.iterations.filter(i => i.done).length;
  if (starting && finished >= limits.maxIterations) return `max iterations reached (${finished} of ${limits.maxIterations})`;
  if (state.modelCalls >= limits.maxModelCalls) return `max model calls reached (${state.modelCalls} of ${limits.maxModelCalls})`;
  if (nowMs - startedMs >= limits.maxWallMinutes * 60000) return `max wall time reached (${limits.maxWallMinutes} minutes this run)`;
  return null;
}

function spend(state, n = 1) {
  state.modelCalls += n;
}

function readLedger(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // An unreadable line is refused, never skipped: a lost look would hand back budget (R16).
  return text.split('\n').filter(l => l.trim()).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (err) {
      throw new Error(`${file}: line ${i + 1} is not a look; the ledger can't be read, so no look is allowed`, { cause: err });
    }
  });
}

/** Checks the look against the ledger (prop/looks.js), then appends it; throws, logging nothing, when it is refused. */
function logLook(file, look, now = new Date()) {
  const verdict = checkLook(look, readLedger(file));
  if (!verdict.ok) throw new Error(`look refused:\n- ${verdict.refusals.join('\n- ')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify({ ...look, at: now.toISOString() })}\n`);
  return verdict;
}

module.exports = { VERSION, loopPaths, acquireLock, lockHolder, openState, saveState, budgetLeft, spend, readLedger, logLook };
