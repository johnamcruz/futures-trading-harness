'use strict';

// The training loop's orchestrator with its slow steps stubbed (the replay driver's run, the trees, the scorecard):
// the real phases, state, lock, look ledger, decision-point runs, paired test, archive and promotion. The real steps
// run end to end in tests/e2e/train-loop-e2e.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmpDir } = require('../helpers');
const { resolveLoop } = require('../../scripts/lib/train/config');
const L = require('../../scripts/lib/train/loop');
const S = require('../../scripts/lib/train/state');
const store = require('../../scripts/lib/replay/store');
const { readArchive } = require('../../scripts/lib/train/archive');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILL = 'skills/a/SKILL.md';
// Twenty trade decisions, every 3 minutes from 09:33 New York time.
const TIMES = Array.from({ length: 20 }, (_, i) => new Date(Date.parse('2022-03-09T14:33:02.000Z') + i * 180000).toISOString());
const fix = { targets: ['wrong stated reason'], expects: 'fixed', edits: [{ file: SKILL, find: '# A', replace: '# A\nFIX' }] };
const harm = { targets: ['wrong stated reason'], expects: 'harm', edits: [{ file: SKILL, find: '# A', replace: '# A\nHARM' }] };
const RESULT = text => (text.includes('FIX') ? 'planted fix' : text.includes('HARM') ? 'planted harm' : 'planted failure');
const CATEGORY = { 'planted failure': 'wrong stated reason', 'planted harm': 'wrong-side entry', 'planted fix': 'right' };

function world({ proposals = [fix, harm], loop: over = {}, crashAt = null } = {}) {
  const user = tmpDir();
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'home') };
  fs.mkdirSync(env.FTH_HOME);
  const trader = { harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3, account: '7' };
  const loop = resolveLoop({
    loopId: 'l1', replay: { workDir: path.join(user, 'work'), broker: 'sim', premarket: false, autotrader: trader },
    tuningWindows: [{ from: '2022-03-09', to: '2022-03-10' }], proposer: trader, repeats: 2, seed: 3, maxFlagged: 20, controlPoints: 0,
    limits: { maxIterations: 1, maxModelCalls: 1000, maxWallMinutes: 30 }, ...over,
  });
  const calls = { propose: 0, steps: [], branches: [], evaluator: 0, replay: 0 };
  const steps = {
    makeTree: dir => { fs.mkdirSync(path.join(dir, 'skills', 'a'), { recursive: true }); fs.writeFileSync(path.join(dir, SKILL), '# A\n'); fs.mkdirSync(path.join(dir, 'workspace')); return 'c0ffee'; },
    prepareTree: (dir, { proposal }) => { if (proposal) require('../../scripts/lib/train/proposal').applyProposal(proposal, dir); },
    seedRunHome: run => {
      for (const d of [run.paths.runDir, run.paths.workspace, run.paths.bars]) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(run.paths.runHome, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['x'], replay: true, journalEnv: 'SIM_JOURNAL', env: [] } } }));
    },
    // The driver's loop, reduced: the clock, the (checkpointing) step, the line.
    runReplay: async ({ run, deps, maxCycles }) => {
      calls.replay += 1;
      const manifest = store.openRun(run.paths, { runId: run.runId, hash: 'h' });
      const done = store.recordedTimes(run.paths.runDir);
      const todo = TIMES.filter(t => !done.has(t));
      if (todo.length > maxCycles) {
        for (const t of todo.slice(0, maxCycles)) {
          const res = await deps.step({ t: new Date(t), kind: 'trade', day: '2022-03-09' }, {}, 1000);
          store.appendRecord(run.paths, manifest, { t, day: '2022-03-09', kind: 'trade', ran: store.parseStep(res.output).ran });
        }
        return { cycles: maxCycles, stopped: `stopped after ${maxCycles} decision times (--max-cycles)`, done: false };
      }
      for (const t of todo) {
        fs.writeFileSync(run.paths.clockFile, JSON.stringify({ now: t }));
        const res = await deps.step({ t: new Date(t), kind: 'trade', day: '2022-03-09' }, {}, 1000);
        store.appendRecord(run.paths, manifest, { t, day: '2022-03-09', kind: 'trade', ran: store.parseStep(res.output).ran });
      }
      return { cycles: todo.length, stopped: null, done: true };
    },
    stepDeps: (run, tree) => ({
      serverCheck: async () => null,
      trades: async () => [],
      step: async p => {
        const side = path.basename(tree);
        calls.steps.push(`${side}|${run.paths.runHome}`);
        if (crashAt !== null && calls.steps.length === crashAt) throw new Error('planted crash');
        return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [{ action: 'trade', ok: true, result: RESULT(fs.readFileSync(path.join(tree, SKILL), 'utf8')) }] })}` };
      },
    }),
    scorecard: ({ runDir }) => Object.values(store.readRun(runDir).days).flat().map(l => ({ key: `${l.t}|MNQ`, t: l.t, day: l.day, symbol: 'MNQ', category: CATEGORY[l.ran[0].result], inTrade: false, blow: false })),
    propose: async () => { calls.propose += 1; return { proposals: proposals.map(proposal => ({ proposal })) }; },
    evaluator: async () => { calls.evaluator += 1; return { available: false, why: 'stub' }; },
    writeBranch: opts => { calls.branches.push(opts); return 'deadbeef'.repeat(5); },
  };
  return { user, env, loop, steps, calls, paths: S.loopPaths(env, 'l1') };
}

const run = (w, opts = {}) => L.runLoop({ loop: w.loop, env: w.env, root: ROOT, steps: w.steps, ...opts });

test('one iteration: the fix is kept (a local branch, a PR body), the harm rejected; looks logged; the archive reproduces it', async () => {
  const w = world();
  const res = await run(w);
  assert.match(res.stopped, /max iterations reached \(1 of 1\)/);
  const archive = readArchive(w.paths.archive);
  assert.deepStrictEqual(archive.map(e => [e.proposal.expects, e.verdict]), [['fixed', 'kept'], ['harm', 'rejected']]);
  assert.deepStrictEqual([archive[0].tests.pairs, archive[0].tests.target.b, archive[0].seed, archive[0].repeats, archive[0].baseCommit], [20, 20, 3, 2, 'c0ffee']);
  assert.deepStrictEqual(archive[0].files, [SKILL]);
  assert.strictEqual(w.calls.branches.length, 1);
  const b = w.calls.branches[0];
  assert.deepStrictEqual([b.branch, b.base, b.files], [`train/l1-i1-${archive[0].proposalId}`, 'c0ffee', [SKILL]]);
  assert.match(b.message, /^docs: training loop l1 iteration 1: wrong stated reason/);
  assert.strictEqual(archive[0].promotion.branch, b.branch);
  assert.ok(fs.existsSync(path.join(w.paths.iter(1), 'promotion', archive[0].proposalId, 'pr-body.md')));
  assert.deepStrictEqual(S.readLedger(w.paths.ledger).map(l => [l.candidate, l.purpose, l.ranges[0].from]), [['l1/champion', 'tuning', '2022-03-09'], ['l1/iter-1', 'tuning', '2022-03-09']]);
  // 20 champion steps + 1 proposer + 20 points x 2 repeats x 3 sides.
  assert.strictEqual(JSON.parse(fs.readFileSync(w.paths.state, 'utf8')).modelCalls, 20 + 1 + 120);
  assert.strictEqual(w.calls.evaluator, 2);
  assert.ok(!fs.existsSync(w.paths.lock), 'the lock is released');
  // A second run with the same limits starts nothing new.
  const again = await run(w);
  assert.match(again.stopped, /max iterations reached/);
  assert.strictEqual(w.calls.propose, 1);
});

test('dry run: no branch; the PR body still written', async () => {
  const w = world({ proposals: [fix] });
  await run(w, { dryRun: true });
  assert.strictEqual(w.calls.branches.length, 0);
  const [e] = readArchive(w.paths.archive);
  assert.deepStrictEqual([e.verdict, e.promotion.branch], ['kept', null]);
  assert.match(e.promotion.why, /dry run/);
});

test('resumable: a crash part way resumes where it stopped; no point runs twice; the same verdicts', async () => {
  const w = world({ crashAt: 50 });
  await assert.rejects(run(w), /planted crash/);
  assert.ok(!fs.existsSync(w.paths.lock), 'the lock is released on a crash');
  assert.strictEqual(w.calls.steps.length, 50, '20 champion steps, then 30 point steps, the last one crashed');
  // The same stubs without the crash, recording into the same list.
  const base = world().steps.stepDeps;
  w.steps.stepDeps = (r, tree) => {
    const d = base(r, tree);
    return { ...d, step: async p => { w.calls.steps.push(`${path.basename(tree)}|${r.paths.runHome}`); return d.step(p); } };
  };
  const res = await run(w);
  assert.match(res.stopped, /max iterations reached/);
  // Every (side, point, repeat) home ran exactly once across the crash, except the one that crashed (it runs again).
  const homes = w.calls.steps.map(s => s.split('|')[1]).filter(h => h.includes(`${path.sep}iter-1${path.sep}`));
  const counts = homes.reduce((m, h) => m.set(h, (m.get(h) || 0) + 1), new Map());
  assert.deepStrictEqual([...counts.entries()].filter(([, n]) => n > 1).map(([h, n]) => [path.basename(h), n]), [['14-r1', 2]], 'only the crashed point (the champion side\'s 30th run) ran twice');
  assert.strictEqual(counts.size, 120);
  assert.strictEqual(w.calls.steps.length, 50 + 120 - 29, 'after the crash: the 91 point runs not done, the crashed one among them');
  assert.deepStrictEqual(readArchive(w.paths.archive).map(e => e.verdict), ['kept', 'rejected']);
  assert.strictEqual(w.calls.replay, 1, 'the champion\'s replay ran once');
  assert.strictEqual(w.calls.propose, 1, 'the proposer ran once');
  assert.strictEqual(S.readLedger(w.paths.ledger).length, 2, 'each look logged once');
});

test('limits: the model-call limit stops between calls; raised, the loop resumes; iterations stop a new one', async () => {
  const w = world({ loop: { limits: { maxIterations: 1, maxModelCalls: 7, maxWallMinutes: 30 } } });
  const res = await run(w);
  assert.match(res.stopped, /max model calls reached \(7 of 7\)/);
  assert.strictEqual(JSON.parse(fs.readFileSync(w.paths.state, 'utf8')).modelCalls, 7);
  w.loop = resolveLoop({ loopId: 'l1', replay: w.loop.replay, tuningWindows: w.loop.tuningWindows, proposer: w.loop.proposer, repeats: 2, seed: 3, maxFlagged: 20, controlPoints: 0, limits: { maxIterations: 1, maxModelCalls: 1000, maxWallMinutes: 30 } });
  const done = await run(w);
  assert.match(done.stopped, /max iterations reached/);
  assert.strictEqual(JSON.parse(fs.readFileSync(w.paths.state, 'utf8')).modelCalls, 141);
});

test('one loop at a time, and never while a live runner holds the account', async () => {
  const w = world();
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    fs.mkdirSync(w.paths.training, { recursive: true });
    fs.writeFileSync(w.paths.lock, JSON.stringify({ pid: sleeper.pid, loopId: 'other' }));
    await assert.rejects(run(w), /another training loop \(pid \d+, other\) is running/);
    fs.unlinkSync(w.paths.lock);
    const runner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'scripts/autotrader.js'], { stdio: 'ignore' });
    try {
      const { processCommand } = require('../../scripts/lib/runner-lock');
      for (let i = 0; i < 200 && !/autotrader\.js/.test(processCommand(runner.pid) || ''); i += 1) await new Promise(r => setTimeout(r, 25));
      fs.writeFileSync(path.join(w.env.FTH_HOME, 'autotrader.lock'), JSON.stringify({ pid: runner.pid }));
      await assert.rejects(run(w), /a live runner holds the account \(pid \d+/);
      assert.ok(!fs.existsSync(w.paths.state), 'nothing started');
    } finally {
      runner.kill();
    }
  } finally {
    sleeper.kill();
  }
});

test('a strategy change is blocked until the evaluator screens it; a duplicate is never re-judged; an invalid proposal is archived', async () => {
  const w = world({ proposals: [{ targets: ['wrong stated reason'], expects: 'x', edits: [{ file: 'strategies/orb/STRATEGY.md', find: 'stop: a', replace: 'stop: b' }] }, { targets: ['right'], expects: 'bad', edits: [] }, fix] });
  // The stub tree has a strategy for the first proposal.
  const make = w.steps.makeTree;
  w.steps.makeTree = dir => { const c = make(dir); fs.mkdirSync(path.join(dir, 'strategies', 'orb'), { recursive: true }); fs.writeFileSync(path.join(dir, 'strategies', 'orb', 'STRATEGY.md'), '---\nname: orb\nstop: a\n---\n# ORB\n'); return c; };
  w.steps.stepDeps = (r, tree) => {
    const d = world().steps.stepDeps(r, tree);
    return { ...d, step: async p => (fs.readFileSync(path.join(tree, 'strategies', 'orb', 'STRATEGY.md'), 'utf8').includes('stop: b') ? { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [{ action: 'trade', ok: true, result: 'planted fix' }] })}` } : d.step(p)) };
  };
  w.loop = { ...w.loop, maxProposals: 3, limits: { ...w.loop.limits, maxIterations: 2 } };
  await run(w);
  const archive = readArchive(w.paths.archive);
  const it1 = archive.filter(e => e.iteration === 1);
  assert.deepStrictEqual(it1.map(e => e.verdict).sort(), ['blocked', 'invalid', 'kept']);
  assert.match(it1.find(e => e.verdict === 'blocked').reasons[0], /screened by the evaluator first/);
  // Iteration 2: nothing flagged is left (iteration 1 targeted every flagged decision): the loop stops there.
  const state = JSON.parse(fs.readFileSync(w.paths.state, 'utf8'));
  assert.match(state.stopped, /nothing flagged left/);
});

test('the evaluator verifies on equal terms: the champion\'s and the candidate\'s trees, the tuning windows, one seed; its failure rejects', async () => {
  for (const failures of [[], ['2022-03-09..2022-03-10: the pass-rate lower bound fell from 0.3 to 0.2']]) {
    const w = world({ proposals: [fix], loop: { evaluator: { prop: 'p', data: { MNQ: '/bars.csv' } } } });
    const seen = [];
    w.steps.evaluator = async opts => { seen.push(opts); return { available: true, blows: 0, failures }; };
    await run(w, { dryRun: true });
    const [o] = seen;
    assert.deepStrictEqual([o.cfg.prop, o.champion, path.basename(o.candidate), o.windows, o.seed, o.look.purpose, o.ledger], ['p', path.join(w.loop.workDir, 'trees', 'champion'), readArchive(w.paths.archive)[0].proposalId, w.loop.tuningWindows, 3, 'tuning', w.paths.ledger]);
    const [e] = readArchive(w.paths.archive);
    assert.strictEqual(e.verdict, failures.length ? 'rejected' : 'kept');
    if (failures.length) assert.match(e.reasons[0], /^evaluator: .*lower bound fell/);
  }
});

test('a strategy change the evaluator\'s streams don\'t read stays blocked; one they read is screened', async () => {
  for (const covers of [['strategies/other/STRATEGY.md'], ['strategies/orb/STRATEGY.md']]) {
    const w = world({ proposals: [{ targets: ['wrong stated reason'], expects: 'x', edits: [{ file: 'strategies/orb/STRATEGY.md', find: 'stop: a', replace: 'stop: b' }] }], loop: { evaluator: { prop: 'p', data: { MNQ: '/bars.csv' } } } });
    const make = w.steps.makeTree;
    w.steps.makeTree = dir => { const c = make(dir); fs.mkdirSync(path.join(dir, 'strategies', 'orb'), { recursive: true }); fs.writeFileSync(path.join(dir, 'strategies', 'orb', 'STRATEGY.md'), '---\nname: orb\nstop: a\n---\n'); return c; };
    const base = w.steps.stepDeps;
    w.steps.stepDeps = (r, tree) => {
      const d = base(r, tree);
      return { ...d, step: async p => (fs.readFileSync(path.join(tree, 'strategies', 'orb', 'STRATEGY.md'), 'utf8').includes('stop: b') ? { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [{ action: 'trade', ok: true, result: 'planted fix' }] })}` } : d.step(p)) };
    };
    w.steps.evaluator = async () => ({ available: true, covers, blows: 0, failures: [] });
    await run(w, { dryRun: true });
    const [e] = readArchive(w.paths.archive);
    assert.strictEqual(e.verdict, covers[0].includes('orb') ? 'kept' : 'blocked', JSON.stringify(e.reasons));
  }
});

test('a change judged before is never re-judged: the next iteration archives it as a duplicate', async () => {
  const w = world({ proposals: [fix], loop: { maxFlagged: 2, limits: { maxIterations: 2, maxModelCalls: 1000, maxWallMinutes: 30 } } });
  await run(w, { dryRun: true });
  const archive = readArchive(w.paths.archive);
  assert.deepStrictEqual(archive.map(e => [e.iteration, e.verdict]), [[1, 'inconclusive'], [2, 'duplicate']]);
  assert.match(archive[1].reasons[0], /judged before, in iteration 1/);
  assert.ok(!fs.existsSync(path.join(w.loop.workDir, 'iter-2', archive[0].proposalId)), 'no point runs for a duplicate');
});

test('a candidate tree that differs from the champion beyond the proposal and its adapters fails closed', async () => {
  const w = world({ proposals: [fix] });
  const prep = w.steps.prepareTree;
  w.steps.prepareTree = (dir, opts) => { prep(dir, opts); if (opts.proposal) { fs.mkdirSync(path.join(dir, 'scripts')); fs.writeFileSync(path.join(dir, 'scripts', 'x.js'), '1'); } };
  await assert.rejects(run(w), /differs from the champion's beyond the proposal and its generated adapters: scripts\/x\.js/);
  assert.deepStrictEqual(readArchive(w.paths.archive), []);
});

test('tier 3: a person\'s proposal is validated, queued, and judged next iteration without calling the model', async () => {
  const w = world();
  assert.throws(() => L.importProposal({ loop: w.loop, env: w.env, root: ROOT, proposal: fix, approvedBy: '' }), /--approved-by/);
  assert.throws(() => L.importProposal({ loop: w.loop, env: w.env, root: ROOT, proposal: { ...fix, edits: [{ file: 'scripts/x.js', find: 'a', replace: 'b' }] }, approvedBy: 'owner' }), /proposal refused/);
  const repoProposal = { targets: ['wrong stated reason'], expects: 'fixed', edits: [{ file: 'skills/session-timing/SKILL.md', find: '# Session Timing', replace: '# Session Timing\n\nFIX' }] };
  const { id } = L.importProposal({ loop: w.loop, env: w.env, root: ROOT, proposal: repoProposal, approvedBy: 'owner' });
  // The stub tree carries that skill too.
  const make = w.steps.makeTree;
  w.steps.makeTree = dir => { const c = make(dir); fs.mkdirSync(path.join(dir, 'skills', 'session-timing'), { recursive: true }); fs.writeFileSync(path.join(dir, 'skills', 'session-timing', 'SKILL.md'), '# Session Timing\n'); return c; };
  await run(w, { dryRun: true });
  assert.strictEqual(w.calls.propose, 0, 'no model called');
  const [e] = readArchive(w.paths.archive);
  assert.deepStrictEqual([e.proposalId, e.source], [id, 'manual, approved by owner']);
  assert.ok(fs.readdirSync(path.join(w.paths.dir, 'imported')).every(f => f.endsWith('.used-1')));
});

test('held-out judging: only with --held-out-look, only held-out units, logged before it runs, once per change', async () => {
  const w = world({ proposals: [fix], loop: { heldOutWindows: [{ from: '2023-09-13', to: '2023-09-14' }] } });
  await run(w, { dryRun: true });
  const [kept] = readArchive(w.paths.archive);
  const judge = (over = {}) => L.judgeHeldOut({ loop: w.loop, env: w.env, root: ROOT, steps: w.steps, proposalId: kept.proposalId, heldOutLook: true, ...over });
  await assert.rejects(judge({ heldOutLook: false }), /pass --held-out-look/);
  await assert.rejects(L.judgeHeldOut({ loop: { ...w.loop, heldOutWindows: [{ from: '2022-03-09', to: '2022-03-10' }] }, env: w.env, root: ROOT, steps: w.steps, proposalId: kept.proposalId, heldOutLook: true }), /not inside one held-out unit/);
  await assert.rejects(judge({ proposalId: 'nope' }), /no change kept/);
  const v = await judge();
  assert.strictEqual(v.verdict, 'kept');
  const looks = S.readLedger(w.paths.ledger);
  assert.deepStrictEqual(looks[looks.length - 1].purpose, 'judging');
  assert.deepStrictEqual(looks[looks.length - 1].ranges, [{ from: '2023-09-13', to: '2023-09-14' }]);
  assert.strictEqual(readArchive(w.paths.archive).filter(e => e.phase === 'held-out').length, 1);
  await assert.rejects(judge(), /judged on held-out months already/);
});

test('held-out months judge once, across changes and loops; months a recorded look used are used', async () => {
  const w = world({ proposals: [fix], loop: { heldOutWindows: [{ from: '2023-09-13', to: '2023-09-14' }] } });
  await run(w, { dryRun: true });
  const [kept] = readArchive(w.paths.archive);
  // Another loop's judging look at September 2023, in the one ledger.
  fs.mkdirSync(path.dirname(w.paths.ledger), { recursive: true });
  fs.appendFileSync(w.paths.ledger, `${JSON.stringify({ candidate: 'other/abc', purpose: 'judging', ranges: [{ from: '2023-09-04', to: '2023-09-09' }] })}\n`);
  await assert.rejects(L.judgeHeldOut({ loop: w.loop, env: w.env, root: ROOT, steps: w.steps, proposalId: kept.proposalId, heldOutLook: true }), /held-out months already used for judging: 2023-09/);
  // April 2024: the flow parity check's recorded look (Select).
  await assert.rejects(L.judgeHeldOut({ loop: { ...w.loop, heldOutWindows: [{ from: '2024-04-22', to: '2024-04-27' }] }, env: w.env, root: ROOT, steps: w.steps, proposalId: kept.proposalId, heldOutLook: true }), /already used for judging: 2024-04/);
  assert.strictEqual(S.readLedger(w.paths.ledger).filter(l => l.purpose === 'judging').length, 1, 'a refused judging logs nothing');
});

test('fails closed: an unreadable imported proposal, a proposer that writes what the loop judges with, a champion tree gone', async () => {
  const w = world();
  fs.mkdirSync(path.join(w.paths.dir, 'imported'), { recursive: true });
  fs.writeFileSync(path.join(w.paths.dir, 'imported', '1-x.json'), '{torn');
  await run(w, { dryRun: true });
  assert.strictEqual(w.calls.propose, 0);
  assert.deepStrictEqual(readArchive(w.paths.archive).map(e => [e.verdict, e.reasons[0]]), [['invalid', 'imported file 1-x.json is unreadable or holds no proposal']]);

  const v = world();
  v.steps.propose = async () => { fs.appendFileSync(v.paths.ledger, '{"candidate":"forged","purpose":"tuning","ranges":[{"from":"2022-03-09","to":"2022-03-10"}]}\n'); return { proposals: [{ proposal: fix }] }; };
  await assert.rejects(run(v), /the proposer's run changed the loop's state, the look ledger or the champion's tree/);
  assert.deepStrictEqual(readArchive(v.paths.archive), []);
  // Resumed with the champion's tree removed: its runs were made with it, so the loop refuses.
  fs.rmSync(path.join(v.loop.workDir, 'trees', 'champion'), { recursive: true, force: true });
  await assert.rejects(run(v), /the champion's tree \([^)]*\) is gone/);
});

test('scorecardDecisions: the scorecard\'s records as the loop reads them', () => {
  const [d] = L.scorecardDecisions([{ t: 'T', day: 'D', symbol: 'MNQ', decision: 'in-trade', category: 'early close', facts: { et: '09:40' }, expected: { decision: 'hold', setup: null }, actual: { action: 'exit', setup: null, result: 'CYCLE RESULT: closed' }, why: ['w'], reasons: { claims: [{ check: false, incidental: false, clause: 'c', why: 'y' }, { check: false, incidental: true, clause: 'i', why: 'z' }] }, pacing: { cushion: 0 } }]);
  assert.deepStrictEqual([d.key, d.inTrade, d.category, d.et, d.falseReasons, d.stated, d.blow], ['T|MNQ', true, 'early close', '09:40', ['"c": y'], 'CYCLE RESULT: closed', true]);
});

test('the loop never runs tests, verify, Python, a push, a merge or a pull request', () => {
  const dir = path.join(ROOT, 'scripts', 'lib', 'train');
  const sources = [...fs.readdirSync(dir).map(f => path.join(dir, f)), path.join(ROOT, 'scripts', 'train-loop.js')].map(f => [f, fs.readFileSync(f, 'utf8')]);
  for (const [f, text] of sources) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // No test runner, package manager, Python or GitHub CLI is started; no git command that moves a branch or a remote.
    assert.doesNotMatch(code, /(spawn|exec|execFile)(Sync)?\(\s*['"`](npm|npx|yarn|pnpm|python3?|gh)['"`]|'(push|merge|pull|checkout|reset|fetch|rebase|switch)'|run-all|node:test|--test\b/, f);
  }
  // The git commands the loop runs: export, status, and the branch writer's plumbing only.
  const tree = fs.readFileSync(path.join(dir, 'tree.js'), 'utf8');
  const used = [...tree.matchAll(/git\(\['([a-z-]+)'/g)].map(m => m[1]);
  assert.deepStrictEqual([...new Set(used)].sort(), ['archive', 'commit-tree', 'hash-object', 'read-tree', 'rev-parse', 'status', 'update-index', 'update-ref', 'write-tree']);
});
