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
 * Under `probe.curriculum` 'trend' (curriculum.js) there is no curated replay: no split, no curated runs. The champion
 * and every edit replay the trend set only (its legs' stepped windows, their control windows, the regression days); the
 * read findings and each edit's read measures come from those same trend runs' decisions (a half's runs are that half's
 * days, so no curated split applies), a read finding kept only where targetScope reaches minPairs; the combined change is
 * judged on the trend set's confirm half alone. The keep rule after it is the same.
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
const EF = require('./exit-findings');
const TFX = require('./trend-facts');
const TC = require('./trend-curve');
const TR = require('../replay/trend-ride');
const FT = require('./first-try');
const SEL = require('./selection');
const CU = require('./curriculum');
const { readJson } = require('../harness-run');

/**
 * A capture's scored exits as an exit edit's screen pairs them (exit-scorecard.js decisions), each to the window it was
 * opened in (unitOfRecord); none without a capture; null (unknown) when it has some but none names its trade (a capture
 * from before they did).
 */
function exitsOf(capture, windows) {
  const list = capture && capture.exits && Array.isArray(capture.exits.decisions) ? capture.exits.decisions : [];
  if (list.length && !list.some(d => d && d.root && d.entryAt)) return null;
  const TW = require('./trend-windows');
  return list.map(d => ({ root: d.root || null, side: d.side, entryAt: d.entryAt || null, unit: d.entryAt && windows ? TW.unitOfRecord(windows, d.entryAt) : null, exitBy: d.exitBy, cls: d.cls, late: d.late === true, r: d.r, peakR: d.peakR }));
}

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

/**
 * The default step: a trend run's capture report (replay/trend-capture.js), written to its folder, its days and its first
 * tries. legs, windows: a stepped-windows run's (trend-windows.js): the capture reads those legs (the census's), and each
 * window's state replaces the session's (stepped to its end or not).
 */
function trendData({ runDir, legs = null, windows = null, context = [] }) {
  const tc = require('../replay/trend-capture');
  const { readRun } = require('../replay/store');
  const { readJson } = require('../harness-run');
  const days = readRun(runDir).days;
  const capture = tc.captureReport({ runDir, days, manifest: readJson(path.join(runDir, 'manifest.json'), {}) || {}, legs, context });
  tc.writeCapture(runDir, capture);
  // The first tries of the run's compose records (first-try.js): its own home's, one session's.
  const home = path.resolve(runDir, '..', '..');
  const first = require('./first-try').firstTries(require('../trading/trade-lifecycle').readRecords(home));
  // Each session: stepped to its end or not, and why; near a contract roll or not (the translator's day files: their
  // standard front month for the run's root).
  const trader = readJson(path.join(runDir, 'autotrader.json'), {}) || {};
  const rootOf = trader.symbols;
  const fronts = {};
  for (const f of fs.readdirSync(home)) {
    const m = /^contracts-[a-z0-9_-]+\.(\d{4}-\d{2}-\d{2})\.json$/i.exec(f);
    if (!m) continue;
    const doc = readJson(path.join(home, f), null);
    const front = doc && doc.front && Array.isArray(rootOf) && rootOf.length ? doc.front[String(rootOf[0]).toUpperCase()] : null;
    if (front && front.month) fronts[m[1]] = front.month;
  }
  const byDay = require('./trend-screen').sessionsOf({ days, combine: require('../replay/combine-run').readLog(runDir), fronts });
  // A windowed run: each window stepped to its end or not, its day's roll-month flag kept.
  const roll = new Map(byDay.map(s => [s.day, s.rollMonth]));
  const sessions = windows ? require('./trend-windows').windowStates({ days, windows, minutes: Number(trader.timeframe) }).map(s => ({ ...s, rollMonth: roll.get(s.day) || false })) : byDay;
  // The model's entries (the run home's entry orders), for the selection value (selection.js), and the decision times
  // the run stepped (only the reactions it stepped count).
  const entries = require('./selection').entriesOf(readJson(path.join(home, 'entry-orders.json'), []) || []);
  return { capture, days, first, sessions, entries, stepped: [...recordedTimes(runDir)].sort(), minutes: Number(trader.timeframe) || null };
}

/**
 * An edit's verdict on both sets: any harm on either (the curated measures, the trend set's legs, net R and blows, the
 * regression days) is a harm; the gain is the target set's own (the trend set's legs for a trend finding, else the
 * curated target). Without a trend set, the curated screen alone.
 */
function combinedScreen({ curated, curatedTarget = true, trend = null, trendTarget = false, regression = [], rule = undefined }) {
  const t = trend ? TSC.screenTrend(trend, { target: trendTarget, rule }) : null;
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
  // The trend curriculum (curriculum.js): the trend set only, no curated replay (probe-config.js requires its trend set).
  const trendOnly = CU.curriculumOf(cfg) === 'trend';
  const ranges = [...cfg.windows, ...(trend ? TS.dayWindows([...trend.set.days, ...(trend.regression ? trend.regression.days : [])]) : [])]; // the whole pool: every round draws from it
  if (!ctx.state.done['look:probe']) {
    const v = checkLook({ ...look, ranges }, S.readLedger(ctx.paths.ledger));
    if (!v.ok) throw new Error(`the probe look is refused:\n- ${v.refusals.join('\n- ')}`);
    S.logLook(ctx.paths.ledger, { ...look, ranges, what: trendOnly ? 'training loop: probes of skill and role edits on the trend set\'s sessions (curriculum trend)' : `training loop: probes of skill and role edits on curated practice-train moments${trend ? ' and the trend set\'s sessions' : ''}` });
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
  const halves = trendOnly ? null : await api.phase(ctx, 'probe:halves', path.join(ctx.paths.dir, 'probes', 'halves.json'), async () => {
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
  // The windows a trend run steps (trend-windows.js): around each leg of the half's batch legs that day (the regression
  // days: every census leg), and the control windows clear of every census leg that day. Code only, from the census and
  // the runner config, before any run: the champion and every edit of a round step the same windows.
  const TW = require('./trend-windows');
  const traderCfg = trend ? require('../autotrader').validateConfig(trend.replay.autotrader) : null;
  const spanOf = id => {
    const s = trend.set.spans && trend.set.spans[id];
    if (!s) throw new Error(`the trend set has no span for leg ${id}: resolve the loop config again (probe-config.js)`);
    return { id, ...s };
  };
  const windowsOn = (which, day) => {
    const all = Object.keys(trend.set.spans || {}).filter(id => trend.set.spans[id].day === day);
    const mine = which === 'regression' ? all : split[which].legs.filter(id => TS.dayOfLeg(id) === day);
    const W = require('../tunables').training().trendWindows;
    return TW.windowsFor({
      day, legs: mine.map(spanOf), others: all.filter(id => !mine.includes(id)).map(spanOf), closes: TW.dayCloses(traderCfg, day), minutes: traderCfg.timeframe, seed,
      leadBars: W.leadBars, controlPerLeg: W.controlPerLeg, catchShare: require('../tunables').replay().trendCapture.catchShare,
    });
  };
  // One side's runs of a trend half's days (or the regression days), one run a day stepping that day's windows, each
  // run's capture report reduced for the screen. A day's windows are their own phase (keyed by their hash): the
  // champion's, replayed once in a loop (its tree never changes inside one), is reused by every later round that steps
  // the same windows (the regression days every round).
  const trendSide = async (side, tree, share, which, withFindings = false) => {
    const days = trendDays(which);
    if (!days.length) return null;
    const out = { legs: [], dayR: {}, blows: 0, cycles: 0, fresh: 0, exits: [], captures: [], rides: [], first: [], sessions: [], entries: [], stepped: [], windows: 0, dropped: [], noWindows: [], controls: [], reads: [] };
    for (const day of days) {
      const built = windowsOn(which, day);
      out.dropped.push(...built.dropped);
      // A day none of whose legs has a window (each outside the runner's sessions, or a holiday): never run, and said so.
      if (!built.windows.length) { out.noWindows.push(day); continue; }
      const h = require('crypto').createHash('sha256').update(JSON.stringify(TW.asConfig(built.windows))).digest('hex').match(/^[0-9a-f]{8}/)[0]; // the run id's tag (its length capped)
      const tag = `t${day.replace(/-/g, '')}.${h}.`;
      const key = `trend-day:${side}:${day}:${h}`;
      const reused = Boolean(ctx.state.done[key]);
      const replay = { ...trend.replay, stepWindows: TW.asConfig(built.windows) };
      const runs = await api.windowRuns(ctx, { side, tag, windows: TS.dayWindows([day]), tree, look, replay, share, role: 'trend-set' });
      const one = await api.phase(ctx, key, path.join(ctx.paths.dir, 'probes', 'trend', `${side}-${day}-${h}.json`), async () => {
        const legs = built.windows.flatMap(w => w.legs).map(spanOf);
        // The day's other census legs classify the run's entries only (an entry in a lead-in bar is in its leg, never "none").
        const context = Object.keys(trend.set.spans || {}).filter(id => trend.set.spans[id].day === day && !legs.some(l => l.id === id)).map(spanOf);
        const got = await (ctx.steps.trendData || trendData)({ runDir: runs.runs[0].runDir, legs, windows: built.windows, context });
        const x = TSC.sideOfTrend({ captures: [got.capture], days: got.days, scorecard: runs.decisions, first: got.first || [], sessions: got.sessions || null, windows: built.windows, minutes: got.minutes || traderCfg.timeframe });
        // Curriculum trend: the run's read data too (its decisions, skill usage and compose records), the read findings'
        // and the read screens' (curriculum.js readPart); never the regression days' (harm only).
        const read = trendOnly && which !== 'regression' ? CU.readPart({ data: await ctx.steps.probeData({ runDir: runs.runs[0].runDir, tree, barsFiles, keep: null }), scorecard: runs.decisions }) : null;
        return { ...(read ? { read } : {}), legs: [...x.legs], dayR: x.dayR, blows: x.blows, first: x.first, sessions: x.sessions, entries: got.entries || [], stepped: got.stepped || [], windows: built.windows.length, cycles: stepsOf(runs.runs[0].runDir), ride: TR.compact(got.capture), exits: exitsOf(got.capture, built.windows), ...(side === 'pc' ? { capture: got.capture } : {}) };
      });
      // Its catch & ride (replay/trend-ride.js), report only: a phase kept before the ride was recorded has none (the
      // champion's keeps its capture, read instead), and the side's total is then unknown (trend-screen.js rideOfSide).
      out.rides.push({ ride: one.ride || TR.compact(one.capture), windows: built.windows });
      // The day's control windows (the round report's false starts, curriculum.js) and, curriculum trend, its read data.
      out.controls.push(...built.windows.filter(w => w.kind === 'control').map(w => w.id));
      if (trendOnly && which !== 'regression') {
        if (!one.read) throw new Error(`trend run ${side} ${day}: no read data kept (a phase from another curriculum): curriculum trend is a new loop`);
        out.reads.push(one.read);
      }
      out.legs.push(...one.legs);
      // Its scored exits, for an exit edit's screen (a phase kept before they were recorded: its capture's, when kept;
      // else unknown, and the side's exits with it).
      const ex = one.exits !== undefined ? one.exits : one.capture ? exitsOf(one.capture, built.windows) : null;
      out.exits = out.exits && ex ? [...out.exits, ...ex] : null;
      Object.assign(out.dayR, one.dayR);
      out.blows += one.blows;
      out.first.push(...(one.first || []));
      out.entries.push(...(one.entries || []));
      out.stepped.push(...(one.stepped || []));
      out.windows += one.windows || 0;
      // A day the step reported nothing of: none of its windows taken as finished (fail closed: they pair nothing).
      out.sessions.push(...(one.sessions || built.windows.map(w => ({ unit: w.id, day, complete: false, why: 'the step reported no session state', rollMonth: false }))));
      out.cycles += one.cycles;
      if (!reused) out.fresh += one.cycles;
      // The findings' half: each missed leg's facts at its start (trend-facts.js), from the run's own files, after the
      // run and outside its home; never in the capture the run's folder holds, never in a phase a trading run reads.
      // The control windows' bars give the base rate (a valid plan where no leg was) and the plans that lost.
      if (withFindings && one.capture) out.captures.push((ctx.steps.trendFacts || TFX.attachFacts)(one.capture, { runDir: runs.runs[0].runDir, tree, barsFiles, controls: built.windows.filter(w => w.kind === 'control') }));
    }
    // A half screens the batch's own legs only (a replayed session can hold legs of another round's batch); the
    // regression days screen every leg they hold.
    const mine = which === 'regression' ? null : new Set(split[which].legs);
    const legs = mine ? out.legs.filter(([id]) => mine.has(id)) : out.legs;
    if (withFindings && mine) out.captures = out.captures.map(c => ({ ...c, legs: (c.legs || []).filter(l => mine.has(l.id)) }));
    const falseStarts = CU.falseStarts(out.exits, { controls: out.controls, sessions: out.sessions, peakR: require('../tunables').training().trendReport.falseStartPeakR });
    return { ...out, legs, falseStarts, read: trendOnly && which !== 'regression' ? CU.readSideOf(out.reads) : null, side: { legs: new Map(legs), dayR: out.dayR, blows: out.blows, first: out.first, sessions: out.sessions } };
  };
  // An exit edit's trend-set pairs (screen.js exitTargetTest): the champion's and the edit's scored exits, one bar apart at most.
  // Only the units both sides finished pair (as measureTrend's); a side's exits unknown: no gain from them.
  const exitPairs = (base, side) => {
    if (!base || !side) return null;
    if (!base.exits || !side.exits) return { unknown: true };
    const finished = s => new Set((s.sessions || []).filter(x => x && x.complete).map(x => (x.unit !== undefined ? x.unit : x.day)));
    const theirs = finished(side);
    return { champion: base.exits, probe: side.exits, stepMs: traderCfg.timeframe * 60000, done: [...finished(base)].filter(u => theirs.has(u)) };
  };
  const report = { iteration: n, ...(trendOnly ? { curriculum: 'trend' } : {}), windows: cfg.windows, seed, cycles: { champion: {}, edits: {} } };
  // A half of the trend batch with no session (a one-day batch): nothing to screen on one and judge on the other.
  const trendEmpty = trend && (!split.probe.days.length || !split.confirm.days.length);
  // The lessons' windows: the curated ones; under curriculum trend, the round's trend days (practice-train, probe-config.js).
  const lessonWindows = trendOnly ? TS.dayWindows([...new Set([...split.probe.days, ...split.confirm.days, ...trendDays('regression')])].sort()) : cfg.windows;
  if (trend) {
    report.trend = {
      set: trend.set.fingerprint, batch: { index: n - 1, size: draw.items.length, from: draw.from, cycles: draw.cycles, trigger: plan.trigger, why: plan.why },
      probe: { days: split.probe.days, legs: split.probe.legs }, confirm: { days: split.confirm.days, legs: split.confirm.legs }, regression: trendDays('regression'),
    };
  }
  const writeReport = () => writeJsonAtomic(path.join(dir, 'probe-report.json'), report);
  if (!trendOnly) report.split = { seed, by: 'session date', probe: halves.probe.days, confirm: halves.confirm.days };
  if (!trendOnly && (!report.split.probe.length || !report.split.confirm.length)) {
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
  if (trendEmpty) {
    // As the curated split: a trend half with no session day is inconclusive, never a pass, and nothing is replayed.
    report.why = `inconclusive: no ${split.probe.days.length ? 'confirm' : 'probe'} days in the trend batch (${draw.items.length} leg(s) on ${new Set(draw.items.map(TS.dayOfLeg)).size} day(s))`;
    const id = `iteration-${n}-trend-split`;
    if (!LS.readLessons(lessonsFile).some(e => e.iteration === n && e.proposalId === id)) {
      LS.appendLesson(lessonsFile, { proposalId: id, iteration: n, composed: true, verdict: 'no effect', n: 0, half: 'none', windows: lessonWindows, seed, why: report.why });
    }
    writeReport();
    ctx.log(`iteration ${n}: ${report.why}`);
    return { proposals: [], report };
  }
  // The champion's probe half: the findings and every edit's screen (its confirm half runs only for a combined change).
  // Curriculum trend: no curated run; its read side is the trend probe half's runs' (below).
  let base = trendOnly ? null : await sideData('pc', champion.dir, 1, 'probe', true);
  if (base) report.cycles.champion.probe = base.cycles;
  // The trend set's probe half and the regression days, the champion's (the findings read the probe half only).
  const trendBase = trend ? await trendSide('pc', champion.dir, 1, 'probe', true) : null;
  if (trendOnly) base = { side: trendBase.read.side, skills: trendBase.read.skills, refusals: trendBase.read.refusals };
  // The probe half's missed legs: those a valid plan existed for (findings), those with none (a correct pass), unknown.
  if (trendBase) {
    report.trend.missed = TF.missedTally(trendBase.captures);
    // The champion's exits on the probe half, scored by what price did next (replay/exit-scorecard.js): the round's report.
    report.trend.exits = EF.exitTally(trendBase.captures);
    // The champion's scored exits name no trade (a phase kept from older code): no exit edit could be screened, so the
    // round shows no exit finding (no proposer slot or probe run spent on an edit that can only end 'no effect').
    if (!trendBase.exits) {
      report.trend.exitFindings = 'none: the champion\'s scored exits name no trade (scored by older code), so no exit edit can be screened';
      ctx.log(`iteration ${n}: exit findings left out: ${report.trend.exitFindings}`);
    }
    // The base rate beside them: the share of the missed legs' entry bars, and of the control bars, with a valid plan.
    const c = TFX.controlsOf(trendBase.captures);
    report.trend.baseRate = { legBars: c.legBars, controlBars: c.controlBars };
    // The champion's catch & ride on the probe half (trend-ride.js): what each edit's own is read against.
    report.trend.probeRide = TSC.rideOfSide(trendBase.side, trendBase.rides);
    const t = report.trend.missed;
    ctx.log(`iteration ${n}: trend probe half: ${t.missed} missed leg(s): ${t.learnable} learnable, ${t.noValidPlan} no valid plan at the time (a correct pass), ${t.unknown} facts unknown`);
  }
  const regBase = trend ? await trendSide('pc', champion.dir, 1, 'regression') : null;
  // The champion's confirm half too, every round: the learning curve reads it (trend-curve.js); nothing of it reaches the
  // proposer, and no edit runs it.
  const trendConfirm = trend ? await trendSide('pc', champion.dir, 1, 'confirm') : null;
  // The scan's traded reactions on the round's confirm days (selection.js), read once a round from the moments file.
  const reactions = trend && trend.moments ? await api.phase(ctx, `${n}:trend-reactions`, path.join(dir, 'trend-reactions.json'), async () => {
    const lines = fs.readFileSync(trend.moments, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch (_err) { return []; } });
    // Only the reactions inside the runner's sessions (the scan covers wider hours); each side then counts those it stepped.
    return SEL.reactionsOf(lines, { days: trendDays('confirm'), sessions: traderCfg.sessions });
  }) : null;
  if (trendBase) report.cycles.champion.trend = trendBase.fresh + (regBase ? regBase.fresh : 0) + (trendConfirm ? trendConfirm.fresh : 0);
  // What the windows left out, never silently: each half's legs and controls with no window, and the days with none
  // (never run). The same windows for every side, so the champion's say it for all.
  if (trend) {
    const left = s => (s ? { dropped: s.dropped, noWindows: s.noWindows } : { dropped: [], noWindows: [] });
    report.trend.windows = { probe: left(trendBase), confirm: left(trendConfirm), regression: left(regBase) };
    // Each side's bars skipped while a cycle ran (latency charged, as live): never a dropped window, but shown, so a
    // slower edit is visible (its missed legs already count against it).
    report.skipped = { champion: TW.skippedShare([trendBase, regBase, trendConfirm].flatMap(s => (s ? s.sessions : []))), edits: {}, composed: null };
    for (const [which, x] of Object.entries(report.trend.windows)) {
      if (x.noWindows.length) ctx.log(`iteration ${n}: trend ${which}: no windows on ${x.noWindows.join(', ')} (never run): ${x.dropped.filter(d => x.noWindows.includes(d.id.split('|')[0])).map(d => d.why).filter((w, i, a) => a.indexOf(w) === i).join('; ')}`);
      const rest = x.dropped.filter(d => !x.noWindows.includes(d.id.split('|')[0]));
      if (rest.length) ctx.log(`iteration ${n}: trend ${which}: ${rest.length} leg or control window(s) left out: ${rest.map(d => `${d.id} (${d.why})`).join('; ')}`);
    }
  }
  if (trendConfirm) {
    // The learning curve's champion: its finished units only (the screens' guard, one side), never a window it left early.
    const fin = TSC.finishedOf(trendConfirm.side);
    // blows and controls (the control windows' false starts, curriculum.js): the round report's mastery read.
    report.trend.champion = { ride: TSC.rideOfSide(trendConfirm.side, trendConfirm.rides), selection: reactions ? SEL.selectionOf(reactions, trendConfirm.entries, { stepped: trendConfirm.stepped }) : null, firstTry: FT.summarize(fin.first), legs: fin.legs.length, caught: fin.legs.filter(l => l.captured).length, netR: fin.netR, sessions: fin.units.length, windows: trendConfirm.windows, blows: trendConfirm.blows, controls: trendConfirm.falseStarts };
  }
  const exists = s => fs.existsSync(path.join(champion.dir, 'skills', s, 'SKILL.md'));
  // The read findings an edit could be judged on: those with at least minPairs of the champion's probe-half decisions in
  // their target's scope (screen.js targetScope); the others are left out, said in the report, so no proposer slot or
  // probe run goes to an edit that could only end 'no effect'.
  // (Curriculum trend: the trend probe half's runs hold its days only, so no curated split applies.)
  const halfOf = (s, which) => (trendOnly ? s : SC.half(s, which, seed));
  const probeHalf = halfOf(base.side, 'probe');
  const allRead = F.findingsFrom({ skills: base.skills, refusals: base.refusals, max: Infinity, exists });
  const judged = f => SC.targetScope(probeHalf, { skill: f.skill, kind: f.kind });
  const readFindings = allRead.filter(f => judged(f) >= SC.SCREEN.minPairs).slice(0, cfg.k * 2);
  const omitted = allRead.filter(f => judged(f) < SC.SCREEN.minPairs);
  if (omitted.length) {
    report.readFindingsOmitted = omitted.map(f => ({ skill: f.skill || null, kind: f.kind, count: f.count, judged: judged(f), why: `${judged(f)} of the champion's probe-half decisions in its target's scope, under the screen's minPairs ${SC.SCREEN.minPairs}: no edit of it could show a gain` }));
    ctx.log(`iteration ${n}: ${omitted.length} read finding(s) left out: under minPairs judged decisions (${report.readFindingsOmitted.map(x => `${x.skill || 'no skill'} ${x.kind} ${x.judged}`).join('; ')})`);
  }
  const findings = await api.phase(ctx, `${n}:findings`, path.join(dir, 'findings.json'), async () => F.mergeFindings(
    // The trend set's findings, its missed legs and its exits that cut a trend or came late (exit-findings.js), by the R
    // each cost.
    trendBase ? [...TF.trendFindings(trendBase.captures, { exists, max: cfg.k * 2 }), ...(trendBase.exits ? EF.exitFindings(trendBase.captures, { exists, max: cfg.k * 2 }) : [])]
      .sort((a, b) => TF.findingCost(b) - TF.findingCost(a)) : [],
    readFindings,
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
    // With trend findings, the base rate and the valid plans that lost on the control bars (balancing examples).
    const controls = trendBase && findings.some(f => f.kind === TF.KIND) ? TFX.controlsText(TFX.controlsOf(trendBase.captures)) : '';
    const res = await ctx.steps.proposeProbes({ cfg: ctx.loop.proposer, tree: own, findings, controls, lessons: LS.summarize(lessons), home: path.join(scratch, 'home'), baseEnv: ctx.env, k: cfg.k });
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
    // Screened on the probe half only: the confirm half stays unseen until the combined change. Curriculum trend: its
    // read side is its trend runs' (no curated run).
    const curated = trendOnly ? null : await sideData(`p-${e.id}`, tree.dir, share, 'probe');
    const ts = trendBase ? await trendSide(`p-${e.id}`, tree.dir, share, 'probe') : null;
    const side = trendOnly ? { side: ts.read.side, cycles: 0 } : curated;
    const m = SC.measure(halfOf(base.side, 'probe'), halfOf(side.side, 'probe'), { skill: e.tag.skill || null, kind: e.finding.kind, exits: exitPairs(trendBase, ts) });
    const rs = regBase ? await trendSide(`p-${e.id}`, tree.dir, share, 'regression') : null;
    const rm = rs ? TSC.measureTrend(regBase.side, rs.side) : null;
    const tm = ts ? TSC.measureTrend(trendBase.side, ts.side) : null;
    const isTrend = e.finding.kind === TF.KIND;
    if (isTrend && !tm) throw new Error(`probe ${e.id}: a trend finding needs the trend set's runs`);
    const screen = combinedScreen({ curated: SC.screen(m), curatedTarget: !isTrend, trend: tm, trendTarget: isTrend, regression: rs ? TSC.regressionHarms(regBase.side, rs.side) : [], rule: ctx.loop.rule });
    const measures = { ...compact(m), ...(tm ? { trend: tm } : {}), ...(rm ? { regression: rm } : {}), ...(isTrend ? { target: tm.capture } : {}) };
    return { id: e.id, tag: e.tag, finding: e.finding, proposal: e.proposal, measures, screen, ride: ts ? TSC.rideOfSide(ts.side, ts.rides) : null, cycles: side.cycles + (ts ? ts.cycles : 0) + (rs ? rs.cycles : 0), ...(ts ? { skipped: TW.skippedShare([...ts.sessions, ...(rs ? rs.sessions : [])]) } : {}) };
  }));
  // The lessons record: one line per probe, written once (a resume finds its lines by iteration and id).
  const recorded = new Set(LS.readLessons(lessonsFile).filter(e => e.iteration === n && !e.composed).map(e => e.proposalId));
  for (const p of probes.filter(x => !recorded.has(x.id))) {
    LS.appendLesson(lessonsFile, {
      proposalId: p.id, iteration: n, ...(p.tag.agent ? { agent: p.tag.agent } : { skill: p.tag.skill }), kind: p.tag.kind, finding: { id: p.finding.id, kind: p.finding.kind, line: F.findingLine(p.finding) },
      findingKind: p.finding.kind, windows: lessonWindows, seed, half: 'probe', measures: p.measures, verdict: p.screen.verdict, n: p.measures.target.pairs, ...(draw ? { trendBatch: { index: n - 1, set: trend.set.fingerprint, probe: split.probe.legs.length, confirm: split.confirm.legs.length } } : {}),
    });
  }
  report.probes = probes.map(p => ({ ...(p.skipped ? { skipped: p.skipped } : {}), ...(p.ride ? { ride: p.ride } : {}), id: p.id, tag: p.tag, finding: p.finding.id, verdict: p.screen.verdict, harms: p.screen.harms, target: p.measures.target, ...(p.measures.trend ? { trend: { capture: p.measures.trend.capture, sides: p.measures.trend.sides } } : {}), ...(p.measures.regression ? { regression: { capture: p.measures.regression.capture } } : {}) }));
  for (const p of probes) report.cycles.edits[p.id] = p.cycles === undefined ? null : p.cycles;
  if (report.skipped) for (const p of probes) if (p.skipped) report.skipped.edits[p.id] = p.skipped;
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
  // Curriculum trend: the trend confirm half's runs (run every round for the curve) are its read side.
  const confirmBase = trendOnly ? { side: trendConfirm.read.side } : await sideData('pc', champion.dir, 1, 'confirm');
  if (!trendOnly) report.cycles.champion.confirm = confirmBase.cycles;
  // The combined change, probed once more and judged on the confirm half only: it must hold there, its parts not cancel.
  const composed = await api.phase(ctx, `${n}:composed`, path.join(dir, `composed-${cid}.json`), async () => {
    const tree = await api.candidateTree(ctx, { dir: work, id: `k-${cid}`, proposal: composition.proposal, champion });
    const curated = trendOnly ? null : await sideData(`k-${cid}`, tree.dir, 1, 'confirm');
    const ts = trendConfirm ? await trendSide(`k-${cid}`, tree.dir, 1, 'confirm') : null;
    const side = trendOnly ? { side: ts.read.side, cycles: 0 } : curated;
    const parts = passed.filter(p => composition.parts.some(x => x.id === p.id));
    const champC = halfOf(confirmBase.side, 'confirm');
    const probeC = halfOf(side.side, 'confirm');
    // A read part beside a trend or an exit part is judged on harm only (screen.js composedScreen).
    const s = SC.composedScreen(champC, probeC, parts.filter(p => p.finding.kind !== TF.KIND), { exits: exitPairs(trendConfirm, ts), trendParts: parts.filter(p => p.finding.kind === TF.KIND).length });
    // The curated measures and harms even when every part is a trend part (no curated target then).
    const cm = s.measures || SC.measure(champC, probeC, {});
    const rs = regBase ? await trendSide(`k-${cid}`, tree.dir, 1, 'regression') : null;
    const tm = ts ? TSC.measureTrend(trendConfirm.side, ts.side) : null;
    const trendParts = parts.filter(p => p.finding.kind === TF.KIND);
    const harms = [...(s.measures ? s.harms : SC.screen(cm).harms), ...(tm ? TSC.trendHarms(tm, { rule: ctx.loop.rule }) : []), ...(rs ? TSC.regressionHarms(regBase.side, rs.side) : [])];
    // Every trend part's target is the trend set's legs caught: it must still gain on the confirm half.
    const lostTrend = trendParts.length && !(tm && TSC.gained(tm.capture)) ? trendParts.map(p => p.id) : [];
    const cancelled = [...s.cancelled, ...lostTrend];
    const verdict = harms.length ? 'hurt' : cancelled.length ? 'no effect' : 'helped';
    const targets = [...s.targets, ...trendParts.map(p => ({ id: p.id, target: tm ? tm.capture : { pairs: 0, b: 0, c: 0 } }))];
    const selection = ts && reactions ? SEL.selectionOf(reactions, ts.entries, { stepped: ts.stepped }) : null;
    return { verdict, pass: verdict === 'helped', harms, cancelled, targets, ride: ts ? TSC.rideOfSide(ts.side, ts.rides) : null, measures: { ...compact(cm), ...(tm ? { trend: { ...tm, selection, controls: ts.falseStarts } } : {}) }, cycles: side.cycles + (ts ? ts.cycles : 0) + (rs ? rs.cycles : 0), ...(ts ? { skipped: TW.skippedShare([...ts.sessions, ...(rs ? rs.sessions : [])]) } : {}) };
  });
  report.cycles.composed = composed.cycles === undefined ? null : composed.cycles;
  if (report.skipped && composed.skipped) report.skipped.composed = composed.skipped;
  // (One part alone: the combined change has the part's id, so the composed line is told apart by `composed`.)
  if (!LS.readLessons(lessonsFile).some(e => e.iteration === n && e.composed === true && e.proposalId === cid)) {
    LS.appendLesson(lessonsFile, {
      proposalId: cid, iteration: n, composed: true, parts: composition.parts.length, partIds: composition.parts.map(p => p.id), windows: lessonWindows, seed, half: 'confirm',
      measures: composed.measures, verdict: composed.verdict, n: Math.min(...composed.targets.map(t => t.target.pairs)), ...(draw ? { trendBatch: { index: n - 1, set: trend.set.fingerprint, probe: split.probe.legs.length, confirm: split.confirm.legs.length } } : {}),
    });
  }
  report.composed = { id: cid, verdict: composed.verdict, harms: composed.harms, cancelled: composed.cancelled, measures: composed.measures, parts: composition.parts.map(p => p.id), ...(composed.measures && composed.measures.trend ? { trend: { capture: composed.measures.trend.capture, netR: composed.measures.trend.netR, firstTry: composed.measures.trend.firstTry, sides: composed.measures.trend.sides, selection: composed.measures.trend.selection || null, ride: composed.ride || null, blows: composed.measures.trend.blows, controls: composed.measures.trend.controls === undefined ? null : composed.measures.trend.controls } } : {}) };
  writeReport();
  ctx.log(`iteration ${n}: combined change ${cid} of ${composition.parts.length} edit(s): ${composed.verdict}${composed.pass ? ': to the keep rule' : ''}`);
  if (!composed.pass) return { proposals: [], report };
  return { proposals: [{ proposal: composition.proposal, source: 'propose-probe-compose', composition: { ...composition, proposal: undefined, composed: report.composed } }], report };
}

module.exports = { probeRound, probeData, trendData, combinedScreen, pool, inHalf };
