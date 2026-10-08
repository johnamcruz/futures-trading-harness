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
