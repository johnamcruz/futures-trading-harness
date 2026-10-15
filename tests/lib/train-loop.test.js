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
const CATEGORY = { 'planted failure': 'wrong stated reason', 'planted harm': 'wrong-side entry', 'planted fix': 'right', 'planted blow': 'right' };

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
  const calls = { propose: 0, steps: [], branches: [], evaluator: 0, replay: 0, preflight: [] };
  const steps = {
    // The training preflight (learning/preflight.js), recorded: its own test below runs the real one.
    preflight: (run, gate, opts) => { calls.preflight.push({ runId: run.runId, barsFiles: opts.barsFiles, noBars: opts.noBars }); return { ok: true, results: [], record: () => null }; },
    makeTree: dir => { fs.mkdirSync(path.join(dir, 'skills', 'a'), { recursive: true }); fs.writeFileSync(path.join(dir, SKILL), '# A\n'); fs.mkdirSync(path.join(dir, 'workspace')); return 'c0ffee'; },
    prepareTree: (dir, { proposal }) => { if (proposal) require('../../scripts/lib/train/proposal').applyProposal(proposal, dir); },
    seedRunHome: run => {
      for (const d of [run.paths.runDir, run.paths.workspace, run.paths.bars]) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(run.paths.runHome, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['x'], replay: true, journalEnv: 'SIM_JOURNAL', env: [] } } }));
    },
    // The driver's loop, reduced: the clock, the (checkpointing) step, the line.
    runReplay: async ({ run, deps, maxCycles }) => {
      const day = new Date(new Date(run.start).getTime() + 3600000).toISOString().slice(0, 10); // the run's window day, so a learning run's days are its window's
      calls.replay += 1;
      const manifest = store.openRun(run.paths, { runId: run.runId, hash: 'h' });
      const done = store.recordedTimes(run.paths.runDir);
      const todo = TIMES.filter(t => !done.has(t));
      if (todo.length > maxCycles) {
        for (const t of todo.slice(0, maxCycles)) {
          const res = await deps.step({ t: new Date(t), kind: 'trade', day }, {}, 1000);
          store.appendRecord(run.paths, manifest, { t, day, kind: 'trade', ran: store.parseStep(res.output).ran });
        }
        return { cycles: maxCycles, stopped: `stopped after ${maxCycles} decision times (--max-cycles)`, done: false };
      }
      for (const t of todo) {
        fs.writeFileSync(run.paths.clockFile, JSON.stringify({ now: t }));
        const res = await deps.step({ t: new Date(t), kind: 'trade', day }, {}, 1000);
        store.appendRecord(run.paths, manifest, { t, day, kind: 'trade', ran: store.parseStep(res.output).ran });
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
    scorecard: ({ runDir }) => Object.values(store.readRun(runDir).days).flat().map(l => ({ key: `${l.t}|MNQ`, t: l.t, day: l.day, symbol: 'MNQ', category: CATEGORY[l.ran[0].result], inTrade: false, blow: l.ran[0].result === 'planted blow' })),
    propose: async () => { calls.propose += 1; return { proposals: proposals.map(proposal => ({ proposal })) }; },
    evaluator: async () => { calls.evaluator += 1; return { available: false, why: 'stub' }; },
    writeBranch: opts => { calls.branches.push(opts); return 'deadbeef'.repeat(5); },
  };
  return { user, env, loop, steps, calls, paths: S.loopPaths(env, 'l1') };
}

const run = (w, opts = {}) => L.runLoop({ loop: w.loop, env: w.env, root: ROOT, steps: w.steps, ...opts });

test('the champion\'s runs pass the training preflight first: a FAIL refuses the run before it is seeded; its facts read the loop\'s bars, or are N/A without them', async () => {
  // Every run of the loop is checked, with no bars to give: facts N/A ("no bars given to the loop").
  const w = world({ proposals: [] });
  await run(w);
  assert.ok(w.calls.preflight.length >= 1);
  assert.deepStrictEqual(w.calls.preflight[0], { runId: 'l1-champion-t0', barsFiles: {}, noBars: 'no bars given to the loop' });
  // With the evaluator's data source, its bars.
  const P = require('../../scripts/lib/learning/preflight');
  const withData = world({ proposals: [] });
  withData.loop = { ...withData.loop, evaluator: { prop: 'prop_portfolio', data: { MNQ: '/bars/MNQ-3m.json' } } };
  await run(withData);
  assert.deepStrictEqual(withData.calls.preflight[0].barsFiles, { MNQ: '/bars/MNQ-3m.json' });
  assert.strictEqual(withData.calls.preflight[0].noBars, null);
  // The real preflight on the loop's stub tree (no strategies, no skills): FAIL, the run refused, nothing seeded or run.
  const real = world({ proposals: [] });
  delete real.steps.preflight;
  await assert.rejects(run(real), /training preflight refused the run:[^]*FAIL strategy: trade_lifecycle is not a strategy/);
  assert.strictEqual(real.calls.replay, 0);
  assert.ok(!fs.existsSync(path.join(real.loop.workDir, 'runs', 'l1-champion-t0', 'learning-run.json')), 'not seeded');
  // With no bars the facts check is N/A, never a FAIL, and the other checks still run.
  const facts = P.runChecks({ run: { cfg: { symbols: ['MNQ'] } }, gate: {}, noBars: 'no bars given to the loop', read: {} }, [P.facts]);
  assert.deepStrictEqual(facts.results, [{ check: 'facts', status: P.NA, detail: 'no bars given to the loop' }]);
});

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

test('the scorecard is read under the look\'s rules: tuning on the tuning windows, judging (against the ledger before the look) held out', async () => {
  const w = world({ proposals: [fix], loop: { heldOutWindows: [{ from: '2023-09-13', to: '2023-09-14' }] } });
  const looks = [];
  const score = w.steps.scorecard;
  w.steps.scorecard = opts => { looks.push(opts.look); return score(opts); };
  await run(w, { dryRun: true });
  assert.ok(looks.length && looks.every(l => l.purpose === 'tuning' && l.candidate === 'l1' && Array.isArray(l.ledger)));
  looks.length = 0;
  const [kept] = readArchive(w.paths.archive);
  await L.judgeHeldOut({ loop: w.loop, env: w.env, root: ROOT, steps: w.steps, proposalId: kept.proposalId, heldOutLook: true });
  assert.ok(looks.length && looks.every(l => l.purpose === 'judging' && l.candidate === `l1/${kept.proposalId}`));
  assert.ok(looks.every(l => !l.ledger.some(x => x.purpose === 'judging')), 'checked against the ledger as it was before this judging\'s own look');
});

test('a judging stopped between logging its look and saving it resumes with its own look; nothing else may', async () => {
  const w = world({ proposals: [fix], loop: { heldOutWindows: [{ from: '2023-09-13', to: '2023-09-14' }] } });
  await run(w, { dryRun: true });
  const [kept] = readArchive(w.paths.archive);
  const tag = `h-${kept.proposalId}-`;
  // The disk as a stop right after the look was logged leaves it: "started" saved, the look (with its loop and
  // proposal) and the snapshot written, the look's own done flag not saved.
  const snapshot = path.join(w.paths.dir, `held-out-${kept.proposalId}`, 'ledger-before.jsonl');
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.copyFileSync(w.paths.ledger, snapshot);
  fs.appendFileSync(w.paths.ledger, `${JSON.stringify({ candidate: `l1/${kept.proposalId}`, purpose: 'judging', ranges: w.loop.heldOutWindows, loopId: 'l1', proposalId: kept.proposalId, at: new Date().toISOString() })}\n`);
  const state = JSON.parse(fs.readFileSync(w.paths.state, 'utf8'));
  state.done[`judging:${tag}`] = 'started';
  fs.writeFileSync(w.paths.state, JSON.stringify(state));
  const v = await L.judgeHeldOut({ loop: w.loop, env: w.env, root: ROOT, steps: w.steps, proposalId: kept.proposalId, heldOutLook: true });
  assert.strictEqual(v.verdict, 'kept');
  assert.strictEqual(S.readLedger(w.paths.ledger).filter(l => l.purpose === 'judging').length, 1, 'no second look');
  assert.strictEqual(readArchive(w.paths.archive).filter(e => e.phase === 'held-out').length, 1);
});

test('a held-out judging resumed without its ledger snapshot is refused, saying what is missing; nothing more runs', async () => {
  const w = world({ proposals: [fix], loop: { heldOutWindows: [{ from: '2023-09-13', to: '2023-09-14' }] } });
  await run(w, { dryRun: true });
  const [kept] = readArchive(w.paths.archive);
  const judge = () => L.judgeHeldOut({ loop: w.loop, env: w.env, root: ROOT, steps: w.steps, proposalId: kept.proposalId, heldOutLook: true });
  const evaluator = w.steps.evaluator;
  w.steps.evaluator = async () => { throw new Error('planted crash'); };
  await assert.rejects(judge(), /planted crash/);
  const snapshot = path.join(w.paths.dir, `held-out-${kept.proposalId}`, 'ledger-before.jsonl');
  assert.ok(fs.existsSync(snapshot));
  fs.rmSync(snapshot);
  w.steps.evaluator = evaluator;
  const steps = w.calls.steps.length;
  const looks = S.readLedger(w.paths.ledger).length;
  await assert.rejects(judge(), /the held-out ledger snapshot .*ledger-before\.jsonl is missing: this judging's look was already logged[^]*Restore the file from a backup to resume\. Otherwise the held-out months 2023-09-13\.\.2023-09-14 are spent \(each judges once, in any loop\): judging needs held-out months not yet used/);
  assert.strictEqual(w.calls.steps.length, steps, 'nothing ran');
  assert.strictEqual(S.readLedger(w.paths.ledger).length, looks, 'no look logged');
  assert.strictEqual(readArchive(w.paths.archive).filter(e => e.phase === 'held-out').length, 0);
});

test('checkedScorecard: any scorecard (a --steps one too) reads a run only after the loop checks its look against the ledger', async () => {
  const home = tmpDir();
  const runDir = path.join(home, 'replay', 'r');
  const paths = { runDir, manifest: path.join(runDir, 'manifest.json') };
  const manifest = store.openRun(paths, { runId: 'r', hash: 'h' });
  store.appendRecord(paths, manifest, { t: '2023-09-13T14:33:02.000Z', day: '2023-09-13', kind: 'trade', ran: [] });
  let called = 0;
  const plugged = L.checkedScorecard(async () => { called += 1; return []; });
  // Select is for judging only: a tuning look is refused before the plugged scorecard runs; no look at all is refused.
  await assert.rejects(plugged({ runDir, look: { purpose: 'tuning', ledger: [] } }), /scorecard's look at 2023-09-13\.\.2023-09-13 is refused: select [^]*allows judging looks only/);
  await assert.rejects(plugged({ runDir }), /only under a look/);
  await assert.rejects(plugged({ runDir, look: { purpose: 'judging' } }), /only under a look/);
  assert.strictEqual(called, 0);
  await plugged({ runDir, look: { purpose: 'judging', ledger: [] } });
  assert.strictEqual(called, 1);
  // runLoop wraps the scorecard it is given: a run whose days its tuning look doesn't allow (a champion run that
  // recorded Select days) is refused before the plugged scorecard is called.
  const w = world({ proposals: [fix] });
  let seen = 0;
  w.steps.scorecard = async () => { seen += 1; return []; };
  const replay = w.steps.runReplay;
  w.steps.runReplay = async opts => {
    const res = await replay(opts);
    const m = store.openRun(opts.run.paths, { runId: opts.run.runId, hash: 'h' });
    store.appendRecord(opts.run.paths, m, { t: '2024-09-10T14:33:02.000Z', day: '2024-09-10', kind: 'trade', ran: [] });
    return res;
  };
  await assert.rejects(run(w, { dryRun: true }), /scorecard's look is refused: the run's days 2022-03-09\.\.2024-09-10 are practice-train \+ practice-validate/);
  assert.strictEqual(seen, 0);
});

test('a held-out ledger snapshot removed while the judging runs stops it at the next scorecard read', async () => {
  const w = world({ proposals: [fix], loop: { heldOutWindows: [{ from: '2023-09-13', to: '2023-09-14' }] } });
  await run(w, { dryRun: true });
  const [kept] = readArchive(w.paths.archive);
  const snapshot = path.join(w.paths.dir, `held-out-${kept.proposalId}`, 'ledger-before.jsonl');
  const replay = w.steps.runReplay;
  w.steps.runReplay = async opts => { fs.rmSync(snapshot, { force: true }); return replay(opts); };
  await assert.rejects(L.judgeHeldOut({ loop: w.loop, env: w.env, root: ROOT, steps: w.steps, proposalId: kept.proposalId, heldOutLook: true }), /the held-out ledger snapshot .* is missing/);
});

test('a candidate that enters where the champion was flat is followed into its trade: a blow there rejects it', async () => {
  const enter = { targets: ['wrong stated reason'], expects: 'enters', edits: [{ file: SKILL, find: '# A', replace: '# A\nFIX ENTER' }] };
  for (const marker of ['ENTER', 'none']) {
    const w = world({ proposals: [marker === 'ENTER' ? enter : fix] });
    const base = w.steps.stepDeps;
    const steps = new Map();
    w.steps.stepDeps = (r, tree) => {
      const d = base(r, tree);
      const entering = fs.readFileSync(path.join(tree, SKILL), 'utf8').includes('ENTER');
      return {
        ...d,
        // The champion is flat after every point; the candidate holds the trade it entered.
        inTrade: async () => entering,
        step: async p => {
          const n = (steps.get(r.paths.runHome) || 0) + 1;
          steps.set(r.paths.runHome, n);
          if (entering && n > 1) return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [{ action: 'trade', ok: true, result: 'planted blow' }] })}` };
          return d.step(p);
        },
      };
    };
    await run(w, { dryRun: true });
    const [e] = readArchive(w.paths.archive);
    if (marker === 'ENTER') {
      assert.strictEqual(e.verdict, 'rejected', JSON.stringify(e.reasons));
      assert.match(e.reasons[0], /blow\(s\) on the candidate's side/);
      assert.ok(e.tests.onlyCandidate > 0, 'it ran on past the champion');
      assert.strictEqual(e.tests.pairs, 20, 'the sample is the decisions both sides made');
    } else assert.strictEqual(e.verdict, 'kept', 'a candidate that stays flat runs only the points');
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

test('the learning gate: each window run checks it as replay.js run does, before its home is seeded, the look before its first cycle', async () => {
  // Practice-train: no look; the run home keeps its decision.
  const w = world({ proposals: [] });
  await run(w);
  const home = path.join(w.loop.workDir, 'runs', 'l1-champion-t0');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'learning-run.json'), 'utf8')).role, 'practice-train');
  // A walk-forward tuning quarter of 2026 is the learning split's sealed final window: refused without an evaluation.
  const Q3 = [{ from: '2026-07-07', to: '2026-07-08' }];
  const sealed = world({ proposals: [], loop: { tuningWindows: Q3 } });
  await assert.rejects(run(sealed), /learning run refused: final is sealed: name the candidate/);
  assert.strictEqual(sealed.calls.replay, 0);
  assert.ok(!fs.existsSync(path.join(sealed.loop.workDir, 'runs', 'l1-champion-t0')), 'nothing seeded');
  // With its evaluation, the final look needs a test pass of the candidate first.
  const evald = world({ proposals: [], loop: { tuningWindows: Q3, learning: { evaluation: 'ev1' } } });
  await assert.rejects(run(evald), /no test pass/);
  const ledger = path.join(evald.env.HOME, '.futures-trading-harness', 'learning', 'looks.jsonl');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, `${JSON.stringify({ kind: 'look', evaluation: 't1', candidate: 'l1/champion', purpose: 'judging', runId: 't1', from: '2025-02-03', to: '2025-02-04', role: 'test' })}\n${JSON.stringify({ kind: 'result', evaluation: 't1', candidate: 'l1/champion', role: 'test', result: 'pass' })}\n`);
  await run(evald);
  assert.strictEqual(evald.calls.replay, 1);
  const looks = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(looks.slice(-1).map(l => [l.role, l.evaluation, l.candidate, l.runId]), [['final', 'ev1.champion-t0', 'l1/champion', 'l1-champion-t0']]);
  // On a test or final day a replay cannot declare itself not learning.
  const fresh = world().loop.replay;
  await assert.rejects(run(world({ proposals: [], loop: { tuningWindows: Q3, replay: { ...fresh, learning: false } } })), /"learning": false on a practice-validate, test or final day/);
  // After the split (2027-H2's tuning quarter), a replay declared not learning runs, and never teaches.
  const off = world({ proposals: [], loop: { tuningWindows: [{ from: '2027-07-06', to: '2027-07-07' }], replay: { ...fresh, learning: false } } });
  await run(off);
  assert.strictEqual(off.calls.replay, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(off.loop.workDir, 'runs', 'l1-champion-t0', 'learning-run.json'), 'utf8')).learning, false);
  assert.throws(() => resolveLoop({ loopId: 'x', learning: { evaluation: 'ev', bogus: 1 } }), /learning.bogus: not a setting/);
  // A reasoning-fix look hides outcomes, and the loop reads them: refused in its config, and refused if a gate ever returned one.
  assert.throws(() => resolveLoop({ loopId: 'x', learning: { evaluation: 'ev', reasoningFix: true } }), /learning.reasoningFix: refused in the training loop/);
  const hidden = world({ proposals: [] });
  hidden.steps.startLearningRun = () => ({ learning: true, role: 'test', look: { purpose: 'reasoning-fix' }, hideOutcomes: true });
  await assert.rejects(run(hidden), /a reasoning-fix look hides its outcomes, and the training loop reads them: refused/);
  assert.strictEqual(hidden.calls.replay, 0);
  // The same run home started as another (here practice-train, now declared not learning): a resume keeps what it was.
  const again = world({ proposals: [], loop: { replay: { ...w.loop.replay, learning: false } } });
  await assert.rejects(run(again), /a resume keeps it/);
});

// The model-scoring verifier (train/model-verifier.js), its slow part stubbed: the paired Monte Carlo's verdict.
const MODEL = { account: 'acct_a', paths: 500 };
const verdictStub = (seen, verdict = 'kept') => opts => { seen.push(opts); return { available: true, verdict, reasons: [`model ${verdict}`], windows: [] }; };

test('model scoring: the challenger replays every tuning window on the same config and seed; the keep rule decides, archived and in the PR body', async () => {
  const w = world({ proposals: [fix], loop: { modelScore: MODEL } });
  const seen = [];
  w.steps.modelVerifier = verdictStub(seen);
  await run(w, { dryRun: true });
  const [e] = readArchive(w.paths.archive);
  assert.strictEqual(e.verdict, 'kept');
  assert.deepStrictEqual(e.reasons, ['model kept']);
  assert.notStrictEqual(e.panelVerdict.verdict, 'blocked');
  const [o] = seen;
  assert.deepStrictEqual([o.cfg, o.seed, o.heldOut, o.root, path.basename(o.candidateRoot), o.rule], [w.loop.modelScore, 3, false, path.join(w.loop.workDir, 'trees', 'champion'), e.proposalId, w.loop.rule]);
  assert.deepStrictEqual(o.pairs.map(p => [p.label, path.basename(p.champion.runDir), path.basename(p.candidate.runDir)]), [['2022-03-09..2022-03-10', 'l1-champion-t0', `l1-c-${e.proposalId}-t0`]]);
  // Each side's decisions are its own run's: the challenger's tree decided "planted fix" (right) where the champion failed.
  assert.deepStrictEqual([o.pairs[0].champion.decisions.length, o.pairs[0].candidate.decisions.length], [20, 20]);
  assert.ok(o.pairs[0].champion.decisions.every(d => d.category === 'wrong stated reason'));
  assert.ok(o.pairs[0].candidate.decisions.every(d => d.category === 'right'));
  // The challenger's run: the same replay config as the champion's, its own runId, practice-train (no look).
  const champ = JSON.parse(fs.readFileSync(path.join(w.loop.workDir, 'runs', 'l1-champion-t0', 'learning-run.json'), 'utf8'));
  const chal = JSON.parse(fs.readFileSync(path.join(w.loop.workDir, 'runs', `l1-c-${e.proposalId}-t0`, 'learning-run.json'), 'utf8'));
  assert.deepStrictEqual([champ.role, chal.role, chal.look || null], ['practice-train', 'practice-train', null]);
  const body = fs.readFileSync(path.join(w.paths.iter(1), 'promotion', e.proposalId, 'pr-body.md'), 'utf8');
  assert.match(body, /The keep rule on the model's own trades/);
  assert.match(body, /still the final gate: this change is kept for review, not promoted/);
  // Resumed: nothing re-runs.
  const replays = w.calls.replay;
  await run(w, { dryRun: true });
  assert.strictEqual(w.calls.replay, replays);
});

test('model scoring: a rejected or inconclusive keep rule is never kept, whatever the panel shows; a panel harm still rejects', async () => {
  for (const verdict of ['rejected', 'inconclusive', 'blocked']) {
    const w = world({ proposals: [fix], loop: { modelScore: MODEL } });
    w.steps.modelVerifier = verdictStub([], verdict);
    await run(w, { dryRun: true });
    const [e] = readArchive(w.paths.archive);
    assert.strictEqual(e.verdict, verdict);
    assert.strictEqual(w.calls.branches.length, 0);
    assert.strictEqual(e.promotion, undefined);
  }
  const h = world({ proposals: [harm], loop: { modelScore: MODEL } });
  h.steps.modelVerifier = verdictStub([]);
  await run(h, { dryRun: true });
  const [e] = readArchive(h.paths.archive);
  assert.strictEqual(e.verdict, 'rejected');
  assert.match(e.reasons[0], /^panel: /);
});

test('model scoring screens a strategy change on the model\'s own trades: no longer blocked without the mechanical evaluator', async () => {
  const strat = { targets: ['wrong stated reason'], expects: 'x', edits: [{ file: 'strategies/orb/STRATEGY.md', find: 'stop: a', replace: 'stop: b' }] };
  const w = world({ proposals: [strat], loop: { modelScore: MODEL } });
  const make = w.steps.makeTree;
  w.steps.makeTree = dir => { const c = make(dir); fs.mkdirSync(path.join(dir, 'strategies', 'orb'), { recursive: true }); fs.writeFileSync(path.join(dir, 'strategies', 'orb', 'STRATEGY.md'), '---\nname: orb\nstop: a\n---\n'); return c; };
  w.steps.modelVerifier = verdictStub([]);
  await run(w, { dryRun: true });
  const [e] = readArchive(w.paths.archive);
  assert.strictEqual(e.verdict, 'kept');
  // The panel is not blocked for want of a mechanical screen either: the challenger's trades screen it.
  assert.notStrictEqual(e.panelVerdict.verdict, 'blocked');
});

test('model scoring config: tuning on practice-train only; held out through learning looks (an evaluation id) in a held-back window', () => {
  const base = world().loop;
  const raw = over => ({ loopId: 'l1', replay: base.replay, proposer: base.proposer, tuningWindows: [{ from: '2022-03-09', to: '2022-03-10' }], modelScore: MODEL, ...over });
  assert.deepStrictEqual(resolveLoop(raw()).modelScore, { account: 'acct_a', paths: 500, reps: 2000, faults: {} });
  assert.notStrictEqual(resolveLoop(raw()).hash, resolveLoop({ ...raw(), modelScore: undefined }).hash);
  assert.strictEqual(resolveLoop({ ...raw(), modelScore: undefined }).modelScore, undefined);
  assert.throws(() => resolveLoop(raw({ tuningWindows: [{ from: '2024-08-05', to: '2024-08-06' }] })), /tunes on practice-train only/);
  assert.throws(() => resolveLoop(raw({ tuningWindows: [{ from: '2026-07-07', to: '2026-07-08' }] })), /tunes on practice-train only/);
  assert.throws(() => resolveLoop(raw({ heldOutWindows: [{ from: '2023-09-13', to: '2023-09-14' }], learning: { evaluation: 'ev' } })), /judges held out inside one of practice-validate/);
  assert.throws(() => resolveLoop(raw({ heldOutWindows: [{ from: '2024-08-05', to: '2024-08-06' }] })), /learning.evaluation: the model-scored loop judges held out through learning looks/);
  assert.ok(resolveLoop(raw({ heldOutWindows: [{ from: '2024-08-05', to: '2024-08-06' }], learning: { evaluation: 'ev', validate: true } })));
  assert.throws(() => resolveLoop(raw({ modelScore: { account: 'acct_a', seed: 9 } })), /modelScore.seed/);
  // The keep rule pairs full-day windows: a curated list is refused before any replay (without modelScore it stays allowed).
  const curated = { ...base.replay, curatedList: { file: 'curated-practice-x.json', list: 'mix' } };
  assert.throws(() => resolveLoop(raw({ replay: curated })), /replay.curatedList: the model-scored loop judges full-day windows/);
  assert.ok(resolveLoop({ ...raw({ replay: curated }), modelScore: undefined }));
});

test('model scoring held out: the challenger\'s held-out run takes its own learning look before its first cycle; the verifier judges held out', async () => {
  const H = [{ from: '2024-09-10', to: '2024-09-11' }];
  const w = world({ proposals: [fix], loop: { modelScore: MODEL, heldOutWindows: H, learning: { evaluation: 'ev1', validate: true } } });
  const seen = [];
  w.steps.modelVerifier = verdictStub(seen);
  await run(w, { dryRun: true });
  const [kept] = readArchive(w.paths.archive);
  const v = await L.judgeHeldOut({ loop: w.loop, env: w.env, root: ROOT, steps: w.steps, proposalId: kept.proposalId, heldOutLook: true });
  assert.strictEqual(v.verdict, 'kept');
  const o = seen[seen.length - 1];
  assert.strictEqual(o.heldOut, true);
  assert.deepStrictEqual(o.pairs.map(p => path.basename(p.candidate.runDir)), [`l1-c-${kept.proposalId}-h0`]);
  const ledger = path.join(w.env.HOME, '.futures-trading-harness', 'learning', 'looks.jsonl');
  const looks = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(looks.map(l => [l.role, l.purpose, l.evaluation, l.runId]), [
    ['practice-validate', 'validate', `ev1.champion-h-${kept.proposalId}-0`, `l1-champion-h-${kept.proposalId}-0`],
    ['practice-validate', 'validate', `ev1.c-${kept.proposalId}-h0`, `l1-c-${kept.proposalId}-h0`],
  ]);
  const held = readArchive(w.paths.archive).find(e => e.phase === 'held-out');
  assert.deepStrictEqual([held.verdict, held.model.verdict], ['kept', 'kept']);
});

test('model scoring held out: a judging that would need more looks than a sealed window has left is refused before any look', async () => {
  // Two test windows: four looks (the champion's run and the challenger's, each window) against a budget of 3.
  const H = [{ from: '2025-03-03', to: '2025-03-04' }, { from: '2025-03-10', to: '2025-03-11' }];
  const w = world({ proposals: [fix], loop: { modelScore: MODEL, heldOutWindows: H, learning: { evaluation: 'ev1' } } });
  w.steps.modelVerifier = verdictStub([]);
  await run(w, { dryRun: true });
  const [kept] = readArchive(w.paths.archive);
  const replays = w.calls.replay;
  await assert.rejects(L.judgeHeldOut({ loop: w.loop, env: w.env, root: ROOT, steps: w.steps, proposalId: kept.proposalId, heldOutLook: true }), /held-out judging refused: test: judging these windows takes 4 look\(s\).*refused before any look is spent/);
  const ledger = path.join(w.env.HOME, '.futures-trading-harness', 'learning', 'looks.jsonl');
  assert.ok(!fs.existsSync(ledger) || fs.readFileSync(ledger, 'utf8').trim() === '', 'no learning look taken');
  assert.strictEqual(w.calls.replay, replays, 'nothing replayed');
  assert.ok(!readArchive(w.paths.archive).some(e => e.phase === 'held-out'));
  // One test window with two judging evaluations already spent: one look left, two needed.
  const one = world({ proposals: [fix], loop: { modelScore: MODEL, heldOutWindows: [H[0]], learning: { evaluation: 'ev1' } } });
  one.steps.modelVerifier = verdictStub([]);
  await run(one, { dryRun: true });
  const [k1] = readArchive(one.paths.archive);
  const file = path.join(one.env.HOME, '.futures-trading-harness', 'learning', 'looks.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = i => JSON.stringify({ kind: 'look', evaluation: `old${i}`, candidate: 'c', purpose: 'judging', runId: `r${i}`, arm: 'without', config: 'x', from: '2025-05-05', to: '2025-05-06', role: 'test', at: '2026-01-01T00:00:00.000Z' });
  fs.writeFileSync(file, `${line(0)}\n${line(1)}\n`);
  await assert.rejects(L.judgeHeldOut({ loop: one.loop, env: one.env, root: ROOT, steps: one.steps, proposalId: k1.proposalId, heldOutLook: true }), /test: .* 2 look\(s\).* 1 of its 3 are left/);
});

test('model scoring held out: a rulebook-editing proposal on a sealed window is refused before any look or replay', async () => {
  const H = [{ from: '2025-03-03', to: '2025-03-04' }];
  const w = world({ proposals: [fix], loop: { modelScore: MODEL, heldOutWindows: H, learning: { evaluation: 'ev1' } } });
  w.steps.modelVerifier = verdictStub([]);
  await run(w, { dryRun: true });
  // The kept change is re-pointed at a rulebook edit (its tuning ran as a skill edit; only the held-out judging is under test).
  const text = fs.readFileSync(w.paths.archive, 'utf8').split(SKILL).join('accounts/acct_a/RULEBOOK.md');
  fs.writeFileSync(w.paths.archive, text);
  const [kept] = readArchive(w.paths.archive);
  const replays = w.calls.replay;
  await assert.rejects(L.judgeHeldOut({ loop: w.loop, env: w.env, root: ROOT, steps: w.steps, proposalId: kept.proposalId, heldOutLook: true }), /held-out judging refused: .*edits a rulebook.*refused before any look is spent/);
  const ledger = path.join(w.env.HOME, '.futures-trading-harness', 'learning', 'looks.jsonl');
  assert.ok(!fs.existsSync(ledger) || fs.readFileSync(ledger, 'utf8').trim() === '', 'no learning look taken');
  assert.ok(!S.readLedger(w.paths.ledger).some(l => l.purpose === 'judging'), 'no judging look taken');
  assert.strictEqual(w.calls.replay, replays, 'nothing replayed');
  assert.ok(!readArchive(w.paths.archive).some(e => e.phase === 'held-out'));
});

test('checkedScorecard: a learning run follows the learning split (practice-train 2023-08 passes); a sealed test run with no ledger look is refused', async () => {
  const { startLearningRun } = require('../../scripts/lib/learning/run-gate');
  const mk = (day, to, extra) => {
    const base = tmpDir();
    const env = { HOME: base };
    const home = path.join(base, 'replays', 'r');
    const runDir = path.join(home, 'replay', 'r');
    const paths = { runDir, manifest: path.join(runDir, 'manifest.json') };
    const manifest = store.openRun(paths, { runId: 'r', hash: 'h' });
    store.appendRecord(paths, manifest, { t: `${day}T14:33:02.000Z`, day, kind: 'trade', ran: [] });
    startLearningRun(home, { runDir, runId: 'r', env: { HOME: base }, endOfDay: true, from: day, to, ...extra });
    return { runDir, env };
  };
  {
    let called = 0;
    const plugged = L.checkedScorecard(async () => { called += 1; return []; });
    const look = { purpose: 'tuning', ledger: [] };
    const free = mk('2023-08-08', '2023-08-09');
    await plugged({ ...free, look });
    assert.strictEqual(called, 1);
    const sealed = mk('2025-03-04', '2025-03-05', { candidate: 'c1', evaluation: 'e1', arm: 'without', config: 'a'.repeat(64) });
    fs.writeFileSync(require('../../scripts/lib/learning/looks').ledgerPath(sealed.env), `${JSON.stringify({ kind: 'look', evaluation: 'other', candidate: 'c1', purpose: 'judging', runId: 'zz', role: 'test', from: '2025-01-02', to: '2025-01-03' })}\n`);
    await assert.rejects(plugged({ ...sealed, look }), /no judging look at test in the learning ledger/);
    assert.strictEqual(called, 1);
  }
});
