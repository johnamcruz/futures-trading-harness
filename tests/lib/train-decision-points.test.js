'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const D = require('../../scripts/lib/train/decision-points');
const store = require('../../scripts/lib/replay/store');

const FAILURES = ['wrong stated reason', 'bad size'];

/** A run home as the driver lays it out (replay/config.js paths), with a manifest and a day of lines. */
function champion() {
  const home = path.join(tmpDir(), 'champion');
  const runDir = path.join(home, 'replay', 'r1');
  const paths = {
    runHome: home, runDir, workspace: path.join(home, 'workspace'), bars: path.join(home, 'bars'), brokerDir: path.join(runDir, 'broker'),
    clockFile: path.join(runDir, 'clock.json'), journal: path.join(runDir, 'broker', 'journal.jsonl'), autotrader: path.join(runDir, 'autotrader.json'),
    manifest: path.join(runDir, 'manifest.json'), stepsLog: path.join(runDir, 'steps.log'),
  };
  for (const d of [paths.workspace, paths.bars, paths.brokerDir, path.join(home, 'logs', 'cycles')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(paths.brokerDir, 'state.json'), '{"position":1}');
  fs.writeFileSync(paths.stepsLog, 'big log');
  fs.writeFileSync(path.join(home, 'logs', 'cycles', 'c.json'), '{}');
  fs.writeFileSync(path.join(home, 'STOP'), 'kill switch on\n');
  // The run's own brokers.json (seedRunHome writes it): the replay broker.
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, 'sim.js'], replay: true, journalEnv: 'SIM_JOURNAL', env: [] } } }));
  const manifest = store.openRun(paths, { runId: 'r1', hash: 'h' });
  for (const [t, kind] of [['2022-03-09T14:33:02.000Z', 'trade'], ['2022-03-09T14:36:02.000Z', 'trade'], ['2022-03-09T14:45:00.000Z', 'eod']]) {
    store.appendRecord(paths, manifest, { t, day: '2022-03-09', kind, ran: [] });
  }
  const derived = { harness: 'custom', symbols: ['MNQ'], account: '7', dataDir: paths.bars, workdir: paths.workspace };
  return { runId: 'r1', broker: 'sim', brokerEnv: { clockFile: 'SIM_CLOCK', stateDir: 'SIM_STATE', runId: null, start: null, end: null }, start: new Date('2022-03-09T00:00:00Z'), end: new Date('2022-03-10T00:00:00Z'), paths, derived, cfg: { ...derived, cycleTimeoutMinutes: 3 }, propDailyLoss: null };
}

test('checkpointDeps: the run home copied before each trade step (clock set), without the step log and cycle files', async () => {
  const run = champion();
  const dir = path.join(tmpDir(), 'checkpoints');
  const seen = [];
  const deps = D.checkpointDeps({ step: async p => { seen.push(p.kind); fs.writeFileSync(path.join(run.paths.brokerDir, 'state.json'), '{"position":0}'); return { code: 0, output: '' }; }, other: 1 }, { run, dir });
  assert.strictEqual(deps.other, 1);
  const t = new Date('2022-03-09T14:33:02.000Z');
  await deps.step({ t, kind: 'trade' }, {}, 1000);
  await deps.step({ t: new Date('2022-03-09T14:45:00Z'), kind: 'eod' }, {}, 1000);
  const cp = D.checkpointOf(dir, t);
  assert.strictEqual(path.basename(cp), '2022-03-09T14-33-02.000Z');
  assert.deepStrictEqual(fs.readdirSync(dir), [path.basename(cp)], 'trade decisions only');
  assert.strictEqual(fs.readFileSync(path.join(cp, 'replay', 'r1', 'broker', 'state.json'), 'utf8'), '{"position":1}', 'the state before the step');
  assert.ok(fs.existsSync(path.join(cp, 'STOP')), 'the kill switch is part of the state');
  assert.ok(!fs.existsSync(path.join(cp, 'replay', 'r1', 'steps.log')) && !fs.existsSync(path.join(cp, 'logs', 'cycles')));
  // A retried time overwrites its checkpoint.
  await deps.step({ t, kind: 'trade' }, {}, 1000);
  assert.strictEqual(fs.readFileSync(path.join(cp, 'replay', 'r1', 'broker', 'state.json'), 'utf8'), '{"position":0}');
  assert.deepStrictEqual(seen, ['trade', 'eod', 'trade']);
});

test('choosePanel: flagged decisions not targeted before, in time order; a seeded control sample of right ones; points by time', () => {
  const d = (t, category, extra = {}) => ({ key: `${t}|MNQ`, t, day: '2022-03-09', category, ...extra });
  const decisions = [d('T3', 'wrong stated reason'), d('T1', 'bad size', { inTrade: true }), d('T2', 'right'), d('T4', 'right'), d('T5', 'right'), d('T6', 'unchecked'), d('T7', 'wrong stated reason')];
  const p = D.choosePanel({ decisions, used: ['T7|MNQ'], maxFlagged: 5, control: 2, seed: 1, failures: FAILURES });
  assert.deepStrictEqual(p.flagged.map(x => x.t), ['T1', 'T3']);
  assert.strictEqual(p.control.length, 2);
  assert.ok(p.control.every(x => x.category === 'right'));
  assert.deepStrictEqual(D.choosePanel({ decisions, used: ['T7|MNQ'], maxFlagged: 5, control: 2, seed: 1, failures: FAILURES }).control, p.control, 'the same seed, the same sample');
  assert.deepStrictEqual(p.points.filter(x => x.flagged).map(x => [x.t, x.inTrade]), [['T1', true], ['T3', false]]);
  assert.strictEqual(D.choosePanel({ decisions, maxFlagged: 1, control: 0, seed: 1, failures: FAILURES }).flagged.length, 1);
});

test('pointSeed: the same for both sides of a pair, different per point and repeat; shuffled is seeded', () => {
  assert.strictEqual(D.pointSeed(5, '2022-03-09T14:33:02.000Z', 0), D.pointSeed(5, new Date('2022-03-09T14:33:02.000Z'), 0));
  assert.notStrictEqual(D.pointSeed(5, '2022-03-09T14:33:02.000Z', 0), D.pointSeed(5, '2022-03-09T14:33:02.000Z', 1));
  assert.notStrictEqual(D.pointSeed(5, '2022-03-09T14:33:02.000Z', 0), D.pointSeed(6, '2022-03-09T14:33:02.000Z', 0));
  assert.deepStrictEqual(D.shuffled([1, 2, 3, 4, 5], 'a'), D.shuffled([1, 2, 3, 4, 5], 'a'));
});

test('followersOf: the champion\'s later trade and end-of-day times that day', () => {
  const run = champion();
  assert.deepStrictEqual(D.followersOf(run.paths.runDir, { t: '2022-03-09T14:33:02.000Z', day: '2022-03-09' }).map(x => [x.t, x.kind]), [['2022-03-09T14:36:02.000Z', 'trade'], ['2022-03-09T14:45:00.000Z', 'eod']]);
});

test('runPoint: from the checkpoint, in a fresh home, re-based, with the tree\'s workspace files; a point in a trade runs on', async () => {
  const run = champion();
  const dir = path.join(tmpDir(), 'checkpoints');
  const t = new Date('2022-03-09T14:33:02.000Z');
  fs.writeFileSync(run.paths.clockFile, JSON.stringify({ now: t.toISOString() }));
  await D.checkpointDeps({ step: async () => ({}) }, { run, dir }).step({ t, kind: 'trade' }, {}, 1000);
  const tree = tmpDir();
  fs.mkdirSync(path.join(tree, 'workspace'));
  fs.writeFileSync(path.join(tree, 'workspace', 'AGENTS.md'), 'candidate adapters\n');
  const home = path.join(tmpDir(), 'point');
  const steps = [];
  const stepDeps = (pr, root) => ({
    serverCheck: async () => null,
    step: async (p, env) => {
      steps.push({ t: p.t.toISOString(), kind: p.kind, home: env.FTH_HOME, seed: env.FTH_TRAIN_SEED, root, clock: JSON.parse(fs.readFileSync(pr.paths.clockFile, 'utf8')).now, cfg: JSON.parse(fs.readFileSync(pr.paths.autotrader, 'utf8')) });
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: 'trade', ran: [{ action: 'trade', ok: true, result: 'CYCLE RESULT: no-trade' }] })}` };
    },
  });
  let calls = 0;
  const point = { t: t.toISOString(), day: '2022-03-09', inTrade: true };
  const res = await D.runPoint({ run, checkpoint: D.checkpointOf(dir, t), home, tree, point, followers: D.followersOf(run.paths.runDir, point), repeat: 2, seed: 99, baseEnv: { PATH: process.env.PATH, FTH_BROKERS_FILE: path.join(tmpDir(), 'none.json') }, stepDeps, onCall: () => { calls += 1; } });
  assert.deepStrictEqual(res.times, ['2022-03-09T14:33:02.000Z', '2022-03-09T14:36:02.000Z', '2022-03-09T14:45:00.000Z']);
  assert.strictEqual(calls, 3);
  assert.ok(steps.every(s => s.home === home && s.seed === '99' && s.root === tree && s.clock === s.t), JSON.stringify(steps[0]));
  assert.deepStrictEqual([steps[0].cfg.workdir, steps[0].cfg.dataDir], [path.join(home, 'workspace'), path.join(home, 'bars')], 'the runner config re-based on the point home');
  assert.strictEqual(fs.readFileSync(path.join(home, 'workspace', 'AGENTS.md'), 'utf8'), 'candidate adapters\n');
  const lines = store.readRun(res.runDir).days['2022-03-09'];
  // The point's lines follow what the checkpoint held (here the champion's whole day, written before it was taken).
  assert.deepStrictEqual(lines.slice(3).map(l => [l.t, l.ran[0].result]), res.times.map(x => [x, 'CYCLE RESULT: no-trade']));
  assert.ok(res.runDir.startsWith(home));
  // The champion's own home is untouched.
  assert.strictEqual(store.readRun(run.paths.runDir).days['2022-03-09'].length, 3);
  // Not in a trade at the point, but this side holds one after a step (or the read fails): it runs on; the
  // champion's own times (mustRun) are always run.
  const base = { PATH: process.env.PATH, FTH_BROKERS_FILE: path.join(tmpDir(), 'none.json') };
  const flat = { ...point, inTrade: false };
  const followers = D.followersOf(run.paths.runDir, point);
  const withTrade = inTrade => (pr, root) => ({ ...stepDeps(pr, root), inTrade });
  const opened = await D.runPoint({ run, checkpoint: D.checkpointOf(dir, t), home, tree, point: flat, followers, repeat: 0, seed: 1, baseEnv: base, stepDeps: withTrade(async () => true) });
  assert.strictEqual(opened.times.length, 3);
  const unread = await D.runPoint({ run, checkpoint: D.checkpointOf(dir, t), home, tree, point: flat, followers, repeat: 0, seed: 1, baseEnv: base, stepDeps: withTrade(async () => { throw new Error('broker down'); }) });
  assert.strictEqual(unread.times.length, 3, 'a failed read is taken as in a trade');
  const must = await D.runPoint({ run, checkpoint: D.checkpointOf(dir, t), home, tree, point: flat, followers, mustRun: ['2022-03-09T14:36:02.000Z'], repeat: 0, seed: 1, baseEnv: base, stepDeps: withTrade(async () => false) });
  assert.deepStrictEqual(must.times, ['2022-03-09T14:33:02.000Z', '2022-03-09T14:36:02.000Z']);
  // Not in a trade: the point alone. No checkpoint: refused.
  const one = await D.runPoint({ run, checkpoint: D.checkpointOf(dir, t), home, tree, point: { ...point, inTrade: false }, followers: [], repeat: 0, seed: 1, baseEnv: { PATH: process.env.PATH, FTH_BROKERS_FILE: path.join(tmpDir(), 'none.json') }, stepDeps });
  assert.deepStrictEqual(one.times, ['2022-03-09T14:33:02.000Z']);
  await assert.rejects(D.runPoint({ run, checkpoint: path.join(dir, 'nope'), home, tree, point, stepDeps }), /no checkpoint/);
  // A step that could not run is the point's error (no decision), never a recorded line.
  const bad = await D.runPoint({ run, checkpoint: D.checkpointOf(dir, t), home, tree, point: { ...point, inTrade: false }, repeat: 0, seed: 1, baseEnv: { PATH: process.env.PATH, FTH_BROKERS_FILE: path.join(tmpDir(), 'none.json') }, stepDeps: () => ({ serverCheck: async () => null, step: async () => ({ code: 1, output: 'boom' }) }) });
  assert.match(bad.error, /could not run/);
  assert.deepStrictEqual(bad.times, []);
});
