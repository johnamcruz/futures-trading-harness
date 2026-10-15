'use strict';

/**
 * Per-bar strategy evaluation over a bar series: the one place that decides
 * whether a STRATEGY.md fires on a bar. Live scans evaluate the last closed
 * bar (strategies.scan); the backtester walks every bar of a long series with
 * the same evaluator, so live and backtest can't disagree about entries.
 *
 * Every mechanical strategy is Markdown rules (`signal: rules`), evaluated by
 * the rules engine over series computed once (causal: bar i only sees bars
 * 0..i). The regime reads the trailing `window` bars. The shipped orb port
 * reproduces the original bot's signals bar for bar (tests/lib/parity.test.js).
 */

const { PARAMS, signalSeries } = require('./market-snapshot');
const { evaluateRules, seriesSource, valueAt } = require('./rules');
const { classifyRegime, regimeFits } = require('./regime');
const { parseWindows, inWindow } = require('./clock');
const ind = require('./indicators');
const mtf = require('./mtf');

// A timeframe ('3m', '1h') in minutes; null when it isn't one.
const tfMinutes = tf => { const m = /^(\d+)(m|h)$/.exec(String(tf || '')); return m ? Number(m[1]) * (m[2] === 'h' ? 60 : 1) : null; };

const { SWING_TFS } = require('./exit-trail');
const { RTH_OPEN_MIN, RTH_CLOSE_MIN, GLOBEX_OPEN_MIN } = require('./clock'); // the session boundaries' one home

const DEFAULT_WINDOW = require('../tunables').analysis().evaluator.windowBars; // bars per evaluation, as the original bot's BARS_WINDOW (config/analysis.json)

function timeframeMs(tf) {
  const m = /^(\d+)(m|h|d)$/.exec(String(tf || ''));
  if (!m) return null;
  return Number(m[1]) * { m: 60000, h: 3600000, d: 86400000 }[m[2]];
}

/**
 * The exit plan for a trade in strategy `s`: fixed target and/or trailing
 * stop, in R (1R = the initial stop distance). Without an exit block the
 * target is risk.min_rr, as a bracket. A policy strategy whose exit is
 * in exit mode `target` sets no target of its own (`own`: each trade keeps its own
 * stop and target, tradeExitPlan), only the trail on top when it has one;
 * in mode `target_then_trail` its `afterTarget`: past the target the trade is trailed, not closed.
 */
function exitPlan(s) {
  const x = s.exit || {};
  const own = x.mode === 'target' || x.mode === 'target_then_trail';
  return {
    // exit.target is a distance per setup (targetDistance on the scan result), not R.
    targetR: own || x.target !== undefined ? null : x.target_r ?? (x.trail_activate_r === undefined ? s.risk.min_rr : null),
    target: x.target ?? null,
    trailActivateR: x.trail_activate_r ?? null,
    trailGivebackR: x.trail_giveback_r ?? null,
    maxBars: x.max_bars ?? null,
    ...(own ? { own: true } : {}),
    // Exit mode target_then_trail: past its own target the trade is trailed, not closed (trading/exit-trail.js).
    ...(x.mode === 'target_then_trail' ? { afterTarget: { lockGivebackR: x.lock_giveback_r, trailBy: x.trail_by, trailR: x.trail_r, swingMinutes: x.trail_by === 'structure' ? SWING_TFS[x.swing_tf] : null } } : {}),
  };
}

/**
 * The exit plan of a trade a policy strategy takes from its component (a rules strategy's setup; null for a compose
 * record, whose own stop and target are its entry's brackets). Mode `trail` (or a policy without a mode): the
 * policy's trail replaces the trade's own exit, as before. Mode `target`: the component's own exit (none to manage
 * for a compose record), with the policy's trail on top when it has one. No policy: the component's own plan.
 */
function tradeExitPlan(policy, component = null) {
  if (!policy) return exitPlan(component);
  const p = exitPlan(policy);
  if (!p.own) return p;
  const base = component ? exitPlan(component) : { targetR: null, target: null, trailActivateR: null, trailGivebackR: null, maxBars: null };
  const own = p.afterTarget ? { ...base, afterTarget: p.afterTarget } : base;
  return p.trailActivateR === null ? own : { ...own, trailActivateR: p.trailActivateR, trailGivebackR: p.trailGivebackR };
}

/**
 * The policies that would trade a composed strategy's setups: every valid policy strategy listing it. A composed trade's
 * exit is theirs (composedExit) whether or not an attempt is running, so practice outside an attempt trades the exit an
 * attempt trades.
 */
const policiesOf = (strategy, strategies = []) => (strategies || []).filter(p => p && p.valid && p.signal === 'policy' && (p.strategies || []).includes(strategy && strategy.name));

/**
 * The exit a composed strategy's trade is managed by, with or without a running attempt: { plan, mode }. The exit of
 * the policy that lists it (tradeExitPlan for a compose record: its own stop and target are its entry's brackets;
 * `mode` the policy's exit mode), the same one an attempt's entry under that policy gets. With no such policy, or
 * policies whose exits differ (none to pick), the strategy's own: its brackets (`mode` 'brackets').
 */
function composedExit(strategy, strategies = []) {
  const own = { plan: exitPlan(strategy), mode: 'brackets' };
  if (!strategy || strategy.signal !== 'composed') return own;
  const plans = policiesOf(strategy, strategies).map(p => ({ plan: tradeExitPlan(p, null), mode: (p.exit && p.exit.mode) || 'trail' }));
  if (!plans.length || new Set(plans.map(x => JSON.stringify(x))).size > 1) return own;
  return plans[0];
}

function inSessions(strategy, now) {
  if (!Array.isArray(strategy.sessions) || strategy.sessions.length === 0) return true;
  return parseWindows(strategy.sessions.join(',')).windows.some(w => inWindow(now, w));
}

/**
 * @param bars normalized bars (indicators.normalizeBars), oldest first
 * @param opts.window bars of history for windowed pieces (the regime)
 */
function createEvaluator(bars, { window = DEFAULT_WINDOW } = {}) {
  const ms = bars.map(b => Date.parse(b.t));
  // The multi-timeframe trend rule's frames, per bar (causal), computed once on first use.
  let ruleSer = null;
  const mtfAt = i => { ruleSer = ruleSer || mtf.ruleSeries(bars); return mtf.biasesAt(ruleSer, i); };
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
  // The strategy's own timeframe is its bars' size (the completed-candle series read it; never guessed from gaps).
  const rulesSource = s => {
    const barMinutes = tfMinutes(s.timeframe);
    const key = `${JSON.stringify(s.params || {})}|${barMinutes}`;
    if (!rulesCache.has(key)) rulesCache.set(key, seriesSource(bars, paramsOf(s), { barMinutes }));
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
        atr14: ind.atr(bars, ind.ATR_PERIOD),
        vwapRth: ind.anchoredVwap(bars, RTH_OPEN_MIN, RTH_CLOSE_MIN),
        vwapSession: ind.anchoredVwap(bars, GLOBEX_OPEN_MIN),
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
    // Nothing fires for a composed strategy (trade_lifecycle): the model composes its trade, never a scan.
    if (s.signal === 'composed') return { ...head, signal: 'composed', candidate: false, note: 'composed by the model (compose_check)' };
    if (s.signal === 'manual') {
      const base = withRegime(head);
      // The side is the LLM's call; the summary says which sides the trend rule leaves open (the gate enforces it).
      return { ...base, signal: 'manual', candidate: session && base.inRegime, mtf: mtf.ruleSummary(mtfAt(i), s.mtf || 'trend'), note: 'evaluate the trigger from STRATEGY.md' };
    }
    const ser = series(s);
    const atr20 = num(ser.atrStop[i]);
    let direction = null;
    let ruleDetail = null;
    let stopDistance = null;
    if (s.signal === 'rules') {
      const r = evaluateRules(s.compiledRules, bars, paramsOf(s), { index: i, get: rulesSource(s), values: describe });
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
    let targetDistance = null;
    if (s.compiledTarget && direction) {
      const terms = Array.isArray(s.compiledTarget) ? s.compiledTarget : s.compiledTarget[direction];
      const d = valueAt(terms, rulesSource(s), i);
      targetDistance = d !== null && d > 0 ? d : null;
    }
    const fails = filterFailures(s, ser, i);
    if (direction && s.compiledTarget && !(targetDistance > 0)) fails.push('target: no positive distance on this bar');
    // A mechanical stop (atr:k or an expression) that has no positive
    // distance on this bar can't be placed: no candidate.
    const mechanicalStop = Boolean(atrMult || s.compiledStop);
    if (direction && mechanicalStop && !(stopDistance > 0)) fails.push('stop: no positive distance on this bar');
    // The trend rule: a trend strategy never enters against the prevailing higher-timeframe trend.
    const biases = direction || describe ? mtfAt(i) : null;
    if (direction) {
      const rule = mtf.trendRule(biases, direction, s.mtf || 'trend');
      if (!rule.allowed) fails.push(`mtf: ${rule.reason}`);
    }
    const base = direction || describe ? withRegime(head) : { ...head, regime: null, regimes: s.regimes || null, inRegime: null };
    return {
      ...base,
      signal: s.signal,
      direction: direction || null,
      filtersFailed: fails,
      candidate: Boolean(direction) && session && base.inRegime === true && fails.length === 0,
      entryRef: bars[i].c,
      stopDistance: stopDistance === null ? null : Math.round(stopDistance * 1e4) / 1e4,
      ...(s.compiledTarget ? { targetDistance: targetDistance === null ? null : Math.round(targetDistance * 1e4) / 1e4 } : {}),
      minRR: s.risk.min_rr,
      exit: exitPlan(s),
      ...(biases ? { mtf: mtf.ruleSummary(biases, s.mtf || 'trend') } : {}),
      ...(ruleDetail ? { rules: ruleDetail } : {}),
      // Detector state on this bar (e.g. a CRT sweep's range, extreme, and why it did or didn't fire).
      ...(describe && s.signal === 'rules' ? (d => (Object.keys(d).length ? { detail: d } : {}))(rulesSource(s).explain(i, JSON.stringify([s.rules, s.risk, s.exit]))) : {}),
    };
  }

  return { at, regimeAt, length: bars.length, bars };
}

module.exports = { DEFAULT_WINDOW, createEvaluator, inSessions, timeframeMs, exitPlan, tradeExitPlan, composedExit };
