'use strict';

/**
 * Process helpers shared by the live runner (scripts/autotrader.js) and the
 * backtester (scripts/backtest.js): atomic JSON state files and one headless
 * harness run in its own process group with a hard timeout.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    return fallback;
  }
}

/** Atomic write via an unpredictable, exclusively created temp file (no symlink tricks). */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Run argv in its own process group (so a timeout kills the harness and
 * everything it started). Resolves { ok, timedOut, code, output } once the
 * harness process exits: a detached grandchild still holding its output
 * pipes can't hold up the loop.
 * `onChild(child|null)` tracks the running child for signal handling.
 */
function runHarness(argv, { cwd, env, timeoutMs, onChild = () => {} }) {
  return new Promise(resolve => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    onChild(child);
    let output = '';
    let timedOut = false;
    const killGroup = sig => {
      try {
        process.kill(-child.pid, sig);
      } catch (_err) {
        child.kill(sig);
      }
    };
    child.stdout.on('data', c => { output += c; });
    child.stderr.on('data', c => { output += c; });
    const timer = setTimeout(() => {
      timedOut = true;
      output += `\n[autotrader] timeout after ${timeoutMs / 60000} min; killing run\n`;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 10000).unref();
    }, timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      onChild(null);
      resolve({ ok: false, timedOut, output: `${output}\n[autotrader] could not start ${cmd}: ${err.message}\n` });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      onChild(null);
      // Give the pipes a moment to drain, then stop waiting on them.
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        const exitCode = code === null ? (signal ? 1 : 0) : code;
        resolve({ ok: exitCode === 0 && !timedOut, timedOut, code: exitCode, output });
      }, 200);
    });
  });
}

/** Entry order ids the MCP gateway recorded in <stateDir>/entry-orders.json. */
function entryOrderIds(stateDir) {
  const list = readJson(path.join(stateDir, 'entry-orders.json'), []);
  return new Set((Array.isArray(list) ? list : []).map(e => Number(e && e.orderId)).filter(Number.isFinite));
}

module.exports = { readJson, writeJsonAtomic, runHarness, entryOrderIds };
