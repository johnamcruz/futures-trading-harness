'use strict';

/**
 * The goal regression's fixture (tests/fixtures/goal/bars.json.gz, built by scripts/goal-fixture.js): a fixed, seeded
 * sample of real RTH sessions in blocks of consecutive sessions, each block's base bars with the warm-up the 4h and 1h
 * reads need before its first session (mtf.js HISTORY_HOURS: the runner's kept history), so the code reads every
 * traded bar as live would. Pure: the CLI reads the bars file (parse only, the data is untrusted) and writes the result.
 *
 * Config: config/training.json goalRegression (the seed, the split date between half A and half B, the blocks per half
 * and the sessions per block); the sessions are the open learning window's (config/schedule.json: from data.sessionsFrom
 * to the end of practice-train), never a sealed one.
 *
 * The golden catch-the-move days (config goalRegression.moveDays) are blocks of their own, half M: tier 2's move
 * scenarios (tests/goal/tier2.goal.js) read them, tier 1's halves never do.
 *
 * Trend days: a session with a trend leg of the PPC trend set (the leg census's detector, replay/trend-capture.js legsOf
 * on the curation session, filtered as the loop's trend probe filters: train/trend-align.js filterLegs, align htf (the 4h
 * and the 1h both the leg's way at its start) and the opening print dropped). Recorded per block, for the report only.
 *
 *   sessionDays(bars, { from, to, session, inSession })   the session dates with bars in the session window that the
 *                                                  runner trades (inSession(ms): setup-library.js runnerClock's, so an
 *                                                  exchange holiday's bars are no session), sorted
 *   trendDays(bars, { from, to, session, minutes }) Set of the trend days (above); trendLegsByDay: their legs by day
 *   labelsFor(sessions, legsByDay, tradesByDay)   { day: { kind: trend | non-trend, why } }: the fixture's labels
 *   moveBlocks(days, moveDays, maxGap)   the move days as blocks of their own (half M), near ones sharing a block
 *   pickBlocks(days, { trend, seed, split, perHalf, length, trendPerHalf })   [{ half, sessions, trend }]: per half,
 *                                                  `perHalf` blocks of `length` consecutive sessions, non-overlapping,
 *                                                  by a seeded draw (the order: a hash of the seed, the half and the
 *                                                  start date); with trendPerHalf, a block is taken only while the
 *                                                  half's trend days stay at most trendPerHalf and its other days at
 *                                                  most the rest, so a half holds exactly that mix (the owner's ask:
 *                                                  trend and non-trend days alike, not the pool's share)
 *   encodeBars(bars, tick, minutes), decodeBars(enc)   the compact form: [[step gap, open, high, low, close, volume]]
 *                                                  in ticks, each price from the one before (the close before for the
 *                                                  open), a gap in base bars; decode gives { t, o, h, l, c, v } bars
 *   blockBars(bars, sessions, { historyHours, minutes })   the bars from historyHours before the first session's Globex
 *                                                  open (18:00 ET the evening before) to its last session's close
 */

const crypto = require('crypto');
const { legsOf } = require('../replay/trend-capture');
const TA = require('../train/trend-align');
const { tradingDayKey, parseWindows, inWindow } = require('../trading/clock');

const msOfHours = hours => hours * 3600000;
const msOf = minutes => minutes * 60000;
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const inRange = (d, from, to) => d >= from && d < to;

function sessionDays(bars, { from, to, session, inSession = () => true }) {
  const days = new Set();
  const { windows } = parseWindows(session);
  for (const b of bars) {
    const at = new Date(Date.parse(b.t));
    if (windows.some(w => inWindow(at, w)) && inSession(at.getTime())) days.add(tradingDayKey(at));
  }
  return [...days].filter(d => inRange(d, from, to)).sort();
}

/** The PPC trend set's legs of [from, to), by day: Map day -> [{ side, start, end, points }]. */
function trendLegsByDay(bars, { from, to, session, minutes }) {
  const legs = legsOf(bars, { session }).filter(g => inRange(g.day, from, to));
  const spans = Object.fromEntries(legs.map(g => [`${g.day}|${g.side}|${g.start}`, g]));
  const got = TA.filterLegs(Object.keys(spans), spans, {
    align: 'htf', opening: 'drop', series: TA.htfSeries(bars, minutes), minutes, window: TA.openingWindow(),
    maxBars: require('../tunables').training().trendSet.openingMaxBars,
  });
  const out = new Map();
  for (const id of got.kept) { const g = spans[id]; out.set(g.day, [...(out.get(g.day) || []), { side: g.side, start: g.start, end: g.end, points: g.points }]); }
  return out;
}

function trendDays(bars, o) {
  return new Set(trendLegsByDay(bars, o).keys());
}

/**
 * Each session's label and why (the fixture's metadata): trend (a PPC trend-set leg: the census detector, the 4h and the
 * 1h its way at its start, not the opening print), else non-trend, with what the mechanical tier did that day on the
 * code that built it (no trade: the right answer is none; a loss at the stop: a fakeout). tradesByDay: Map day -> [trade].
 */
function labelsFor(sessions, legsByDay, tradesByDay = new Map()) {
  return Object.fromEntries(sessions.map(d => {
    const legs = legsByDay.get(d) || [];
    if (legs.length) return [d, { kind: 'trend', why: `PPC trend leg${legs.length > 1 ? 's' : ''} ${legs.map(g => `${g.side} ${new Date(g.start).toISOString().slice(11, 16)}-${new Date(g.end).toISOString().slice(11, 16)} UTC (${g.points} pts)`).join(', ')}, the 4h and 1h aligned` }];
    const ts = tradesByDay.get(d) || [];
    const first = ts[0];
    const what = !first ? 'no trade (the right answer is none)' : first.reason === 'stop' && first.R < 0 ? `a fakeout: the first entry stopped at ${first.R}R` : `first entry ${first.R}R (${first.reason})`;
    return [d, { kind: 'non-trend', why: `no 4h/1h-aligned trend leg; the mechanical tier: ${what}` }];
  }));
}

/** The move days as blocks: days within `maxGap` sessions of each other share one block (and its warm-up). */
function moveBlocks(days, moveDays, maxGap) {
  const out = [];
  for (const d of [...moveDays].sort()) {
    const last = out[out.length - 1];
    if (last && days.indexOf(d) - days.indexOf(last.sessions[last.sessions.length - 1]) <= maxGap) last.sessions.push(d);
    else out.push({ half: 'M', sessions: [d] });
  }
  return out;
}

function pickBlocks(days, { trend = new Set(), seed, split, perHalf, length, trendPerHalf = null }) {
  const out = [];
  const total = perHalf * length;
  const caps = trendPerHalf === null ? { trend: total, other: total } : { trend: trendPerHalf, other: total - trendPerHalf };
  for (const half of ['A', 'B']) {
    const pool = days.filter(d => (half === 'A' ? d < split : d >= split));
    const starts = pool.slice(0, Math.max(0, pool.length - length + 1)).map((d, i) => ({ d, i }))
      .sort((a, b) => hash(`${seed}|${half}|${a.d}`).localeCompare(hash(`${seed}|${half}|${b.d}`)));
    const used = new Set();
    const mine = [];
    const count = { trend: 0, other: 0 };
    for (const { i } of starts) {
      if (mine.length >= perHalf) break;
      const span = pool.slice(i, i + length);
      if (span.some((_d, k) => used.has(i + k))) continue;
      const t = span.filter(d => trend.has(d)).length;
      if (count.trend + t > caps.trend || count.other + (span.length - t) > caps.other) continue;
      span.forEach((_d, k) => used.add(i + k));
      count.trend += t;
      count.other += span.length - t;
      mine.push({ half, sessions: span, trend: span.filter(d => trend.has(d)) });
    }
    if (mine.length < perHalf) throw new Error(`half ${half}: only ${mine.length} of ${perHalf} blocks of ${length} sessions fit in ${pool.length} sessions${trendPerHalf === null ? '' : ` with ${trendPerHalf} trend days`}`);
    out.push(...mine.sort((a, b) => a.sessions[0].localeCompare(b.sessions[0])));
  }
  return out;
}

/** The Globex open (18:00 ET the evening before) of a session date, from its bars: the first bar of its trading day. */
function blockBars(bars, sessions, { historyHours, minutes }) {
  const first = sessions[0];
  const last = sessions[sessions.length - 1];
  const i0 = bars.findIndex(b => tradingDayKey(new Date(Date.parse(b.t))) >= first);
  if (i0 < 0) throw new Error(`no bars for ${first}`);
  const from = Date.parse(bars[i0].t) - msOfHours(historyHours);
  if (!(minutes > 0)) throw new Error('minutes: the base bars\' size');
  return bars.filter(b => { const ms = Date.parse(b.t); return ms >= from && tradingDayKey(new Date(ms)) <= last; });
}

function encodeBars(bars, tick, minutes) {
  const stepMs = msOf(minutes);
  const t = x => {
    const k = Math.round(x / tick);
    if (Math.abs(k * tick - x) > tick * 1e-6) throw new Error(`a price off the ${tick} tick: ${x}`);
    return k;
  };
  const rows = [];
  let prevMs = null;
  let prevC = null;
  for (const b of bars) {
    const ms = Date.parse(b.t);
    if (prevMs !== null && (ms - prevMs) % stepMs !== 0) throw new Error(`a bar off the ${minutes}m grid at ${b.t}`);
    const o = t(b.o);
    const row = [prevMs === null ? 0 : (ms - prevMs) / stepMs, prevC === null ? o : o - prevC, t(b.h) - o, t(b.l) - o, t(b.c) - o, Math.round(b.v)];
    rows.push(row);
    prevMs = ms;
    prevC = t(b.c);
  }
  return { t0: bars.length ? new Date(Date.parse(bars[0].t)).toISOString() : null, tick, minutes, rows };
}

function decodeBars(enc) {
  const stepMs = msOf(enc.minutes);
  const out = [];
  let ms = Date.parse(enc.t0);
  let prevC = null;
  for (const [gap, dO, dH, dL, dC, v] of enc.rows) {
    ms += gap * stepMs;
    const o = prevC === null ? dO : prevC + dO;
    out.push({ t: new Date(ms).toISOString(), o: o * enc.tick, h: (o + dH) * enc.tick, l: (o + dL) * enc.tick, c: (o + dC) * enc.tick, v });
    prevC = o + dC;
  }
  return out;
}

module.exports = { sessionDays, trendDays, trendLegsByDay, labelsFor, moveBlocks, pickBlocks, blockBars, encodeBars, decodeBars };
