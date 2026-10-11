'use strict';

/**
 * The autonomous runner's lock (<FTH_HOME>/autotrader.lock: its pid and start
 * time), read by the runner itself (one runner per machine) and by anything
 * that must know whether a runner is live (the harness tools refuse `record`
 * while one runs: it records every bar's read and signals itself).
 *
 *   processCommand(pid, { spawn })   the process's command line, '' when it is gone, null when unknown
 *   lockHolderAlive(lock, { self })  the pid exists and (where its command can be read) is an autotrader
 *   liveRunner(env)                  the live runner's pid from its lock, or null
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { harnessHome } = require('./paths');

const lockFile = env => path.join(harnessHome(env), 'autotrader.lock');

function processCommand(pid, { spawn = spawnSync } = {}) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch (_err) {
    // no /proc (macOS): ask ps
  }
  try {
    const r = spawn('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
    if (r.error || r.status === null) return null;
    return r.status === 0 ? String(r.stdout).trim() : ''; // ps exits 1 for no such process
  } catch (_err) {
    return null;
  }
}

/** A lock holder is live only if the pid exists and (where its command can be read) is an autotrader. */
function lockHolderAlive(lock, { self = process.pid, command = processCommand } = {}) {
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0 || lock.pid === self) return false;
  try {
    process.kill(lock.pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  const cmd = command(lock.pid);
  return cmd === null || cmd.includes('autotrader');
}

function liveRunner(env = process.env, opts = {}) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockFile(env), 'utf8'));
  } catch (_err) {
    return null;
  }
  return lockHolderAlive(lock, { self: null, ...opts }) ? lock.pid : null;
}

module.exports = { lockFile, processCommand, lockHolderAlive, liveRunner };
