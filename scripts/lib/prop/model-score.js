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
 * none is refused before any look (combine.requireSizing: sizing lives only in a policy's rulebook entry, no code default).
 *
 *   resolveAccount({ override, attempts, runnerAccount, strategies, accounts })   { name, why } (name null: none)
 *   scoreRun(runDir, { root, env, account, policy, rates, weights, listOf, momentOf, barsFiles, seed, paths, reps, faults, attribution, now })
 *   reweightRun(runDir, stream, { root, barsFiles, rates, weights, listOf, momentOf, seed })   a curated run's stream at natural rates
 *   pairRuns(runDirA, runDirB, { root, rootB, env, account, policy, accountB, policyB, candidateB, barsFiles, seed, paths, reps, faults, now })
 *       two runs of the same days (skill version A against B) through the same paths (prop/evaluator.js scorePaired),
 *       each run's score logged beside its own look: the judge a skill change is kept by. Scored as the model traded
 *       (scorePaired sized 'own': each entry at its own filled share of the ceiling, its own exit when it took itself
 *       out), the ceiling-sized result beside it (`ceiling`, labelled, never judged). A curated run is refused
 *       (refuseCurated). With accountB or policyB,
 *       each side is scored under its own policy's whole entry (policyRulebook); candidateB: B's is a candidate rulebook
 *   policyRulebook(policy, { candidate })   { sizing, exit, multiplier, candidate? }: a policy's entry as the Monte Carlo applies it
 *   propScoreSection(runDir, { root, env, override, rates, barsFiles, faults })   { result, text, markdown } (never throws)
 *   parseFaults(text)   the fault rates of `--faults stop=<rate>,outage=<rate>` ({} without it: faults not measured)
 *   scoreText(result), scoreMarkdown(result), scoreSummary(result)
 */

const fs = require('fs');
const path = require('path');
const { MC_SIZE } = require('./mc-size');
const { requireSizing } = require('../trading/combine');
const { readModelStream } = require('./model-stream');
const { reweightStream, curatedRates } = require('./natural-rate');
const { scoreRiskActions } = require('./risk-actions');
const { checkModelWindow, scoreStream, scorePaired } = require('./evaluator');
const { recordScore, ledgerPath } = require('../learning/looks');
const { gateLimits } = require('./attempts');
const { ceiling } = require('../trading/rulebook');


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

/**
 * The live entry's sizing beyond the rulebook, for the Monte Carlo of a run (prop/size-translate.js, as live sizes it):
 * limits { capUsd: the policy's composed component's risk.max_risk_usd, orderMax: the run home's broker's recorded max
 * order size, null when none }, and the contract the run traded (its runner's selected symbols: micro when every one is a
 * micro, mini when every one is a mini; else the policy's contracts).
 */
function liveSizing({ policy, strategies = [], home, runner = {}, env = process.env }) {
  const { familyOf } = require('../trading/contracts');
  const comp = policy ? (strategies || []).find(s => s && (policy.strategies || []).includes(s.name) && s.signal === 'composed') : null;
  let orderMax = null;
  try {
    const { brokerOrderLimit, contractsFileFor } = require('../trading/broker-specs');
    orderMax = brokerOrderLimit(contractsFileFor(home, env)).maxOrderSize;
  } catch (_err) { /* none recorded */ }
  const syms = Array.isArray(runner.symbols) ? runner.symbols.map(s => String(s).toUpperCase()) : [];
  const legOf = s => { const f = familyOf(s); return !f ? null : s === f.micro ? 'micro' : s === f.mini ? 'mini' : null; };
  const legs = [...new Set(syms.map(legOf))];
  const contracts = legs.length === 1 && legs[0] ? legs[0] : null;
  const capUsd = comp && comp.risk && comp.risk.max_risk_usd > 0 ? comp.risk.max_risk_usd : null;
  // Either limit alone still applies (live translateSize takes the broker's max whatever the cap); neither: none.
  return { limits: capUsd !== null || orderMax !== null ? { capUsd, orderMax } : null, contracts };
}

/** The policy strategy that trades `account` (its sizing and contracts), or null. */
function policyFor(strategies, accountName) {
  return (strategies || []).find(s => s && s.valid !== false && s.signal === 'policy' && s.account === accountName && s.status !== 'disabled') || null;
}

/** A run's stream and its checked pass: a real score refuses an unsettled entry, or a fault rate its trades can't take. */
function streamAndPass(runDir, { root, barsFiles, rates, weights, faults, env, now, candidateRulebook = false }) {
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
  const pass = checkModelWindow({ run, diagnostic, candidateRulebook, logScore: entry => recordScore(ledger, entry), now });
  return { stream, run, diagnostic, pass };
}

/**
 * A curated run's stream rebuilt at its lists' natural rates (natural-rate.js): its decision lines (plain passes
 * included: every moment it stepped is a candidate), each placed in its list and moment (listOf, momentOf: ratesFor's),
 * and, for a run whose days started from drawn account states, each weighted back to the natural mix of states. The one
 * reweighting both the run's score (scoreRun) and the account-state draw (account-states.js sourceStream) use.
 */
function reweightRun(runDir, stream, { root = null, barsFiles = {}, rates = null, weights = null, listOf, momentOf, seed = 1 }) {
  const { decisions } = require('../learning/run-experience').runDecisions(runDir, { root, barsFiles });
  const AS = require('./account-states');
  const states = AS.readStatesLog(runDir);
  const stateWeightOf = states.some(x => x.kind === 'start') ? AS.decisionWeight(states) : null;
  return reweightStream(stream, decisions, { rates, weights, listOf, momentOf, seed, stateWeightOf });
}

function scoreRun(runDir, { root = null, account, policy = null, limits = null, contracts = null, rates = null, weights = null, listOf, momentOf, barsFiles = {}, seed = 1, paths = MC_SIZE.paths, reps = MC_SIZE.reps, faults = {}, attribution = true, riskActions = true, env = process.env, now = new Date() }) {
  if (!account) throw new Error('an account profile to score against');
  requireSizing(policy && policy.sizing, `${account.name}: no policy strategy with a whole rulebook sizing trades it, so nothing is scored`);
  const { stream, run, diagnostic, pass } = streamAndPass(runDir, { root, barsFiles, rates, weights, faults, env, now });
  const s = diagnostic === 'reweighted' ? reweightRun(runDir, stream, { root, barsFiles, rates, weights, listOf, momentOf, seed }) : stream;
  const sizing = policy ? policy.sizing || null : null;
  const result = scoreStream(s, {
    pass, account, rulebook: { sizing, limits }, contracts: contracts || (policy && policy.contracts) || 'auto', gate: gateLimits(env), seed, paths, reps, faults, attribution,
  });
  // The model's risk actions against their counterfactuals (prop/risk-actions.js): on the run's own days, a scoring of
  // its own (logged beside the run's look as every scoring is); not for a reweighted stream (its days are drawn).
  const acted = stream.days.some(d => (d.passed || []).length || d.trades.some(t => (t.actions || []).length));
  let risk = null;
  if (riskActions && acted && diagnostic !== 'reweighted') {
    const again = checkModelWindow({ run, diagnostic, logScore: entry => recordScore(run.ledger || ledgerPath(env), entry), now });
    risk = scoreRiskActions(stream, { pass: again, account, rulebook: { sizing, limits }, contracts: contracts || (policy && policy.contracts) || 'auto', gate: gateLimits(env), seed, paths, reps, faults });
  }
  return {
    ...result, riskActions: risk, runId: run.runId, role: run.role, account: account.name, policy: policy ? policy.name : null,
    sizingFrom: `${policy.name}'s rulebook`, // none: refused above (no code default sizing)
    sizedWith: { limits, contracts: contracts || (policy && policy.contracts) || 'auto' }, // the live entry's limits and contract (liveSizing), or none
    trades: stream.trades.length, runDays: stream.days.length, excluded: stream.excluded, adverse: stream.adverse, reweighted: s.reweighted || null,
  };
}

/**
 * A policy's whole rulebook entry as the Monte Carlo applies it: its sizing, its exit (each trade re-exited from its
 * recorded path, attempts.js exitAs) and its verdict multipliers on each trade's recorded facts (trading/rulebook.js
 * ceiling, as the live verdict; a missing fact skips the trade: fails closed). candidate: a rulebook not the account's.
 */
function policyRulebook(policy, { candidate = false } = {}) {
  const items = policy && Array.isArray(policy.multipliers) ? policy.multipliers : [];
  const multiplier = t => {
    if (!items.length) return 1;
    const t0 = t.entryTime || (Number.isFinite(t.entryMs) ? new Date(t.entryMs).toISOString() : new Date(0).toISOString());
    const facts = Object.fromEntries(Object.entries(t.facts || {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, { value: v, at: t0 }]));
    return ceiling(items, facts, new Date(t0)).multiplier;
  };
  return { sizing: policy ? policy.sizing || null : null, ...(policy && policy.exit ? { exit: policy.exit } : {}), multiplier, ...(candidate ? { candidate: true } : {}) };
}

/**
 * A curated run never judges a change: its moments are picked outcome-balanced (curated-lists.js: winners and losers
 * kept level, a pass share per list), so even rebuilt at natural rates the outcomes it draws are the list's, not the
 * market's; and a rebuilt stream's days are drawn, so it has no real start days to pair (scorePaired refuses one). The
 * keep rule pairs full-day runs (or setup-focused runs of the same calendar days, labelled diagnostic).
 */
function refuseCurated(runDir) {
  const { loadPinnedCurated } = require('../learning/curated-lists');
  if (loadPinnedCurated(path.resolve(runDir, '..', '..'))) {
    throw new Error(`${path.basename(path.resolve(runDir))} is a curated run: a paired judge never reads one (its moments are outcome-balanced, its rebuilt days drawn, not paired); replay full-day windows of at least 3 x the account's sessions`);
  }
}

function pairRuns(runDirA, runDirB, { root = null, rootB = null, account, policy = null, accountB, policyB, candidateB = false, barsFiles = {}, seed = 1, paths = MC_SIZE.paths, reps = MC_SIZE.reps, faults = {}, env = process.env, now = new Date() } = {}) {
  if (!account) throw new Error('an account profile to score against');
  requireSizing(policy && policy.sizing, `${account.name}: no policy strategy with a whole rulebook sizing trades it, so nothing is scored`);
  // Two rulebooks (accountB or policyB given: the training loop's verifier): each side its own policy's whole entry,
  // B's a candidate's when it differs (its pass refused on test and final). Else one rulebook's sizing for both, as before.
  const two = accountB !== undefined || policyB !== undefined;
  for (const dir of [runDirA, runDirB]) refuseCurated(dir);
  const a = streamAndPass(runDirA, { root, barsFiles, faults, env, now });
  // rootB: the tree run B ran on, when it is another (the training loop's challenger); its records are read with its documents.
  const b = streamAndPass(runDirB, { root: rootB || root, barsFiles, faults, env, now, candidateRulebook: two && candidateB });
  const rulebook = two ? policyRulebook(policy) : { sizing: policy ? policy.sizing || null : null };
  const pB = policyB === undefined ? policy : policyB;
  const res = scorePaired(a.stream, b.stream, {
    passA: a.pass, passB: b.pass, account, rulebook, contracts: (policy && policy.contracts) || 'auto', gate: gateLimits(env), seed, paths, reps, faults, sized: 'own',
    ...(two ? { accountB: accountB || account, rulebookB: policyRulebook(pB, { candidate: candidateB }), contractsB: (pB && pB.contracts) || 'auto' } : {}),
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
 * A curated run's natural rates and its decisions' lists and moments (natural-rate.js curatedRates: listOf, momentOf):
 * rates given by hand (a file) or from the run's curated lists document (`curated`: { file, list }, the replay config's),
 * the document checked against the list the run pinned and needed either way (it places each decision in its moment).
 * A run that pinned none: null (rates by hand on it: refused). A curated run without its document: refused (it is never
 * scored as a full-day run).
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
  // Rates by hand: the decisions' lists and moments still from the run's document (its candidates are its moments).
  if (ratesFile) {
    const doc = docOf();
    if (!doc) throw new Error('rates by hand reweight a curated run: its candidates are the curated moments it stepped, placed by its lists document, so give its replay config (--config) too');
    const c = curatedRates(doc, { list: pinned.list, delayMs });
    return { rates: JSON.parse(fs.readFileSync(ratesFile, 'utf8')), listOf: c.listOf, momentOf: c.momentOf, from: ratesFile };
  }
  if (!pinned) return null;
  if (!curated || !curated.file) throw new Error('a curated run is scored at its lists\' natural rates: give its replay config (--config), which names its lists document, or --natural-rates');
  const doc = docOf();
  const c = curatedRates(doc, { list: pinned.list, delayMs });
  return { rates: c.rates, listOf: c.listOf, momentOf: c.momentOf, from: `${pinned.list} of ${doc.fingerprint.slice(0, 16)}, ${c.scanDays} scan days (${c.scanDaysFrom})` };
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
    const policy = policyFor(strategies, account.name);
    const live = liveSizing({ policy, strategies, home: path.resolve(dir, '..', '..'), runner, env });
    const result = scoreRun(dir, { root, env, account, policy, limits: live.limits, contracts: live.contracts, rates: nat ? nat.rates : null, listOf: nat ? nat.listOf : undefined, momentOf: nat ? nat.momentOf : undefined, barsFiles, faults, riskActions, now });
    if (nat) result.ratesFrom = nat.from;
    result.accountWhy = pick.why;
    return { result, text: `\n${scoreText(result)}`, markdown: scoreMarkdown(result), summary: scoreSummary(result) };
  } catch (err) {
    const why = `Prop Monte Carlo: not scored (${err.message})`;
    return { result: null, text: `\n${why}\n`, markdown: `## Prop Monte Carlo\n\n- ${why}\n`, summary: null, error: err.message };
  }
}

module.exports = { ratesFor, reweightRun, resolveAccount, liveSizing, policyFor, policyRulebook, scoreRun, pairRuns, parseFaults, scoreText, scoreMarkdown, scoreSummary, propScoreSection };
