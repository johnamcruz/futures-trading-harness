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
 *   m3     the trigger bar: price, ET time and session window, regime, EMAs,
 *          ADX, Keltner, VWAP side, participation, 3m swings and liquidity
 *          (equal highs and lows, open fair value gaps), where price is against
 *          the value areas, IB and prior RTH range, the scan's candidates,
 *          the trend rule                                until the next base-bar close
 *   m15    the 15m read (trend, structure, swings, ADX), the alignment per
 *          side, today so far (open, gap, opening type, IB, day type), the
 *          session's volume profile                      until the next 15m close
 *   h1     the 1h and 4h reads                            until the next 1h close
 *   day    the prior RTH day and its volume profile, the overnight range
 *                                                         until the next trading day
 *
 * A section is recomputed before it expires when what it rests on breaks
 * (invalidation): a close through one of its key levels (m15: the 15m swing
 * high and low, the prior RTH high, low, VAH and VAL, the IB; h1: the 1h swing
 * high and low), or a bar whose range is over twice ATR(14) (m15 and h1).
 * Candles align to the 18:00 ET session open, as the multi-timeframe read does.
 *
 * Each section carries a version that changes only when it is recomputed, so
 * whatever was built on it (an analyst's report) stays valid while the
 * versions it used are unchanged.
 *
 *   buildBriefing({ symbol, bars, minutes, prev, scan, now })   the briefing (prev: the last one, reused where valid)
 *   renderBriefing(b, { now })                                   one text block per section, with validity
 *   briefingFile(home, root) / writeBriefing / readBriefing      <FTH_HOME>/briefing/<MICRO ROOT>.json
 *   nextClose(at, minutes)                                       when the candle containing `at` closes
 *   sessionWindow(at)                                            { name, until } (the session-timing skill's windows)
 */

const fs = require('fs');
const path = require('path');
const { snapshot } = require('./market-snapshot');
const { mtfRead } = require('./mtf');
const { normalizeBars } = require('./indicators');
const { tradingDayStart, minutesOfDay } = require('./clock');
const { familyRoot } = require('./contracts');

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

const etClock = at => new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
const round2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const frameOf = (read, minutes) => (read.frames.find(f => f.minutes === minutes) || {}).read || null;
const brief = f => (f ? { trend: f.trend, bias: f.bias, structure: f.votes && f.votes.structure, close: f.close, emaFast: f.emaFast, emaSlow: f.emaSlow, adx: f.adx, atr: f.atr, swingHigh: f.levels && f.levels.swingHigh, swingLow: f.levels && f.levels.swingLow, prevHigh: f.levels && f.levels.prevHigh, prevLow: f.levels && f.levels.prevLow } : null);

/** Each section's data, levels it rests on, and expiry, from this bar's snapshot and read. */
function computeSections({ snap, read, scan, minutes, closedAt }) {
  const t = snap.trend || {};
  const vp = snap.volumeProfile || {};
  const lv = snap.levels || {};
  const day = snap.day || {};
  const price = snap.last.c;
  const win = sessionWindow(closedAt);
  const f15 = frameOf(read, 15);
  const f60 = frameOf(read, 60);
  const prior = vp.priorRth || {};
  return {
    m3: {
      validUntil: new Date(closedAt.getTime() + minutes * 60000),
      levels: [],
      data: {
        price, bar: snap.last.t, et: etClock(closedAt), window: win.name, windowUntil: win.until.toISOString(),
        regime: snap.regime && { primary: snap.regime.primary, volatility: snap.regime.volatility },
        trend: { emaFast: round2(t.emaFast), emaSlow: round2(t.emaSlow), ema50: round2(t.ema50), ema200: round2(t.ema200), adx: t.adx, adxSlope: t.adxSlope, supertrend: t.supertrend && t.supertrend.direction, keltner: t.keltner ? { upper: round2(t.keltner.upper), mid: round2(t.keltner.mid), lower: round2(t.keltner.lower) } : null },
        priceVsEmaFast: price > t.emaFast ? 'above' : 'below',
        atr14: round2((snap.volatility || {}).atr14),
        vwap: { session: round2(lv.vwapSession), rth: round2(lv.vwapRth), side: price > lv.vwapSession ? 'above' : 'below', distanceAtr: (snap.vwap || {}).distanceAtr },
        participation: snap.participation && { relVolLast3VsPrior20: snap.participation.relVolLast3VsPrior20, relVolVsSameTimePriorDay: snap.participation.relVolVsSameTimePriorDay },
        swings3m: snap.structure,
        // Liquidity on the trigger bars: the recent swing points, equal highs and lows, open fair value gaps.
        liquidity: snap.liquidity ? { swingHighs: snap.liquidity.swingHighs, swingLows: snap.liquidity.swingLows, equalHighs: snap.liquidity.equalHighs, equalLows: snap.liquidity.equalLows, openFvgs: snap.liquidity.openFvgs } : null,
        referenceStop: snap.referenceStop && { distance: round2(snap.referenceStop.distance) },
        // Where price is against the levels the cached sections hold (it moves every bar, so it lives here).
        location: {
          priorValue: where(price, prior.val, prior.vah), sessionValue: vp.session ? where(price, vp.session.val, vp.session.vah) : null,
          initialBalance: where(price, day.ibLow, day.ibHigh), priorRthRange: lv.priorRth ? where(price, lv.priorRth.low, lv.priorRth.high) : null,
        },
        candidates: (scan || []).filter(r => r.candidate && r.direction).map(r => ({ name: r.name, direction: r.direction, status: r.status, confluence: r.confluence || null })),
        trendRule: read.lines[read.lines.length - 1],
      },
    },
    m15: {
      validUntil: nextClose(closedAt, 15),
      levels: [
        ['15m swing high', f15 && f15.levels.swingHigh], ['15m swing low', f15 && f15.levels.swingLow],
        ['prior RTH high', (lv.priorRth || {}).high], ['prior RTH low', (lv.priorRth || {}).low],
        ['prior VAH', prior.vah], ['prior VAL', prior.val], ['IB high', day.ibHigh], ['IB low', day.ibLow],
      ].filter(([, p]) => Number.isFinite(p)),
      data: {
        frame: brief(f15),
        alignment: read.alignment,
        today: { open: day.open, gap: day.gap, openVs: day.openVs, openType: day.openType, ibHigh: day.ibHigh, ibLow: day.ibLow, dayType: day.dayType, rangeVsAdr: day.adr ? round2(day.range / day.adr) : null, openingRange: lv.openingRange || null },
        sessionProfile: vp.session ? { poc: round2(vp.session.poc), vah: round2(vp.session.vah), val: round2(vp.session.val) } : null,
      },
    },
    h1: {
      validUntil: nextClose(closedAt, 60),
      levels: [['1h swing high', f60 && f60.levels.swingHigh], ['1h swing low', f60 && f60.levels.swingLow]].filter(([, p]) => Number.isFinite(p)),
      data: { h1: brief(f60), h4: brief(frameOf(read, 240)) },
    },
    day: {
      validUntil: new Date(tradingDayStart(closedAt).getTime() + 1440 * 60000),
      levels: [],
      data: {
        priorRth: lv.priorRth || null, overnight: lv.overnight || null,
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
function buildBriefing({ symbol, bars: raw, minutes, prev = null, scan = [], now = new Date() }) {
  const bars = normalizeBars(raw);
  if (bars.length < 3) throw new Error(`need closed bars, got ${bars.length}`);
  const last = bars[bars.length - 1];
  const closedAt = new Date(Date.parse(last.t) + minutes * 60000);
  const snap = snapshot({ bars });
  const read = mtfRead(bars);
  const fresh = computeSections({ snap, read, scan, minutes, closedAt });
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

/** Price against a low-high band: below, inside, or above (null without the band). */
function where(p, lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return p < lo ? 'below' : p > hi ? 'above' : 'inside';
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

function readBriefing(home, root) {
  try {
    return JSON.parse(fs.readFileSync(briefingFile(home, root), 'utf8'));
  } catch (_err) {
    return null;
  }
}

module.exports = { SECTIONS, WINDOWS, nextClose, sessionWindow, buildBriefing, renderBriefing, briefingFile, writeBriefing, readBriefing };
