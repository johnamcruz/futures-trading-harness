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
 * Market hours are a hard rule, always applied: entries only in the market
 * session (18:00-16:00 ET, Sunday evening to Friday) and before end of day
 * (`eodAt`), and every trade is closed at end of day; none is carried past
 * the 16:00 ET close. The harness's other entry rules apply
 * as they do live (`gate: true`): the runner's sessions, the order gate's
 * no-entry windows, loss streak cooldown, daily loss count, and daily entry
 * cap. `gate: false` drops those (not the market hours) when comparing with
 * algoTraderBot.
 *
 * With an account profile (`account`, accounts/<name>/ACCOUNT.md) the run is
 * a prop challenge: trades are sized from the account's cushion
 * (combine.js), equity touching the max-loss floor inside a bar is a blow,
 * the firm's daily limit flattens the day, and the run ends on pass, blow, or
 * timeout. With a `policy` (rl/policy-bundle.js) the policy decides, through the
 * same code the live runner uses, whether to take each setup and at what
 * size, and whether to close a trade that is past its ratchet. The
 * challenge env (rl/challenge-env.js) trains on exactly this loop.
 *
 * Fills: market entries at the bar close plus `slippageTicks`; stops at the
 * stop price (or the bar's open when it gapped through) minus slippage;
 * targets at the target price (or a better open); trailing closes at the bar
 * close. Results are in R (1R = the initial stop distance, before costs, as
 * algoTraderBot reports) and in dollars after fees and slippage.
 */

const { createEvaluator, timeframeMs } = require('../trading/evaluator');
const { exitPlan } = require('../trading/strategies');
const { trailStep } = require('../trading/trail');
const { parseWindows, inWindow, tradingDayStart, tradingDayKey, inMarketHours, sessionMinute, sessionMinuteOf, EARLY_CLOSE_MIN } = require('../trading/clock');
const { loadConfig } = require('../trading/config');
const ind = require('../trading/indicators');
const combine = require('../trading/combine');
const { familyOf, specFor } = require('../trading/contracts');
const { buildObservation } = require('../rl/observation');

const { normalizeBars } = ind;

/** Round half to even, as Python's round() (algoTraderBot's tick math). */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

const DEFAULTS = {
  size: 1,
  riskPerTrade: null, // $ risked per trade; sizes contracts from the stop (like algoTraderBot --risk)
  maxContracts: 5,
  slippageTicks: 0,
  feesPerSide: null, // per contract; default from the contract spec
  gate: true,
  maxDailyLoss: 500, // $ realized loss that ends the trading day, like projectx-mcp's PROJECTX_MAX_DAILY_LOSS (0 = off)
  sessions: ['18:00-15:50@America/New_York'],
  eodAt: '15:50@America/New_York',
  earlyCloseDates: [], // trading days (YYYY-MM-DD they end on) closing at 13:00 ET: end of day at earlyCloseEodAt
  earlyCloseEodAt: '12:50@America/New_York',
  closedDates: [], // holidays: no trading at all
  window: 500,
  account: null, // an account profile: run as a prop challenge (combine.js)
  sizing: null, // combine sizing (combine.DEFAULT_SIZING keys)
  policy: null, // { decide(kind, obs, info) } -> 'skip' | 'half' | 'full' at a setup, 'hold' | 'close' in a trade
  prop: null, // a policy strategy's run: { strategy (its STRATEGY.md: exit), components (names, the observation's order), contracts (micro | mini | auto) }
  prepared: null, // from prepare(): reuse the evaluator and features across runs
};

function parseAt(spec) {
  const m = /^(\d{1,2}):(\d{2})@(.+)$/.exec(String(spec || '').trim());
  return m ? { minute: Number(m[1]) * 60 + Number(m[2]), timeZone: m[3] } : null;
}

const round2 = x => Math.round(x * 100) / 100;
/** A price on the tick grid, free of float noise (2045.1 - 0.2 is 2044.9, not 2044.8999999999999). */
const onTick = (x, tick) => Math.round(Math.round(x / tick) * tick * 1e9) / 1e9;

/**
 * @param markets [{ symbol, bars (normalized, timeframe bars), tickSize, tickValue, feesPerSide }]
 * @param strategies loaded STRATEGY.md objects, in priority order
 * @param opts { start, end (ms), ...DEFAULTS, gateConfig (order-gate config) }
 * @returns { trades, equity, skipped }
 */
/**
 * Per symbol: bars, the evaluator over the whole series, the strategies that
 * trade it, cached setups, and the market features the policy observes.
 * Reusable across runs (episodes) on the same data.
 */
function prepare(markets, strategies, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const skipped = new Map(); // strategy -> reason, for strategies that can't be traded mechanically
  const books = markets.map(m => {
    const bars = normalizeBars(m.bars).map((b, i) => ({ ...b, ms: Date.parse(b.t), i }));
    const usable = strategies.filter(s => {
      if (!s.valid || s.status === 'disabled') return false;
      if (!s.instruments.includes(m.symbol)) return false;
      if (s.signal === 'manual') { skipped.set(s.name, 'manual strategies need the LLM'); return false; }
      if (!/^atr:/.test(typeof s.risk.stop === 'string' ? s.risk.stop : '') && !s.compiledStop) { skipped.set(s.name, `stop "${s.risk.stop}" has no mechanical distance`); return false; }
      return true;
    });
    const ev = createEvaluator(bars, { window: o.window });
    const memo = new Map();
    // The first candidate on bar i, in strategy order (the scan at the bar's close).
    const setupAt = i => {
      if (!memo.has(i)) {
        let pick = null;
        for (const s of usable) {
          const r = ev.at(s, i, { describe: false });
          if (r.candidate && r.stopDistance > 0) { pick = { s, r }; break; }
        }
        memo.set(i, pick);
      }
      return memo.get(i);
    };
    const feats = { atr20: ind.atr(bars, 20), atr100: ind.atr(bars, 100), adx: ind.adx(bars, 14) };
    return { ...m, bars, ev, usable, setupAt, feats };
  });
  return { books, skipped };
}

/** First bar index with ms >= t (bars sorted by time). */
function lowerBound(bars, t) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].ms < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function runEngine(markets, strategies, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const gateCfg = o.gateConfig || loadConfig({});
  const sessions = parseWindows((o.sessions || []).join(',')).windows;
  const noEntry = parseWindows(gateCfg.noEntryWindows).windows;
  const entryHours = parseWindows(gateCfg.entryHours || '').windows;
  const eodNormal = parseAt(o.eodAt);
  const eodEarly = parseAt(o.earlyCloseEodAt);
  const earlyDays = new Set(o.earlyCloseDates || []);
  const closedDays = new Set(o.closedDates || []);
  const trades = [];
  const prepared = o.prepared || prepare(markets, strategies, o);
  const skipped = new Map(Object.entries(Object.fromEntries(prepared.skipped)));
  // Run-local position state over the shared, prepared books.
  const books = prepared.books.map(b => ({ ...b, pos: null, lastIndex: null }));
  // The prop challenge, when the run has an account.
  const account = o.account;
  let cs = account ? combine.start(account) : null;
  const decisions = [];
  let wins = 0; // closed trades after fees: won, lost (the policy is rewarded on both)
  let losses = 0;
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
    const gross = ticks * p.tickValue * p.size;
    const fees = 2 * p.fee * p.size;
    const net = gross - fees;
    const t = {
      symbol: book.symbol, contract: p.contract, strategy: p.strategy, direction: p.sign > 0 ? 'long' : 'short',
      entryTime: p.entryTime, entry: p.entry, initialStop: p.initialStop, exitTime: new Date(bar.ms + tfMs(book)).toISOString(),
      exit: price, size: p.size, risk: p.risk,
      r: Math.round(((p.sign * (price - p.entry)) / p.risk) * 1000) / 1000,
      mfeR: Math.round(p.peakR * 1000) / 1000,
      maeR: Math.round(p.troughR * 1000) / 1000,
      barsHeld: p.barsHeld, reason, pnl: round2(gross), fees: round2(fees), net: round2(net),
    };
    trades.push(t);
    if (net > 0) wins += 1;
    else if (net < 0) losses += 1;
    equity += net;
    curve.push({ t: t.exitTime, equity: round2(equity) });
    // The live gate counts losses from ProjectX P&L, before fees; the daily
    // dollar limit counts net.
    closesToday.push({ pnl: gross, net, ts: bar.ms + tfMs(book) });
    if (cs) cs = combine.applyClose(cs, net);
    book.pos = null;
  };
  const feeOf = book => (account && account.fees_per_side && account.fees_per_side[book.symbol] !== undefined
    ? account.fees_per_side[book.symbol] : book.feesPerSide ?? 0.37);
  // A contract of the book's micro/mini family: the account's fee, else the spec's.
  // The same fee as the live verdict and the gate (prop-state legOf): the account's, else the contract spec's.
  const legOf = (book, root) => {
    const spec = { ...(specFor(root) || {}), ...(root === book.symbol ? { tickValue: book.tickValue } : {}) };
    const fee = account && account.fees_per_side && account.fees_per_side[root] !== undefined ? account.fees_per_side[root]
      : spec.feesPerSide ?? feeOf(book);
    return { root, tickValue: spec.tickValue, fee, max: (account && account.max_contracts && account.max_contracts[root]) || 0 };
  };
  // Dollars per point for an open position, and its net P&L at a price.
  const perPoint = (book, p) => (p.tickValue / book.tickSize) * p.size;
  const openNet = (book, p, price) => p.sign * (price - p.entry) * perPoint(book, p) - 2 * p.fee * p.size;
  // The price at which the open position's net P&L equals `net` (rounded against the trade).
  const priceForNet = (book, p, net) => {
    const raw = p.entry + p.sign * ((net + 2 * p.fee * p.size) / perPoint(book, p));
    const t = book.tickSize;
    return p.sign > 0 ? Math.floor(raw / t + 1e-9) * t : Math.ceil(raw / t - 1e-9) * t;
  };
  const ask = (kind, book, i, closeAt, extra) => {
    const obs = buildObservation({ cs, account, book, i, closeAt, components: o.prop ? o.prop.components : [], ...extra });
    const action = o.policy.decide(kind, obs, { symbol: book.symbol, t: book.bars[i].t, balance: cs ? cs.balance : null, wins, losses, ...extra });
    decisions.push({ kind, t: book.bars[i].t, symbol: book.symbol, action, balance: cs ? cs.balance : null });
    return action;
  };

  const timeline = [];
  books.forEach((b, k) => {
    const from = Math.max(o.window - 1, lowerBound(b.bars, o.start ?? -Infinity));
    const to = o.end === undefined || o.end === null ? b.bars.length : lowerBound(b.bars, o.end);
    for (let i = from; i < to; i += 1) timeline.push([b.bars[i].ms, k, i]);
  });
  if (books.length > 1) timeline.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  for (const [, k, i] of timeline) {
    const book = books[k];
    const bar = book.bars[i];
    const closeAt = new Date(bar.ms + tfMs(book));
    const dayKey = tradingDayStart(closeAt).getTime();
    if (dayKey !== day) {
      if (day !== null) {
        // Nothing is carried into a new trading day: close what yesterday left
        // (data with no bar after the close) at its last bar.
        for (const b of books) {
          if (b.pos && b.pos.tradingDay !== dayKey) closeTrade(b, b.bars[b.lastIndex], b.bars[b.lastIndex].c, 'eod');
        }
        if (cs) {
          cs = combine.endDay(cs);
          if (cs.status !== 'active') break;
        }
      }
      day = dayKey;
      entriesToday = 0;
      closesToday = [];
    }
    book.lastIndex = i;

    // 1. Broker: the resting stop and target against this bar.
    // Hard rule: no trade is carried past the close into the next trading
    // day. If the data has no bar between end of day and this one, close at
    // the previous bar's close.
    const p = book.pos;
    if (p && i > p.entryIndex) {
      const slip = o.slippageTicks * book.tickSize;
      const stopHit = p.sign > 0 ? bar.l <= p.stop : bar.h >= p.stop;
      const targetHit = p.target !== null && (p.sign > 0 ? bar.h >= p.target : bar.l <= p.target);
      p.peakR = Math.max(p.peakR, (p.sign * ((p.sign > 0 ? bar.h : bar.l) - p.entry)) / p.risk);
      const stopFill = stopHit ? onTick((p.sign > 0 ? Math.min(bar.o, p.stop) : Math.max(bar.o, p.stop)) - p.sign * slip, book.tickSize) : null;
      // The worst price the trade sees in this bar: its stop fill, or the bar's extreme.
      const worst = stopHit ? stopFill : (p.sign > 0 ? bar.l : bar.h);
      p.troughR = Math.min(p.troughR, (p.sign * (worst - p.entry)) / p.risk);
      const worstNet = openNet(book, p, worst);
      if (cs && combine.touches(cs, worstNet)) {
        // Equity reached the max-loss floor: the firm liquidates there.
        closeTrade(book, bar, priceForNet(book, p, cs.floor - cs.balance), 'blow');
        cs = combine.blow(cs);
        break;
      } else if (cs && combine.dailyBreached(cs, worstNet)) {
        // The firm's daily loss limit: flattened there, no trading until tomorrow.
        closeTrade(book, bar, priceForNet(book, p, -cs.dailyLimit - cs.dayPnl), 'daily_limit');
        cs = { ...cs, dayStopped: true };
      } else if (stopHit) {
        closeTrade(book, bar, stopFill, p.stop === p.initialStop ? 'stop' : 'trail');
      } else if (targetHit) {
        closeTrade(book, bar, p.sign > 0 ? Math.max(bar.o, p.target) : Math.min(bar.o, p.target), 'target');
      } else {
        p.barsHeld += 1;
      }
    }

    // 2. Manage an open trade at the bar's close. Like algoTraderBot's
    // handle_bar, a bar that started with a trade open only manages it: a
    // trade closed here (trail, max bars, end of day) leaves no entry this bar.
    // The exchange calendar, as live: holidays have no session; early closes
    // end at 13:00 ET with end of day at earlyCloseEodAt.
    const tday = tradingDayKey(closeAt);
    const early = earlyDays.has(tday);
    const eod = early && eodEarly ? eodEarly : eodNormal;
    const afterEod = closedDays.has(tday) || (eod && sessionMinute(closeAt) >= sessionMinuteOf(eod, closeAt))
      || !inMarketHours(closeAt, { until: early ? EARLY_CLOSE_MIN : undefined });
    let managed = false;
    if (book.pos && i > book.pos.entryIndex) {
      const q = book.pos;
      managed = true;
      const step = trailStep(q, bar, q.plan, book.tickSize);
      q.stop = onTick(step.stop, book.tickSize);
      q.peakR = step.peakR;
      if (step.close) closeTrade(book, bar, step.close.price, 'trail');
      else if (q.plan.maxBars && q.barsHeld >= q.plan.maxBars) closeTrade(book, bar, bar.c, 'max_bars');
      else if (afterEod) closeTrade(book, bar, bar.c, 'eod');
      else if (o.policy && q.plan.trailActivateR !== null && q.peakR >= q.plan.trailActivateR
        && ask('position', book, i, closeAt, { pos: q }) === 'close') {
        // Past the ratchet, the policy may bank the trade (before it, only the stop and trail run).
        closeTrade(book, bar, bar.c, 'policy');
      }
    } else if (book.pos && afterEod) {
      managed = true;
      closeTrade(book, bar, bar.c, 'eod');
    }

    // 3. Flat: look for an entry, as the live loop does after each closed bar.
    if (managed || book.pos || !book.usable.length) continue;
    // Entries at the bar's close need market hours and time before end of day,
    // and the bar itself must lie in market hours.
    if (afterEod || !inMarketHours(new Date(bar.ms))) continue;
    if (cs && combine.entryBlock(cs)) continue;
    if (o.gate) {
      if (sessions.length && !sessions.some(w => inWindow(closeAt, w))) continue;
      if (noEntry.some(w => inWindow(closeAt, w))) continue;
      if (entryHours.length && !entryHours.some(w => inWindow(closeAt, w))) continue;
      if (gateCfg.maxEntriesPerDay > 0 && entriesToday >= gateCfg.maxEntriesPerDay) continue;
      const losses = closesToday.filter(c => c.pnl < 0);
      if (losses.length >= gateCfg.maxDailyLosses) continue;
      if (o.maxDailyLoss > 0 && closesToday.reduce((a, c) => a + c.net, 0) <= -o.maxDailyLoss) continue;
      // As the live gate: a loss extends the streak, a win ends it, a scratch neither.
      let streak = 0;
      for (let c = closesToday.length - 1; c >= 0 && closesToday[c].pnl <= 0; c -= 1) if (closesToday[c].pnl < 0) streak += 1;
      const lastLoss = [...closesToday].reverse().find(c => c.pnl < 0);
      if (streak >= gateCfg.maxConsecutiveLosses && closeAt.getTime() - lastLoss.ts < gateCfg.lossCooldownMin * 60000) continue;
    }
    const pick = book.setupAt(i);
    if (!pick) continue;
    const sign = pick.r.direction === 'long' ? 1 : -1;
    const entry = onTick(bar.c + sign * o.slippageTicks * book.tickSize, book.tickSize);
    const stopTicks = Math.max(1, roundHalfEven(pick.r.stopDistance / book.tickSize));
    const risk = onTick(stopTicks * book.tickSize, book.tickSize);
    // A policy strategy's trades all exit by its own exit block.
    const plan = exitPlan(o.prop ? o.prop.strategy : pick.s);
    let size = o.riskPerTrade
      ? Math.min(o.maxContracts, Math.max(1, Math.floor(o.riskPerTrade / (stopTicks * book.tickValue))))
      : Math.min(o.maxContracts, o.size);
    let leg = { root: book.symbol, tickValue: book.tickValue, fee: feeOf(book) };
    if (cs) {
      // Prop challenge: the size from the account's cushion and clock, in micros
      // or minis (contracts mode), within its limits. Same as live (combine.contractPlan).
      const sizing = { ...combine.DEFAULT_SIZING, ...(o.sizing || {}) };
      const fam = familyOf(book.symbol);
      const legs = fam ? { micro: legOf(book, fam.micro), mini: legOf(book, fam.mini) } : { micro: legOf(book, book.symbol), mini: null };
      const sizeFor = fraction => combine.contractPlan({
        dollars: combine.budget(cs, sizing), room: combine.room(cs), stopTicks, legs, mode: (o.prop && o.prop.contracts) || 'micro',
        guard: sizing.min_size_guard, fraction, ratio: fam ? fam.ratio : 10,
      });
      let cp = sizeFor(1);
      if (!cp) continue;
      if (o.policy) {
        const mini = Boolean(fam && cp.root === fam.mini);
        const action = ask('setup', book, i, closeAt, { setup: { sign, stopTicks, size: cp.size, riskUsd: cp.size * cp.riskPerContract, mini, strategy: pick.s.name } });
        if (action === 'skip') continue;
        if (action === 'half') cp = sizeFor(0.5);
        if (!cp) continue;
      }
      size = cp.size;
      leg = legs.micro.root === cp.root ? legs.micro : legs.mini;
    }
    const fam = familyOf(book.symbol);
    book.pos = {
      strategy: pick.s.name, contract: leg.root, tickValue: leg.tickValue, fee: leg.fee, mini: Boolean(fam && leg.root === fam.mini),
      sign, entry, risk, size, plan,
      stop: onTick(entry - sign * risk, book.tickSize), initialStop: onTick(entry - sign * risk, book.tickSize),
      // As algoTraderBot: target ticks from the unrounded stop distance.
      target: plan.targetR ? onTick(entry + sign * Math.max(1, roundHalfEven((plan.targetR * pick.r.stopDistance) / book.tickSize)) * book.tickSize, book.tickSize)
        // exit.target: a level, the signal bar's close plus the distance (e.g. the far side of a CRT range),
        // never on the wrong side of the fill.
        : plan.target && pick.r.targetDistance > 0
          ? onTick(sign > 0 ? Math.max(entry + book.tickSize, bar.c + roundHalfEven(pick.r.targetDistance / book.tickSize) * book.tickSize)
            : Math.min(entry - book.tickSize, bar.c - roundHalfEven(pick.r.targetDistance / book.tickSize) * book.tickSize), book.tickSize)
          : null,
      entryIndex: i, entryTime: closeAt.toISOString(), tradingDay: tradingDayStart(closeAt).getTime(), peakR: 0, troughR: 0, barsHeld: 0,
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
  return { trades, equity: curve, skipped: Object.fromEntries(skipped), combine: cs, decisions };
}

module.exports = { roundHalfEven, DEFAULTS, prepare, runEngine };
