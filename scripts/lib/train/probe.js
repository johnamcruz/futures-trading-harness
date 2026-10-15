'use strict';

/**
 * Propose-Probe-Compose (docs/TRAINING.md): one training-loop iteration's proposals, found fast without loosening the
 * bar for keeping one. A cheap screen first, then the strict test. With the loop config's `probe` (probe-config.js):
 *
 *   look      a tuning look at the probe windows (practice-train: no budget), logged once
 *   split     the curated moments split by session date, by a seeded hash (the loop's seed: screen.js halfOf), into a
 *             probe half and a confirm half, both practice-train; the report records the seed and each half's dates
 *   champion  the champion's tree replays the probe windows' curated moments (the stage-1 `probe.replay`, the loop's
 *             seed); its skill-usage report and scorecard on the probe half give the findings (findings.js): the
 *             skills with the most misreads, misses and wrong-reason refusals
 *   propose   one model call: the proposer writes up to k small, independent skill edits, each tagged with its skill,
 *             the finding it addresses and its kind (probe-edit.js), reading the lessons record's capped summary
 *             (lessons.js). Each is checked in code (proposal.js, probe-edit.js); an edit probed before is not re-run
 *   probe     each edit's tree replays the SAME moments with the SAME replay config and seed; code pairs it with the
 *             champion decision by decision on the probe half only and screens it (screen.js): helped, no effect or
 *             hurt. `parallel` probes at once (default 1; more only without latency charged: probe-config.js). The
 *             lessons record gets one line per probe
 *   compose   code combines every edit that helped into one change (compose.js: a conflict on the same lines keeps the
 *             larger paired gain), and that change is probed once more, judged on the confirm half only (no edit was
 *             chosen on it): it must hold there, and its parts must not cancel. The keep rule's verdict on it is
 *             added to the lessons record by the loop (train/loop.js)
 *   keep      a combined change that passes goes back to the loop as this iteration's one proposal, through the full
 *             keep rule (train/model-verifier.js, modelScore: the loop's full-day tuning windows, 0 blows, the pooled
 *             interval; held-out judging is its own step). Kept, it is a local branch and a PR body; nothing merges
 *
 * The LLM proposes; code judges, everywhere. Edits exist only in the probe trees (the loop's work directory) and in
 * a kept change's branch: never in the repository's working tree. Every probe phase is a file (resumable).
 *
 *   probeRound(ctx, { n, champion, api })   { proposals: [{ proposal, source, composition }], report }
 *   probeData({ runDir, tree, barsFiles, keep })  a probe run's experience decisions, skill-usage report (its
 *                                           points in keep(root, bar) counted; every point's relevance listed) and compose reads
 *   inHalf(which, seed)                     keep(root, bar) for one half
 *   pool(items, limit, fn)                  fn over items, at most limit at once; every started one finishes
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../harness-run');
const S = require('./state');
const T = require('./tree');
const P = require('./proposal');
const PE = require('./probe-edit');
const F = require('./findings');
const SC = require('./screen');
const C = require('./compose');
const LS = require('./lessons');
const { checkLook } = require('../prop/looks');

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  let failed = null;
  const worker = async () => {
    while (next < items.length && !failed) {
      const i = next;
      next += 1;
      try { out[i] = await fn(items[i], i); } catch (err) { failed = failed || err; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failed) throw failed;
  return out;
}

/** keep(root, bar) for one half of the moments (screen.js halfOf: by session date, seeded). */
function inHalf(which, seed) {
  const { tradingDayKey } = require('../trading/clock');
  return (_root, bar) => {
    const t = Date.parse(bar);
    return Number.isFinite(t) && SC.halfOf(tradingDayKey(new Date(t)), seed) === which;
  };
}

/** The default step: what the screen and the findings read from one finished probe run. */
function probeData({ runDir, tree, barsFiles = {}, keep = null }) {
  const { runDecisions } = require('../learning/run-experience');
  const { readSkillUsage, readComposeRecords } = require('../learning/skill-usage');
  const home = path.resolve(runDir, '..', '..');
  const usage = readSkillUsage(runDir, { barsFiles, keep, perPoint: true });
  return {
    decisions: runDecisions(runDir, { root: tree, barsFiles }).decisions,
    usage: { ...usage, perPoint: undefined },
    points: usage.perPoint.map(p => ({ root: p.root, bar: p.bar, relevant: p.relevant })),
    records: readComposeRecords(home).map(r => ({ root: r.root, bar: r.bar, reads: (r.reads || []).map(x => ({ step: x.step, read: x.read, skill: x.skill })) })),
  };
}

const compact = m => ({
  reads: m.reads, process: m.process, r: m.r, target: m.target, blows: m.blows,
  skill: m.skill ? { skill: m.skill.skill, champion: m.skill.champion, probe: m.skill.probe } : null,
});

async function probeRound(ctx, { n, champion, api }) {
  const cfg = ctx.loop.probe;
  const dir = ctx.paths.iter(n);
  const work = path.join(api.workDir, `iter-${n}`);
  const lessonsFile = path.join(ctx.paths.dir, LS.FILE);
  const look = { candidate: `${ctx.loop.loopId}/probe`, purpose: 'tuning' };
  if (!ctx.state.done['look:probe']) {
    const v = checkLook({ ...look, ranges: cfg.windows }, S.readLedger(ctx.paths.ledger));
    if (!v.ok) throw new Error(`the probe look is refused:\n- ${v.refusals.join('\n- ')}`);
    S.logLook(ctx.paths.ledger, { ...look, ranges: cfg.windows, what: 'training loop: probes of skill edits on curated practice-train moments' });
    ctx.state.done['look:probe'] = true;
    ctx.save();
  }
  const barsFiles = ctx.loop.evaluator && ctx.loop.evaluator.data ? ctx.loop.evaluator.data : {};
  // The overfit guard's split (screen.js halfOf): by session date, seeded by the loop's seed, recorded in the report.
  const seed = ctx.loop.seed;
  // One side's runs of the probe windows (the same replay config and seed for every side), reduced for the screen.
  // `which`: the half its skill-usage counts describe (the probe half for the champion's findings and each edit; the
  // confirm half for the combined change); every point's relevance is kept for the screen either way.
  const sideData = async (side, tree, share, which, withFindings = false) => {
    const runs = await api.windowRuns(ctx, { side, tag: 'p', windows: cfg.windows, tree, look, replay: cfg.replay, share });
    return api.phase(ctx, `probe-data:${side}`, path.join(ctx.paths.dir, 'probes', `${side}.json`), async () => {
      const data = [];
      for (const r of runs.runs) data.push(await ctx.steps.probeData({ runDir: r.runDir, tree, barsFiles, keep: inHalf(which, seed) }));
      const usage = F.mergeUsage(data.map(d => d.usage));
      const sided = SC.sideOf({ decisions: data.flatMap(d => d.decisions || []), scorecard: runs.decisions, usage, points: data.flatMap(d => d.points || []) });
      // The findings read the probe half only: its wrong-reason refusals (by their bar's session date).
      const ownHalf = runs.decisions.filter(d => inHalf(which, seed)(d.symbol, d.barT || d.t));
      return {
        side: sided,
        ...(withFindings ? { skills: usage, refusals: F.refusalsOf(ownHalf, data.flatMap(d => d.records || [])) } : {}),
      };
    });
  };
  const report = { iteration: n, windows: cfg.windows, seed };
  const writeReport = () => writeJsonAtomic(path.join(dir, 'probe-report.json'), report);
  const base = await sideData('pc', champion.dir, 1, 'probe', true);
  const days = which => [...new Set(SC.half(base.side, which, seed).decisions.map(d => d.day))].sort();
  report.split = { seed, by: 'session date', probe: days('probe'), confirm: days('confirm') };
  if (!report.split.probe.length || !report.split.confirm.length) {
    // One half holds no session dates: nothing could be screened on one and judged on the other, so never a pass.
    const pairs = which => SC.half(base.side, which, seed).decisions.length;
    report.split.pairs = { probe: pairs('probe'), confirm: pairs('confirm') };
    report.why = 'inconclusive: a half has no session dates';
    const id = `iteration-${n}-split`;
    if (!LS.readLessons(lessonsFile).some(e => e.iteration === n && e.proposalId === id)) {
      LS.appendLesson(lessonsFile, { proposalId: id, iteration: n, composed: true, verdict: 'no effect', n: 0, half: 'none', windows: cfg.windows, seed, why: report.why, pairs: report.split.pairs });
    }
    writeReport();
    ctx.log(`iteration ${n}: ${report.why} (decisions: probe ${report.split.pairs.probe}, confirm ${report.split.pairs.confirm})`);
    return { proposals: [], report };
  }
  const findings = await api.phase(ctx, `${n}:findings`, path.join(dir, 'findings.json'), async () => F.findingsFrom({
    skills: base.skills, refusals: base.refusals, max: cfg.k * 2, exists: s => fs.existsSync(path.join(champion.dir, 'skills', s, 'SKILL.md')),
  }));
  report.findings = findings;
  if (!findings.length) {
    report.why = 'no findings: the champion\'s practice runs show no misread, miss or wrong-reason refusal of a skill it can edit';
    writeReport();
    ctx.log(`iteration ${n}: ${report.why}`);
    return { proposals: [], report };
  }
  const edits = await api.phase(ctx, `${n}:probe-proposals`, path.join(dir, 'probe-proposals.json'), async () => {
    const lessons = LS.readLessons(lessonsFile);
    const before = new Set(lessons.map(e => e.proposalId));
    ctx.call();
    // The proposer reads its own copy of the champion's documents, never the trees the runs use.
    const scratch = path.join(work, 'proposer');
    const own = path.join(scratch, 'tree');
    if (fs.existsSync(own)) T.removeTree(own, scratch);
    await ctx.steps.makeTree(own, champion.baseCommit);
    const guard = api.guarded(ctx, champion);
    const res = await ctx.steps.proposeProbes({ cfg: ctx.loop.proposer, tree: own, findings, lessons: LS.summarize(lessons), home: path.join(scratch, 'home'), baseEnv: ctx.env, k: cfg.k });
    if (api.guarded(ctx, champion) !== guard) throw new Error('the proposer\'s run changed the loop\'s state, the look ledger or the champion\'s tree: the loop stops; check them before resuming');
    const ids = [];
    return res.proposals.slice(0, cfg.k).map(x => {
      if (x.error) return { id: null, errors: [x.error], line: x.line };
      const id = P.proposalId(x.proposal);
      if (ids.includes(id)) return null;
      ids.push(id);
      const errors = [...P.validateProposal(x.proposal, { root: champion.dir }), ...PE.tagErrors(x.tag, x.proposal, { findings })];
      if (!errors.length) errors.push(...PE.styleErrors(x.proposal, { root: champion.dir, kind: x.tag.kind }));
      const finding = findings.find(f => x.tag && f.id === x.tag.finding) || null;
      return { id, tag: x.tag, finding, proposal: x.proposal, errors, probedBefore: before.has(id) };
    }).filter(Boolean);
  });
  report.edits = edits.map(e => ({ id: e.id, tag: e.tag, errors: e.errors, probedBefore: e.probedBefore }));
  const runnable = edits.filter(e => e.id && !e.errors.length && !e.probedBefore);
  // Each edit alone, on the champion's moments and seed; `parallel` at once, each run's calls a share of those left.
  const probes = await pool(runnable, cfg.parallel, e => api.phase(ctx, `${n}:probe:${e.id}`, path.join(dir, `probe-${e.id}.json`), async () => {
    const tree = await api.candidateTree(ctx, { dir: work, id: `p-${e.id}`, proposal: e.proposal, champion });
    const side = await sideData(`p-${e.id}`, tree.dir, Math.min(cfg.parallel, runnable.length), 'probe');
    // Screened on the probe half only: the confirm half stays unseen until the combined change.
    const m = SC.measure(SC.half(base.side, 'probe', seed), SC.half(side.side, 'probe', seed), { skill: e.tag.skill, kind: e.finding.kind });
    return { id: e.id, tag: e.tag, finding: e.finding, proposal: e.proposal, measures: compact(m), screen: SC.screen(m) };
  }));
  // The lessons record: one line per probe, written once (a resume finds its lines by iteration and id).
  const recorded = new Set(LS.readLessons(lessonsFile).filter(e => e.iteration === n && !e.composed).map(e => e.proposalId));
  for (const p of probes.filter(x => !recorded.has(x.id))) {
    LS.appendLesson(lessonsFile, {
      proposalId: p.id, iteration: n, skill: p.tag.skill, kind: p.tag.kind, finding: { id: p.finding.id, kind: p.finding.kind, line: F.findingLine(p.finding) },
      findingKind: p.finding.kind, windows: cfg.windows, seed, half: 'probe', measures: p.measures, verdict: p.screen.verdict, n: p.measures.target.pairs,
    });
  }
  report.probes = probes.map(p => ({ id: p.id, tag: p.tag, finding: p.finding.id, verdict: p.screen.verdict, harms: p.screen.harms, target: p.measures.target }));
  for (const p of probes) ctx.log(`iteration ${n}: probe ${p.id} (${p.tag.skill}, ${p.tag.kind}, ${p.finding.id}): ${p.screen.verdict}${p.screen.harms.length ? `: ${p.screen.harms.join('; ')}` : ''}`);
  const passed = probes.filter(p => p.screen.pass);
  if (!passed.length) {
    report.why = 'no edit passed the screen';
    writeReport();
    return { proposals: [], report };
  }
  const composition = await api.phase(ctx, `${n}:compose`, path.join(dir, 'composition.json'), async () => C.compose(passed, { root: champion.dir }));
  report.composition = { parts: composition.parts.map(p => p.id), conflicts: composition.conflicts, dropped: composition.dropped };
  if (!composition.proposal) {
    report.why = 'nothing composed: every passing edit was left out';
    writeReport();
    return { proposals: [], report };
  }
  const cid = P.proposalId(composition.proposal);
  // The combined change, probed once more and judged on the confirm half only: it must hold there, its parts not cancel.
  const composed = await api.phase(ctx, `${n}:composed`, path.join(dir, `composed-${cid}.json`), async () => {
    const tree = await api.candidateTree(ctx, { dir: work, id: `k-${cid}`, proposal: composition.proposal, champion });
    const side = await sideData(`k-${cid}`, tree.dir, 1, 'confirm');
    const s = SC.composedScreen(SC.half(base.side, 'confirm', seed), SC.half(side.side, 'confirm', seed), passed.filter(p => composition.parts.some(x => x.id === p.id)));
    return { verdict: s.verdict, pass: s.pass, harms: s.harms, cancelled: s.cancelled, targets: s.targets, measures: s.measures ? compact(s.measures) : null };
  });
  // (One part alone: the combined change has the part's id, so the composed line is told apart by `composed`.)
  if (!LS.readLessons(lessonsFile).some(e => e.iteration === n && e.composed === true && e.proposalId === cid)) {
    LS.appendLesson(lessonsFile, {
      proposalId: cid, iteration: n, composed: true, parts: composition.parts.length, partIds: composition.parts.map(p => p.id), windows: cfg.windows, seed, half: 'confirm',
      measures: composed.measures, verdict: composed.verdict, n: Math.min(...composed.targets.map(t => t.target.pairs)),
    });
  }
  report.composed = { id: cid, verdict: composed.verdict, harms: composed.harms, cancelled: composed.cancelled };
  writeReport();
  ctx.log(`iteration ${n}: combined change ${cid} of ${composition.parts.length} edit(s): ${composed.verdict}${composed.pass ? ': to the keep rule' : ''}`);
  if (!composed.pass) return { proposals: [], report };
  return { proposals: [{ proposal: composition.proposal, source: 'propose-probe-compose', composition: { ...composition, proposal: undefined, composed: report.composed } }], report };
}

module.exports = { probeRound, probeData, pool, inHalf };
