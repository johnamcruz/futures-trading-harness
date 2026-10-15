'use strict';

/**
 * Process helpers shared by the live runner (scripts/autotrader.js) and the
 * backtester (scripts/backtest.js): atomic JSON state files and one headless
 * harness run in its own process group with a hard timeout.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const RUN = require('./tunables').runner().runner; // config/runner.json: the kill grace after a run
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
 * An appender for the live transcript, a file of this run's own: created new (a leftover at its path removed first), each
 * chunk added; a write that fails is skipped, so the gate sees less, never more (a file it can't read refuses entries).
 * `done()` removes it once the run has ended (the cycle log keeps the whole transcript).
 */
function liveWriter(file) {
  let ok = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; } // a leftover is never read as this run's
    fs.writeFileSync(file, '', { mode: 0o600, flag: 'wx' });
    ok = true;
  } catch (_err) { /* can't be replaced or made: nothing is written, and the gate fails closed (an unreadable or empty file) */ }
  const append = chunk => { if (ok) try { fs.appendFileSync(file, chunk); } catch (_err) { /* as above */ } };
  append.done = () => { if (ok) try { fs.unlinkSync(file); } catch (_err) { /* gone already */ } };
  return append;
}

/**
 * Run argv in its own process group (so a timeout kills the harness and
 * everything it started). Resolves { ok, timedOut, code, output, stdout, lineTimes } once the
 * harness process exits (`stdout`: the standard output alone): a detached grandchild still holding its output
 * pipes can't hold up the loop, and whatever it left in its process group is
 * stopped.
 * `onChild(child|null)` tracks the running child for signal handling.
 */
function runHarness(argv, { cwd, env, timeoutMs, onChild = () => {}, liveFile = null }) {
  return new Promise(resolve => {
    const [cmd, ...args] = argv;
    // The transcript so far, for the gate to read while the run goes on: emptied first, then each output chunk appended.
    const live = liveFile ? liveWriter(liveFile) : Object.assign(() => {}, { done: () => {} });
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    onChild(child);
    let output = '';
    let stdout = ''; // the transcript alone (the gate's view: liveFile), without stderr
    let timedOut = false;
    const killGroup = sig => {
      try {
        process.kill(-child.pid, sig);
      } catch (_err) {
        child.kill(sig);
      }
    };
    // Each standard-output line's arrival (wall ms), for the cycle's timing (cycle-timing.js): a line without its own time.
    const lineTimes = [];
    child.stdout.on('data', c => { const s = String(c); output += s; stdout += s; live(c); for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) lineTimes.push(Date.now()); });
    child.stderr.on('data', c => { output += c; });
    const timer = setTimeout(() => {
      timedOut = true;
      output += `\n[autotrader] timeout after ${timeoutMs / 60000} min; killing run\n`;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), RUN.killGraceMs).unref();
    }, timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      onChild(null);
      live.done();
      resolve({ ok: false, timedOut, stdout, lineTimes, output: `${output}\n[autotrader] could not start ${cmd}: ${err.message}\n` });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      onChild(null);
      // Anything the harness left running in its group (a background shell, a
      // sub-agent) must not keep acting after the cycle: end the group too.
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), RUN.exitKillGraceMs).unref();
      // Give the pipes a moment to drain, then stop waiting on them.
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        live.done();
        const exitCode = code === null ? (signal ? 1 : 0) : code;
        resolve({ ok: exitCode === 0 && !timedOut, timedOut, code: exitCode, output, stdout, lineTimes });
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
  // opencode's project config (generated; it holds the roles and every permission) and the names it also loads.
  'opencode.json', 'opencode.jsonc',
];
/**
 * Folders fingerprinted whole (every file's path and bytes, symlinks as their target): opencode loads
 * agents, commands, plugins (code it runs) and configs from `.opencode/`, and installs npm packages there
 * (running its package.json). The harness generates none, so the folder is absent and must stay so.
 */
const TRUSTED_WORKSPACE_DIRS = ['.opencode'];

/** A folder's fingerprint: null when absent, else a digest of every entry under it, in order. */
function dirDigest(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (abs, rel) => {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) hash.update(`link:${rel}:${fs.readlinkSync(abs)}\n`);
    else if (st.isDirectory()) {
      hash.update(`dir:${rel}\n`);
      for (const name of fs.readdirSync(abs).sort()) walk(path.join(abs, name), rel ? `${rel}/${name}` : name);
    } else hash.update(`file:${rel}:${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}\n`);
  };
  try {
    walk(dir, '');
  } catch (err) {
    if (err.code === 'ENOENT' && !fs.existsSync(dir)) return null;
    return `unreadable:${err.code || err.message}`;
  }
  return hash.digest('hex');
}

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
  return {
    ...Object.fromEntries(TRUSTED_WORKSPACE_FILES.map(f => {
      try {
        return [f, fileDigest(f, fs.readFileSync(path.join(dir, f)))];
      } catch (_err) {
        return [f, null];
      }
    })),
    ...Object.fromEntries(TRUSTED_WORKSPACE_DIRS.map(d => [`${d}/`, dirDigest(path.join(dir, d))])),
  };
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

module.exports = { readJson, writeJsonAtomic, runHarness, entryOrders, TRUSTED_WORKSPACE_FILES, TRUSTED_WORKSPACE_DIRS, fileDigest, dirDigest, workspaceFingerprint, changedFiles };
