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
 *
 * The trend rule (trendRule, ruleSeries): the prevailing trend is the highest
 * of RULE_FRAMES (4h, 1h, 15m, built from the trigger bars) that has one. A
 * trend strategy (every strategy unless it declares `mtf: reversal`) may not
 * enter against it, and needs the 4-hour read to exist; a reversal strategy
 * may fade it. With no trend on any frame, both sides are open. The scan, the
 * backtester, the runner's record (recordFor), and the order gate all apply
 * this one rule.
 */

const ind = require('./indicators');
const { zonedParts } = require('./clock');

// maxCandles: a read uses at most the last 300 completed candles (enough for EMA50 to settle),
// so a per-bar series over a long backtest stays linear.
// historyHours: every read uses only the candles of the last 240 hours (about 60 4-hour candles,
// enough for EMA50), so the live read (the runner keeps 250 hours of bars, HISTORY_HOURS) and the
// backtest's per-bar read see exactly the same candles.
const DEFAULTS = { fast: 20, slow: 50, adx: 14, atr: 14, swingK: 2, rangeLen: 20, maxCandles: 300, historyHours: 240 };
// What the live runner and bars.js keep: the read's window plus margin.
const HISTORY_HOURS = 250;
// The frames the trend rule reads, highest first.
const RULE_FRAMES = [240, 60, 15];
const STYLES = ['trend', 'reversal'];
const LABEL = { 15: '15m', 30: '30m', 60: '1h', 120: '2h', 240: '4h', 1440: 'daily' };
const label = m => LABEL[m] || `${m}m`;

/** The bars' step in ms: the smallest gap between the last 50 bars (gaps only ever add time). */
function stepOf(bars) {
  let step = Infinity;
  for (let i = Math.max(1, bars.length - 50); i < bars.length; i += 1) {
    const d = Date.parse(bars[i].t) - Date.parse(bars[i - 1].t);
    if (d > 0 && d < step) step = d;
  }
  return Number.isFinite(step) ? step : 60000;
}

/** Does the bar at `t` (lasting `stepMs`) close exactly on an m-minute candle boundary? Then its candle is complete. */
function closesCandle(t, stepMs, minutes) {
  return startsOnOpen({ t: new Date(Date.parse(t) + stepMs).toISOString() }, minutes);
}

/**
 * The m-minute candles in `bars`: [{ t, o, h, l, c, v, start, end, complete }].
 * The last candle is in progress (complete: false) unless the last bar closed
 * on its boundary; a first candle the bars start partway into is dropped.
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
  const lastDone = bars.length > 0 && closesCandle(bars[bars.length - 1].t, stepOf(bars), minutes);
  return out.filter(c => !c.cut).map((c, k, all) => ({ ...c, complete: k < all.length - 1 || lastDone }));
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
function readTimeframe(all, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const cs = all.length > o.maxCandles ? all.slice(-o.maxCandles) : all;
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
    candles: all.length,
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

/**
 * The trend rule for one side. `biases`: { 240: 1|0|-1|NaN, 60: ..., 15: ... }
 * (NaN: no read yet). Returns { allowed, prevailing: { minutes, label, trend } | null, ready, reason }.
 */
function trendRule(biases, side, style = 'trend') {
  const sign = side === 'long' || side === 1 ? 1 : side === 'short' || side === -1 ? -1 : 0;
  const ready = Number.isFinite(biases[RULE_FRAMES[0]]);
  const top = RULE_FRAMES.find(m => Number.isFinite(biases[m]) && biases[m] !== 0);
  const prevailing = top ? { minutes: top, label: label(top), trend: biases[top] > 0 ? 'up' : 'down' } : null;
  if (style === 'reversal') return { allowed: true, prevailing, ready, reason: null };
  if (!ready) return { allowed: false, prevailing, ready, reason: `no ${label(RULE_FRAMES[0])} trend read yet (needs 3 completed ${label(RULE_FRAMES[0])} candles in the bars)` };
  if (prevailing && sign && Math.sign(biases[top]) === -sign) {
    return { allowed: false, prevailing, ready, reason: `against the prevailing ${prevailing.label} ${prevailing.trend} trend: only a reversal strategy (mtf: reversal) may fade it` };
  }
  return { allowed: true, prevailing, ready, reason: null };
}

/** Per bar: the rule frames' biases, causal (the candles completed before the bar). { 240: [...], 60: [...], 15: [...] } */
function ruleSeries(bars, opts = {}) {
  return Object.fromEntries(RULE_FRAMES.map(m => [m, biasSeries(bars, m, opts)]));
}

const biasesAt = (series, i) => Object.fromEntries(RULE_FRAMES.map(m => [m, series[m][i]]));

/** The trend-rule summary of a bias map, for a scan result or a record. */
function ruleSummary(biases, style = 'trend') {
  const word = b => (Number.isFinite(b) ? (b > 0 ? 'up' : b < 0 ? 'down' : 'range') : 'unknown');
  const long = trendRule(biases, 'long', style);
  const short = trendRule(biases, 'short', style);
  return {
    style,
    frames: Object.fromEntries(RULE_FRAMES.map(m => [label(m), word(biases[m])])),
    prevailing: long.prevailing ? `${long.prevailing.label} ${long.prevailing.trend}` : null,
    ready: long.ready,
    longAllowed: long.allowed,
    shortAllowed: short.allowed,
    ...(long.reason || short.reason ? { reason: long.reason || short.reason } : {}),
  };
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
/** The completed candles that start inside the read's window, ending at `asOfMs`. */
function inWindow(cs, asOfMs, opts = {}) {
  const from = asOfMs - ({ ...DEFAULTS, ...opts }.historyHours) * 3600000;
  return cs.filter(c => Date.parse(c.t) >= from);
}

function mtfRead(bars, { timeframes = [15, 60, 240], daily = null, opts = {} } = {}) {
  const nb = ind.normalizeBars(bars);
  const asOfMs = nb.length ? Date.parse(nb[nb.length - 1].t) : 0;
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
    const done = inWindow(cs.filter(c => c.complete), asOfMs, opts);
    const cur = cs.find(c => !c.complete) || null;
    frames.push({
      minutes: m, label: label(m), source: 'built from the trigger bars', read: readTimeframe(done, opts),
      forming: cur ? { t: cur.t, o: cur.o, h: cur.h, l: cur.l, c: cur.c } : null,
    });
  }
  const al = alignment(frames.filter(f => f.read.trend !== 'unknown'));
  const lastBar = last(nb);
  // The trend rule reads the frames built from the trigger bars (the daily is context only).
  const ruleBiases = Object.fromEntries(RULE_FRAMES.map(m => {
    const cs = inWindow(candles(nb, m).filter(c => c.complete), asOfMs, opts);
    return [m, cs.length >= 3 ? readTimeframe(cs, opts).bias : NaN];
  }));
  const rule = ruleSummary(ruleBiases);
  const forming = f => (f.forming ? ` | forming ${f.label} candle from ${f.forming.t}: O ${f.forming.o} H ${f.forming.h} L ${f.forming.l} C ${f.forming.c} (not in the trend)` : '');
  return {
    asOf: lastBar.t,
    price: lastBar.c,
    frames,
    alignment: al,
    biases: ruleBiases,
    rule,
    lines: [
      ...frames.map(f => line(f.minutes, f.read) + forming(f)),
      `Alignment: long ${al.long}, short ${al.short}; bias ${al.bias} (score ${al.score} of ±${al.maxScore}).`,
      ruleLine(rule),
    ],
  };
}

function ruleLine(r) {
  if (!r.ready) return `Trend rule: ${r.reason}; trend strategies can't enter yet, reversal strategies can.`;
  if (!r.prevailing) return 'Trend rule: no trend on 4h, 1h, or 15m; both sides open to every strategy.';
  const against = r.longAllowed ? 'short' : 'long';
  return `Trend rule: prevailing trend ${r.prevailing}; trend strategies may not go ${against}, reversal strategies (mtf: reversal) may.`;
}

/**
 * Per bar: the m-minute bias as of the candles completed by that bar's close
 * (causal: a candle that closes with the bar counts; the one in progress doesn't).
 */
function biasSeries(bars, minutes, opts = {}) {
  const n = bars.length;
  const out = new Array(n).fill(NaN);
  const h = ind.htfCandles(bars, minutes);
  const step = stepOf(bars);
  const windowMs = ({ ...DEFAULTS, ...opts }.historyHours) * 3600000;
  const done = [];
  let first = 0; // the oldest completed candle still inside the window
  let cur = null;
  let bias = NaN;
  const finish = asOfMs => {
    if (cur && !cur.cut) done.push(cur);
    cur = null;
    // The completed candles of the window, as mtfRead reads them: the rule and the read agree.
    while (first < done.length && Date.parse(done[first].t) < asOfMs - windowMs) first += 1;
    const win = done.slice(first);
    bias = win.length >= 3 ? readTimeframe(win, opts).bias : NaN;
  };
  for (let i = 0; i < n; i += 1) {
    const b = bars[i];
    const ms = Date.parse(b.t);
    if (!cur || cur.key !== h.key[i]) {
      if (cur) finish(ms);
      cur = { key: h.key[i], t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, cut: i === 0 && !startsOnOpen(b, minutes) };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
    // This bar closes its candle: it is complete now, not when the next bar opens.
    if (closesCandle(b.t, step, minutes)) finish(ms);
    out[i] = bias;
  }
  return out;
}

module.exports = { DEFAULTS, HISTORY_HOURS, RULE_FRAMES, STYLES, candles, readTimeframe, alignment, mtfRead, biasSeries, label, trendRule, ruleSeries, biasesAt, ruleSummary, ruleLine };
