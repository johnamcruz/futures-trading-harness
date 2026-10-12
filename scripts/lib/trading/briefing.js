'use strict';

/**
 * The bar briefing: the analysis of one symbol's closed bars, by timeframe,
 * computed once and reused until it expires. The runner builds it after every
 * closed bar from the bars it hands the cycle; every role reads it (the
 * `bar_briefing` harness tool) instead of fetching and computing the same
 * numbers again.
 *
 * Each section holds what changes on its own clock, and is kept until then:
 *
 *   m3     the trigger bar and everything that moves with it: price, ET time
 *          and session window, regime, EMAs, ADX, Keltner, VWAP side (RTH
 *          VWAP in RTH, else the session's), participation, 3m swings and
 *          liquidity, today so far (open, gap, opening type, opening range,
 *          IB, day type), the overnight range so far, the developing session
 *          profile, the latest BOS or CHoCH, sweeps of the key levels in the
 *          last 10 bars, the 1h swings not traded back to, the nearest
 *          liquidity above and below in points and ATR (room to run), where price is against the value areas, IB and prior RTH
 *          range, the scan's candidates, the trend rule  until the next base-bar close
 *   m15    the 15m read (trend, structure, swings, the latest BOS or CHoCH), the alignment per side,
 *          and the 15m candles' indicators (regime, EMAs, ADX and its slope,
 *          SuperTrend, Keltner, ATR), all from completed 15m candles
 *                                                         until the next 15m close
 *   h1     the 1h and 4h reads, the 1h's latest BOS or CHoCH   until the next 1h close
 *   day    the prior RTH day and its volume profile      until the first bar after the 16:00 ET RTH close
 *
 * A value lives in the section whose clock it changes on: anything that
 * moves bar by bar (a running high, a developing profile) is in m3.
 *
 * Sections change only on expiry: m15 and h1 read completed candles only, so nothing in them changes before
 * their next close. What moves with price against them (a 3m close through a 15m or 1h swing, the room to the
 * nearest levels) is in m3. Distances are in points and R: 1R is a setup's own stop, else the reference stop
 * (0.5 x ATR(20)).
 *
 * Each section carries a version that changes only when it is recomputed, so
 * whatever was built on it (an analyst's report) stays valid while the
 * versions it used are unchanged.
 *
 *   buildBriefing({ symbol, bars, minutes, prev, scan, scanError, now })   the briefing (prev: the last one, reused where valid)
 *   current(b, now)                                              whether it is this bar's (its m3 still holds at now)
 *   renderBriefing(b, { now })                                   one text block per section, with validity
 *   briefingFile(home, root) / writeBriefing / readBriefing      <FTH_HOME>/briefing/<MICRO ROOT>.json
 *   nextClose(at, minutes)                                       when the candle containing `at` closes
 *   sessionWindow(at)                                            { name, until } (the session-timing skill's windows)
 */

const fs = require('fs');
const path = require('path');
const { snapshot } = require('./market-snapshot');
const { mtfRead, candles } = require('./mtf');
const { normalizeBars } = require('./indicators');
const { tradingDayStart, minutesOfDay } = require('./clock');
const { familyRoot } = require('./contracts');
const { pivots, lastBreaks, sweeps, untestedSwings, swingLevels } = require('./structure-events');

const SECTIONS = ['m3', 'm15', 'h1', 'day'];
const ET = 'America/New_York';

// The session-timing skill's windows (ET minutes of the day, from 00:00).
const WINDOWS = [
  [-360, 180, 'asia'], [180, 570, 'london'], [570, 575, 'opening print (no entries)'], [575, 660, 'opening drive'],
  [660, 690, 'late morning'], [690, 810, 'lunch lull'], [810, 945, 'afternoon'], [945, 960, 'into the close (no entries)'],
  [960, 1080, 'daily break (closed)'], [1080, 1620, 'asia'],
];

/** When the `minutes` candle containing `at` closes (candles from the trading day's 18:00 ET open). */
function nextClose(at, minutes) {
  const start = tradingDayStart(at).getTime();
  const step = minutes * 60000;
  return new Date(start + (Math.floor((at.getTime() - start) / step) + 1) * step);
}

function sessionWindow(at) {
  const m = minutesOfDay(at, ET);
  // Asia runs 18:00-03:00 across midnight: before 03:00 it is the window that started at 18:00 the evening before.
  const [, end, name] = WINDOWS.find(([a, b]) => m >= a && m < b && !(a < 0 && m >= 1080));
  return { name, until: new Date(at.getTime() + (end - m) * 60000 - (at.getUTCSeconds() * 1000 + at.getUTCMilliseconds())) };
}

/**
 * When the prior RTH day next changes: the first bar that opens at or after 16:00 ET completes today's RTH day, so a
 * section computed on the bar opening at `barOpen` holds until that bar closes (the next 16:00 ET after the bar's
 * open, strictly, plus one bar).
 */
function nextRthRoll(barOpen, minutes) {
  const m = minutesOfDay(barOpen, ET);
  const ahead = (960 - m + 1440) % 1440 || 1440;
  return new Date(barOpen.getTime() + (ahead + minutes) * 60000 - (barOpen.getUTCSeconds() * 1000 + barOpen.getUTCMilliseconds()));
}

const etClock = at => new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
const round2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const frameOf = (read, minutes) => (read.frames.find(f => f.minutes === minutes) || {}).read || null;
// A higher-timeframe read (mtf.js): its EMAs are EMA20 and EMA50 (named so: the 3m and 15m indicators are EMA9/EMA20),
// its swing pattern, and its dealing range with the 50%. Swing levels against price are in m3 (they move with price).
const brief = f => (f ? {
  trend: f.trend, bias: f.bias, swingPattern: f.votes && f.votes.structure, close: f.close, ema20: f.emaFast, ema50: f.emaSlow, adx: f.adx, atr: f.atr,
  range: f.levels && Number.isFinite(f.levels.rangeHigh) ? { high: f.levels.rangeHigh, low: f.levels.rangeLow, mid: round2((f.levels.rangeHigh + f.levels.rangeLow) / 2) } : null,
  ...(f.note ? { note: f.note } : {}),
} : null);
/** A higher timeframe's break with its time as the candle's close (when the break was known), not its open. */
const atClose = (lb, mins) => {
  const shift = x => (x ? { ...x, at: new Date(Date.parse(x.at) + mins * 60000).toISOString(), swingAt: new Date(Date.parse(x.swingAt) + mins * 60000).toISOString() } : null);
  return { last: shift(lb.last), previous: shift(lb.previous) };
};
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const EQUAL_K = 2; // the snapshot's swing confirmation (bars after the pivot)

/** Each section's data and expiry, from this bar's snapshot and read. */
function computeSections({ bars, c15, c60, snap, snap15, read, read15, readH1, scan, scanError, minutes, closedAt, blackouts }) {
  const t = snap.trend || {};
  const vp = snap.volumeProfile || {};
  const lv = snap.levels || {};
  const day = snap.day || {};
  const price = snap.last.c;
  const win = sessionWindow(closedAt);
  const f15 = frameOf(read15, 15);
  const f60 = frameOf(readH1, 60);
  const prior = vp.priorRth || {};
  const sess = vp.session || {};
  const liq = snap.liquidity || {};
  const st = snap.structure || {};
  // The VWAP that applies: the RTH VWAP from 09:30 to 16:00 ET, else the session's (18:00 ET), as the strategy filters use.
  const applies = (snap.vwap || {}).applies || null;
  const vwapRef = applies === 'rth' ? lv.vwapRth : lv.vwapSession;
  const t15 = (snap15 && snap15.trend) || {};
  // 1R without a setup: the reference stop, 0.5 x ATR(20), the stop the strategies are built on (a setup's own stop is its 1R).
  const oneR = (snap.referenceStop || {}).distance;
  const step = minutes * 60000;
  const after = (iso, k = EQUAL_K) => new Date(Date.parse(iso) + k * step).toISOString();
  // A 1h swing counts as tested only by bars after its hour closed (the bars inside it made it).
  const swings1h = pivots(c60);
  const untested1h = untestedSwings(bars, [...swings1h.filter(x => x.type === 'high').slice(-4), ...swings1h.filter(x => x.type === 'low').slice(-4)]
    .map(x => ({ ...x, end: new Date(Date.parse(x.t) + 3600000).toISOString() })));
  // The 15m and 1h swings, and whether a 3m close has gone through each since its candle closed (per bar).
  const htf = (cs, mins, label) => swingLevels(cs, 2, 3).map(x => {
    const end = Date.parse(x.t) + mins * 60000;
    const b = bars.find(y => Date.parse(y.t) >= end && (x.type === 'high' ? y.c > x.price : y.c < x.price));
    return { name: `${label} swing ${x.type}`, type: x.type, price: x.price, side: side(x.price, price), brokenAt: b ? b.t : null };
  });
  // Per timeframe: the swings still holding, and the latest one a 3m close went through (with when).
  const holdAndLastBreak = list => {
    const broken = list.filter(x => x.brokenAt).sort((x, y) => Date.parse(y.brokenAt) - Date.parse(x.brokenAt))[0];
    return [...list.filter(x => !x.brokenAt), ...(broken ? [broken] : [])];
  };
  const htfLevels = [...holdAndLastBreak(htf(c15, 15, '15m')), ...holdAndLastBreak(htf(c60, 60, '1h'))];
  // Equal highs (lows) still untaken: no bar since their last touch traded above (below) them.
  const pool = (list, type) => (list || []).map(x => {
    const level = type === 'high' ? Math.max(...x.prices) : Math.min(...x.prices);
    const times = x.at.map(Date.parse).sort((a, b) => a - b);
    const since = after(new Date(times[times.length - 1]).toISOString());
    const beyond = b => (type === 'high' ? b.h > level : b.l < level);
    // Taken: traded beyond after the last touch, or between the touches (outside the touches' own swing bars).
    const between = b => { const t = Date.parse(b.t); return t > times[0] + EQUAL_K * step && t < times[times.length - 1] - EQUAL_K * step; };
    const taken = bars.some(b => (Date.parse(b.t) > Date.parse(since) || between(b)) && beyond(b));
    return { name: type === 'high' ? 'equal highs' : 'equal lows', price: level, since, taken };
  });
  const eqHighs = pool(liq.equalHighs, 'high');
  const eqLows = pool(liq.equalLows, 'low');
  const rth = applies === 'rth';
  const round100 = [Math.ceil(price / 100) * 100, Math.floor(price / 100) * 100].filter(x => x !== price);
  const levels = [
    ['day high', rth ? day.high : null], ['day low', rth ? day.low : null], ['IB high', day.ibHigh], ['IB low', day.ibLow],
    ['opening range high', (lv.openingRange || {}).high], ['opening range low', (lv.openingRange || {}).low],
    ['session high', ((snap.context || {}).session || {}).high], ['session low', ((snap.context || {}).session || {}).low],
    [`VWAP (${applies || 'session'})`, vwapRef],
    ['prior RTH high', (lv.priorRth || {}).high], ['prior RTH low', (lv.priorRth || {}).low], ['prior RTH close', (lv.priorRth || {}).close],
    ['overnight high', (lv.overnight || {}).high], ['overnight low', (lv.overnight || {}).low],
    ['prior VAH', prior.vah], ['prior VAL', prior.val], ['prior POC', prior.poc],
    ['session VAH', sess.vah], ['session VAL', sess.val], ['session POC', sess.poc],
    ['last 3m swing high', st.lastSwingHigh], ['last 3m swing low', st.lastSwingLow],
    ...htfLevels.filter(x => !x.brokenAt).map(x => [x.name, x.price]),
    ...untested1h.map(x => [`untested 1h swing ${x.type}`, x.price]),
    ...[...eqHighs, ...eqLows].filter(x => !x.taken).map(x => [x.name, x.price]),
    ...round100.map(x => ['round number', x]),
  ];
  const room = nearest(price, oneR, levels);
  const news = newsState(blackouts, closedAt);
  const noEntry = /\(no entries\)|closed/.test(win.name);
  const bar = snap.last;
  const atr14 = (snap.volatility || {}).atr14;
  return {
    m3: {
      validUntil: new Date(closedAt.getTime() + step),
      data: {
        price, bar: { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, rangeAtr: atr14 > 0 ? round2((bar.h - bar.l) / atr14) : null },
        et: etClock(closedAt), window: win.name, windowUntil: win.until.toISOString(),
        // R: every distance below is in points and R; 1R here is the reference stop (a setup's own stop is its 1R).
        oneR: Number.isFinite(oneR) ? { points: round2(oneR), basis: '0.5 x ATR(20), the reference stop' } : null,
        news,
        regime: snap.regime ? { primary: snap.regime.primary, volatility: snap.regime.volatility, tags: snap.regime.tags, metrics: snap.regime.metrics } : null,
        trend: { ema9: round2(t.emaFast), ema20: round2(t.emaSlow), ema50: round2(t.ema50), ema200: round2(t.ema200), adx: t.adx, adxSlope: t.adxSlope, supertrend: t.supertrend ? { direction: t.supertrend.direction, line: round2(t.supertrend.line) } : null, keltner: t.keltner ? { upper: round2(t.keltner.upper), mid: round2(t.keltner.mid), lower: round2(t.keltner.lower) } : null },
        priceVsEma9: side(price, t.emaFast),
        atr14: round2(atr14),
        vwap: { applies, session: round2(lv.vwapSession), rth: round2(lv.vwapRth), side: side(price, vwapRef), distanceAtr: (snap.vwap || {}).distanceAtr, crossesLast30: applies === 'rth' ? (snap.vwap || {}).rthCrossesLast30 : (snap.vwap || {}).sessionCrossesLast30 },
        participation: snap.participation ? omit(snap.participation, ['note']) : null,
        // The counters the strategies' skip rules name (EMA crosses, ADX falling, Keltner squeeze and band-close streak,
        // SuperTrend flips, the last 5 bars' range in ATR).
        context: snap.context ? omit(snap.context, ['flow', 'session']) : null,
        referenceStop: snap.referenceStop ? { distance: round2(snap.referenceStop.distance), long: round2(snap.referenceStop.long), short: round2(snap.referenceStop.short) } : null,
        swings: { high: st.lastSwingHigh, highAt: st.lastSwingHighAt, low: st.lastSwingLow, lowAt: st.lastSwingLowAt },
        // Liquidity on the trigger bars: recent swing points, equal highs and lows (with whether taken), open fair value gaps.
        liquidity: { swingHighs: liq.swingHighs, swingLows: liq.swingLows, equalHighs: eqHighs.map(x => omit(x, ['since'])), equalLows: eqLows.map(x => omit(x, ['since'])), openFvgs: liq.openFvgs },
        // Structure events (structure-events.js): the latest break on the trigger bars, sweeps of key liquidity in the last
        // 10 bars (only levels that existed before the sweep), the 1h swings not traded back to, and the 15m and 1h swings
        // against price (a 3m close through one since its candle closed: brokenAt).
        lastBreak: lastBreaks(bars),
        sweeps: sweeps(bars, [
          ['prior RTH high', (lv.priorRth || {}).high, 'high', true], ['prior RTH low', (lv.priorRth || {}).low, 'low', true],
          // The overnight range is final at 09:30 ET: its sweeps count in RTH only.
          ...(rth ? [['overnight high', (lv.overnight || {}).high, 'high', true], ['overnight low', (lv.overnight || {}).low, 'low', true]] : []),
          ['last 3m swing high', st.lastSwingHigh, 'high', false, st.lastSwingHighAt ? after(st.lastSwingHighAt) : null],
          ['last 3m swing low', st.lastSwingLow, 'low', false, st.lastSwingLowAt ? after(st.lastSwingLowAt) : null],
          ...eqHighs.map(x => [x.name, x.price, 'high', false, x.since]), ...eqLows.map(x => [x.name, x.price, 'low', false, x.since]),
        ].map(([name, p, sideOf, key = false, since = null]) => ({ name, price: p, side: sideOf, key, since })), 10),
        htfLevels,
        untested1hSwings: untested1h,
        // The room to run: the three nearest levels above and below price, in points and R.
        nearestLiquidity: room,
        // Today so far and the developing levels: they move bar by bar.
        today: { open: day.open, gap: day.gap, openVs: day.openVs, openType: day.openType, openingRange: lv.openingRange || null, high: day.high, low: day.low, range: day.range, ibHigh: day.ibHigh, ibLow: day.ibLow, ibRange: day.ibRange, extUp: day.extUp, extDown: day.extDown, dayType: day.dayType, rangeVsAdr: day.adr ? round2(day.range / day.adr) : null },
        overnight: lv.overnight || null,
        sessionProfile: sess.poc ? { poc: round2(sess.poc), vah: round2(sess.vah), val: round2(sess.val), hvnAbove: sess.hvnAbove, hvnBelow: sess.hvnBelow, lvnAbove: sess.lvnAbove, lvnBelow: sess.lvnBelow } : null,
        priorProfileNodes: prior.poc ? { hvnAbove: prior.hvnAbove, hvnBelow: prior.hvnBelow, lvnAbove: prior.lvnAbove, lvnBelow: prior.lvnBelow } : null,
        // Where price is against the levels.
        location: {
          priorValue: where(price, prior.val, prior.vah), sessionValue: sess.poc ? where(price, sess.val, sess.vah) : null,
          initialBalance: where(price, day.ibLow, day.ibHigh), priorRthRange: lv.priorRth ? where(price, lv.priorRth.low, lv.priorRth.high) : null,
        },
        // The scan's candidates, each with its stop (its 1R), its exit, and the first level in its way in points and R.
        // null: the scan failed or the bar wasn't scanned, so what fired is unknown (not "nothing fired").
        candidates: scan ? scan.filter(r => r.candidate && r.direction).map(r => candidate(r, price, levels, { noEntry, newsBlocked: Boolean(news.inBlackout), lunch: /lunch/.test(win.name), alignment: read15.alignment, vwapSide: side(price, vwapRef) })) : null,
        ...(scan ? {} : { scanError: scanError || 'the scan failed this bar' }),
        trendRule: read.lines[read.lines.length - 1],
      },
    },
    m15: {
      validUntil: nextClose(closedAt, 15),
      data: {
        frame: brief(f15),
        alignment: read15.alignment,
        lastBreak: atClose(lastBreaks(c15), 15),
        // The 15m candles' own indicators (completed candles only): EMA9 and EMA20, as on the trigger bars.
        indicators: snap15 ? {
          regime: snap15.regime && { primary: snap15.regime.primary, volatility: snap15.regime.volatility },
          ema9: round2(t15.emaFast), ema20: round2(t15.emaSlow), adx: t15.adx, adxSlope: t15.adxSlope,
          supertrend: t15.supertrend ? { direction: t15.supertrend.direction, line: round2(t15.supertrend.line) } : null,
          keltner: t15.keltner ? { upper: round2(t15.keltner.upper), mid: round2(t15.keltner.mid), lower: round2(t15.keltner.lower) } : null,
          atr14: round2((snap15.volatility || {}).atr14),
        } : null,
      },
    },
    h1: {
      validUntil: nextClose(closedAt, 60),
      data: { h1: brief(f60), h4: brief(frameOf(readH1, 240)), lastBreak: atClose(lastBreaks(c60), 60) },
    },
    day: {
      // The prior RTH day changes at the RTH close (16:00 ET).
      validUntil: nextRthRoll(new Date(closedAt.getTime() - step), minutes),
      data: {
        priorRth: lv.priorRth || null,
        priorProfile: prior.poc ? { poc: round2(prior.poc), vah: round2(prior.vah), val: round2(prior.val), hvn: prior.hvn, lvn: prior.lvn } : null,
      },
    },
  };
}

/**
 * A scan candidate with its 1R (its stop), its exit, the first level in its way in points and R, and its grade:
 *
 *   A  the trend rule allows its side, the multi-timeframe read is `aligned` for it, nothing in its way before its
 *      trail activation (or target, else its min R:R, else 2R), confluence with it and none against, price on its
 *      side of the VWAP that applies, and not the lunch lull: take it, let the trail work, prefer it over the rest
 *   B  allowed and not mixed, pullback or counter, but a level between 1R and its trail activation: only with a
 *      target before that level that still meets its min R:R
 *   C  against the trend rule, a mixed, pullback or counter read, a level within 1R, confluence against, or a
 *      no-entry window: skip
 */
function candidate(r, price, levels, { noEntry = false, newsBlocked = false, lunch = false, alignment = {}, vwapSide = null } = {}) {
  const R = r.stopDistance;
  const up = r.direction === 'long';
  // Its own three nearest levels in its direction, in its own R (its stop): the first is the one in its way.
  const ahead = merge(levels.filter(([, p]) => Number.isFinite(p) && (up ? p > price : p < price)).sort(([, a], [, b]) => (up ? a - b : b - a))).slice(0, 3)
    .map(([name, p]) => ({ name, price: p, points: round2(Math.abs(p - price)), R: R > 0 ? round2(Math.abs(p - price) / R) : null }));
  const exit = r.exit || {};
  const inTheWay = R > 0 ? ahead[0] || null : null;
  // Its target: a level target's distance (the scan's targetDistance), else targetR x its stop.
  const targetPoints = Number.isFinite(r.targetDistance) ? r.targetDistance : Number.isFinite(exit.targetR) && R > 0 ? exit.targetR * R : null;
  const target = targetPoints !== null ? { level: exit.target || null, points: round2(targetPoints), R: R > 0 ? round2(targetPoints / R) : null } : null;
  // The room it needs: to its trail activation, else its target, else its min R:R, else 2R.
  const needR = exit.trailActivateR ?? (target && target.R) ?? r.minRR ?? 2;
  const mtf = r.mtf || {};
  const allowed = mtf.style === 'reversal' || (up ? mtf.longAllowed : mtf.shortAllowed) !== false;
  const align = alignment ? alignment[up ? 'long' : 'short'] : null;
  const against = ((r.confluence || {}).against || []).length;
  const withIt = ((r.confluence || {}).with || []).length;
  const vwapWith = vwapSide === (up ? 'above' : 'below');
  const roomR = inTheWay ? inTheWay.R : null;
  const c = [];
  if (!allowed) c.push('against the trend rule');
  if (['mixed', 'pullback', 'counter'].includes(align)) c.push(`multi-timeframe read ${align}`);
  if (roomR !== null && roomR < 1) c.push(`${inTheWay.name} within 1R (${roomR}R)`);
  if (against) c.push('confluence against');
  if (noEntry) c.push('no-entry window');
  if (newsBlocked) c.push('news blackout');
  const a = [];
  if (align !== 'aligned') a.push(`multi-timeframe read ${align || 'unknown'}, not aligned`);
  if (roomR !== null && roomR < needR) a.push(`${inTheWay.name} at ${roomR}R, before the ${needR}R it needs`);
  if (!withIt) a.push('no confluence');
  if (!vwapWith) a.push(`price ${vwapSide || 'not'} the VWAP for a ${r.direction}`);
  if (lunch) a.push('lunch lull');
  const grade = c.length ? 'C' : a.length ? 'B' : 'A';
  return {
    name: r.name, direction: r.direction, status: r.status, confluence: r.confluence || null,
    entryRef: r.entryRef, stopPoints: round2(R), minRR: r.minRR ?? null,
    exit: { trailActivateR: exit.trailActivateR ?? null, trailGivebackR: exit.trailGivebackR ?? null, targetR: exit.targetR ?? null, maxBars: exit.maxBars ?? null },
    target, inTheWay, ahead, needR,
    grade, why: grade === 'C' ? c : grade === 'B' ? a : ['trend allows it, aligned, room to its trail or target, confluence, VWAP with it'],
    ...(noEntry || newsBlocked ? { blocked: noEntry ? 'no-entry window' : 'news blackout' } : {}),
  };
}

/** The news blackouts at `at`: the one in force (with its end), else the next one today (with the minutes to it). */
function newsState(blackouts, at) {
  // An unreadable blackouts file: unknown (the gate refuses entries then), never "no blackout".
  if (blackouts && blackouts.error) return { inBlackout: null, error: `the blackouts file can't be read (${blackouts.error}): the order gate refuses entries` };
  const items = ((blackouts && blackouts.items) || []).filter(x => Date.parse(x.end) > at.getTime()).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const now = items.find(x => Date.parse(x.start) <= at.getTime());
  if (now) return { inBlackout: true, reason: now.reason || null, until: now.end };
  const next = items[0];
  return next ? { inBlackout: false, next: { reason: next.reason || null, start: next.start, inMinutes: Math.round((Date.parse(next.start) - at.getTime()) / 60000) } } : { inBlackout: false, next: null };
}

/**
 * The briefing for `symbol`'s closed bars on `minutes`-minute bars: each section from `prev` while it is
 * valid (same symbol and bar size, not expired), else recomputed with a new version.
 */
function buildBriefing({ symbol, contractId = null, bars: raw, minutes, prev = null, scan = [], scanError = null, blackouts = null, now = new Date() }) {
  const bars = normalizeBars(raw);
  if (bars.length < 3) throw new Error(`need closed bars, got ${bars.length}`);
  const last = bars[bars.length - 1];
  const closedAt = new Date(Date.parse(last.t) + minutes * 60000);
  const snap = snapshot({ bars });
  const read = mtfRead(bars);
  // The m15 and h1 reads as of their own last candle close: the read's window slides with each bar, so a section
  // read at its close stays what a fresh read at that close gives for its whole life (the trend rule in m3 is the
  // read of this bar, as the gate's).
  const asOfClose = m => {
    const boundary = nextClose(new Date(closedAt.getTime() - m * 60000), m).getTime();
    const upTo = bars.filter(b => Date.parse(b.t) + minutes * 60000 <= boundary);
    return upTo.length >= 3 ? mtfRead(upTo) : read;
  };
  const read15 = asOfClose(15);
  const readH1 = asOfClose(60);
  // The 15m and 1h candles, completed only (the one forming isn't in them).
  const done = m => candles(bars, m).filter(c => c.complete).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  const c15 = done(15);
  const c60 = done(60);
  const snap15 = c15.length >= 30 ? snapshot15(c15) : null;
  const fresh = computeSections({ bars, c15, c60, snap, snap15, read, read15, readH1, scan, scanError, minutes, closedAt, blackouts });
  // Same symbol, bar size and contract (a roll to the next month is new prices, never the old month's levels).
  const usable = prev && prev.symbol === symbol && prev.minutes === minutes && (prev.contractId || null) === contractId && Date.parse(prev.closedAt) < closedAt.getTime();
  const sections = {};
  for (const name of SECTIONS) {
    const old = usable ? prev.sections[name] : null;
    if (old && Date.parse(old.validUntil) > closedAt.getTime()) { sections[name] = old; continue; }
    const s = fresh[name];
    sections[name] = { version: `${name}@${closedAt.toISOString()}`, computedAt: closedAt.toISOString(), validUntil: s.validUntil.toISOString(), reason: old ? 'expired' : 'new', data: s.data };
  }
  return { symbol, contractId, minutes, asOf: last.t, closedAt: closedAt.toISOString(), price: last.c, builtAt: now.toISOString(), sections };
}

/** Levels within a tick of each other, as one with the names joined (sorted nearest first; the first price kept). */
function merge(sorted, tick = 0.25) {
  const out = [];
  for (const [name, p] of sorted) {
    const same = out.find(([, q]) => Math.abs(q - p) <= tick + 1e-9);
    if (same) { if (!same[0].split(' / ').includes(name)) same[0] = `${same[0]} / ${name}`; } else out.push([name, p]);
  }
  return out;
}

/** The three nearest named levels above and below price, each in points and R (`oneR`: 1R in points). */
function nearest(price, oneR, levels) {
  const pick = above => merge(levels.filter(([, p]) => Number.isFinite(p) && (above ? p > price : p < price))
    .sort(([, a], [, b]) => (above ? a - b : b - a))).slice(0, 3);
  const one = ([name, p]) => ({ name, price: p, points: round2(Math.abs(p - price)), R: oneR > 0 ? round2(Math.abs(p - price) / oneR) : null });
  return { above: pick(true).map(one), below: pick(false).map(one) };
}

/** Price against a level: above or below (null without one). */
function side(p, level) {
  return Number.isFinite(level) && Number.isFinite(p) ? (p > level ? 'above' : p < level ? 'below' : 'at') : null;
}

/** Price against a low-high band: below, inside, or above (null without the band). */
function where(p, lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return p < lo ? 'below' : p > hi ? 'above' : 'inside';
}

/** The 15m candles' snapshot, or null when it can't be computed (too few candles for an indicator). */
function snapshot15(c15) {
  try {
    return snapshot({ bars: c15 });
  } catch (_err) {
    return null;
  }
}

/** Whether the briefing is this bar's: its m3 (the trigger bar) still holds at `now`. */
function current(b, now = new Date()) {
  return Boolean(b && b.sections && b.sections.m3 && Date.parse(b.sections.m3.validUntil) > now.getTime());
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;
const etDate = at => new Intl.DateTimeFormat('en-CA', { timeZone: ET, month: '2-digit', day: '2-digit' }).format(at);
/** Every time as ET (HH:MM, with the date when it isn't the bar's ET day), as the skills and session windows read it. */
function etTimes(v, barDay) {
  if (typeof v === 'string' && ISO.test(v)) {
    const at = new Date(v);
    return etDate(at) === barDay ? etClock(at) : `${etDate(at)} ${etClock(at)}`;
  }
  if (Array.isArray(v)) return v.map(x => etTimes(x, barDay));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, etTimes(x, barDay)]));
  return v;
}
const fmt = v => (v && typeof v === 'object' ? JSON.stringify(v) : String(v));

const GRADE = { A: 'take it, let it run', B: 'only with a target before the level', C: 'skip' };
const lvl = x => `${x.name} ${x.price} (${x.points} pts, ${x.R}R)`;

/** The decision in plain words, first: what a role needs at a glance (the sections below hold the detail). */
function summaryLines(b, et) {
  const m3 = (b.sections.m3 || {}).data || {};
  const m15 = (b.sections.m15 || {}).data || {};
  const al = m15.alignment || {};
  const rule = String(m3.trendRule || '').replace(/^Trend rule: /, '');
  const vw = m3.vwap || {};
  const news = m3.news || {};
  const room = m3.nearestLiquidity || { above: [], below: [] };
  const out = [
    `Summary (${b.symbol} ${b.minutes}m, ${m3.et} ET, ${m3.window} until ${et(m3.windowUntil)}):`,
    `- Price ${m3.price}. 1R = ${m3.oneR ? `${m3.oneR.points} pts (${m3.oneR.basis})` : 'unknown'}; every distance below is in points and R.`,
    `- Trend rule: ${rule}`,
    `- Alignment: long ${al.long || '?'}, short ${al.short || '?'}. Regime: ${(m3.regime || {}).primary || '?'}, ${(m3.regime || {}).volatility || '?'} volatility.`,
    `- VWAP (${vw.applies || '?'}): price ${vw.side || '?'}, ${Number.isFinite(vw.distanceAtr) ? Math.abs(vw.distanceAtr) : '?'} ATR away, ${vw.crossesLast30 ?? '?'} crosses in 30 bars.`,
    `- News: ${news.error ? news.error : news.inBlackout ? `in a blackout (${news.reason || 'event'}) until ${et(news.until)}` : news.next ? `next ${news.next.reason || 'event'} at ${et(news.next.start)} (in ${news.next.inMinutes} min)` : 'no blackout ahead'}.`,
    `- Room above (R = the reference stop): ${(room.above || []).map(lvl).join(', ') || 'none found'}.`,
    `- Room below (R = the reference stop): ${(room.below || []).map(lvl).join(', ') || 'none found'}.`,
  ];
  if (m3.candidates === null) out.push(`- Setups: unknown (${m3.scanError || 'the scan failed'}): no rules entry this bar.`);
  else if (!m3.candidates || !m3.candidates.length) out.push('- Setups: none fired on this bar.');
  else {
    out.push('- Setups:');
    for (const c of m3.candidates) {
      out.push(`  - ${c.name} ${c.direction}: grade ${c.grade} (${GRADE[c.grade]}): ${c.why.join('; ')}. Stop ${c.stopPoints} pts (its own 1R)${c.target ? `; target ${c.target.points} pts (${c.target.R}R)` : ''}; needs ${c.needR}R of room; levels ahead in its R: ${(c.ahead || []).map(lvl).join(', ') || 'none found'}.`);
    }
  }
  return out;
}

/** The briefing as text: the summary, then one block per section, with when it was computed and until when it holds. */
function renderBriefing(b, { now = new Date() } = {}) {
  const day = etDate(new Date(b.closedAt));
  const et = v => etTimes(v, day);
  const lines = [`Bar briefing ${b.symbol} ${b.minutes}m, bar ${et(b.asOf)} ET closed ${et(b.closedAt)} ET (${day}), price ${b.price}; times in ET, distances in points and R (computed once per section; reuse it, don't recompute):`];
  lines.push(...summaryLines(b, et), '', 'Detail by timeframe:');
  for (const name of SECTIONS) {
    const s = b.sections[name];
    if (!s) continue;
    const stale = Date.parse(s.validUntil) <= now.getTime() ? ' EXPIRED (the next briefing replaces it)' : '';
    lines.push(`[${name}] version ${s.version}, valid until ${et(s.validUntil)} ET${stale}`);
    for (const [k, v] of Object.entries(s.data)) lines.push(`  ${k}: ${fmt(et(v))}`);
  }
  return `${lines.join('\n')}\n`;
}

const briefingFile = (home, root) => path.join(home, 'briefing', `${familyRoot(root)}.json`);

function writeBriefing(home, b) {
  const file = briefingFile(home, b.symbol);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(b)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/** Remove the briefing (a bar whose briefing failed: an older one must not be read as this bar's). */
function removeBriefing(home, root) {
  try { fs.unlinkSync(briefingFile(home, root)); } catch (_err) { /* none */ }
}

function readBriefing(home, root) {
  try {
    return JSON.parse(fs.readFileSync(briefingFile(home, root), 'utf8'));
  } catch (_err) {
    return null;
  }
}

module.exports = { SECTIONS, WINDOWS, nextClose, nextRthRoll, sessionWindow, buildBriefing, candidate, current, renderBriefing, briefingFile, writeBriefing, readBriefing, removeBriefing };
