'use strict';

/**
 * The tool-call layer's call log (docs/TOOL-CALLS-AND-ORCHESTRATION.md, "One call log"): what the rules keep between a
 * session's calls, one state per rule and session. In memory for a harness whose rules run in-process (the opencode
 * plugin, one per run); in a file for one whose hooks start a process per call (Claude Code: `file`, under the harness
 * home), read on open and written on `save`. A state is a plain object the rule changes in place.
 *
 * A file log is locked while one process holds it (a lock file beside it, taken atomically): a harness that runs a
 * call's hooks in parallel processes (Claude Code, parallel tool calls) would otherwise lose one's update to the
 * other's (a role's report, so the desk rule would hold compose_check for a role that reported). The lock is taken on
 * open, waiting up to LOCK_WAIT_MS; one older than LOCK_STALE_MS (a process that died) is taken over; save releases it.
 *
 *   createCallLog({ file })   { state(rule, session), save() }
 */

const fs = require('fs');
const path = require('path');

// config/runner.json limits.callLogLock: how long to wait for the lock, when one is stale, how often to look.
const { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS, pollMs: LOCK_POLL_MS } = require('../tunables').runner().limits.callLogLock;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Take `lock` (exclusive create, holding this owner's token); a stale one is taken over by renaming it away, which
 * only one waiter can win; the owner's token, or null when it couldn't be taken in time.
 */
function takeLock(lock) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const token = `${process.pid}-${require('crypto').randomUUID()}`;
  for (let waited = 0; waited <= LOCK_WAIT_MS; waited += LOCK_POLL_MS) {
    try {
      fs.writeFileSync(lock, token, { flag: 'wx' });
      return token;
    } catch (err) {
      if (err.code !== 'EEXIST') return null;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          const away = `${lock}.${token}.stale`;
          fs.renameSync(lock, away); // one waiter wins; the others find it gone (ENOENT)
          fs.rmSync(away, { force: true });
          continue;
        }
      } catch (_e) { /* taken over or gone: try again */ }
      pause(LOCK_POLL_MS);
    }
  }
  return null;
}

/** Remove `lock` only if it is still this owner's (one held past stale and taken over is the new owner's). */
function releaseLock(lock, token) {
  try {
    if (fs.readFileSync(lock, 'utf8') === token) fs.rmSync(lock, { force: true });
  } catch (_err) { /* gone */ }
}

function createCallLog({ file = null } = {}) {
  let all = {};
  const lock = file ? `${file}.lock` : null;
  const token = lock ? takeLock(lock) : null;
  if (file) {
    try { all = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_err) { all = {}; }
  }
  return {
    state(rule, session) {
      const key = `${rule}\u0000${String(session || '')}`;
      if (!all[key] || typeof all[key] !== 'object') all[key] = {};
      return all[key];
    },
    save() {
      if (!file) return;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(all));
        fs.renameSync(tmp, file);
      } finally {
        if (token) releaseLock(lock, token);
      }
    },
  };
}

module.exports = { createCallLog };
