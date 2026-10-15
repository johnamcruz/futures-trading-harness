'use strict';

/**
 * The two-layer evaluator (docs/LEARNED-RULEBOOK.md R6-R9): the learning loop's scoring function. Layer 1
 * (prop/trade-stream.js) runs the policy strategy's strategies over the bars once; layer 2 (prop/attempts.js)
 * runs combine attempts from that trade stream under the account's rules and the rulebook. This module checks
 * the window against the schedule and the look ledger, scores a stream, and shapes the result so the promotion
 * gate (prop/promotion.js gateFailures) reads it directly.
 *
 * - The window: [from, to) in session dates, inside one unit of the schedule (prop/splits.js: every attempt
 *   starts and ends inside one block). Train runs freely. Any other unit needs a look ({ candidate, purpose:
 *   tuning | judging }) that the ledger allows (prop/looks.js checkLook), and the look is logged (logLook)
 *   before any bar of the window is read; each scoring of a held-out stream is a look of its own. A
 *   reasoning-fix look is refused: a mechanical score is a claim about the market.
 * - Real paths (R7): an attempt from every distinct start day (every `every`-th) that leaves room for a
 *   whole attempt before the window ends (`sessions` sessions after the start). Rates have a block bootstrap
 *   interval (blocks of `sessions` sessions, R15) and a Wilson interval at the effective sample size
 *   (non-overlapping attempts).
 * - Resampled paths (R9): `paths` attempts of `sessions` days drawn by a stationary block bootstrap over the
 *   window's trading days (mean block `meanBlock`, regime-matched joins), with each stop exit's overshoot
 *   redrawn from its market's observed ones and faults injected at the given rates (stop faults per trade,
 *   runner outages per day; unmeasured rates are reported as such).
 * - Expectancy cuts (R9): real and resampled paths again with the per-trade expectancy cut by each `cuts` share.
 * - A policy with a branch that reads broker fields (stream.fieldBranch) on a window not wholly covered
 *   (section 4): an attempt is covered when its start day plus `sessions` sessions lies inside coverage
 *   (splits.attemptFlowCovered), decided at the start; the pass rate, the attempt count and the months come
 *   from covered attempts only; blows count on every attempt; uncovered attempts are marked flow off; with no
 *   covered attempt the gate fails.
 * - Blows: `blown` at the top counts every blow on every attempt scored (real, resampled, every cut), so the
 *   gate's zero-blow rule and R8's constraint read one number; `blows` breaks it down.
 * - Everything random is seeded (`seed`): the same stream, options and seed give the same result.
 *
 * The model's replay trades (prop/model-stream.js): a stream with `source: 'model'` is scored only on a pass from
 * checkModelWindow, never checkWindow, and a mechanical stream never on one. Its windows are the learning split's
 * (learning/splits.js), not the schedule's: the run's own look (learning/run-gate.js, taken in the learning ledger
 * before its first cycle) is what lets anyone read its outcomes, so every score of a practice-validate, test or final
 * run is logged beside that look (learning/looks.js recordScore), which must be there. Practice-train is free. A
 * reasoning-fix look's outcomes are hidden: no score. A curated run's score is `diagnostic (reweighted)` (its days are
 * resampled at each list's natural rate, prop/natural-rate.js) and a setup-focused run's `diagnostic (setup-focused)`:
 * both practice only, and refused by the promotion gate (`diagnostic`); a full-day run's score is `real`. Days to pass
 * are reported as the median and the 90th percentile (the nearest rank above: never faster than the attempts were).
 */

const { unitContaining, attemptFlowCovered, isFlowCovered } = require('./splits');
const learningSplits = require('../learning/splits');
const { checkLook } = require('./looks');
const { gateFailures } = require('./promotion');
const { tradingDayStart } = require('../trading/clock');
const combine = require('../trading/combine');
const stats = require('./stats');
const at = require('./attempts');
const { createAttribution } = require('./risk-attribution');

const LOOK_PURPOSES = Object.freeze(['tuning', 'judging']);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const issued = new WeakMap(); // pass -> { unit, look, from, to }: a caller can't edit what was checked

/** The start of a session date's trading day (18:00 ET the evening before), in ms. */
function sessionStart(iso) {
  if (!ISO_DAY.test(String(iso))) throw new Error(`a session date YYYY-MM-DD, not ${String(iso)}`);
  return tradingDayStart(new Date(Date.parse(`${iso}T12:00:00Z`))).getTime();
}

/**
 * Check a window [from, to) (session dates) against the schedule and the look ledger. Train: free. Elsewhere:
 * `look` ({ candidate, purpose }), `ledger` (the looks so far) and `logLook` (appends the entry, before the
 * look) are required, and the ledger must allow it. Returns a single-use pass for scoreStream:
 * { unit, look (the logged entry, or null) }. Throws with the reasons on a refusal.
 */
function checkWindow({ from, to, look = null, ledger = null, logLook = null, now = new Date() }) {
  if (!ISO_DAY.test(String(from)) || !ISO_DAY.test(String(to)) || !(from < to)) throw new Error(`window: from and to as session dates YYYY-MM-DD, from before to (got ${from}, ${to})`);
  let unit;
  try {
    unit = unitContaining(from, to);
  } catch (e) {
    throw new Error(`window ${from}..${to}: ${e.message}`, { cause: e });
  }
  if (!unit) throw new Error(`window ${from}..${to} crosses a unit of the schedule (prop/splits.js): every attempt starts and ends inside one block, so score each block on its own`);
  let entry = null;
  if (unit.role !== 'train') {
    const where = `${unit.block}${unit.part ? ` ${unit.part}` : ''}`;
    if (!look || typeof look !== 'object') throw new Error(`window ${from}..${to} is in ${where}, not train: it needs a look ({ candidate, purpose }), checked against the ledger and logged (R16)`);
    if (!LOOK_PURPOSES.includes(look.purpose)) throw new Error(`a mechanical evaluation is a claim about the market: its look's purpose is ${LOOK_PURPOSES.join(' or ')}, not ${String(look.purpose)}`);
    if (typeof logLook !== 'function') throw new Error(`a look at ${where} is logged before it is taken: logLook is required`);
    const r = checkLook({ candidate: look.candidate, purpose: look.purpose, ranges: [{ from, to }] }, ledger);
    if (!r.ok) throw new Error(`the look at ${where} is refused: ${r.refusals.join('; ')}`);
    entry = Object.freeze({
      candidate: look.candidate, purpose: look.purpose, ranges: Object.freeze([Object.freeze({ from, to })]), at: now.toISOString(), what: 'mechanical evaluation (prop/evaluator.js)',
    });
    logLook(entry);
  }
  const checked = Object.freeze({ unit, look: entry, from, to });
  const pass = Object.freeze({ ...checked });
  issued.set(pass, checked);
  return pass;
}

const DIAGNOSTIC = Object.freeze(['reweighted', 'setup-focused']);

/**
 * Check a model replay run before its trades are scored (module header). run: { runId, from, to (session dates, `to`
 * exclusive), learning, role, look, hideOutcomes } (the run's learning-run.json decision and its window); diagnostic:
 * null (a full-day run: the real score), 'reweighted' (a curated run) or 'setup-focused'; candidateRulebook: true
 * when the score is a candidate rulebook's (prop/rulebook-score.js), refused on test and final; logScore(entry):
 * appends the score beside the run's look (learning/looks.js recordScore, which refuses one without it), required
 * on practice-validate, test and final. Returns a single-use pass for scoreStream. Throws with the reason.
 */
function checkModelWindow({ run, diagnostic = null, candidateRulebook = false, logScore = null, now = new Date() }) {
  if (!run || typeof run !== 'object') throw new Error('run: the replay run\'s learning decision and window');
  if (run.hideOutcomes) throw new Error(`run ${run.runId} is a reasoning-fix look: its outcomes are hidden, so it has no Monte Carlo score`);
  if (diagnostic !== null && !DIAGNOSTIC.includes(diagnostic)) throw new Error(`diagnostic: null (a full-day run) or one of ${DIAGNOSTIC.join(', ')}, not ${String(diagnostic)}`);
  const { from, to } = run;
  if (!ISO_DAY.test(String(from)) || !ISO_DAY.test(String(to)) || !(from < to)) throw new Error(`run window: from and to as session dates YYYY-MM-DD, from before to (got ${from}, ${to})`);
  let role = null;
  if (run.learning === true) {
    const roles = learningSplits.rolesBetween(from, to);
    if (roles.length !== 1) throw new Error(`run ${run.runId} spans ${roles.join(' + ')}: a learning run lies inside one window`);
    role = roles[0];
    if (run.role !== role) throw new Error(`run ${run.runId} was started as ${String(run.role)}, but its days are ${role}`);
  } else if (learningSplits.touchesHeldBack(from, to)) {
    throw new Error(`run ${run.runId} is not a learning run but touches practice-validate, test or final: those months are read only through their look`);
  }
  const sealed = learningSplits.SEALED.includes(role);
  if (sealed && diagnostic) throw new Error(`${role} is sealed and judged on every bar, as live: a ${diagnostic} score is practice's, never ${role}'s`);
  if (sealed && candidateRulebook) throw new Error(`${role} is sealed: a candidate rulebook is tuned on practice-train and chosen on practice-validate, never scored on ${role}`);
  let entry = null;
  if (role && role !== 'practice-train') {
    if (!run.look || typeof run.look !== 'object' || !run.look.evaluation) throw new Error(`run ${run.runId} is ${role} but carries no look: its outcomes are read only through the look it took before its first cycle`);
    if (typeof logScore !== 'function') throw new Error(`a score of a ${role} run is logged beside its look: logScore is required`);
    entry = Object.freeze({
      kind: 'score', evaluation: run.look.evaluation, candidate: run.look.candidate, runId: run.runId, role, from, to,
      rulebook: candidateRulebook ? 'candidate' : 'account', diagnostic, at: now.toISOString(), what: 'prop Monte Carlo of the model\'s trades (prop/model-stream.js)',
    });
    logScore(entry);
  }
  const unit = Object.freeze({ role: role || 'unscheduled', block: role || 'unscheduled', part: null });
  const checked = Object.freeze({ unit, look: entry, from, to, model: true, diagnostic, synthetic: diagnostic === 'reweighted', candidateRulebook: Boolean(candidateRulebook) });
  const pass = Object.freeze({ ...checked });
  issued.set(pass, checked);
  return pass;
}

const blank = () => ({ attempts: 0, passed: 0, blown: 0, timeout: 0, unfinished: 0, passDays: [] });
function add(agg, o) {
  agg.attempts += 1;
  if (o.status === 'passed') { agg.passed += 1; agg.passDays.push(o.sessions); } else if (o.status === 'blown') agg.blown += 1;
  else if (o.status === 'timeout') agg.timeout += 1;
  else agg.unfinished += 1;
  return agg;
}
const rate = (k, n) => (n ? Math.round((k / n) * 10000) / 10000 : null);
const finish = a => ({
  attempts: a.attempts, passed: a.passed, blown: a.blown, timeout: a.timeout, unfinished: a.unfinished,
  passRate: rate(a.passed, a.attempts), blowRate: rate(a.blown, a.attempts), timeoutRate: rate(a.timeout, a.attempts),
  medianDaysToPass: stats.median(a.passDays), p90DaysToPass: stats.quantileUp(a.passDays, 0.9),
});

/** The pass checked for this scoring, used up (each scoring of a held-out window is a look of its own). */
function takePass(given) {
  const pass = given && typeof given === 'object' ? issued.get(given) : undefined;
  if (!pass) throw new Error('scoreStream needs the pass checkWindow returned for this window (each scoring of a held-out window is a look, logged)');
  issued.delete(given);
  return pass;
}

/** The options every scoring checks; returns the fault rates. */
function checkOptions({ account, seed, paths, every, meanBlock, faults }) {
  if (!account || !Number.isInteger(account.sessions) || account.sessions < 1) throw new Error('account: an account profile with sessions');
  if (!Number.isInteger(seed)) throw new Error('seed: a whole number');
  if (!(Number.isInteger(paths) && paths >= 0) || !(Number.isInteger(every) && every >= 1)) throw new Error('paths: 0 or more; every: 1 or more');
  if (!(meanBlock >= 5 && meanBlock <= 10)) throw new Error(`meanBlock: 5 to 10 days (R9), not ${String(meanBlock)}`);
  const rates = { stopFault: Number(faults.stopFault) || 0, outage: Number(faults.outage) || 0 };
  for (const [k, v] of Object.entries(rates)) if (!(v >= 0 && v <= 1)) throw new Error(`faults.${k}: a rate from 0 to 1, not ${v}`);
  return rates;
}

/** A trade's own exit: the model closed it before its stop, its target and end of day (a tightened stop, a manual close). */
const ownExit = t => (t.actions || []).includes('early-exit');
/** The model's own share of the ceiling (its filled size over the verdict's); a share that rounds to no contract takes one. */
const ownShare = t => ({ fraction: t.sizeFraction ?? 1, keepOne: true });

/**
 * The stream's days, held to the pass (a model stream to a model pass, a reweighted one to a diagnostic one), each
 * trade re-exited under the policy's exit. keepOwnExits: a trade the model exited itself (ownExit) keeps that exit; the
 * policy's exit replaces only the bracket's.
 */
function daysFor(stream, pass, rulebook, { keepOwnExits = false } = {}) {
  const model = stream.source === 'model';
  if (model !== Boolean(pass.model)) throw new Error(model ? 'a model stream is scored on a pass from checkModelWindow (its run\'s look), never checkWindow' : 'a mechanical stream is scored on a pass from checkWindow, never checkModelWindow');
  if (Boolean(stream.reweighted) !== Boolean(pass.synthetic)) throw new Error(stream.reweighted ? 'a reweighted stream is scored only as a diagnostic (reweighted) score' : 'a diagnostic (reweighted) score needs the reweighted stream (prop/natural-rate.js)');
  if (pass.model && Boolean(rulebook.candidate) !== Boolean(pass.candidateRulebook)) throw new Error('a candidate rulebook is scored only on a pass checked for one (checkModelWindow candidateRulebook), and the account\'s only on one that was not');
  // A reweighted stream's days are resampled, not session dates: no window to hold them to.
  const held = pass.synthetic ? stream.days : stream.days.filter(d => d.day >= pass.from && d.day < pass.to);
  // The policy's exit mode first (attempts.js exitAs): every trade re-exited from its recorded path; none, as recorded.
  const slip = Number.isFinite(stream.slippageTicks) ? stream.slippageTicks : 1;
  const days = rulebook.exit ? held.map(d => ({ ...d, trades: d.trades.map(t => (keepOwnExits && ownExit(t) ? t : at.exitAs(t, rulebook.exit, slip))) })) : held;
  if (days.length !== stream.days.length) throw new Error(`the stream has days outside the window ${pass.from}..${pass.to}`);
  const bad = days.find(d => d.trades.some(t => t.day !== d.day));
  if (bad) throw new Error(`the stream's day ${bad.day} holds a trade of another day`);
  return days;
}

/** Layer 2's context: the account, the rulebook's sizing and multiplier, the sizing function, each market's legs. */
function contextFor({ account, rulebook, size, contracts, maxDailyLoss, gate }) {
  const sizing = { ...combine.DEFAULT_SIZING, ...(rulebook.sizing || {}) };
  const legsCache = new Map();
  return {
    account, sizing, size, multiplier: rulebook.multiplier || at.fullVerdict, mode: contracts, maxDailyLoss,
    // The order gate's loss limits, as live (attempts.js gateLimits: the gate's own config).
    gate: gate === undefined ? at.gateLimits() : gate,
    legsOf: t => {
      if (!legsCache.has(t.symbol)) legsCache.set(t.symbol, at.legsFor(account, t.symbol, { tickValue: t.tickValue, ...(Number.isFinite(t.feesPerSide) ? { feesPerSide: t.feesPerSide } : {}) }));
      return legsCache.get(t.symbol);
    },
  };
}

/**
 * Score a trade stream (layer 2 and the statistics). opts: { pass (from checkWindow, for this stream's window, or
 * checkModelWindow for a model stream), account, rulebook: { sizing, multiplier, candidate, exit (the policy's exit
 * mode, as the strategy loader reads it: every trade is re-exited under it from its recorded path first, attempts.js
 * exitAs; none: as the stream recorded it) }, size, contracts (micro |
 * mini | auto), maxDailyLoss, seed, paths, meanBlock, reps, level, every, cuts, faults: { stopFault, outage, measured },
 * attribution (true: the risk attribution of the resampled paths, prop/risk-attribution.js) }. Returns the result
 * (module header); gateFailures(result) is the promotion gate's verdict on it.
 */
function scoreStream(stream, opts) {
  const started = Date.now();
  const {
    pass: given, account, rulebook = {}, size = at.defaultSize, contracts = 'auto', maxDailyLoss = 0, gate = undefined, seed = 1, paths = 2000, meanBlock = 7,
    reps = 2000, level = 0.9, every = 1, cuts = [0.25, 0.5], faults = {}, attribution = false,
  } = opts || {};
  const pass = takePass(given);
  const rates = checkOptions({ account, seed, paths, every, meanBlock, faults });
  const days = daysFor(stream, pass, rulebook);
  const inWindow = days.flatMap(d => d.trades);
  const S = account.sessions;
  const ctx = contextFor({ account, rulebook, size, contracts, maxDailyLoss, gate });
  const { sizing } = ctx;
  const branch = Array.isArray(stream.fieldBranch) && stream.fieldBranch.length > 0;
  const covers = d => !branch || attemptFlowCovered(d, S);

  // Real paths: every distinct start day leaving room for a whole attempt before the window ends.
  const startIdx = [];
  for (let i = 0; i < days.length - S; i += 1) if (i % every === 0) startIdx.push(i);
  const real = startIdx.map(i => {
    const o = at.runAttempt(days.slice(i), ctx);
    const covered = covers(days[i].day);
    return { start: days[i].day, month: days[i].month || days[i].day.slice(0, 7), index: i, covered, ...(covered ? {} : { flowOff: true }), ...o };
  });
  const gatePop = real.filter(o => o.covered);
  const months = new Map();
  for (const o of gatePop) {
    if (!months.has(o.month)) months.set(o.month, blank());
    add(months.get(o.month), o);
  }
  // Blows count on every attempt that starts in a month, whatever its coverage.
  for (const [m, agg] of months) agg.blown = real.filter(o => o.month === m && o.status === 'blown').length;
  const all = real.reduce(add, blank());
  const pop = gatePop.reduce(add, blank());
  const block = Math.ceil(S / every);
  const boot = (xs, label) => stats.blockBootstrap(xs, { block, reps, level, rand: stats.streamFor(seed, label) });
  const ess = stats.effectiveSampleSize(gatePop.map(o => o.index), S);
  const essAll = stats.effectiveSampleSize(real.map(o => o.index), S);

  // Resampled paths.
  const regimes = days.map(d => d.regime || 'normal');
  const byRegime = stats.groupBy(regimes);
  const pools = at.overshootPools(inWindow);
  const pathOf = rand => stats.stationaryPath(days.length, S, { meanBlock, rand, regimes, byRegime }).map(k => days[k]);
  const attr = attribution ? createAttribution() : null;
  // Stop faults drawn on the base paths: fired (the trade ran unprotected), or missed (no no-stop path to run it on).
  const faultCount = { injected: 0, missed: 0, outages: 0 };
  const resample = (label, transform = null) => {
    const prand = stats.streamFor(seed, `paths:${label}`);
    const vrand = stats.streamFor(seed, `variants:${label}`);
    const agg = blank();
    const cov = blank();
    if (!days.length) return { all: agg, covered: cov };
    for (let p = 0; p < paths; p += 1) {
      const list = pathOf(prand);
      const watch = attr && label === 'base' ? attr.observe(list) : {};
      const o = at.runAttempt(list, {
        ...ctx, ...watch,
        outageDay: () => {
          const out = rates.outage > 0 && vrand() < rates.outage;
          if (out && label === 'base') faultCount.outages += 1;
          return out;
        },
        variant: t0 => {
          let t = transform ? transform(t0) : t0;
          t = at.redrawOvershoot(t, pools.get(t.symbol), vrand);
          if (!(rates.stopFault > 0 && vrand() < rates.stopFault)) return t;
          const f = at.stopFault(t);
          if (label === 'base') faultCount[f ? 'injected' : 'missed'] += 1;
          return f || t;
        },
      });
      if (attr && label === 'base') attr.end(o.status);
      add(agg, o);
      if (!branch || list.every(d => isFlowCovered(d.day))) add(cov, o);
    }
    return { all: agg, covered: cov };
  };
  const shapeResampled = r => ({
    ...finish(branch ? r.covered : r.all), blown: r.all.blown, paths: r.all.attempts,
    mcInterval: stats.wilson((branch ? r.covered : r.all).passed, (branch ? r.covered : r.all).attempts, level),
  });
  const base = resample('base');
  const eR = at.expectancyR(inWindow);
  const cutResults = {};
  for (const c of cuts) {
    const cutReal = startIdx.map(i => at.runAttempt(days.slice(i).map(d => ({ ...d, trades: d.trades.map(t => at.cutTrade(t, c, eR)) })), ctx));
    const covReal = cutReal.filter((_, k) => real[k].covered);
    cutResults[String(c)] = {
      cut: c, real: { ...finish(covReal.reduce(add, blank())), blown: cutReal.filter(o => o.status === 'blown').length },
      resampled: shapeResampled(resample(`cut:${c}`, t => at.cutTrade(t, c, eR))),
    };
  }
  const blows = {
    real: all.blown, resampled: base.all.blown,
    cuts: Object.fromEntries(Object.entries(cutResults).map(([k, v]) => [k, { real: v.real.blown, resampled: v.resampled.blown }])),
  };
  const totalBlown = blows.real + blows.resampled + Object.values(blows.cuts).reduce((a, x) => a + x.real + x.resampled, 0);
  const passBoot = boot(gatePop.map(o => (o.status === 'passed' ? 1 : 0)), 'interval:pass');
  const result = {
    // The promotion gate's shape (gateFailures): covered attempts for a policy with a field branch.
    attempts: pop.attempts, passed: pop.passed, blown: totalBlown, timeout: pop.timeout,
    months: Object.fromEntries([...months].map(([k, v]) => [k, finish(v)])),
    passRate: rate(pop.passed, pop.attempts), blowRate: rate(all.blown, all.attempts), timeoutRate: rate(pop.timeout, pop.attempts),
    medianDaysToPass: stats.median(pop.passDays), p90DaysToPass: stats.quantileUp(pop.passDays, 0.9),
    score: pass.diagnostic ? `diagnostic (${pass.diagnostic})` : 'real', diagnostic: Boolean(pass.diagnostic),
    intervals: {
      pass: passBoot,
      blow: boot(real.map(o => (o.status === 'blown' ? 1 : 0)), 'interval:blow'),
      timeout: boot(gatePop.map(o => (o.status === 'timeout' ? 1 : 0)), 'interval:timeout'),
      // The exact effective count (rate x ESS), never rounded: rounding moves the interval up as often as down.
      passAtEss: stats.wilson(pop.attempts ? (pop.passed / pop.attempts) * ess : 0, ess, level),
      // Blows and timeouts at the effective sample size too: neighbouring starts share most of their sessions.
      blowAtEss: stats.wilson(all.attempts ? (all.blown / all.attempts) * essAll : 0, essAll, level),
      timeoutAtEss: stats.wilson(pop.attempts ? (pop.timeout / pop.attempts) * ess : 0, ess, level),
    },
    ess, blows,
    real: { ...finish(all), ess: essAll, attempts: all.attempts, list: real.map(({ index: _i, ...o }) => o) },
    resampled: { ...shapeResampled(base), meanBlock, regimeMatched: true, overshootRedrawn: true, faults: faultCount },
    cuts: cutResults,
    ...(attr ? { attribution: { ...attr.result(), role: pass.unit.role } } : {}),
    coverage: {
      fieldBranch: branch ? stream.fieldBranch : [], covered: gatePop.length, uncovered: real.length - gatePop.length,
      flowOffMonths: [...new Set(real.filter(o => !o.covered).map(o => o.month))],
    },
    objective: {
      lowerBound: passBoot.lo, zeroBlows: totalBlown === 0, medianDaysToPass: stats.median(pop.passDays), p90DaysToPass: stats.quantileUp(pop.passDays, 0.9),
      rejected: totalBlown > 0 ? [`${totalBlown} blow(s) over the attempts scored (R8: a single blow rejects)`] : [],
    },
    window: { from: pass.from, to: pass.to, role: pass.unit.role, block: pass.unit.block, part: pass.unit.part, days: days.length },
    look: pass.look,
    inputs: {
      sessions: S, every, seed, paths, reps, level, cuts, sizing, contracts, maxDailyLoss, gate: ctx.gate, expectancyR: Math.round(eR * 10000) / 10000,
      entryDelayMs: stream.entryDelayMs, faults: { ...rates, measured: Boolean(faults.measured) },
      // Trades a stop fault can't reach (no no-stop path): with a fault rate above 0 they run as recorded.
      noFaultPath: inWindow.filter(t => !t.noStop).length, rBasis: stream.rBasis || 'gross',
      multiplier: rulebook.multiplier ? 'rulebook' : 'full (today\'s verdict)',
    },
    runtimeMs: { layer1: stream.runtimeMs ?? null, layer2: Date.now() - started },
  };
  const failures = gateFailures(result);
  if (branch && !gatePop.length) failures.push('no covered attempt: a policy with a field branch can\'t be promoted without one (section 4)');
  result.promotion = { failures, passes: failures.length === 0 };
  return result;
}

/**
 * One attempt over `list` on path `p`, its random draws (the day's outage, each trade's overshoot and fault, by its
 * order within the day) from sources of their own, so two runs or two arms on the same path meet the same faults
 * whatever else a day's trades consumed. decide(trade, { cs, counters }) (optional): an arm's choice for each item, null
 * to skip it, or { fraction, trade, keepOne } (the size share, the trade to replay in its place, and keepOne: a share
 * that rounds to no contract still takes one, as the model did when it filled at least one).
 */
function pairedRunner({ ctx, rates, seed, pools }) {
  return (list, p, decide = null) => {
    let day = 0;
    let out = false;
    const chosen = new Map();
    const keep = new Set();
    return at.runAttempt(list, {
      ...ctx,
      size: args => {
        const plan = ctx.size(args);
        if ((plan && plan.size >= 1) || !keep.has(args.trade) || !(args.fraction > 0)) return plan;
        // One contract of the smaller leg: a micro unless only minis trade (one mini can be the whole ceiling).
        const full = ctx.size({ ...args, fraction: 1, mode: args.mode === 'mini' ? 'mini' : 'micro' }) || ctx.size({ ...args, fraction: 1 });
        return full && full.size >= 1 ? { ...full, size: 1 } : plan;
      },
      onDay: (_cs, d) => { day = d; out = rates.outage > 0 && stats.streamFor(seed, `pair:${p}:${d}`)() < rates.outage; },
      outageDay: () => out,
      ...(decide ? {
        multiplier: (t0, info) => {
          const c = decide(t0, info);
          if (!c) return 0;
          chosen.set(t0, c.trade || t0);
          if (c.keepOne) keep.add(t0); else keep.delete(t0);
          // Inside the rulebook's own ceiling: the arm's share times its multiplier.
          return c.fraction * Number(ctx.multiplier(c.trade || t0, info));
        },
      } : {}),
      variant: t0 => {
        const base = chosen.get(t0) || t0;
        const t = at.redrawOvershoot(base, pools.get(base.symbol), stats.streamFor(seed, `pair:${p}:${day}:${t0.seq}:overshoot`));
        return rates.stopFault > 0 && stats.streamFor(seed, `pair:${p}:${day}:${t0.seq}:fault`)() < rates.stopFault ? at.stopFault(t) || t : t;
      },
    });
  };
}

/**
 * The model's risk actions against their counterfactuals, through the same Monte Carlo paths (prop/risk-actions.js
 * builds the arms). Each day's items are its trades and its passed candidates (`passed`), in time order. `base`
 * decides as the model did; each arm reverts one kind of action in one account state (decided on the path, as the
 * state stands when the item comes up). Resampled paths only (each a stationary block bootstrap path of the stream's
 * days, as scoreStream's). opts: { pass (checkModelWindow), account, rulebook, size, contracts, maxDailyLoss, seed,
 * paths, meanBlock, reps, level, faults, base, arms: { name: decide }, sized }. sized: 'own' keeps a trade the model exited itself
 * (ownExit) on that exit, as scorePaired's does, so the base isn't re-exited under the policy exit; 'ceiling' (the default)
 * re-exits every trade. Returns { base, arms: { name: { resampled,
 * diff: { passRate, blowRate } (base minus arm, paired), applied, saved, caused, costPasses, gainedPasses } } }:
 * applied, the paths the arm changed anything on; saved, the paths where the arm blew and the model didn't (the model's
 * action saved a blow); caused, the reverse; costPasses, the arm passed and the model didn't; gainedPasses, the reverse.
 */
function scoreArms(stream, opts) {
  const {
    pass: given, account, rulebook = {}, size = at.defaultSize, contracts = 'auto', maxDailyLoss = 0, gate = undefined, seed = 1, paths = 1000,
    meanBlock = 7, reps = 1000, level = 0.9, faults = {}, base, arms = {}, sized = 'ceiling',
  } = opts || {};
  if (!SIZED.includes(sized)) throw new Error(`scoreArms: sized is one of ${SIZED.join(', ')}, not ${String(sized)}`);
  const pass = takePass(given);
  if (!pass.model || pass.synthetic) throw new Error('scoreArms: a model run\'s own days (a checkModelWindow pass, not a reweighted stream)');
  if (typeof base !== 'function') throw new Error('scoreArms: base, the model\'s own decisions');
  const rates = checkOptions({ account, seed, paths, every: 1, meanBlock, faults });
  const days = daysFor(stream, pass, rulebook, { keepOwnExits: sized === 'own' }).map(d => {
    const items = [...d.trades, ...(d.passed || [])].sort((a, b) => (Date.parse(a.entryTime) || 0) - (Date.parse(b.entryTime) || 0) || String(a.id).localeCompare(String(b.id)));
    return { ...d, trades: items.map((t, seq) => ({ ...t, seq })) };
  });
  const S = account.sessions;
  const ctx = contextFor({ account, rulebook, size, contracts, maxDailyLoss, gate });
  // The overshoots the run's own fills showed (a counterfactual's stop fill carries no gap of its own).
  const runWith = pairedRunner({ ctx, rates, seed, pools: at.overshootPools(stream.days.flatMap(d => d.trades.filter(t => !t.counterfactual))) });
  const regimes = days.map(d => d.regime || 'normal');
  const byRegime = stats.groupBy(regimes);
  const prand = stats.streamFor(seed, 'paths:arms');
  const names = Object.keys(arms);
  const baseOut = [];
  const armOut = Object.fromEntries(names.map(n => [n, []]));
  const applied = Object.fromEntries(names.map(n => [n, []]));
  for (let p = 0; p < (days.length ? paths : 0); p += 1) {
    const list = stats.stationaryPath(days.length, S, { meanBlock, rand: prand, regimes, byRegime }).map(k => days[k]);
    baseOut.push(runWith(list, p, base));
    for (const n of names) {
      let changed = false;
      armOut[n].push(runWith(list, p, (t, info) => { const c = arms[n](t, info); if (c && c.changed) changed = true; return c; }));
      applied[n].push(changed);
    }
  }
  const sum = list => finish(list.reduce(add, blank()));
  const is = st => o => (o.status === st ? 1 : 0);
  const out = {};
  for (const n of names) {
    const pairs = baseOut.map((b, k) => ({ a: b, b: armOut[n][k] }));
    const d = st => pairedInterval(pairs.map(x => is(st)(x.a) - is(st)(x.b)), { block: 1, reps, level, rand: stats.streamFor(seed, `arms:${n}:${st}`) });
    out[n] = {
      resampled: sum(armOut[n]), diff: { passRate: d('passed'), blowRate: d('blown') }, applied: applied[n].filter(Boolean).length,
      saved: pairs.filter(x => x.b.status === 'blown' && x.a.status !== 'blown').length, caused: pairs.filter(x => x.a.status === 'blown' && x.b.status !== 'blown').length,
      costPasses: pairs.filter(x => x.b.status === 'passed' && x.a.status !== 'passed').length, gainedPasses: pairs.filter(x => x.a.status === 'passed' && x.b.status !== 'passed').length,
    };
  }
  return {
    counterfactual: true, base: sum(baseOut), arms: out, look: pass.look,
    inputs: { sessions: S, seed, paths, reps, level, faults: { ...rates, measured: Boolean(faults.measured) }, contracts, days: days.length },
  };
}

/** A paired difference's interval: the mean of per-pair differences, resampled (block 1 over paths, `block` over starts). */
function pairedInterval(diffs, { block, reps, level, rand }) {
  const b = stats.blockBootstrap(diffs, { block, reps, level, rand });
  // Too few blocks to resample: no information, the whole range a difference of rates can take.
  return b.degenerate ? { diff: b.rate, lo: -1, hi: 1, level, degenerate: true, n: diffs.length } : { diff: b.rate, lo: b.lo, hi: b.hi, level, n: diffs.length };
}

/** The median days to pass of A minus B, with a percentile interval over resampled pairs (null without passes on a side). */
function medianDiff(pairs, { reps, level, rand }) {
  const med = list => stats.median(list.filter(x => x !== null));
  const of = (list, side) => list.map(p => (p[side].status === 'passed' ? p[side].sessions : null));
  const point = med(of(pairs, 'a')) !== null && med(of(pairs, 'b')) !== null ? med(of(pairs, 'a')) - med(of(pairs, 'b')) : null;
  if (point === null || pairs.length < 2) return { diff: point, lo: null, hi: null, level, n: pairs.length };
  const out = [];
  for (let r = 0; r < reps; r += 1) {
    const draw = Array.from({ length: pairs.length }, () => pairs[stats.pick(rand, pairs.length)]);
    const a = med(of(draw, 'a'));
    const b = med(of(draw, 'b'));
    if (a !== null && b !== null) out.push(a - b);
  }
  out.sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  return { diff: point, lo: stats.quantile(out, tail), hi: stats.quantile(out, 1 - tail), level, n: pairs.length };
}

/**
 * Two runs of the same days or moments (skill version A against B, the library on against off), scored through the
 * same Monte Carlo paths: the same start days, the same resampled day blocks (stationary bootstrap, drawn once from
 * the seed, regime-matched on A's regimes), and the same faults and overshoot draws (each path's day, and each trade
 * of it by its order within the day, has a random source of its own both runs read: the k-th trade of a day meets
 * the same draws in both; the overshoots are drawn from the two runs' observed ones together). The judge for keeping
 * a skill change: nothing is kept on opinion.
 *
 * opts: { passA, passB (checkModelWindow, one per run: each run's score is logged beside its own look), account,
 * rulebook, size, contracts, maxDailyLoss, seed, paths, meanBlock, reps, level, every, faults, and side B's own
 * accountB, rulebookB, contractsB (default: side A's) }. With a rulebook of its own, side B is sized, exited and
 * multiplied by it (daysFor(streamB, passB, rulebookB): its pass a candidate's when rulebookB.candidate) in a context
 * of its own; the two sides still share the seed, the start days, the resampled blocks and one overshoot pool, and
 * their accounts the same sessions. The runs must hold the same days; reweighted (curated) streams are refused
 * (their days are each run's own draw, not shared).
 *
 * sized: 'ceiling' (the default) sizes every entry at the code's ceiling (the verdict's size times the rulebook's
 * multiplier) and re-exits every trade under the policy's exit. 'own' scores the model as it traded: each entry at its
 * own filled share of that ceiling (sizeFraction, ownShare: risk-actions.js's base; never fewer than one contract when it
 * filled one), and a trade it took out itself (ownExit: an early exit, a tightened stop) at that exit, the policy's exit
 * re-exiting only the trades its bracket closed; the ceiling-sized result is then reported beside it as `ceiling`
 * ({ sizedAs, label, a, b, diff, verdict, blows }), labelled, never judged. A judge of the model's risk decisions
 * (sizing down, cutting a loser near the limit) reads 'own': at the ceiling they are erased.
 *
 * Returns { a, b (each: pass, blow and timeout rates, median and p90 days to pass, on the real and the resampled
 * paths), starts (each real start day: { start, a, b } statuses, aDays, bDays: the raw pairs a pooled test stacks),
 * diff: { real, resampled } (each: passRate, blowRate, timeoutRate and medianDaysToPass, A minus B, with a
 * paired interval: a block bootstrap over start days, blocks of `sessions`, or over paths), verdict (on the resampled
 * paths), verdict: zero blows first (a run with no blow, real or resampled, beats one with any, whatever its pass
 * rate); else, on the resampled paths, 'A better' when A passes more (interval above 0) without blowing more, or blows
 * less (interval below 0) without passing less; 'B better' mirrored; 'trade-off' when each is better on one; else
 * 'no significant difference' }.
 */
function scorePaired(streamA, streamB, opts) {
  const {
    passA: givenA, passB: givenB, account, rulebook = {}, size = at.defaultSize, contracts = 'auto', maxDailyLoss = 0, gate = undefined, seed = 1, paths = 2000,
    meanBlock = 7, reps = 2000, level = 0.9, every = 1, faults = {}, accountB = account, rulebookB = rulebook, contractsB = contracts, sized = 'ceiling',
  } = opts || {};
  if (givenA === givenB) throw new Error('scorePaired: one pass per run (passA, passB)');
  if (!SIZED.includes(sized)) throw new Error(`scorePaired: sized is one of ${SIZED.join(', ')}, not ${String(sized)}`);
  const passA = takePass(givenA);
  const passB = takePass(givenB);
  if (!passA.model || !passB.model) throw new Error('scorePaired compares two model runs (checkModelWindow passes)');
  if (passA.synthetic || passB.synthetic) throw new Error('scorePaired: a reweighted (curated) stream draws its own days; compare full-day or setup-focused runs of the same days');
  const rates = checkOptions({ account, seed, paths, every, meanBlock, faults });
  if (!accountB || accountB.sessions !== account.sessions) throw new Error('scorePaired: the two sides\' accounts must have the same sessions (one attempt length, the same start days)');
  const own = sized === 'own';
  const both = keepOwnExits => {
    const daysA = daysFor(streamA, passA, rulebook, { keepOwnExits });
    const daysB = daysFor(streamB, passB, rulebookB, { keepOwnExits });
    if (daysA.length !== daysB.length || daysA.some((d, k) => d.day !== daysB[k].day)) throw new Error('scorePaired: the two runs must hold the same days (the same window, or the same moments)');
    return [daysA, daysB];
  };
  const shared = { account, rulebook, size, contracts, maxDailyLoss, gate, seed, paths, meanBlock, reps, level, every, rates, faults, accountB, rulebookB, contractsB, passA, passB };
  // The model's own: each entry at its own filled share of the ceiling, out where it took itself out.
  const main = pairedScore(...both(own), { ...shared, decide: own ? ownShare : null });
  main.sizedAs = sized;
  // Beside it, labelled and never judged: every entry at the code's ceiling under the policy's exit.
  if (own) main.ceiling = { sizedAs: 'ceiling', label: CEILING_LABEL, ...pick(pairedScore(...both(false), { ...shared, decide: null }), ['a', 'b', 'diff', 'verdict', 'blows']) };
  return main;
}

const SIZED = Object.freeze(['ceiling', 'own']);
const CEILING_LABEL = 'every entry at the code\'s ceiling (the verdict\'s size) under the policy\'s exit, not the model\'s own size or exits: reported beside, never judged';
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

/** One paired scoring of two runs' days (scorePaired's body); decide: each trade's share (ownShare), or null for the ceiling. */
function pairedScore(daysA, daysB, { account, rulebook, size, contracts, maxDailyLoss, gate, seed, paths, meanBlock, reps, level, every, rates, faults, accountB, rulebookB, contractsB, passA, passB, decide }) {
  const S = account.sessions;
  // One context per side (its own sizing, exit, multiplier and contracts); one overshoot pool and the same seeded draws.
  const pools = at.overshootPools([...daysA, ...daysB].flatMap(d => d.trades));
  const runA = pairedRunner({ ctx: contextFor({ account, rulebook, size, contracts, maxDailyLoss, gate }), rates, seed, pools });
  const runB = pairedRunner({ ctx: contextFor({ account: accountB, rulebook: rulebookB, size, contracts: contractsB, maxDailyLoss, gate }), rates, seed, pools });
  const startIdx = [];
  for (let i = 0; i < daysA.length - S; i += 1) if (i % every === 0) startIdx.push(i);
  const real = startIdx.map(i => ({ a: runA(daysA.slice(i), `real${i}`, decide), b: runB(daysB.slice(i), `real${i}`, decide) }));
  const regimes = daysA.map(d => d.regime || 'normal');
  const byRegime = stats.groupBy(regimes);
  const prand = stats.streamFor(seed, 'paths:paired');
  const resampled = [];
  if (daysA.length) {
    for (let p = 0; p < paths; p += 1) {
      const idx = stats.stationaryPath(daysA.length, S, { meanBlock, rand: prand, regimes, byRegime });
      resampled.push({ a: runA(idx.map(k => daysA[k]), p, decide), b: runB(idx.map(k => daysB[k]), p, decide) });
    }
  }
  const side = (pairs, k) => finish(pairs.map(x => x[k]).reduce(add, blank()));
  const is = st => o => (o.status === st ? 1 : 0);
  const diffs = (pairs, label, block) => {
    const d = st => pairedInterval(pairs.map(x => is(st)(x.a) - is(st)(x.b)), { block, reps, level, rand: stats.streamFor(seed, `paired:${label}:${st}`) });
    return { passRate: d('passed'), blowRate: d('blown'), timeoutRate: d('timeout'), medianDaysToPass: medianDiff(pairs, { reps, level, rand: stats.streamFor(seed, `paired:${label}:days`) }) };
  };
  const diff = { real: diffs(real, 'real', Math.ceil(S / every)), resampled: diffs(resampled, 'resampled', 1) };
  const r = diff.resampled;
  // Zero blows first (the hard gate): a run with a blow never beats one without, whatever its pass rate.
  const blowsOf = k => [...real, ...resampled].filter(x => x[k].status === 'blown').length;
  const [ba, bb] = [blowsOf('a'), blowsOf('b')];
  // Blows are A minus B too: an interval below 0 is fewer blows for A.
  const aBetter = (r.passRate.lo > 0 && !(r.blowRate.lo > 0)) || (r.blowRate.hi < 0 && !(r.passRate.hi < 0));
  const bBetter = (r.passRate.hi < 0 && !(r.blowRate.hi < 0)) || (r.blowRate.lo > 0 && !(r.passRate.lo > 0));
  const verdict = ba === 0 && bb > 0 ? 'A better' : bb === 0 && ba > 0 ? 'B better' : aBetter && !bBetter ? 'A better' : bBetter && !aBetter ? 'B better' : aBetter ? 'trade-off (one passes more, the other blows less)' : 'no significant difference';
  return {
    a: { real: side(real, 'a'), resampled: side(resampled, 'a'), score: passA.diagnostic ? `diagnostic (${passA.diagnostic})` : 'real', look: passA.look },
    b: { real: side(real, 'b'), resampled: side(resampled, 'b'), score: passB.diagnostic ? `diagnostic (${passB.diagnostic})` : 'real', look: passB.look },
    starts: real.map((x, k) => ({ start: daysA[startIdx[k]].day, a: x.a.status, b: x.b.status, aDays: x.a.sessions, bDays: x.b.sessions })),
    diff, verdict, blows: { a: ba, b: bb }, paired: { sameDays: true, sameBlocks: true, sameFaults: true, oneRulebook: rulebookB === rulebook && accountB === account && contractsB === contracts },
    inputs: { sessions: S, seed, paths, reps, level, every, faults: { ...rates, measured: Boolean(faults.measured) }, contracts, contractsB, days: daysA.length },
  };
}

module.exports = { LOOK_PURPOSES, DIAGNOSTIC, SIZED, sessionStart, checkWindow, checkModelWindow, scoreStream, scorePaired, scoreArms, ownShare, ownExit };
