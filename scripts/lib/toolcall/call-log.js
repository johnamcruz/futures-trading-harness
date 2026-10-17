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

/** Take `lock` (exclusive create); a stale one is taken over; false when it couldn't be taken in time. */
function takeLock(lock) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let waited = 0; waited <= LOCK_WAIT_MS; waited += LOCK_POLL_MS) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true }); } catch (_e) { /* gone */ }
      pause(LOCK_POLL_MS);
    }
  }
  return false;
}

function createCallLog({ file = null } = {}) {
  let all = {};
  const lock = file ? `${file}.lock` : null;
  const locked = lock ? takeLock(lock) : false;
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
        if (locked) fs.rmSync(lock, { force: true });
      }
    },
  };
}

module.exports = { createCallLog };
