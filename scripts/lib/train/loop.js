'use strict';

/**
 * The training loop's orchestrator (docs/LEARNED-RULEBOOK.md section 7a, R24-R28, R30; section 10 step 14,
 * a skeleton). Once per loop, on the tuning windows only:
 *
 *   trees      the champion's tree: the repository's HEAD as files, adapters synced (tree.js)
 *   champion   the champion's continuous replay of each tuning window (the replay driver), with a checkpoint
 *              before every trade decision (decision-points.js); a tuning look, logged (prop/looks.js)
 *   scorecard  the champion's decisions, scored (step 2's scorecard; a failure category per decision)
 *
 * then each iteration n:
 *
 *   panel      (c) the flagged decisions not targeted before, plus a seeded control sample of right ones
 *   propose    (d) the proposer (proposer.js), or proposals a person imported (tier 3, manual); each validated
 *   baseline   (a, e) the champion's tree on the panel's points, from their checkpoints, `repeats` times each
 *   candidate  (e) each valid proposal's tree (applied, synced, validated) on the same points, seeds, repeats
 *   verdict    (f) the paired test (paired.js) and the evaluator (step 9), by code; the LLM never judges
 *   archive    (g) every proposal and its verdict (archive.js); a kept one gets a PR body draft and, unless
 *              dry-run, a local branch. Nothing is pushed, merged or opened: promotion is a reviewed PR.
 *
 * Steps are pluggable (`steps`): the scorecard and the evaluator are adapters. The evaluator is step 9's
 * (train/evaluator.js: the champion's and the candidate's trees scored on the same windows and seed); without an
 * `evaluator` in the loop config it says it is unavailable, so a strategy or
 * rulebook change is `blocked`, never kept. Resumable and idempotent: each phase's output is a file and the phase
 * is marked done in state.json after it (state.js). Limits (iterations, model calls, wall time) stop the loop
 * between calls, resumable. It never runs `npm run verify` or any test: no tests while replays run (memory).
 *
 *   defaultSteps({ root, env })                 the real steps
 *   scorecardDecisions(records)                 the scorecard's records as the loop's decisions
 *   runLoop({ loop, env, root, steps, dryRun, log })          { stopped, iterations }
 *   judgeHeldOut({ loop, env, root, steps, proposalId, heldOutLook, log })   the held-out verdict (spends a look)
 *   importProposal({ loop, env, root, proposal, approvedBy })                tier 3: a person's proposal, queued
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic, dirDigest, fileDigest } = require('../harness-run');
const { harnessHome } = require('../paths');
const { liveRunner } = require('../runner-lock');
const { withAdapter } = require('../broker/adapter');
const { resolveReplay } = require('../replay/config');
const driver = require('../replay/driver');
const { scoreRun, lookAt } = require('../replay/scorecard');
const { readRun } = require('../replay/store');
const { loadStrategies } = require('../trading/strategies');
const { loadAccounts } = require('../trading/accounts');
const S = require('./state');
const T = require('./tree');
const P = require('./proposal');
const D = require('./decision-points');
const { pairUp, judge } = require('./paired');
const A = require('./archive');
const proposer = require('./proposer');
const E = require('./evaluator');
const { replayFor } = require('./config');
const { unitContaining } = require('../prop/splits');
const { checkLook } = require('../prop/looks');
const { checkLearningRun, startLearningRun } = require('../learning/run-gate');
const { rolesBetween } = require('../learning/splits');

class Stop extends Error {}

/**
 * Every scorecard, the default or one plugged in with --steps, reads a run only after the loop has checked the look
 * itself (replay/scorecard.js lookAt: the same rules, against the same ledger the default path uses). A refused
 * look, or none, throws before the scorecard is called, so a plugged scorecard can't skip it.
 */
function checkedScorecard(scorecard) {
  return async opts => {
    if (!opts || !opts.look || typeof opts.look.purpose !== 'string' || !Array.isArray(opts.look.ledger)) {
      throw new Error('a scorecard reads a run only under a look (purpose and ledger): refused');
    }
    lookAt(readRun(opts.runDir), opts.look);
    return scorecard(opts);
  };
}

/** The evaluator's result with the proposal's strategy and rulebook files it did not score (judge keeps those blocked). */
function withUncovered(evaluator, proposal) {
  if (!evaluator || !evaluator.available) return evaluator;
  const covers = new Set(evaluator.covers || []);
  return { ...evaluator, uncovered: [...new Set(proposal.edits.map(e => e.file))].filter(f => ['strategy', 'rulebook'].includes(P.kindOf(f)) && !covers.has(f)) };
}

/** The scorecard's records as decisions: key, time, category, whether in a trade, and what the proposer reads. */
function scorecardDecisions(records) {
  return records.map(r => ({
    key: `${r.t}|${r.symbol}`, t: r.t, day: r.day, symbol: r.symbol, category: r.category, inTrade: r.decision === 'in-trade',
    et: r.facts && r.facts.et, expected: { decision: r.expected && r.expected.decision, setup: r.expected && r.expected.setup },
    actual: { action: r.actual && r.actual.action, setup: r.actual && r.actual.setup }, why: r.why || [],
    falseReasons: ((r.reasons && r.reasons.claims) || []).filter(c => c.check === false && !c.incidental).map(c => `"${c.clause}": ${c.why}`),
    stated: r.actual && r.actual.result,
    // A blow: the account at or past its floor at this decision (the evaluator, step 9, judges blows over attempts).
    blow: Boolean(r.pacing && typeof r.pacing.cushion === 'number' && r.pacing.cushion <= 0),
  }));
}

function defaultSteps({ root, env = process.env }) {
  return {
    // The champion: HEAD (a clean repository); a candidate or the proposer: the champion's own commit, whatever HEAD is now.
    makeTree: (dir, commit) => T.exportTree(root, dir, { commit }),
    prepareTree: (dir, opts) => T.prepareTree(dir, opts),
    // The driver's step, plus whether the side's replay account holds a position or a working order (a point runs on).
    stepDeps: (run, tree) => ({
      ...driver.defaultDeps(run, tree),
      inTrade: (stepEnv, account) => withAdapter({ root: tree, env: stepEnv }, async a => {
        const s = await a.accountState(account);
        return s.positions.length > 0 || s.orders.length > 0;
      }),
    }),
    seedRunHome: (run, opts) => driver.seedRunHome(run, opts),
    runReplay: opts => driver.runReplay(opts),
    // Step 2's scorecard (replay/scorecard.js) as decisions; a run still open is scored as it stands.
    // look: the look the scorecard checks against the ledger's rules before it reads the run (tuning, or judging held out).
    scorecard: ({ runDir, tree, look }) => scorecardDecisions(scoreRun(runDir, { strategies: loadStrategies(tree, env).strategies, accounts: loadAccounts(tree, env).accounts, unfinished: true, look: look || {} }).records),
    // Step 9's two-layer evaluator (train/evaluator.js): { available, blows, failures, windows }.
    evaluator: opts => E.evaluate({ ...opts, env }),
    propose: opts => proposer.propose(opts),
    writeBranch: (opts) => T.writeBranch(root, opts),
  };
}

function refuseIfLive(env) {
  for (const home of new Set([harnessHome(env), harnessHome({})])) {
    const pid = liveRunner({ FTH_HOME: home });
    if (pid) throw new Error(`training refused: a live runner holds the account (pid ${pid}, ${home}); train when it is stopped`);
  }
  // One loop per machine as well: a loop on the default home blocks one on another home (read only).
  const other = S.lockHolder(S.loopPaths({}, '_').lock);
  if (other && other.pid !== process.pid && S.loopPaths(env, '_').lock !== S.loopPaths({}, '_').lock) {
    throw new Error(`training refused: another training loop (pid ${other.pid}, ${other.loopId}) is running on the default home`);
  }
}

/** A context for one command: paths, lock, state, the budget and its check before every model call. */
function open({ loop, env, root, steps, log, lock = true }) {
  refuseIfLive(env);
  const paths = S.loopPaths(env, loop.loopId);
  const release = lock ? S.acquireLock(paths, { loopId: loop.loopId }) : () => {};
  try {
    const state = S.openState(paths, { loopId: loop.loopId, hash: loop.hash });
    const merged = { ...defaultSteps({ root, env }), ...(steps || {}) };
    const ctx = { loop, env, root, steps: { ...merged, scorecard: checkedScorecard(merged.scorecard) }, log: log || (() => {}), paths, state, release, startedMs: Date.now() };
    ctx.save = () => S.saveState(paths, state);
    ctx.check = () => {
      const why = S.budgetLeft(state, loop.limits, { startedMs: ctx.startedMs });
      if (why) throw new Stop(why);
      // A live runner started since: refused before every model call, not only at the start.
      refuseIfLive(env);
    };
    ctx.call = () => {
      ctx.check();
      S.spend(state, 1);
      ctx.save();
    };
    return ctx;
  } catch (err) {
    release();
    throw err;
  }
}

/** Runs `fn` once per key across resumes: its result is the phase's file; a phase done is read back. */
async function phase(ctx, key, file, fn) {
  if (ctx.state.done[key] && fs.existsSync(file)) return readJson(file, null);
  const out = await fn();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, out);
  ctx.state.done[key] = true;
  ctx.save();
  return out;
}

const W = ctx => ctx.loop.workDir;

async function championTree(ctx) {
  const file = path.join(ctx.paths.dir, 'champion-tree.json');
  const done = ctx.state.done['tree:champion'] && readJson(file, null);
  if (done && !fs.existsSync(done.dir)) throw new Error(`the champion's tree (${done.dir}) is gone: the loop's runs were made with it; start a new loopId`);
  return phase(ctx, 'tree:champion', file, async () => {
    const dir = path.join(W(ctx), 'trees', 'champion');
    if (fs.existsSync(dir)) T.removeTree(dir, path.join(W(ctx), 'trees'));
    const baseCommit = await ctx.steps.makeTree(dir);
    await ctx.steps.prepareTree(dir, {});
    return { dir, baseCommit: baseCommit || null };
  });
}

/**
 * A window run's learning gate: the run's window and `"learning"` flag (the loop's replay config), the loop's
 * `learning` settings (validate; never reasoningFix: the loop reads every outcome) and, outside practice-train, its evaluation id (the loop's, one per window:
 * <evaluation>.<label>), required
 * there as replay.js run requires --evaluation; the candidate is the loop's look's.
 */
function learningGate(ctx, run, look, label) {
  const l = ctx.loop.learning || {};
  let practice = false;
  try { practice = rolesBetween(run.start, run.end).every(r => r === 'practice-train'); } catch (_err) { /* the gate names it */ }
  const looked = run.learning !== false && !practice;
  return {
    from: run.start, to: run.end, runId: run.runId, learning: run.learning,
    candidate: looked && l.evaluation ? look.candidate : null, evaluation: looked && l.evaluation ? `${l.evaluation}.${label}` : null,
    validate: looked && l.validate === true, reasoningFix: false, endOfDay: run.endOfDay, practice: run.practice || null, runDir: run.paths.runDir, arm: 'without', config: ctx.loop.hash, env: ctx.env,
  };
}

/** The champion's continuous runs of a set of windows, with checkpoints; then their decisions. */
async function championRuns(ctx, { tag, windows, tree, look }) {
  if (!ctx.state.done[`look:${tag}`]) {
    S.logLook(ctx.paths.ledger, look);
    ctx.state.done[`look:${tag}`] = true;
    ctx.save();
  }
  const runs = [];
  for (const [i, window] of windows.entries()) {
    const label = `champion-${tag}${i}`;
    const run = resolveReplay(replayFor(ctx.loop, { label, window }), { baseDir: ctx.root, env: ctx.env, root: tree });
    const checkpoints = path.join(W(ctx), 'checkpoints', label);
    runs.push({ label, window, runDir: run.paths.runDir, checkpoints, run });
    if (ctx.state.done[`run:${label}`]) continue;
    // The learning gate (learning/run-gate.js), as replay.js run applies it: checked before the run home is seeded,
    // its look taken before the first cycle, its decision checked again on resume. The point runs start from this
    // run's checkpoints (decision-points.js runPoint copies its home), so they inherit what it was allowed.
    const gate = learningGate(ctx, run, look, label);
    checkLearningRun(gate);
    ctx.steps.seedRunHome(run, { root: tree, userEnv: ctx.env });
    const learned = (ctx.steps.startLearningRun || startLearningRun)(run.paths.runHome, gate);
    // The loop reads every outcome (scorecards, the paired test): a run whose outcomes are hidden never runs in it.
    if (learned.hideOutcomes) throw new Error(`${label}: a reasoning-fix look hides its outcomes, and the training loop reads them: refused`);
    ctx.check();
    const left = ctx.loop.limits.maxModelCalls - ctx.state.modelCalls;
    const deps = D.checkpointDeps(ctx.steps.stepDeps(run, tree), { run, dir: checkpoints });
    ctx.log(`${label}: the champion's replay of ${window.from}..${window.to}, with checkpoints`);
    const res = await ctx.steps.runReplay({ run, baseEnv: ctx.env, root: tree, deps, maxCycles: left, log: ctx.log });
    S.spend(ctx.state, res.cycles || 0);
    ctx.save();
    // Stopped at the model-call limit (its cycles are the calls left) or for the driver's own reason.
    if (!res.done) throw new Stop(S.budgetLeft(ctx.state, ctx.loop.limits, { startedMs: ctx.startedMs }) || res.stopped || `${label}: not finished`);
    ctx.state.done[`run:${label}`] = true;
    ctx.save();
  }
  const decisions = await phase(ctx, `scorecard:${tag}`, path.join(ctx.paths.dir, `champion-${tag}-decisions.json`), async () => {
    const out = [];
    for (const r of runs) out.push(...(await ctx.steps.scorecard({ runDir: r.runDir, tree, look: ctx.lookFor() })).map(d => ({ ...d, run: r.label })));
    return out;
  });
  return { runs, decisions };
}

/** One side's point runs (champion or a candidate), scored: [{ key, repeat, category, blow }]. */
async function sideRuns(ctx, { side, dir, tree, panel, runs, baselineSide = null }) {
  const out = [];
  for (const [pi, point] of panel.points.entries()) {
    const r = runs.find(x => x.label === point.run) || runs[0];
    const followers = D.followersOf(r.runDir, point);
    for (let k = 0; k < ctx.loop.repeats; k += 1) {
      const home = path.join(dir, side, `${pi}-r${k}`);
      const resultFile = path.join(dir, side, `${pi}-r${k}.json`);
      let result = readJson(resultFile, null);
      if (!result) {
        const seed = D.pointSeed(ctx.loop.seed, point.t, k);
        // A candidate runs at least every time the champion's run of this point and repeat reached.
        const champ = baselineSide ? readJson(path.join(dir, baselineSide, `${pi}-r${k}.json`), null) : null;
        result = await D.runPoint({
          run: r.run, checkpoint: D.checkpointOf(r.checkpoints, point.t), home, tree, point, followers, mustRun: champ ? champ.times : [], repeat: k, seed, baseEnv: ctx.env,
          stepDeps: ctx.steps.stepDeps, onCall: ctx.call,
        });
        const decisions = result.error ? [] : await ctx.steps.scorecard({ runDir: result.runDir, tree, look: ctx.lookFor() });
        result.decisions = decisions.filter(d => result.times.includes(d.t)).map(d => ({ key: `${point.t}|${d.key}`, repeat: k, category: d.category, blow: d.blow === true }));
        writeJsonAtomic(resultFile, result);
      }
      out.push(...result.decisions);
    }
  }
  return out;
}

/** Each panel point carries the run it came from. */
function withRuns(panel, decisions) {
  const runOf = new Map(decisions.map(d => [d.t, d.run]));
  return { ...panel, points: panel.points.map(p => ({ ...p, run: runOf.get(p.t) })) };
}

async function candidateTree(ctx, { dir, id, proposal, champion }) {
  const treeDir = path.join(dir, 'trees', id);
  const owned = path.join(dir, 'trees');
  if (fs.existsSync(treeDir)) T.removeTree(treeDir, owned);
  await ctx.steps.makeTree(treeDir, champion.baseCommit);
  await ctx.steps.prepareTree(treeDir, { proposal });
  // The candidate is the champion plus the proposal and the adapters generated from it; anything else fails closed.
  const files = T.changedFiles(champion.dir, treeDir);
  const stray = files.filter(f => !proposal.edits.some(e => e.file === f) && !T.GENERATED.test(f));
  if (stray.length) throw new Error(`the candidate's tree differs from the champion's beyond the proposal and its generated adapters: ${stray.slice(0, 10).join(', ')}`);
  return { dir: treeDir, files };
}

/**
 * What the proposer must not touch, as digests: the loop's state and archive, the look ledger, the champion's tree.
 * (The checkpoints and run homes, possibly gigabytes, are not hashed: the proposer's harness home and working
 * directory are its own, and nothing points it at them.)
 */
function guarded(ctx, champion) {
  const ledger = fs.existsSync(ctx.paths.ledger) ? fileDigest('ledger', fs.readFileSync(ctx.paths.ledger)) : null;
  return JSON.stringify([dirDigest(ctx.paths.dir), ledger, dirDigest(champion.dir)]);
}

async function proposalsFor(ctx, { n, flagged, champion }) {
  const queued = path.join(ctx.paths.dir, 'imported');
  const files = fs.existsSync(queued) ? fs.readdirSync(queued).filter(f => f.endsWith('.json')).sort() : [];
  if (files.length) {
    // Tier 3 (manual): proposals a person imported come first; no model is called for this iteration.
    // Marked used once the phase's file is written (below, after the propose phase), so a stop in between loses none.
    const list = files.slice(0, ctx.loop.maxProposals).map(f => ({ ...(readJson(path.join(queued, f), null) || {}), file: f }));
    return list.map(x => (x.proposal && typeof x.proposal === 'object'
      ? { proposal: x.proposal, source: `manual, approved by ${x.approvedBy}`, imported: x.file }
      : { error: `imported file ${x.file} is unreadable or holds no proposal`, source: 'manual', imported: x.file }));
  }
  ctx.call();
  // The proposer reads its own copy of the champion's documents (its working directory), never the trees the runs use.
  const scratch = path.join(W(ctx), `iter-${n}`, 'proposer');
  const own = path.join(scratch, 'tree');
  if (fs.existsSync(own)) T.removeTree(own, scratch);
  await ctx.steps.makeTree(own, champion.baseCommit);
  // Its harness's own tools could write files: anything the loop judges with that changed fails closed.
  const before = guarded(ctx, champion);
  const res = await ctx.steps.propose({ cfg: ctx.loop.proposer, tree: own, flagged, home: path.join(scratch, 'home'), baseEnv: ctx.env, maxProposals: ctx.loop.maxProposals });
  if (guarded(ctx, champion) !== before) throw new Error('the proposer\'s run changed the loop\'s state, the look ledger or the champion\'s tree: the loop stops; check them before resuming');
  return res.proposals.map(p => ({ ...p, source: 'proposer' }));
}

async function iteration(ctx, n, { champion, champ }) {
  const it = ctx.state.iterations.find(x => x.n === n) || (ctx.state.iterations.push({ n, done: false }), ctx.state.iterations[ctx.state.iterations.length - 1]);
  const dir = ctx.paths.iter(n);
  const work = path.join(W(ctx), `iter-${n}`);
  const used = ctx.state.iterations.filter(x => x.n < n).flatMap(x => x.targeted || []);
  const panel = await phase(ctx, `${n}:panel`, path.join(dir, 'panel.json'), async () => {
    const p = D.choosePanel({ decisions: champ.decisions, used, maxFlagged: ctx.loop.maxFlagged, control: ctx.loop.controlPoints, seed: `${ctx.loop.seed}|${n}`, failures: P.FAILURES });
    return withRuns(p, champ.decisions);
  });
  if (!panel.flagged.length) {
    it.done = true;
    it.nothing = true;
    ctx.save();
    throw new Stop('nothing flagged left to work on: the champion\'s scored decisions are all right, unchecked or already targeted');
  }
  it.targeted = panel.flagged.map(d => d.key);
  ctx.save();
  const archive = A.readArchive(ctx.paths.archive);
  const proposals = await phase(ctx, `${n}:propose`, path.join(dir, 'proposals.json'), async () => {
    const raw = await proposalsFor(ctx, { n, flagged: panel.flagged, champion });
    const ids = [];
    return raw.map(x => {
      if (x.error) return { id: null, source: x.source, errors: [x.error], line: x.line, imported: x.imported };
      const id = P.proposalId(x.proposal);
      // The same change twice in one reply is one proposal.
      if (ids.includes(id)) return null;
      ids.push(id);
      const errors = P.validateProposal(x.proposal, { root: champion.dir });
      const before = A.judgedBefore(archive, id);
      return { id, source: x.source, proposal: x.proposal, errors, duplicateOf: before ? before.iteration : null, imported: x.imported };
    }).filter(Boolean);
  });
  for (const x of proposals.filter(y => y.imported)) {
    const f = path.join(ctx.paths.dir, 'imported', x.imported);
    if (fs.existsSync(f)) fs.renameSync(f, `${f}.used-${n}`);
  }
  const runnable = proposals.filter(x => x.id && !x.errors.length && x.duplicateOf === null);
  const baseline = runnable.length ? await phase(ctx, `${n}:baseline`, path.join(dir, 'baseline.json'), () => sideRuns(ctx, { side: 'champion', dir: work, tree: champion.dir, panel, runs: champ.runs })) : [];
  const verdicts = [];
  for (const x of runnable) {
    const cand = await phase(ctx, `${n}:candidate:${x.id}`, path.join(dir, `candidate-${x.id}.json`), async () => {
      const tree = await candidateTree(ctx, { dir: work, id: x.id, proposal: x.proposal, champion });
      return { tree: tree.dir, files: tree.files, decisions: await sideRuns(ctx, { side: x.id, dir: work, tree: tree.dir, panel, runs: champ.runs, baselineSide: 'champion' }) };
    });
    const v = await phase(ctx, `${n}:verdict:${x.id}`, path.join(dir, `verdict-${x.id}.json`), async () => {
      // Paired: the champion's tree and the candidate's, the same windows, bar files and seed.
      const evaluator = await ctx.steps.evaluator({ cfg: ctx.loop.evaluator, champion: champion.dir, candidate: cand.tree, proposal: x.proposal, windows: ctx.loop.tuningWindows, seed: ctx.loop.seed, look: { candidate: `${ctx.loop.loopId}/iter-${n}/${x.id}`, purpose: 'tuning' }, ledger: ctx.paths.ledger, log: ctx.log });
      return { ...judge({ pairs: pairUp(baseline, cand.decisions), targets: x.proposal.targets, failures: P.FAILURES, rule: ctx.loop.rule, mechanical: P.isMechanical(x.proposal), evaluator: withUncovered(evaluator, x.proposal) }), evaluator };
    });
    verdicts.push({ x, cand, v });
  }
  await phase(ctx, `${n}:archive`, path.join(dir, 'archived.json'), async () => {
    const already = new Set(A.readArchive(ctx.paths.archive).filter(e => e.iteration === n).map(e => e.proposalId));
    const common = { iteration: n, windows: ctx.loop.tuningWindows, seed: ctx.loop.seed, repeats: ctx.loop.repeats, baseCommit: champion.baseCommit, panel: { flagged: panel.flagged.length, control: panel.control.length, points: panel.points.map(p => p.t) } };
    for (const x of proposals.filter(y => !runnable.includes(y))) {
      const id = x.id || `invalid-${n}-${proposals.indexOf(x)}`;
      if (!already.has(id)) A.appendEntry(ctx.paths.archive, { ...common, proposalId: id, source: x.source, proposal: x.proposal || null, verdict: x.duplicateOf !== null && x.duplicateOf !== undefined ? 'duplicate' : 'invalid', reasons: x.errors.length ? x.errors : [`judged before, in iteration ${x.duplicateOf}`] });
    }
    for (const { x, cand, v } of verdicts) {
      if (already.has(x.id)) continue;
      const entry = { ...common, proposalId: x.id, source: x.source, proposal: x.proposal, files: cand.files, verdict: v.verdict, reasons: v.reasons, tests: v.tests, evaluator: v.evaluator };
      if (v.verdict === 'kept') entry.promotion = promote(ctx, { entry, n, tree: cand.tree, dir });
      A.appendEntry(ctx.paths.archive, entry);
      ctx.log(`iteration ${n}: ${x.id} ${v.verdict}: ${v.reasons.join('; ')}`);
    }
    return { at: new Date().toISOString() };
  });
  it.done = true;
  ctx.save();
}

/** A kept change: the PR body draft and the edits (always); a local branch unless dry-run. Never pushed. */
function promote(ctx, { entry, n, tree, dir }) {
  const out = path.join(dir, 'promotion', entry.proposalId);
  fs.mkdirSync(out, { recursive: true });
  const body = A.prBody(entry, { loopId: ctx.loop.loopId });
  fs.writeFileSync(path.join(out, 'pr-body.md'), body);
  writeJsonAtomic(path.join(out, 'proposal.json'), entry.proposal);
  const branch = `train/${ctx.loop.loopId}-i${n}-${entry.proposalId}`;
  if (ctx.dryRun || !entry.baseCommit) return { dir: out, branch: null, why: ctx.dryRun ? 'dry run: no branch' : 'no champion commit (a copied tree): no branch' };
  const message = `docs: training loop ${ctx.loop.loopId} iteration ${n}: ${entry.proposal.targets.join(', ')}\n\n${entry.proposal.expects}\n`;
  const commit = ctx.steps.writeBranch({ branch, base: entry.baseCommit, fromDir: tree, files: entry.files, message, indexFile: path.join(out, 'index.tmp') });
  ctx.log(`kept ${entry.proposalId}: branch ${branch} (${commit.slice(0, 12)}), PR body ${path.join(out, 'pr-body.md')}; never pushed`);
  return { dir: out, branch, commit };
}

async function runLoop({ loop, env = process.env, root, steps, dryRun = false, log }) {
  const ctx = open({ loop, env, root, steps, log });
  ctx.dryRun = dryRun;
  // The scorecard's look: tuning, checked against the ledger as it stands (tuning looks spend no budget).
  ctx.lookFor = () => ({ purpose: 'tuning', candidate: loop.loopId, ledger: S.readLedger(ctx.paths.ledger) });
  try {
    // Every tuning window must be one the ledger allows a tuning look at, before anything runs.
    const v = checkLook({ candidate: `${loop.loopId}/plan`, purpose: 'tuning', ranges: loop.tuningWindows }, S.readLedger(ctx.paths.ledger));
    if (!v.ok) throw new Error(`look refused:\n- ${v.refusals.join('\n- ')}`);
    const champion = await championTree(ctx);
    const champ = await championRuns(ctx, { tag: 't', windows: loop.tuningWindows, tree: champion.dir, look: { candidate: `${loop.loopId}/champion`, purpose: 'tuning', ranges: loop.tuningWindows, what: 'training loop: the champion\'s tuning replays' } });
    for (;;) {
      const open1 = ctx.state.iterations.find(x => !x.done);
      if (!open1) {
        const why = S.budgetLeft(ctx.state, loop.limits, { startedMs: ctx.startedMs, starting: true });
        if (why) throw new Stop(why);
      }
      const n = open1 ? open1.n : ctx.state.iterations.length + 1;
      if (!ctx.state.done[`look:iter-${n}`]) {
        S.logLook(ctx.paths.ledger, { candidate: `${loop.loopId}/iter-${n}`, purpose: 'tuning', ranges: loop.tuningWindows, what: `training loop iteration ${n}: panel and paired re-run` });
        ctx.state.done[`look:iter-${n}`] = true;
        ctx.save();
      }
      await iteration(ctx, n, { champion, champ });
    }
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    ctx.state.stopped = err.message;
    ctx.save();
    ctx.log(`stopped: ${err.message}`);
    return { stopped: err.message, iterations: ctx.state.iterations.filter(x => x.done).length };
  } finally {
    ctx.release();
  }
}

/** Held-out judging of a kept change: a judging look at heldOutWindows, budgeted (R16, R17, R26); never shown to the proposer. */
async function judgeHeldOut({ loop, env = process.env, root, steps, proposalId, heldOutLook = false, log }) {
  if (!heldOutLook) throw new Error('held-out judging spends the look budget: pass --held-out-look to take the look');
  if (!loop.heldOutWindows) throw new Error('heldOutWindows: the config names none');
  // Only months the search never tunes on judge: Select, Out-of-sample, a walk-forward held-out quarter.
  for (const w of loop.heldOutWindows) {
    const u = unitContaining(w.from, w.to);
    if (!u || !(u.role === 'select' || u.role === 'oos' || u.part === 'held-out')) throw new Error(`heldOutWindows ${w.from}..${w.to}: not inside one held-out unit (Select, Out-of-sample, or a walk-forward held-out quarter)`);
  }
  const ctx = open({ loop, env, root, steps, log });
  try {
    const archive = A.readArchive(ctx.paths.archive);
    const entry = archive.find(e => e.proposalId === proposalId && e.verdict === 'kept' && e.phase !== 'held-out');
    if (!entry) throw new Error(`${proposalId}: no change kept on tuning in this loop's archive`);
    if (archive.some(e => e.proposalId === proposalId && e.phase === 'held-out')) throw new Error(`${proposalId} was judged on held-out months already: each held-out month judges once`);
    const tag = `h-${proposalId}-`;
    const champion = await championTree(ctx);
    // The ledger as it was before this judging's one look: the evaluator checks the same look on copies of it, so a
    // judging spends one look, however many windows and scorings it holds.
    const before = path.join(ctx.paths.dir, `held-out-${proposalId}`, 'ledger-before.jsonl');
    // The scorecard checks the same judging look against that snapshot: it reads, it never logs.
    // Without it a check would run against the recorded looks alone: fail closed, never an empty ledger.
    const missing = () => new Error(`the held-out ledger snapshot ${before} is missing: this judging's look was already logged, and its checks can't run without the ledger as it was before that look. Restore the file from a backup to resume. Otherwise the held-out months ${loop.heldOutWindows.map(w => `${w.from}..${w.to}`).join(', ')} are spent (each judges once, in any loop): judging needs held-out months not yet used.`);
    const snapshot = () => {
      if (!fs.existsSync(before)) throw missing();
      return S.readLedger(before);
    };
    ctx.lookFor = () => ({ purpose: 'judging', candidate: `${loop.loopId}/${proposalId}`, ledger: snapshot() });
    if (!ctx.state.done[`look:${tag}`]) {
      // Each held-out month judges once (section 4), across every loop and change. The month check, the snapshot
      // and the look are one step under the ledger's lock, so two judgings can't both take a month. "Started" is
      // saved first: a stop after the look is logged but before it is saved resumes with this loop's own look.
      const started = ctx.state.done[`judging:${tag}`] === 'started';
      if (!started) {
        ctx.state.done[`judging:${tag}`] = 'started';
        ctx.save();
      }
      S.takeJudgingLook(ctx.paths.ledger, { candidate: `${loop.loopId}/${proposalId}`, purpose: 'judging', ranges: loop.heldOutWindows, what: 'training loop: held-out judging of a kept change' }, { snapshot: before, own: { loopId: loop.loopId, proposalId }, resume: started });
      ctx.state.done[`look:${tag}`] = true;
      ctx.save();
    } else if (!fs.existsSync(before)) throw missing();
    const champ = await championRuns(ctx, { tag, windows: loop.heldOutWindows, tree: champion.dir, look: { candidate: `${loop.loopId}/${proposalId}`, purpose: 'judging', ranges: loop.heldOutWindows, what: 'training loop: held-out judging of a kept change' } });
    const dir = path.join(ctx.paths.dir, `held-out-${proposalId}`);
    const work = path.join(W(ctx), `held-out-${proposalId}`);
    const all = P.FAILURES.concat(['right']);
    const panel = withRuns(D.choosePanel({ decisions: champ.decisions.filter(d => all.includes(d.category)), maxFlagged: ctx.loop.maxFlagged, control: ctx.loop.controlPoints, seed: `${loop.seed}|${tag}`, failures: P.FAILURES }), champ.decisions);
    const baseline = await phase(ctx, `${tag}baseline`, path.join(dir, 'baseline.json'), () => sideRuns(ctx, { side: 'champion', dir: work, tree: champion.dir, panel, runs: champ.runs }));
    const cand = await phase(ctx, `${tag}candidate`, path.join(dir, 'candidate.json'), async () => {
      const tree = await candidateTree(ctx, { dir: work, id: proposalId, proposal: entry.proposal, champion });
      return { tree: tree.dir, files: tree.files, decisions: await sideRuns(ctx, { side: proposalId, dir: work, tree: tree.dir, panel, runs: champ.runs, baselineSide: 'champion' }) };
    });
    // The candidate alone, a judging look the evaluator logs before it reads a bar (each scoring is a look).
    const evaluator = await phase(ctx, `${tag}evaluator`, path.join(dir, 'evaluator.json'), () => ctx.steps.evaluator({
      cfg: loop.evaluator, champion: null, candidate: cand.tree, proposal: entry.proposal, windows: loop.heldOutWindows, seed: loop.seed,
      look: { candidate: `${loop.loopId}/${proposalId}`, purpose: 'judging' }, ledger: before, scratchLedger: { file: path.join(dir, 'ledger-scratch.jsonl') }, log: ctx.log,
    }));
    const v = judge({ pairs: pairUp(baseline, cand.decisions), targets: entry.proposal.targets, failures: P.FAILURES, rule: loop.rule, mechanical: P.isMechanical(entry.proposal), evaluator: withUncovered(evaluator, entry.proposal) });
    A.appendEntry(ctx.paths.archive, { phase: 'held-out', iteration: entry.iteration, proposalId, windows: loop.heldOutWindows, seed: loop.seed, repeats: loop.repeats, baseCommit: champion.baseCommit, verdict: v.verdict, reasons: v.reasons, tests: v.tests, evaluator });
    return v;
  } catch (err) {
    if (err instanceof Stop) return { verdict: 'stopped', reasons: [err.message] };
    throw err;
  } finally {
    ctx.release();
  }
}

/** Tier 3: a proposal a person brings (from any source they chose), validated now and queued for the next iteration. */
function importProposal({ loop, env = process.env, root, proposal, approvedBy }) {
  if (typeof approvedBy !== 'string' || !approvedBy.trim()) throw new Error('--approved-by <name>: a person approves every imported proposal');
  const errors = P.validateProposal(proposal, { root });
  if (errors.length) throw new Error(`proposal refused:\n- ${errors.join('\n- ')}`);
  const paths = S.loopPaths(env, loop.loopId);
  const id = P.proposalId(proposal);
  const file = path.join(paths.dir, 'imported', `${Date.now()}-${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, { proposal, approvedBy: approvedBy.trim(), at: new Date().toISOString() });
  return { id, file };
}

module.exports = { Stop, checkedScorecard, defaultSteps, scorecardDecisions, runLoop, judgeHeldOut, importProposal, refuseIfLive };
