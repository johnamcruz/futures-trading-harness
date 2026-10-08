'use strict';

/**
 * Deterministic, causal indicators over OHLCV bars, so agents don't do
 * indicator math in their heads. Definitions follow algoTraderBot/indicators.py:
 * EMA = pandas ewm(adjust=False); ATR and ADX use Wilder smoothing.
 * Every array is aligned to the bars; warm-up values are NaN.
 */

const { zonedParts } = require('./clock');

const ET = 'America/New_York';

/** Accept a projectx-mcp get_bars result ({bars:[{t,o,h,l,c,v}]}) or a bare array. */
function normalizeBars(input) {
  const raw = Array.isArray(input) ? input : input && Array.isArray(input.bars) ? input.bars : null;
  if (!raw) throw new Error('expected get_bars output ({ bars: [...] }) or an array of bars');
  return raw
    .map(b => ({
      t: String(b.t ?? b.time),
      o: Number(b.o ?? b.open),
      h: Number(b.h ?? b.high),
      l: Number(b.l ?? b.low),
      c: Number(b.c ?? b.close),
      v: Number(b.v ?? b.volume ?? 0),
    }))
    .filter(b => Number.isFinite(Date.parse(b.t)) && [b.o, b.h, b.l, b.c].every(Number.isFinite))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

function ema(values, span) {
  const alpha = 2 / (span + 1);
  const out = new Array(values.length).fill(NaN);
  let prev = NaN;
  values.forEach((x, i) => {
    prev = Number.isNaN(prev) ? x : alpha * x + (1 - alpha) * prev;
    out[i] = prev;
  });
  return out;
}

/** Wilder smoothing: first value = mean of the first `period` inputs starting at `from`. */
function wilder(values, period, from = 0) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < from + period) return out;
  let sum = 0;
  for (let i = from; i < from + period; i += 1) sum += values[i];
  let prev = sum / period;
  out[from + period - 1] = prev;
  for (let i = from + period; i < values.length; i += 1) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

function trueRange(bars) {
  return bars.map((b, i) => (i === 0
    ? b.h - b.l
    : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
}

function atr(bars, period = 14) {
  return wilder(trueRange(bars), period, 1);
}

function adx(bars, period = 14) {
  const n = bars.length;
  const plusDm = new Array(n).fill(0);
  const minusDm = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const up = bars[i].h - bars[i - 1].h;
    const down = bars[i - 1].l - bars[i].l;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  const tr = wilder(trueRange(bars), period, 1);
  const pdm = wilder(plusDm, period, 1);
  const mdm = wilder(minusDm, period, 1);
  const dx = new Array(n).fill(NaN);
  for (let i = 0; i < n; i += 1) {
    if (Number.isNaN(tr[i])) continue;
    if (tr[i] === 0) { dx[i] = 0; continue; } // flat bars: no directional movement (as the source does)
    const pdi = (100 * pdm[i]) / tr[i];
    const mdi = (100 * mdm[i]) / tr[i];
    dx[i] = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  }
  return wilder(dx, period, period);
}

/** SuperTrend: { line, direction } with direction +1 bull / -1 bear. */
function supertrend(bars, period = 10, mult = 3) {
  const a = atr(bars, period);
  const n = bars.length;
  const line = new Array(n).fill(NaN);
  const direction = new Array(n).fill(NaN);
  let upper = NaN;
  let lower = NaN;
  let dir = 1;
  for (let i = 0; i < n; i += 1) {
    if (Number.isNaN(a[i])) continue;
    const mid = (bars[i].h + bars[i].l) / 2;
    const basicUpper = mid + mult * a[i];
    const basicLower = mid - mult * a[i];
    const prevClose = i > 0 ? bars[i - 1].c : bars[i].c;
    upper = Number.isNaN(upper) || basicUpper < upper || prevClose > upper ? basicUpper : upper;
    lower = Number.isNaN(lower) || basicLower > lower || prevClose < lower ? basicLower : lower;
    if (bars[i].c > upper) dir = 1;
    else if (bars[i].c < lower) dir = -1;
    direction[i] = dir;
    line[i] = dir === 1 ? lower : upper;
  }
  return { line, direction };
}

function keltner(bars, emaLen = 20, mult = 1.5, atrPeriod = 20) {
  const mid = ema(bars.map(b => b.c), emaLen);
  const a = atr(bars, atrPeriod);
  return {
    upper: mid.map((m, i) => m + mult * a[i]),
    mid,
    lower: mid.map((m, i) => m - mult * a[i]),
  };
}

/** Most recent confirmed fractal swing high/low at each bar (confirmed k bars after the pivot). */
function swings(bars, k = 2) {
  const n = bars.length;
  const high = new Array(n).fill(NaN);
  const low = new Array(n).fill(NaN);
  const highIdx = new Array(n).fill(-1);
  const lowIdx = new Array(n).fill(-1);
  let sh = NaN; let sl = NaN; let shi = -1; let sli = -1;
  for (let i = 0; i < n; i += 1) {
    const j = i - k;
    if (j - k >= 0) {
      let isHigh = true; let isLow = true;
      for (let m = j - k; m <= j + k; m += 1) {
        if (m === j) continue;
        if (!(bars[j].h > bars[m].h)) isHigh = false;
        if (!(bars[j].l < bars[m].l)) isLow = false;
      }
      if (isHigh) { sh = bars[j].h; shi = j; }
      if (isLow) { sl = bars[j].l; sli = j; }
    }
    high[i] = sh; low[i] = sl; highIdx[i] = shi; lowIdx[i] = sli;
  }
  return { high, low, highIdx, lowIdx };
}

// New York day/minute per timestamp, memoized: the same bars are seen again
// on every closed bar (live) and in every window (backtests).
const ET_CACHE = new Map();
function etInfo(t) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  let v = ET_CACHE.get(ms);
  if (!v) {
    const p = zonedParts(new Date(ms), ET);
    v = { day: `${p.year}-${p.month}-${p.day}`, minute: p.hour * 60 + p.minute };
    if (ET_CACHE.size > 500000) ET_CACHE.clear();
    ET_CACHE.set(ms, v);
  }
  return v;
}

/**
 * Opening range of the first `minutes` from `openMin` (ET) each day. Active only
 * on bars after the range has closed (fully in the past), NaN otherwise.
 */
function openingRange(bars, minutes = 15, openMin = 9 * 60 + 30) {
  const n = bars.length;
  const high = new Array(n).fill(NaN);
  const low = new Array(n).fill(NaN);
  let day = null; let oh = NaN; let ol = NaN;
  for (let i = 0; i < n; i += 1) {
    const { day: d, minute } = etInfo(bars[i].t);
    if (d !== day) { day = d; oh = NaN; ol = NaN; }
    if (minute >= openMin && minute < openMin + minutes) {
      oh = Number.isNaN(oh) ? bars[i].h : Math.max(oh, bars[i].h);
      ol = Number.isNaN(ol) ? bars[i].l : Math.min(ol, bars[i].l);
    } else if (minute >= openMin + minutes) {
      high[i] = oh; low[i] = ol;
    }
  }
  return { high, low };
}

/**
 * Session key for an anchor time: bars at or after `anchorMin` ET belong to the
 * next key, so the key changes exactly at the anchor (18:00 Globex, 09:30 RTH).
 */
function sessionKey(t, anchorMin) {
  return etInfo(Date.parse(t) + (24 * 60 - anchorMin) * 60000).day;
}

/**
 * VWAP anchored at `anchorMin` ET. With `untilMin`, bars at or after that time
 * (or before the anchor) are outside the session and get NaN (RTH: 570 to 960).
 */
function anchoredVwap(bars, anchorMin, untilMin = null) {
  const out = new Array(bars.length).fill(NaN);
  let key = null; let pv = 0; let vol = 0;
  for (let i = 0; i < bars.length; i += 1) {
    if (untilMin !== null) {
      const { minute } = etInfo(bars[i].t);
      if (minute < anchorMin || minute >= untilMin) continue;
    }
    const k = sessionKey(bars[i].t, anchorMin);
    if (k !== key) { key = k; pv = 0; vol = 0; }
    pv += ((bars[i].h + bars[i].l + bars[i].c) / 3) * bars[i].v;
    vol += bars[i].v;
    out[i] = vol > 0 ? pv / vol : NaN;
  }
  return out;
}

module.exports = {
  normalizeBars,
  ema,
  wilder,
  trueRange,
  atr,
  adx,
  supertrend,
  keltner,
  swings,
  openingRange,
  sessionKey,
  anchoredVwap,
};
