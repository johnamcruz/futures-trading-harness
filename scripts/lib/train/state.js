'use strict';

/**
 * The training loop's state on disk, in the harness home (never the repository):
 *
 *   <FTH_HOME>/training/loop.lock               one loop at a time on this home: { pid, loopId, startedAt }
 *   <default home>/training/looks.jsonl          the one look ledger (R16; prop/looks.js judges it): always the default
 *                                                harness home's, whatever FTH_HOME says, so another home never starts a fresh budget
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
 *   readLedger(file) / logLook(file, look)    the look ledger: a look is checked (prop/looks.js) before it is logged,
 *                                             under the ledger's lock (the evaluator's lock too)
 *   takeJudgingLook(file, look, { snapshot })  a held-out judging's months checked unused, the snapshot written and
 *                                             the look logged, as one step under the lock
 *   monthsOf(from, to)                        the months a range of session dates touches
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readJson, writeJsonAtomic } = require('../harness-run');
const { harnessHome } = require('../paths');
const { checkLook } = require('../prop/looks');
const { RECORDED_LOOKS } = require('../prop/splits');
const LF = require('../prop/ledger-file');

const VERSION = 1;

/** The look ledger: the default harness home's (of the user's home directory), never FTH_HOME's. */
const ledgerFile = env => path.join(harnessHome({}, env.HOME || os.homedir()), 'training', 'looks.jsonl');

function loopPaths(env, loopId) {
  const training = path.join(harnessHome(env), 'training');
  const dir = path.join(training, loopId);
  return {
    training, dir, lock: path.join(training, 'loop.lock'), ledger: ledgerFile(env),
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
  // Written whole first, then linked into place: the lock never exists half-written.
  const tag = `${pid}-${crypto.randomBytes(4).toString('hex')}`;
  const tmp = `${paths.lock}.${tag}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid, loopId, startedAt: now.toISOString() }), { mode: 0o600 });
  const busy = (holder, cause) => new Error(`another training loop (pid ${holder.pid}, ${holder.loopId}) is running on this home (${paths.lock}): one loop at a time`, { cause });
  try {
    for (let i = 0; i < 3; i += 1) {
      try {
        fs.linkSync(tmp, paths.lock);
        return () => {
          const held = readJson(paths.lock, null);
          if (held && held.pid === pid) fs.unlinkSync(paths.lock);
        };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const lock = readJson(paths.lock, null);
        // Unreadable: held (fails closed); a person removes it once no loop runs.
        if (!lock) throw new Error(`${paths.lock} is unreadable, so it is taken as held. Remove ${paths.lock} by hand only when no training loop (scripts/train-loop.js) is running on this harness home.`, { cause: err });
        if (alive(lock.pid)) throw busy(lock, err);
        // A dead holder's lock: moved aside (only one process can move it), then checked to be the one read.
        const aside = `${paths.lock}.${tag}.stale`;
        try {
          fs.renameSync(paths.lock, aside);
        } catch (e) {
          if (e.code === 'ENOENT') continue;
          throw e;
        }
        const moved = readJson(aside, null);
        if (moved && alive(moved.pid)) {
          try { fs.linkSync(aside, paths.lock); } catch (_e) { /* someone holds it again */ }
          fs.unlinkSync(aside);
          throw busy(moved, err);
        }
        fs.unlinkSync(aside);
      }
    }
    throw new Error(`could not lock ${paths.lock}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_err) { /* gone: never hides the error above */ }
  }
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

/**
 * The ledger's looks, through the one reader (prop/ledger-file.js): JSON lines or the earlier JSON-list format; a
 * line that isn't a look, or an existing empty file, is refused (a lost look would hand back budget, R16). A missing
 * file is a ledger with no looks only where the loop starts the one ledger at its fixed path (create, the default
 * for a tuning look); a held-out judging requires it to exist (takeJudgingLook).
 */
function readLedger(file, { create = true } = {}) {
  return LF.readLedger(file, { create });
}

/** fn holding the ledger's lock (`<ledger>.lock`, prop/ledger-file.js withLedgerLock, as the evaluator takes it). */
function locked(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    return LF.withLedgerLock(file, fn);
  } catch (err) {
    // A run killed while it held the lock (SIGKILL) leaves the lock file: it is never broken automatically.
    if (/locked by another run/.test(err.message)) {
      throw new Error(`the look ledger is locked: ${file}.lock exists. Another training loop (scripts/train-loop.js) or evaluator run (scripts/evaluate.js) holds it, or one was killed while holding it. Remove ${file}.lock by hand only when no training loop and no evaluator run is running.`, { cause: err });
    }
    throw err;
  }
}

function appendChecked(file, look, now) {
  const verdict = checkLook(look, readLedger(file));
  if (!verdict.ok) throw new Error(`look refused:\n- ${verdict.refusals.join('\n- ')}`);
  LF.appendLook(file, { ...look, at: now.toISOString() });
  return verdict;
}

/**
 * Checks the look against the ledger (prop/looks.js), then appends it, both under the ledger's lock; throws,
 * logging nothing, when it is refused.
 */
function logLook(file, look, now = new Date()) {
  return locked(file, () => appendChecked(file, look, now));
}

/** The months ('YYYY-MM') a [from, to) range of session dates touches. */
function monthsOf(from, to) {
  const out = [];
  const last = new Date(Date.parse(`${to}T00:00:00Z`) - 86400000).toISOString().slice(0, 7);
  for (let m = String(from).slice(0, 7); m <= last;) {
    out.push(m);
    const [y, mo] = m.split('-').map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  return out;
}

/**
 * A held-out judging's one look, atomically under the ledger's lock: refused when any of its months was used by an
 * earlier judging look or a recorded look (each held-out month judges once, section 4); else the ledger as it is
 * now is written to `snapshot` (the judging's checks run against it), and the look is checked and appended.
 */
function takeJudgingLook(file, look, { snapshot, own = null, resume = false, now = new Date() }) {
  return locked(file, () => {
    // A judging follows the loop's tuning looks: the ledger exists (a missing one is refused, never a fresh budget).
    const ledger = readLedger(file, { create: false });
    // A resume after a stop between this look being logged and the loop saving it (resume: the loop had saved "judging
    // started"; own: { loopId, proposalId }, written into the look): the look this loop and proposal logged on the same
    // months is theirs. Any other look on those months refuses: a month never judges a second proposal.
    const mineAlready = resume && own && ledger.find(l => l.purpose === 'judging' && l.loopId === own.loopId && l.proposalId === own.proposalId
      && JSON.stringify(l.ranges) === JSON.stringify(look.ranges));
    if (mineAlready) {
      if (!fs.existsSync(snapshot)) throw new Error(`the held-out ledger snapshot ${snapshot} is missing for a judging whose look is already logged: restore the file from a backup to resume; otherwise those held-out months are spent`);
      return { resumed: true };
    }
    const months = ws => new Set(ws.flatMap(w => monthsOf(w.from, w.to)));
    const mine = months(look.ranges);
    const used = [...RECORDED_LOOKS.map(l => ({ ranges: [l] })), ...ledger.filter(l => l.purpose === 'judging')]
      .flatMap(l => [...months(Array.isArray(l.ranges) ? l.ranges : [l])]).filter(m => mine.has(m));
    if (used.length) throw new Error(`held-out months already used for judging: ${[...new Set(used)].sort().join(', ')}; each held-out month judges once`);
    // The look's own rules (budget, role) checked before anything is written.
    const verdict = checkLook(look, ledger);
    if (!verdict.ok) throw new Error(`look refused:\n- ${verdict.refusals.join('\n- ')}`);
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    fs.writeFileSync(snapshot, fs.existsSync(file) ? fs.readFileSync(file) : '');
    LF.appendLook(file, { ...look, ...(own ? { loopId: own.loopId, proposalId: own.proposalId } : {}), at: now.toISOString() });
    return verdict;
  });
}

module.exports = { VERSION, loopPaths, acquireLock, lockHolder, openState, saveState, budgetLeft, spend, readLedger, logLook, takeJudgingLook, monthsOf };
