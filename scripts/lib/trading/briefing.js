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
 *          last 10 bars, the 1h swings not traded back to, where price is against the value areas, IB and prior RTH
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
 * A section is recomputed before it expires when what it rests on breaks
 * (invalidation): a close through one of its key levels (m15: the 15m swing
 * high and low, the prior RTH high, low, VAH and VAL; h1: the 1h swing high
 * and low), or a bar whose range is over twice ATR(14) (m15 and h1).
 * Candles align to the 18:00 ET session open, as the multi-timeframe read does.
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
const { pivots, lastBreaks, sweeps, untestedSwings } = require('./structure-events');

const SECTIONS = ['m3', 'm15', 'h1', 'day'];
const SPIKE_ATR = 2;
const ET = 'America/New_York';

// The session-timing skill's windows (ET minutes of the day, from 00:00).
const WINDOWS = [
  [0, 180, 'asia'], [180, 570, 'london'], [570, 575, 'opening print (no entries)'], [575, 660, 'opening drive'],
  [660, 690, 'late morning'], [690, 810, 'lunch lull'], [810, 945, 'afternoon'], [945, 960, 'into the close (no entries)'],
  [960, 1080, 'daily break (closed)'], [1080, 1440, 'asia'],
];

/** When the `minutes` candle containing `at` closes (candles from the trading day's 18:00 ET open). */
function nextClose(at, minutes) {
  const start = tradingDayStart(at).getTime();
  const step = minutes * 60000;
  return new Date(start + (Math.floor((at.getTime() - start) / step) + 1) * step);
}

function sessionWindow(at) {
  const m = minutesOfDay(at, ET);
  const [, end, name] = WINDOWS.find(([a, b]) => m >= a && m < b);
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
const brief = f => (f ? { trend: f.trend, bias: f.bias, structure: f.votes && f.votes.structure, close: f.close, emaFast: f.emaFast, emaSlow: f.emaSlow, adx: f.adx, atr: f.atr, swingHigh: f.levels && f.levels.swingHigh, swingLow: f.levels && f.levels.swingLow, prevHigh: f.levels && f.levels.prevHigh, prevLow: f.levels && f.levels.prevLow } : null);

/** Each section's data, levels it rests on, and expiry, from this bar's snapshot and read. */
function computeSections({ bars, c15, c60, snap, snap15, read, scan, scanError, minutes, closedAt }) {
  const t = snap.trend || {};
  const vp = snap.volumeProfile || {};
  const lv = snap.levels || {};
  const day = snap.day || {};
  const price = snap.last.c;
  const win = sessionWindow(closedAt);
  const f15 = frameOf(read, 15);
  const f60 = frameOf(read, 60);
  const prior = vp.priorRth || {};
  // The VWAP that applies: the RTH VWAP from 09:30 to 16:00 ET, else the session's (18:00 ET), as the strategy filters use.
  const vwapRef = (snap.vwap || {}).applies === 'rth' ? lv.vwapRth : lv.vwapSession;
  const t15 = (snap15 && snap15.trend) || {};
  return {
    m3: {
      validUntil: new Date(closedAt.getTime() + minutes * 60000),
      levels: [],
      data: {
        price, bar: snap.last.t, et: etClock(closedAt), window: win.name, windowUntil: win.until.toISOString(),
        regime: snap.regime && { primary: snap.regime.primary, volatility: snap.regime.volatility },
        trend: { emaFast: round2(t.emaFast), emaSlow: round2(t.emaSlow), ema50: round2(t.ema50), ema200: round2(t.ema200), adx: t.adx, adxSlope: t.adxSlope, supertrend: t.supertrend && t.supertrend.direction, keltner: t.keltner ? { upper: round2(t.keltner.upper), mid: round2(t.keltner.mid), lower: round2(t.keltner.lower) } : null },
        priceVsEmaFast: side(price, t.emaFast),
        atr14: round2((snap.volatility || {}).atr14),
        vwap: { applies: (snap.vwap || {}).applies || null, session: round2(lv.vwapSession), rth: round2(lv.vwapRth), side: side(price, vwapRef), distanceAtr: (snap.vwap || {}).distanceAtr },
        participation: snap.participation && { relVolLast3VsPrior20: snap.participation.relVolLast3VsPrior20, relVolVsSameTimePriorDay: snap.participation.relVolVsSameTimePriorDay },
        swings3m: snap.structure,
        // Liquidity on the trigger bars: the recent swing points, equal highs and lows, open fair value gaps.
        liquidity: snap.liquidity ? { swingHighs: snap.liquidity.swingHighs, swingLows: snap.liquidity.swingLows, equalHighs: snap.liquidity.equalHighs, equalLows: snap.liquidity.equalLows, openFvgs: snap.liquidity.openFvgs } : null,
        // Structure events (structure-events.js): the latest break on the trigger bars, sweeps of the key liquidity (the
        // prior RTH and overnight highs and lows, equal highs and lows, the last 3m swings) in the last 10 bars, and the 1h swings not traded back to (that changes on any bar, so it lives here).
        structure: lastBreaks(bars),
        sweeps: sweeps(bars, [
          ['prior RTH high', (lv.priorRth || {}).high, 'high'], ['prior RTH low', (lv.priorRth || {}).low, 'low'],
          ['overnight high', (lv.overnight || {}).high, 'high'], ['overnight low', (lv.overnight || {}).low, 'low'],
          ['last 3m swing high', (snap.structure || {}).lastSwingHigh, 'high'], ['last 3m swing low', (snap.structure || {}).lastSwingLow, 'low'],
          ...((snap.liquidity || {}).equalHighs || []).map(x => ['equal highs', Math.max(...x.prices), 'high']),
          ...((snap.liquidity || {}).equalLows || []).map(x => ['equal lows', Math.min(...x.prices), 'low']),
        ].map(([name, price, side]) => ({ name, price, side })), 10).slice(0, 5),
        untested1hSwings: untestedSwings(bars, [...pivots(c60).filter(x => x.type === 'high').slice(-4), ...pivots(c60).filter(x => x.type === 'low').slice(-4)]),
        // Today so far and the developing levels: they move bar by bar, so they live here, never in a cached section.
        today: { open: day.open, gap: day.gap, openVs: day.openVs, openType: day.openType, openingRange: lv.openingRange || null, ibHigh: day.ibHigh, ibLow: day.ibLow, dayType: day.dayType, rangeVsAdr: day.adr ? round2(day.range / day.adr) : null },
        overnight: lv.overnight || null,
        sessionProfile: vp.session ? { poc: round2(vp.session.poc), vah: round2(vp.session.vah), val: round2(vp.session.val) } : null,
        // Where price is against the levels: it moves every bar.
        location: {
          priorValue: where(price, prior.val, prior.vah), sessionValue: vp.session ? where(price, vp.session.val, vp.session.vah) : null,
          initialBalance: where(price, day.ibLow, day.ibHigh), priorRthRange: lv.priorRth ? where(price, lv.priorRth.low, lv.priorRth.high) : null,
        },
        // null: the scan failed this bar, so what fired is unknown (not "nothing fired").
        candidates: scan ? scan.filter(r => r.candidate && r.direction).map(r => ({ name: r.name, direction: r.direction, status: r.status, confluence: r.confluence || null })) : null,
        ...(scan ? {} : { scanError: scanError || 'the scan failed this bar' }),
        trendRule: read.lines[read.lines.length - 1],
      },
    },
    m15: {
      validUntil: nextClose(closedAt, 15),
      levels: [
        ['15m swing high', f15 && f15.levels.swingHigh], ['15m swing low', f15 && f15.levels.swingLow],
        ['prior RTH high', (lv.priorRth || {}).high], ['prior RTH low', (lv.priorRth || {}).low],
        ['prior VAH', prior.vah], ['prior VAL', prior.val],
      ].filter(([, p]) => Number.isFinite(p)),
      data: {
        frame: brief(f15),
        alignment: read.alignment,
        structure: lastBreaks(c15),
        // The 15m candles' own indicators (completed candles only).
        indicators: snap15 ? {
          regime: snap15.regime && { primary: snap15.regime.primary, volatility: snap15.regime.volatility },
          emaFast: round2(t15.emaFast), emaSlow: round2(t15.emaSlow), adx: t15.adx, adxSlope: t15.adxSlope,
          supertrend: t15.supertrend ? { direction: t15.supertrend.direction, line: round2(t15.supertrend.line) } : null,
          keltner: t15.keltner ? { upper: round2(t15.keltner.upper), mid: round2(t15.keltner.mid), lower: round2(t15.keltner.lower) } : null,
          atr14: round2((snap15.volatility || {}).atr14),
        } : null,
      },
    },
    h1: {
      validUntil: nextClose(closedAt, 60),
      levels: [['1h swing high', f60 && f60.levels.swingHigh], ['1h swing low', f60 && f60.levels.swingLow]].filter(([, p]) => Number.isFinite(p)),
      data: { h1: brief(f60), h4: brief(frameOf(read, 240)), structure: lastBreaks(c60) },
    },
    day: {
      // The prior RTH day changes at the RTH close (16:00 ET).
      validUntil: nextRthRoll(new Date(closedAt.getTime() - minutes * 60000), minutes),
      levels: [],
      data: {
        priorRth: lv.priorRth || null,
        priorProfile: prior.poc ? { poc: round2(prior.poc), vah: round2(prior.vah), val: round2(prior.val), hvn: prior.hvn, lvn: prior.lvn } : null,
      },
    },
  };
}

/** Why a kept section must be recomputed now, or null: a close through one of its levels, or a range spike. */
function invalidation(sec, name, { prevClose, close, rangeAtr }) {
  if ((name === 'm15' || name === 'h1') && rangeAtr > SPIKE_ATR) return `a bar range of ${round2(rangeAtr)} x ATR(14)`;
  if (!Number.isFinite(prevClose)) return null;
  const hit = (sec.levels || []).find(([, p]) => (prevClose - p) * (close - p) < 0 || (prevClose !== p && close === p));
  return hit ? `a close through the ${hit[0]} ${hit[1]}` : null;
}

/**
 * The briefing for `symbol`'s closed bars on `minutes`-minute bars: each section from `prev` while it is
 * valid (same symbol and bar size, not expired, not invalidated), else recomputed with a new version.
 */
function buildBriefing({ symbol, bars: raw, minutes, prev = null, scan = [], scanError = null, now = new Date() }) {
  const bars = normalizeBars(raw);
  if (bars.length < 3) throw new Error(`need closed bars, got ${bars.length}`);
  const last = bars[bars.length - 1];
  const closedAt = new Date(Date.parse(last.t) + minutes * 60000);
  const snap = snapshot({ bars });
  const read = mtfRead(bars);
  // The 15m candles' own snapshot, from completed candles only (the one forming isn't in it).
  const done = m => candles(bars, m).filter(c => c.complete).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  const c15 = done(15);
  const c60 = done(60);
  const snap15 = c15.length >= 30 ? snapshot15(c15) : null;
  const fresh = computeSections({ bars, c15, c60, snap, snap15, read, scan, scanError, minutes, closedAt });
  const atr = (snap.volatility || {}).atr14;
  const ctx = { prevClose: prev && prev.price, close: last.c, rangeAtr: atr > 0 ? (last.h - last.l) / atr : 0 };
  const usable = prev && prev.symbol === symbol && prev.minutes === minutes && Date.parse(prev.closedAt) < closedAt.getTime();
  const sections = {};
  for (const name of SECTIONS) {
    const old = usable ? prev.sections[name] : null;
    const why = !old ? 'new' : Date.parse(old.validUntil) <= closedAt.getTime() ? 'expired' : invalidation(old, name, ctx);
    if (old && !why) { sections[name] = old; continue; }
    const s = fresh[name];
    sections[name] = { version: `${name}@${closedAt.toISOString()}`, computedAt: closedAt.toISOString(), validUntil: s.validUntil.toISOString(), reason: why, levels: s.levels, data: s.data };
  }
  return { symbol, minutes, asOf: last.t, closedAt: closedAt.toISOString(), price: last.c, builtAt: now.toISOString(), sections };
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

const fmt = v => (v && typeof v === 'object' ? JSON.stringify(v) : String(v));

/** The briefing as text: one block per section, with when it was computed, why, and until when it holds. */
function renderBriefing(b, { now = new Date() } = {}) {
  const lines = [`Bar briefing ${b.symbol} ${b.minutes}m, bar ${b.asOf} closed ${b.closedAt}, price ${b.price} (computed once per section; reuse it, don't recompute):`];
  for (const name of SECTIONS) {
    const s = b.sections[name];
    if (!s) continue;
    const stale = Date.parse(s.validUntil) <= now.getTime() ? ' EXPIRED (the next briefing replaces it)' : '';
    lines.push(`[${name}] version ${s.version}, valid until ${s.validUntil}${stale}${s.reason && s.reason !== 'new' ? `, recomputed: ${s.reason}` : ''}`);
    for (const [k, v] of Object.entries(s.data)) lines.push(`  ${k}: ${fmt(v)}`);
    if (s.levels && s.levels.length) lines.push(`  invalidated by a close through: ${s.levels.map(([n, p]) => `${n} ${p}`).join(', ')}`);
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

module.exports = { SECTIONS, WINDOWS, nextClose, nextRthRoll, sessionWindow, buildBriefing, current, renderBriefing, briefingFile, writeBriefing, readBriefing, removeBriefing };
