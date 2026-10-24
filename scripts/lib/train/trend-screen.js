'use strict';

/**
 * The trend screen (Propose-Probe-Compose, docs/TRAINING.md): one edit's runs of the trend set's sessions
 * (trend-set.js) against the champion's, paired by code on the same days, from each run's trend-capture report
 * (replay/trend-capture.js: its legs, each caught or not, and every missed leg's blocker) and its day records:
 *
 *   capture   per leg (its id: day, side, start bar; the same bars give both sides the same legs), caught or not, an
 *             exact one-sided McNemar test. A leg the edit caught counts as fixed only when its session's net R got no
 *             worse: catching more legs by trading more and losing more is never a gain
 *   netR      the paired bootstrap interval of each session's net R (every round trip's R, leg or not), edit minus
 *             champion: the harm a looser rule shows on the days with nothing to catch
 *   blows     decisions the run's scorecard records at or past the account's floor
 *   firstTry  the model's first compose_check of each decision point, before any hint (first-try.js): paired, a harm
 *             when significantly worse under the loop's decision rule, whatever the legs caught; never a gain
 * The thresholds are the curated screen's own (screen.js SCREEN): a gain needs minDiscordant changed legs, p at most
 * gainAlpha and minEffect of the paired legs net; a harm p at most harmAlpha, or netR's interval wholly below zero on at
 * least minPairs sessions. The regression days (the trend-move set) judge only harm: fewer legs caught there than the
 * champion caught, net, is a harm, whatever the census showed.
 *
 *   dayR(days)                                  { day: net R } of a run's day records (every round trip with an R)
 *   sideOfTrend({ captures, days, scorecard, first })   { legs: Map id -> { day, captured, availableR }, dayR, blows, first }
 *   measureTrend(champion, probe)               { capture, netR, legs, rate: { champion, probe }, blows }
 *   trendHarms(m, { rule }), regressionHarms(champion, probe)   [harm] (rule: the loop's decision rule, for first tries)
 *   screenTrend(m, { target, rule })            { verdict, pass, harms, gain }: target false judges harm only
 */

const { tally } = require('./paired');
const { pairedInterval } = require('./ab-compare');
const { SCREEN } = require('./screen');
const FT = require('./first-try');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Each session's net R: every round trip with an R in its day records. */
function dayR(days) {
  const out = {};
  for (const [day, recs] of Object.entries(days || {})) {
    let r = 0;
    for (const rec of Array.isArray(recs) ? recs : []) for (const t of Array.isArray(rec && rec.trades) ? rec.trades : []) if (isObj(t.roundTrip) && num(t.roundTrip.r) !== null) r += t.roundTrip.r;
    out[day] = Math.round(r * 10000) / 10000;
  }
  return out;
}

function sideOfTrend({ captures = [], days = {}, scorecard = [], first = [] } = {}) {
  const legs = new Map();
  for (const doc of captures) for (const l of (isObj(doc) && Array.isArray(doc.legs) ? doc.legs : [])) legs.set(l.id, { day: l.day, captured: l.captured === true, availableR: num(l.availableR) });
  return { legs, dayR: dayR(days), blows: (scorecard || []).filter(d => d && d.blow === true).length, first: Array.isArray(first) ? first : [] };
}

function measureTrend(champion, probe) {
  const ids = [...champion.legs.keys()].filter(id => probe.legs.has(id));
  const sameDays = Object.keys(champion.dayR).filter(d => d in probe.dayR);
  const worseDay = d => (probe.dayR[d] ?? 0) < (champion.dayR[d] ?? 0);
  // A leg caught only by the edit is fixed only when its session's net R got no worse.
  const pairs = ids.map(id => {
    const a = champion.legs.get(id);
    const b = probe.legs.get(id);
    return { base: { category: a.captured ? 'right' : 'missed' }, cand: { category: b.captured && !(worseDay(a.day) && !a.captured) ? 'right' : 'missed' } };
  });
  const t = tally(pairs, r => r.category !== 'right');
  const iv = pairedInterval(sameDays.map(d => probe.dayR[d] - champion.dayR[d]), 'trend:netR');
  const rate = s => (ids.length ? Math.round((ids.filter(id => s.legs.get(id).captured).length / ids.length) * 10000) / 10000 : null);
  return {
    capture: { pairs: ids.length, b: t.b, c: t.c, n: t.n, pBetter: t.pBetter, pWorse: t.pWorse },
    netR: { pairs: sameDays.length, diff: iv.diff, lo: iv.lo, hi: iv.hi },
    legs: ids.length, rate: { champion: rate(champion), probe: rate(probe) }, blows: probe.blows,
    firstTry: { paired: FT.pairFirstTries(champion.first, probe.first), champion: FT.summarize(champion.first), probe: FT.summarize(probe.first) },
  };
}

const harmful = t => t && t.n >= SCREEN.minDiscordant && t.c > t.b && t.pWorse <= SCREEN.harmAlpha;
const gained = t => t && t.n >= SCREEN.minDiscordant && t.b > t.c && t.pBetter <= SCREEN.gainAlpha && t.pairs > 0 && (t.b - t.c) / t.pairs >= SCREEN.minEffect;

function trendHarms(m, { rule } = {}) {
  const out = [];
  const ft = m.firstTry ? FT.firstTryHarm(m.firstTry.paired, rule) : null;
  if (ft) out.push(`trend set: ${ft}`);
  if (m.blows > 0) out.push(`trend set: ${m.blows} blow(s) on the probe's side`);
  if (harmful(m.capture)) out.push(`trend set: legs caught worse (broken ${m.capture.c}, fixed ${m.capture.b}, p ${m.capture.pWorse})`);
  if (m.netR.pairs >= SCREEN.minPairs && m.netR.hi !== null && m.netR.hi < 0) out.push(`trend set: net R per session worse (${m.netR.diff} [${m.netR.lo}, ${m.netR.hi}])`);
  return out;
}

/** The regression days: harm only. Fewer of the champion's legs caught there, net, is a harm. */
function regressionHarms(champion, probe) {
  const m = measureTrend(champion, probe);
  const out = [];
  if (m.capture.c > m.capture.b) out.push(`regression days: ${m.capture.c - m.capture.b} leg(s) the champion caught lost, net`);
  if (m.blows > 0) out.push(`regression days: ${m.blows} blow(s)`);
  return out;
}

function screenTrend(m, { target = true, rule } = {}) {
  const harms = trendHarms(m, { rule });
  const gain = target && gained(m.capture);
  const verdict = harms.length ? 'hurt' : gain ? 'helped' : 'no effect';
  return { verdict, pass: verdict === 'helped', harms, gain: Boolean(gain) };
}

module.exports = { dayR, sideOfTrend, measureTrend, trendHarms, regressionHarms, screenTrend, gained, harmful };
