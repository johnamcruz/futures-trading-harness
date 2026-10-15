'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('../../scripts/lib/learning/run-gate');
const PF = require('../fixtures/preflight');

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
  // A home without the run's record (deleted, or another workDir) under a runId that took its look is no resume.
  assert.throws(() => G.startLearningRun(tmp(), { ...sealed, candidate: 'champ', evaluation: 'ev1' }), /run t1 took its judging look in evaluation ev1 already, and this run home has no record of it .*start another runId/);
  // Refused by the check too, before any home is seeded, when the run dir is named; its resume passes.
  assert.throws(() => G.checkLearningRun({ ...sealed, candidate: 'champ', evaluation: 'ev1', runDir: tmp() }), /took its judging look in evaluation ev1 already, and this run home has no record of it/);
  assert.strictEqual(G.checkLearningRun({ ...sealed, candidate: 'champ', evaluation: 'ev1', runDir: home }).role, 'test');
  assert.strictEqual(fs.readFileSync(ledger, 'utf8').trim().split('\n').length, 2, 'nothing spent by the refusal');
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
  // The run and its look's ledger line record the schedule they were taken under (scripts/lib/schedule.js).
  const fp = require('../../scripts/lib/schedule').fingerprint();
  assert.deepStrictEqual(G.readLearningRun(runDir).schedule, fp);
  assert.deepStrictEqual(require('../../scripts/lib/prop/ledger-file').readLedger(G.readLearningRun(runDir).ledger).map(e => e.schedule), [fp]);
  // Another FTH_HOME, the same home folder: the same ledger, so the resume runs (no fresh budget).
  assert.strictEqual(G.startLearningRun(home, { ...sealed, env: { ...env, FTH_HOME: tmp() } }).taken.repeat, true);
  assert.throws(() => G.startLearningRun(home, { ...sealed, env: { HOME: tmp(), FTH_HOME: env.FTH_HOME } }), /one ledger \(the same home\)/);
  // The run record decides, even when the home's copy is gone.
  fs.rmSync(path.join(home, 'learning-run.json'));
  assert.throws(() => G.startLearningRun(home, { ...sealed, evaluation: 'ev2', env }), /a resume keeps it/);
});

/**
 * scripts/replay.js run on a config for [start, end) (a Monday), with flags: { status, stdout, stderr, user, live }. The
 * training preflight runs first (learning/preflight.js): the run's 1m bars (--bars), a 1m data lane for the 5m facts,
 * and practice-train's practice mode. `user`: an existing user folder (a resume), else a fresh one.
 */
function replayRun(start, end, flags = [], over = {}, user = tmp()) {
  const config = path.join(user, 'replay.json');
  const bars = PF.writeMinuteBars(path.join(user, 'MNQ-1m.csv'), start.slice(0, 10));
  fs.writeFileSync(config, JSON.stringify({
    runId: 'r', workDir: path.join(user, 'replays'), broker: 'replaymock', start, end, premarket: false,
    // noWeb: the fixture's custom command attested off the web (a learning run's no-web-in-replay check).
    autotrader: PF.AUTOTRADER, noWeb: true, ...(start < '2024-07-01' ? { practice: PF.PRACTICE } : {}), ...over,
  }));
  flags = [...flags, '--bars', `MNQ=${bars}`];
  const live = path.join(user, 'live');
  fs.mkdirSync(live, { recursive: true });
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
    ['2022-03-07T14:30:00Z', '2022-03-07T15:00:00Z', [], { endOfDay: false }, /keeps its end of day/],
    ['2026-03-02T14:30:00Z', '2026-03-02T15:00:00Z', ['--candidate', 'champ', '--evaluation', 'fin'], {}, /look refused: final: candidate champ has no test pass/],
  ];
  for (const [start, end, flags, over, why] of cases) {
    const r = replayRun(start, end, flags, over);
    assert.strictEqual(r.status, 1, `${start} ${flags.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, why);
    assert.ok(!seeded(r), `${start}: nothing seeded`);
  }
  // A practice-train run passes the gate: its decision kept with the run record before the first cycle.
  const ok = replayRun('2022-03-07T14:30:00Z', '2022-03-07T15:00:00Z');
  assert.match(ok.stdout, /learning: practice-train/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ok.user, 'replays', 'r', 'replay', 'r', 'learning-run.json'), 'utf8')).role, 'practice-train');
  // A validate run with its flag: logged and counted in the one ledger.
  const val = replayRun('2024-08-05T14:30:00Z', '2024-08-05T15:00:00Z', ['--validate']);
  assert.match(val.stdout, /learning: practice-validate, validate look r/);
  assert.strictEqual(fs.readFileSync(path.join(val.user, '.futures-trading-harness', 'learning', 'looks.jsonl'), 'utf8').trim().split('\n').length, 1);
  // A judging run's look names its arm and its setup (replay/config.js setupHash), from the config alone.
  const live = replayRun('2025-03-03T14:30:00Z', '2025-03-03T15:00:00Z', ['--candidate', 'champ', '--evaluation', 'ev1']);
  const [taken] = fs.readFileSync(path.join(live.user, '.futures-trading-harness', 'learning', 'looks.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual([taken.arm, /^[0-9a-f]{64}$/.test(taken.config), /^[0-9a-f]{64}$/.test(taken.setup), taken.setup !== taken.config, taken.role], ['without', true, true, true, 'test']);
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
  // The history library, by its own hash: two arms differing only in their pinned library are two setups, so an
  // evaluation refuses the second; the same library under another path is the same setup.
  const L = require('../../scripts/lib/learning/setup-library');
  const K = require('../../scripts/lib/learning/looks');
  const rec = day => ({ v: L.VERSION, validBars: 2, id: day, root: 'MNQ', day, bar: `${day}T15:00:00.000Z`, status: 'traded', side: 'long', reads: [], signature: 'bias:x', setupKey: 'setup:y', context: {}, outcome: { filled: true, R: 1, exitTime: `${day}T16:00:00.000Z` } });
  const libA = L.writeLibrary(path.join(user, 'libA'), L.buildLibraryIndex([rec('2022-03-01')], { reps: 20 }));
  const libB = L.writeLibrary(path.join(user, 'libB'), L.buildLibraryIndex([rec('2022-03-02')], { reps: 20 }));
  const copyA = path.join(user, 'copyA.json');
  fs.copyFileSync(libA, copyA);
  assert.strictEqual(h({}), h({}), 'no library: the hash it had');
  assert.notStrictEqual(h({ setupLibrary: libA }), h({}));
  assert.notStrictEqual(h({ setupLibrary: libA }), h({ setupLibrary: libB }));
  assert.strictEqual(h({ setupLibrary: libA }), h({ setupLibrary: copyA }));
  const arm = (runId, setupLibrary) => ({ evaluation: 'evL', candidate: 'champ', purpose: 'judging', runId, from: '2025-03-03', to: '2025-03-04', arm: runId === 'r-with' ? `with:${'a'.repeat(16)}` : 'without', config: h({ runId, setupLibrary }) });
  const ledger = [{ kind: 'look', ...arm('r-without', libA), role: 'test' }];
  const other = K.checkLook(arm('r-with', libB), ledger);
  assert.strictEqual(other.ok, false);
  assert.match(other.refusals.join(), /its arms differ only in their experience index/);
  assert.ok(K.checkLook(arm('r-with', libA), ledger).ok, 'the same library: a valid arm');
});


test('library display: off unless the config says true, part of the setup; a paired with/without-display comparison is an arm dimension of its own', () => {
  const crypto = require('crypto');
  const { resolveReplay, setupHash, setupBase, lookArm } = require('../../scripts/lib/replay/config');
  const { treeDigest, HARNESS_DIRS, CODE_DIRS } = require('../../scripts/lib/session/record');
  const L = require('../../scripts/lib/learning/setup-library');
  const K = require('../../scripts/lib/learning/looks');
  const ROOT = path.join(__dirname, '..', '..');
  const user = tmp();
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'live') };
  const raw = o => ({ runId: 'a', workDir: path.join(user, 'replays'), broker: 'replaymock', start: '2025-03-03T14:30:00Z', end: '2025-03-03T15:00:00Z', premarket: false, autotrader: { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3 }, ...o });
  const run = o => resolveReplay(raw(o), { baseDir: user, env, root: ROOT });
  const rec = day => ({ v: L.VERSION, validBars: 2, id: day, root: 'MNQ', day, bar: `${day}T15:00:00.000Z`, status: 'traded', side: 'long', reads: [], signature: 'bias:x', setupKey: 'setup:y', context: {}, outcome: { filled: true, R: 1, exitTime: `${day}T16:00:00.000Z` } });
  const libA = L.writeLibrary(path.join(user, 'libA'), L.buildLibraryIndex([rec('2022-03-01')], { reps: 20 }));
  const libB = L.writeLibrary(path.join(user, 'libB'), L.buildLibraryIndex([rec('2022-03-02')], { reps: 20 }));
  const hashA = L.readLibrary(libA).hash.slice(0, 16);
  // Config: a boolean, off by default, and only with a library to show.
  assert.strictEqual(run({ setupLibrary: libA }).libraryDisplay, false);
  assert.strictEqual(run({ setupLibrary: libA, libraryDisplay: true }).libraryDisplay, true);
  assert.throws(() => run({ setupLibrary: libA, libraryDisplay: 'yes' }), /libraryDisplay: true or false/);
  assert.throws(() => run({ libraryDisplay: true }), /libraryDisplay: shows the pinned history library; name it \(setupLibrary\)/);
  // The hash a setup had before the display existed (the body setupHash had), for a run without a library and one
  // with a library and no display: their looks in the ledger stay theirs.
  const before = r => crypto.createHash('sha256').update(JSON.stringify({
    cfg: { ...r.cfg, dataDir: null, workdir: null }, broker: r.broker, start: r.start.toISOString(), end: r.end.toISOString(), everyNth: r.everyNth,
    premarket: r.premarket, endOfDay: r.endOfDay, prop: r.prop || null,
    // A learning run charges its latency (replay/latency.js): named in the setup, as setupHash names it.
    ...(r.latency ? { latency: true } : {}), harness: treeDigest(ROOT, HARNESS_DIRS), code: treeDigest(ROOT, CODE_DIRS),
    ...(r.setupLibrary ? { library: L.readLibrary(r.setupLibrary).hash } : {}),
  })).digest('hex');
  for (const o of [{}, { setupLibrary: libA }, { setupLibrary: libA, libraryDisplay: false }]) assert.strictEqual(setupHash(run(o)), before(run(o)), JSON.stringify(o));
  // The display is part of the setup: shown and hidden are two setups, sharing their base.
  const off = run({ setupLibrary: libA });
  const on = run({ setupLibrary: libA, libraryDisplay: true });
  assert.notStrictEqual(setupHash(on), setupHash(off));
  assert.strictEqual(setupBase(on), setupHash(off));
  assert.strictEqual(setupBase(off), setupHash(off));
  assert.notStrictEqual(setupBase(run({ setupLibrary: libB, libraryDisplay: true })), setupHash(off), 'another library: another base');
  // The arm a look names.
  assert.strictEqual(lookArm(run({})), 'without');
  assert.strictEqual(lookArm(off), 'without', 'pinned alone: not shown, no library arm');
  assert.strictEqual(lookArm(on), `without+library:${hashA}`);
  assert.ok(K.ARM.test(lookArm(on)) && !K.ARM.test(`without+library:${hashA}+library:${hashA}`) && !K.ARM.test('without+library:xyz'));
  // A paired comparison: the hidden arm and the shown arm of one evaluation, accepted and recorded.
  const look = (runId, r, over = {}) => ({ evaluation: 'evD', candidate: 'champ', purpose: 'judging', runId, from: '2025-03-03', to: '2025-03-04', arm: lookArm(r), config: setupHash(r), base: setupBase(r), ...over });
  const ledgerFile = path.join(user, 'looks.jsonl');
  K.recordLook(ledgerFile, look('r-hidden', off), { create: true });
  const shown = K.recordLook(ledgerFile, look('r-shown', on));
  assert.deepStrictEqual([shown.ok, shown.appended, shown.shared], [true, true, true], 'one evaluation, one look spent');
  const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual('base' in lines[0], false, 'the hidden arm\'s line is the line it had (its base is its config)');
  assert.deepStrictEqual([lines[1].arm, lines[1].config, lines[1].base], [`without+library:${hashA}`, setupHash(on), setupHash(off)]);
  assert.strictEqual(K.lookUsage(lines).test.evaluations, 1);
  // Refused: a shown arm of another library, or one that also changes the index; a third arm differing from one arm in
  // both dimensions; an arm whose base contradicts it.
  const ledger = lines;
  const refused = (l, why) => { const r = K.checkLook(l, ledger); assert.strictEqual(r.ok, false, JSON.stringify(l)); assert.match(r.refusals.join('; '), why); };
  const one = [lines[0]];
  const lB = run({ setupLibrary: libB, libraryDisplay: true });
  refused({ ...look('r-b', lB) }, /differ only in their experience index, or only in the history library's display/);
  assert.strictEqual(K.checkLook(look('r-b', lB), one).ok, false);
  assert.strictEqual(K.checkLook(look('r-idx', on, { arm: `with:${'a'.repeat(16)}+library:${hashA}` }), one).ok, false, 'display and index both changed');
  assert.ok(K.checkLook(look('r-idx', off, { arm: `with:${'a'.repeat(16)}` }), one).ok, 'the index alone: an arm as before');
  refused(look('r-idx', off, { arm: `with:${'a'.repeat(16)}` }), /not r-shown's/);
  refused(look('r-x', on, { base: null }), /names its setup without the display \(base\)/);
  refused(look('r-x', on, { base: setupHash(on) }), /names its setup without the display \(base\)/);
  refused(look('r-x', off, { base: 'f'.repeat(64) }), /is not shown the history library: its base is its config/);
  refused(look('r-y', on), /has its without\+library:[0-9a-f]{16} arm already/);
  // A resume is the look it took (the reviewer's case: a hidden arm resumed as the shown one would be a free second arm).
  const resumed = K.checkLook(look('r-hidden', on), ledger);
  assert.strictEqual(resumed.ok, false);
  assert.match(resumed.refusals.join(), /run r-hidden took its look in evaluation evD as another arm \(without\+library:[0-9a-f]{16}, not without\): a resume keeps its arm/);
  assert.match(K.checkLook(look('r-shown', off), ledger).refusals.join(), /run r-shown took its look .* as another arm \(without, not without\+library/);
  // A code fix between start and resume changes the config and base (they digest scripts/), not the arm: still a resume.
  const fixed = K.checkLook(look('r-shown', on, { config: '1'.repeat(64), base: '2'.repeat(64) }), ledger);
  assert.deepStrictEqual([fixed.ok, fixed.repeat], [true, true], fixed.refusals.join());
  // The setup without its code (setupFixed) is kept: a run home deleted and started again with another runner config
  // under the same runId and arm is no free repeat.
  const { setupFixed } = require('../../scripts/lib/replay/config');
  assert.notStrictEqual(setupFixed(on), setupHash(on));
  assert.notStrictEqual(setupFixed(on), setupFixed(off), 'the display is part of it');
  const withSetup = [{ ...lines[0], setup: setupFixed(off) }];
  assert.ok(K.checkLook(look('r-hidden', off, { setup: setupFixed(off), config: '3'.repeat(64), base: '3'.repeat(64) }), withSetup).ok, 'the same setup, other code: a resume');
  const other = run({ setupLibrary: libA, autotrader: { ...raw({}).autotrader, timeframe: 5 } });
  const rerun = K.checkLook(look('r-hidden', off, { setup: setupFixed(other) }), withSetup);
  assert.strictEqual(rerun.ok, false);
  assert.match(rerun.refusals.join(), /run r-hidden took its look in evaluation evD with another setup .*: a resume keeps its setup/);
  assert.deepStrictEqual([K.checkLook(look('r-hidden', off), ledger).ok, K.checkLook(look('r-hidden', off), ledger).repeat], [true, true], 'the same arm: a free repeat');
  // An old line without arm or config resumes as it was.
  const old = [{ kind: 'look', evaluation: 'evOld', candidate: 'champ', purpose: 'judging', runId: 'r-old', from: '2025-03-03', to: '2025-03-04', role: 'test' }];
  assert.ok(K.checkLook({ ...look('r-old', off), evaluation: 'evOld' }, old).ok);
  // The same config is the same display and base: an arm claiming the shown display on the hidden arm's setup is refused.
  const same = K.checkLook(look('r-z', off, { arm: `with:${'c'.repeat(16)}+library:${hashA}`, base: 'd'.repeat(64) }), one);
  assert.strictEqual(same.ok, false);
  assert.match(same.refusals.join(), /arm with:c{16}\+library:[0-9a-f]{16} has r-hidden's setup .* but not its library display or base/);
  // Through the run gate: the base is carried into the look.
  const genv = { HOME: tmp(), FTH_HOME: tmp() };
  const gate = { from: D('2025-03-03T00:00:00Z'), to: D('2025-03-08T00:00:00Z'), env: genv, candidate: 'champ', evaluation: 'evG' };
  G.startLearningRun(tmp(), { ...gate, runId: 'g-off', arm: lookArm(off), config: setupHash(off), base: setupBase(off), setup: 's'.repeat(8) });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(genv.HOME, '.futures-trading-harness', 'learning', 'looks.jsonl'), 'utf8').trim().split('\n')[0]).setup, 's'.repeat(8), 'the gate records the setup');
  assert.strictEqual(G.startLearningRun(tmp(), { ...gate, runId: 'g-on', arm: lookArm(on), config: setupHash(on), base: setupBase(on) }).taken.ok, true);
  assert.throws(() => G.startLearningRun(tmp(), { ...gate, runId: 'g-nobase', arm: `with:${'b'.repeat(16)}+library:${hashA}`, config: setupHash(on) }), /names its setup without the display/);
  // scripts/replay.js run: the config's flag reaches the run's pin; without it the library is pinned hidden.
  // (Shown only on an evaluation's arm, the training preflight's rule: a validate run naming its evaluation; hidden on
  // practice. Mondays, the preflight's bar fixture.)
  for (const [display, said, start, flags] of [[true, /history library pinned: [0-9a-f]{16}, shown to the model/, '2024-08-05', ['--validate', '--evaluation', 'evD']], [undefined, /history library pinned: [0-9a-f]{16}, not shown to the model \(libraryDisplay off\)/, '2022-03-07', []]]) {
    const r = replayRun(`${start}T14:30:00Z`, `${start}T15:00:00Z`, flags, { setupLibrary: libA, ...(display === undefined ? {} : { libraryDisplay: display }) });
    assert.match(r.stdout, said, r.stderr);
    assert.strictEqual(L.libraryShown(path.join(r.user, 'replays', 'r')), display === true);
  }
  // A resume can't pin a library its run started without (its look named no display).
  const first = replayRun('2024-08-05T14:30:00Z', '2024-08-05T15:00:00Z', ['--validate', '--evaluation', 'evR']);
  const again = replayRun('2024-08-05T14:30:00Z', '2024-08-05T15:00:00Z', ['--validate', '--evaluation', 'evR'], { setupLibrary: libA, libraryDisplay: true }, first.user);
  assert.strictEqual(again.status, 1, again.stdout);
  // Refused by the preflight's ledger-look (the resume names another arm and setup) before its pin could be tried.
  assert.match(again.stderr, /a resume keeps its arm|this run started without a history library; a resume can't pin one/);
  assert.strictEqual(L.libraryShown(path.join(first.user, 'replays', 'r')), false);
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
