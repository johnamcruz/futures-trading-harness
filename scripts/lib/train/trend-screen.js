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
 * The units: a trend run steps windows around its legs (trend-windows.js), so each unit is a window: a leg pairs only when
 * its window was stepped to its end on both sides (trend-windows.js windowStates), net R is per window (each round trip
 * to the window it followed; control windows, with no leg, carry the entries made where there was nothing to catch),
 * and first tries are the windows' bars'. The rules read the same with "window" for "session": the harms (net R per
 * window worse on at least minPairs windows, legs broken, first tries worse, a blow) and the gain (legs fixed, a fix only
 * when its window's net R got no worse). A run without windows pairs whole sessions:
 * only sessions both runs stepped to their end pair (sessionsOf: the day's end-of-day step ran). A session a run left
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
 *   sideOfTrend({ captures, days, scorecard, first, sessions, windows, minutes })   { legs: Map id -> { day, captured,
 *                                               availableR, unit }, dayR (per unit), blows, first, sessions } (sessions: sessionsOf,
 *                                               or windowStates with windows; none: no unit known finished, none pairs)
 *   finishedOf(side)                            { legs, units, netR, first }: one side's finished units alone (the learning curve)
 *   rideOfSide(side, rides)                     its finished units' trend catch & ride totals (replay/trend-ride.js), or null
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

function sideOfTrend({ captures = [], days = {}, scorecard = [], first = [], sessions = null, windows = null, minutes = null } = {}) {
  const TW = require('./trend-windows');
  // Stepped windows (trend-windows.js): each leg's unit is the window it was stepped in, net R per window, and only the
  // first tries on the windows' bars.
  const unitOfLeg = new Map((Array.isArray(windows) ? windows : []).flatMap(w => (w.legs || []).map(id => [id, w.id])));
  const legs = new Map();
  for (const doc of captures) for (const l of (isObj(doc) && Array.isArray(doc.legs) ? doc.legs : [])) legs.set(l.id, { day: l.day, captured: l.captured === true, availableR: num(l.availableR), ...(windows ? { unit: unitOfLeg.get(l.id) || null } : {}) });
  const tries = Array.isArray(first) ? first : [];
  return {
    legs, dayR: windows ? TW.unitR({ days, windows }) : dayR(days), blows: (scorecard || []).filter(d => d && d.blow === true).length,
    first: windows ? tries.map(p => ({ ...p, unit: TW.unitOfBar(windows, p.bar, minutes) })).filter(p => p.unit) : tries, sessions: Array.isArray(sessions) ? sessions : null,
  };
}

/** A leg's, a state's or a first try's unit: its window (a stepped-windows run) or its session date. */
const unitOf = x => (x.unit !== undefined ? x.unit : x.day);

function measureTrend(champion, probe) {
  // Only units (sessions, or a windowed run's windows) both sides stepped to their end (an incomplete one is neither a
  // miss nor a catch). No state: none known finished (fail closed), so nothing pairs.
  const done = s => new Set((Array.isArray(s.sessions) ? s.sessions : []).filter(x => x && x.complete).map(unitOf));
  const a = done(champion);
  const b = done(probe);
  const ok = d => d !== null && a.has(d) && b.has(d);
  const ids = [...champion.legs.keys()].filter(id => probe.legs.has(id) && ok(unitOf(champion.legs.get(id))));
  const sameDays = Object.keys(champion.dayR).filter(d => d in probe.dayR && ok(d));
  // No session state at all: nothing paired from that side, and the report says why (never an empty, silent list).
  const dropped = s => (Array.isArray(s.sessions) ? s.sessions.filter(x => !ok(unitOf(x))).map(x => ({ day: unitOf(x), why: x.complete ? 'the other side did not finish it' : x.why })) : [{ day: null, why: 'the step reported no session state' }]);
  const onDays = list => (list || []).filter(p => ok(p.unit !== undefined ? p.unit : dayOfBar(p.bar)));
  const worseDay = d => (probe.dayR[d] ?? 0) < (champion.dayR[d] ?? 0);
  // A leg caught only by the edit is fixed only when its unit's net R got no worse.
  const pairs = ids.map(id => {
    const a = champion.legs.get(id);
    const b = probe.legs.get(id);
    return { base: { category: a.captured ? 'right' : 'missed' }, cand: { category: b.captured && !(worseDay(unitOf(a)) && !a.captured) ? 'right' : 'missed' } };
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

/**
 * One side's finished units alone (the learning curve's champion: the screens' own guard, one side): its legs whose unit
 * it stepped to its end, those units, and their mean net R.
 */
function finishedOf(side) {
  const done = new Set((Array.isArray(side.sessions) ? side.sessions : []).filter(x => x && x.complete).map(unitOf));
  const legs = [...side.legs.values()].filter(l => done.has(unitOf(l)));
  const units = Object.keys(side.dayR || {}).filter(u => done.has(u));
  const netR = units.length ? Math.round((units.reduce((s, u) => s + side.dayR[u], 0) / units.length) * 10000) / 10000 : null;
  const first = (side.first || []).filter(p => done.has(p.unit !== undefined ? p.unit : dayOfBar(p.bar)));
  return { legs, units, netR, first };
}

/**
 * One side's trend catch & ride (replay/trend-ride.js summarize) on its finished units only (finishedOf's guard): rides
 * [{ ride: trend-ride.js compact(capture), windows }], one per run; only the side's own legs (side.legs: the half's), and
 * each filled entry to the window it was placed in (trend-windows.js unitOfRecord; a run without windows: its session
 * date). null without rides, or when a run's ride is unknown (an earlier phase that kept none): never a partial total.
 */
function rideOfSide(side, rides) {
  const list = Array.isArray(rides) ? rides : [];
  if (!side || !list.length || list.some(x => !isObj(x) || !isObj(x.ride))) return null;
  const TW = require('./trend-windows');
  const { tradingDayKey } = require('../trading/clock');
  const done = new Set((Array.isArray(side.sessions) ? side.sessions : []).filter(x => x && x.complete).map(unitOf));
  const legs = [];
  const entries = [];
  for (const { ride, windows } of list) {
    legs.push(...(ride.legs || []).filter(l => side.legs.has(l.id) && done.has(unitOf(side.legs.get(l.id)))));
    const unit = e => (Array.isArray(windows) && windows.length ? TW.unitOfRecord(windows, e.at) : tradingDayKey(new Date(e.at)));
    entries.push(...(ride.entries || []).filter(e => done.has(unit(e))));
  }
  return require('../replay/trend-ride').summarize({ legs, entries });
}

const harmful = t => t && t.n >= SCREEN.minDiscordant && t.c > t.b && t.pWorse <= SCREEN.harmAlpha;
const gained = t => t && t.n >= SCREEN.minDiscordant && t.b > t.c && t.pBetter <= SCREEN.gainAlpha && t.pairs > 0 && (t.b - t.c) / t.pairs >= SCREEN.minEffect;

function trendHarms(m, { rule } = {}) {
  const out = [];
  const ft = m.firstTry ? FT.firstTryHarm(m.firstTry.paired, rule) : null;
  if (ft) out.push(`trend set: ${ft}`);
  if (m.blows > 0) out.push(`trend set: ${m.blows} blow(s) on the probe's side`);
  if (harmful(m.capture)) out.push(`trend set: legs caught worse (broken ${m.capture.c}, fixed ${m.capture.b}, p ${m.capture.pWorse})`);
  if (m.netR.pairs >= SCREEN.minPairs && m.netR.hi !== null && m.netR.hi < 0) out.push(`trend set: net R per window worse (${m.netR.diff} [${m.netR.lo}, ${m.netR.hi}])`);
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

module.exports = { dayR, sessionsOf, rollMonth, sideOfTrend, finishedOf, rideOfSide, measureTrend, trendHarms, regressionHarms, screenTrend, gained, harmful };
