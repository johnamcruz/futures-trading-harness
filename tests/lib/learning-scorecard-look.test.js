'use strict';

// A learning run's scorecard follows the learning split and ledger (learning/scorecard-look.js), not the prop schedule.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const { scoreRun, writeScorecard } = require('../../scripts/lib/replay/scorecard');
const { startLearningRun } = require('../../scripts/lib/learning/run-gate');
const { ledgerPath } = require('../../scripts/lib/learning/looks');
const { learningLook } = require('../../scripts/lib/learning/scorecard-look');

/** A finished one-day run with no cycles: enough to be scored. `learning` starts it through the gate (an object of its options). */
function makeRun(day, { learning = null, runId = 'lr1' } = {}) {
  const base = tmpDir();
  const home = path.join(base, 'replays', runId);
  const runDir = path.join(home, 'replay', runId);
  for (const d of [runDir, path.join(home, 'logs'), path.join(runDir, 'broker')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ v: 1, runId, hash: 'c'.repeat(64), harness: 'custom', model: 'm-1', daysDone: [day], finished: true }));
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ symbols: ['MNQ'], timeframe: 3, account: '7', bars: 3000 }));
  const t = Date.parse(`${day}T20:50:02Z`);
  fs.writeFileSync(path.join(runDir, `${day}.jsonl`), `${JSON.stringify({ v: 1, t: new Date(t).toISOString(), day, kind: 'eod', ran: [], cycles: [], refusals: [], errors: [], bars: [], trades: [], since: new Date(t - 180000).toISOString() })}\n`);
  fs.writeFileSync(path.join(runDir, 'broker', 'journal.jsonl'), '');
  const env = { HOME: base };
  process.env.HOME = base; // the scorecard reads the canonical ledger of the current home
  if (learning) startLearningRun(home, { runDir, runId, env, endOfDay: true, ...learning });
  return { home, runDir, env, base };
}
const SEALED = day => ({ ...when(day), candidate: 'c1', evaluation: 'e1', arm: 'without', config: 'a'.repeat(64) });
const next = d => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const when = day => ({ from: day, to: next(day) });
const score = (runDir, extra = {}) => scoreRun(runDir, { strategies: [], accounts: [], ...extra });

test('conflict: the prop schedule alone refuses a practice-train month (select block) and 2020 (before its start)', () => {
  for (const day of ['2023-08-08', '2020-03-03']) {
    const { runDir } = makeRun(day);
    assert.throws(() => score(runDir), /is refused/, day);
  }
});

test('a practice-train learning run writes its scorecard, in 2023-08 and in 2020, with no look recorded', () => {
  for (const day of ['2023-08-08', '2020-03-03']) {
    const { runDir, env } = makeRun(day, { learning: when(day) });
    const out = writeScorecard(runDir, { strategies: [], accounts: [] });
    assert.ok(fs.existsSync(out.file), day);
    assert.strictEqual(out.summary.look.role, 'practice-train');
    assert.ok(!fs.existsSync(ledgerPath(env)), 'practice-train takes no look');
  }
});

test('a practice-validate run scores through the validate look the gate took, and takes no other', () => {
  const { runDir, env } = makeRun('2024-09-10', { learning: { ...when('2024-09-10'), validate: true } });
  const before = fs.readFileSync(ledgerPath(env), 'utf8');
  const out = writeScorecard(runDir, { strategies: [], accounts: [], look: { ledgerFile: path.join(tmpDir(), 'prop-ledger.jsonl') } });
  assert.strictEqual(out.summary.look.role, 'practice-validate');
  assert.strictEqual(fs.readFileSync(ledgerPath(env), 'utf8'), before);
});

test('a test-window run needs its recorded look: with it, scored; with the look gone from the ledger, refused', () => {
  const { runDir, env } = makeRun('2025-03-04', { learning: SEALED('2025-03-04') });
  assert.strictEqual(score(runDir).summary.look.role, 'test');
  fs.writeFileSync(ledgerPath(env), '{"kind":"look","evaluation":"other","candidate":"c1","purpose":"judging","runId":"zz","role":"test","from":"2025-01-02","to":"2025-01-03"}\n');
  assert.throws(() => score(runDir), /no judging look at test in the learning ledger/);
  fs.rmSync(ledgerPath(env));
  assert.throws(() => score(runDir), /can't be read/);
});

test('a reasoning-fix look at test hides outcomes', () => {
  const { runDir } = makeRun('2025-03-04', { learning: { ...SEALED('2025-03-04'), reasoningFix: true } });
  assert.match(score(runDir).summary.outcomes, /hidden/);
});

test('a record whose role is not the role of the run\'s days is refused, never freed', () => {
  const { runDir, home } = makeRun('2023-08-08', { learning: when('2023-08-08') });
  for (const dir of [runDir, home]) {
    const f = path.join(dir, 'learning-run.json');
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...rec, role: 'practice-validate' }));
  }
  assert.throws(() => score(runDir), /not the practice-validate window/);
  const t = makeRun('2025-03-04', { learning: SEALED('2025-03-04') });
  const f = path.join(t.runDir, 'learning-run.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), role: 'practice-train' }));
  assert.throws(() => score(t.runDir), /not the practice-train window/);
});

test('a run declared not learning, or with no record, still follows the prop schedule', () => {
  const day = '2025-03-04'; // prop schedule: out-of-sample, judging only: a default tuning look is refused
  const none = makeRun(day);
  assert.throws(() => score(none.runDir), /is refused/);
  const off = makeRun('2023-08-08');
  fs.writeFileSync(path.join(off.runDir, 'learning-run.json'), JSON.stringify({ learning: false, role: null, look: null, hideOutcomes: false }));
  assert.throws(() => score(off.runDir), /is refused/);
  const train = makeRun('2022-03-02'); // prop train: a tuning look is allowed, as before
  assert.ok(score(train.runDir).summary.look.purpose);
});

test('learningLook: null for a run with no record, the look for a practice-train run', () => {
  assert.strictEqual(learningLook(makeRun('2023-08-08').runDir, { manifest: {}, days: { '2023-08-08': [] } }), null);
  const { runDir } = makeRun('2023-08-08', { learning: when('2023-08-08') });
  assert.strictEqual(learningLook(runDir, { manifest: { runId: 'lr1' }, days: { '2023-08-08': [] } }).role, 'practice-train');
  assert.throws(() => learningLook(runDir, { manifest: { runId: 'lr1' }, days: {} }), /no days/);
});

test('a forged record naming a forged ledger cannot free a sealed run: only the canonical ledger counts', () => {
  const { runDir, home, base } = makeRun('2025-03-04', { learning: SEALED('2025-03-04') });
  const forged = path.join(base, 'forged.jsonl');
  fs.writeFileSync(forged, `${JSON.stringify({ kind: 'look', evaluation: 'e1', candidate: 'c1', purpose: 'judging', runId: 'lr1', role: 'test', from: '2025-03-04', to: '2025-03-05' })}\n`);
  fs.writeFileSync(ledgerPath({ HOME: base }), '');
  for (const dir of [runDir, home]) {
    const f = path.join(dir, 'learning-run.json');
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ledger: forged }));
  }
  assert.throws(() => score(runDir), /not the canonical learning ledger/);
});

test('the schedule: a held-back run is read only while its sealed windows are the ones it started under and the sealed rule holds', () => {
  const { runDir, env } = makeRun('2025-03-04', { learning: SEALED('2025-03-04') });
  const run = { manifest: { runId: 'lr1' }, days: { '2025-03-04': {} } };
  assert.strictEqual(learningLook(runDir, run, { env }).role, 'test');
  // The run's record says it started under another sealed learning part: refused.
  const file = path.join(runDir, 'learning-run.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, schedule: { ...rec.schedule, version: 'v0', sealed: { ...rec.schedule.sealed, learning: 'e'.repeat(64) } } }));
  assert.throws(() => learningLook(runDir, run, { env }), /started under schedule v0, whose sealed learning windows are not the current schedule's/);
  fs.writeFileSync(file, JSON.stringify(rec));
  // A sealed look in the ledger under another sealed part: the sealed rule refuses the read.
  const other = { version: 'v0', hash: 'f'.repeat(64), sealed: { learning: 'e'.repeat(64), prop: 'd'.repeat(64) } };
  fs.appendFileSync(ledgerPath(env), `${JSON.stringify({ kind: 'look', role: 'final', evaluation: 'x', runId: 'x', from: '2026-02-02', to: '2026-02-03', schedule: other })}\n`);
  assert.throws(() => learningLook(runDir, run, { env }), /sealed learning windows .* schedule v0/);
});

test('a record from before fingerprints is read under LEGACY: refused when the current sealed learning part differs', () => {
  const { runDir, env } = makeRun('2025-03-04', { learning: SEALED('2025-03-04') });
  const run = { manifest: { runId: 'lr1' }, days: { '2025-03-04': {} } };
  const file = path.join(runDir, 'learning-run.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete rec.schedule;
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.strictEqual(learningLook(runDir, run, { env }).role, 'test'); // the current sealed part is LEGACY's
  const schedule = require('../../scripts/lib/schedule');
  const real = schedule.current;
  const cur = real();
  schedule.current = () => ({ ...cur, version: 'v2', fingerprint: { ...cur.fingerprint, sealed: { ...cur.fingerprint.sealed, learning: 'e'.repeat(64) } } });
  try {
    assert.throws(() => learningLook(runDir, run, { env }), /started under schedule v1, whose sealed learning windows are not the current schedule's/);
  } finally { schedule.current = real; }
});
