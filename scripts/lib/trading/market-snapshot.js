'use strict';

/**
 * Summarise bars into the numbers the analyst agents and strategies use:
 * trend/momentum values, key levels, and which mechanical strategy triggers
 * fired on the last closed bar. Parameters follow the original bot's config.py.
 */

const ind = require('./indicators');
const { classifyRegime, vwapCrosses: crossesOf, REGIME_PARAMS } = require('./regime');
const { zonedParts } = require('./clock');
const vp = require('./volume-profile');
const dayContext = require('./day-context');
const { onTick, levelOnTick } = require('./contracts');
const { SNAPSHOT_PARAMS: SNAPSHOT_CISD } = require('./cisd');
const { closeLocation } = require('./candle-facts');

const PARAMS = {
  emaFast: 9, emaSlow: 20, adxPeriod: 14, adxSlopeBars: 5,
  stPeriod: 10, stMult: 3,
  kcLen: 20, kcMult: 1.5, kcAtr: 20,
  swingK: 2,
  orbMinutes: 15,
  atrStop: 20, stopAtrMult: 0.5,
  // Candle Range Theory sweeps (crt_dir / crt_risk / crt_target, scripts/lib/trading/crt.js).
  crtSweepBars: 10, crtShiftBars: 5, crtMaxDepth: 0.5, crtMinRangeAtr: 2, crtBufferAtr: 0.25, crtMinRR: 2,
  // CISD and its OTE bounce (cisd_* / ote_* / in_ote series, scripts/lib/trading/cisd.js): defaults and meaning there.
  ...SNAPSHOT_CISD,
  // Volume profile settings (vpRows, vpRowSize, ...): defaults and meaning in volume-profile.js.
  ...vp.PARAM_DEFAULTS,
  vpLookback: 360, // bars in the snapshot's rolling profile
  adrDays: 10, // days in the average daily range (day-context.js)
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


/**
 * The RTH days in the bars by ET date ({ open, high, low, close, whole }), and the dates complete by the last bar (its
 * 16:00 ET close passed), oldest first. A day whose 09:30 bar isn't in the data is partial (whole false).
 */
function rthDaysOf(bars) {
  const lastEt = etDayMinute(bars[bars.length - 1].t);
  const days = new Map();
  for (const b of bars) {
    const { day, minute } = etDayMinute(b.t);
    if (minute < RTH_OPEN || minute >= RTH_CLOSE) continue;
    const d = days.get(day) || { open: b.o, high: -Infinity, low: Infinity, close: null, whole: minute === RTH_OPEN };
    d.high = Math.max(d.high, b.h); d.low = Math.min(d.low, b.l); d.close = b.c;
    days.set(day, d);
  }
  const complete = [...days.keys()].filter(d => d < lastEt.day || (d === lastEt.day && lastEt.minute >= RTH_CLOSE)).sort();
  return { days, complete };
}

function levels(bars) {
  const last = bars[bars.length - 1];
  const session = ind.sessionKey(last.t, GLOBEX_OPEN);
  // A day whose 09:30 bar isn't in the data is partial: no levels from it (as the rules engine).
  const { days: rthDays, complete } = rthDaysOf(bars);
  let onHigh = null; let onLow = null;
  for (const b of bars) {
    const { minute } = etDayMinute(b.t);
    if (minute >= RTH_OPEN && minute < RTH_CLOSE) continue;
    if (ind.sessionKey(b.t, GLOBEX_OPEN) === session && !(minute >= RTH_CLOSE && minute < GLOBEX_OPEN)) {
      onHigh = onHigh === null ? b.h : Math.max(onHigh, b.h);
      onLow = onLow === null ? b.l : Math.min(onLow, b.l);
    }
  }
  const priorDays = complete.filter(d => rthDays.get(d).whole);
  // The overnight session counts only if the data starts before it (its 18:00 ET open is in the data).
  const overnightWhole = ind.sessionKey(bars[0].t, GLOBEX_OPEN) !== session || etDayMinute(bars[0].t).minute === GLOBEX_OPEN;
  const prior = priorDays.length ? rthDays.get(priorDays[priorDays.length - 1]) : null;
  return {
    priorRth: prior ? { day: priorDays[priorDays.length - 1], high: prior.high, low: prior.low, close: prior.close } : null,
    overnight: onHigh === null || !overnightWhole ? null : { high: onHigh, low: onLow },
  };
}

/**
 * The prior RTH day (levels().priorRth: the last whole day complete by the last bar) as a daily candle: its open
 * (the 09:30 bar's), its direction (close against open), where it closed in its range (candle-facts closeLocation:
 * the top, middle or bottom third), and where it closed against the RTH day before it: above its high, below its low,
 * or inside its range. `dayBefore` is the RTH day just before it in the data, null when that day is partial (no 09:30
 * bar) or not in the bars. Null without a prior RTH day. Causal: it reads days complete by the last bar only.
 */
function priorDayCandle(bars) {
  if (!bars.length) return null;
  const { days, complete } = rthDaysOf(bars);
  const k = complete.map(d => days.get(d).whole).lastIndexOf(true);
  if (k < 0) return null;
  const p = days.get(complete[k]);
  const q = k > 0 && days.get(complete[k - 1]).whole ? { day: complete[k - 1], ...days.get(complete[k - 1]) } : null;
  return {
    day: complete[k],
    open: p.open,
    dir: p.close > p.open ? 'up' : p.close < p.open ? 'down' : 'flat',
    closeLocation: closeLocation({ o: p.open, h: p.high, l: p.low, c: p.close }),
    dayBefore: q ? { day: q.day, high: q.high, low: q.low } : null,
    closeVsDayBefore: !q ? null : p.close > q.high ? 'above its high' : p.close < q.low ? 'below its low' : 'inside its range',
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
  // By trading day (from the 18:00 ET open): the evening session has no opening range yet.
  const dayOf = b => ind.sessionKey(b.t, GLOBEX_OPEN);
  const now = { ...etMinute(bars[i].t), day: dayOf(bars[i]) };
  const orBars = bars.filter(b => { const e = etMinute(b.t); return dayOf(b) === now.day && e.minute >= RTH_OPEN && e.minute < RTH_OPEN + orbMinutes; });
  const orAvg = now.minute >= RTH_OPEN + orbMinutes && orBars.length ? mean(orBars.map(vol)) : null;
  const yesterday = [...bars].reverse().find(b => dayOf(b) !== now.day && etMinute(b.t).minute === now.minute);
  return {
    lastBarVolume: vol(bars[i]),
    relVolLastVsOpeningRange: ratio(vol(bars[i]), orAvg),
    relVolLast3VsOpeningRange: ratio(last3, orAvg),
    relVolLast3VsPrior20: ratio(last3, prior20),
    relVolVsSameTimePriorDay: yesterday ? ratio(vol(bars[i]), vol(yesterday)) : null,
    note: 'relative volume = this volume / that average; under 1.0 is thin participation, 1.5+ strong',
  };
}

/**
 * Closes crossing a VWAP over the last 30 bars: counted as the regime counts them (regime.js), so the session
 * VWAP's count is the regime's own `sessionVwapCrosses`.
 */
const vwapCrosses = (bars, vwap) => crossesOf(bars, vwap, bars.length - REGIME_PARAMS.crossBars);

/**
 * The fair value gaps of the last `n` bars (3-bar gaps: bar 1's high under bar 3's low, bullish, or bar 1's low
 * over bar 3's high, bearish), by what the bars since have done to them: open (not traded back into), partly filled
 * (traded into, not through: low-high is the part still unfilled, gapLow-gapHigh the whole gap), and filled (traded
 * through: dropped). Oldest first.
 */
function fairValueGaps(bars, n = 60) {
  const open = [];
  const partly = [];
  for (let j = Math.max(2, bars.length - n); j < bars.length; j += 1) {
    const a = bars[j - 2];
    const c = bars[j];
    const later = bars.slice(j + 1);
    const at = bars[j - 1].t;
    if (a.h < c.l) {
      // Bullish: price comes back down into it; the deepest low since is how far it filled.
      const deepest = later.length ? Math.min(...later.map(b => b.l)) : Infinity;
      if (deepest >= c.l) open.push({ side: 'bullish', low: a.h, high: c.l, at });
      else if (deepest > a.h) partly.push({ side: 'bullish', low: a.h, high: deepest, gapLow: a.h, gapHigh: c.l, at });
    }
    if (a.l > c.h) {
      // Bearish: price comes back up into it; the highest high since is how far it filled.
      const highest = later.length ? Math.max(...later.map(b => b.h)) : -Infinity;
      if (highest <= c.h) open.push({ side: 'bearish', low: c.h, high: a.l, at });
      else if (highest < a.l) partly.push({ side: 'bearish', low: highest, high: a.l, gapLow: c.h, gapHigh: a.l, at });
    }
  }
  return { open, partly };
}

/**
 * Liquidity: the last 4 confirmed swing highs and lows, equal highs and lows
 * among them (within 0.1 x ATR(14): resting stops), and the fair value gaps
 * of the last 60 bars still open and partly filled (fairValueGaps).
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
  const { open, partly } = fairValueGaps(bars);
  return {
    swingHighs: highs.slice(-4),
    swingLows: lows.slice(-4),
    equalHighs: equal(recentHighs),
    equalLows: equal(recentLows),
    openFvgs: open.slice(-3),
    partlyFilledFvgs: partly.slice(-3),
    note: 'equal = within 0.1 x ATR(14); open FVG = a 3-bar gap price has not traded back into since; partly filled FVG = traded into, not through: low-high is the part still unfilled, gapLow-gapHigh the whole gap (last 60 bars)',
  };
}

/**
 * The numbers the strategies' context filters and skip rules talk about, so
 * none has to be eyeballed: EMA crosses, ADX falling, the Keltner squeeze and
 * band-close streak, SuperTrend flips, the last 5 bars' range, the session's
 * high and low so far, and the last bar's volume against its 60-bar average.
 */
function context(bars, series, atrNow) {
  const { emaFast, emaSlow, adx, st, kc } = series;
  const n = bars.length;
  const i = n - 1;
  const from = k => Math.max(1, n - k);
  let crosses = 0;
  for (let j = from(30); j < n; j += 1) {
    const a = Math.sign(emaFast[j] - emaSlow[j]);
    const b = Math.sign(emaFast[j - 1] - emaSlow[j - 1]);
    if (a && b && a !== b) crosses += 1;
  }
  let falling = 0;
  for (let j = i; j > 0 && Number.isFinite(adx[j]) && adx[j] < adx[j - 1]; j -= 1) falling += 1;
  const width = j => kc.upper[j] - kc.lower[j];
  const widths = [];
  for (let j = Math.max(0, n - 20); j < n; j += 1) if (Number.isFinite(width(j))) widths.push(width(j));
  const avgWidth = widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : null;
  let streak = 0;
  const outside = j => (bars[j].c > kc.upper[j] ? 1 : bars[j].c < kc.lower[j] ? -1 : 0);
  const side = outside(i);
  for (let j = i; j >= 0 && side !== 0 && outside(j) === side; j -= 1) streak += 1;
  let flips = 0;
  for (let j = from(20); j < n; j += 1) if (st.direction[j] && st.direction[j - 1] && st.direction[j] !== st.direction[j - 1]) flips += 1;
  const last5 = bars.slice(-5);
  const session = ind.sessionKey(bars[i].t, GLOBEX_OPEN);
  const inSession = bars.filter(b => ind.sessionKey(b.t, GLOBEX_OPEN) === session);
  const sessionWhole = ind.sessionKey(bars[0].t, GLOBEX_OPEN) !== session || etDayMinute(bars[0].t).minute === GLOBEX_OPEN;
  const vol = bars.slice(-60).map(b => Number(b.v) || 0);
  const volAvg = vol.length && vol.some(v => v > 0) ? vol.reduce((a, b) => a + b, 0) / vol.length : null;
  return {
    emaCrossesLast30: crosses,
    adxFallingBars: falling,
    keltnerWidthVsAvg20: avgWidth ? round(width(i) / avgWidth, 2) : null,
    bandCloseStreak: side ? { side: side > 0 ? 'above' : 'below', bars: streak } : null,
    supertrendFlipsLast20: flips,
    range5Atr: atrNow ? round((Math.max(...last5.map(b => b.h)) - Math.min(...last5.map(b => b.l))) / atrNow, 2) : null,
    session: sessionWhole ? { high: Math.max(...inSession.map(b => b.h)), low: Math.min(...inSession.map(b => b.l)) } : null,
    volVsAvg60: volAvg ? round((Number(bars[i].v) || 0) / volAvg, 2) : null,
  };
}

/**
 * Volume profile at the last bar: the prior RTH day's, this Globex session's
 * (developing), and the last vpLookback bars' (rolling), each with POC,
 * value area, nodes, and where price is (scripts/lib/trading/volume-profile.js).
 */
function volumeProfile(bars, p, atrNow, level) {
  const i = bars.length - 1;
  const options = vp.optionsFromParams(p);
  const r = x => round(x, 2);
  const one = (kind, length) => vp.describe(vp.profileAt(bars, kind, i, { length, options }), bars[i].c, atrNow, r, level);
  return {
    priorRth: one('prior_rth'),
    session: one('session'),
    rolling: bars.length >= p.vpLookback ? one('rolling', p.vpLookback) : null,
    note: `bar-based approximation (each bar's volume spread over its range), ${options.rowSize > 0 ? `${options.rowSize}-point rows` : `${options.rows} rows`}, ${Math.round(options.valueArea * 100)}% value area; fromPocAtr = (price - POC) / ATR(14)`,
  };
}

/**
 * The snapshot of `input` (bars, or { bars, tickSize, exactLevels }): with the contract's tickSize, the volume
 * profile's levels (row centers, off the grid) are given on its tick (contracts.js levelOnTick); without it, to two
 * decimals; with exactLevels, unrounded (for a caller that rounds them itself, as the briefing does).
 */
function snapshot(input, overrides = {}) {
  const bars = ind.normalizeBars(input);
  const tickSize = input && !Array.isArray(input) && input.tickSize > 0 ? input.tickSize : null;
  const exact = Boolean(input && !Array.isArray(input) && input.exactLevels);
  const level = x => (x === null || x === undefined ? null : exact ? x : tickSize ? levelOnTick(x, tickSize) : round(x, 2));
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
    volumeProfile: volumeProfile(bars, p, at(atr14, i), level),
    // The day so far: the open against the prior day, the opening type, the initial balance, the day type, the range against the ADR.
    day: (() => {
      const d = dayContext.dayContextSeries(bars, { adrDays: p.adrDays, params: p }).day[i];
      if (!d) return null;
      // The prior day's profile levels on the tick, as the volume profile's (its high, low and close are traded prices).
      const prior = d.prior && tickSize ? { ...d.prior, ...Object.fromEntries(['val', 'poc', 'vah'].filter(k => Number.isFinite(d.prior[k])).map(k => [k, level(d.prior[k])])) } : d.prior;
      return { ...d, prior, line: dayContext.describeDay(d, tickSize ? { round: x => onTick(x, tickSize), level } : {}) };
    })(),
    participation: participation(bars, p.orbMinutes),
    context: context(bars, series, at(atr14, i)),
    liquidity: liquidity(bars, p.swingK, at(atr14, i)),
    regime: classifyRegime(bars),
    referenceStop: stopDistance === null ? null : {
      distance: round(stopDistance),
      long: round(last.c - stopDistance),
      short: round(last.c + stopDistance),
      note: `${p.stopAtrMult} x ATR(${p.atrStop}) as trained in the original bot; round to tickSize and widen to structure if the strategy says so`,
    },
    params: p,
  };
}

/**
 * The key levels as the snapshot of the bars up to and including bar i gives them (the same code, on bars 0..i only):
 * the prior RTH day, the overnight range, the opening range once complete, the session and RTH VWAP (and which
 * applies), the prior day's and the session's POC/VAH/VAL, and the initial balance once complete. For a completed
 * candle read against the levels as they stood at its close (candle-facts.js; the briefing).
 */
// The whole-series parts levelsAsOf reads at a bar, once per bars array (each a causal series: its value at bar i reads
// bars 0..i only, as the snapshot of bars 0..i computes it).
const AS_OF = new WeakMap();
function levelsAsOf(bars, i, overrides = {}) {
  const p = { ...PARAMS, ...overrides };
  const options = vp.optionsFromParams(p);
  const key = JSON.stringify(p);
  if (!AS_OF.has(bars) || AS_OF.get(bars).key !== key) {
    AS_OF.set(bars, {
      key,
      or: ind.openingRange(bars, p.orbMinutes),
      vwapSession: ind.anchoredVwap(bars, GLOBEX_OPEN),
      vwapRth: ind.anchoredVwap(bars, RTH_OPEN, RTH_CLOSE),
      prior: vp.profileSeries(bars, 'prior_rth', { options }).profile,
      day: dayContext.dayContextSeries(bars, { adrDays: p.adrDays, params: p }).day,
    });
  }
  const s = AS_OF.get(bars);
  const upTo = bars.slice(0, i + 1);
  const three = x => (x ? { poc: round(x.poc, 2), vah: round(x.vah, 2), val: round(x.val, 2) } : null);
  const vwapRth = at(s.vwapRth, i);
  const d = s.day[i];
  return {
    ...levels(upTo),
    openingRange: at(s.or.high, i) === null ? null : { high: s.or.high[i], low: s.or.low[i] },
    vwapSession: round(at(s.vwapSession, i)),
    vwapRth: round(vwapRth),
    vwapApplies: vwapRth !== null ? 'rth' : 'session',
    priorProfile: three(s.prior[i]),
    sessionProfile: three(vp.profileAt(bars, 'session', i, { options })),
    ib: d ? { high: d.ibHigh ?? null, low: d.ibLow ?? null } : null,
  };
}

module.exports = { PARAMS, snapshot, signalSeries, levels, priorDayCandle, volumeProfile, fairValueGaps, levelsAsOf };
