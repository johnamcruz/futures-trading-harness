'use strict';

/**
 * Mechanical backtest of STRATEGY.md strategies on historical bars, modeled on
 * the original bot's backtest (backtest.drive + bot.handle_bar + SimBroker):
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
 * the original bot.
 *
 * With an account profile (`account`, accounts/<name>/ACCOUNT.md) the run is
 * a prop challenge: trades are sized from the account's cushion
 * (combine.js), equity touching the max-loss floor inside a bar is a blow,
 * the firm's daily limit flattens the day, and the run ends on pass, blow, or
 * timeout. Several markets share the one account and trade one position at a
 * time across it (as the live gateway enforces): a setup on one market waits
 * while another's trade is open, so a stopped trade never reaches the floor or
 * the daily limit. A policy strategy's run (`prop`) takes every setup the
 * account's budget can size, in its contract mode, and exits every trade by
 * the policy strategy's own exit block, as the live runner does. This account
 * mode is the reference layer 2 (prop/attempts.js) is tested against, attempt
 * by attempt (tests/lib/prop-evaluator.test.js).
 *
 * Fills are the simulated broker's (sim-broker.js, one per market): by default
 * (`fill: 'next-open'`) a market entry fills at the next bar's open plus
 * `slippageTicks` (1), as live, where the order goes in during the next bar;
 * `fill: 'close'` at the signal bar's close, as the original bot does. A setup
 * whose fill bar opens through its stop or (for a target level) its target, or
 * falls in another trading day or after end of day, expires untraded
 * (`expired`). Results are in R (1R = the initial stop distance, before costs,
 * as the original bot reports) and in dollars after fees and slippage.
 */

const { createEvaluator, timeframeMs } = require('../trading/evaluator');
const { exitPlan, tradeExitPlan, tradesRoot } = require('../trading/strategies');
const { swingSeries } = require('../trading/exit-trail');

/** A book's swing level at bar i on `minutes` candles: a long's latest confirmed swing low, a short's high (computed once per book). */
function swingAt(book, minutes, sign, i) {
  book.swings = book.swings || new Map();
  if (!book.swings.has(minutes)) book.swings.set(minutes, swingSeries(book.bars, minutes));
  const s = book.swings.get(minutes);
  return (sign > 0 ? s.low : s.high)[i];
}
const { createSimBroker, onTick } = require('./sim-broker');
const { parseWindows, inWindow, tradingDayStart, tradingDayKey, inMarketHours, sessionMinute, sessionMinuteOf, EARLY_CLOSE_MIN, SESSION_DEFAULTS } = require('../trading/clock');
const { loadConfig } = require('../trading/config');
const ind = require('../trading/indicators');
const combine = require('../trading/combine');
const { ceiling } = require('../trading/rulebook');
const { familyOf, specFor } = require('../trading/contracts');
const { requireFee, feePerSide } = require('../trading/accounts');

const { normalizeBars } = ind;

/** Round half to even, as Python's round() (the original bot's tick math). */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

const DEFAULTS = {
  size: 1,
  riskPerTrade: null, // $ risked per trade; sizes contracts from the stop (like the original bot's --risk)
  // Backtest-only (a plain run, no account): contracts at most. Never used for an account, whose limit is its own
  // (ACCOUNT.md max_contracts, through combine.contractPlan).
  maxContracts: require('../tunables').replay().backtest.maxContracts, // config/replay.json backtest
  // Per market fill (entries and stops), in ticks: the floor a prop size counts for its stop (combine.js
  // MIN_STOP_SLIPPAGE_TICKS; a policy's rulebook may state more, never less).
  slippageTicks: combine.MIN_STOP_SLIPPAGE_TICKS,
  fill: 'next-open', // 'next-open': entries fill at the next bar's open (live latency); 'close': at the signal bar's close
  minConfluence: 1, // strategies that must fire the same side on the bar (the entry's own included)
  // Strategies firing both sides on the bar: 'reversal' (as the live gate: only a reversal strategy, mtf: reversal,
  // may enter), 'skip' (no entry), or 'priority' (the first in order trades, as the original bot had no such rule).
  conflict: 'reversal',
  // A plain run's fee per contract per side (each market's own, else this): none is refused, never assumed. An
  // account run's fees are its ACCOUNT.md fees_per_side (accounts.js requireFee).
  feesPerSide: null,
  gate: true,
  // Backtest-only (a plain run, no account): $ realized loss that ends the trading day (0 = off). Never used for an
  // account, whose daily limits are its own: ACCOUNT.md daily_loss_limit and RULEBOOK.md daily_loss_soft (combine.js).
  maxDailyLoss: require('../tunables').replay().backtest.maxDailyLoss,
  sessions: [...SESSION_DEFAULTS.sessions],
  eodAt: SESSION_DEFAULTS.eodAt,
  earlyCloseDates: [], // trading days (YYYY-MM-DD they end on) closing at 13:00 ET: end of day at earlyCloseEodAt
  earlyCloseEodAt: SESSION_DEFAULTS.earlyCloseEodAt,
  closedDates: [], // holidays: no trading at all
  window: require('../trading/evaluator').DEFAULT_WINDOW, // config/analysis.json evaluator.windowBars
  account: null, // an account profile: run as a prop challenge (combine.js)
  // An account run's sizing: a policy's rulebook entry, every key (combine.SIZING_KEYS); else the policy strategy's
  // own (prop.strategy.sizing, which the strategy loader takes from the rulebook). None is refused.
  sizing: null,
  prop: null, // a policy strategy's run: { strategy (its STRATEGY.md: exit), components (the names of the strategies it trades: the only ones a setup is picked from), contracts (micro | mini | auto) }
  prepared: null, // from prepare(): reuse the evaluator across runs
  // The evaluator's trade stream (prop/trade-stream.js): one position at a time across the markets without an
  // account, as a prop attempt trades; an entry fills at the open of the first bar at least this long after the
  // signal bar's close (the model's cycle delay; 0: the next bar's open); and each trade's adverse path (troughTicks).
  onePosition: false,
  entryDelayMs: 0,
  tracePath: false,
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
/**
 * Per symbol: bars, the evaluator over the whole series, the strategies that
 * trade it, and cached setups.
 * Reusable across runs (episodes) on the same data.
 */
/** The setup behind an entry, for the trade record: stop, target, and detector state on the signal bar. */
function setupOf(book, pick, i) {
  const why = book.ev.at(pick.s, i, { describe: true });
  return {
    signalBar: book.bars[i].t, close: book.bars[i].c, stopDistance: pick.r.stopDistance, regime: why.regime || null,
    ...(why.targetDistance ? { targetDistance: why.targetDistance } : {}),
    ...(why.detail ? { detail: why.detail } : {}),
  };
}

function prepare(markets, strategies, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const skipped = new Map(); // strategy -> reason, for strategies that can't be traded mechanically
  const books = markets.map(m => {
    const bars = normalizeBars(m.bars).map((b, i) => ({ ...b, ms: Date.parse(b.t), i }));
    const usable = strategies.filter(s => {
      if (!s.valid || s.status === 'disabled') return false;
      // Each market is a selected contract: a rules strategy trades the selected leg of its family, as live.
      if (!tradesRoot(s, m.symbol, [m.symbol])) return false;
      if (s.signal === 'manual') { skipped.set(s.name, 'manual strategies need the LLM'); return false; }
      if (!/^atr:/.test(typeof s.risk.stop === 'string' ? s.risk.stop : '') && !s.compiledStop) { skipped.set(s.name, `stop "${s.risk.stop}" has no mechanical distance`); return false; }
      return true;
    });
    const ev = createEvaluator(bars, { window: o.window });
    const memo = new Map();
    // The first candidate on bar i, in strategy order (the scan at the bar's close), with its
    // confluence: how many strategies fired its side and how many the other. A policy run picks
    // only from the strategies it trades (prop.components: its active ones, as live), while every
    // strategy given counts toward confluence and conflict (a paper one too, as in the live scan).
    const traded = o.prop && Array.isArray(o.prop.components) ? new Set(o.prop.components) : null;
    const setupAt = i => {
      if (!memo.has(i)) {
        const fired = [];
        for (const s of usable) {
          const r = ev.at(s, i, { describe: false });
          if (r.candidate && r.direction) fired.push({ s, r });
        }
        let pick = fired.find(f => f.r.stopDistance > 0 && (!traded || traded.has(f.s.name))) || null;
        if (pick) {
          const withIt = fired.filter(f => f.r.direction === pick.r.direction).length;
          const against = fired.length - withIt;
          const conflicted = against > 0 && (o.conflict === 'skip' || (o.conflict === 'reversal' && pick.s.mtf !== 'reversal'));
          if (withIt < (o.minConfluence || 1) || conflicted) pick = null;
          else pick = { ...pick, confluence: withIt, against };
        }
        memo.set(i, pick);
      }
      return memo.get(i);
    };
    return { ...m, bars, ev, usable, setupAt };
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
  // Run-local position state over the shared, prepared books: each market's simulated broker.
  const books = prepared.books.map(b => ({ ...b, broker: createSimBroker({ tickSize: b.tickSize, slippageTicks: o.slippageTicks }), lastIndex: null }));
  // The prop challenge, when the run has an account.
  const account = o.account;
  let cs = account ? combine.start(account) : null;
  // Account-wide state, like the live order gate (per trading day).
  let day = null;
  let entriesToday = 0;
  let closesToday = []; // { pnl, ts } of closed trades this trading day
  let equity = 0;
  const curve = [];
  let expired = 0; // setups whose next-bar fill never happened (gap through the stop or target, new day, end of day)

  const tfMs = book => timeframeMs(`${o.timeframe}m`) || (book.bars[1] ? book.bars[1].ms - book.bars[0].ms : 60000);
  // Records a broker exit ({ position, price, reason, gross, fees, net }) as a trade.
  const closeTrade = (book, bar, { position: p, price, reason, gross, fees, net }) => {
    const t = {
      symbol: book.symbol, contract: p.contract, strategy: p.strategy, direction: p.sign > 0 ? 'long' : 'short',
      entryTime: p.entryTime, entry: p.entry, initialStop: p.initialStop, exitTime: new Date(bar.ms + tfMs(book)).toISOString(),
      exit: price, size: p.size, risk: p.risk,
      // The dollars at risk (stop distance x size x tick value): net / riskUsd is the trade's net R.
      riskUsd: round2((p.risk / book.tickSize) * p.tickValue * p.size),
      r: Math.round(((p.sign * (price - p.entry)) / p.risk) * 1000) / 1000,
      mfeR: Math.round(p.peakR * 1000) / 1000,
      maeR: Math.round(p.troughR * 1000) / 1000,
      barsHeld: p.barsHeld, reason, pnl: round2(gross), fees: round2(fees), net: round2(net),
      confluence: p.confluence || 1, conflict: p.conflict || 0,
      target: p.target,
      ...(p.troughPath ? { troughTicks: p.troughPath.slice() } : {}),
      // Why it was taken: the setup's stop and target distances and its detectors' state (trades.jsonl).
      ...(p.setup ? { setup: p.setup } : {}),
    };
    trades.push(t);
    equity += net;
    curve.push({ t: t.exitTime, equity: round2(equity) });
    // The live gate counts losses from the broker's P&L (search_trades), before fees; the daily
    // dollar limit counts net.
    closesToday.push({ pnl: gross, net, ts: bar.ms + tfMs(book) });
    if (cs) cs = combine.applyClose(cs, net, gross);
  };
  // A fee is never assumed: an account run's are its profile's (ACCOUNT.md fees_per_side), the same fee as the live
  // verdict and the gate (prop-state legOf); a plain run's the market's own, else the run's (feesPerSide).
  const plainFee = book => {
    const f = book.feesPerSide ?? o.feesPerSide;
    if (!(typeof f === 'number' && Number.isFinite(f) && f >= 0)) throw new Error(`${book.symbol}: no fee per side (the market's feesPerSide, or the run's); a fee is never assumed`);
    return f;
  };
  // A contract of the book's micro/mini family, priced with the account's fee: one the account may trade (max above
  // 0) without a fee is refused; one it may not trade needs none (contractPlan never sizes an unpriced leg).
  const legOf = (book, root) => {
    const spec = { ...(specFor(root) || {}), ...(root === book.symbol ? { tickValue: book.tickValue } : {}) };
    const max = (account && account.max_contracts && account.max_contracts[root]) || 0;
    return { root, tickValue: spec.tickValue, fee: max > 0 ? requireFee(account, root) : feePerSide(account, root), max };
  };
  const legsOf = book => {
    const fam = familyOf(book.symbol);
    return fam ? { micro: legOf(book, fam.micro), mini: legOf(book, fam.mini) } : { micro: legOf(book, book.symbol), mini: null };
  };
  // An account run's trades are priced by its legs; a plain run's by the market's fee.
  const feeOf = book => (account ? null : plainFee(book));
  // Refused up front, not at the first setup: every market's fee (a plain run's, or each tradable leg's), and an
  // account run's sizing (the rulebook's).
  for (const b of books) { if (account) legsOf(b); else plainFee(b); }
  const sizing = account ? combine.requireSizing(o.sizing || (o.prop && o.prop.strategy && o.prop.strategy.sizing), `${account.name}: an account run sizes from a policy's rulebook entry`) : null;
  // The day's realized-loss stop: a plain run's maxDailyLoss (backtest-only); an account's own limits instead
  // (combine.js: the firm's daily_loss_limit and the rulebook's daily_loss_soft), never the backtest default.
  const dailyStopUsd = account ? 0 : o.maxDailyLoss;

  const timeline = [];
  books.forEach((b, k) => {
    const from = Math.max(o.window - 1, lowerBound(b.bars, o.start ?? -Infinity));
    const to = o.end === undefined || o.end === null ? b.bars.length : lowerBound(b.bars, o.end);
    for (let i = from; i < to; i += 1) timeline.push([b.bars[i].ms, k, i]);
  });
  if (books.length > 1) timeline.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // Bars that close together settle on every market first (fills, stops, targets, trails, end of
  // day), then look for entries in market order, as live: the runner reads every symbol's closed
  // bar and the account before the cycle. Otherwise a later market's stop-out at this bar would
  // still block an earlier market's setup (one position at a time) that live would take.
  const STOP = Symbol('stop');
  const settle = (k, i) => {
    const book = books[k];
    const bar = book.bars[i];
    const closeAt = new Date(bar.ms + tfMs(book));
    const dayKey = tradingDayStart(closeAt).getTime();
    if (dayKey !== day) {
      if (day !== null) {
        // Nothing is carried into a new trading day: close what yesterday left
        // (data with no bar after the close) at its last bar.
        for (const b of books) {
          const p = b.broker.position;
          if (!p || p.tradingDay === dayKey) continue;
          if (p.pending) { b.broker.cancel(); expired += 1; } else closeTrade(b, b.bars[b.lastIndex], b.broker.exit(b.bars[b.lastIndex].c, 'eod'));
        }
        if (cs) {
          cs = combine.endDay(cs);
          if (cs.status !== 'active') return STOP;
        }
      }
      day = dayKey;
      entriesToday = 0;
      closesToday = [];
    }
    book.lastIndex = i;

    // The exchange calendar, as live: holidays have no session; early closes
    // end at 13:00 ET with end of day at earlyCloseEodAt.
    const tday = tradingDayKey(closeAt);
    const early = earlyDays.has(tday);
    const eod = early && eodEarly ? eodEarly : eodNormal;
    const afterEod = closedDays.has(tday) || (eod && sessionMinute(closeAt) >= sessionMinuteOf(eod, closeAt))
      || !inMarketHours(closeAt, { until: early ? EARLY_CLOSE_MIN : undefined });

    // 0. A setup from the previous bar fills at this bar's open (fill: next-open), or expires.
    const broker = book.broker;
    if (broker.position && broker.position.pending) {
      const q = broker.position;
      const waiting = q.fillAt && bar.ms < q.fillAt; // the cycle is still running: no fill yet
      if (afterEod || !inMarketHours(new Date(bar.ms)) || q.tradingDay !== dayKey) broker.cancel();
      else if (!waiting && broker.fillAtOpen(bar)) q.entryTime = bar.t;
      // Gapped through its stop, or a target level the fill reached (or under the strategy's min_rr): dropped.
      if (!broker.position) expired += 1;
      else if (!broker.position.pending) entriesToday += 1;
    }

    // 1. Broker: the resting stop and target against this bar (any position here was entered
    // before this bar). A prop account's floor and daily limit act first, at the worst price
    // the trade sees in the bar. Nothing is carried past the close into the next trading day
    // (the day change above closes it at the previous bar's close).
    const guard = cs && (worst => {
      const worstNet = broker.netAt(worst);
      // Equity reached the max-loss floor: the firm liquidates there.
      if (combine.touches(cs, worstNet)) return { price: broker.priceForNet(cs.floor - cs.balance), reason: 'blow' };
      // The firm's daily loss limit: flattened there, no trading until tomorrow.
      if (combine.dailyBreached(cs, worstNet)) return { price: broker.priceForNet(-cs.dailyLimit - cs.dayPnl), reason: 'daily_limit' };
      return null;
    });
    const settled = broker.onBar(bar, { guard });
    if (settled) {
      closeTrade(book, bar, settled);
      if (settled.reason === 'blow') { cs = combine.blow(cs); return STOP; }
      if (settled.reason === 'daily_limit') cs = { ...cs, dayStopped: true };
    }

    // 2. Manage an open trade at the bar's close. Like the original bot's
    // handle_bar, a bar that started with a trade open only manages it: a
    // trade closed here (trail, max bars, end of day) leaves no entry this bar.
    const q = broker.position;
    if (q) {
      // A structure trail past the target (exit-trail.js): the swing confirmed by this bar's close, on the trade's side.
      const after = q.plan && q.plan.afterTarget;
      const swing = after && after.trailBy === 'structure' ? swingAt(book, after.swingMinutes, q.sign, i) : null;
      const done = broker.manage(bar, { swing }) || (afterEod ? broker.exit(bar.c, 'eod') : null);
      if (done) closeTrade(book, bar, done);
    }
    return { book, bar, i, closeAt, afterEod, managed: Boolean(q) };
  };
  const enter = ({ book, bar, i, closeAt, afterEod, managed }) => {
    // 3. Flat: look for an entry, as the live loop does after each closed bar.
    if (managed || book.broker.position || !book.usable.length) return;
    // Entries at the bar's close need market hours and time before end of day,
    // and the bar itself must lie in market hours.
    if (afterEod || !inMarketHours(new Date(bar.ms))) return;
    if (cs && combine.entryBlock(cs)) return;
    // A prop attempt trades one position at a time across the whole account, as live (the gateway's
    // prop-one-position check): each size assumes no other open risk, so with several markets a
    // setup waits while another market's trade is open or about to fill.
    if ((cs || o.onePosition) && books.some(b => b.broker.position)) return;
    if (o.gate) {
      if (sessions.length && !sessions.some(w => inWindow(closeAt, w))) return;
      if (noEntry.some(w => inWindow(closeAt, w))) return;
      if (entryHours.length && !entryHours.some(w => inWindow(closeAt, w))) return;
      if (gateCfg.maxEntriesPerDay > 0 && entriesToday >= gateCfg.maxEntriesPerDay) return;
      const losses = closesToday.filter(c => c.pnl < 0);
      if (losses.length >= gateCfg.maxDailyLosses) return;
      if (dailyStopUsd > 0 && closesToday.reduce((a, c) => a + c.net, 0) <= -dailyStopUsd) return;
      // As the live gate: a loss extends the streak, a win ends it, a scratch neither.
      let streak = 0;
      for (let c = closesToday.length - 1; c >= 0 && closesToday[c].pnl <= 0; c -= 1) if (closesToday[c].pnl < 0) streak += 1;
      const lastLoss = [...closesToday].reverse().find(c => c.pnl < 0);
      if (streak >= gateCfg.maxConsecutiveLosses && closeAt.getTime() - lastLoss.ts < gateCfg.lossCooldownMin * 60000) return;
    }
    const pick = book.setupAt(i);
    if (!pick) return;
    const sign = pick.r.direction === 'long' ? 1 : -1;
    const stopTicks = Math.max(1, roundHalfEven(pick.r.stopDistance / book.tickSize));
    const risk = onTick(stopTicks * book.tickSize, book.tickSize);
    // A policy strategy's trades exit by its exit (tradeExitPlan): mode trail, its trail; mode target, the setup's own.
    const plan = o.prop ? tradeExitPlan(o.prop.strategy, pick.s) : exitPlan(pick.s);
    let size = o.riskPerTrade
      ? Math.min(o.maxContracts, Math.max(1, Math.floor(o.riskPerTrade / (stopTicks * book.tickValue))))
      : Math.min(o.maxContracts, o.size);
    let leg = { root: book.symbol, tickValue: book.tickValue, fee: feeOf(book) };
    if (cs) {
      // Prop challenge: the size from the account's cushion and clock, in micros
      // or minis (contracts mode), within its limits. Same as live (combine.contractPlan).
      const fam = familyOf(book.symbol);
      const legs = legsOf(book);
      const sizeFor = fraction => combine.contractPlan({
        dollars: combine.budget(cs, sizing), room: combine.room(cs), stopTicks, legs, mode: (o.prop && o.prop.contracts) || 'micro',
        guard: sizing.min_size_guard, fraction, ratio: fam ? fam.ratio : 10, slipTicks: sizing.stop_slippage_ticks, minContracts: sizing.min_contracts,
      });
      // Times the verdict's multiplier (the rulebook's enforced items, as prop/verdict.js): 0 skips the setup.
      const { multiplier } = ceiling(o.prop && o.prop.strategy ? o.prop.strategy.multipliers : [], {}, closeAt);
      // The live entry's limits over the sizing where the run states them (o.prop.limits: { capUsd, orderMax }; the
      // composed cap and the broker's max, prop/size-translate.js limitPlan), then the floor again, with the floor
      // stretch as live (the rulebook's floor_stretch_max_usd while the attempt, cs, is healthy).
      const cp = multiplier > 0 ? require('../prop/size-translate').limitPlan(sizeFor(multiplier), {
        limits: (o.prop && o.prop.limits) || null,
        minContracts: sizing.min_contracts, ratio: fam ? fam.ratio : 1, miniRoot: legs.mini ? legs.mini.root : null,
        stretchUsd: sizing.floor_stretch_max_usd, state: cs,
      }) : null;
      if (!cp) return;
      size = cp.size;
      leg = legs.micro.root === cp.root ? legs.micro : legs.mini;
    }
    const fam = familyOf(book.symbol);
    const pos = book.broker.submitMarket({
      sign, risk, size, tickValue: leg.tickValue, fee: leg.fee, plan,
      // As the original bot: target ticks from the unrounded stop distance.
      target: plan.targetR ? { ticks: Math.max(1, roundHalfEven((plan.targetR * pick.r.stopDistance) / book.tickSize)) }
        // exit.target: a level, the signal bar's close plus the distance (e.g. the far side of a CRT range);
        // the broker refuses an entry whose fill is already at or past it, or under min_rr.
        : plan.target ? { price: pick.r.targetDistance > 0 ? onTick(bar.c + sign * roundHalfEven(pick.r.targetDistance / book.tickSize) * book.tickSize, book.tickSize) : null }
          : null,
      minRR: plan.target && !plan.targetR ? pick.s.risk.min_rr || 0 : 0,
      strategy: pick.s.name, contract: leg.root, mini: Boolean(fam && leg.root === fam.mini),
      entryIndex: i, entryTime: closeAt.toISOString(), tradingDay: tradingDayStart(closeAt).getTime(),
      confluence: pick.confluence || 1, conflict: pick.against || 0,
      setup: setupOf(book, pick, i),
      ...(o.entryDelayMs > 0 && o.fill === 'next-open' ? { fillAt: closeAt.getTime() + o.entryDelayMs } : {}),
      ...(o.tracePath ? { troughPath: [] } : {}),
    }, { price: bar.c, fill: o.fill === 'next-open' ? 'next-open' : 'close' });
    // next-open: fills at the next bar's open (step 0 there).
    if (pos && !pos.pending) entriesToday += 1;
  };
  for (let g = 0, stop = false; g < timeline.length && !stop;) {
    let h = g + 1;
    while (h < timeline.length && timeline[h][0] === timeline[g][0]) h += 1;
    const ready = [];
    for (let x = g; x < h && !stop; x += 1) {
      const r = settle(timeline[x][1], timeline[x][2]);
      if (r === STOP) stop = true;
      else ready.push(r);
    }
    if (!stop) for (const r of ready) enter(r);
    g = h;
  }

  // Settle anything still open at the end of the data, at the last close.
  for (const book of books) {
    const p = book.broker.position;
    if (p && p.pending) { book.broker.cancel(); expired += 1; } else if (p) {
      const last = book.bars[book.lastIndex];
      closeTrade(book, last, book.broker.exit(last.c, 'end'));
    }
  }
  return { trades, equity: curve, skipped: Object.fromEntries(skipped), combine: cs, expired };
}

module.exports = { roundHalfEven, DEFAULTS, prepare, runEngine };
