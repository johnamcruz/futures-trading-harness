'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmpDir } = require('../helpers');
const S = require('../../scripts/lib/train/state');

const LIMITS = { maxIterations: 2, maxModelCalls: 10, maxWallMinutes: 60 };

test('loopPaths: everything in the harness home\'s training folder', () => {
  const home = tmpDir();
  const user = tmpDir();
  const p = S.loopPaths({ FTH_HOME: home, HOME: user }, 'l1');
  // The ledger is the default home's, whatever FTH_HOME says: another home never starts a fresh look budget.
  assert.strictEqual(S.loopPaths({ FTH_HOME: tmpDir(), HOME: user }, 'l2').ledger, p.ledger);
  assert.deepStrictEqual([p.lock, p.ledger, p.state, p.archive, p.iter(3)], [
    path.join(home, 'training', 'loop.lock'), path.join(user, '.futures-trading-harness', 'training', 'looks.jsonl'), path.join(home, 'training', 'l1', 'state.json'),
    path.join(home, 'training', 'l1', 'archive.jsonl'), path.join(home, 'training', 'l1', 'iter-3'),
  ]);
});

test('lock: one loop at a time; a live holder refuses, a dead one\'s lock is taken over, release frees it', async () => {
  const p = S.loopPaths({ FTH_HOME: tmpDir() }, 'l1');
  const release = S.acquireLock(p, { loopId: 'l1' });
  assert.throws(() => S.acquireLock(p, { loopId: 'l2', pid: process.pid + 1 }), /another training loop \(pid \d+, l1\) is running/);
  release();
  assert.ok(!fs.existsSync(p.lock));
  // A holder in another process that is alive: refused; once it has exited: taken over.
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(p.lock, JSON.stringify({ pid: sleeper.pid, loopId: 'other' }));
    assert.throws(() => S.acquireLock(p, { loopId: 'l1' }), new RegExp(`pid ${sleeper.pid}, other`));
  } finally {
    sleeper.kill();
  }
  await new Promise(r => sleeper.on('exit', r));
  const again = S.acquireLock(p, { loopId: 'l1' });
  assert.strictEqual(JSON.parse(fs.readFileSync(p.lock, 'utf8')).pid, process.pid);
  // An unreadable lock is held (fails closed), never taken over.
  const p2 = S.loopPaths({ FTH_HOME: tmpDir() }, 'l1');
  fs.mkdirSync(p2.training, { recursive: true });
  fs.writeFileSync(p2.lock, '');
  assert.throws(() => S.acquireLock(p2, { loopId: 'l1' }), /unreadable: another loop may hold it/);
  assert.deepStrictEqual(fs.readdirSync(p2.training), ['loop.lock'], 'no temporary file left');
  // A release by a process that no longer holds it leaves the holder's lock alone.
  fs.writeFileSync(p.lock, JSON.stringify({ pid: 1, loopId: 'x' }));
  again();
  assert.ok(fs.existsSync(p.lock));
});

test('openState: created once; resumed with the same config hash; another hash or loop refused', () => {
  const p = S.loopPaths({ FTH_HOME: tmpDir() }, 'l1');
  const s = S.openState(p, { loopId: 'l1', hash: 'a'.repeat(64) });
  s.modelCalls = 4;
  S.saveState(p, s);
  assert.strictEqual(S.openState(p, { loopId: 'l1', hash: 'a'.repeat(64) }).modelCalls, 4);
  assert.throws(() => S.openState(p, { loopId: 'l1', hash: 'b'.repeat(64) }), /another config/);
  assert.throws(() => S.openState(p, { loopId: 'l9', hash: 'a'.repeat(64) }), /belongs to loop l1/);
  fs.writeFileSync(p.state, '{');
  assert.throws(() => S.openState(p, { loopId: 'l1', hash: 'a'.repeat(64) }), /unreadable/);
});

test('budgetLeft: model calls across resumes, wall time this run, iterations before a new one starts', () => {
  const s = { iterations: [{ done: true }], modelCalls: 9 };
  assert.strictEqual(S.budgetLeft(s, LIMITS, { startedMs: 0, nowMs: 1000 }), null);
  S.spend(s, 1);
  assert.match(S.budgetLeft(s, LIMITS, { startedMs: 0, nowMs: 1000 }), /max model calls reached \(10 of 10\)/);
  assert.match(S.budgetLeft({ iterations: [], modelCalls: 0 }, LIMITS, { startedMs: 0, nowMs: 3600000 }), /max wall time/);
  assert.match(S.budgetLeft({ iterations: [{ done: true }, { done: true }], modelCalls: 0 }, LIMITS, { startedMs: 0, nowMs: 0, starting: true }), /max iterations reached \(2 of 2\)/);
  assert.strictEqual(S.budgetLeft({ iterations: [{ done: true }, { done: true }], modelCalls: 0 }, LIMITS, { startedMs: 0, nowMs: 0 }), null, 'a running iteration finishes');
});

test('the look ledger: a look is checked before it is logged; a refused one logs nothing; an unreadable ledger allows none', () => {
  const file = path.join(tmpDir(), 'training', 'looks.jsonl');
  assert.deepStrictEqual(S.readLedger(file), []);
  S.logLook(file, { candidate: 'l1/iter-1', purpose: 'tuning', ranges: [{ from: '2022-03-07', to: '2022-03-12' }] }, new Date('2026-10-13T00:00:00Z'));
  assert.deepStrictEqual(S.readLedger(file).map(l => [l.candidate, l.purpose, l.at]), [['l1/iter-1', 'tuning', '2026-10-13T00:00:00.000Z']]);
  // Select is for judging only; Out-of-sample's budget is spent by judging looks.
  assert.throws(() => S.logLook(file, { candidate: 'x', purpose: 'tuning', ranges: [{ from: '2023-09-11', to: '2023-09-16' }] }), /allows judging looks only/);
  assert.throws(() => S.logLook(file, { candidate: 'x', purpose: 'tuning', ranges: [{ from: '2023-06-26', to: '2023-07-04' }] }), /crosses a unit boundary/);
  // Out of sample: the parity look already spent one of 3; two more, then retired.
  const oos = { candidate: 'x', purpose: 'judging', ranges: [{ from: '2024-09-09', to: '2024-09-14' }] };
  S.logLook(file, oos);
  S.logLook(file, oos);
  assert.throws(() => S.logLook(file, oos), /retired/);
  assert.strictEqual(S.readLedger(file).length, 3);
  fs.appendFileSync(file, 'torn\n');
  assert.throws(() => S.readLedger(file), /line 4 is not a look/);
  assert.throws(() => S.logLook(file, { candidate: 'l1/iter-2', purpose: 'tuning', ranges: [{ from: '2022-03-07', to: '2022-03-12' }] }), /not a look/);
});
