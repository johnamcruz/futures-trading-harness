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
 * pipes can't hold up the loop, and whatever it left in its process group is
 * stopped.
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
      // Anything the harness left running in its group (a background shell, a
      // sub-agent) must not keep acting after the cycle: end the group too.
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 2000).unref();
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

/**
 * Files in the run's working directory that every harness trusts: operator
 * instructions and project settings. A run must not change them (a Codex run
 * can write its working directory), so the runner fingerprints them before
 * and after every run.
 */
const TRUSTED_WORKSPACE_FILES = [
  'AGENTS.md', 'CLAUDE.md', 'QWEN.md', '.mcp.json',
  '.qwen/settings.json', '.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml',
];

/**
 * A trusted file's fingerprint (sha256 hex). Qwen Code stamps the settings file it loads with its
 * settings-format version ("$version": an integer) and writes it back on every start: for
 * .qwen/settings.json that one key, and JSON whitespace, are not part of the fingerprint; every
 * other key and value is, in order. Anything that isn't a JSON object is fingerprinted as bytes.
 */
function fileDigest(name, content) {
  const hash = data => crypto.createHash('sha256').update(data).digest('hex');
  if (name === '.qwen/settings.json') {
    let v = null;
    try { v = JSON.parse(String(content)); } catch (_err) { /* not JSON: as bytes */ }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // Safe because the harness writes only permissions lists there, which no Qwen version migration
      // rewrites (tests pin it); a key such a migration moves (legacy scalars, tools.core, modelProviders) would reopen it.
      const { $version: version, ...rest } = v;
      if (version === undefined || Number.isInteger(version)) return hash(`json:${JSON.stringify(rest)}`);
    }
  }
  return hash(content);
}

function workspaceFingerprint(dir) {
  return Object.fromEntries(TRUSTED_WORKSPACE_FILES.map(f => {
    try {
      return [f, fileDigest(f, fs.readFileSync(path.join(dir, f)))];
    } catch (_err) {
      return [f, null];
    }
  }));
}

/** Files whose fingerprint differs. */
function changedFiles(before, after) {
  return Object.keys({ ...before, ...after }).filter(f => before[f] !== after[f]);
}

/** Entries the MCP gateway recorded in <stateDir>/entry-orders.json, oldest first. */
function entryOrders(stateDir) {
  const list = readJson(path.join(stateDir, 'entry-orders.json'), []);
  return (Array.isArray(list) ? list : []).filter(e => e && Number.isFinite(Number(e.orderId)));
}

module.exports = { readJson, writeJsonAtomic, runHarness, entryOrders, TRUSTED_WORKSPACE_FILES, fileDigest, workspaceFingerprint, changedFiles };
