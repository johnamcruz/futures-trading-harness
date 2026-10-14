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
  assert.throws(() => S.acquireLock(p2, { loopId: 'l1' }), new RegExp(`${p2.lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is unreadable, so it is taken as held\\. Remove .* by hand only when no training loop \\(scripts/train-loop\\.js\\) is running`));
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

test('takeJudgingLook: two judgings at once (two harness homes, one ledger) - exactly one takes the held-out month', async () => {
  const { spawn: run } = require('child_process');
  const STATE = path.join(__dirname, '..', '..', 'scripts', 'lib', 'train', 'state.js');
  for (let trial = 0; trial < 5; trial += 1) {
    const dir = tmpDir();
    const ledger = path.join(dir, 'training', 'looks.jsonl');
    const startAt = Date.now() + 400;
    const child = k => new Promise(resolve => {
      const code = `const S = require(${JSON.stringify(STATE)}); while (Date.now() < ${startAt}); try { S.takeJudgingLook(${JSON.stringify(ledger)}, { candidate: 'loop${k}/x', purpose: 'judging', ranges: [{ from: '2023-09-13', to: '2023-09-14' }] }, { snapshot: ${JSON.stringify(path.join(dir, `snap${k}.jsonl`))} }); process.stdout.write('took'); } catch (e) { process.stdout.write('refused: ' + e.message); }`;
      const p = run(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      p.stdout.on('data', d => { out += d; });
      p.on('exit', () => resolve(out));
    });
    const outs = await Promise.all([child(1), child(2)]);
    assert.strictEqual(outs.filter(o => o === 'took').length, 1, outs.join(' | '));
    assert.ok(outs.some(o => /refused: (held-out months already used for judging: 2023-09|the look ledger is locked)/.test(o)), outs.join(' | '));
    assert.strictEqual(S.readLedger(ledger).filter(l => l.purpose === 'judging').length, 1);
  }
});

test('takeJudgingLook: a used month refused (recorded looks too); the snapshot is the ledger before the look; a held lock refuses', () => {
  const dir = tmpDir();
  const ledger = path.join(dir, 'training', 'looks.jsonl');
  const snap = path.join(dir, 'snap.jsonl');
  const look = { candidate: 'l/x', purpose: 'judging', ranges: [{ from: '2023-09-13', to: '2023-09-14' }] };
  S.logLook(ledger, { candidate: 'l/t', purpose: 'tuning', ranges: [{ from: '2022-03-07', to: '2022-03-12' }] });
  const before = fs.readFileSync(ledger, 'utf8');
  S.takeJudgingLook(ledger, look, { snapshot: snap });
  assert.strictEqual(fs.readFileSync(snap, 'utf8'), before);
  assert.throws(() => S.takeJudgingLook(ledger, { ...look, candidate: 'other/y' }, { snapshot: snap }), /already used for judging: 2023-09/);
  assert.throws(() => S.takeJudgingLook(ledger, { ...look, ranges: [{ from: '2024-04-22', to: '2024-04-27' }] }, { snapshot: snap }), /already used for judging: 2024-04/);
  fs.writeFileSync(`${ledger}.lock`, '');
  assert.throws(() => S.logLook(ledger, { candidate: 'l/t2', purpose: 'tuning', ranges: [{ from: '2022-03-07', to: '2022-03-12' }] }), /the look ledger is locked: .*looks\.jsonl\.lock exists[^]*Remove .*looks\.jsonl\.lock by hand only when no training loop and no evaluator run is running/);
  assert.deepStrictEqual(S.monthsOf('2023-09-25', '2023-11-02'), ['2023-09', '2023-10', '2023-11']);
});

test('takeJudgingLook: the look\'s own rules decide too - a reserve month is refused with nothing written', () => {
  const dir = tmpDir();
  const ledger = path.join(dir, 'training', 'looks.jsonl');
  const snap = path.join(dir, 'snap.jsonl');
  // 2027-H1 is reserve: no month of it was judged, so only the look's own check (prop/looks.js) refuses it.
  assert.throws(() => S.takeJudgingLook(ledger, { candidate: 'l/x', purpose: 'judging', ranges: [{ from: '2027-02-01', to: '2027-02-06' }] }, { snapshot: snap }), /look refused:[^]*reserved/);
  assert.ok(!fs.existsSync(snap), 'no snapshot');
  assert.deepStrictEqual(S.readLedger(ledger), [], 'nothing logged');
  // The look names its loop and proposal; a resume finds only its own.
  const look = { candidate: 'l1/p1', purpose: 'judging', ranges: [{ from: '2023-09-13', to: '2023-09-14' }] };
  S.takeJudgingLook(ledger, look, { snapshot: snap, own: { loopId: 'l1', proposalId: 'p1' } });
  assert.deepStrictEqual([S.readLedger(ledger)[0].loopId, S.readLedger(ledger)[0].proposalId], ['l1', 'p1']);
  assert.deepStrictEqual(S.takeJudgingLook(ledger, look, { snapshot: snap, own: { loopId: 'l1', proposalId: 'p1' }, resume: true }), { resumed: true });
  assert.throws(() => S.takeJudgingLook(ledger, look, { snapshot: snap, own: { loopId: 'l1', proposalId: 'p1' } }), /already used/, 'without the saved "started" state it is not a resume');
  assert.throws(() => S.takeJudgingLook(ledger, { ...look, candidate: 'l1/p2' }, { snapshot: snap, own: { loopId: 'l1', proposalId: 'p2' }, resume: true }), /already used/, 'another proposal never judges the month');
  assert.throws(() => S.takeJudgingLook(ledger, { ...look, candidate: 'l2/p1' }, { snapshot: snap, own: { loopId: 'l2', proposalId: 'p1' }, resume: true }), /already used/, 'another loop never judges the month');
  assert.strictEqual(S.readLedger(ledger).length, 1);
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
