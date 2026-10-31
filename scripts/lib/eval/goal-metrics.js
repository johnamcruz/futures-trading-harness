'use strict';

/**
 * The goal regression's metrics (docs/TRAINING.md, "The goal regression"), the owner's goal in its priority order: 0
 * blows, a 30-session combine pass rate of 40% or more, more R caught of the R the trends offered. Pure: trades from
 * goal-trades.js, the trend legs from trend-capture.js legsOf, the combine from the prop simulator.
 *
 *   trendLegs(bars, sessions, { session, minutes })   the PPC trend set's legs of these sessions (legsOf on the curation
 *                          session, filtered as the loop's trend probe: train/trend-align.js filterLegs align htf, the
 *                          opening print dropped), each with `until` (its catch window: start + catchShare of its span)
 *   caught(trades, legs, { minutes, refRiskPts })   { legs, caught, rCaught, rAvailable, share }: a leg is caught by the
 *                          first trade its way that entered in its catch window (its R counts); a leg offers |to - the
 *                          close of its start bar| / refRiskPts R (refRiskPts: the half's median planned risk in points)
 *   tradeStats(trades, { falseStartPeakR, tick })   { trades, meanR, falseStartShare, maxDrawdownR, medianRiskPts }
 *   combineMc({ trades, days, regimes, ctx, sessions, paths, seed, meanBlock, symbol })   { paths, pass, blow, blows,
 *                          meanDaysToPass }: a seeded stationary bootstrap of the days (prop/stats.js stationaryPath, by
 *                          regime), each path a 30-session attempt under the account's rules (prop/attempts.js runAttempt),
 *                          trades the candidates (goal-trades.js), one position at a time after sizing at the path's state
 *   walkTaken({ trades, days, regimes, ctx, symbol })   the candidates live takes on the sessions in order (attempts back
 *                          to back, one position at a time after sizing): what tradeStats and caught read
 *   mcContext(shipped, { root, env, symbol })   the attempt's context: the policy's account, rulebook sizing, the composed
 *                          strategy's cap and the gate's loss limits (as the studies' combine MC built it)
 */

const at = require('../prop/attempts');
const stats = require('../prop/stats');
const { legsOf } = require('../replay/trend-capture');
const TA = require('../train/trend-align');
const { accountNamed } = require('../trading/accounts');
const { requireSizing } = require('../trading/combine');
const { entryOrder } = require('./goal-trades');

const msOf = minutes => minutes * 60000;
const TC = require('../tunables').replay().trendCapture;
const sum = xs => xs.reduce((a, x) => a + x, 0);
const r4 = x => Math.round(x * 1e4) / 1e4;

function trendLegs(bars, sessions, { session, minutes }) {
  const days = new Set(sessions);
  const legs = legsOf(bars, { session }).filter(g => days.has(g.day));
  const spans = Object.fromEntries(legs.map(g => [`${g.day}|${g.side}|${g.start}`, g]));
  const kept = TA.filterLegs(Object.keys(spans), spans, {
    align: 'htf', opening: 'drop', series: TA.htfSeries(bars, minutes), minutes, window: TA.openingWindow(),
    maxBars: require('../tunables').training().trendSet.openingMaxBars,
  }).kept;
  const ix = new Map(bars.map((b, i) => [Date.parse(b.t), i]));
  return kept.map(id => {
    const g = spans[id];
    const t0 = Date.parse(g.start);
    const t1 = Date.parse(g.end) + msOf(minutes);
    const first = bars[ix.get(t0)];
    return { ...g, until: new Date(t0 + (t1 - t0) * TC.catchShare).toISOString(), startClose: first ? first.c : g.from };
  });
}

function caught(trades, legs, { refRiskPts }) {
  let rc = 0;
  let ra = 0;
  let n = 0;
  for (const g of legs) {
    if (refRiskPts > 0) ra += Math.abs(g.to - g.startClose) / refRiskPts;
    const t = trades.find(x => x.side === g.side && x.day === g.day && Date.parse(x.entryTime) >= Date.parse(g.start) && Date.parse(x.entryTime) <= Date.parse(g.until));
    if (t) { n += 1; rc += t.R; }
  }
  return { legs: legs.length, caught: n, rCaught: r4(rc), rAvailable: r4(ra), share: ra > 0 ? r4(rc / ra) : 0 };
}

function tradeStats(trades, { falseStartPeakR, tick }) {
  const n = trades.length;
  const R = trades.map(t => t.R);
  let peak = 0;
  let cum = 0;
  let dd = 0;
  for (const r of R) { cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const risks = trades.map(t => t.stopTicks * tick);
  return {
    trades: n, meanR: n ? r4(sum(R) / n) : 0, totalR: r4(sum(R)),
    falseStartShare: n ? r4(trades.filter(t => t.R < 0 && (t.mfeR ?? 0) <= falseStartPeakR).length / n) : 0,
    maxDrawdownR: r4(dd), medianRiskPts: stats.median(risks),
  };
}

function mcContext(shipped, { root, env = {}, symbol }) {
  const policy = shipped.policy;
  const account = accountNamed(root, policy.account, env);
  return {
    account, sizing: requireSizing(policy.sizing, policy.name), size: at.defaultSize, multiplier: at.fullVerdict, mode: policy.contracts || 'auto',
    maxDailyLoss: 0, limits: { capUsd: shipped.life.risk.max_risk_usd, orderMax: null }, gate: at.gateLimits(env), legsOf: () => at.legsFor(account, symbol),
  };
}

/** A trade as the attempt simulator reads it: its move and its worst excursion in ticks of its stop. */
const toTrade = (t, symbol) => {
  const trough = Math.min(0, t.maeR ?? 0, t.R);
  return { symbol, day: t.day, entryTime: t.entryTime, exitTime: t.exitTime, stopTicks: t.stopTicks, moveTicks: r4(t.R * t.stopTicks), troughTicks: trough < 0 ? [r4(trough * t.stopTicks)] : [], R: t.R };
};

/** The days as an attempt reads them: each day's candidates in entry order (goal-trades.js entryOrder), `ref` the trade. */
function dayList(trades, days, regimes, symbol) {
  const byDay = new Map(days.map(d => [d, []]));
  for (const t of [...trades].sort(entryOrder)) if (byDay.has(t.day)) byDay.get(t.day).push({ ...toTrade(t, symbol), ref: t });
  return days.map((day, i) => ({ day, month: day.slice(0, 7), regime: regimes[i], trades: byDay.get(day) }));
}

/**
 * The trades live would take on the half's sessions in their own order: attempts one after another (a new one the
 * session after one ends), each trade sized at that attempt's state, one position at a time after sizing (runAttempt's
 * onePosition). The trade metrics (tradeStats, caught) read these: a plan no account sizes is never a trade.
 */
function walkTaken({ trades, days, regimes, ctx, symbol }) {
  const list = dayList(trades, days, regimes, symbol);
  const taken = [];
  for (let k = 0; k < list.length;) {
    let last = 0;
    at.runAttempt(list.slice(k), { ...ctx, onePosition: true, onDay: (_cs, d) => { last = d; }, onTrade: ({ trade }) => taken.push(trade.ref) });
    k += last + 1;
  }
  return taken;
}

function combineMc({ trades, days, regimes, ctx, sessions, paths, seed, meanBlock, symbol }) {
  const list = dayList(trades, days, regimes, symbol);
  const rand = stats.streamFor(seed, 'paths:goal');
  const byRegime = stats.groupBy(regimes);
  const out = [];
  for (let p = 0; p < paths; p += 1) {
    const ix = stats.stationaryPath(list.length, sessions, { meanBlock, rand, regimes, byRegime });
    out.push(at.runAttempt(ix.map(j => list[j]), { ...ctx, onePosition: true }));
  }
  const passed = out.filter(o => o.status === 'passed');
  const blows = out.filter(o => o.status === 'blown').length;
  return { paths, pass: r4(passed.length / paths), blow: r4(blows / paths), blows, meanDaysToPass: passed.length ? r4(sum(passed.map(o => o.sessions)) / passed.length) : null };
}

module.exports = { trendLegs, caught, tradeStats, combineMc, walkTaken, mcContext, toTrade };
