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
 *   whole attempt before the window ends (as prop/challenge.js starts them). Rates have a block bootstrap
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
 */

const { unitContaining, attemptFlowCovered, isFlowCovered } = require('./splits');
const { checkLook } = require('./looks');
const { gateFailures } = require('./promotion');
const { tradingDayStart } = require('../trading/clock');
const combine = require('../trading/combine');
const stats = require('./stats');
const at = require('./attempts');

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
  medianDaysToPass: stats.median(a.passDays),
});

/**
 * Score a trade stream (layer 2 and the statistics). opts: { pass (from checkWindow, for this stream's window),
 * account, rulebook: { sizing, multiplier }, size, contracts (micro | mini | auto), maxDailyLoss, seed, paths,
 * meanBlock, reps, level, every, cuts, faults: { stopFault, outage, measured } }. Returns the result (module
 * header); gateFailures(result) is the promotion gate's verdict on it.
 */
function scoreStream(stream, opts) {
  const started = Date.now();
  const {
    pass: given, account, rulebook = {}, size = at.defaultSize, contracts = 'auto', maxDailyLoss = 0, seed = 1, paths = 2000, meanBlock = 7,
    reps = 2000, level = 0.9, every = 1, cuts = [0.25, 0.5], faults = {},
  } = opts || {};
  const pass = given && typeof given === 'object' ? issued.get(given) : undefined;
  if (!pass) throw new Error('scoreStream needs the pass checkWindow returned for this window (each scoring of a held-out window is a look, logged)');
  issued.delete(given);
  if (!account || !Number.isInteger(account.sessions) || account.sessions < 1) throw new Error('account: an account profile with sessions');
  if (!Number.isInteger(seed)) throw new Error('seed: a whole number');
  if (!(Number.isInteger(paths) && paths >= 0) || !(Number.isInteger(every) && every >= 1)) throw new Error('paths: 0 or more; every: 1 or more');
  if (!(meanBlock >= 5 && meanBlock <= 10)) throw new Error(`meanBlock: 5 to 10 days (R9), not ${String(meanBlock)}`);
  const rates = { stopFault: Number(faults.stopFault) || 0, outage: Number(faults.outage) || 0 };
  for (const [k, v] of Object.entries(rates)) if (!(v >= 0 && v <= 1)) throw new Error(`faults.${k}: a rate from 0 to 1, not ${v}`);
  const days = stream.days.filter(d => d.day >= pass.from && d.day < pass.to);
  if (days.length !== stream.days.length) throw new Error(`the stream has days outside the window ${pass.from}..${pass.to}`);
  const bad = days.find(d => d.trades.some(t => t.day !== d.day));
  if (bad) throw new Error(`the stream's day ${bad.day} holds a trade of another day`);
  const inWindow = days.flatMap(d => d.trades);
  const S = account.sessions;
  const sizing = { ...combine.DEFAULT_SIZING, ...(rulebook.sizing || {}) };
  const legsCache = new Map();
  const ctx = {
    account, sizing, size, multiplier: rulebook.multiplier || at.fullVerdict, mode: contracts, maxDailyLoss,
    legsOf: t => {
      if (!legsCache.has(t.symbol)) legsCache.set(t.symbol, at.legsFor(account, t.symbol, { tickValue: t.tickValue, ...(Number.isFinite(t.feesPerSide) ? { feesPerSide: t.feesPerSide } : {}) }));
      return legsCache.get(t.symbol);
    },
  };
  const branch = Array.isArray(stream.fieldBranch) && stream.fieldBranch.length > 0;
  const covers = d => !branch || attemptFlowCovered(d, S);

  // Real paths: every distinct start day leaving room for a whole attempt (prop/challenge.js starts).
  const startIdx = [];
  for (let i = 0; i < days.length - S; i += 1) if (i % every === 0) startIdx.push(i);
  const real = startIdx.map(i => {
    const o = at.runAttempt(days.slice(i), ctx);
    const covered = covers(days[i].day);
    return { start: days[i].day, month: days[i].day.slice(0, 7), index: i, covered, ...(covered ? {} : { flowOff: true }), ...o };
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
  const resample = (label, transform = null) => {
    const prand = stats.streamFor(seed, `paths:${label}`);
    const vrand = stats.streamFor(seed, `variants:${label}`);
    const agg = blank();
    const cov = blank();
    if (!days.length) return { all: agg, covered: cov };
    for (let p = 0; p < paths; p += 1) {
      const list = pathOf(prand);
      const o = at.runAttempt(list, {
        ...ctx,
        outageDay: () => rates.outage > 0 && vrand() < rates.outage,
        variant: t0 => {
          let t = transform ? transform(t0) : t0;
          t = at.redrawOvershoot(t, pools.get(t.symbol), vrand);
          return rates.stopFault > 0 && vrand() < rates.stopFault ? at.stopFault(t) || t : t;
        },
      });
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
    medianDaysToPass: stats.median(pop.passDays),
    intervals: {
      pass: passBoot,
      blow: boot(real.map(o => (o.status === 'blown' ? 1 : 0)), 'interval:blow'),
      timeout: boot(gatePop.map(o => (o.status === 'timeout' ? 1 : 0)), 'interval:timeout'),
      passAtEss: stats.wilson(Math.round((pop.attempts ? pop.passed / pop.attempts : 0) * ess), ess, level),
    },
    ess, blows,
    real: { ...finish(all), ess: essAll, attempts: all.attempts, list: real.map(({ index: _i, ...o }) => o) },
    resampled: { ...shapeResampled(base), meanBlock, regimeMatched: true, overshootRedrawn: true },
    cuts: cutResults,
    coverage: {
      fieldBranch: branch ? stream.fieldBranch : [], covered: gatePop.length, uncovered: real.length - gatePop.length,
      flowOffMonths: [...new Set(real.filter(o => !o.covered).map(o => o.month))],
    },
    objective: {
      lowerBound: passBoot.lo, zeroBlows: totalBlown === 0, medianDaysToPass: stats.median(pop.passDays),
      rejected: totalBlown > 0 ? [`${totalBlown} blow(s) over the attempts scored (R8: a single blow rejects)`] : [],
    },
    window: { from: pass.from, to: pass.to, role: pass.unit.role, block: pass.unit.block, part: pass.unit.part, days: days.length },
    look: pass.look,
    inputs: {
      sessions: S, every, seed, paths, reps, level, cuts, sizing, contracts, maxDailyLoss, expectancyR: Math.round(eR * 10000) / 10000,
      entryDelayMs: stream.entryDelayMs, faults: { ...rates, measured: Boolean(faults.measured) },
      multiplier: rulebook.multiplier ? 'rulebook' : 'full (today\'s verdict)',
    },
    runtimeMs: { layer1: stream.runtimeMs ?? null, layer2: Date.now() - started },
  };
  const failures = gateFailures(result);
  if (branch && !gatePop.length) failures.push('no covered attempt: a policy with a field branch can\'t be promoted without one (section 4)');
  result.promotion = { failures, passes: failures.length === 0 };
  return result;
}

module.exports = { LOOK_PURPOSES, sessionStart, checkWindow, scoreStream };
