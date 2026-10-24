'use strict';

/**
 * Propose-Probe-Compose (docs/TRAINING.md): one training-loop iteration's proposals, found fast without loosening the
 * bar for keeping one. A cheap screen first, then the strict test. With the loop config's `probe` (probe-config.js):
 *
 *   look      a tuning look at the probe windows (practice-train: no budget), logged once
 *   split     the curated moments split by session date, by a seeded hash (the loop's seed: screen.js halfOf), into a
 *             probe half and a confirm half, both practice-train, each written as a curated list of its own
 *             (probe-halves.js, the step halfReplay), so a side replays only the half it is judged on; the report records
 *             the seed and each half's dates, read from the list before any run
 *   champion  the champion's tree replays the probe half's curated moments (the stage-1 `probe.replay`, the loop's
 *             seed); its skill-usage report and scorecard give the findings (findings.js): the skills with the most
 *             misreads, misses and wrong-reason refusals, each placed on the flow step it blocks (flow.js). Its confirm
 *             half runs only once a round has a combined change to judge
 *   propose   one model call: the proposer writes up to k small, independent edits, each to one skill or one desk
 *             role's body (agent-edit.js), tagged with its target, the finding it addresses and its kind (probe-edit.js),
 *             reading the findings by flow step and the lessons record's capped summary (lessons.js). Each is checked in
 *             code (proposal.js, probe-edit.js, agent-edit.js); an edit probed before is not re-run
 *   probe     each edit's tree replays the SAME probe-half moments with the SAME replay config and seed (never the
 *             confirm half); code pairs it with the champion decision by decision and screens it (screen.js): helped, no effect or
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
 *
 * The report (probe-report.json) also holds each side's cost: the cycles its runs recorded (cycles.champion.probe and
 * .confirm, cycles.edits[id], cycles.composed), read by the iteration's summary (iteration-report.js).
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
const { recordedTimes } = require('../replay/store');
const TS = require('./trend-set');
const TSC = require('./trend-screen');
const TF = require('./trend-findings');
const TC = require('./trend-curve');
const { readJson } = require('../harness-run');

/** The steps (cycles) a run recorded; 0 for a run with no records. */
function stepsOf(runDir) {
  try {
    return recordedTimes(runDir).size;
  } catch (_err) {
    return 0;
  }
}

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

/** The default step: a whole-session trend run's capture report (replay/trend-capture.js), written to its folder, and its days. */
function trendData({ runDir }) {
  const tc = require('../replay/trend-capture');
  const { readRun } = require('../replay/store');
  const { readJson } = require('../harness-run');
  const days = readRun(runDir).days;
  const capture = tc.captureReport({ runDir, days, manifest: readJson(path.join(runDir, 'manifest.json'), {}) || {} });
  tc.writeCapture(runDir, capture);
  return { capture, days };
}

/**
 * An edit's verdict on both sets: any harm on either (the curated measures, the trend set's legs, net R and blows, the
 * regression days) is a harm; the gain is the target set's own (the trend set's legs for a trend finding, else the
 * curated target). Without a trend set, the curated screen alone.
 */
function combinedScreen({ curated, curatedTarget = true, trend = null, trendTarget = false, regression = [] }) {
  const t = trend ? TSC.screenTrend(trend, { target: trendTarget }) : null;
  const harms = [...curated.harms, ...(t ? t.harms : []), ...regression];
  const gain = Boolean((curatedTarget && curated.gain) || (trendTarget && t && t.gain));
  const verdict = harms.length ? 'hurt' : gain ? 'helped' : 'no effect';
  return { verdict, pass: verdict === 'helped', harms, gain };
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
  const trend = cfg.trend || null;
  const ranges = [...cfg.windows, ...(trend ? TS.dayWindows([...trend.set.days, ...(trend.regression ? trend.regression.days : [])]) : [])]; // the whole pool: every round draws from it
  if (!ctx.state.done['look:probe']) {
    const v = checkLook({ ...look, ranges }, S.readLedger(ctx.paths.ledger));
    if (!v.ok) throw new Error(`the probe look is refused:\n- ${v.refusals.join('\n- ')}`);
    S.logLook(ctx.paths.ledger, { ...look, ranges, what: `training loop: probes of skill and role edits on curated practice-train moments${trend ? ' and the trend set\'s sessions' : ''}` });
    ctx.state.done['look:probe'] = true;
    ctx.save();
  }
  const barsFiles = ctx.loop.evaluator && ctx.loop.evaluator.data ? ctx.loop.evaluator.data : {};
  // The overfit guard's split (screen.js halfOf): by session date, seeded by the loop's seed, recorded in the report.
  const seed = ctx.loop.seed;
  // One side's runs of the probe windows (the same replay config and seed for every side), reduced for the screen.
  // `which`: the half its skill-usage counts describe (the probe half for the champion's findings and each edit; the
  // confirm half for the combined change); every point's relevance is kept for the screen either way.
  // Each half is a run of its own (probe-halves.js): the curated list's half, written once per loop, so a side replays
  // only the half it is judged on (the champion each half, an edit the probe half, the combined change the confirm half).
  const halves = await api.phase(ctx, 'probe:halves', path.join(ctx.paths.dir, 'probes', 'halves.json'), async () => {
    const out = {};
    for (const which of SC.HALVES) out[which] = await ctx.steps.halfReplay({ replay: cfg.replay, which, seed, dir: path.join(api.workDir, 'curated-halves'), root: ctx.root });
    return out;
  });
  const TAG = { probe: 'p', confirm: 'q' };
  // `which`: the half the side replays and its skill-usage counts describe; every point's relevance is kept for the screen.
  const sideData = async (side, tree, share, which, withFindings = false) => {
    const runs = await api.windowRuns(ctx, { side, tag: TAG[which], windows: cfg.windows, tree, look, replay: halves[which].replay, share });
    return api.phase(ctx, `probe-data:${side}-${TAG[which]}`, path.join(ctx.paths.dir, 'probes', `${side}-${TAG[which]}.json`), async () => {
      const data = [];
      for (const r of runs.runs) data.push(await ctx.steps.probeData({ runDir: r.runDir, tree, barsFiles, keep: inHalf(which, seed) }));
      const usage = F.mergeUsage(data.map(d => d.usage));
      const sided = SC.sideOf({ decisions: data.flatMap(d => d.decisions || []), scorecard: runs.decisions, usage, points: data.flatMap(d => d.points || []) });
      // The findings read the probe half only: its wrong-reason refusals (by their bar's session date).
      const ownHalf = runs.decisions.filter(d => inHalf(which, seed)(d.symbol, d.barT || d.t));
      return {
        side: sided,
        // The cycles the side's runs stepped (their recorded steps): what this side cost, for the iteration's report.
        cycles: runs.runs.reduce((sum, r) => sum + stepsOf(r.runDir), 0),
        ...(withFindings ? { skills: usage, refusals: F.refusalsOf(ownHalf, data.flatMap(d => d.records || [])) } : {}),
      };
    });
  };
  // This round's batch from the trend pool (trend-set.js drawBatches: the census's order, without replacement across
  // rounds, reshuffled once the pool is used up); the champion and every edit of the round replay the same days, split
  // into the probe and confirm halves by the loop's seed. The regression days are the same every round.
  // This round's batch size (trend-curve.js planBatch, config/training.json trendBatch): from the earlier rounds' sizes and
  // outcomes (their iteration reports), frozen once planned; then its batch, the pool's next legs after theirs.
  const plan = trend ? await api.phase(ctx, `${n}:trend-plan`, path.join(dir, 'trend-plan.json'), async () => {
    const earlier = [];
    for (let i = 1; i < n; i += 1) {
      const rep = readJson(path.join(ctx.paths.iter(i), 'probe-report.json'), null);
      const rec = readJson(path.join(ctx.paths.iter(i), 'iteration-report.json'), null);
      if (rep && rep.trend && rep.trend.batch) earlier.push({ size: rep.trend.batch.size, outcome: rec && rec.trend ? rec.trend.outcome : 'neutral' });
    }
    return { ...TC.planBatch(earlier, { pool: trend.set.legs.length, cfg: trend.batch }), sizes: earlier.map(e => e.size) };
  }) : null;
  const draw = trend ? TS.drawBatches(trend.set.legs, { seed, sizes: [...plan.sizes, plan.size] }).pop() : null;
  // The batch split by session date into the probe half (findings, each edit's screen) and the confirm half (the
  // combined change), about trend.half of the legs each, no day in both.
  const split = draw ? TS.splitBatch(draw.items, { seed, half: trend.batch.half }) : null;
  const trendDays = which => (which === 'regression' ? (trend.regression ? trend.regression.days : []) : split[which].days);
  // One side's runs of a trend half's sessions (or the regression days), one run a session, each session's capture
  // report reduced for the screen. A session is its own phase: the champion's, replayed once in a loop (its tree never
  // changes inside one), is reused by every later round that draws it.
  const trendSide = async (side, tree, share, which, withFindings = false) => {
    const days = trendDays(which);
    if (!days.length) return null;
    const out = { legs: [], dayR: {}, blows: 0, cycles: 0, fresh: 0, captures: [] };
    for (const day of days) {
      const tag = `t${day.replace(/-/g, '')}`;
      const key = `trend-day:${side}:${day}`;
      const reused = Boolean(ctx.state.done[key]);
      const runs = await api.windowRuns(ctx, { side, tag, windows: TS.dayWindows([day]), tree, look, replay: trend.replay, share });
      const one = await api.phase(ctx, key, path.join(ctx.paths.dir, 'probes', 'trend', `${side}-${day}.json`), async () => {
        const got = await (ctx.steps.trendData || trendData)({ runDir: runs.runs[0].runDir });
        const x = TSC.sideOfTrend({ captures: [got.capture], days: got.days, scorecard: runs.decisions });
        return { legs: [...x.legs], dayR: x.dayR, blows: x.blows, cycles: stepsOf(runs.runs[0].runDir), ...(side === 'pc' ? { capture: got.capture } : {}) };
      });
      out.legs.push(...one.legs);
      Object.assign(out.dayR, one.dayR);
      out.blows += one.blows;
      out.cycles += one.cycles;
      if (!reused) out.fresh += one.cycles;
      if (withFindings && one.capture) out.captures.push(one.capture);
    }
    // A half screens the batch's own legs only (a replayed session can hold legs of another round's batch); the
    // regression days screen every leg they hold.
    const mine = which === 'regression' ? null : new Set(split[which].legs);
    const legs = mine ? out.legs.filter(([id]) => mine.has(id)) : out.legs;
    if (withFindings && mine) out.captures = out.captures.map(c => ({ ...c, legs: (c.legs || []).filter(l => mine.has(l.id)) }));
    return { ...out, legs, side: { legs: new Map(legs), dayR: out.dayR, blows: out.blows } };
  };
  const report = { iteration: n, windows: cfg.windows, seed, cycles: { champion: {}, edits: {} } };
  if (trend) {
    report.trend = {
      set: trend.set.fingerprint, batch: { index: n - 1, size: draw.items.length, from: draw.from, cycles: draw.cycles, trigger: plan.trigger, why: plan.why },
      probe: { days: split.probe.days, legs: split.probe.legs }, confirm: { days: split.confirm.days, legs: split.confirm.legs }, regression: trendDays('regression'),
    };
  }
  const writeReport = () => writeJsonAtomic(path.join(dir, 'probe-report.json'), report);
  report.split = { seed, by: 'session date', probe: halves.probe.days, confirm: halves.confirm.days };
  if (!report.split.probe.length || !report.split.confirm.length) {
    // One half holds no session dates: nothing could be screened on one and judged on the other, so never a pass.
    // Nothing is replayed for it either: the split is read from the list's moments before any run.
    report.split.moments = { probe: halves.probe.moments, confirm: halves.confirm.moments };
    report.why = 'inconclusive: a half has no session dates';
    const id = `iteration-${n}-split`;
    if (!LS.readLessons(lessonsFile).some(e => e.iteration === n && e.proposalId === id)) {
      LS.appendLesson(lessonsFile, { proposalId: id, iteration: n, composed: true, verdict: 'no effect', n: 0, half: 'none', windows: cfg.windows, seed, why: report.why, moments: report.split.moments });
    }
    writeReport();
    ctx.log(`iteration ${n}: ${report.why} (moments: probe ${report.split.moments.probe}, confirm ${report.split.moments.confirm})`);
    return { proposals: [], report };
  }
  // The champion's probe half: the findings and every edit's screen (its confirm half runs only for a combined change).
  const base = await sideData('pc', champion.dir, 1, 'probe', true);
  report.cycles.champion.probe = base.cycles;
  // The trend set's probe half and the regression days, the champion's (the findings read the probe half only).
  const trendBase = trend ? await trendSide('pc', champion.dir, 1, 'probe', true) : null;
  const regBase = trend ? await trendSide('pc', champion.dir, 1, 'regression') : null;
  // The champion's confirm half too, every round: the learning curve reads it (trend-curve.js); nothing of it reaches the
  // proposer, and no edit runs it.
  const trendConfirm = trend ? await trendSide('pc', champion.dir, 1, 'confirm') : null;
  if (trendBase) report.cycles.champion.trend = trendBase.fresh + (regBase ? regBase.fresh : 0) + (trendConfirm ? trendConfirm.fresh : 0);
  if (trendConfirm) {
    const legs = [...trendConfirm.side.legs.values()];
    const days = Object.values(trendConfirm.side.dayR);
    report.trend.champion = { legs: legs.length, caught: legs.filter(l => l.captured).length, netR: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10000) / 10000 : null, sessions: days.length };
  }
  const exists = s => fs.existsSync(path.join(champion.dir, 'skills', s, 'SKILL.md'));
  const findings = await api.phase(ctx, `${n}:findings`, path.join(dir, 'findings.json'), async () => F.mergeFindings(
    trendBase ? TF.trendFindings(trendBase.captures, { exists, max: cfg.k * 2 }) : [],
    F.findingsFrom({ skills: base.skills, refusals: base.refusals, max: cfg.k * 2, exists }),
    { max: cfg.k * 2 },
  ));
  report.findings = findings;
  if (!findings.length) {
    report.why = 'no findings: the champion\'s practice runs show no misread, miss, wrong-reason refusal or missed trend leg a skill or role edit could address';
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
    const share = Math.min(cfg.parallel, runnable.length);
    const side = await sideData(`p-${e.id}`, tree.dir, share, 'probe');
    // Screened on the probe half only: the confirm half stays unseen until the combined change.
    const m = SC.measure(SC.half(base.side, 'probe', seed), SC.half(side.side, 'probe', seed), { skill: e.tag.skill || null, kind: e.finding.kind });
    const ts = trendBase ? await trendSide(`p-${e.id}`, tree.dir, share, 'probe') : null;
    const rs = regBase ? await trendSide(`p-${e.id}`, tree.dir, share, 'regression') : null;
    const rm = rs ? TSC.measureTrend(regBase.side, rs.side) : null;
    const tm = ts ? TSC.measureTrend(trendBase.side, ts.side) : null;
    const isTrend = e.finding.kind === TF.KIND;
    if (isTrend && !tm) throw new Error(`probe ${e.id}: a trend finding needs the trend set's runs`);
    const screen = combinedScreen({ curated: SC.screen(m), curatedTarget: !isTrend, trend: tm, trendTarget: isTrend, regression: rs ? TSC.regressionHarms(regBase.side, rs.side) : [] });
    const measures = { ...compact(m), ...(tm ? { trend: tm } : {}), ...(rm ? { regression: rm } : {}), ...(isTrend ? { target: tm.capture } : {}) };
    return { id: e.id, tag: e.tag, finding: e.finding, proposal: e.proposal, measures, screen, cycles: side.cycles + (ts ? ts.cycles : 0) + (rs ? rs.cycles : 0) };
  }));
  // The lessons record: one line per probe, written once (a resume finds its lines by iteration and id).
  const recorded = new Set(LS.readLessons(lessonsFile).filter(e => e.iteration === n && !e.composed).map(e => e.proposalId));
  for (const p of probes.filter(x => !recorded.has(x.id))) {
    LS.appendLesson(lessonsFile, {
      proposalId: p.id, iteration: n, ...(p.tag.agent ? { agent: p.tag.agent } : { skill: p.tag.skill }), kind: p.tag.kind, finding: { id: p.finding.id, kind: p.finding.kind, line: F.findingLine(p.finding) },
      findingKind: p.finding.kind, windows: cfg.windows, seed, half: 'probe', measures: p.measures, verdict: p.screen.verdict, n: p.measures.target.pairs, ...(draw ? { trendBatch: { index: n - 1, set: trend.set.fingerprint, probe: split.probe.legs.length, confirm: split.confirm.legs.length } } : {}),
    });
  }
  report.probes = probes.map(p => ({ id: p.id, tag: p.tag, finding: p.finding.id, verdict: p.screen.verdict, harms: p.screen.harms, target: p.measures.target, ...(p.measures.trend ? { trend: { capture: p.measures.trend.capture } } : {}), ...(p.measures.regression ? { regression: { capture: p.measures.regression.capture } } : {}) }));
  for (const p of probes) report.cycles.edits[p.id] = p.cycles === undefined ? null : p.cycles;
  for (const p of probes) ctx.log(`iteration ${n}: probe ${p.id} (${(PE.targetOf(p.tag) || { label: '?' }).label}, ${p.tag.kind}, ${p.finding.id}): ${p.screen.verdict}${p.screen.harms.length ? `: ${p.screen.harms.join('; ')}` : ''}`);
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
  // The champion's confirm half: run once a round first has a combined change to judge on it (never for an edit).
  const confirmBase = await sideData('pc', champion.dir, 1, 'confirm');
  report.cycles.champion.confirm = confirmBase.cycles;
  // The combined change, probed once more and judged on the confirm half only: it must hold there, its parts not cancel.
  const composed = await api.phase(ctx, `${n}:composed`, path.join(dir, `composed-${cid}.json`), async () => {
    const tree = await api.candidateTree(ctx, { dir: work, id: `k-${cid}`, proposal: composition.proposal, champion });
    const side = await sideData(`k-${cid}`, tree.dir, 1, 'confirm');
    const parts = passed.filter(p => composition.parts.some(x => x.id === p.id));
    const champC = SC.half(confirmBase.side, 'confirm', seed);
    const probeC = SC.half(side.side, 'confirm', seed);
    const s = SC.composedScreen(champC, probeC, parts.filter(p => p.finding.kind !== TF.KIND));
    // The curated measures and harms even when every part is a trend part (no curated target then).
    const cm = s.measures || SC.measure(champC, probeC, {});
    const ts = trendConfirm ? await trendSide(`k-${cid}`, tree.dir, 1, 'confirm') : null;
    const rs = regBase ? await trendSide(`k-${cid}`, tree.dir, 1, 'regression') : null;
    const tm = ts ? TSC.measureTrend(trendConfirm.side, ts.side) : null;
    const trendParts = parts.filter(p => p.finding.kind === TF.KIND);
    const harms = [...(s.measures ? s.harms : SC.screen(cm).harms), ...(tm ? TSC.trendHarms(tm) : []), ...(rs ? TSC.regressionHarms(regBase.side, rs.side) : [])];
    // Every trend part's target is the trend set's legs caught: it must still gain on the confirm half.
    const lostTrend = trendParts.length && !(tm && TSC.gained(tm.capture)) ? trendParts.map(p => p.id) : [];
    const cancelled = [...s.cancelled, ...lostTrend];
    const verdict = harms.length ? 'hurt' : cancelled.length ? 'no effect' : 'helped';
    const targets = [...s.targets, ...trendParts.map(p => ({ id: p.id, target: tm ? tm.capture : { pairs: 0, b: 0, c: 0 } }))];
    return { verdict, pass: verdict === 'helped', harms, cancelled, targets, measures: { ...compact(cm), ...(tm ? { trend: tm } : {}) }, cycles: side.cycles + (ts ? ts.cycles : 0) + (rs ? rs.cycles : 0) };
  });
  report.cycles.composed = composed.cycles === undefined ? null : composed.cycles;
  // (One part alone: the combined change has the part's id, so the composed line is told apart by `composed`.)
  if (!LS.readLessons(lessonsFile).some(e => e.iteration === n && e.composed === true && e.proposalId === cid)) {
    LS.appendLesson(lessonsFile, {
      proposalId: cid, iteration: n, composed: true, parts: composition.parts.length, partIds: composition.parts.map(p => p.id), windows: cfg.windows, seed, half: 'confirm',
      measures: composed.measures, verdict: composed.verdict, n: Math.min(...composed.targets.map(t => t.target.pairs)), ...(draw ? { trendBatch: { index: n - 1, set: trend.set.fingerprint, probe: split.probe.legs.length, confirm: split.confirm.legs.length } } : {}),
    });
  }
  report.composed = { id: cid, verdict: composed.verdict, harms: composed.harms, cancelled: composed.cancelled, measures: composed.measures, parts: composition.parts.map(p => p.id), ...(composed.measures && composed.measures.trend ? { trend: { capture: composed.measures.trend.capture, netR: composed.measures.trend.netR } } : {}) };
  writeReport();
  ctx.log(`iteration ${n}: combined change ${cid} of ${composition.parts.length} edit(s): ${composed.verdict}${composed.pass ? ': to the keep rule' : ''}`);
  if (!composed.pass) return { proposals: [], report };
  return { proposals: [{ proposal: composition.proposal, source: 'propose-probe-compose', composition: { ...composition, proposal: undefined, composed: report.composed } }], report };
}

module.exports = { probeRound, probeData, trendData, combinedScreen, pool, inHalf };
