'use strict';

/**
 * The evaluator's first layer (docs/LEARNED-RULEBOOK.md R6.1): trade generation, slow and deterministic. The
 * backtest engine (backtest/engine.js, the code live uses: the strategies' evaluator, fills, fees, slippage
 * and the trailing exit) runs a policy strategy's strategies over the bars once, without an account, one
 * position at a time across its markets as an attempt trades, and every setup it takes becomes a trade of
 * the stream, in R and ticks, so the second layer (prop/attempts.js) can size and replay it under any
 * account state and rulebook without re-running the bars.
 *
 * Each trade records:
 * - its outcome: the move in ticks from the fill to the exit, the stop in ticks, R, its adverse path (each
 *   deeper trough in ticks, in order: the second layer replays the floor and the daily limit on it), the
 *   adverse excursion in R, and its order within the day;
 * - its stop overshoot: ticks a stop exit filled past the stop beyond the expected slippage (gaps, fast
 *   markets), resampled by the bootstrap (R9);
 * - its no-stop path: the worst move and the last close until the end of the day, for a stop that wasn't
 *   working (an injected fault, R9);
 * - its price path, bar by bar from the fill to the end of its day ([open, adverse, favourable, close] in ticks
 *   the trade's way; pathEnds: when each of those bars closes), and its own exit (its component's target in ticks from the fill and its trail, the policy's
 *   exit aside), and the structure trail's swing levels along that path (each swing timeframe a rulebook may name, as
 *   confirmed by each bar's close), so the second layer can exit it under another exit mode (prop/attempts.js exitAs);
 * - its facts, by the functions live uses, never a copy: the scan (trading/strategies.js scan: the
 *   confluence) and the briefing (trading/briefing.js buildBriefing: the trend rule, the multi-timeframe
 *   read, the room to the first level in its way and the room it needs), on the bars the runner hands a
 *   cycle (autotrader historyBars), and the regime on its signal bar. A fact that can't be computed is
 *   recorded as an error, never guessed (R4: the rulebook's multiplier fails closed on it).
 *
 * Entries fill after the model's cycle delay (`entryDelayMs`: at the open of the first bar at least that long
 * after the signal bar's close; 0 is the next bar's open). Dollar limits (the account's and the engine's
 * maxDailyLoss) are left to the second layer, which sizes; the gate's count rules (losses per day, the loss
 * streak cooldown, entries per day) apply here, on the stream.
 */

const { runEngine, prepare, DEFAULTS } = require('../backtest/engine');
const { tradingDayStart, tradingDayKey, sessionMinute, sessionMinuteOf } = require('../trading/clock');
const { fieldPaths } = require('../backtest/bar-fields');
const { scan } = require('../trading/strategies');
const { buildBriefing } = require('../trading/briefing');
const { historyBars, parseAt } = require('../autotrader');
const { exitPlan } = require('../trading/evaluator');
const { SWING_TFS, swingSeries } = require('../trading/exit-trail');
const { roundHalfEven } = require('../backtest/engine');
const { REGIME_PARAMS } = require('../trading/regime');

const round6 = x => Math.round(x * 1e6) / 1e6;

/** The trading-day starts with a bar in any of the books (markets), in order: every market's days, not the first's. */
function tradingDays(books) {
  const set = new Set();
  for (const book of books) {
    let last = null;
    for (const b of book.bars) {
      const d = tradingDayStart(new Date(b.ms + 1)).getTime();
      if (d !== last) { set.add(d); last = d; }
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** A conservative cycle delay from measured cycle times (ms): the given percentile (0.9 by default), or 0 with none. */
function delayFromCycles(durationsMs, percentile = 0.9) {
  const xs = (durationsMs || []).filter(x => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!xs.length) return 0;
  return xs[Math.min(xs.length - 1, Math.ceil(percentile * xs.length) - 1)];
}

/**
 * Each trading day's volatility regime, from the first market's bars: the day's range against the mean range
 * of the `lookback` days before it (only earlier days: causal): 'high' at the live regime's highVol multiple or more,
 * 'low' at its lowVol multiple or less (trading/regime.js REGIME_PARAMS, the cutoffs' one home), else 'normal' (and
 * 'normal' before any history). Map day key -> regime.
 * Sharing 1.4 / 0.7 with the live regime is deliberate: a different statistic (a day's range against the mean of the
 * days before it, not a bar's ATR ratio), the same cutoffs, so one number says what a high or low volatility day is.
 * Fewer days clear them than at the old 1.25 / 0.8, so on a short window stats.js has fewer high/low days and falls
 * back to the whole pool.
 */
function dayRegimes(bars, tfMs, lookback = 20) {
  const ranges = new Map();
  for (const b of bars) {
    const k = tradingDayKey(new Date(b.ms + tfMs));
    const r = ranges.get(k) || { h: -Infinity, l: Infinity };
    r.h = Math.max(r.h, b.h);
    r.l = Math.min(r.l, b.l);
    ranges.set(k, r);
  }
  const out = new Map();
  const past = [];
  for (const [k, r] of ranges) {
    const range = r.h - r.l;
    const recent = past.slice(-lookback);
    const mean = recent.length ? recent.reduce((a, x) => a + x, 0) / recent.length : null;
    out.set(k, !mean ? 'normal' : range >= REGIME_PARAMS.highVol * mean ? 'high' : range <= REGIME_PARAMS.lowVol * mean ? 'low' : 'normal');
    past.push(range);
  }
  return out;
}

/**
 * The trade's price path from the fill bar to the end of that trading day (the end-of-day flatten, as the engine
 * exits): each bar as [open, adverse extreme, favourable extreme, close], signed ticks from the entry, the trade's
 * way. null when no bar is at or after the fill.
 */
function pricePath(book, t, opts) {
  const sign = t.direction === 'long' ? 1 : -1;
  const at = x => round6((sign * (x - t.entry)) / book.tickSize);
  const idx = pathIndexes(book, t, opts);
  return idx.length ? idx.map(k => { const b = book.bars[k]; return [at(b.o), at(sign > 0 ? b.l : b.h), at(sign > 0 ? b.h : b.l), at(b.c)]; }) : null;
}

/** When each bar of the trade's price path closes (ms): a re-exited trade's exit time (prop/attempts.js exitAs). */
function pathEnds(book, t, opts) {
  const idx = pathIndexes(book, t, opts);
  return idx.length ? idx.map(k => book.bars[k].ms + opts.tfMs) : null;
}

/** The book's bar indexes of a trade's path: from the fill bar to the end of that trading day (the end-of-day flatten). */
function pathIndexes(book, t, { tfMs, eod }) {
  const fillMs = Date.parse(t.entryTime);
  let k = book.bars.findIndex(b => b.ms >= fillMs);
  if (k < 0) return [];
  const day = tradingDayStart(new Date(book.bars[k].ms + tfMs)).getTime();
  const out = [];
  for (; k < book.bars.length; k += 1) {
    const closeAt = new Date(book.bars[k].ms + tfMs);
    if (tradingDayStart(closeAt).getTime() !== day) break;
    out.push(k);
    if (eod && sessionMinute(closeAt) >= sessionMinuteOf(eod, closeAt)) break;
  }
  return out;
}

/**
 * The structure trail's levels along a trade's path (exit-trail.js swingSeries, by each bar's close, never later bars):
 * per swing timeframe a structure trail may name (SWING_TFS), one value per path bar, the latest confirmed swing on
 * the trade's side (a long's swing low, a short's high) in signed ticks from the entry, the trade's way; null with none.
 */
function swingPath(book, t, opts) {
  const sign = t.direction === 'long' ? 1 : -1;
  const idx = pathIndexes(book, t, opts);
  if (!idx.length) return null;
  book.swings = book.swings || new Map();
  return Object.fromEntries(Object.entries(SWING_TFS).map(([tf, m]) => {
    if (!book.swings.has(m)) book.swings.set(m, swingSeries(book.bars, m));
    const s = book.swings.get(m);
    return [tf, idx.map(k => { const v = (sign > 0 ? s.low : s.high)[k]; return v === null ? null : round6((sign * (v - t.entry)) / book.tickSize); })];
  }));
}

/** The worst move and the last close (signed ticks from the entry) from the fill bar to the end of that trading day. */
function noStopPath(book, t, opts) {
  const p = pricePath(book, t, opts);
  return p ? { worstTicks: round6(Math.min(0, ...p.map(x => x[1]))), closeTicks: p[p.length - 1][3] } : null;
}

/**
 * The trade's own exit, its component's (exitPlan), whatever exit the policy ran it with: the target in ticks from
 * the fill (a target in R from the setup's stop distance, or a level from the signal bar's close, as the engine
 * places them; null without one) and the component's own trail in R (null without one).
 */
function ownExit(t, component, tick) {
  if (!component) return null;
  const plan = exitPlan(component);
  const sign = t.direction === 'long' ? 1 : -1;
  const setup = t.setup || {};
  let level = null;
  if (plan.targetR && setup.stopDistance > 0) level = t.entry + sign * Math.max(1, roundHalfEven((plan.targetR * setup.stopDistance) / tick)) * tick;
  else if (plan.target && setup.targetDistance > 0 && Number.isFinite(setup.close)) level = setup.close + sign * roundHalfEven(setup.targetDistance / tick) * tick;
  const targetTicks = level === null ? null : round6((sign * (level - t.entry)) / tick);
  return { targetTicks: targetTicks !== null && targetTicks > 0 ? targetTicks : null, trailActivateR: plan.trailActivateR, trailGivebackR: plan.trailGivebackR };
}

/** The facts at a trade's setup, by the live scan and briefing on the bars a cycle is handed. */
function factsAt(book, t, { strategies, tfMin, count, roundSteps = null }) {
  const signal = t.setup && t.setup.signalBar;
  const i = book.index.get(signal);
  if (i === undefined) return { error: `no bar at the signal time ${signal}` };
  try {
    const bars = book.bars.slice(Math.max(0, i + 1 - count), i + 1).map(({ t: bt, o, h, l, c, v, ...rest }) => {
      const { ms: _ms, i: _i, ...fields } = rest;
      return { t: bt, o, h, l, c, v, ...fields };
    });
    const results = scan(strategies, bars, { symbol: book.symbol, selected: [book.symbol] });
    const brief = buildBriefing({ symbol: book.symbol, bars, minutes: tfMin, scan: results, roundSteps, now: new Date(Date.parse(signal) + tfMin * 60000) });
    const c = (brief.sections.m3.data.candidates || []).find(x => x.name === t.strategy && x.direction === t.direction);
    if (!c) return { error: `the scan on the signal bar has no ${t.direction} ${t.strategy} candidate` };
    return {
      trendRule: c.trendRule, alignment: c.alignment, roomR: c.inTheWay ? c.inTheWay.R : null, inTheWay: c.inTheWay ? c.inTheWay.name : null,
      needR: c.needR, confluence: { with: (c.confluence && c.confluence.with || []).length, against: (c.confluence && c.confluence.against || []).length },
      vwapSide: c.vwapSide, regime: (t.setup && t.setup.regime) || null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Run layer 1. markets: [{ symbol, bars, tickSize, tickValue, feesPerSide }] (bars at the policy's timeframe);
 * strategies: every strategy the scan counts (the policy's `counted`), in its order; prop: { strategy (the policy
 * strategy), components (the names it trades), contracts }; engine: the backtest options (gateConfig, sessions,
 * eodAt, window, fill, slippageTicks, ...); from, to: ms bounds of the window (to exclusive); facts: false skips
 * them (faster; a rulebook that reads facts then fails closed on every trade); roundSteps: the briefing's
 * round-number config (round-numbers.js), by default the engine's gateConfig's, the one the evaluation loaded.
 *
 * Returns { days: [{ day, regime, trades }] (every trading day with bars in the window, in order),
 * trades, fieldBranch (the traded strategies that read broker fields), entryDelayMs, slippageTicks, expired,
 * skipped, runtimeMs }.
 */
function tradeStream({ markets, strategies, prop, engine = {}, from = null, to = null, facts = true, entryDelayMs = 0, regimeLookback = 20, roundSteps = (engine.gateConfig || {}).roundSteps || null }) {
  const started = Date.now();
  if (!prop || !prop.strategy || !Array.isArray(prop.components) || !prop.components.length) throw new Error('prop: { strategy, components, contracts }: the policy strategy and the strategies it trades');
  if (!(Number.isFinite(entryDelayMs) && entryDelayMs >= 0)) throw new Error(`entryDelayMs: 0 or more, not ${String(entryDelayMs)}`);
  const o = {
    ...DEFAULTS, ...engine, account: null, sizing: null, prop, maxDailyLoss: 0, onePosition: true, entryDelayMs, tracePath: true,
    start: from, end: to,
  };
  if (o.fill !== 'next-open' && entryDelayMs > 0) throw new Error('entryDelayMs needs fill: next-open');
  const prepared = prepare(markets, strategies, o);
  const res = runEngine(markets, strategies, { ...o, prepared });
  const books = new Map(prepared.books.map(b => [b.symbol, { ...b, index: new Map(b.bars.map((x, k) => [x.t, k])) }]));
  const tfMin = Number(o.timeframe) || Math.round((prepared.books[0].bars[1].ms - prepared.books[0].bars[0].ms) / 60000);
  const tfMs = tfMin * 60000;
  const eod = parseAt(o.eodAt);
  const count = historyBars(tfMin);
  const regimes = dayRegimes(prepared.books[0].bars, tfMs, regimeLookback);
  const slip = o.slippageTicks;
  const trades = res.trades.map(t => {
    const book = books.get(t.symbol);
    const sign = t.direction === 'long' ? 1 : -1;
    const tick = book.tickSize;
    const stopTicks = Math.round(t.risk / tick);
    const moveTicks = round6((sign * (t.exit - t.entry)) / tick);
    const stopped = t.reason === 'stop';
    return {
      day: tradingDayKey(new Date(Date.parse(t.exitTime))), symbol: t.symbol, strategy: t.strategy, direction: t.direction,
      entryTime: t.entryTime, exitTime: t.exitTime, reason: t.reason, tickSize: tick, tickValue: book.tickValue,
      stopTicks, moveTicks, r: t.r, maeR: t.maeR, mfeR: t.mfeR, troughTicks: t.troughTicks || [],
      overshootTicks: stopped ? Math.max(0, round6((sign * (t.initialStop - t.exit)) / tick - slip)) : null,
      noStop: noStopPath(book, t, { tfMs, eod }),
      path: pricePath(book, t, { tfMs, eod }),
      pathEnds: pathEnds(book, t, { tfMs, eod }),
      swingPath: swingPath(book, t, { tfMs, eod }),
      ownExit: ownExit(t, strategies.find(x => x.name === t.strategy) || null, tick),
      facts: facts ? factsAt(book, t, { strategies, tfMin, count, roundSteps }) : { error: 'facts not computed (facts: false)' },
    };
  });
  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.day)) byDay.set(t.day, []);
    const list = byDay.get(t.day);
    t.seq = list.length;
    list.push(t);
  }
  // from and to are session starts (prop/evaluator.js sessionStart): a day is in the window when its session starts in it.
  const days = tradingDays(prepared.books)
    .filter(d => (from === null || d >= from) && (to === null || d < to))
    .map(d => tradingDayKey(new Date(d + 12 * 3600000)))
    .map(k => ({ day: k, regime: regimes.get(k) || 'normal', trades: byDay.get(k) || [] }));
  const traded = new Set(prop.components);
  const fieldBranch = strategies.filter(s => traded.has(s.name) && fieldPaths(s).length).map(s => s.name);
  return {
    days, trades, fieldBranch, entryDelayMs, slippageTicks: slip, expired: res.expired, skipped: res.skipped,
    timeframe: tfMin, runtimeMs: Date.now() - started,
  };
}

module.exports = { tradeStream, tradingDays, delayFromCycles, dayRegimes, noStopPath, pricePath, pathEnds, swingPath, ownExit, factsAt };
