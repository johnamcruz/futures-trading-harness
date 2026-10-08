'use strict';

/**
 * Per-bar strategy evaluation over a bar series: the one place that decides
 * whether a STRATEGY.md fires on a bar. Live scans evaluate the last closed
 * bar (strategies.scan); the backtester walks every bar of a long series with
 * the same evaluator, so live and backtest can't disagree about entries.
 *
 * Every mechanical strategy is Markdown rules (`signal: rules`), evaluated by
 * the rules engine over series computed once (causal: bar i only sees bars
 * 0..i). The cisd_ote series runs algoTraderBot's detector on the trailing
 * `window` bars, as the source does. The shipped ports reproduce
 * algoTraderBot's signals bar for bar (tests/lib/parity.test.js).
 */

const { PARAMS, signalSeries } = require('./market-snapshot');
const { evaluateRules, seriesSource, valueAt } = require('./rules');
const { classifyRegime, regimeFits } = require('./regime');
const { parseWindows, inWindow } = require('./clock');
const ind = require('./indicators');

const DEFAULT_WINDOW = 500; // bars per evaluation, as algoTraderBot's BARS_WINDOW
const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;
const GLOBEX_OPEN = 18 * 60;

function timeframeMs(tf) {
  const m = /^(\d+)(m|h|d)$/.exec(String(tf || ''));
  if (!m) return null;
  return Number(m[1]) * { m: 60000, h: 3600000, d: 86400000 }[m[2]];
}

/**
 * The exit plan for a trade in strategy `s`: fixed target and/or trailing
 * stop, in R (1R = the initial stop distance). Without an exit block the
 * target is risk.min_rr, as a bracket.
 */
function exitPlan(s) {
  const x = s.exit || {};
  return {
    targetR: x.target_r ?? (x.trail_activate_r === undefined ? s.risk.min_rr : null),
    trailActivateR: x.trail_activate_r ?? null,
    trailGivebackR: x.trail_giveback_r ?? null,
    maxBars: x.max_bars ?? null,
  };
}

function inSessions(strategy, now) {
  if (!Array.isArray(strategy.sessions) || strategy.sessions.length === 0) return true;
  return parseWindows(strategy.sessions.join(',')).windows.some(w => inWindow(now, w));
}

/**
 * @param bars normalized bars (indicators.normalizeBars), oldest first
 * @param opts.window bars of history for windowed pieces (cisd_ote, regime)
 */
function createEvaluator(bars, { window = DEFAULT_WINDOW } = {}) {
  const ms = bars.map(b => Date.parse(b.t));
  const seriesCache = new Map();
  const rulesCache = new Map();
  const regimeCache = new Map();
  let extras = null;

  const paramsOf = s => ({ ...PARAMS, ...(s.params || {}) });
  const series = s => {
    const key = JSON.stringify(s.params || {});
    if (!seriesCache.has(key)) seriesCache.set(key, signalSeries(bars, s.params || {}));
    return seriesCache.get(key);
  };
  const rulesSource = s => {
    const key = JSON.stringify(s.params || {});
    if (!rulesCache.has(key)) rulesCache.set(key, seriesSource(bars, paramsOf(s), { window }));
    return rulesCache.get(key);
  };
  const windowStart = i => Math.max(0, i - window + 1);
  const regimeAt = i => {
    if (!regimeCache.has(i)) regimeCache.set(i, classifyRegime(bars.slice(windowStart(i), i + 1)));
    return regimeCache.get(i);
  };
  const extra = () => {
    if (!extras) {
      extras = {
        atr14: ind.atr(bars, 14),
        vwapRth: ind.anchoredVwap(bars, RTH_OPEN, RTH_CLOSE),
        vwapSession: ind.anchoredVwap(bars, GLOBEX_OPEN),
      };
    }
    return extras;
  };
  const num = v => (Number.isFinite(v) ? v : null);

  function filterFailures(s, ser, i) {
    const f = s.filters || {};
    const fails = [];
    const adx = num(ser.adx[i]);
    if (f.adx_min !== undefined && !(adx !== null && adx >= f.adx_min)) fails.push(`ADX ${adx} < ${f.adx_min}`);
    if (f.adx_max !== undefined && !(adx !== null && adx <= f.adx_max)) fails.push(`ADX ${adx} > ${f.adx_max}`);
    if (f.adx_slope_min !== undefined) {
      const k = ser.p.adxSlopeBars;
      const slope = adx !== null && i - k >= 0 && num(ser.adx[i - k]) !== null ? adx - ser.adx[i - k] : null;
      if (!(slope !== null && slope >= f.adx_slope_min)) fails.push(`ADX slope ${slope} < ${f.adx_slope_min}`);
    }
    if (f.max_vwap_distance_atr !== undefined) {
      const x = extra();
      const vwap = num(x.vwapRth[i]) ?? num(x.vwapSession[i]);
      const atr = num(x.atr14[i]);
      const dist = vwap !== null && atr ? Math.abs(bars[i].c - vwap) / atr : null;
      if (dist === null || dist > f.max_vwap_distance_atr) fails.push(`VWAP distance ${dist === null ? 'unknown' : dist.toFixed(2)} ATR > ${f.max_vwap_distance_atr}`);
    }
    return fails;
  }

  /**
   * Evaluate strategy `s` on bar i. `now` (default: the bar's close) is the
   * time sessions are checked at. Returns the scan result for that bar,
   * including `entry` (the bar's close) and `stopDistance` (price) when known.
   */
  function at(s, i, { now = null, describe = true } = {}) {
    const tfMs = timeframeMs(s.timeframe) || (i > 0 ? ms[i] - ms[i - 1] : 60000);
    const when = now || new Date(ms[i] + tfMs);
    const session = inSessions(s, when);
    // The regime is classified on demand: always for a live scan (describe),
    // and in a backtest only on bars where the strategy fires.
    const withRegime = base => {
      const regime = regimeAt(i);
      return { ...base, regime: regime ? regime.primary : null, regimes: s.regimes || null, inRegime: regimeFits(s.regimes, regime) };
    };
    const head = { name: s.name, status: s.status, timeframe: s.timeframe, inSession: session };
    if (s.signal === 'manual') {
      const base = withRegime(head);
      return { ...base, signal: 'manual', candidate: session && base.inRegime, note: 'evaluate the trigger from STRATEGY.md' };
    }
    const ser = series(s);
    const atr20 = num(ser.atrStop[i]);
    let direction = null;
    let ruleDetail = null;
    let stopDistance = null;
    if (s.signal === 'rules') {
      const r = evaluateRules(s.compiledRules, bars, paramsOf(s), { index: i, get: rulesSource(s) });
      direction = r.direction;
      ruleDetail = { long: r.long, short: r.short };
    }
    const atrMult = typeof s.risk.stop === 'string' ? /^atr:(.+)$/.exec(s.risk.stop) : null;
    if (atrMult && atr20 !== null) stopDistance = Number(atrMult[1]) * atr20;
    if (s.compiledStop) {
      // A per-side stop ({ long, short }) has a distance only once the side is known.
      const terms = Array.isArray(s.compiledStop) ? s.compiledStop : direction ? s.compiledStop[direction] : null;
      const d = terms ? valueAt(terms, rulesSource(s), i) : null;
      stopDistance = d !== null && d > 0 ? d : null;
    }
    const fails = filterFailures(s, ser, i);
    // A mechanical stop (atr:k or an expression) that has no positive
    // distance on this bar can't be placed: no candidate.
    const mechanicalStop = Boolean(atrMult || s.compiledStop);
    if (direction && mechanicalStop && !(stopDistance > 0)) fails.push('stop: no positive distance on this bar');
    const base = direction || describe ? withRegime(head) : { ...head, regime: null, regimes: s.regimes || null, inRegime: null };
    return {
      ...base,
      signal: s.signal,
      direction: direction || null,
      filtersFailed: fails,
      candidate: Boolean(direction) && session && base.inRegime === true && fails.length === 0,
      entryRef: bars[i].c,
      stopDistance: stopDistance === null ? null : Math.round(stopDistance * 1e4) / 1e4,
      minRR: s.risk.min_rr,
      exit: exitPlan(s),
      ...(ruleDetail ? { rules: ruleDetail } : {}),
    };
  }

  return { at, regimeAt, length: bars.length, bars };
}

module.exports = { DEFAULT_WINDOW, createEvaluator, inSessions, timeframeMs, exitPlan };
