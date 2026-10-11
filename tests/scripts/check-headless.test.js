'use strict';

// scripts/check-headless.js end to end with a stand-in harness CLI (tests/fixtures/fake-harness.js)
// that calls the real harness tools server with the run's environment and prints each harness's
// transcript format. The owner runs it against the real CLIs.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'check-headless.js');
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js');

const run = (args, extra = {}) => {
  const home = tmpDir();
  const env = { ...process.env, HOME: home, FTH_HOME: home, ...extra };
  delete env.FTH_REPLAY_NOW;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 120000 });
};

test('check-headless: every harness reaches the harness tools and the role; the shell result is reported', { timeout: 180000 }, () => {
  const r = run(['--bin', FAKE]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  for (const h of ['claude', 'codex', 'qwen']) assert.match(r.stdout, new RegExp(`^${h}: ok$`, 'm'));
  assert.strictEqual((r.stdout.match(/harness tool blackouts_list: answered/g) || []).length, 3);
  assert.strictEqual((r.stdout.match(/harness tool strategies_list: answered/g) || []).length, 3);
  assert.match(r.stdout, /subagent: risk-manager \(the harness role\), answered PROBE-ROLE-OK/);
  assert.match(r.stdout, /shell `node -e 1`: refused/);
  assert.match(r.stdout, /shell `node -e 1`: ran/);
});

test('check-headless: a run that delegates to no role fails; bad arguments are refused', { timeout: 120000 }, () => {
  const r = run(['--harness', 'claude', '--bin', FAKE], { FAKE_PROBE: 'no-role' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /claude: NOT ok[\s\S]*subagent: none delegated/);
  assert.strictEqual(run(['--harness', 'cursor']).status, 2);
  assert.match(run(['--bogus', 'x']).stderr, /usage: check-headless\.js/);
  assert.match(run(['--timeout', '0']).stderr, /--timeout/);
});
