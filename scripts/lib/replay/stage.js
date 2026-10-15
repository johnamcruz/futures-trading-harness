'use strict';

/**
 * Training stages: one replay, two presets (docs/TRAINING.md). The replay config's `stage` picks one; a preset only
 * sets defaults and requirements, and an explicit config value that contradicts it is refused, never overridden.
 *
 *   stage 1, learn to trade   a learning run on practice-train or practice-validate; a curated list on practice; latency
 *                             charged; the history library hidden (libraryDisplay off); no prop attempt (account states
 *                             are stage 2's). At its end: the skill-usage report, the scorecard summary and R by setup;
 *                             on a validate run, the stage-1 exit test (EXIT_TEST).
 *   stage 2, pass prop        stage 1's, plus the account states, account facts and prop risk rules (phase 2:
 *                             feat/prop-mc-model, feat/prop-portfolio-missing; not available until merged). At its end:
 *                             the 30-day Monte Carlo by account state; on a validate run, the promotion gate
 *                             (prop/promotion.js, frozen).
 *
 * The config refuses a contradiction (applyStage); the run's role, curated list and the merged features are checked by
 * the training preflight (learning/preflight.js `stage`). `stage` is part of both run hashes (replay/config.js), so a
 * stage-1 run and a stage-2 run are two runs and two setups.
 *
 *   STAGES                      { 1: { name, defaults, refused }, 2: ... }
 *   EXIT_TEST                   the stage-1 exit test's thresholds (owner-confirmed), the one place for them
 *   applyStage(raw)             { raw (the preset's defaults under the config's own values), stage, errors }
 *   stageRequirements(stage)    what the preflight checks for it
 *   exitTest({ decisions, measures, adherence })   [{ test, status: PASS | FAIL | INSUFFICIENT | N/A, detail }]
 *   rBySetup(decisions)         [{ setup, n, entered, meanR }]: composed decisions with an R, by their setup step's skills
 *   stageReport(run, { root, env, read })   the end-of-run lines (scripts/replay.js run, when the run is done)
 */

const { MIN_N, MIN_DAYS, cellStats } = require('../learning/experience-index');

const STAGES = Object.freeze({
  1: Object.freeze({
    name: 'learn to trade',
    defaults: Object.freeze({ latency: true, libraryDisplay: false }),
    refused: Object.freeze({ learning: false, latency: false, libraryDisplay: true, prop: 'set' }),
  }),
  2: Object.freeze({
    name: 'pass prop',
    defaults: Object.freeze({ latency: true, libraryDisplay: false }),
    refused: Object.freeze({ learning: false, latency: false, libraryDisplay: true }),
  }),
});

/**
 * The stage-1 exit test, judged on a practice-validate run (owner-confirmed, 2026-10-14). Every threshold reports
 * PASS only over at least `minN` samples (the experience index's MIN_N, 20, the same rule a cell needs before it
 * shows a rate); under it, "insufficient sample (n)". The expectancy's interval is the experience index's day
 * bootstrap (cellStats: 90%, whole trading days resampled), which also needs MIN_DAYS (10) distinct days.
 *   plannedRR          every entry's planned reward:risk at least this (min_rr enforces it; the test checks none fell under)
 *   avgWinnerR         the realized mean R of the winning entries, at least this
 *   expectancyR        the mean R per entry, at least this, and its interval's lower bound above expectancyLoAbove
 *   correctReadRate    the share of the compose records' reads verified true, at least this
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
    if (v === 'set' || r[k] === v) errors.push(`${k}: ${JSON.stringify(r[k])} contradicts stage ${r.stage} (${preset.name})${k === 'prop' ? ': account states are stage 2\'s' : ''}; remove it or change the stage`);
  }
  return { raw: { ...preset.defaults, ...r }, stage: r.stage, errors };
}

function stageRequirements(stage) {
  if (!STAGES[stage]) return null;
  return { roles: ['practice-train', 'practice-validate'], curatedOn: 'practice-train', latency: true, libraryDisplay: false, prop: stage === 1 ? 'none' : 'allowed', phase2: stage === 2 };
}

const fmt = x => (x === null || x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(2));
const enteredWithR = ds => ds.filter(d => d.decision === 'entered' && d.outcome && Number.isFinite(d.outcome.R));

function exitTest({ decisions = [], measures = null, adherence = null }) {
  const T = EXIT_TEST;
  const out = [];
  const t = (test, status, detail) => out.push({ test, status, detail });
  const few = n => `insufficient sample (${n}; at least ${T.minN})`;
  const entered = decisions.filter(d => d.decision === 'entered');
  if (entered.length < T.minN) t('planned-rr', 'INSUFFICIENT', few(entered.length));
  else {
    const under = entered.filter(d => !(d.plan && Number.isFinite(d.plan.rr) && d.plan.rr >= T.plannedRR));
    t('planned-rr', under.length ? 'FAIL' : 'PASS', `${under.length} of ${entered.length} entries under ${T.plannedRR}R (or without a planned R:R)`);
  }
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
  const reads = measures && measures.reads ? measures.reads : { reads: 0, verified: 0 };
  if (reads.reads < T.minN) t('correct-reads', 'INSUFFICIENT', few(reads.reads));
  else {
    const rate = reads.verified / reads.reads;
    t('correct-reads', rate >= T.correctReadRate ? 'PASS' : 'FAIL', `${fmt(rate)} of ${reads.reads} reads true (at least ${T.correctReadRate})`);
  }
  if (!adherence || adherence.unavailable) t('process-adherence', 'N/A', adherence && adherence.unavailable ? adherence.unavailable : 'no scorecard');
  else {
    const n = adherence.agree + adherence.disagree;
    if (n < T.minN) t('process-adherence', 'INSUFFICIENT', few(n));
    else t('process-adherence', adherence.agree / n >= T.processAdherence ? 'PASS' : 'FAIL', `${fmt(adherence.agree / n)} agreement over ${n} scored decisions (at least ${T.processAdherence})`);
  }
  return out;
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

/** The default readers of a finished run: its learning log and measures, its scorecard, its role, the merged features. */
function defaultRead(run, { root, env, barsFiles = {} }) {
  const learning = require('../learning/learning-report');
  return {
    learning: () => learning.readLearning(run.paths.runHome),
    measures: l => learning.learningMeasures(l),
    role: () => (require('../learning/run-gate').readLearningRun(run.paths.runHome) || {}).role || null,
    adherence: () => {
      const sc = require('./scorecard');
      const { strategies } = require('../trading/strategies').loadStrategies(root, env);
      const { accounts } = require('../trading/accounts').loadAccounts(root, env);
      return sc.scoreRun(run.paths.runDir, { strategies, accounts }).summary.agreement.overall;
    },
    features: () => require('../learning/preflight').defaultReaders(root, env).features(),
    skillUsage: () => learning.skillUsageFor(run.paths.runDir, { barsFiles }),
  };
}

/** The skill-usage lines: the run's real report (learning-report.js skillUsageFor) when merged, else N/A. */
function skillUsageLines(merged, rd) {
  if (!merged) return ['skill usage: N/A (needs feat/skill-usage)'];
  let u = null;
  try { u = rd.skillUsage ? rd.skillUsage() : null; } catch (e) { u = { error: String(e.message).split('\n')[0] }; }
  if (!u) return ['skill usage: no compose records in the run'];
  return require('../learning/learning-report').usageText(u).trimEnd().split('\n');
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
  let adherence = null;
  try {
    const a = rd.adherence();
    adherence = f.scorecardComposed ? a : { unavailable: 'needs fix/scorecard-composed (the scorecard doesn\'t score composed setups yet)' };
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
    const tests = exitTest({ decisions, measures: l ? rd.measures(l) : null, adherence });
    const pass = tests.every(x => x.status === 'PASS');
    lines.push(`stage-1 exit test: ${pass ? 'PASS' : 'FAIL'}`);
    for (const x of tests) lines.push(`  ${x.status} ${x.test}: ${x.detail}`);
  }
  if (run.stage === 2) {
    lines.push(f.monteCarlo ? '30-day Monte Carlo by account state: see the prop report' : '30-day Monte Carlo by account state: N/A (phase 2, needs feat/prop-mc-model)');
    if (validate) lines.push(f.monteCarlo ? 'promotion gate: see the prop report' : 'promotion gate (prop/promotion.js): N/A (needs the Monte Carlo\'s attempts, feat/prop-mc-model)');
  }
  return lines;
}

module.exports = { STAGES, EXIT_TEST, applyStage, stageRequirements, exitTest, rBySetup, stageReport };
