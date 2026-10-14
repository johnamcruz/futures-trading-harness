'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('../../scripts/lib/learning/run-gate');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-learn-gate-'));
const D = iso => new Date(iso);

test('practice-train: no look, no flags; recorded in the run home and kept on resume', () => {
  const home = tmp();
  const env = { FTH_HOME: tmp() };
  const opts = { from: D('2022-03-01T00:00:00Z'), to: D('2022-04-01T00:00:00Z'), runId: 'p1', env };
  const r = G.startLearningRun(home, opts);
  assert.deepStrictEqual([r.learning, r.role, r.look, r.hideOutcomes], [true, 'practice-train', null, false]);
  assert.strictEqual(G.readLearningRun(home).role, 'practice-train');
  assert.ok(!fs.existsSync(path.join(env.FTH_HOME, 'learning')), 'practice takes no look');
  assert.throws(() => G.checkLearningRun({ ...opts, candidate: 'c' }), /practice-train is practice/);
  assert.throws(() => G.checkLearningRun({ ...opts, validate: true }), /practice-train is practice/);
  assert.throws(() => G.startLearningRun(home, { ...opts, learning: false }), /this run started as/, 'a resume keeps what it started as');
});

test('spanning windows or outside the split is refused; learning false is recorded and takes no flag', () => {
  const env = { FTH_HOME: tmp() };
  assert.throws(() => G.checkLearningRun({ from: D('2024-06-20T00:00:00Z'), to: D('2024-07-10T00:00:00Z'), runId: 'x', env }), /spans practice-train \+ practice-validate/);
  assert.throws(() => G.checkLearningRun({ from: D('2027-02-01T00:00:00Z'), to: D('2027-02-10T00:00:00Z'), runId: 'x', env }), /"learning": false/);
  const home = tmp();
  assert.deepStrictEqual(G.startLearningRun(home, { from: D('2027-02-01T00:00:00Z'), to: D('2027-02-10T00:00:00Z'), runId: 'x', learning: false, env }).learning, false);
  assert.strictEqual(G.readLearningRun(home).learning, false);
  assert.throws(() => G.checkLearningRun({ from: D('2026-10-07T00:00:00Z'), to: D('2026-10-08T00:00:00Z'), runId: 'x', learning: false, candidate: 'c' }), /takes no candidate/);
});

test('validate needs its flag and is counted; sealed windows need a candidate and an evaluation and take the look first', () => {
  const env = { FTH_HOME: tmp() };
  const val = { from: D('2024-08-01T00:00:00Z'), to: D('2024-09-01T00:00:00Z'), runId: 'v1', env };
  assert.throws(() => G.checkLearningRun(val), /need the validate flag/);
  const v = G.startLearningRun(tmp(), { ...val, validate: true });
  assert.deepStrictEqual([v.role, v.look.purpose, v.taken.budget], ['practice-validate', 'validate', null]);
  const ledger = path.join(env.FTH_HOME, 'learning', 'looks.jsonl');
  assert.strictEqual(fs.readFileSync(ledger, 'utf8').trim().split('\n').length, 1, 'counted');
  const sealed = { from: D('2025-03-03T00:00:00Z'), to: D('2025-03-08T00:00:00Z'), runId: 't1', env };
  assert.throws(() => G.checkLearningRun(sealed), /test is sealed: name the candidate .*--evaluation/);
  assert.throws(() => G.checkLearningRun({ ...sealed, candidate: 'c' }), /--evaluation/);
  assert.throws(() => G.checkLearningRun({ ...sealed, validate: true, candidate: 'c', evaluation: 'e' }), /sealed, not validate/);
  const home = tmp();
  const t = G.startLearningRun(home, { ...sealed, candidate: 'champ', evaluation: 'ev1' });
  assert.deepStrictEqual([t.role, t.look.purpose, t.taken.appended, t.hideOutcomes], ['test', 'judging', true, false]);
  assert.strictEqual(G.startLearningRun(home, { ...sealed, candidate: 'champ', evaluation: 'ev1' }).taken.appended, false, 'a resume spends nothing');
  const fix = G.startLearningRun(tmp(), { ...sealed, runId: 'f1', candidate: 'champ', evaluation: 'fx', reasoningFix: true });
  assert.deepStrictEqual([fix.look.purpose, fix.hideOutcomes], ['reasoning-fix', true]);
  // Final: refused before anything is written without a test pass.
  const fin = { from: D('2026-03-02T00:00:00Z'), to: D('2026-03-07T00:00:00Z'), runId: 'f2', env, candidate: 'champ', evaluation: 'fin' };
  assert.throws(() => G.checkLearningRun(fin), /no test pass/);
  // A ledger named on purpose must exist.
  assert.throws(() => G.checkLearningRun({ ...sealed, candidate: 'c', evaluation: 'e', ledgerFile: path.join(tmp(), 'typo.jsonl') }), /no ledger/);
});

test('scripts/replay.js run: a sealed run without a candidate is refused before its run home is seeded', () => {
  const user = tmp();
  const config = path.join(user, 'replay.json');
  fs.writeFileSync(config, JSON.stringify({
    runId: 'sealed', workDir: path.join(user, 'replays'), broker: 'replaymock', start: '2025-03-03T14:30:00Z', end: '2025-03-03T15:00:00Z', premarket: false,
    autotrader: { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3 },
  }));
  const live = path.join(user, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: { replaymock: { command: ['true'], replay: true } } }));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'replay.js'), 'run', '--config', config], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: user, FTH_HOME: live } });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /learning run refused: test is sealed/);
  assert.ok(!fs.existsSync(path.join(user, 'replays', 'sealed')), 'nothing seeded');
});
