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
 * Only sessions both runs stepped to their end pair (sessionsOf: the day's end-of-day step ran). A session a run left
 * early (a call limit, a crash or failed cycles, its combine attempt ending) holds fewer legs than the market had, so
 * its legs, net R and first tries count neither as a miss nor as a catch: they are dropped, and each side's report says
 * which and why. A session in its front contract's expiry month (rollMonth: the month the front contract expires or
 * the one after the roll; the run home's contract day files, their standard months) is flagged: pairing legs across a
 * contract roll is not yet confirmed (a back-adjusted roll gap could shift a leg's start).
 *
 * The thresholds are the curated screen's own (screen.js SCREEN): a gain needs minDiscordant changed legs, p at most
 * gainAlpha and minEffect of the paired legs net; a harm p at most harmAlpha, or netR's interval wholly below zero on at
 * least minPairs sessions. The regression days (the trend-move set) judge only harm: fewer legs caught there than the
 * champion caught, net, is a harm, whatever the census showed.
 *
 *   dayR(days)                                  { day: net R } of a run's day records (every round trip with an R)
 *   sessionsOf({ days, combine, fronts })       [{ day, complete, why, rollMonth }]: days a run's day records; combine
 *                                               its combine log; fronts { day: the front contract's YYYY-MM }
 *   sideOfTrend({ captures, days, scorecard, first, sessions })   { legs: Map id -> { day, captured, availableR }, dayR, blows,
 *                                               first, sessions } (sessions: sessionsOf; none: every day complete)
 *   measureTrend(champion, probe)               { capture, netR, legs, rate: { champion, probe }, blows }
 *   trendHarms(m, { rule }), regressionHarms(champion, probe)   [harm] (rule: the loop's decision rule, for first tries)
 *   screenTrend(m, { target, rule })            { verdict, pass, harms, gain }: target false judges harm only
 */

const { tally } = require('./paired');
const { pairedInterval } = require('./ab-compare');
const { SCREEN } = require('./screen');
const FT = require('./first-try');
const { tradingDayKey } = require('../trading/clock');

/** A bar's session date (the 18:00 ET rollover), or null. */
const dayOfBar = bar => (Number.isFinite(Date.parse(bar)) ? tradingDayKey(new Date(Date.parse(bar))) : null);

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

/** A run's sessions: complete when the day's end-of-day step ran; else why it stopped; and a roll-month flag. */
function sessionsOf({ days = {}, combine = [], fronts = {} } = {}) {
  return Object.keys(days || {}).sort().map(day => {
    const recs = Array.isArray(days[day]) ? days[day] : [];
    const complete = recs.some(r => r && r.kind === 'eod');
    const ended = (combine || []).find(x => x && x.kind === 'end' && (x.day === day || String(x.at || '').startsWith(day)));
    const last = recs[recs.length - 1];
    const why = complete ? null : ended ? `its combine attempt ended (${ended.outcome || 'ended'})` : last && Array.isArray(last.errors) && last.errors.length ? 'failed cycles (a crash or errors)' : 'stopped before the session ended (a call limit or an interruption)';
    return { day, complete, why, rollMonth: rollMonth(day, fronts[day]) };
  });
}

/**
 * Near a roll: the months from the session to its front contract's month are one of config/training.json
 * trendScreen.rollFlagGaps (0, the expiry month before the roll; 3, the month after a quarterly roll).
 */
function rollMonth(day, front) {
  const d = /^(\d{4})-(\d{2})/.exec(String(day || ''));
  if (!/^\d{4}-\d{2}$/.test(String(front || '')) || !d) return false;
  // The session's month moved on by each gap (Date.UTC carries a month past December into the next year).
  const monthOn = g => new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1 + g, 1)).toISOString().slice(0, 'YYYY-MM'.length);
  return require('../tunables').training().trendScreen.rollFlagGaps.some(g => monthOn(g) === front);
}

function sideOfTrend({ captures = [], days = {}, scorecard = [], first = [], sessions = null } = {}) {
  const legs = new Map();
  for (const doc of captures) for (const l of (isObj(doc) && Array.isArray(doc.legs) ? doc.legs : [])) legs.set(l.id, { day: l.day, captured: l.captured === true, availableR: num(l.availableR) });
  return { legs, dayR: dayR(days), blows: (scorecard || []).filter(d => d && d.blow === true).length, first: Array.isArray(first) ? first : [], sessions: Array.isArray(sessions) ? sessions : null };
}

function measureTrend(champion, probe) {
  // Only sessions both sides stepped to their end (an incomplete session is neither a miss nor a catch).
  const done = s => new Set((s.sessions || Object.keys(s.dayR).map(day => ({ day, complete: true }))).filter(x => x.complete).map(x => x.day));
  const a = done(champion);
  const b = done(probe);
  const ok = d => a.has(d) && b.has(d);
  const ids = [...champion.legs.keys()].filter(id => probe.legs.has(id) && ok(champion.legs.get(id).day));
  const sameDays = Object.keys(champion.dayR).filter(d => d in probe.dayR && ok(d));
  const dropped = s => (s.sessions || []).filter(x => !ok(x.day)).map(x => ({ day: x.day, why: x.complete ? 'the other side did not finish it' : x.why }));
  const onDays = list => (list || []).filter(p => ok(dayOfBar(p.bar)));
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
    firstTry: { paired: FT.pairFirstTries(onDays(champion.first), onDays(probe.first)), champion: FT.summarize(onDays(champion.first)), probe: FT.summarize(onDays(probe.first)) },
    // Per side: the batch legs its captures found, the legs paired, the sessions dropped and why, the roll-month ones.
    sides: {
      champion: { found: champion.legs.size, paired: ids.length, dropped: dropped(champion), rollMonth: (champion.sessions || []).filter(x => x.rollMonth).map(x => x.day) },
      probe: { found: probe.legs.size, paired: ids.length, dropped: dropped(probe), rollMonth: (probe.sessions || []).filter(x => x.rollMonth).map(x => x.day) },
    },
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

module.exports = { dayR, sessionsOf, rollMonth, sideOfTrend, measureTrend, trendHarms, regressionHarms, screenTrend, gained, harmful };
