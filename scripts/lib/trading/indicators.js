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
/** Real order flow on a bar (aggressive buy and sell volume), when it has it. */
function flowFields(b) {
  const bv = Number(b.bv ?? b.buy_volume);
  const sv = Number(b.sv ?? b.sell_volume);
  return b.bv !== undefined || b.buy_volume !== undefined ? (Number.isFinite(bv) && Number.isFinite(sv) ? { bv, sv } : {}) : {};
}

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
      ...flowFields(b),
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

/**
 * Wilder smoothing (RMA), as futures_foundation's _rma: the first value, at
 * index period-1, is the mean of the first `period` inputs; NaN before that.
 */
function rma(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev += (values[i] - prev) / period;
    out[i] = prev;
  }
  return out;
}

function trueRange(bars) {
  return bars.map((b, i) => (i === 0
    ? b.h - b.l
    : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
}

/** Wilder ATR (compute_atr): first value at index period-1, including the first bar's range. */
function atr(bars, period = 14) {
  return rma(trueRange(bars), period);
}

/**
 * Wilder ADX (compute_adx), warm-up included: NaN for fewer than 2*period
 * bars; DX is 0 where the smoothed ranges aren't defined yet or are flat, so
 * the first ADX value lands at index period-1.
 */
function adx(bars, period = 14) {
  const n = bars.length;
  if (n < 2 * period) return new Array(n).fill(NaN);
  const plusDm = new Array(n).fill(0);
  const minusDm = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const up = bars[i].h - bars[i - 1].h;
    const down = bars[i - 1].l - bars[i].l;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  const tr = rma(trueRange(bars), period);
  const pdm = rma(plusDm, period);
  const mdm = rma(minusDm, period);
  const dx = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const pdi = (100 * pdm[i]) / tr[i];
    const mdi = (100 * mdm[i]) / tr[i];
    const denom = pdi + mdi;
    dx[i] = denom > 0 ? (100 * Math.abs(pdi - mdi)) / denom : 0; // NaN or 0/0 -> 0, as numpy.where does
  }
  return rma(dx, period);
}

/**
 * SuperTrend (compute_supertrend): Wilder ATR bands on hl2, final bands
 * carried while finite, and the source's state machine: direction starts at
 * +1, flips short when a close is below the final lower band while long, and
 * long when a close is above the final upper band while short.
 * Returns { line, direction } with direction +1 bull / -1 bear.
 */
function supertrend(bars, period = 10, mult = 3) {
  const a = atr(bars, period);
  const n = bars.length;
  const upper = bars.map((b, i) => (b.h + b.l) / 2 + mult * a[i]);
  const lower = bars.map((b, i) => (b.h + b.l) / 2 - mult * a[i]);
  const fUp = upper.slice();
  const fLo = lower.slice();
  for (let i = 1; i < n; i += 1) {
    if (!(Number.isFinite(fUp[i - 1]) && Number.isFinite(fLo[i - 1]))) continue;
    if (!(upper[i] < fUp[i - 1] || bars[i - 1].c > fUp[i - 1])) fUp[i] = fUp[i - 1];
    if (!(lower[i] > fLo[i - 1] || bars[i - 1].c < fLo[i - 1])) fLo[i] = fLo[i - 1];
  }
  const direction = new Array(n).fill(1);
  const line = new Array(n).fill(NaN);
  for (let i = 1; i < n; i += 1) {
    const c = bars[i].c;
    if (direction[i - 1] === 1 && c < fLo[i]) direction[i] = -1;
    else if (direction[i - 1] === -1 && c > fUp[i]) direction[i] = 1;
    else direction[i] = direction[i - 1];
    line[i] = direction[i] === 1 ? fLo[i] : fUp[i];
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
 * A session already under way at the first bar is partial: NaN, not a VWAP
 * of whatever part the bars happen to hold.
 */
function anchoredVwap(bars, anchorMin, untilMin = null) {
  const out = new Array(bars.length).fill(NaN);
  let key = null; let pv = 0; let vol = 0; let complete = false;
  for (let i = 0; i < bars.length; i += 1) {
    if (untilMin !== null) {
      const { minute } = etInfo(bars[i].t);
      if (minute < anchorMin || minute >= untilMin) continue;
    }
    const k = sessionKey(bars[i].t, anchorMin);
    if (k !== key) { key = k; pv = 0; vol = 0; complete = i > 0; }
    pv += ((bars[i].h + bars[i].l + bars[i].c) / 3) * bars[i].v;
    vol += bars[i].v;
    out[i] = complete && vol > 0 ? pv / vol : NaN;
  }
  return out;
}

/**
 * Order flow per bar. With real flow (bv/sv: aggressive buy and sell volume,
 * recorded from the TopstepX market hub or in the data file) it is bv - sv.
 * Otherwise it is estimated from the bar (no bid/ask split needed): volume signed by
 * where it closed in its range, v * ((c - l) - (h - c)) / (h - l). A close
 * at the high is all buying, at the low all selling, mid-range balanced. A
 * bar with no range takes the sign of its close against the prior close.
 */
function barDelta(bars) {
  return bars.map((b, i) => {
    if (hasFlow(b)) return b.bv - b.sv;
    const v = Number(b.v) || 0;
    const range = b.h - b.l;
    if (range > 0) return (v * ((b.c - b.l) - (b.h - b.c))) / range;
    const prev = i > 0 ? bars[i - 1].c : b.c;
    return v * Math.sign(b.c - prev);
  });
}

/**
 * Order-flow imbalance over the last n bars: summed bar delta over summed
 * volume, from -1 (all selling) to +1 (all buying). NaN until n bars exist
 * or when they traded no volume.
 */
// Real flow counts only when it accounts for most of the bar's volume (a
// feed that missed prints must not read as a confident imbalance).
const hasFlow = b => Number.isFinite(b.bv) && Number.isFinite(b.sv) && !(Number(b.v) > 0 && b.bv + b.sv < 0.5 * Number(b.v));

function ofi(bars, n) {
  const d = barDelta(bars);
  return bars.map((_, i) => {
    if (i + 1 < n) return NaN;
    let sd = 0;
    let sv = 0;
    for (let k = i + 1 - n; k <= i; k += 1) { sd += d[k]; sv += hasFlow(bars[k]) ? bars[k].bv + bars[k].sv : Number(bars[k].v) || 0; }
    return sv > 0 ? sd / sv : NaN;
  });
}

/**
 * Higher-timeframe candles of `minutes` (dividing a day) built from the bars,
 * aligned to the 18:00 ET Globex open: 60 opens on the hour; 240 opens at
 * 18:00, 22:00, 02:00, 06:00, 10:00, 14:00 ET. For each bar:
 *   key                  the candle the bar is in
 *   prevO prevH prevL prevC  the previous candle (the one before this bar's),
 *                        NaN while it is unknown or was cut off by the data's start
 *   curO curH curL       this bar's candle so far, up to and including the bar
 * Causal: a bar only sees candles that closed before it and its own candle so far.
 */
function htfCandles(bars, minutes) {
  const n = bars.length;
  const out = {
    key: new Array(n), prevO: new Array(n).fill(NaN), prevH: new Array(n).fill(NaN), prevL: new Array(n).fill(NaN), prevC: new Array(n).fill(NaN),
    curO: new Array(n).fill(NaN), curH: new Array(n).fill(NaN), curL: new Array(n).fill(NaN),
  };
  let cur = null;
  let prev = null;
  for (let i = 0; i < n; i += 1) {
    const b = bars[i];
    const sinceOpen = (etInfo(b.t).minute - 18 * 60 + 1440) % 1440;
    const session = sessionKey(b.t, 18 * 60);
    const idx = Math.floor(sinceOpen / minutes);
    const key = `${session}#${idx}`;
    if (!cur || cur.key !== key) {
      // The previous candle is the one right before this one: in the same
      // session, the next index on (a feed gap that skipped a whole candle
      // leaves no previous candle); across the 18:00 open, the last candle of
      // the session before.
      const adjacent = cur && (cur.session !== session || cur.idx === idx - 1);
      prev = cur && cur.complete && adjacent ? cur : null;
      // The candle the data starts in is complete only if the data starts on its open.
      cur = { key, session, idx, o: b.o, h: b.h, l: b.l, c: b.c, complete: i > 0 || (sinceOpen % minutes === 0 && Date.parse(b.t) % 60000 === 0) };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
    out.key[i] = key;
    out.curO[i] = cur.o; out.curH[i] = cur.h; out.curL[i] = cur.l;
    if (prev) { out.prevO[i] = prev.o; out.prevH[i] = prev.h; out.prevL[i] = prev.l; out.prevC[i] = prev.c; }
  }
  return out;
}

module.exports = {
  htfCandles,
  barDelta,
  ofi,
  normalizeBars,
  ema,
  rma,
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
