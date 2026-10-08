'use strict';

/**
 * Mechanical backtest of STRATEGY.md strategies on historical bars, modeled on
 * algoTraderBot's backtest (backtest.drive + bot.handle_bar + SimBroker):
 *
 *   for each closed bar (all symbols, in time order):
 *     1. the simulated broker settles the open trade against the bar: stop
 *        first, then target (a bar touching both is a loss);
 *     2. at the bar's close, an open trade is managed: trailing stop
 *        (trail.js), max-bars, end-of-day flatten;
 *     3. flat, every strategy is evaluated on the bar (evaluator.js, the same
 *        code the live scan runs) and the first candidate, in strategy order,
 *        enters at the bar's close with its stop (and target).
 *
 * The harness's own entry rules apply as they do live (`gate: true`): the
 * runner's sessions and end of day, the order gate's no-entry windows, loss
 * streak cooldown, daily loss count, and daily entry cap. Set `gate: false`
 * to trade the strategies the way algoTraderBot does (around the clock, no
 * limits) when comparing with it.
 *
 * Fills: market entries at the bar close plus `slippageTicks`; stops at the
 * stop price (or the bar's open when it gapped through) minus slippage;
 * targets at the target price (or a better open); trailing closes at the bar
 * close. Results are in R (1R = the initial stop distance, before costs, as
 * algoTraderBot reports) and in dollars after fees and slippage.
 */

const { createEvaluator, timeframeMs } = require('../trading/evaluator');
const { exitPlan } = require('../trading/strategies');
const { trailStep, snapStop } = require('../trading/trail');
const { parseWindows, inWindow, tradingDayStart, minutesOfDay } = require('../trading/clock');
const { loadConfig } = require('../trading/config');
const { normalizeBars } = require('../trading/indicators');

const DEFAULTS = {
  size: 1,
  riskPerTrade: null, // $ risked per trade; sizes contracts from the stop (like algoTraderBot --risk)
  maxContracts: 5,
  slippageTicks: 0,
  feesPerSide: null, // per contract; default from the contract spec
  gate: true,
  maxDailyLoss: 500, // $ realized loss that ends the trading day, like projectx-mcp's PROJECTX_MAX_DAILY_LOSS (0 = off)
  sessions: ['09:35-15:00@America/New_York'],
  eodAt: '15:50@America/New_York',
  window: 500,
};

function parseAt(spec) {
  const m = /^(\d{1,2}):(\d{2})@(.+)$/.exec(String(spec || '').trim());
  return m ? { minute: Number(m[1]) * 60 + Number(m[2]), timeZone: m[3] } : null;
}

const round2 = x => Math.round(x * 100) / 100;

/**
 * @param markets [{ symbol, bars (normalized, timeframe bars), tickSize, tickValue, feesPerSide }]
 * @param strategies loaded STRATEGY.md objects, in priority order
 * @param opts { start, end (ms), ...DEFAULTS, gateConfig (order-gate config) }
 * @returns { trades, equity, skipped }
 */
function runEngine(markets, strategies, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const gateCfg = o.gateConfig || loadConfig({});
  const sessions = parseWindows((o.sessions || []).join(',')).windows;
  const noEntry = parseWindows(gateCfg.noEntryWindows).windows;
  const eod = parseAt(o.eodAt);
  const trades = [];
  const skipped = new Map(); // strategy -> reason, for strategies that can't be traded mechanically

  // Per symbol: evaluator over its whole series, the strategies that trade it.
  const books = markets.map(m => {
    const bars = normalizeBars(m.bars).map((b, i) => ({ ...b, ms: Date.parse(b.t), i }));
    const usable = strategies.filter(s => {
      if (!s.valid || s.status === 'disabled') return false;
      if (!s.instruments.includes(m.symbol)) return false;
      if (s.signal === 'manual') { skipped.set(s.name, 'manual strategies need the LLM'); return false; }
      if (!/^atr:/.test(s.risk.stop) && s.signal !== 'cisd_ote') { skipped.set(s.name, `stop "${s.risk.stop}" has no mechanical distance`); return false; }
      return true;
    });
    return { ...m, bars, ev: createEvaluator(bars, { window: o.window }), usable, pos: null };
  });

  // Account-wide state, like the live order gate (per trading day).
  let day = null;
  let entriesToday = 0;
  let closesToday = []; // { pnl, ts } of closed trades this trading day
  let equity = 0;
  const curve = [];

  const tfMs = book => timeframeMs(`${o.timeframe}m`) || (book.bars[1] ? book.bars[1].ms - book.bars[0].ms : 60000);
  const closeTrade = (book, bar, price, reason) => {
    const p = book.pos;
    const ticks = Math.round((p.sign * (price - p.entry)) / book.tickSize * 1e6) / 1e6;
    const gross = ticks * book.tickValue * p.size;
    const fees = 2 * (book.feesPerSide ?? 0.37) * p.size;
    const net = gross - fees;
    const t = {
      symbol: book.symbol, strategy: p.strategy, direction: p.sign > 0 ? 'long' : 'short',
      entryTime: p.entryTime, entry: p.entry, initialStop: p.initialStop, exitTime: new Date(bar.ms + tfMs(book)).toISOString(),
      exit: price, size: p.size, risk: p.risk,
      r: Math.round(((p.sign * (price - p.entry)) / p.risk) * 1000) / 1000,
      mfeR: Math.round(p.peakR * 1000) / 1000,
      barsHeld: p.barsHeld, reason, pnl: round2(gross), fees: round2(fees), net: round2(net),
    };
    trades.push(t);
    equity += net;
    curve.push({ t: t.exitTime, equity: round2(equity) });
    closesToday.push({ pnl: net, ts: bar.ms + tfMs(book) });
    book.pos = null;
  };

  const timeline = [];
  books.forEach((b, k) => b.bars.forEach(bar => {
    if (bar.ms >= (o.start ?? -Infinity) && bar.ms < (o.end ?? Infinity) && bar.i >= o.window - 1) timeline.push([bar.ms, k, bar.i]);
  }));
  timeline.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  for (const [, k, i] of timeline) {
    const book = books[k];
    const bar = book.bars[i];
    book.lastIndex = i;
    const closeAt = new Date(bar.ms + tfMs(book));
    const dayKey = tradingDayStart(closeAt).getTime();
    if (dayKey !== day) {
      day = dayKey;
      entriesToday = 0;
      closesToday = [];
    }

    // 1. Broker: the resting stop and target against this bar.
    const p = book.pos;
    if (p && i > p.entryIndex) {
      const slip = o.slippageTicks * book.tickSize;
      const stopHit = p.sign > 0 ? bar.l <= p.stop : bar.h >= p.stop;
      const targetHit = p.target !== null && (p.sign > 0 ? bar.h >= p.target : bar.l <= p.target);
      p.peakR = Math.max(p.peakR, (p.sign * ((p.sign > 0 ? bar.h : bar.l) - p.entry)) / p.risk);
      if (stopHit) {
        const base = p.sign > 0 ? Math.min(bar.o, p.stop) : Math.max(bar.o, p.stop);
        closeTrade(book, bar, base - p.sign * slip, p.stop === p.initialStop ? 'stop' : 'trail');
      } else if (targetHit) {
        closeTrade(book, bar, p.sign > 0 ? Math.max(bar.o, p.target) : Math.min(bar.o, p.target), 'target');
      } else {
        p.barsHeld += 1;
      }
    }

    // 2. Manage an open trade at the bar's close.
    const afterEod = eod && o.gate && minutesOfDay(closeAt, eod.timeZone) >= eod.minute;
    if (book.pos && i > book.pos.entryIndex) {
      const q = book.pos;
      const step = trailStep(q, bar, q.plan, book.tickSize);
      q.stop = step.stop;
      q.peakR = step.peakR;
      if (step.close) closeTrade(book, bar, step.close.price, 'trail');
      else if (q.plan.maxBars && q.barsHeld >= q.plan.maxBars) closeTrade(book, bar, bar.c, 'max_bars');
      else if (afterEod) closeTrade(book, bar, bar.c, 'eod');
    } else if (book.pos && afterEod) {
      closeTrade(book, bar, bar.c, 'eod');
    }

    // 3. Flat: look for an entry, as the live loop does after each closed bar.
    if (book.pos || !book.usable.length) continue;
    if (o.gate) {
      if (afterEod) continue;
      if (sessions.length && !sessions.some(w => inWindow(closeAt, w))) continue;
      if (noEntry.some(w => inWindow(closeAt, w))) continue;
      if (gateCfg.maxEntriesPerDay > 0 && entriesToday >= gateCfg.maxEntriesPerDay) continue;
      const losses = closesToday.filter(c => c.pnl < 0);
      if (losses.length >= gateCfg.maxDailyLosses) continue;
      if (o.maxDailyLoss > 0 && closesToday.reduce((a, c) => a + c.pnl, 0) <= -o.maxDailyLoss) continue;
      let streak = 0;
      for (let c = closesToday.length - 1; c >= 0 && closesToday[c].pnl < 0; c -= 1) streak += 1;
      if (streak >= gateCfg.maxConsecutiveLosses && closeAt.getTime() - closesToday[closesToday.length - 1].ts < gateCfg.lossCooldownMin * 60000) continue;
    }
    let pick = null;
    for (const s of book.usable) {
      const r = book.ev.at(s, i, { now: closeAt, describe: false });
      if (r.candidate && r.stopDistance > 0) { pick = { s, r }; break; }
    }
    if (!pick) continue;
    const sign = pick.r.direction === 'long' ? 1 : -1;
    const entry = bar.c + sign * o.slippageTicks * book.tickSize;
    const stopTicks = Math.max(1, Math.round(pick.r.stopDistance / book.tickSize));
    const risk = stopTicks * book.tickSize;
    const plan = exitPlan(pick.s);
    const size = o.riskPerTrade
      ? Math.min(o.maxContracts, Math.max(1, Math.floor(o.riskPerTrade / (stopTicks * book.tickValue))))
      : Math.min(o.maxContracts, o.size);
    book.pos = {
      strategy: pick.s.name, sign, entry, risk, size, plan,
      stop: entry - sign * risk, initialStop: entry - sign * risk,
      target: plan.targetR ? snapStop(entry + sign * plan.targetR * risk, -sign, book.tickSize) : null,
      entryIndex: i, entryTime: closeAt.toISOString(), peakR: 0, barsHeld: 0,
    };
    entriesToday += 1;
  }

  // Settle anything still open at the end of the data, at the last close.
  for (const book of books) {
    if (book.pos) {
      const last = book.bars[book.lastIndex];
      closeTrade(book, last, last.c, 'end');
    }
  }
  return { trades, equity: curve, skipped: Object.fromEntries(skipped) };
}

module.exports = { DEFAULTS, runEngine };
