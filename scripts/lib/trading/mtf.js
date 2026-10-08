'use strict';

/**
 * Multi-timeframe read: the trend on each higher timeframe, built from the
 * trigger bars (and optionally daily bars), and whether a long or a short is
 * with all of them, a pullback inside them, or against them.
 *
 * Candles are aligned to the 18:00 ET Globex open (indicators.htfCandles):
 * 60 opens on the hour, 240 at 18, 22, 02, 06, 10, 14 ET, 1440 is the
 * session (18:00-17:00 ET). Only completed candles are read; the one in
 * progress is reported but never decides the trend.
 *
 * Per timeframe (readTimeframe):
 *   trend    up / down / range, from three votes: close vs EMA(fast),
 *            EMA(fast) vs EMA(slow), and swing structure (higher highs and
 *            higher lows, or lower highs and lower lows). Two of three agreeing
 *            (and none against) sets the trend; bias is +1, -1, or 0.
 *   adx, atr, slope (EMA fast change over 3 candles, in ATRs), the close's
 *   position in the last 20 candles' range (0 = low, 1 = high), and levels
 *   (the previous candle's high and low, the last swing high and low).
 *
 * Alignment (alignment): for each side, with timeframes from highest to lowest:
 *   aligned   no timeframe against it, and most with it
 *   pullback  every timeframe above the lowest with it, the lowest against it
 *             (wait for the trigger timeframe to turn back)
 *   counter   the highest timeframe against it
 *   mixed     anything else
 *
 * biasSeries(bars, m) is the same bias per bar, causal (each bar sees only
 * candles completed before it), for the rules language: mtf_bias(m).
 */

const ind = require('./indicators');
const { zonedParts } = require('./clock');

const DEFAULTS = { fast: 20, slow: 50, adx: 14, atr: 14, swingK: 2, rangeLen: 20 };
const LABEL = { 15: '15m', 30: '30m', 60: '1h', 120: '2h', 240: '4h', 1440: 'daily' };
const label = m => LABEL[m] || `${m}m`;

/**
 * The m-minute candles in `bars`: [{ t, o, h, l, c, v, start, end, complete }].
 * The last candle is in progress (complete: false); a first candle the bars
 * start partway into is dropped.
 */
function candles(bars, minutes) {
  const h = ind.htfCandles(bars, minutes);
  const out = [];
  let cur = null;
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    if (!cur || cur.key !== h.key[i]) {
      if (cur) out.push(cur);
      // htfCandles marks the first candle complete only when the data starts on its open.
      const first = i === 0 && Number.isNaN(h.prevH[i]) && !startsOnOpen(b, minutes);
      cur = { key: h.key[i], t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, start: i, end: i, cut: first };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v || 0;
      cur.end = i;
    }
  }
  if (cur) out.push(cur);
  return out.filter(c => !c.cut).map((c, k, all) => ({ ...c, complete: k < all.length - 1 }));
}

function startsOnOpen(bar, minutes) {
  const ms = Date.parse(bar.t);
  const p = zonedParts(new Date(ms), 'America/New_York');
  const sinceOpen = (p.hour * 60 + p.minute - 18 * 60 + 1440) % 1440;
  return sinceOpen % minutes === 0 && ms % 60000 === 0;
}

const last = arr => arr[arr.length - 1];
const fin = x => (Number.isFinite(x) ? x : null);
const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/** The last two confirmed swing highs and lows: their structure. */
function structure(cs, k) {
  const highs = [];
  const lows = [];
  for (let j = k; j < cs.length - k; j += 1) {
    let hi = true;
    let lo = true;
    for (let m = j - k; m <= j + k; m += 1) {
      if (m === j) continue;
      if (!(cs[j].h > cs[m].h)) hi = false;
      if (!(cs[j].l < cs[m].l)) lo = false;
    }
    if (hi) highs.push(cs[j].h);
    if (lo) lows.push(cs[j].l);
  }
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  const hh = h2 !== undefined ? h2 > h1 : null;
  const hl = l2 !== undefined ? l2 > l1 : null;
  let kind = 'unclear';
  if (hh === true && hl === true) kind = 'HH/HL';
  else if (hh === false && hl === false) kind = 'LH/LL';
  else if (hh !== null && hl !== null) kind = 'mixed';
  return { kind, swingHigh: highs.length ? last(highs) : null, swingLow: lows.length ? last(lows) : null };
}

/** The trend read of completed candles `cs` (oldest first). */
function readTimeframe(cs, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (cs.length < 3) return { candles: cs.length, bias: 0, trend: 'unknown', reason: `only ${cs.length} completed candle(s)` };
  const closes = cs.map(c => c.c);
  const emaF = ind.ema(closes, o.fast);
  const emaS = cs.length >= o.slow ? ind.ema(closes, o.slow) : null;
  const atr = ind.atr(cs, o.atr);
  const adx = ind.adx(cs, o.adx);
  const i = cs.length - 1;
  const close = closes[i];
  const f = emaF[i];
  const s = emaS ? emaS[i] : null;
  const a = fin(atr[i]);
  const st = structure(cs, o.swingK);
  const votes = [
    close > f ? 1 : close < f ? -1 : 0,
    s === null ? 0 : f > s ? 1 : f < s ? -1 : 0,
    st.kind === 'HH/HL' ? 1 : st.kind === 'LH/LL' ? -1 : 0,
  ];
  const up = votes.filter(v => v > 0).length;
  const down = votes.filter(v => v < 0).length;
  const bias = up >= 2 && down === 0 ? 1 : down >= 2 && up === 0 ? -1 : 0;
  const window = cs.slice(-o.rangeLen);
  const hi = Math.max(...window.map(c => c.h));
  const lo = Math.min(...window.map(c => c.l));
  return {
    candles: cs.length,
    asOf: last(cs).t,
    trend: bias > 0 ? 'up' : bias < 0 ? 'down' : 'range',
    bias,
    votes: { closeVsFast: votes[0], fastVsSlow: emaS ? votes[1] : null, structure: st.kind },
    close,
    emaFast: r2(f),
    emaSlow: s === null ? null : r2(s),
    slopeAtr: a && i >= 3 ? r2((f - emaF[i - 3]) / a) : null,
    adx: r2(adx[i]),
    atr: r2(a),
    rangePos: hi > lo ? r2((close - lo) / (hi - lo)) : null,
    levels: { prevHigh: cs[i].h, prevLow: cs[i].l, swingHigh: st.swingHigh, swingLow: st.swingLow, rangeHigh: hi, rangeLow: lo },
    ...(emaS ? {} : { note: `no EMA${o.slow} vote, needs ${o.slow}` }),
  };
}

/** For each side: aligned / pullback / counter / mixed, timeframes given highest first. */
function alignment(frames) {
  const biases = frames.map(f => f.read.bias);
  const verdict = sign => {
    if (!biases.length) return 'unknown';
    if (biases[0] === -sign) return 'counter';
    const above = biases.slice(0, -1);
    const lowest = last(biases);
    if (biases.length > 1 && above.every(b => b === sign) && lowest === -sign) return 'pullback';
    const against = biases.filter(b => b === -sign).length;
    const withIt = biases.filter(b => b === sign).length;
    if (against === 0 && withIt * 2 >= biases.length) return 'aligned';
    return 'mixed';
  };
  // Higher timeframes weigh more: the highest counts as many as there are frames.
  const score = biases.reduce((acc, b, k) => acc + b * (biases.length - k), 0);
  const max = biases.reduce((acc, _b, k) => acc + (biases.length - k), 0);
  return { long: verdict(1), short: verdict(-1), bias: score > 0 ? 'long' : score < 0 ? 'short' : 'neutral', score, maxScore: max };
}

function line(m, x) {
  if (x.trend === 'unknown') return `${label(m)}: unknown (${x.reason})`;
  const v = x.votes;
  return `${label(m)}: ${x.trend.toUpperCase()} (close ${x.close} vs EMA${DEFAULTS.fast} ${x.emaFast}${x.emaSlow !== null ? `, EMA${DEFAULTS.fast} vs EMA${DEFAULTS.slow} ${x.emaSlow}` : ''}, structure ${v.structure}), `
    + `ADX ${x.adx ?? '-'}, ATR ${x.atr ?? '-'}, ${x.rangePos === null ? '' : `at ${Math.round(x.rangePos * 100)}% of the ${DEFAULTS.rangeLen}-candle range, `}`
    + `swing ${x.levels.swingLow ?? '-'} / ${x.levels.swingHigh ?? '-'}${x.note ? ` (${x.candles} candles: ${x.note})` : ''}`;
}

/**
 * The full read. `bars`: the trigger bars (oldest first, closed). `daily`:
 * optional daily bars (get_bars day), read as the highest timeframe.
 */
function mtfRead(bars, { timeframes = [15, 60, 240], daily = null, opts = {} } = {}) {
  const nb = ind.normalizeBars(bars);
  if (nb.length < 3) throw new Error(`need bars to read, got ${nb.length}`);
  const tfs = [...new Set(timeframes)].sort((a, b) => b - a);
  for (const m of tfs) if (!(Number.isInteger(m) && m > 0 && 1440 % m === 0)) throw new Error(`timeframe ${m}: minutes that divide a day (15, 30, 60, 240, ...)`);
  const frames = [];
  if (daily) {
    const db = ind.normalizeBars(daily);
    // get_bars with includePartialBar=false: every daily bar is complete.
    frames.push({ minutes: 1440, label: 'daily', source: 'daily bars', read: readTimeframe(db, opts) });
  }
  for (const m of tfs) {
    if (daily && m === 1440) continue;
    const cs = candles(nb, m);
    const done = cs.filter(c => c.complete);
    const cur = cs.find(c => !c.complete) || null;
    frames.push({
      minutes: m, label: label(m), source: 'built from the trigger bars', read: readTimeframe(done, opts),
      forming: cur ? { t: cur.t, o: cur.o, h: cur.h, l: cur.l, c: cur.c } : null,
    });
  }
  const al = alignment(frames.filter(f => f.read.trend !== 'unknown'));
  const lastBar = last(nb);
  return {
    asOf: lastBar.t,
    price: lastBar.c,
    frames,
    alignment: al,
    lines: [
      ...frames.map(f => line(f.minutes, f.read)),
      `Alignment: long ${al.long}, short ${al.short}; bias ${al.bias} (score ${al.score} of ±${al.maxScore}).`,
    ],
  };
}

/** Per bar: the m-minute bias as of the last candle completed before that bar (causal). */
function biasSeries(bars, minutes, opts = {}) {
  const n = bars.length;
  const out = new Array(n).fill(NaN);
  const h = ind.htfCandles(bars, minutes);
  const done = [];
  let cur = null;
  let bias = NaN;
  for (let i = 0; i < n; i += 1) {
    const b = bars[i];
    if (!cur || cur.key !== h.key[i]) {
      if (cur && !cur.cut) {
        done.push(cur);
        // Every completed candle, as mtfRead reads them: the rule and the read agree.
        bias = done.length >= 3 ? readTimeframe(done, opts).bias : NaN;
      }
      cur = { key: h.key[i], t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, cut: i === 0 && !startsOnOpen(b, minutes) };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
    out[i] = bias;
  }
  return out;
}

module.exports = { DEFAULTS, candles, readTimeframe, alignment, mtfRead, biasSeries, label };
