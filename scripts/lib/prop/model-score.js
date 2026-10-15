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
 * A full-day run's score is `real`. A curated run (one with a pinned curated list, learning/curated-lists.js) is
 * reweighted to its lists' natural rates (prop/natural-rate.js curatedRates, from the curated scan's candidate counts in
 * its lists document, which the replay config names; or rates given by hand) and scored `diagnostic (reweighted)`; a
 * curated run without its document is not scored. A setup-focused run is `diagnostic (setup-focused)`. Neither is ever
 * a promotion score. A curated run whose days started from drawn account states (prop/account-states.js) is reweighted
 * by each decision's state weight too (natural-rate.js stateWeightOf), so its oversampled states count at their
 * natural share.
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
 *   propScoreSection(runDir, { root, env, override, rates, barsFiles, faults })   { result, text, markdown } (never throws)
 *   parseFaults(text)   the fault rates of `--faults stop=<rate>,outage=<rate>` ({} without it: faults not measured)
 *   scoreText(result), scoreMarkdown(result), scoreSummary(result)
 */

const fs = require('fs');
const path = require('path');
const { readModelStream } = require('./model-stream');
const { reweightStream, curatedRates } = require('./natural-rate');
const { scoreRiskActions } = require('./risk-actions');
const { checkModelWindow, scoreStream, scorePaired } = require('./evaluator');
const { recordScore, ledgerPath } = require('../learning/looks');
const { gateLimits } = require('./attempts');


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
  if (!diagnostic && stream.overlaps.length) {
    throw new Error(`${stream.overlaps.length} pair(s) of trades open at the same time (first at ${stream.overlaps[0].at}): each is settled alone against the account, so their combined drawdown would go unseen; a real score refuses them`);
  }
  if (!diagnostic && Number(faults && faults.stopFault) > 0 && stream.noStop.missing) {
    throw new Error(`${stream.noStop.missing} trade(s) without a no-stop path (no bars after the fill): an injected stop fault would silently drop out of them; give the run's bars (--bars)`);
  }
  const ledger = run.ledger || ledgerPath(env);
  const pass = checkModelWindow({ run, diagnostic, logScore: entry => recordScore(ledger, entry), now });
  return { stream, run, diagnostic, pass };
}

function scoreRun(runDir, { root = null, account, policy = null, rates = null, weights = null, listOf, barsFiles = {}, seed = 1, paths = 2000, reps = 2000, faults = {}, attribution = true, riskActions = true, env = process.env, now = new Date() }) {
  if (!account) throw new Error('an account profile to score against');
  const { stream, run, diagnostic, pass } = streamAndPass(runDir, { root, barsFiles, rates, weights, faults, env, now });
  let s = stream;
  if (diagnostic === 'reweighted') {
    const { runDecisions } = require('../learning/run-experience');
    const { decisions } = runDecisions(runDir, { root, barsFiles });
    // A run whose days started from drawn account states: each decision weighted back to the natural mix of states.
    const states = require('./account-states').readStatesLog(runDir);
    const stateWeightOf = states.some(x => x.kind === 'start') ? require('./account-states').decisionWeight(states) : null;
    s = reweightStream(stream, decisions, { rates, weights, listOf, seed, stateWeightOf });
  }
  const sizing = policy ? policy.sizing || null : null;
  const result = scoreStream(s, {
    pass, account, rulebook: { sizing }, contracts: (policy && policy.contracts) || 'auto', gate: gateLimits(env), seed, paths, reps, faults, attribution,
  });
  // The model's risk actions against their counterfactuals (prop/risk-actions.js): on the run's own days, a scoring of
  // its own (logged beside the run's look as every scoring is); not for a reweighted stream (its days are drawn).
  const acted = stream.days.some(d => (d.passed || []).length || d.trades.some(t => (t.actions || []).length));
  let risk = null;
  if (riskActions && acted && diagnostic !== 'reweighted') {
    const again = checkModelWindow({ run, diagnostic, logScore: entry => recordScore(run.ledger || ledgerPath(env), entry), now });
    risk = scoreRiskActions(stream, { pass: again, account, rulebook: { sizing }, contracts: (policy && policy.contracts) || 'auto', gate: gateLimits(env), seed, paths: Math.min(paths, 1000), reps: Math.min(reps, 1000), faults });
  }
  return {
    ...result, riskActions: risk, runId: run.runId, role: run.role, account: account.name, policy: policy ? policy.name : null,
    sizingFrom: policy ? `${policy.name}'s rulebook` : 'the default sizing (no policy strategy trades this account)',
    trades: stream.trades.length, runDays: stream.days.length, excluded: stream.excluded, adverse: stream.adverse, reweighted: s.reweighted || null,
  };
}

function pairRuns(runDirA, runDirB, { root = null, account, policy = null, barsFiles = {}, seed = 1, paths = 2000, reps = 2000, faults = {}, env = process.env, now = new Date() } = {}) {
  if (!account) throw new Error('an account profile to score against');
  const a = streamAndPass(runDirA, { root, barsFiles, faults, env, now });
  const b = streamAndPass(runDirB, { root, barsFiles, faults, env, now });
  const res = scorePaired(a.stream, b.stream, {
    passA: a.pass, passB: b.pass, account, rulebook: { sizing: policy ? policy.sizing || null : null }, contracts: (policy && policy.contracts) || 'auto', gate: gateLimits(env), seed, paths, reps, faults,
  });
  return { ...res, runs: { a: a.run.runId, b: b.run.runId }, account: account.name };
}

/**
 * Fault rates for the score from `--faults stop=<rate>,outage=<rate>` (a stop fault per trade: late, missing or refused;
 * a runner outage per day): { stopFault, outage, measured: true } (the rates were given), {} without the flag.
 */
function parseFaults(text) {
  if (text === undefined || text === null) return {};
  const out = { stopFault: 0, outage: 0, measured: true };
  const keys = { stop: 'stopFault', outage: 'outage' };
  for (const part of String(text).split(',')) {
    const m = /^\s*(stop|outage)\s*=\s*([0-9.]+)\s*$/.exec(part);
    const v = m ? Number(m[2]) : NaN;
    if (!m || !(v >= 0 && v <= 1)) throw new Error(`--faults: stop=<rate>,outage=<rate>, each from 0 to 1 (got ${String(text)})`);
    out[keys[m[1]]] = v;
  }
  return out;
}

/** The faults the score injected: the given rates and what fired, or that none were measured. */
const faultsText = (f, seen = {}) => (f.measured
  ? `faults at the given rates (stop ${f.stopFault} a trade, outage ${f.outage} a day; ${seen.injected || 0} stop fault(s) fired, ${seen.missed || 0} without a no-stop path, ${seen.outages || 0} outage day(s))`
  : 'faults not measured (no rates given: --faults stop=<rate>,outage=<rate>)');

const pct = x => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1)}%`);
const iv = i => (i && i.lo !== null && i.lo !== undefined ? `[${pct(i.lo)}, ${pct(i.hi)}]` : '[-]');
const num = x => (x === null || x === undefined ? '-' : String(x));

/** The score's lines, in the owner's order. */
function scoreLines(r) {
  const S = r.inputs.sessions;
  const rs = r.resampled;
  const zero = r.blown === 0;
  // The evidence: the run's distinct session days, and the attempts among them that share no session. Resampled paths
  // reuse those days: their interval is conditional on them, never a count of independent attempts.
  const D = r.runDays;
  const independent = Math.floor(D / S);
  const head = r.real.attempts === 0 ? '0 independent attempts: resampled only, not evidence. ' : '';
  const lines = [
    `${head}Prop Monte Carlo, ${S}-day attempts (${r.account}, ${r.sizingFrom}): ${r.score}${r.diagnostic ? ', never a promotion score' : ''}; ${D} distinct day(s), ${independent} independent attempt(s); every entry sized at the code's ceiling (the verdict's), not the model's own size`,
    `1. Zero blows (hard gate): ${zero ? 'held' : 'FAILED'}: ${r.blown} blow(s) over ${r.real.attempts} real attempts, ${rs.paths} resampled paths and the expectancy cuts`,
    `2. Pass within ${S} trading days: ${pct(r.passRate)} of ${r.attempts} real attempts (bootstrap ${iv(r.intervals.pass)}, Wilson at ${r.ess} independent ${iv(r.intervals.passAtEss)}); resampled ${pct(rs.passRate)} of ${rs.paths} paths (Wilson ${iv(rs.mcInterval)}, conditional on these ${D} days)`,
    `3. Days to pass: median ${num(r.medianDaysToPass)}, p90 ${num(r.p90DaysToPass)} (real); median ${num(rs.medianDaysToPass)}, p90 ${num(rs.p90DaysToPass)} (resampled)`,
    `4. Blow rate ${pct(r.blowRate)} (bootstrap ${iv(r.intervals.blow)}, Wilson at ${r.real.ess} independent ${iv(r.intervals.blowAtEss)}), timeout rate ${pct(r.timeoutRate)} (bootstrap ${iv(r.intervals.timeout)}, Wilson at ${r.ess} independent ${iv(r.intervals.timeoutAtEss)}) (real); resampled blow ${pct(rs.blowRate)}, timeout ${pct(rs.timeoutRate)}`,
    ['test', 'final'].includes(r.window.role)
      ? `Promotion gate: ${r.promotion.passes ? 'passes' : `refused: ${r.promotion.failures.join('; ')}`}`
      : `Promotion gate: n/a (${r.window.role} is not out of sample${r.promotion.passes ? '' : `; it would refuse: ${r.promotion.failures.join('; ')}`})`,
    `From ${r.trades} of the model's trades (its fills) over ${r.runDays} session day(s)${r.reweighted ? `, rebuilt at natural rates (${r.reweighted.tradesPerDay} trades a day over ${r.reweighted.days} days${r.ratesFrom ? `, from ${r.ratesFrom}` : ''}${r.reweighted.accountStates ? ', each decision weighted back to the natural mix of account states' : ''}${r.reweighted.unsampled.length ? `; unsampled lists: ${r.reweighted.unsampled.join(', ')}` : ''})` : ''}; adverse path from bars on ${r.adverse.bars}, the stop bound on ${r.adverse.bound}${r.excluded.length ? `; ${r.excluded.length} entr${r.excluded.length === 1 ? 'y' : 'ies'} left out (no settled outcome)` : ''}; R gross (price over the stop; the attempts settle net dollars); ${faultsText(r.inputs.faults, rs.faults)}`,
  ];
  if (r.attribution) {
    const a = r.attribution.states;
    lines.push(`By account state (resampled): ${Object.entries(a).map(([k, v]) => `${k} ${v.taken} taken / ${v.passed} passed, mean R (gross) ${num(v.meanR)}, in blown ${pct(v.blowShare)}, in passed ${pct(v.passShare)}`).join('; ')}`);
    const f = r.attribution.flagged.slice(0, 5);
    if (f.length) lines.push(`Decisions that cost attempts: ${f.map(x => `${x.kind} ${x.symbol} ${x.bar || x.id} (${x.count} path(s))`).join('; ')}`);
  }
  if (r.riskActions) {
    const sign = i => `${i.diff > 0 ? '+' : ''}${pct(i.diff)} ${iv(i)}`;
    for (const [kind, a] of Object.entries(r.riskActions.actions)) {
      if (!a.n) continue;
      const all = a.byState.all;
      const states = Object.entries(a.byState).filter(([k, v]) => k !== 'all' && v.applied).map(([k, v]) => `${k} ${v.applied} paths, saved ${v.savedBlows}/caused ${v.causedBlows} blows, cost ${v.costPasses}/gained ${v.gainedPasses} passes`);
      lines.push(`Risk action ${kind} (counterfactual: reverted on the same paths; ${a.n} decision(s)): pass rate ${sign(all.diff.passRate)} (${all.effect.pass}), blow rate ${sign(all.diff.blowRate)} (${all.effect.blow}) against the model as it traded (pass ${pct(r.riskActions.base.passRate)}, blow ${pct(r.riskActions.base.blowRate)}, at its own sizes)${states.length ? `; by state: ${states.join('; ')}` : ''}`);
    }
  }
  return lines;
}

const scoreText = r => `${scoreLines(r).map((l, i) => (i ? `  ${l}` : l)).join('\n')}\n`;
const scoreMarkdown = r => ['## Prop Monte Carlo', '', ...scoreLines(r).map(l => `- ${l}`), ''].join('\n');

/** The few numbers the learning report shows beside R and the skill measures. */
function scoreSummary(r) {
  return {
    score: r.score, account: r.account, sessions: r.inputs.sessions, zeroBlows: r.blown === 0, passRate: r.passRate, resampledPassRate: r.resampled.passRate,
    medianDaysToPass: r.medianDaysToPass, p90DaysToPass: r.p90DaysToPass, blowRate: r.blowRate, timeoutRate: r.timeoutRate,
    resampledBlowRate: r.resampled.blowRate, attempts: r.attempts, paths: r.resampled.paths, promotion: r.promotion.passes,
    realAttempts: r.real.attempts, days: r.runDays, independentAttempts: Math.floor(r.runDays / r.inputs.sessions), sizedAt: 'ceiling',
  };
}

/**
 * A curated run's natural rates and its decisions' lists: rates given by hand (a file), else from the run's curated lists
 * document (`curated`: { file, list }, the replay config's), checked against the list the run pinned. A run that pinned
 * none: null. A curated run with neither: refused (it is never scored as a full-day run).
 */
function ratesFor(runDir, { ratesFile = null, curated = null } = {}) {
  const { loadPinnedCurated, readLists } = require('../learning/curated-lists');
  const pinned = loadPinnedCurated(path.resolve(runDir, '..', '..'));
  let runner = {};
  try { runner = JSON.parse(fs.readFileSync(path.join(runDir, 'autotrader.json'), 'utf8')) || {}; } catch (_err) { /* none: no poll delay */ }
  // The poll delay the driver stepped with: the runner config over the runner's defaults (autotrader.js DEFAULTS).
  const delayMs = Number({ ...require('../autotrader').DEFAULTS, ...runner }.barDelaySeconds || 0) * 1000;
  const docOf = () => {
    if (!pinned || !curated || !curated.file) return null;
    const doc = readLists(curated.file);
    if (doc.fingerprint !== pinned.fingerprint || (curated.list || 'mix') !== pinned.list) throw new Error(`the run pinned curated list ${String(pinned.fingerprint).slice(0, 16)} (${pinned.list}), not ${doc.fingerprint.slice(0, 16)} (${curated.list || 'mix'})`);
    return doc;
  };
  // Rates by hand: the decisions' lists still from the run's document when there is one.
  if (ratesFile) {
    const doc = docOf();
    return { rates: JSON.parse(fs.readFileSync(ratesFile, 'utf8')), listOf: doc ? curatedRates(doc, { list: pinned.list, delayMs }).listOf : undefined, from: ratesFile };
  }
  if (!pinned) return null;
  if (!curated || !curated.file) throw new Error('a curated run is scored at its lists\' natural rates: give its replay config (--config), which names its lists document, or --natural-rates');
  const doc = docOf();
  const c = curatedRates(doc, { list: pinned.list, delayMs });
  return { rates: c.rates, listOf: c.listOf, from: `${pinned.list} of ${doc.fingerprint.slice(0, 16)}, ${c.scanDays} scan days (${c.scanDaysFrom})` };
}

/**
 * The section for the replay's report and the end of a run: { result, text, markdown, summary }; a run that can't be
 * scored says why (never throws: the report still writes).
 */
function propScoreSection(runDir, { root, env = process.env, override = null, ratesFile = null, curated = null, barsFiles = {}, faults = {}, riskActions = true, now = new Date() } = {}) {
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
    const nat = ratesFor(dir, { ratesFile, curated });
    const result = scoreRun(dir, { root, env, account, policy: policyFor(strategies, account.name), rates: nat ? nat.rates : null, listOf: nat ? nat.listOf : undefined, barsFiles, faults, riskActions, now });
    if (nat) result.ratesFrom = nat.from;
    result.accountWhy = pick.why;
    return { result, text: `\n${scoreText(result)}`, markdown: scoreMarkdown(result), summary: scoreSummary(result) };
  } catch (err) {
    const why = `Prop Monte Carlo: not scored (${err.message})`;
    return { result: null, text: `\n${why}\n`, markdown: `## Prop Monte Carlo\n\n- ${why}\n`, summary: null, error: err.message };
  }
}

module.exports = { ratesFor, resolveAccount, policyFor, scoreRun, pairRuns, parseFaults, scoreText, scoreMarkdown, scoreSummary, propScoreSection };
