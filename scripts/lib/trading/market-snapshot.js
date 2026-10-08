'use strict';

/**
 * Summarise bars into the numbers the analyst agents and strategies use:
 * trend/momentum values, key levels, and which mechanical strategy triggers
 * fired on the last closed bar. Parameters follow algoTraderBot/config.py.
 */

const ind = require('./indicators');
const { classifyRegime } = require('./regime');
const { zonedParts } = require('./clock');

const PARAMS = {
  emaFast: 9, emaSlow: 20, adxPeriod: 14, adxSlopeBars: 5,
  stPeriod: 10, stMult: 3,
  kcLen: 20, kcMult: 1.5, kcAtr: 20,
  swingK: 2,
  orbMinutes: 15,
  atrStop: 20, stopAtrMult: 0.5,
  // Candle Range Theory sweeps (crt_dir / crt_risk / crt_target, scripts/lib/trading/crt.js).
  crtSweepBars: 10, crtShiftBars: 5, crtMaxDepth: 0.5, crtMinRangeAtr: 2, crtBufferAtr: 0.25, crtMinRR: 2,
};

const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;
const GLOBEX_OPEN = 18 * 60;

const at = (arr, i) => (i >= 0 && i < arr.length && Number.isFinite(arr[i]) ? arr[i] : null);
const round = (x, d = 4) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

function etDayMinute(t) {
  const p = zonedParts(new Date(t), 'America/New_York');
  return { day: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`, minute: p.hour * 60 + p.minute };
}


function levels(bars) {
  const last = bars[bars.length - 1];
  const lastEt = etDayMinute(last.t);
  const session = ind.sessionKey(last.t, GLOBEX_OPEN);
  const rthDays = new Map();
  let onHigh = null; let onLow = null;
  for (const b of bars) {
    const { day, minute } = etDayMinute(b.t);
    if (minute >= RTH_OPEN && minute < RTH_CLOSE) {
      const d = rthDays.get(day) || { high: -Infinity, low: Infinity, close: null };
      d.high = Math.max(d.high, b.h); d.low = Math.min(d.low, b.l); d.close = b.c;
      rthDays.set(day, d);
    } else if (ind.sessionKey(b.t, GLOBEX_OPEN) === session && !(minute >= RTH_CLOSE && minute < GLOBEX_OPEN)) {
      onHigh = onHigh === null ? b.h : Math.max(onHigh, b.h);
      onLow = onLow === null ? b.l : Math.min(onLow, b.l);
    }
  }
  const priorDays = [...rthDays.keys()].filter(d => d < lastEt.day || (d === lastEt.day && lastEt.minute >= RTH_CLOSE)).sort();
  const prior = priorDays.length ? rthDays.get(priorDays[priorDays.length - 1]) : null;
  return {
    priorRth: prior ? { day: priorDays[priorDays.length - 1], high: prior.high, low: prior.low, close: prior.close } : null,
    overnight: onHigh === null ? null : { high: onHigh, low: onLow },
  };
}

/**
 * Indicators for a whole bar series, computed once. Every value at bar i uses
 * bars 0..i only, so a backtest can walk the series bar by bar (no look-ahead)
 * and live trading evaluates the last bar the same way. Entry triggers are
 * not here: every strategy's trigger is its STRATEGY.md rules
 * (strategies.js scan).
 */
function signalSeries(bars, overrides = {}) {
  const p = { ...PARAMS, ...overrides };
  const closes = bars.map(b => b.c);
  const s = {
    p,
    closes,
    emaFast: ind.ema(closes, p.emaFast),
    emaSlow: ind.ema(closes, p.emaSlow),
    adx: ind.adx(bars, p.adxPeriod),
    atrStop: ind.atr(bars, p.atrStop),
    st: ind.supertrend(bars, p.stPeriod, p.stMult),
    kc: ind.keltner(bars, p.kcLen, p.kcMult, p.kcAtr),
    sw: ind.swings(bars, p.swingK),
    or: ind.openingRange(bars, p.orbMinutes),
  };
  return s;
}

const etMinute = t => { const q = zonedParts(new Date(t), 'America/New_York'); return { day: `${q.year}-${q.month}-${q.day}`, minute: q.hour * 60 + q.minute }; };
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const ratio = (x, y) => (x !== null && y ? round(x / y, 2) : null);

/**
 * Participation: the last bar's and the last 3 bars' volume against the
 * opening range's average bar (today, once it has closed), the 20 bars before,
 * and the same time on the previous day in the data.
 */
function participation(bars, orbMinutes) {
  const i = bars.length - 1;
  const vol = b => (Number.isFinite(b.v) ? b.v : 0);
  const last3 = mean(bars.slice(-3).map(vol));
  const prior20 = mean(bars.slice(Math.max(0, i - 23), i - 2).map(vol));
  const now = etMinute(bars[i].t);
  const orBars = bars.filter(b => { const e = etMinute(b.t); return e.day === now.day && e.minute >= RTH_OPEN && e.minute < RTH_OPEN + orbMinutes; });
  const orAvg = now.minute >= RTH_OPEN + orbMinutes && orBars.length ? mean(orBars.map(vol)) : null;
  const yesterday = [...bars].reverse().find(b => { const e = etMinute(b.t); return e.day !== now.day && e.minute === now.minute; });
  return {
    lastBarVolume: vol(bars[i]),
    relVolLastVsOpeningRange: ratio(vol(bars[i]), orAvg),
    relVolLast3VsOpeningRange: ratio(last3, orAvg),
    relVolLast3VsPrior20: ratio(last3, prior20),
    relVolVsSameTimePriorDay: yesterday ? ratio(vol(bars[i]), vol(yesterday)) : null,
    note: 'relative volume = this volume / that average; under 1.0 is thin participation, 1.5+ strong',
  };
}

/** Closes crossing a VWAP over the last `n` bars (where it has a value): many crosses = rotation, few = trend. */
function vwapCrosses(bars, vwap, n = 30) {
  let crosses = 0;
  let side = 0;
  for (let i = Math.max(0, bars.length - n); i < bars.length; i += 1) {
    if (!Number.isFinite(vwap[i])) continue;
    const s2 = Math.sign(bars[i].c - vwap[i]);
    if (s2 !== 0 && side !== 0 && s2 !== side) crosses += 1;
    if (s2 !== 0) side = s2;
  }
  return crosses;
}

/**
 * Liquidity: the last 4 confirmed swing highs and lows, equal highs and lows
 * among them (within 0.1 x ATR(14): resting stops), and the open fair value
 * gaps of the last 60 bars (3-bar gaps price hasn't traded back through).
 */
function liquidity(bars, k, atrNow) {
  const highs = [];
  const lows = [];
  for (let j = k; j < bars.length - k; j += 1) {
    let hi = true;
    let lo = true;
    for (let m = j - k; m <= j + k; m += 1) {
      if (m === j) continue;
      if (!(bars[j].h > bars[m].h)) hi = false;
      if (!(bars[j].l < bars[m].l)) lo = false;
    }
    if (hi) highs.push({ price: bars[j].h, t: bars[j].t });
    if (lo) lows.push({ price: bars[j].l, t: bars[j].t });
  }
  const tol = atrNow ? 0.1 * atrNow : 0;
  const equal = list => {
    const out = [];
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        if (Math.abs(list[a].price - list[b].price) <= tol) out.push({ prices: [list[a].price, list[b].price], at: [list[a].t, list[b].t] });
      }
    }
    return out.slice(-3);
  };
  const recentHighs = highs.slice(-12);
  const recentLows = lows.slice(-12);
  const fvgs = [];
  for (let j = Math.max(2, bars.length - 60); j < bars.length; j += 1) {
    const a = bars[j - 2];
    const c = bars[j];
    const later = bars.slice(j + 1);
    if (a.h < c.l && !later.some(b => b.l <= a.h)) fvgs.push({ side: 'bullish', low: a.h, high: c.l, at: bars[j - 1].t });
    if (a.l > c.h && !later.some(b => b.h >= a.l)) fvgs.push({ side: 'bearish', low: c.h, high: a.l, at: bars[j - 1].t });
  }
  return {
    swingHighs: highs.slice(-4),
    swingLows: lows.slice(-4),
    equalHighs: equal(recentHighs),
    equalLows: equal(recentLows),
    openFvgs: fvgs.slice(-3),
    note: 'equal = within 0.1 x ATR(14); open FVG = a 3-bar gap price has not traded back into since (last 60 bars)',
  };
}

function snapshot(input, overrides = {}) {
  const bars = ind.normalizeBars(input);
  if (bars.length < 3) throw new Error(`need at least 3 bars, got ${bars.length}`);
  const series = signalSeries(bars, overrides);
  const { p, closes, emaFast, emaSlow, adx, atrStop, st, kc, sw, or } = series;
  const i = bars.length - 1;
  const ema50 = ind.ema(closes, 50);
  const ema200 = ind.ema(closes, 200);
  const atr14 = ind.atr(bars, 14);
  const vwapSession = ind.anchoredVwap(bars, GLOBEX_OPEN);
  const vwapRth = ind.anchoredVwap(bars, RTH_OPEN, RTH_CLOSE);

  const adxNow = at(adx, i);
  const adxSlope = adxNow !== null && at(adx, i - p.adxSlopeBars) !== null ? adxNow - adx[i - p.adxSlopeBars] : null;
  const stopDistance = at(atrStop, i) === null ? null : p.stopAtrMult * atrStop[i];

  const last = bars[i];
  return {
    bars: bars.length,
    from: bars[0].t,
    last: { t: last.t, o: last.o, h: last.h, l: last.l, c: last.c, v: last.v },
    trend: {
      emaFast: round(at(emaFast, i)), emaSlow: round(at(emaSlow, i)), ema50: round(at(ema50, i)),
      ema200: bars.length >= 200 ? round(at(ema200, i)) : null,
      adx: round(adxNow, 2), adxSlope: round(adxSlope, 2),
      supertrend: { direction: at(st.direction, i) === 1 ? 'up' : at(st.direction, i) === -1 ? 'down' : null, line: round(at(st.line, i)) },
      keltner: { upper: round(at(kc.upper, i)), mid: round(at(kc.mid, i)), lower: round(at(kc.lower, i)) },
    },
    volatility: { atr14: round(at(atr14, i)), atr20: round(at(atrStop, i)) },
    structure: {
      lastSwingHigh: at(sw.high, i), lastSwingHighAt: sw.highIdx[i] >= 0 ? bars[sw.highIdx[i]].t : null,
      lastSwingLow: at(sw.low, i), lastSwingLowAt: sw.lowIdx[i] >= 0 ? bars[sw.lowIdx[i]].t : null,
    },
    levels: {
      ...levels(bars),
      openingRange: at(or.high, i) === null ? null : { high: or.high[i], low: or.low[i], minutes: p.orbMinutes },
      vwapSession: round(at(vwapSession, i)),
      vwapRth: round(at(vwapRth, i)),
    },
    vwap: {
      // RTH VWAP exists 09:30-16:00 ET; outside it the session VWAP (18:00 ET anchor) applies, as in the strategy filters.
      applies: at(vwapRth, i) !== null ? 'rth' : 'session',
      distanceAtr: (() => { const v = at(vwapRth, i) ?? at(vwapSession, i); const a = at(atr14, i); return v !== null && a ? round((last.c - v) / a, 2) : null; })(),
      rthCrossesLast30: vwapCrosses(bars, vwapRth),
      sessionCrossesLast30: vwapCrosses(bars, vwapSession),
    },
    participation: participation(bars, p.orbMinutes),
    liquidity: liquidity(bars, p.swingK, at(atr14, i)),
    regime: classifyRegime(bars),
    referenceStop: stopDistance === null ? null : {
      distance: round(stopDistance),
      long: round(last.c - stopDistance),
      short: round(last.c + stopDistance),
      note: `${p.stopAtrMult} x ATR(${p.atrStop}) as trained in algoTraderBot; round to tickSize and widen to structure if the strategy says so`,
    },
    params: p,
  };
}

module.exports = { PARAMS, snapshot, signalSeries, levels };
