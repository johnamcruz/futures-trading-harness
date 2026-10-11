'use strict';

// The runner's lock (scripts/lib/runner-lock.js): a holder is live only if its pid exists and is an
// autotrader, so a pid reused by another program (after a crash or a reboot) is not taken for a runner.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmpDir } = require('../helpers');
const { lockFile, processCommand, lockHolderAlive, liveRunner } = require('../../scripts/lib/runner-lock');

test('processCommand: a live process\'s command, \'\' when it is gone, null when it can\'t be told', async () => {
  assert.match(processCommand(process.pid), /node/);
  const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise(r => gone.on('exit', r));
  assert.strictEqual(processCommand(gone.pid), '', 'an exited process');
  assert.strictEqual(processCommand(2 ** 30, { spawn: () => ({ error: new Error('no ps') }) }), null);
  assert.strictEqual(processCommand(2 ** 30, { spawn: () => ({ status: 1, stdout: '', stderr: 'ps: permission denied' }) }), null, 'ps complaining is unknown, not gone');
  assert.strictEqual(processCommand(2 ** 30, { spawn: () => ({ status: 1, stdout: '', stderr: '' }) }), '', 'a silent exit 1 is gone');
});

test('lockHolderAlive: an autotrader is live; another program, a dead pid, itself, or a bad lock is not', () => {
  const live = { pid: process.pid };
  assert.strictEqual(lockHolderAlive(live, { self: null, command: () => 'node /x/scripts/autotrader.js --config a.json' }), true);
  assert.strictEqual(lockHolderAlive(live, { self: null, command: () => '/sbin/launchd' }), false, 'a reused pid');
  for (const cmd of ['vim notes-about-autotrader.txt', 'node /x/scripts/autotrader.jsx', 'tail -f autotrader.log']) {
    assert.strictEqual(lockHolderAlive(live, { self: null, command: () => cmd }), false, cmd);
  }
  for (const cmd of ['C:\\h\\scripts\\autotrader.js', 'node autotrader.js --config a.json', 'node scripts/autotrader --config a.json', 'node /x/scripts/autotrader.js']) {
    assert.strictEqual(lockHolderAlive(live, { self: null, command: () => cmd }), true, cmd);
  }
  assert.strictEqual(lockHolderAlive(live, { self: null, command: () => null }), true, 'unknown command: assume live (fail closed)');
  assert.strictEqual(lockHolderAlive(live), false, 'its own lock');
  assert.strictEqual(lockHolderAlive({ pid: 2 ** 30 }, { self: null, command: () => 'autotrader' }), false, 'gone');
  for (const bad of [null, {}, { pid: 0 }, { pid: -1 }, { pid: '12' }, { pid: 1.5 }]) assert.strictEqual(lockHolderAlive(bad, { self: null }), false, JSON.stringify(bad));
});

test('liveRunner: the pid in <FTH_HOME>/autotrader.lock when an autotrader holds it', async () => {
  const home = tmpDir();
  const env = { FTH_HOME: home };
  assert.strictEqual(lockFile(env), path.join(home, 'autotrader.lock'));
  assert.strictEqual(liveRunner(env), null, 'no lock');
  fs.writeFileSync(lockFile(env), 'not json');
  assert.strictEqual(liveRunner(env), null);
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/x/scripts/autotrader.js'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(lockFile(env), JSON.stringify({ pid: runner.pid }));
    assert.strictEqual(liveRunner(env), runner.pid);
    fs.writeFileSync(lockFile(env), JSON.stringify({ pid: process.pid }));
    assert.strictEqual(liveRunner(env), null, 'a pid that is not an autotrader');
  } finally {
    runner.kill();
  }
  await new Promise(r => runner.on('exit', r));
  fs.writeFileSync(lockFile(env), JSON.stringify({ pid: runner.pid }));
  assert.strictEqual(liveRunner(env), null, 'a stale lock');
});
