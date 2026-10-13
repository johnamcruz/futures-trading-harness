'use strict';

// One temporary root per test run. tests/run-all.js makes it under the system temporary
// directory, points TMPDIR (TMP, TEMP) at it for the test processes, so os.tmpdir() in every test
// and every child they spawn is inside it, and removes it when the run ends: on success, on
// failure, and on SIGINT or SIGTERM. KEEP_TEST_TMP=1 keeps it and prints its path. A test file run
// on its own (node --test file) has no root and uses os.tmpdir() as before.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** The root's name: <tmp>/futures-trading-harness-tests-<pid>-<random>. */
const ROOT_PREFIX = 'futures-trading-harness-tests-';
/** The environment variable a run sets to its root (tests may check they are inside it). */
const ROOT_ENV = 'FTH_TEST_TMP_ROOT';
/** Set to 1 to keep the root after the run. */
const KEEP_ENV = 'KEEP_TEST_TMP';

const keepRequested = (env = process.env) => env[KEEP_ENV] === '1';
/** CI set to true or 1 (any case): nothing else shares the temporary directory there. */
const inCI = (env = process.env) => /^(true|1)$/i.test(String(env.CI ?? '').trim());

function createRoot(parent = os.tmpdir(), pid = process.pid) {
  return fs.mkdtempSync(path.join(parent, `${ROOT_PREFIX}${pid}-`));
}

/**
 * `env` with the temporary directory moved to `root`. Without NODE_TEST_CONTEXT: a run is always a
 * top-level node --test, even when started from inside a test.
 */
function rootEnv(root, env = process.env) {
  const { NODE_TEST_CONTEXT: _, ...rest } = env;
  return { ...rest, TMPDIR: root, TMP: root, TEMP: root, [ROOT_ENV]: root };
}

/** Every name in `parent`, sorted ([] when it can't be read). */
function listEntries(parent) {
  try { return fs.readdirSync(parent).sort(); } catch { return []; }
}

/** Names the system itself makes in the temporary directory at any time (a CI runner's systemd): never a test's. */
const SYSTEM_ENTRIES = [/^systemd-private-/];

/** Names in `parent` that were not there before (`before`), but `except` (the run's kept root) and the system's own. */
function leaked(parent, before, except = []) {
  const had = new Set([...before, ...except]);
  return listEntries(parent).filter(n => !had.has(n) && !SYSTEM_ENTRIES.some(re => re.test(n)));
}

/** Removes `root`, or keeps it and says where it is. Returns true when removed. */
function removeRoot(root, { keep = false, log = m => process.stderr.write(`${m}\n`) } = {}) {
  if (keep) {
    log(`${KEEP_ENV}=1: kept the test temp root ${root}`);
    return false;
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  return true;
}

/**
 * Runs `node --test files` with its temporary directory in a fresh root under `parent`, then
 * removes the root and checks nothing new with a test prefix was left in `parent`. Resolves to the
 * exit status: the tests' status, or 1 when they were killed. Every name in `parent` is noted before
 * the run; a new one afterwards is a leak. A leak fails the run when `strict`
 * (by default in CI, where nothing else shares the temporary directory); otherwise it is a warning,
 * since another test run at the same time (an older checkout) may have made those dirs. A SIGINT or
 * SIGTERM to this process is passed to the tests; the root is removed once they exit.
 */
function runTests(files, { parent = os.tmpdir(), env = process.env, stdio = 'inherit', log, signals = ['SIGINT', 'SIGTERM'], strict = inCI(env) } = {}) {
  const keep = keepRequested(env);
  const before = listEntries(parent);
  const root = createRoot(parent);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { removeRoot(root, { keep, log }); } catch (e) { (log || console.error)(`could not remove the test temp root ${root}: ${e.message}`); }
  };
  // A last resort: the root goes even if this process exits another way.
  process.once('exit', cleanup);
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--test', ...files], { stdio, env: rootEnv(root, env) });
    const forward = {};
    for (const sig of signals) {
      forward[sig] = () => { if (child.exitCode === null && child.signalCode === null) child.kill(sig); };
      process.on(sig, forward[sig]);
    }
    const done = status => {
      for (const sig of signals) process.removeListener(sig, forward[sig]);
      cleanup();
      process.removeListener('exit', cleanup);
      const left = leaked(parent, before, keep ? [path.basename(root)] : []);
      if (left.length) {
        const what = strict ? 'the test run left' : 'warning: the test run (or another run at the same time) left';
        (log || (m => process.stderr.write(`${m}\n`)))(`${what} ${left.length} new entr${left.length === 1 ? 'y' : 'ies'} outside its root in ${parent}: ${left.slice(0, 10).join(', ')}`);
        if (strict) status = status || 1;
      }
      resolve({ status, root, kept: keep, leaked: left });
    };
    child.on('error', e => { (log || console.error)(`could not start the tests: ${e.message}`); done(1); });
    child.on('exit', (code, signal) => done(signal || code === null ? 1 : code));
  });
}

module.exports = { ROOT_PREFIX, ROOT_ENV, KEEP_ENV, keepRequested, inCI, createRoot, rootEnv, listEntries, leaked, removeRoot, runTests };
