'use strict';

/**
 * The day so far: how the RTH morning has behaved from 09:30 ET up to the last closed bar, said plainly from its own
 * bars, and an RTH volatility that compares like with like. A DESCRIPTION of the morning so far, never a forecast of
 * the rest of it (measured on 56 recorded days, 2021 and 2024: the read matched the 09:30-12:00 day, AUC 0.76 at 09:45
 * to 1.00 at 11:15, yet read the rest of the morning no better than a coin flip, AUC 0.39-0.58; a review's 736 NQ days
 * out of sample: 0.56, 0.48, 0.52, 0.48), and never an input to a decision: nothing in the gate, compose_check,
 * order_plan, the trend rule or sizing reads it. The briefing shows it (the summary's Day so far line).
 *
 *   efficiency  |last close - the 09:30 bar's open| / the RTH bars' summed range (1 = one straight line, 0 = back where
 *               it began)
 *   score       efficiency x sqrt(bars): efficiency alone falls as bars add up (a random walk's net move grows with
 *               sqrt(bars), its summed range with bars), so the read's bands sit on the score, one scale all morning
 *   read        'directional' (score at least config daySoFar.directional), 'rotational' (under daySoFar.rotational),
 *               else 'mixed', decided on the score as shown (2 decimals); with the net move's direction (up, down,
 *               flat). Cumulative since 09:30, no recency: a 30-minute trend then two hours of range still reads
 *               directional (the candles and the Trend declared? line carry the recent bars)
 *   vwapCrosses closes crossing the RTH VWAP since 09:30 (regime.js vwapCrosses, on the RTH VWAP)
 *   rangeAtr    the RTH range so far in ATR(14) of the bars; rangeVsAdr: in the average daily range (the day context's
 *               ADR, as `today.rangeVsAdr`); netAtr: (last close - the RTH open) / ATR, the Trend declared? line's
 *               day's move (the line points there for its size)
 *
 * Too early: under config daySoFar.minBars RTH bars (a floor from review, not tuned to a score: at 5 bars a random walk
 * can read directional, and the early words mostly change by 11:15), the bars and the crosses only, never a read. Unknown (with why): no 09:30 bar in the data (or no bar before it), or bars without range.
 *
 * The RTH volatility: the mean bar range of today's last daySoFar.volMinutes of RTH (the bars since 09:30 when fewer)
 * against the median, over the prior sessions holding a bar at every one of those minutes (the most recent
 * daySoFar.volSessions; fewer than daySoFar.volMinSessions: unknown), of the same minutes' mean range. The same
 * minutes on prior days, so the open's wide bars meet the open's: the regime's word (ATR(14) against its own last 100
 * bars, mostly overnight ones early in RTH) reads "high" on most mornings and says little then. That word stays as it
 * is (strategies and the experience index read it); this one is shown beside it under its own name.
 *
 *   daySoFar(bars, { atr, adr })        null outside RTH | { status: 'read' | 'too early' | 'unknown', ... }
 *   readOf(score)                                  the band's word
 *   daySoFarLine(d, { tf, dayType })               the summary's line, or null
 *   windowMeans(bars, { minutes })                 null outside RTH | { todayMean, priorMeans, windowMinutes }
 *   rthVolatility(bars, { minutes })               null outside RTH | volatilityRead's, with windowMinutes
 *   volatilityRead(todayMean, priorMeans)          { status: 'read', ratio, word, sessions } | { status: 'unknown', reason, sessions }
 *   volatilityText(v, tf)                          the alignment line's suffix ('' for none)
 */

const ind = require('./indicators');
const { vwapCrosses } = require('./regime');
const { RTH_OPEN_MIN, RTH_CLOSE_MIN } = require('./clock'); // the session boundaries' one home

const A = require('../tunables').analysis();
const CFG = A.daySoFar; // config/analysis.json daySoFar

const finite = x => typeof x === 'number' && Number.isFinite(x);
const round2 = x => (finite(x) ? Math.round(x * 100) / 100 : null);
const inRth = minute => minute >= RTH_OPEN_MIN && minute < RTH_CLOSE_MIN;

/** Today's RTH bars up to the last: { from, day, minute } (from: the first index), or null when the last bar isn't RTH. */
function todayOf(bars) {
  const n = bars.length;
  if (!n) return null;
  const last = ind.etInfo(bars[n - 1].t);
  if (!inRth(last.minute)) return null;
  let from = n - 1;
  while (from > 0) {
    const e = ind.etInfo(bars[from - 1].t);
    if (e.day !== last.day || !inRth(e.minute)) break;
    from -= 1;
  }
  return { from, day: last.day, minute: last.minute, first: ind.etInfo(bars[from].t).minute };
}

/** The read's word for a score (efficiency x sqrt(bars)). */
function readOf(score) {
  return score >= CFG.directional ? 'directional' : score < CFG.rotational ? 'rotational' : 'mixed';
}

function daySoFar(bars, { atr = null, adr = null } = {}) {
  const today = todayOf(bars || []);
  if (!today) return null;
  const { from } = today;
  // The 09:30 bar with a bar before it (the RTH VWAP of a session already under way at the data's start is unknown).
  if (today.first !== RTH_OPEN_MIN) return { status: 'unknown', reason: 'no 09:30 ET bar in the data' };
  if (from === 0) return { status: 'unknown', reason: 'the data starts at 09:30 ET (no RTH VWAP yet)' };
  const rth = bars.slice(from);
  const n = rth.length;
  const crosses = vwapCrosses(bars, ind.anchoredVwap(bars, RTH_OPEN_MIN, RTH_CLOSE_MIN), from);
  if (n < CFG.minBars) return { status: 'too early', bars: n, vwapCrosses: crosses, readFrom: CFG.minBars };
  let sum = 0; let hi = -Infinity; let lo = Infinity;
  for (const b of rth) { sum += b.h - b.l; hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); }
  if (!(sum > 0)) return { status: 'unknown', reason: 'the RTH bars have no range' };
  const net = rth[n - 1].c - rth[0].o;
  const efficiency = Math.abs(net) / sum;
  // The word from the score as the line prints it (0.3351 prints 0.34: mixed, as the bands say).
  const score = round2(efficiency * Math.sqrt(n));
  const per = x => (finite(x) && x > 0 ? (v => round2(v / x)) : () => null);
  return {
    status: 'read', bars: n, read: readOf(score), direction: net > 0 ? 'up' : net < 0 ? 'down' : 'flat',
    efficiency: round2(efficiency), score, vwapCrosses: crosses,
    rangeAtr: per(atr)(hi - lo), rangeVsAdr: per(adr)(hi - lo), netAtr: per(atr)(net),
  };
}

/** The summary's Day so far line (tf: the bars' timeframe; dayType: the day context's, pointed to once it exists). */
function daySoFarLine(d, { tf = '3m', dayType = null } = {}) {
  if (!d) return null;
  if (d.status === 'unknown') return `- Day so far: unknown (${d.reason}).`;
  // No clock time (the owner: a time only when it adds value): the RTH bars counted, the rest in `day-context`.
  const head = `- Day so far (${d.bars} ${tf} bars; \`day-context\`)`;
  if (d.status === 'too early') return `${head}: too early (a read from ${d.readFrom} bars), RTH VWAP crosses ${d.vwapCrosses}.`;
  const word = d.read === 'rotational' ? d.read : `${d.read} ${d.direction}`;
  // Its range in ADR is today.rangeVsAdr in the detail: not said twice.
  const range = `range ${d.rangeAtr ?? '?'} x ${tf} ATR(14)`;
  return `${head}: ${word}: efficiency ${d.efficiency} (x sqrt(bars) ${d.score}), RTH VWAP crosses ${d.vwapCrosses}, ${range}, net ${d.direction} (its size: Trend declared? day's move)${dayType ? '; IB day type: today.dayType' : ''}.`;
}

function volatilityRead(todayMean, priorMeans) {
  const prior = (priorMeans || []).filter(x => finite(x) && x > 0);
  const sessions = prior.length;
  if (sessions < CFG.volMinSessions) return { status: 'unknown', reason: `${sessions} prior session${sessions === 1 ? '' : 's'} with these minutes; needs ${CFG.volMinSessions}`, sessions };
  if (!finite(todayMean)) return { status: 'unknown', reason: 'no range today', sessions };
  const s = [...prior].sort((a, b) => a - b);
  const median = sessions % 2 ? s[(sessions - 1) / 2] : (s[sessions / 2 - 1] + s[sessions / 2]) / 2;
  const ratio = round2(todayMean / median);
  return { status: 'read', ratio, word: ratio >= CFG.volHigh ? 'high' : ratio <= CFG.volLow ? 'low' : 'normal', sessions };
}

/**
 * The RTH volatility's inputs: today's mean bar range over its window, each prior session's mean at the same minutes
 * (most recent first, at most daySoFar.volSessions), and the window's minutes; null outside RTH.
 */
function windowMeans(bars, { minutes } = {}) {
  const today = todayOf(bars || []);
  if (!today) return null;
  const end = today.minute + minutes;
  const start = Math.max(RTH_OPEN_MIN, end - CFG.volMinutes);
  const slots = new Map(); // minute -> today's range
  for (let i = today.from; i < bars.length; i += 1) {
    const m = ind.etInfo(bars[i].t).minute;
    if (m >= start) slots.set(m, bars[i].h - bars[i].l);
  }
  const mean = xs => xs.reduce((a, x) => a + x, 0) / xs.length;
  // Each prior session (most recent first): its range at each of today's minutes; a session missing one is left out.
  const prior = [];
  let day = null; let got = null;
  const close = () => { if (got && got.size === slots.size) prior.push(mean([...got.values()])); };
  for (let i = today.from - 1; i >= 0 && prior.length < CFG.volSessions; i -= 1) {
    const e = ind.etInfo(bars[i].t);
    if (!inRth(e.minute)) continue;
    if (e.day !== day) { close(); day = e.day; got = new Map(); }
    if (slots.has(e.minute)) got.set(e.minute, bars[i].h - bars[i].l);
  }
  if (prior.length < CFG.volSessions) close();
  return { todayMean: slots.size ? mean([...slots.values()]) : NaN, priorMeans: prior.slice(0, CFG.volSessions), windowMinutes: end - start };
}

function rthVolatility(bars, { minutes } = {}) {
  const w = windowMeans(bars, { minutes });
  return w ? { ...volatilityRead(w.todayMean, w.priorMeans), windowMinutes: w.windowMinutes } : null;
}

/** The alignment line's suffix: the RTH volatility, with its baseline (' RTH volatility: ...'), '' without one. */
function volatilityText(v, tf = '3m') {
  if (!v) return '';
  if (v.status !== 'read') return ` RTH volatility: unknown (${v.reason}).`;
  return ` RTH volatility: ${v.word} (the last ${v.windowMinutes} min's ${tf} bar range ${v.ratio}x the same minutes' median on ${v.sessions} prior sessions).`;
}

/** The read's word as a day class (the head trader's STATE day words; the read audit's day label): one word each. */
const DAY_CLASS = Object.freeze({ directional: 'trend', rotational: 'chop', mixed: 'mixed', 'too early': 'early' });

module.exports = { DAY_CLASS, daySoFar, readOf, daySoFarLine, windowMeans, rthVolatility, volatilityRead, volatilityText };
