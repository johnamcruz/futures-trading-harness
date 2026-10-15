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
  const env = { HOME: tmp(), FTH_HOME: tmp() };
  const opts = { from: D('2022-03-01T00:00:00Z'), to: D('2022-04-01T00:00:00Z'), runId: 'p1', env };
  const r = G.startLearningRun(home, opts);
  assert.deepStrictEqual([r.learning, r.role, r.look, r.hideOutcomes], [true, 'practice-train', null, false]);
  assert.strictEqual(G.readLearningRun(home).role, 'practice-train');
  assert.ok(!fs.existsSync(path.join(env.HOME, '.futures-trading-harness', 'learning')), 'practice takes no look');
  assert.throws(() => G.checkLearningRun({ ...opts, candidate: 'c' }), /practice-train is practice/);
  assert.throws(() => G.checkLearningRun({ ...opts, validate: true }), /practice-train is practice/);
  assert.throws(() => G.startLearningRun(home, { ...opts, learning: false }), /this run started as/, 'a resume keeps what it started as');
});

test('spanning windows or outside the split is refused; learning false is recorded and takes no flag', () => {
  const env = { HOME: tmp(), FTH_HOME: tmp() };
  assert.throws(() => G.checkLearningRun({ from: D('2024-06-20T00:00:00Z'), to: D('2024-07-10T00:00:00Z'), runId: 'x', env }), /spans practice-train \+ practice-validate/);
  assert.throws(() => G.checkLearningRun({ from: D('2027-02-01T00:00:00Z'), to: D('2027-02-10T00:00:00Z'), runId: 'x', env }), /"learning": false/);
  const home = tmp();
  assert.deepStrictEqual(G.startLearningRun(home, { from: D('2027-02-01T00:00:00Z'), to: D('2027-02-10T00:00:00Z'), runId: 'x', learning: false, env }).learning, false);
  assert.strictEqual(G.readLearningRun(home).learning, false);
  assert.throws(() => G.checkLearningRun({ from: D('2026-10-07T00:00:00Z'), to: D('2026-10-08T00:00:00Z'), runId: 'x', learning: false, candidate: 'c' }), /takes no candidate/);
});

test('validate needs its flag and is counted; sealed windows need a candidate and an evaluation and take the look first', () => {
  const env = { HOME: tmp(), FTH_HOME: tmp() };
  const val = { from: D('2024-08-01T00:00:00Z'), to: D('2024-09-01T00:00:00Z'), runId: 'v1', env };
  assert.throws(() => G.checkLearningRun(val), /need the validate flag/);
  const v = G.startLearningRun(tmp(), { ...val, validate: true });
  assert.deepStrictEqual([v.role, v.look.purpose, v.taken.budget], ['practice-validate', 'validate', null]);
  const ledger = path.join(env.HOME, '.futures-trading-harness', 'learning', 'looks.jsonl');
  assert.strictEqual(fs.readFileSync(ledger, 'utf8').trim().split('\n').length, 1, 'counted');
  const sealed = { from: D('2025-03-03T00:00:00Z'), to: D('2025-03-08T00:00:00Z'), runId: 't1', env, config: 'c0nf' };
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
  const fin = { from: D('2026-03-02T00:00:00Z'), to: D('2026-03-07T00:00:00Z'), runId: 'f2', env, candidate: 'champ', evaluation: 'fin', config: 'c0nf' };
  assert.throws(() => G.checkLearningRun(fin), /no test pass/);
});

test('no way around the sealed windows: "learning": false on a test or final day, a learning run without its end of day', () => {
  const env = { HOME: tmp(), FTH_HOME: tmp() };
  for (const [from, to] of [['2024-08-05', '2024-08-09'], ['2024-06-28', '2024-07-03'], ['2025-03-03', '2025-03-08'], ['2026-06-01', '2026-06-02'], ['2024-12-30', '2025-01-03'], ['2026-12-28', '2027-01-08']]) {
    assert.throws(() => G.checkLearningRun({ from: D(`${from}T00:00:00Z`), to: D(`${to}T00:00:00Z`), runId: 'x', learning: false, env }), /"learning": false on a practice-validate, test or final day/, from);
  }
  assert.strictEqual(G.checkLearningRun({ from: D('2027-02-01T00:00:00Z'), to: D('2027-02-10T00:00:00Z'), runId: 'x', learning: false, env }).learning, false);
  assert.strictEqual(G.checkLearningRun({ from: D('2019-02-01T00:00:00Z'), to: D('2019-02-10T00:00:00Z'), runId: 'x', learning: false, env }).learning, false);
  assert.throws(() => G.checkLearningRun({ from: D('2022-03-01T00:00:00Z'), to: D('2022-04-01T00:00:00Z'), runId: 'p', endOfDay: false, env }), /keeps its end of day/);
});

test('one ledger: the run keeps its ledger\'s path, and the ledger is the default home\'s, whatever FTH_HOME; a resume under another home is refused; the decision is kept with the run record', () => {
  const home = tmp();
  const runDir = path.join(home, 'replay', 't1');
  const sealed = { from: D('2025-03-03T00:00:00Z'), to: D('2025-03-08T00:00:00Z'), runId: 't1', candidate: 'champ', evaluation: 'ev1', runDir, config: 'c0nf' };
  const env = { HOME: tmp(), FTH_HOME: tmp() };
  G.startLearningRun(home, { ...sealed, env });
  assert.strictEqual(G.readLearningRun(runDir).ledger, path.join(env.HOME, '.futures-trading-harness', 'learning', 'looks.jsonl'));
  assert.deepStrictEqual(G.readLearningRun(home), G.readLearningRun(runDir), 'the run home keeps a copy for the cycle\'s tools');
  // Another FTH_HOME, the same home folder: the same ledger, so the resume runs (no fresh budget).
  assert.strictEqual(G.startLearningRun(home, { ...sealed, env: { ...env, FTH_HOME: tmp() } }).taken.repeat, true);
  assert.throws(() => G.startLearningRun(home, { ...sealed, env: { HOME: tmp(), FTH_HOME: env.FTH_HOME } }), /one ledger \(the same home\)/);
  // The run record decides, even when the home's copy is gone.
  fs.rmSync(path.join(home, 'learning-run.json'));
  assert.throws(() => G.startLearningRun(home, { ...sealed, evaluation: 'ev2', env }), /a resume keeps it/);
});

/** scripts/replay.js run on a config for [start, end), with flags: { status, stdout, stderr, user, live }. */
function replayRun(start, end, flags = [], over = {}) {
  const user = tmp();
  const config = path.join(user, 'replay.json');
  fs.writeFileSync(config, JSON.stringify({
    runId: 'r', workDir: path.join(user, 'replays'), broker: 'replaymock', start, end, premarket: false,
    autotrader: { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3 }, ...over,
  }));
  const live = path.join(user, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: { replaymock: { command: ['true'], replay: true, journalEnv: 'MOCK_JOURNAL', env: ['MOCK_JOURNAL'] } } }));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'replay.js'), 'run', '--config', config, ...flags], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: user, FTH_HOME: live }, timeout: 60000 });
  return { ...r, user, live };
}

test('scripts/replay.js run: the gate decides before the run home is seeded', () => {
  const seeded = r => fs.existsSync(path.join(r.user, 'replays', 'r'));
  const cases = [
    ['2025-03-03T14:30:00Z', '2025-03-03T15:00:00Z', [], {}, /learning run refused: test is sealed: name the candidate/],
    ['2025-03-03T14:30:00Z', '2025-03-03T15:00:00Z', ['--candidate', 'champ'], {}, /--evaluation/],
    ['2024-08-05T14:30:00Z', '2024-08-05T15:00:00Z', [], {}, /practice-validate months need the validate flag/],
    ['2025-03-03T14:30:00Z', '2025-03-03T15:00:00Z', [], { learning: false }, /"learning": false on a practice-validate, test or final day/],
    ['2022-03-09T14:30:00Z', '2022-03-09T15:00:00Z', [], { endOfDay: false }, /keeps its end of day/],
    ['2026-03-02T14:30:00Z', '2026-03-02T15:00:00Z', ['--candidate', 'champ', '--evaluation', 'fin'], {}, /look refused: final: candidate champ has no test pass/],
  ];
  for (const [start, end, flags, over, why] of cases) {
    const r = replayRun(start, end, flags, over);
    assert.strictEqual(r.status, 1, `${start} ${flags.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, why);
    assert.ok(!seeded(r), `${start}: nothing seeded`);
  }
  // A practice-train run passes the gate: its decision kept with the run record before the first cycle.
  const ok = replayRun('2022-03-09T14:30:00Z', '2022-03-09T15:00:00Z');
  assert.match(ok.stdout, /learning: practice-train/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ok.user, 'replays', 'r', 'replay', 'r', 'learning-run.json'), 'utf8')).role, 'practice-train');
  // A validate run with its flag: logged and counted in the one ledger.
  const val = replayRun('2024-08-05T14:30:00Z', '2024-08-05T15:00:00Z', ['--validate']);
  assert.match(val.stdout, /learning: practice-validate, validate look r/);
  assert.strictEqual(fs.readFileSync(path.join(val.user, '.futures-trading-harness', 'learning', 'looks.jsonl'), 'utf8').trim().split('\n').length, 1);
  // A judging run's look names its arm and its setup (replay/config.js setupHash), from the config alone.
  const live = replayRun('2025-03-03T14:30:00Z', '2025-03-03T15:00:00Z', ['--candidate', 'champ', '--evaluation', 'ev1']);
  const [taken] = fs.readFileSync(path.join(live.user, '.futures-trading-harness', 'learning', 'looks.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual([taken.arm, /^[0-9a-f]{64}$/.test(taken.config), taken.role], ['without', true, 'test']);
});

test('setupHash: the same for two runs of one setup (another runId, learning flag), another for another setup', () => {
  const { resolveReplay, setupHash } = require('../../scripts/lib/replay/config');
  const ROOT = path.join(__dirname, '..', '..');
  const user = tmp();
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'live') };
  const raw = o => ({ runId: 'a', workDir: path.join(user, 'replays'), broker: 'replaymock', start: '2025-03-03T14:30:00Z', end: '2025-03-03T15:00:00Z', premarket: false, autotrader: { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3 }, ...o });
  const h = o => setupHash(resolveReplay(raw(o), { baseDir: user, env, root: ROOT }));
  assert.strictEqual(h({}), h({ runId: 'b', learning: true }));
  assert.notStrictEqual(h({}), h({ autotrader: { ...raw({}).autotrader, timeframe: 5 } }));
  assert.notStrictEqual(h({}), h({ end: '2025-03-03T16:00:00Z' }));
});


test('setup-focused practice: allowed on practice-train and practice-validate, kept on resume; refused on test, final and runs not learning', () => {
  const env = { FTH_HOME: tmp() };
  const practice = { mode: 'setup-focus', setupTf: 15, quietSample: 0.15, seed: 1, levels: 'key', reactions: ['rejected', 'broke'] };
  const train = { from: D('2022-03-01T00:00:00Z'), to: D('2022-04-01T00:00:00Z'), runId: 'sp1', env, practice };
  assert.deepStrictEqual(G.checkLearningRun(train).practice, practice);
  const home = tmp();
  G.startLearningRun(home, train);
  assert.deepStrictEqual(G.readLearningRun(home).practice, practice, 'kept with the run (the learning report reads it)');
  assert.throws(() => G.startLearningRun(home, { ...train, practice: null }), /this run started as/, 'a resume keeps it');
  assert.throws(() => G.startLearningRun(home, { ...train, practice: { ...practice, seed: 2 } }), /this run started as/);
  // A run started before practice existed (no field) resumes as it was.
  const old = tmp();
  G.startLearningRun(old, { ...train, practice: null, runId: 'sp0' });
  assert.strictEqual(G.readLearningRun(old).practice, undefined);
  assert.doesNotThrow(() => G.startLearningRun(old, { ...train, practice: null, runId: 'sp0' }));
  assert.strictEqual(G.checkLearningRun({ ...train, practice: null }).practice, undefined, 'none: no field');
  assert.deepStrictEqual(G.checkLearningRun({ from: D('2024-08-01T00:00:00Z'), to: D('2024-09-01T00:00:00Z'), runId: 'sv', env, validate: true, practice }).practice, practice);
  assert.throws(() => G.checkLearningRun({ from: D('2025-03-01T00:00:00Z'), to: D('2025-04-01T00:00:00Z'), runId: 'st', env, candidate: 'c', evaluation: 'e', practice }), /practice runs only on practice-train or practice-validate \(this run: test\)/);
  assert.throws(() => G.checkLearningRun({ from: D('2026-03-01T00:00:00Z'), to: D('2026-04-01T00:00:00Z'), runId: 'sf', env, candidate: 'c', evaluation: 'e', reasoningFix: true, practice }), /this run: final/);
  assert.throws(() => G.checkLearningRun({ from: D('2027-02-01T00:00:00Z'), to: D('2027-02-10T00:00:00Z'), runId: 'sn', env, learning: false, practice }), /not a learning run/);
});
