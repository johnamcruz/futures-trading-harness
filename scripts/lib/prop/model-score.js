'use strict';

/**
 * The 30-day Monte Carlo prop score of a replay run: the model's own trades (prop/model-stream.js) through the
 * evaluator (prop/evaluator.js: combine attempts under the account's rules, combine.js, the one rule engine of live,
 * the gate and the simulator), for the replay's report and the end of every run (scripts/replay.js). It replaces the
 * old per-month verdict (one fresh attempt per calendar month on the run's single path).
 *
 * The score, in the owner's order:
 *   1. zero blows, the hard gate: the frozen promotion gate (prop/promotion.js), never weakened;
 *   2. the pass rate within the account's `sessions` (30) trading days;
 *   3. the median and the 90th percentile of days to pass;
 *   4. the blow and timeout rates, with their intervals (a block bootstrap over start days, Wilson at the effective
 *      sample size, Wilson over the resampled paths).
 * A full-day run's score is `real`. A curated run (natural rates given, or <run dir>/natural-rates.json, prop/natural-
 * rate.js) is `diagnostic (reweighted)`, a setup-focused one `diagnostic (setup-focused)`: never promotion scores.
 * A real score refuses a stream with an entry it couldn't settle (a dropped loss would flatter it).
 *
 * The account: --account; else the run's own attempt (its home's combine/<account>.json); else the runner config's
 * `account` when it names a profile; else the policy strategies' account when they agree. None: not scored (no
 * default account). The sizing: the policy strategy that trades that account (its rulebook's sizing, contracts);
 * none: combine.DEFAULT_SIZING, said so.
 *
 *   resolveAccount({ override, attempts, runnerAccount, strategies, accounts })   { name, why } (name null: none)
 *   scoreRun(runDir, { root, env, account, policy, rates, weights, listOf, barsFiles, seed, paths, reps, faults, attribution, now })
 *   pairRuns(runDirA, runDirB, { root, env, account, policy, barsFiles, seed, paths, reps, faults, now })   two runs of the
 *       same days (skill version A against B) through the same paths (prop/evaluator.js scorePaired), each run's score
 *       logged beside its own look: the judge a skill change is kept by
 *   propScoreSection(runDir, { root, env, override, rates, barsFiles })   { result, text, markdown } (never throws)
 *   scoreText(result), scoreMarkdown(result), scoreSummary(result)
 */

const fs = require('fs');
const path = require('path');
const { readModelStream } = require('./model-stream');
const { reweightStream } = require('./natural-rate');
const { checkModelWindow, scoreStream, scorePaired } = require('./evaluator');
const { recordScore, ledgerPath } = require('../learning/looks');

const RATES_FILE = 'natural-rates.json';

function resolveAccount({ override = null, attempts = [], runnerAccount = null, strategies = [], accounts = [] }) {
  const names = new Set(accounts.filter(a => a.valid !== false).map(a => a.name));
  if (override) return { name: override, why: '--account' };
  const own = attempts.filter(n => names.has(n));
  if (own.length === 1) return { name: own[0], why: 'the run\'s own attempt' };
  if (runnerAccount && names.has(String(runnerAccount))) return { name: String(runnerAccount), why: 'the runner config\'s account' };
  const prop = [...new Set(strategies.filter(s => s && s.valid !== false && s.signal === 'policy' && s.account).map(s => s.account))].filter(n => names.has(n));
  if (prop.length === 1) return { name: prop[0], why: 'the policy strategies\' account' };
  return { name: null, why: prop.length > 1 ? `the policy strategies name several accounts (${prop.join(', ')}): pass --account` : 'no account: pass --account (no default account)' };
}

/** The policy strategy that trades `account` (its sizing and contracts), or null. */
function policyFor(strategies, accountName) {
  return (strategies || []).find(s => s && s.valid !== false && s.signal === 'policy' && s.account === accountName && s.status !== 'disabled') || null;
}

/** A run's stream and its checked pass: a real score refuses an unsettled entry, or a fault rate its trades can't take. */
function streamAndPass(runDir, { root, barsFiles, rates, weights, faults, env, now }) {
  const { stream, run } = readModelStream(runDir, { root, barsFiles });
  const diagnostic = rates || weights ? 'reweighted' : run.practice ? 'setup-focused' : null;
  if (!diagnostic && stream.excluded.length) {
    throw new Error(`${stream.excluded.length} entr${stream.excluded.length === 1 ? 'y' : 'ies'} without a settled outcome (${stream.excluded.slice(0, 3).map(x => `${x.root} ${x.bar}: ${x.why}`).join('; ')}): a real score never leaves one out`);
  }
  if (!diagnostic && Number(faults && faults.stopFault) > 0 && stream.noStop.missing) {
    throw new Error(`${stream.noStop.missing} trade(s) without a no-stop path (no bars after the fill): an injected stop fault would silently drop out of them; give the run's bars (--bars)`);
  }
  const ledger = run.ledger || ledgerPath(env);
  const pass = checkModelWindow({ run, diagnostic, logScore: entry => recordScore(ledger, entry), now });
  return { stream, run, diagnostic, pass };
}

function scoreRun(runDir, { root = null, account, policy = null, rates = null, weights = null, listOf, barsFiles = {}, seed = 1, paths = 2000, reps = 2000, faults = {}, attribution = true, env = process.env, now = new Date() }) {
  if (!account) throw new Error('an account profile to score against');
  const { stream, run, diagnostic, pass } = streamAndPass(runDir, { root, barsFiles, rates, weights, faults, env, now });
  let s = stream;
  if (diagnostic === 'reweighted') {
    const { runDecisions } = require('../learning/run-experience');
    const { decisions } = runDecisions(runDir, { root, barsFiles });
    s = reweightStream(stream, decisions, { rates, weights, listOf, seed });
  }
  const sizing = policy ? policy.sizing || null : null;
  const result = scoreStream(s, {
    pass, account, rulebook: { sizing }, contracts: (policy && policy.contracts) || 'auto', seed, paths, reps, faults, attribution,
  });
  return {
    ...result, runId: run.runId, role: run.role, account: account.name, policy: policy ? policy.name : null,
    sizingFrom: policy ? `${policy.name}'s rulebook` : 'the default sizing (no policy strategy trades this account)',
    trades: stream.trades.length, runDays: stream.days.length, excluded: stream.excluded, adverse: stream.adverse, reweighted: s.reweighted || null,
  };
}

function pairRuns(runDirA, runDirB, { root = null, account, policy = null, barsFiles = {}, seed = 1, paths = 2000, reps = 2000, faults = {}, env = process.env, now = new Date() } = {}) {
  if (!account) throw new Error('an account profile to score against');
  const a = streamAndPass(runDirA, { root, barsFiles, faults, env, now });
  const b = streamAndPass(runDirB, { root, barsFiles, faults, env, now });
  const res = scorePaired(a.stream, b.stream, {
    passA: a.pass, passB: b.pass, account, rulebook: { sizing: policy ? policy.sizing || null : null }, contracts: (policy && policy.contracts) || 'auto', seed, paths, reps, faults,
  });
  return { ...res, runs: { a: a.run.runId, b: b.run.runId }, account: account.name };
}

const pct = x => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1)}%`);
const iv = i => (i && i.lo !== null && i.lo !== undefined ? `[${pct(i.lo)}, ${pct(i.hi)}]` : '[-]');
const num = x => (x === null || x === undefined ? '-' : String(x));

/** The score's lines, in the owner's order. */
function scoreLines(r) {
  const S = r.inputs.sessions;
  const rs = r.resampled;
  const zero = r.blown === 0;
  const lines = [
    `Prop Monte Carlo, ${S}-day attempts (${r.account}, ${r.sizingFrom}): ${r.score}${r.diagnostic ? ', never a promotion score' : ''}`,
    `1. Zero blows (hard gate): ${zero ? 'held' : 'FAILED'}: ${r.blown} blow(s) over ${r.real.attempts} real attempts, ${rs.paths} resampled paths and the expectancy cuts`,
    `2. Pass within ${S} trading days: ${pct(r.passRate)} of ${r.attempts} real attempts (bootstrap ${iv(r.intervals.pass)}, Wilson at ${r.ess} independent ${iv(r.intervals.passAtEss)}); resampled ${pct(rs.passRate)} of ${rs.paths} (Wilson ${iv(rs.mcInterval)})`,
    `3. Days to pass: median ${num(r.medianDaysToPass)}, p90 ${num(r.p90DaysToPass)} (real); median ${num(rs.medianDaysToPass)}, p90 ${num(rs.p90DaysToPass)} (resampled)`,
    `4. Blow rate ${pct(r.blowRate)} (bootstrap ${iv(r.intervals.blow)}, Wilson at ${r.real.ess} independent ${iv(r.intervals.blowAtEss)}), timeout rate ${pct(r.timeoutRate)} (bootstrap ${iv(r.intervals.timeout)}, Wilson at ${r.ess} independent ${iv(r.intervals.timeoutAtEss)}) (real); resampled blow ${pct(rs.blowRate)}, timeout ${pct(rs.timeoutRate)}`,
    `Promotion gate: ${r.promotion.passes ? 'passes' : `refused: ${r.promotion.failures.join('; ')}`}`,
    `From ${r.trades} of the model's trades (its fills) over ${r.runDays} session day(s)${r.reweighted ? `, rebuilt at natural rates (${r.reweighted.tradesPerDay} trades a day over ${r.reweighted.days} days${r.reweighted.unsampled.length ? `; unsampled lists: ${r.reweighted.unsampled.join(', ')}` : ''})` : ''}; adverse path from bars on ${r.adverse.bars}, the stop bound on ${r.adverse.bound}${r.excluded.length ? `; ${r.excluded.length} entr${r.excluded.length === 1 ? 'y' : 'ies'} left out (no settled outcome)` : ''}; R gross (price over the stop; the attempts settle net dollars); faults ${r.inputs.faults.measured ? 'measured' : 'unmeasured'} (stop ${r.inputs.faults.stopFault}, outage ${r.inputs.faults.outage}${rs.faults && rs.faults.injected + rs.faults.missed ? `; ${rs.faults.injected} fired, ${rs.faults.missed} without a no-stop path` : ''})`,
  ];
  if (r.attribution) {
    const a = r.attribution.states;
    lines.push(`By account state (resampled): ${Object.entries(a).map(([k, v]) => `${k} ${v.taken} taken / ${v.passed} passed, mean R (gross) ${num(v.meanR)}, in blown ${pct(v.blowShare)}, in passed ${pct(v.passShare)}`).join('; ')}`);
    const f = r.attribution.flagged.slice(0, 5);
    if (f.length) lines.push(`Decisions that cost attempts: ${f.map(x => `${x.kind} ${x.symbol} ${x.bar || x.id} (${x.count} path(s))`).join('; ')}`);
  }
  return lines;
}

const scoreText = r => `${scoreLines(r).map((l, i) => (i ? `  ${l}` : l)).join('\n')}\n`;
const scoreMarkdown = r => ['## Prop Monte Carlo', '', ...scoreLines(r).map(l => `- ${l}`), ''].join('\n');

/** The few numbers the learning report shows beside R and the skill measures. */
function scoreSummary(r) {
  return {
    score: r.score, account: r.account, zeroBlows: r.blown === 0, passRate: r.passRate, resampledPassRate: r.resampled.passRate,
    medianDaysToPass: r.medianDaysToPass, p90DaysToPass: r.p90DaysToPass, blowRate: r.blowRate, timeoutRate: r.timeoutRate,
    resampledBlowRate: r.resampled.blowRate, attempts: r.attempts, paths: r.resampled.paths, promotion: r.promotion.passes,
  };
}

/** The run's natural rates: the file given, else <run dir>/natural-rates.json when the curated run wrote one, else null. */
function ratesFor(runDir, file) {
  const f = file || path.join(runDir, RATES_FILE);
  if (!file && !fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/**
 * The section for the replay's report and the end of a run: { result, text, markdown, summary }; a run that can't be
 * scored says why (never throws: the report still writes).
 */
function propScoreSection(runDir, { root, env = process.env, override = null, ratesFile = null, barsFiles = {}, now = new Date() } = {}) {
  try {
    const { loadAccounts, accountNamed } = require('../trading/accounts');
    const { loadStrategies } = require('../trading/strategies');
    const { runningAttempts } = require('../trading/prop-state');
    const dir = path.resolve(runDir);
    let runner = {};
    try { runner = JSON.parse(fs.readFileSync(path.join(dir, 'autotrader.json'), 'utf8')) || {}; } catch (_err) { /* none */ }
    const { strategies } = loadStrategies(root, env);
    const pick = resolveAccount({ override, attempts: runningAttempts(path.resolve(dir, '..', '..')), runnerAccount: runner.account, strategies, accounts: loadAccounts(root, env).accounts });
    if (!pick.name) throw new Error(pick.why);
    const account = accountNamed(root, pick.name, env);
    const result = scoreRun(dir, { root, env, account, policy: policyFor(strategies, account.name), rates: ratesFor(dir, ratesFile), barsFiles, now });
    result.accountWhy = pick.why;
    return { result, text: `\n${scoreText(result)}`, markdown: scoreMarkdown(result), summary: scoreSummary(result) };
  } catch (err) {
    const why = `Prop Monte Carlo: not scored (${err.message})`;
    return { result: null, text: `\n${why}\n`, markdown: `## Prop Monte Carlo\n\n- ${why}\n`, summary: null, error: err.message };
  }
}

module.exports = { RATES_FILE, resolveAccount, policyFor, scoreRun, pairRuns, scoreText, scoreMarkdown, scoreSummary, propScoreSection };
