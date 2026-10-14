'use strict';

/**
 * End to end: one iteration of the training loop, dry run, with the fake harness CLI (as both the trader and
 * the proposer) and the mock exchange as the replay broker. The champion's replay of a Train window (with a
 * checkpoint before each trade decision) makes a planted failure at every decision; the proposer returns two
 * planted proposals: one that fixes the failure (KEPT) and one that trades it for a worse one (REJECTED). The
 * run is stopped by its model-call limit and resumed: nothing runs twice. Every look is in the ledger.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'tests', 'fixtures', 'mock-exchange-server.js');
const HARNESS = path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js');
const RUNNER = path.join(ROOT, 'tests', 'fixtures', 'train-loop-runner.js');
const SKILL = 'skills/session-timing/SKILL.md';
const H1 = '# Session Timing';

const fix = { targets: ['wrong stated reason'], expects: 'no reason that names the opening window once entries are allowed', why: 'planted', edits: [{ file: SKILL, find: H1, replace: `${H1}\n\nPLANTED-FIX` }] };
const harm = { targets: ['wrong stated reason'], expects: 'a planted harmful change', edits: [{ file: SKILL, find: H1, replace: `${H1}\n\nPLANTED-HARM` }] };

function world() {
  const user = tmpDir();
  const live = path.join(user, 'live-home');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({
    brokers: { replaymock: { command: [process.execPath, SERVER], replay: true, journalEnv: 'MOCK_JOURNAL', env: ['MOCK_STATE_DIR', 'MOCK_JOURNAL', 'MOCK_CLOCK_FILE', 'MOCK_REPLAY', 'MOCK_INIT'] } },
  }));
  const trader = { harness: 'custom', command: [process.execPath, HARNESS, '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-09:40@America/New_York'], eodAt: '09:45@America/New_York' };
  const loop = {
    loopId: 'e2e-loop',
    replay: { workDir: path.join(user, 'train'), broker: 'replaymock', premarket: false, autotrader: trader, brokerEnv: { clockFile: 'MOCK_CLOCK_FILE', stateDir: 'MOCK_STATE_DIR', runId: null, start: null, end: null } },
    // Wednesday 2022-03-09, in Train: four trade decisions (09:30, 09:33, 09:36, 09:39, each polled 2 s after its bar closed) and end of day.
    tuningWindows: [{ from: '2022-03-09', to: '2022-03-10' }],
    proposer: { harness: 'custom', command: [process.execPath, HARNESS, '{prompt}'], symbols: ['MNQ'], timeframe: 3 },
    repeats: 5, seed: 5, maxProposals: 2, controlPoints: 0,
    limits: { maxIterations: 1, maxModelCalls: 30, maxWallMinutes: 30 },
  };
  const config = path.join(user, 'loop.json');
  fs.writeFileSync(config, JSON.stringify(loop));
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: live, MOCK_REPLAY: '1', FAKE_HARNESS_PLANT: SKILL, FAKE_HARNESS_PROPOSALS: JSON.stringify([fix, harm]) };
  return { user, live, config, loop, env, state: path.join(live, 'training', 'e2e-loop') };
}

const runner = (w, args) => spawnSync(process.execPath, [RUNNER, w.config, ...args], { encoding: 'utf8', env: w.env, timeout: 600000 });
const result = r => JSON.parse(r.stdout.split('\n').find(l => l.startsWith('RESULT ')).slice(7));
const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('training loop e2e: the planted fix is kept and the planted harm rejected; a stop at the limit resumes; every look logged', { timeout: 900000 }, () => {
  const w = world();
  // Stopped by the model-call limit part way: 5 champion steps, 1 proposer call, then point runs.
  const first = runner(w, ['run', '--dry-run']);
  assert.strictEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.match(result(first).stopped, /max model calls reached \(30 of 30\)/);
  const mid = JSON.parse(fs.readFileSync(path.join(w.state, 'state.json'), 'utf8'));
  assert.strictEqual(mid.modelCalls, 30);
  assert.ok(!fs.existsSync(path.join(w.state, 'archive.jsonl')), 'nothing judged yet');

  // Raised limits (not part of the loop's identity): it resumes where it stopped.
  w.loop.limits.maxModelCalls = 200;
  fs.writeFileSync(w.config, JSON.stringify(w.loop));
  const second = runner(w, ['run', '--dry-run']);
  assert.strictEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.match(result(second).stopped, /max iterations reached/);
  const state = JSON.parse(fs.readFileSync(path.join(w.state, 'state.json'), 'utf8'));
  // Every call once: 5 champion steps + 1 proposer + 4 points x 5 repeats x (champion + 2 candidates).
  assert.strictEqual(state.modelCalls, 5 + 1 + 4 * 5 * 3, 'nothing ran twice across the stop');
  assert.deepStrictEqual(state.iterations.map(i => [i.n, i.done]), [[1, true]]);

  const archive = lines(path.join(w.state, 'archive.jsonl'));
  const byTarget = Object.fromEntries(archive.map(e => [e.proposal.edits[0].replace.includes('FIX') ? 'fix' : 'harm', e]));
  assert.strictEqual(byTarget.fix.verdict, 'kept', JSON.stringify(byTarget.fix.reasons));
  assert.deepStrictEqual([byTarget.fix.tests.pairs, byTarget.fix.tests.target.b, byTarget.fix.tests.target.c], [20, 20, 0]);
  assert.strictEqual(byTarget.harm.verdict, 'rejected');
  assert.match(byTarget.harm.reasons.join(' '), /wrong-side entry: 20 decision\(s\) broken/);
  for (const e of archive) {
    assert.deepStrictEqual([e.seed, e.repeats, e.panel.flagged, e.panel.points.length], [5, 5, 4, 4], 'what reproduces it');
    assert.ok(e.files.includes(SKILL), 'the edited skill');
    assert.ok(e.files.every(f => f === SKILL || /^(workspace|qwen-extension|\.codex|\.agents)\//.test(f)), `only the skill and adapters generated from it: ${e.files}`);
  }
  // The kept change's promotion: a PR body draft and the proposal; a dry run writes no branch.
  const promo = byTarget.fix.promotion;
  assert.strictEqual(promo.branch, null);
  assert.match(fs.readFileSync(path.join(promo.dir, 'pr-body.md'), 'utf8'), /Verdict: \*\*kept\*\*[^]*npm run verify/);
  assert.ok(!fs.existsSync(path.join(w.state, 'iter-1', 'promotion', byTarget.harm.proposalId)), 'no promotion for a rejected change');
  // The candidate's tree had the edit; the champion's did not.
  assert.match(fs.readFileSync(path.join(w.loop.replay.workDir, 'e2e-loop', 'iter-1', 'trees', byTarget.fix.proposalId, SKILL), 'utf8'), /PLANTED-FIX/);
  assert.doesNotMatch(fs.readFileSync(path.join(w.loop.replay.workDir, 'e2e-loop', 'trees', 'champion', SKILL), 'utf8'), /PLANTED/);

  // Each point ran once per repeat at its own time, from the champion's checkpoint taken just before it, with the
  // same seed on both sides of a pair.
  const work = path.join(w.loop.replay.workDir, 'e2e-loop');
  const panel = JSON.parse(fs.readFileSync(path.join(w.state, 'iter-1', 'panel.json'), 'utf8'));
  panel.points.forEach((p, i) => {
    assert.ok(fs.existsSync(path.join(work, 'checkpoints', 'champion-t0', p.t.replace(/:/g, '-'))), `checkpoint ${p.t}`);
    const base = JSON.parse(fs.readFileSync(path.join(work, 'iter-1', 'champion', `${i}-r1.json`), 'utf8'));
    const cand = JSON.parse(fs.readFileSync(path.join(work, 'iter-1', byTarget.fix.proposalId, `${i}-r1.json`), 'utf8'));
    assert.deepStrictEqual([base.times, cand.times, base.seed], [[p.t], [p.t], cand.seed]);
    assert.notStrictEqual(base.seed, JSON.parse(fs.readFileSync(path.join(work, 'iter-1', 'champion', `${i}-r0.json`), 'utf8')).seed, 'each repeat its own seed');
  });
  // The look ledger: the champion's replays and the iteration, both tuning looks at Train, each once.
  const looks = lines(path.join(w.live, 'training', 'looks.jsonl'));
  assert.deepStrictEqual(looks.map(l => [l.candidate, l.purpose]), [['e2e-loop/champion', 'tuning'], ['e2e-loop/iter-1', 'tuning']]);
  // The repository's tree is untouched.
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, SKILL), 'utf8'), /PLANTED/);
});
