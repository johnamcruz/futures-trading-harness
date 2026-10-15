'use strict';

/**
 * Training stages: one replay, two presets (docs/TRAINING.md). The replay config's `stage` picks one; a preset only
 * sets defaults and requirements, and an explicit config value that contradicts it is refused, never overridden.
 *
 *   stage 1, learn to trade   a learning run on practice-train or practice-validate; a curated list on practice; latency
 *                             charged; the history library hidden (libraryDisplay off); no prop attempt (account states
 *                             are stage 2's); the risk record hidden (riskRecordDisplay off). At its end: the skill-usage report, the scorecard summary and R by setup;
 *                             on a validate run, the stage-1 exit test (EXIT_TEST) on the candidate's pooled validate runs.
 *   stage 2, pass prop        stage 1's, plus the account states (accountStates: each curated practice day starts from a
 *                             state drawn from the model's own 30-day Monte Carlo paths, prop/account-states.js; required
 *                             on practice-train), the account facts and the prop risk rules;
 *                             the model's risk record (riskRecordDisplay) only on a run declared a comparison arm
 *                             (comparisonArm). At its end: the practice by
 *                             account state (each attempt's end, raw and reweighted to the natural mix of states) and
 *                             the 30-day Monte Carlo by account state; on a validate run, the promotion gate
 *                             (prop/promotion.js, frozen).
 *
 * The config refuses a contradiction (applyStage); the run's role, curated list and the merged features are checked by
 * the training preflight (learning/preflight.js `stage`). `stage` is part of both run hashes (replay/config.js), so a
 * stage-1 run and a stage-2 run are two runs and two setups.
 *
 *   STAGES                      { 1: { name, defaults, refused }, 2: { ..., comparisonOnly } }
 *   EXIT_TEST                   the stage-1 exit test's thresholds (owner-confirmed), the one place for them
 *   applyStage(raw)             { raw (the preset's defaults under the config's own values), stage, errors }
 *   stageRequirements(stage)    what the preflight checks for it
 *   exitTest({ decisions, adherence })   [{ test, status: PASS | FAIL | INSUFFICIENT | N/A | SANITY, detail }]
 *   pooledExitTest(pool, { scorecardComposed })   { pass, tests, head }: the exit test on a candidate's pooled validate runs
 *   readPool(run, { env, scoreOf })   that pool from the run's ledger and the run homes beside it
 *   rBySetup(decisions)         [{ setup, n, entered, meanR }]: composed decisions with an R, by their setup step's skills
 *   stageReport(run, { root, env, read })   the end-of-run lines (scripts/replay.js run, when the run is done)
 */

const fs = require('fs');
const path = require('path');
const { MIN_N, MIN_DAYS, cellStats } = require('../learning/experience-index');
const { VALIDATE_RUNS_PER_CANDIDATE } = require('../learning/looks');

const STAGES = Object.freeze({
  1: Object.freeze({
    name: 'learn to trade',
    defaults: Object.freeze({ latency: true, libraryDisplay: false, riskRecordDisplay: false }),
    refused: Object.freeze({ learning: false, latency: false, libraryDisplay: true, riskRecordDisplay: true, prop: 'set', accountStates: 'set' }),
  }),
  2: Object.freeze({
    name: 'pass prop',
    defaults: Object.freeze({ latency: true, libraryDisplay: false, riskRecordDisplay: false }),
    refused: Object.freeze({ learning: false, latency: false, libraryDisplay: true }),
    // Shown only on a run declared a comparison arm (the replay config's comparisonArm): with/without the risk record.
    comparisonOnly: Object.freeze(['riskRecordDisplay']),
  }),
});

/**
 * The stage-1 exit test (owner-confirmed, 2026-10-14), judged on a candidate's pooled practice-validate runs (its
 * first VALIDATE_RUNS_PER_CANDIDATE, learning/looks.js validateRuns; pooledExitTest), never one run alone. Every
 * threshold reports PASS only over at least `minN` samples (the experience index's MIN_N, 20, the same rule a cell
 * needs before it shows a rate); under it, "insufficient sample (n)". avgWinnerR needs minN winners: at the
 * thresholds' own profile (winners 1.8R, losers -1R, +0.3R a trade: a 46% win rate) that is about 43 entries on
 * average and 52 for nine pools in ten (61 at a 40% win rate). The expectancy's interval is the experience index's
 * day bootstrap (cellStats: 90%, whole trading days resampled), which also needs MIN_DAYS (10) distinct days.
 *   plannedRR          a sanity line, never a criterion: the entries under this planned reward:risk (min_rr enforces it)
 *   avgWinnerR         the realized mean R of the winning entries, at least this
 *   expectancyR        the mean R per entry, at least this, and its interval's lower bound above expectancyLoAbove
 *   correctReadRate    the share of composed decisions whose reads were all verified true, at least this (per
 *                      decision, so trivially true reads can't carry a decision with a false one)
 *   processAdherence   the scorecard's agreement rate (agree of agree + disagree), at least this
 */
const EXIT_TEST = Object.freeze({
  plannedRR: 2,
  avgWinnerR: 1.8,
  expectancyR: 0.3,
  expectancyLoAbove: 0,
  correctReadRate: 0.8,
  processAdherence: 0.8,
  minN: MIN_N,
  minDays: MIN_DAYS,
});

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function applyStage(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (r.stage === undefined) return { raw: r, stage: null, errors: [] };
  const preset = STAGES[r.stage];
  if (!preset || typeof r.stage !== 'number') return { raw: r, stage: null, errors: ['stage: 1 (learn to trade) or 2 (pass prop)'] };
  const errors = [];
  for (const [k, v] of Object.entries(preset.refused)) {
    if (!has(r, k)) continue;
    if (v === 'set' || r[k] === v) errors.push(`${k}: ${JSON.stringify(r[k])} contradicts stage ${r.stage} (${preset.name})${['prop', 'accountStates'].includes(k) ? ': account states are stage 2\'s' : ''}; remove it or change the stage`);
  }
  for (const k of preset.comparisonOnly || []) {
    if (r[k] === true && r.comparisonArm !== true) errors.push(`${k}: true in stage ${r.stage} (${preset.name}) only on a run declared a comparison arm (comparisonArm: true); remove it or declare the arm`);
  }
  return { raw: { ...preset.defaults, ...r }, stage: r.stage, errors };
}

function stageRequirements(stage) {
  if (!STAGES[stage]) return null;
  // accountStates: where the preset requires the run's days to start from drawn account states ('none': refused).
  return { roles: ['practice-train', 'practice-validate'], curatedOn: 'practice-train', latency: true, libraryDisplay: false, riskRecordDisplay: stage === 1 ? 'off' : 'comparison-arm', prop: stage === 1 ? 'none' : 'allowed', accountStates: stage === 1 ? 'none' : 'practice-train', phase2: false };
}

const fmt = x => (x === null || x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(2));
const enteredWithR = ds => ds.filter(d => d.decision === 'entered' && d.outcome && Number.isFinite(d.outcome.R));

function exitTest({ decisions = [], adherence = null }) {
  const T = EXIT_TEST;
  const out = [];
  const t = (test, status, detail) => out.push({ test, status, detail });
  const few = n => `insufficient sample (${n}; at least ${T.minN})`;
  const entered = decisions.filter(d => d.decision === 'entered');
  // A sanity line, never a criterion: min_rr enforces the planned R:R, so it says the plan, not the trading.
  const under = entered.filter(d => !(d.plan && Number.isFinite(d.plan.rr) && d.plan.rr >= T.plannedRR));
  t('planned-rr', 'SANITY', `${under.length} of ${entered.length} entries under ${T.plannedRR}R (or without a planned R:R): a sanity line (min_rr enforces it), not an exit criterion`);
  const withR = enteredWithR(decisions);
  const winners = withR.filter(d => d.outcome.R > 0);
  if (winners.length < T.minN) t('avg-winner', 'INSUFFICIENT', few(winners.length));
  else {
    const m = winners.reduce((a, d) => a + d.outcome.R, 0) / winners.length;
    t('avg-winner', m >= T.avgWinnerR ? 'PASS' : 'FAIL', `${fmt(m)}R over ${winners.length} winners (at least ${T.avgWinnerR}R)`);
  }
  const rows = withR.map(d => [d.settledDay || d.day, d.outcome.R, 1, (d.context && d.context.regime) || '-']);
  const cell = cellStats(rows, { seed: 1, reps: 2000, key: 'stage-1-exit' });
  if (!cell.enough) t('expectancy', 'INSUFFICIENT', `insufficient sample (${cell.n} entries, ${cell.days} days; at least ${T.minN} over ${T.minDays} days)`);
  else {
    const ok = cell.meanR.mean >= T.expectancyR && cell.meanR.lo > T.expectancyLoAbove;
    t('expectancy', ok ? 'PASS' : 'FAIL', `${fmt(cell.meanR.mean)}R per entry, 90% day-bootstrap interval ${fmt(cell.meanR.lo)} to ${fmt(cell.meanR.hi)} (at least ${T.expectancyR}R, lower bound above ${T.expectancyLoAbove})`);
  }
  // Per decision: one passes when every read it composed from is verified true, so trivial true reads can't carry it.
  const read = decisions.filter(d => d.decision !== 'none' && Array.isArray(d.reads) && d.reads.length);
  if (read.length < T.minN) t('correct-reads', 'INSUFFICIENT', few(read.length));
  else {
    const right = read.filter(d => d.reads.every(r => r && (r.check === true || r.check === 'true'))).length;
    const rate = right / read.length;
    t('correct-reads', rate >= T.correctReadRate ? 'PASS' : 'FAIL', `${fmt(rate)} of ${read.length} decisions with every read true (at least ${T.correctReadRate})`);
  }
  if (!adherence || adherence.unavailable) t('process-adherence', 'N/A', adherence && adherence.unavailable ? adherence.unavailable : 'no scorecard');
  else {
    const n = adherence.agree + adherence.disagree;
    if (n < T.minN) t('process-adherence', 'INSUFFICIENT', few(n));
    else t('process-adherence', adherence.agree / n >= T.processAdherence ? 'PASS' : 'FAIL', `${fmt(adherence.agree / n)} agreement over ${n} scored decisions (at least ${T.processAdherence})`);
  }
  return out;
}

/**
 * The stage-1 exit test on a candidate's pooled validate runs (learning/looks.js validateRuns: its first
 * VALIDATE_RUNS_PER_CANDIDATE, in the order their looks were taken). pool: { candidate, named (the run named its
 * candidate, --candidate: an unnamed run is its own candidate, so its retries would never pool), runId (this run),
 * counted: [{ runId, decisions, adherence }], missing (counted runs whose log wasn't found), beyond (later runs, never
 * read), all: { runs, candidates } }. A pool that isn't whole (unnamed, a run missing) can't pass. scorecardComposed:
 * false makes process adherence N/A. Returns { pass, tests, head }: pass only when the pool is whole and every
 * criterion (not the sanity line) passes.
 */
function pooledExitTest(pool, { scorecardComposed = true } = {}) {
  const ids = pool.counted.map(r => r.runId);
  let poolLine;
  if (!pool.named) poolLine = { test: 'pool', status: 'N/A', detail: `run ${pool.runId} names no candidate (--candidate <name> with --validate): an unnamed run is its own candidate, so its retries never pool and the cap never counts them` };
  else if (pool.missing.length) poolLine = { test: 'pool', status: 'INSUFFICIENT', detail: `candidate ${pool.candidate}'s validate run(s) ${pool.missing.join(', ')} not found beside this one: a pool without them could flatter it` };
  else poolLine = { test: 'pool', status: 'PASS', detail: `candidate ${pool.candidate}: ${ids.join(', ')} pooled (the first ${VALIDATE_RUNS_PER_CANDIDATE} validate runs at most)` };
  const errored = pool.counted.find(r => r.adherence && r.adherence.error);
  const adherence = !scorecardComposed ? { unavailable: 'needs fix/scorecard-composed (the scorecard doesn\'t score composed setups yet)' }
    : errored ? { unavailable: `run ${errored.runId}'s scorecard not scored (${errored.adherence.error})` }
      : pool.counted.reduce((a, r) => ({ agree: a.agree + Number((r.adherence && r.adherence.agree) || 0), disagree: a.disagree + Number((r.adherence && r.adherence.disagree) || 0) }), { agree: 0, disagree: 0 });
  const tests = [poolLine, ...exitTest({ decisions: pool.counted.flatMap(r => r.decisions || []), adherence })];
  const pass = tests.every(x => x.status === 'PASS' || x.status === 'SANITY');
  const past = pool.beyond.includes(pool.runId) ? `; this run is past the cap: it is not read, and can't move the verdict of ${ids.join(', ')}` : '';
  const head = `stage-1 exit test: ${pass ? 'PASS' : 'FAIL'} (pooled over ${ids.length} validate run(s) of ${pool.candidate || pool.runId}${past}; the ledger holds ${pool.all.runs} validate run(s) over ${pool.all.candidates} candidate(s))`;
  return { pass, tests, head };
}

/** The setup step's skills of a decision's skill signature ("...+setup:a,b+..."), or '-'. */
const setupOf = d => {
  const m = /(?:^|\+)setup:([^+]+)/.exec(String((d.signatures && d.signatures.skill) || ''));
  return m ? m[1] : '-';
};

function rBySetup(decisions = []) {
  const g = new Map();
  for (const d of decisions) {
    if (d.decision === 'none' || !(d.outcome && Number.isFinite(d.outcome.R))) continue;
    const k = setupOf(d);
    const x = g.get(k) || { setup: k, n: 0, entered: 0, sum: 0 };
    x.n += 1;
    x.entered += d.decision === 'entered' ? 1 : 0;
    x.sum += d.outcome.R;
    g.set(k, x);
  }
  return [...g.values()].sort((a, b) => b.n - a.n || (a.setup < b.setup ? -1 : 1)).map(x => ({ setup: x.setup, n: x.n, entered: x.entered, meanR: x.sum / x.n }));
}

/**
 * A validate run's pool (pooledExitTest's input): its look's candidate, that candidate's counted validate runs from the
 * run's ledger (learning/looks.js validateRuns), each read from its run home beside this one (<workDir>/<runId>: its
 * learning log, and its scorecard by scoreOf(runDir)); a counted run without a log is `missing`.
 */
function readPool(run, { env = process.env, scoreOf }) {
  const looks = require('../learning/looks');
  const { readLedger } = require('../prop/ledger-file');
  const { readLearning } = require('../learning/learning-report');
  const gate = require('../learning/run-gate').readLearningRun(run.paths.runHome) || {};
  const candidate = gate.look ? gate.look.candidate : null;
  const file = gate.ledger || looks.ledgerPath(env);
  const v = looks.validateRuns(fs.existsSync(file) ? readLedger(file) : [], candidate);
  const counted = [];
  const missing = [];
  for (const id of v.counted) {
    const home = path.join(path.dirname(run.paths.runHome), id);
    const l = readLearning(home);
    if (!l) { missing.push(id); continue; }
    let adherence;
    try { adherence = scoreOf(path.join(home, 'replay', id)); } catch (e) { adherence = { error: String(e.message).split('\n')[0] }; }
    counted.push({ runId: id, decisions: l.decisions, adherence });
  }
  return { candidate, named: Boolean(candidate) && candidate !== run.runId, runId: run.runId, counted, missing, beyond: v.beyond, all: v.all };
}

/** The default readers of a finished run: its learning log, its scorecard, its role, its candidate's validate pool, the merged features. */
function defaultRead(run, { root, env, barsFiles = {} }) {
  const learning = require('../learning/learning-report');
  const scoreOf = runDir => {
    const sc = require('./scorecard');
    const { strategies } = require('../trading/strategies').loadStrategies(root, env);
    const { accounts } = require('../trading/accounts').loadAccounts(root, env);
    return sc.scoreRun(runDir, { strategies, accounts }).summary.agreement.overall;
  };
  return {
    learning: () => learning.readLearning(run.paths.runHome),
    role: () => (require('../learning/run-gate').readLearningRun(run.paths.runHome) || {}).role || null,
    adherence: () => scoreOf(run.paths.runDir),
    // The candidate's validate runs from the ledger (its run homes beside this one, <workDir>/<runId>).
    pool: () => readPool(run, { env, scoreOf }),
    features: () => require('../learning/preflight').defaultReaders(root, env).features(),
    skillUsage: () => learning.skillUsageFor(run.paths.runDir, { barsFiles }),
  };
}

/** The skill-usage lines: the run's real report (learning-report.js skillUsageFor) when merged, else N/A. */
function skillUsageLines(merged, rd) {
  if (!merged) return ['skill usage: N/A (needs feat/skill-usage)'];
  let u;
  try { u = rd.skillUsage ? rd.skillUsage() : null; } catch (e) { u = { error: String(e.message).split('\n')[0] }; }
  if (!u) return ['skill usage: no compose records in the run'];
  return require('../learning/learning-report').usageText(u).trimEnd().split('\n');
}

const pctOf = x => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1)}%`);
const rateText = r => `${pctOf(r.raw)} as practised, ${pctOf(r.weighted)} reweighted`;

/** The practice by account state (prop/account-states.js practiceByState): each attempt's end, raw and reweighted. */
function practiceLines(log, planned = null) {
  if (!log.some(x => x.kind === 'start')) return ['practice by account state: no day started from a drawn state (accountStates)'];
  const p = require('../prop/account-states').practiceByState(log);
  const one = (name, v) => `  ${name}: ${v.attempts} attempt(s); blown ${rateText(v.blown)}; stopped for the day ${rateText(v.stopped)}; at the target ${rateText(v.target)}; mean P&L ${fmt(v.pnl.raw)} as practised, ${fmt(v.pnl.weighted)} reweighted`;
  return [
    `practice by account state: ${p.days} day(s) from drawn states, ${p.ended} ended (reweighted: each to its state's natural share of the model's own Monte Carlo paths; weights from the planned assignment; ${p.days} of ${planned === null ? '?' : planned} days run)`,
    one('all', p.all), ...Object.entries(p.byBucket).map(([b, v]) => one(b, v)),
  ];
}

function stageReport(run, opts = {}) {
  if (!run.stage) return [];
  try {
    return stageLines(run, opts);
  } catch (e) {
    return [`stage ${run.stage} report not written: ${String(e.message).split('\n')[0]}`];
  }
}

function stageLines(run, { root, env = process.env, barsFiles = {}, read = null }) {
  const rd = read || defaultRead(run, { root, env, barsFiles });
  const lines = [`stage ${run.stage} (${STAGES[run.stage].name}) report:`];
  const f = rd.features();
  lines.push(...skillUsageLines(f.skillUsage, rd));
  try {
    // This run's own scorecard; the exit test reads every pooled run's (the composed grading, SCORES_COMPOSED).
    const a = rd.adherence();
    lines.push(`scorecard: ${a.decisions} decisions, ${a.agree} agree, ${a.disagree} disagree, ${a.unchecked} unchecked${a.rate === null || a.rate === undefined ? '' : ` (agreement ${fmt(a.rate)})`}`);
  } catch (e) {
    lines.push(`scorecard: not scored (${String(e.message).split('\n')[0]})`);
  }
  const l = rd.learning();
  const decisions = l ? l.decisions : [];
  const bySetup = rBySetup(decisions);
  lines.push(bySetup.length ? 'R by setup:' : 'R by setup: no composed decision with an R');
  for (const s of bySetup) lines.push(`  ${s.setup}: ${s.n} decision(s), ${s.entered} entered, mean ${fmt(s.meanR)}R`);
  const validate = rd.role() === 'practice-validate';
  if (run.stage === 1 && validate) {
    // Judged on the candidate's pooled validate runs, never this run alone (a retry would be a fresh chance at a pass).
    const { tests, head } = pooledExitTest(rd.pool(), { scorecardComposed: f.scorecardComposed });
    lines.push(head);
    for (const x of tests) lines.push(`  ${x.status} ${x.test}: ${x.detail}`);
  }
  if (run.stage === 2) {
    lines.push(...practiceLines(rd.statesLog ? rd.statesLog() : require('../prop/account-states').readStatesLog(run.paths.runDir), run.accountStates && run.accountStates.assignment ? run.accountStates.assignment.days.length : null));
    lines.push(f.monteCarlo ? '30-day Monte Carlo by account state: see the prop report' : '30-day Monte Carlo by account state: N/A (phase 2, needs feat/prop-mc-model)');
    if (validate) lines.push(f.monteCarlo ? 'promotion gate: see the prop report' : 'promotion gate (prop/promotion.js): N/A (needs the Monte Carlo\'s attempts, feat/prop-mc-model)');
  }
  return lines;
}

module.exports = { STAGES, EXIT_TEST, applyStage, stageRequirements, exitTest, pooledExitTest, readPool, rBySetup, stageReport, practiceLines };
