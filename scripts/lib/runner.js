'use strict';

/**
 * The autonomous runner's loop body, with every side effect injected so it
 * can be driven by a simulated clock in tests. scripts/autotrader.js wires it
 * to the real clock, the broker adapter, the filesystem, and the harness CLI.
 *
 * One pass (step):
 *   1. Clock actions first: end-of-day catch-up, end of day, premarket.
 *   2. In session, poll every symbol's bar clock (all symbols, every pass, so
 *      none is starved), with back-off while no bar is published.
 *   3. Gather every symbol whose bar just closed, re-check the kill switch
 *      and cap, then start ONE cycle covering all of them (one harness run at
 *      a time; bars that close during a run are skipped, never queued).
 *   4. Re-resolve each symbol's active contract at the start of every trading
 *      day and after repeated resyncs with no bar (contract roll).
 *   5. Before each bar's cycle, with an account configured:
 *      - on a flat contract, cancel working orders that aren't pending
 *        entries (stops and targets left behind by a closed trade could
 *        otherwise fill into a new, unchecked position);
 *      - with a position from a strategy whose exit trails (exit block),
 *        apply the trailing rule to the bar that just closed (trail.js, the
 *        same rule the backtester uses): tighten the protective stop, or
 *        close at market when the bar already went through the new stop.
 *      Entries (ids, strategy, planned stop) come from the MCP gateway.
 *   6. Prop challenges (prop/live-runner.js), for strategies with an account:
 *      the balance is snapshotted every bar and recorded at end of day; a
 *      policy strategy's sizing screens each setup (a skip starts no cycle;
 *      the verdict is what the gate allows). Its trades exit by its trail.
 *   7. Timeframe lanes (lanes.js, lane-cycle.js): a bar clock per symbol and
 *      lane. The lanes whose bars closed on a pass go into ONE cycle (a lane
 *      due at the same close that hasn't published yet holds it a few
 *      seconds, so a 3m close and the 1m close at that minute are one cycle);
 *      each lane's trigger decides for its own bars (a "signal" lane runs only
 *      on a fire or with something open: no fire and flat costs no model
 *      call). The first lane is the runner's: its bars feed the
 *      multi-timeframe record, the briefing and the trailing stops. With
 *      several lanes, entry verdicts of two policies in one cycle are settled
 *      by priority (the other's skipped and recorded so for the gate), the
 *      cycle's budget is the fastest closed lane's, and each lane's last bar
 *      is kept in the state (a replay pass is a new process).
 */

const { openTrades, describeOpenTrade } = require('./trading/open-trades');
const { zonedParts } = require('./trading/clock');
const { decide, recordRun, prompts, signalDecision, dayKey, endOfDayAt, historyShownLines } = require('./autotrader');
const { decisionEntry, marketOf, parseResult, withPositions } = require('./trading/decision-history');
const { barStep, sleepMs } = require('./bar-clock');
const { contractRoot, contractMonthTag } = require('./trading/journal');
const { familyRoot, familyOf } = require('./trading/contracts');
const { specMismatch, validSpec, noSpecsMessage } = require('./trading/broker-specs');
const { isOpen } = require('./trading/positions');
const { coverageError } = require('./trading/exchange-calendar');

// Micros and minis of one index share bars: a position or order in either
// belongs to the symbol polled (MNQ bars manage an NQ trade too).
const famOf = contractId => familyRoot(contractRoot(contractId));
const etTime = iso => { const p = zonedParts(new Date(iso), 'America/New_York'); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ET`; };
const { trailStep } = require('./trading/trail');
const { tradingDayStart, inMarketHours, sessionMinuteOf, MARKET_CLOSE_MIN, MARKET_TZ, parseWindows, inWindow } = require('./trading/clock');

/** Whether a session window of the runner's is open at `now` (a trade cycle could run). */
const inSession = (cfg, now) => inMarketHours(now) && parseWindows(cfg.sessions.join(',')).windows.some(w => inWindow(now, w));
const { exitPlan } = require('./trading/strategies');
const { timeframeMs } = require('./trading/evaluator');
const { lanesOf } = require('./lanes');
const { cycleTimeoutMin, settleCollisions, skippedVerdict, lanesLine, LOWER_PRIORITY, boundHistory, laneHistory } = require('./lane-cycle');

const IDLE_MS = 5000;
const RESYNCS_BEFORE_REROLL = 3;
const MAX_POLL_MS = 10000;
const LOOKUP_RETRY_MS = 30000;
const MAX_RETRY_MS = 60000;
// A close sent this recently may not have filled yet: the contract is not closed (or its orders cancelled) again
// until it settles, so two closes in flight never over-close into the other side.
const CLOSE_SETTLE_MS = 10000;
// End of day that reads the account but doesn't find it flat yet counts as failed runs (kill switch) only after this long.
const UNFLAT_GRACE_MS = 120000;
const FILL_GRACE_MS = 30000;
// The account read for a run's prompt never holds a run up longer than this.
const ACCOUNT_READ_MS = 5000;
// A closing balance that couldn't be recorded is retried this often, this many times.
const CLOSE_RETRY_MS = 60000;
const CLOSE_TRIES = 5;
const STOP_ORDER_TYPES = new Set([3, 4, 5]);
// A failed premarket is tried again after these pauses (then every 10 min), until a session window opens.
const PREMARKET_RETRY_MS = [60000, 120000, 300000, 600000];
// Several lanes: how long a lane due at the same close as one that already closed may keep the cycle waiting.
const COALESCE_HOLD_MS = 10000;

function createRunner(deps) {
  const {
    cfg, root, client, clock, runCycle, isKillSwitchOn, createKillSwitch,
    loadState, saveState, writeBars, scanFor, log = () => {}, entryOrders = () => [], strategyNamed = () => null,
    scanLog = () => {}, // the decision log: one record per scanned bar (trading/scan-log.js scanRecord)
    // The multi-timeframe record the order gate reads (trading/mtf-state.js); returns its trend-rule line.
    recordMtf = () => null,
    // Several lanes: the multi-timeframe record's line as the first lane's bars wrote it (another lane's bar never
    // rewrites it); (sym) -> line or null.
    readMtf = () => null,
    // The day so far (trading/day-context.js): one line for the prompt, or null.
    dayContext = null,
    // A strategy's track record (trading/track-record.js): (name, { regime, at }) -> one line, or null.
    trackRecord = () => null,
    // The journal's entries, for the open trades' setup and initial stop (trading/open-trades.js).
    journalEntries = () => [],
    // Today's premarket plan for a symbol (trading/session-context.js): (symbol, entries, now) -> one line.
    premarketPlan = () => null,
    // Today's closed entries with no review (trading/session-context.js unreviewedLine): (symbols, entries, positions, at, orders) -> line or null.
    unreviewed = () => null,
    // The news blackouts (trading/session-context.js): (now) -> one line.
    news = () => null,
    // The record of the last reviewed trades: ({ entries }) -> "4W/6L, E -0.12R" or null.
    tradesSummary = () => null,
    // An open trade against its strategy's recorded excursions (track-record.js excursionNote): (trade) -> text or null.
    tradeHistory = () => null,
    // The signal record the order gate reads (trading/signal-state.js): what fired on the bar.
    recordSignals = () => {},
    // The bar briefing (trading/briefing.js): the analysis by timeframe, reused until each part expires.
    recordBriefing = () => {},
    // The report cache (trading/report-cache.js): serve({ symbols, account, now }) -> { roles, reports } still valid,
    // record({ symbols, account, now, output, served }) after the cycle. null: every role runs every cycle.
    reportCache = null,
    // The top instincts from the journal's reviews (trading/instincts.js), for the prompt.
    lessons = () => [],
    // The last 10 reviewed trades' outcomes (trading/instincts.js recentTrades), for the prompt.
    recentTrades = () => [],
    event = () => {}, // the event log: one record per thing that happens (cycles, positions, stops, closes, errors)
    prop = null, // prop-challenge hooks (prop/live-runner.js createPropHooks)
    // A closed bar this pass polled: (symbol, { bar, stale, action, contractId, bars }), stale when it closed too long
    // ago to start a cycle, action the pass's (trade, manage, housekeep), bars the window polled (never to be changed).
    // The session record's decision point (session/live.js).
    barClosed = () => {},
    accountReadMs = ACCOUNT_READ_MS,
    // Several lanes: how long a lane due at the same close may hold the cycle. A one-pass process (a replay step)
    // passes 0: it can't wait (its bars are all there at the point; one missing is a gap live would wait out too).
    coalesceHoldMs = COALESCE_HOLD_MS,
  } = deps;
  const entryOrderIds = () => new Set(entryOrders().map(e => Number(e.orderId)));
  let state = loadState();
  let errors = 0;
  let recover = false; // the last trade cycle was stopped mid-run
  let pendingClose = null; // { day, tries, lastTry }: a closing balance still to record
  let unflatPasses = 0; // flatten passes in a row (by one caller, unflatWhy) that found something open or working
  let unflatWhy = null;
  let unflatSince = 0; // when the current run of unflat passes began
  let flattenRead = false; // whether the last flatten pass read the account
  const closedAt = new Map(); // contractId -> when the runner last sent its close
  let calendarCheckedDay = null;
  let eodRunDay = null; // the trading day whose end-of-day agents' run already happened
  // A bar clock per symbol and lane (lanes.js): the first lane's in the symbols' order, then each further lane's.
  const lanes = lanesOf(cfg);
  const multi = lanes.length > 1;
  const laneKey = s => `${s.symbol}|${s.minutes}m`;
  // Several lanes: each lane's last bar, kept in the state (a replay pass is a new process: without it a 3m lane
  // would take its last bar for a new one at every 1m close).
  // { lastBarT, contractId } per lane: a clock is restored only for the contract it was kept on (a roll since starts over).
  const restored = (symbol, minutes) => {
    const r = multi && state && state.laneClocks ? state.laneClocks[`${symbol}|${minutes}m`] : null;
    const ok = r && typeof r.lastBarT === 'string' && Number.isFinite(Date.parse(r.lastBarT)) && typeof r.contractId === 'string';
    return ok ? { restoredFor: r.contractId, clock: { lastBarT: r.lastBarT, expectedCloseAt: Date.parse(r.lastBarT) + 2 * minutes * 60000, pollingSince: null } } : { restoredFor: null, clock: null };
  };
  const syms = lanes.flatMap((lane, li) => cfg.symbols.map(symbol => ({ symbol, lane: li, minutes: lane.timeframe, contractId: null, contractDay: null, ...restored(symbol, lane.timeframe), lastPollAt: 0, misses: 0, resyncs: 0 })));
  let held = []; // several lanes: closed bars waiting (briefly) for a lane due at the same close
  const delayMs = cfg.barDelaySeconds * 1000;
  const sessionWindows = parseWindows(cfg.sessions.join(',')).windows;
  const timeoutMs = cfg.barTimeoutSeconds * 1000;

  /** An event for the event log; a failure to log never stops the pass. */
  function emit(kind, data = {}) {
    try {
      event({ at: clock.now().toISOString(), kind, ...data });
    } catch (_err) {
      // logging is best effort
    }
  }

  /** Run an agent cycle, timed, with its outcome in the event log. */
  async function timedCycle(action, prompt, limits, info = {}) {
    const t0 = clock.now().getTime();
    emit('cycle_start', { action, timeoutMs: limits.timeoutMs, ...info });
    const r = await runCycle(action, prompt, limits);
    // agentError: the agent's own "CYCLE RESULT: error", a decision (replay records it as live and goes on).
    emit('cycle_end', { action, ms: clock.now().getTime() - t0, ok: Boolean(r && r.ok), timedOut: Boolean(r && r.timedOut), result: (r && r.result) || null, ...(r && r.agentError ? { agentError: true } : {}), ...info });
    if (r && r.result) log(`${action}: ${r.result}`);
    return r;
  }

  function record(ok, timedOut, now) {
    errors = ok ? 0 : errors + 1;
    if (errors >= cfg.maxConsecutiveErrors && !isKillSwitchOn()) {
      createKillSwitch(`created by autotrader after ${errors} failed runs at ${now.toISOString()}`);
      emit('kill_switch', { reason: `${errors} failed runs in a row` });
      log(`${errors} failed runs in a row: kill switch created. Remove it to resume.`, 'error');
    }
    if (timedOut) recover = true;
  }

  // The broker's tick specs (the translator records them as it answers): a spec that differs from the
  // static table is said loudly (training would not equal live), once per value.
  const specSaid = new Set();
  const checkSpec = (root, c) => {
    const why = !validSpec(c) ? `${root}: the broker's contract has no usable tick specs (${noSpecsMessage(root)})` : specMismatch(root, c);
    if (why && !specSaid.has(why)) {
      specSaid.add(why);
      log(why, 'error');
    }
  };
  const partnerLookups = new Set();
  // The other contract of the family (NQ for MNQ): a prop budget may size into it, so its specs are recorded too.
  async function lookUpPartner(root) {
    const fam = familyOf(root);
    const partner = fam && (fam.micro === root ? fam.mini : fam.micro);
    if (!partner) return;
    try {
      checkSpec(partner, await client.activeContract(partner));
    } catch (err) {
      // Once per partner and trading day: a prop entry that may size into it is refused until its specs are recorded.
      const key = `partner:${partner}:${dayKey(clock.now())}`;
      if (!specSaid.has(key)) {
        specSaid.add(key);
        log(`${partner}: contract lookup failed (${err.message}); a prop entry that may size into ${partner} is refused until the broker's tick specs for it are recorded`, 'error');
      }
    }
  }

  async function ensureContract(sym, now) {
    const day = dayKey(now);
    if (sym.contractId && sym.contractDay === day && sym.resyncs < RESYNCS_BEFORE_REROLL) return sym;
    // After a failed lookup, retry at most every 30 s; meanwhile keep polling the known contract.
    if (sym.lookupFailedAt && now.getTime() - sym.lookupFailedAt < LOOKUP_RETRY_MS) return sym;
    let c;
    try {
      c = await client.activeContract(sym.symbol);
    } catch (err) {
      log(`${sym.symbol}: contract lookup failed (${err.message})${sym.contractId ? `; staying on ${sym.contractId}` : ''}`, 'error');
      return { ...sym, lookupFailedAt: now.getTime() };
    }
    checkSpec(String(sym.symbol).toUpperCase(), c);
    // Not awaited here (it never holds up the symbol's poll; it catches its own errors): the step awaits it
    // before it returns, so a one-step process (replay) never closes the broker under it.
    const lookup = lookUpPartner(String(sym.symbol).toUpperCase());
    partnerLookups.add(lookup);
    lookup.finally(() => partnerLookups.delete(lookup));
    if (c.id !== sym.contractId) {
      log(`${sym.symbol}: active contract ${sym.contractId ? `${sym.contractId} -> ` : ''}${c.id}`);
      // A roll starts the clock over; the first lookup keeps a lane's clock restored from the state when it was kept
      // on this contract (none with one lane).
      return { ...sym, contractId: c.id, tickSize: c.tickSize, contractDay: day, clock: !sym.contractId && sym.restoredFor === c.id ? sym.clock : null, lastPollAt: 0, misses: 0, resyncs: 0, lookupFailedAt: 0 };
    }
    return { ...sym, tickSize: c.tickSize || sym.tickSize, contractDay: day, resyncs: 0, lookupFailedAt: 0 };
  }

  async function pollSymbol(i, now) {
    let sym = syms[i];
    const { minutes } = sym;
    // The first lane's bars write the symbol's multi-timeframe record; another lane's read it.
    const first = sym.lane === 0;
    try {
      sym = await ensureContract(sym, now);
      syms[i] = sym;
      if (!sym.contractId) return null;
      // Back off while bars aren't being published (halt, break): 2, 4, 8, max 10 s.
      const pollMs = Math.min(MAX_POLL_MS, cfg.barPollSeconds * 1000 * 2 ** Math.max(0, sym.misses - 2));
      const step = await barStep(sym, now, { minutes, delayMs, timeoutMs, pollMs },
        () => client.closedBars(sym.contractId, { minutes, limit: cfg.bars, now }));
      sym = step.sym;
      if (step.event === 'no-bar') sym = { ...sym, misses: sym.misses + 1 };
      if (step.event === 'resync') {
        sym = { ...sym, misses: 0, resyncs: sym.resyncs + 1 };
        log(`${sym.symbol}: no new ${minutes}m bar in time (break, halt, or roll); resynced (${sym.resyncs})`);
      }
      if (step.event === 'bar' || step.event === 'stale') sym = { ...sym, misses: 0, resyncs: 0 };
      syms[i] = sym;
      if (step.event !== 'bar' && step.event !== 'stale') return null;
      // A stale bar (closed while a cycle ran) starts no cycle, but its prices
      // still feed the trailing stop and the leftover-order check.
      const stale = step.event === 'stale' && !recover;
      if (stale) log(`${sym.symbol}: bar ${step.bar.t} closed too long ago to start a cycle; housekeeping only`);
      const bars = step.bars;
      let file = null;
      try {
        file = writeBars(sym, bars);
      } catch (err) {
        // No bars file means no cycle, but housekeeping (stops, flattening)
        // must still see this bar. Counted toward the kill switch.
        log(`${sym.symbol}: could not write the bars file (${err.message}); housekeeping only`, 'error');
        record(false, false, now);
      }
      let trend = null;
      try {
        trend = first ? recordMtf(sym, bars) : readMtf(sym);
      } catch (err) {
        // Without a fresh record the gate refuses trend strategies' entries (fail closed).
        log(`${sym.symbol}: could not record the multi-timeframe read (${err.message}); the gate refuses trend entries`, 'error');
      }
      let day = null;
      let dayError = null;
      try {
        day = dayContext ? dayContext(sym, bars) : null;
      } catch (err) {
        dayError = err.message;
        log(`${sym.symbol}: no day context this bar (${err.message})`, 'error');
      }
      return { symbol: sym.symbol, lane: sym.lane, minutes, contractId: sym.contractId, tickSize: sym.tickSize, bars, stale: stale || file === null, dayError, bar: { t: step.bar.t, c: step.bar.c, file, contractId: sym.contractId, trend, day, recent: bars.slice(-10) } };
    } catch (err) {
      syms[i] = { ...syms[i], lastPollAt: now.getTime() };
      log(`${sym.symbol}: ${err.message}`, 'error');
      return null;
    }
  }

  /** Cancel leftover orders on a flat contract root (never pending entries). */
  async function cleanupFlat(item, { positions, orders }, { noCycles = false } = {}) {
    const root = famOf(item.contractId);
    // Flat means no position in any month or size (micro, mini) of the root (not months netting to zero).
    if (positions.some(p => famOf(p.contractId) === root && isOpen(p))) return;
    // When no cycle may run (kill switch, outside the sessions), a pending
    // entry that fills would have no one to manage it: cancel those too.
    const entries = noCycles ? new Set() : entryOrderIds();
    for (const o of orders.filter(x => famOf(x.contractId) === root && !entries.has(Number(x.id)))) {
      await client.cancelOrder(cfg.account, o.id);
      log(`${item.symbol}: cancelled leftover order ${o.id} (type ${o.type}, side ${o.side}, size ${o.size}) on a flat ${root} position`);
    }
  }

  /**
   * Trailing exit for a position whose strategy trails (exit block), the
   * backtester's rule applied live:
   *   - the trade is matched to the entry the gateway recorded for it (same
   *     root and side, recorded this trading day and no later than the fill);
   *   - 1R comes from the planned bracket, else the working stop when the
   *     trade is first seen, else the "stop <price>" in the rationale, and must
   *     be at least 4 ticks;
   *   - only bars that opened after the fill count (the fill bar's earlier
   *     prices aren't the trade's; a fill within 30 s of a bar's open counts
   *     that bar), and every such bar is applied once, in
   *     order, even the ones that closed while a cycle was running;
   *   - the resting stop order is the truth: the stop is tightened by
   *     modifying it, the new level is kept only once the modify succeeded,
   *     and when a bar went through a level the resting stop wasn't at yet,
   *     the trade is closed at market and its leftover orders are cancelled.
   * State lives in state.trails[contractId], keyed by the position.
   */
  async function trailPosition(item, { positions, orders }) {
    // This month's contract, or its mini/micro sibling (a policy strategy may trade either).
    const fam = famOf(item.contractId);
    const sameMonth = x => x.contractId === item.contractId || (famOf(x.contractId) === fam && contractMonthTag(x.contractId) === contractMonthTag(item.contractId));
    const p = positions.find(x => sameMonth(x) && isOpen(x));
    const cid = p ? p.contractId : item.contractId;
    const trails = { ...(state.trails || {}) };
    const save = t => { trails[item.contractId] = t; state = { ...state, trails }; };
    if (!p) {
      if (trails[item.contractId]) { delete trails[item.contractId]; state = { ...state, trails }; }
      return;
    }
    const tick = Number(item.tickSize) || 0;
    const sign = p.type === 1 ? 1 : p.type === 2 ? -1 : 0;
    const opened = Date.parse(p.creationTimestamp);
    const key = String(p.id ?? `${p.creationTimestamp}|${p.averagePrice}`);
    const protective = orders.filter(o => o.contractId === cid && Number(o.type) === 4 && (Number(o.side) === 0 ? 1 : -1) === -sign);
    const stopOrder = protective.length === 1 ? protective[0] : null;
    let t = trails[item.contractId];
    if (!t || t.key !== key) {
      const side = sign > 0 ? 'buy' : 'sell';
      const firstSeen = clock.now().getTime();
      const fillAt = Number.isFinite(opened) ? opened : firstSeen;
      const dayStart = tradingDayStart(new Date(fillAt)).getTime();
      const rec = [...entryOrders()].reverse().find(e => {
        const at = Date.parse(e.at);
        return contractRoot(e.contractId) === contractRoot(cid) && e.setup && (!e.side || e.side === side)
          && at >= dayStart && at <= fillAt + 120000;
      });
      const strategy = rec && strategyNamed(rec.setup);
      const plan = strategy ? exitPlan(strategy) : null;
      const entry = Number(p.averagePrice);
      let risk = null;
      if (rec && rec.stopTicks && tick) risk = rec.stopTicks * tick;
      else if (stopOrder && sign * (entry - Number(stopOrder.stopPrice)) > 0) risk = sign * (entry - Number(stopOrder.stopPrice));
      else if (rec && rec.stopPrice && sign * (entry - rec.stopPrice) > 0) risk = sign * (entry - rec.stopPrice);
      // Managed: a trailing exit, or a time stop (max_bars), or both.
      const managed = plan && (plan.trailActivateR !== null || plan.maxBars);
      // max_bars counts the strategy's own bars; the runner sees its own timeframe's.
      const tfMin = ((strategy && timeframeMs(strategy.timeframe)) || cfg.timeframe * 60000) / 60000;
      const maxRunnerBars = plan && plan.maxBars ? Math.ceil((plan.maxBars * tfMin) / cfg.timeframe) : null;
      const ok = managed && tick > 0 && risk >= 4 * tick - 1e-9;
      t = ok
        ? { key, setup: rec.setup, sign, entry, risk, stop: entry - sign * risk, peakR: 0, troughR: 0, barsHeld: 0, plan, maxRunnerBars, since: fillAt, lastBarT: null }
        : { key, skip: true };
      save(t);
      if (ok) {
        const how = [plan.trailActivateR !== null ? `activate ${plan.trailActivateR}R, give back ${plan.trailGivebackR}R` : '', plan.maxBars ? `time stop ${plan.maxBars} ${strategy.timeframe} bars = ${maxRunnerBars} ${cfg.timeframe}m bars` : ''].filter(Boolean).join('; ');
        log(`${item.symbol}: managing ${rec.setup} ${sign > 0 ? 'long' : 'short'} from ${entry}, 1R = ${risk} (${how})`);
        emit('position_managed', { symbol: item.symbol, contractId: cid, setup: rec.setup, side: sign > 0 ? 'long' : 'short', size: Number(p.size), entry, risk, stop: entry - sign * risk, plan, maxRunnerBars });
      } else if (managed) log(`${item.symbol}: ${rec.setup} position not managed (no trail, no time stop): no usable initial stop (1R ${risk}, needs 4+ ticks)`, 'error');
    }
    if (t.skip) return;
    // Every bar that opened after the fill (a market fill seconds into a bar
    // counts that bar, as the backtest does) and hasn't been applied yet.
    const bars = item.bars.filter(b => Date.parse(b.t) >= t.since - FILL_GRACE_MS && (t.lastBarT === null || Date.parse(b.t) > Date.parse(t.lastBarT)));
    if (!bars.length) return;
    // With no working stop nothing rests: the planned stop is a level the
    // price must not go through either.
    const resting = stopOrder ? Number(stopOrder.stopPrice) : protective.length ? t.stop : null;
    let peakR = t.peakR;
    let troughR = t.troughR || 0;
    let barsHeld = t.barsHeld || 0;
    let target = resting ?? t.stop;
    let cross = null;
    for (const bar of bars) {
      // A level the resting stop never reached (a modify that failed or came
      // too late) protects nothing: a bar through it means out at market.
      if ((resting === null || sign * (target - resting) > 0) && (sign > 0 ? bar.l <= target : bar.h >= target)) { cross = { bar, stop: target }; break; }
      troughR = Math.min(troughR, (sign * ((sign > 0 ? bar.l : bar.h) - t.entry)) / t.risk);
      const step = trailStep({ ...t, stop: target, peakR }, bar, t.plan, tick);
      peakR = step.peakR;
      target = step.stop;
      if (step.close) { cross = { bar, stop: step.stop }; break; }
      barsHeld += 1;
    }
    const lastBarT = bars[bars.length - 1].t;
    const closeOut = async why => {
      closedAt.set(cid, clock.now().getTime()); // end of day won't send a second close while this one fills
      await client.closePosition(cfg.account, cid);
      const last = bars[bars.length - 1];
      emit('position_closed', { symbol: item.symbol, contractId: cid, setup: t.setup, side: sign > 0 ? 'long' : 'short', entry: t.entry, risk: t.risk, why,
        lastClose: last.c, rNow: (sign * (last.c - t.entry)) / t.risk, peakR, troughR, barsHeld });
      save({ ...t, peakR, troughR, barsHeld, lastBarT });
      // The runner's own exit, for the decision history's real R (decision-history.js withPositions).
      state = { ...state, runnerCloses: { ...(state.runnerCloses || {}), [cid]: { at: clock.now().toISOString(), r: Math.round(((sign * (last.c - t.entry)) / t.risk) * 100) / 100 } } };
      log(`${item.symbol}: ${why}; closed ${t.setup} at market (peak ${peakR.toFixed(2)}R)`);
      for (const o of orders.filter(x => x.contractId === cid)) {
        try {
          await client.cancelOrder(cfg.account, o.id);
        } catch (err) {
          log(`${item.symbol}: could not cancel ${o.id} after the close (${err.message}); the next bar retries`, 'error');
        }
      }
    };
    if (cross) {
      await closeOut(`trail: price went through the new stop ${cross.stop} (resting ${resting ?? 'none'})`);
      return;
    }
    // The strategy's time stop (exit.max_bars), as the backtester applies it.
    const maxBars = t.maxRunnerBars || t.plan.maxBars;
    if (maxBars && barsHeld >= maxBars) {
      await closeOut(`time stop: ${barsHeld} ${cfg.timeframe}m bars in the trade (max_bars ${t.plan.maxBars})`);
      return;
    }
    save({ ...t, peakR, troughR, barsHeld, lastBarT });
    if (!stopOrder) {
      if (sign * (target - t.stop) < tick - 1e-9) return;
      log(`${item.symbol}: trail wants the stop at ${target} but there is no single working stop order to move`, 'error');
      return;
    }
    if (sign * (target - resting) < tick - 1e-9) return;
    if (Number(stopOrder.size) > Number(p.size)) {
      log(`${item.symbol}: trail: stop ${stopOrder.id} (size ${stopOrder.size}) is bigger than the position (${p.size}); not moving it toward the market`, 'error');
      return;
    }
    await client.modifyStop(cfg.account, stopOrder.id, target);
    emit('stop_moved', { symbol: item.symbol, contractId: cid, setup: t.setup, from: resting, to: target, peakR, barsHeld });
    save({ ...trails[item.contractId], stop: target });
    log(`${item.symbol}: trail: stop ${resting} -> ${target} (peak ${peakR.toFixed(2)}R)`);
  }

  /** Account housekeeping before a cycle: leftover orders and trailing stops. */
  /**
   * Close every position of this root (any month) whose opposite-side stops
   * don't add up to its size, then cancel the root's orders once nothing of
   * it is left open. Returns true when it closed anything.
   */
  async function flattenUncovered(item, { positions, orders }) {
    const root = famOf(item.contractId);
    const open = positions.filter(p => famOf(p.contractId) === root && isOpen(p));
    const closed = [];
    for (const p of open) {
      const sign = p.type === 1 ? 1 : -1;
      const covered = orders
        .filter(o => o.contractId === p.contractId && STOP_ORDER_TYPES.has(Number(o.type)) && (Number(o.side) === 0 ? 1 : -1) === -sign)
        .reduce((a, o) => a + Number(o.size || 0), 0);
      if (covered === Number(p.size)) continue;
      closedAt.set(p.contractId, clock.now().getTime());
      await client.closePosition(cfg.account, p.contractId);
      closed.push(p.contractId);
      log(`${item.symbol}: ${p.contractId} ${sign > 0 ? 'long' : 'short'} ${p.size} has stops for ${covered} while no cycle can run (kill switch or outside sessions); closed at market`, 'error');
    }
    if (!closed.length) return false;
    // A target or stop left working on a flat contract could open a new,
    // unmanaged position: cancel them now, not on the next bar.
    const stillOpen = new Set(open.filter(p => !closed.includes(p.contractId)).map(p => p.contractId));
    for (const o of orders.filter(x => famOf(x.contractId) === root && (closed.includes(x.contractId) || !stillOpen.size))) {
      try {
        await client.cancelOrder(cfg.account, o.id);
      } catch (err) {
        log(`${item.symbol}: could not cancel ${o.id} after the close (${err.message}); the next bar retries`, 'error');
      }
    }
    return true;
  }

  // `trail`: apply the trailing exit to this item's bars (only the first lane's: the trail counts its bars).
  async function housekeeping(item, { noCycles = false, trail = true } = {}) {
    if (!cfg.account || cfg.paper || typeof client.accountState !== 'function') return;
    try {
      const account = await client.accountState(cfg.account);
      await cleanupFlat(item, account, { noCycles });
      // No cycle will come to protect a position whose stops don't cover it
      // exactly (none, too small, or big enough to flip it): flatten it.
      if (noCycles && await flattenUncovered(item, account)) return;
      if (trail) await trailPosition(item, account);
    } catch (err) {
      log(`${item.symbol}: account housekeeping failed (${err.message})`, 'error');
    }
  }

  /** [net position, working orders] in the item's micro/mini family (any month). */
  async function exposure(item) {
    if (typeof client.accountState !== 'function') {
      return Promise.all([client.netPosition(cfg.account, item.contractId), client.workingOrders(cfg.account, item.contractId)]);
    }
    const { positions, orders } = await client.accountState(cfg.account);
    const fam = famOf(item.contractId);
    const mine = positions.filter(p => famOf(p.contractId) === fam && isOpen(p));
    // A size that can't be read counts as one contract: the position is open, never flat.
    const size = p => (Number.isInteger(Number(p.size)) && Number(p.size) > 0 ? Number(p.size) : 1);
    const net = mine.reduce((n, p) => n + (p.type === 1 ? 1 : p.type === 2 ? -1 : 0) * size(p), 0);
    // A long in one month and a short in another still needs managing.
    return [net || mine.reduce((n, p) => n + size(p), 0), orders.filter(o => famOf(o.contractId) === fam).length];
  }

  /** Record a scanned bar in the decision log; a failure to log never stops the pass. */
  function logScan(item, results, decision) {
    try {
      recordSignals(item, results);
    } catch (err) {
      log(`${item.symbol}: could not record the bar's signals (${err.message}); the gate refuses rules entries, and policy entries on this bar's verdicts`, 'error');
    }
    try {
      scanLog({ at: clock.now(), symbol: item.symbol, contractId: item.contractId, bar: item.bar, results, decision });
    } catch (err) {
      log(`${item.symbol}: decision log failed (${err.message})`, 'error');
    }
  }

  /** The item's bar briefing (built once per item and bar; a failure is logged, never stops the pass). */
  function briefItem(item, results, scanError) {
    if (item.briefed) return;
    item.briefed = true;
    // The briefing is the symbol's, built on the first lane's bars (another lane's bar keeps the last one).
    if (item.lane > 0) return;
    try {
      recordBriefing(item, results, scanError);
    } catch (err) {
      log(`${item.symbol}: no bar briefing this bar (${err.message}); the roles read the tools themselves`, 'error');
    }
  }

  // The strategy scan for an item; a failure is named in the prompt (what fired is unknown), not left out.
  function scanItem(item) {
    try {
      item.scan = multi ? scanFor(item.symbol, item.bars, lanes[item.lane]) : scanFor(item.symbol, item.bars);
    } catch (err) {
      item.scan = null;
      item.scanError = err.message;
      log(`${item.symbol}: strategy scan failed (${err.message})`, 'error');
    }
    briefItem(item, item.scan, item.scanError || null);
    return item.scan;
  }

  // The policy's screen couldn't run (it threw, or the account check before it failed): no verdict. Only
  // the fired strategies an active policy owns lose their entry; plain strategies still trade. Without an
  // owners hook every fired strategy is treated as owned (the gate decides; the prompt errs on caution).
  function policyFailed(item, why) {
    let owned;
    try {
      const map = typeof prop.owners === 'function' ? prop.owners({ symbol: item.symbol, contractId: item.contractId }) : null;
      owned = (item.scan || []).filter(r => r.candidate && r.direction && (!map || map.has(r.name))).map(r => r.name);
    } catch (_err) {
      owned = (item.scan || []).filter(r => r.candidate && r.direction).map(r => r.name);
    }
    item.verdicts = [];
    if (owned.length) { item.screenError = why; item.notEntries = owned; }
  }

  // A policy screens its strategy's setups (only when flat: a verdict is for a new entry). A failed screen
  // means no verdict, so the gate refuses any entry: the prompt says so instead of listing the setups.
  function screenItem(item) {
    try {
      const screened = prop.screen(item.scan, { symbol: item.symbol, contractId: item.contractId, bars: item.bars, now: clock.now(), ...(multi ? { lane: lanes[item.lane] } : {}) });
      item.verdicts = screened.filter(r => r.verdict).map(r => r.verdict);
      return screened;
    } catch (err) {
      policyFailed(item, err.message);
      log(`${item.symbol}: policy screen failed (${err.message}); the gate refuses its entries`, 'error');
      return item.scan;
    }
  }

  async function wanted(item, manageOnly) {
    // Each lane's own trigger (one lane: the config's).
    if ((multi ? lanes[item.lane].trigger : cfg.trigger) === 'bar' && !manageOnly) {
      // Every bar runs a cycle with what fired; a policy still records its verdicts for the gate.
      const results = scanItem(item);
      if (results) {
        let screened = results;
        if (prop && cfg.account) {
          try {
            const [net, working] = await exposure(item);
            if (net === 0 && working === 0) screened = screenItem(item);
          } catch (err) {
            // No account read, no screen: no verdict for the policy's strategies (named in the prompt).
            policyFailed(item, `account check failed: ${err.message}`);
            log(`${item.symbol}: account check for the policy screen failed (${err.message}); no verdict this bar`, 'error');
          }
        }
        // The decision log gets every bar: what fired, so live can be reconciled with the scan (reconcile.js).
        logScan(item, screened, { run: true, reason: 'bar closed' });
      }
      return { run: true, reason: 'bar closed' };
    }
    if (!cfg.account) return { run: false, reason: 'cap reached and no account configured to check positions' };
    let net;
    let working;
    try {
      [net, working] = await exposure(item);
    } catch (err) {
      // Can't see the account: run the cycle rather than risk leaving a position unmanaged.
      scanItem(item);
      if (prop && item.scan) policyFailed(item, `account check failed: ${err.message}`);
      log(`${item.symbol}: account check failed (${err.message}); running the cycle to manage anything open`, 'error');
      const decision = { run: true, reason: `account check failed (${err.message})` };
      // The bar is still recorded: the gate ties a verdict to the last recorded bar, so an older bar's verdict can't pass for this one.
      if (item.scan) logScan(item, item.scan, decision);
      return decision;
    }
    if (manageOnly) {
      return net !== 0 || working > 0 ? { run: true, reason: 'manage only' } : { run: false, reason: 'cap reached and flat' };
    }
    const results = scanItem(item);
    // A failed scan: run the cycle (it says so) when there is something to manage, else wait for the next bar.
    if (!results) return net !== 0 || working > 0 ? { run: true, reason: 'manage (the scan failed)' } : { run: false, reason: 'the scan failed' };
    const screened = prop && net === 0 && working === 0 ? screenItem(item) : results;
    if (!(prop && net === 0 && working === 0)) item.verdicts = [];
    const decision = signalDecision(screened, net, working, { paper: cfg.paper });
    logScan(item, screened, decision);
    return decision;
  }

  /**
   * One pass. Never throws: an unexpected error (a full disk, a broken
   * harness) is logged, counted toward the kill switch, and retried after a
   * pause, so the loop survives to run end of day.
   */
  async function step() {
    try {
      return await stepOnce();
    } catch (err) {
      log(`runner error: ${err.message}`, 'error');
      emit('error', { where: 'runner', error: err.message, stack: err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : null });
      try {
        record(false, false, clock.now());
      } catch (_err) {
        // the kill switch could not be written either; keep going
      }
      return Math.min(MAX_RETRY_MS, IDLE_MS * 2 ** Math.min(errors, 4));
    } finally {
      // The partner lookups this step started (after its polls and orders): settled before the step returns.
      await Promise.all([...partnerLookups]);
    }
  }

  /**
   * Close every position in the traded roots and cancel their orders: after
   * the end-of-day run, and whenever one turns up outside market hours (hard
   * rule: no position is held outside the 18:00-16:00 ET session). True only
   * when a read of the account finds nothing open and nothing working there:
   * after closing or cancelling anything it returns false, and the caller's
   * retry reads the account again (a close the broker accepted may not have
   * filled). Each close and cancel is tried on its own, so one failure never
   * skips the others. End of day is done, and the prop close recorded, only
   * once the account is verified flat.
   */
  async function flattenAll(why) {
    if (!cfg.account || cfg.paper || typeof client.accountState !== 'function') return true;
    let state;
    flattenRead = false;
    if (why !== unflatWhy) { unflatPasses = 0; unflatWhy = why; }
    try {
      state = await client.accountState(cfg.account);
    } catch (err) {
      log(`${why}: could not read the account (${err.message}); retrying`, 'error');
      return false;
    }
    flattenRead = true;
    const roots = new Set(cfg.symbols.map(familyRoot));
    const open = state.positions.filter(p => roots.has(famOf(p.contractId)) && isOpen(p));
    const working = state.orders.filter(x => roots.has(famOf(x.contractId)));
    if (!open.length && !working.length) {
      if (unflatPasses) emit('flatten_verified', { why, passes: unflatPasses });
      unflatPasses = 0;
      return true;
    }
    unflatPasses += 1;
    if (unflatPasses === 1) unflatSince = clock.now().getTime();
    // A contract closed moments ago and still open waits for its close to fill: no second close, and no cancel of its
    // orders (one may be the close itself). Once it reads flat, its leftover orders are cancelled at once.
    const nowMs = clock.now().getTime();
    const stillOpen = new Set(open.map(p => p.contractId));
    const settling = id => stillOpen.has(id) && nowMs - (closedAt.get(id) ?? -Infinity) < CLOSE_SETTLE_MS;
    if (unflatPasses > 1) {
      log(`${why}: still not flat after ${unflatPasses - 1} pass(es): ${open.map(p => p.contractId).join(', ') || 'no position'}${working.length ? `, ${working.length} working order(s)` : ''}; closing again`, 'error');
      emit('flatten_unverified', { why, passes: unflatPasses - 1, open: open.map(p => p.contractId), working: working.length });
    }
    const toClose = open.filter(x => !settling(x.contractId));
    const toCancel = working.filter(x => !settling(x.contractId) && !toClose.some(p => p.contractId === x.contractId));
    for (const p of toClose) {
      try {
        closedAt.set(p.contractId, nowMs);
        await client.closePosition(cfg.account, p.contractId);
        log(`${why}: ${p.contractId} was open; closed at market`, 'error');
        emit('flatten', { why, contractId: p.contractId, size: Number(p.size), side: p.type === 1 ? 'long' : p.type === 2 ? 'short' : null });
      } catch (err) {
        log(`${why}: could not close ${p.contractId} (${err.message}); retrying`, 'error');
      }
    }
    for (const o of toCancel) {
      try {
        await client.cancelOrder(cfg.account, o.id);
      } catch (err) {
        log(`${why}: could not cancel order ${o.id} (${err.message}); retrying`, 'error');
      }
    }
    return false;
  }
  const eodBackstop = () => flattenAll('end of day');
  let lastHoursCheck = 0;

  /**
   * The account for a run's prompt: balance, open positions, working orders,
   * and each running prop attempt's state (null without an account). A failed
   * or slow read (over accountReadMs) is reported in the prompt, never hidden,
   * and never holds the run up.
   */
  async function accountSnapshot(now) {
    const hasState = typeof client.accountState === 'function';
    const hasBalance = typeof client.accountBalance === 'function';
    if (!cfg.account || (!hasState && !hasBalance)) return null;
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${accountReadMs / 1000} s`)), accountReadMs);
    });
    try {
      const [state, balance] = await Promise.race([Promise.all([
        hasState ? client.accountState(cfg.account) : null,
        hasBalance ? client.accountBalance(cfg.account) : NaN,
      ]), deadline]);
      let attempts = [];
      if (prop && typeof prop.summaries === 'function') {
        try {
          attempts = prop.summaries(now, balance);
        } catch (err) {
          log(`prop attempt state unavailable for the prompt (${err.message})`, 'error');
        }
      }
      return {
        id: cfg.account, at: now.toISOString(), balance,
        // Without a state read, positions and orders are unknown, not flat.
        positions: state ? state.positions.filter(isOpen) : null,
        workingOrders: state ? state.orders.length : null,
        orders: state ? state.orders : null,
        attempts,
      };
    } catch (err) {
      log(`account state for the prompt unavailable (${err.message})`, 'error');
      return { id: cfg.account, error: err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * When the soonest bar any symbol waits for is due for its poll (its bar clock's expected close plus the poll
   * delay; already past when a bar closed and is waiting), or null when a symbol's clock doesn't know: none yet,
   * or one that has seen no bar (before the first one, its close is only a guess).
   */
  function nextBarDueAt() {
    const due = syms.filter(s => s.clock && s.clock.lastBarT && Number.isFinite(s.clock.expectedCloseAt)).map(s => s.clock.expectedCloseAt + delayMs);
    return due.length === syms.length && due.length ? Math.min(...due) : null;
  }

  /**
   * Time from `now` (outside the session windows) to the poll of the first bar in the next one, less a margin for
   * the run's own start; null when no window opens within a day.
   */
  function msToSessionPoll(now) {
    const t0 = Math.ceil(now.getTime() / 60000) * 60000;
    for (let k = 0; k <= 1440; k += 1) {
      const t = t0 + k * 60000;
      if (inSession(cfg, new Date(t))) return Math.max(0, t + delayMs - now.getTime() - 5000);
    }
    return null;
  }

  /** Time from `now` to the next bar's poll, less a margin for the run's own start: 0 when one is due or unknown. */
  function msToNextBar(now) {
    const due = nextBarDueAt();
    return due === null ? 0 : Math.max(0, due - now.getTime() - 5000);
  }

  /** The account as read for a run, for the event log. */
  function accountEvent(a) {
    if (a.error) return { id: a.id, error: a.error };
    return {
      id: a.id, balance: a.balance, positions: a.positions ? a.positions.map(p => ({ contractId: p.contractId, side: p.type === 1 ? 'long' : p.type === 2 ? 'short' : null, size: p.size, averagePrice: p.averagePrice })) : null,
      workingOrders: a.workingOrders, ...(a.openTradesError ? { openTradesError: a.openTradesError } : {}), attempts: (a.attempts || []).map(x => ({ account: x.account, status: x.status, balance: x.balance, floor: x.floor, cushion: x.cushion, profit: x.profit, dayPnl: x.dayPnl, entryBlock: x.entryBlock || null })),
    };
  }

  /**
   * Several lanes: entry verdicts of more than one policy among the cycle's items. The first policy's stand (its
   * priority, else 3m and slower first: lane-cycle.js); every other's is skipped: recorded for the gate (a
   * superseding skip verdict, so its entry is refused), shown as skipped in the prompt, and returned for the cycle
   * record so the labels see it. A skip that can't be recorded (tried twice) leaves the skipped policy's entry
   * verdict the gate's latest: the caller then runs the cycle manage-only (no entry at all), failing closed.
   */
  function settlePolicies(run) {
    const current = run.flatMap(x => x.verdicts || []);
    // Other policies' entry verdicts from earlier cycles, still open (unexpired, unused): the priority holds across
    // cycles, so a lower-priority policy's new setup never jumps a higher one's open setup. One that can't be read:
    // the cycle's own verdicts are settled alone (said in the log).
    let open = [];
    try {
      // An open verdict is replaced only by this cycle's entry verdict of the same policy on the same index family
      // (a skip, or a setup on another family, leaves it open).
      const famKey = v => `${v.strategy}|${famOf(v.contract || v.contractId || v.symbol || '')}`;
      const mine = new Set(current.filter(v => v.action !== 'skip').map(famKey));
      open = prop && typeof prop.openVerdicts === 'function' ? (prop.openVerdicts(clock.now()) || []).filter(v => !mine.has(famKey(v))) : [];
    } catch (err) {
      log(`open policy verdicts unreadable (${err.message}); this cycle's setups are settled among themselves`, 'error');
    }
    // Every loser is skipped: this cycle's, and an earlier open one that a higher-priority setup now goes before.
    const { skipped } = settleCollisions([...current, ...open], n => strategyNamed(n));
    const out = [];
    for (const { verdict, by } of skipped) {
      const item = run.find(x => (x.verdicts || []).includes(verdict)) || null;
      const where = item ? { symbol: item.symbol, lane: `${item.minutes}m` } : { symbol: verdict.symbol || contractRoot(verdict.contractId || '') || null, lane: ((strategyNamed(verdict.strategy) || {}).timeframe) || null, earlier: verdict.at || null };
      const skip = skippedVerdict(verdict, by, clock.now());
      let unrecorded = null;
      for (let tries = 0; tries < 2; tries += 1) {
        try {
          if (!prop || typeof prop.supersede !== 'function') throw new Error('no prop hooks to record it');
          prop.supersede(skip);
          unrecorded = null;
          break;
        } catch (err) {
          unrecorded = err.message;
        }
      }
      if (unrecorded) {
        // The gate would still read the skipped policy's entry verdict: the kill switch (another file) makes it refuse
        // every entry until the user looks, and this cycle only manages.
        log(`${where.symbol}: could not record ${verdict.strategy}'s skip (${unrecorded}); this cycle is manage-only and the kill switch is on`, 'error');
        try {
          if (!isKillSwitchOn()) createKillSwitch(`created by autotrader at ${clock.now().toISOString()}: ${verdict.strategy}'s skip for ${by} could not be recorded for the gate (${unrecorded})`);
          emit('kill_switch', { reason: `${verdict.strategy}'s skip could not be recorded` });
        } catch (err) {
          log(`could not create the kill switch either (${err.message})`, 'error');
        }
      }
      if (item) item.verdicts = item.verdicts.map(v => (v === verdict ? skip : v));
      const rec = { ...where, policy: verdict.strategy, component: verdict.component || null, direction: verdict.direction || null, skipped: LOWER_PRIORITY, by, ...(unrecorded ? { unrecorded } : {}) };
      out.push(rec);
      emit('policy_skipped', rec);
      log(`${where.symbol}: ${verdict.strategy} ${verdict.direction} setup from ${verdict.component}${item ? '' : ` (open since ${verdict.at})`} skipped: ${LOWER_PRIORITY} (${by} goes first)`);
    }
    return out;
  }

  /** Several lanes: each lane's last bar into the state (saved when it moved), for the next process's clocks. */
  function saveLaneClocks() {
    const prev = (state && state.laneClocks) || {};
    const next = { ...prev };
    for (const s of syms) if (s.clock && s.clock.lastBarT && s.contractId) next[laneKey(s)] = { lastBarT: s.clock.lastBarT, contractId: s.contractId };
    const same = (a, b) => Boolean(a && b) && a.lastBarT === b.lastBarT && a.contractId === b.contractId;
    if (Object.keys(next).some(k => !same(next[k], prev[k]))) {
      state = { ...state, laneClocks: next };
      saveState(state);
    }
  }

  /**
   * Several lanes: how long to wait before the cycle (ms), or null to run it now. It waits while a lane of a symbol
   * whose bar closed is due at that close (its clock expects a bar closing no later) and hasn't published it, until
   * coalesceHoldMs after the earliest of the closes plus the poll delay.
   */
  function coalesceWait(ready, at) {
    if (!ready.length) return null;
    const closeOf = x => Date.parse(x.bar.t) + x.minutes * 60000;
    const late = syms.filter(s => s.contractId && s.clock && Number.isFinite(s.clock.expectedCloseAt)
      && ready.some(x => x.symbol === s.symbol && x.lane !== s.lane && s.clock.expectedCloseAt <= closeOf(x))
      && !ready.some(x => x.symbol === s.symbol && x.lane === s.lane));
    if (!late.length) return null;
    const until = Math.min(...ready.map(closeOf)) + delayMs + coalesceHoldMs;
    if (at.getTime() >= until) {
      log(`${late.map(laneKey).join(', ')}: no bar yet for the close the other lanes have; cycling without it`);
      return null;
    }
    return Math.max(250, Math.min(cfg.barPollSeconds * 1000, until - at.getTime()));
  }

  /** Milliseconds from `now` to today's end of day (Infinity if none). */
  function msToEod(now) {
    const eod = endOfDayAt(cfg, now);
    if (!eod) return Infinity;
    return (tradingDayStart(now).getTime() + sessionMinuteOf(eod, now) * 60000) - now.getTime();
  }
  /** Milliseconds from `now` to the 16:00 ET close of its trading day. */
  function msToClose(now) {
    return (tradingDayStart(now).getTime() + sessionMinuteOf({ minute: MARKET_CLOSE_MIN, timeZone: MARKET_TZ }, now) * 60000) - now.getTime();
  }
  /** A run's time limit: its timeout, but never past end of day (or, for end of day, the close). */
  function limitFor(action, now, baseMin = cfg.cycleTimeoutMinutes) {
    const base = baseMin * 60000;
    const until = action === 'eod' ? msToClose(now) : msToEod(now);
    return Math.max(0, Math.min(base, until));
  }

  /**
   * Record the closing balance of the day end of day just closed. Retried at
   * most CLOSE_TRIES times, a minute apart; an error a retry can't fix (the
   * day already recorded with another balance) stops at once. Either way the
   * gate's missed-close check keeps prop entries refused until it is recorded.
   */
  async function recordClose(now) {
    if (!pendingClose || now.getTime() - pendingClose.lastTry < CLOSE_RETRY_MS) return;
    const { day } = pendingClose;
    pendingClose.tries += 1;
    pendingClose.lastTry = now.getTime();
    try {
      await prop.endOfDay(now, day);
      if (pendingClose.tries > 1) log(`end of day: the close of ${day} is recorded`);
      emit('close_recorded', { day, tries: pendingClose.tries });
      pendingClose = null;
    } catch (err) {
      const final = /already recorded/.test(err.message) || pendingClose.tries >= CLOSE_TRIES;
      log(`end of day: could not record the close of ${day} (${err.message}); `
        + (final ? `giving up: prop entries stay refused until it is recorded (node scripts/combine.js record-day --account <name> --day ${day} --balance <dollars>)` : 'retrying in a minute'), 'error');
      emit('close_record_failed', { day, tries: pendingClose.tries, error: err.message, final });
      if (final) pendingClose = null;
    }
  }

  async function stepOnce() {
    const now = clock.now();
    // Bars held for a coalesced cycle go only into this pass's polling, while still within the hold: any other path
    // (premarket, end of day, outside hours) drops them.
    const carried = held;
    held = [];
    // Once a trading day: warn while the exchange calendar is running out (after it, the gate refuses entries).
    if (dayKey(now) !== calendarCheckedDay) {
      calendarCheckedDay = dayKey(now);
      const gap = coverageError(now, { closed: cfg.closedDates, early: cfg.earlyCloseDates });
      if (gap) { log(gap, 'error'); emit('calendar_ending', { message: gap }); }
    }
    let d = decide(cfg, state, now, { killSwitch: isKillSwitchOn() });
    state = d.state;
    // A premarket that failed: tried again after its pause, until a session window opens; then the day trades
    // without a plan (premarketUnavailable: the prompt, the event log and the session record say so).
    if (d.action === 'premarket' && state.premarketTries > 0) {
      // Before the session, a retry must end before its first bar is polled: with under 30 s left, none is tried.
      const preCap = msToSessionPoll(now);
      if (inSession(cfg, now) || (preCap !== null && preCap < 30000)) {
        // Its retries go on, on the same pause, after the passes' cycles (retryPremarket), until one succeeds or end of day.
        state = { ...recordRun(state, 'premarket', now), premarketUnavailable: { at: now.toISOString(), tries: state.premarketTries } };
        log(`premarket: no plan after ${state.premarketTries} failed run(s) and the session is open (or opens before another try could end); trading without a premarket plan until a retry succeeds`, 'error');
        emit('premarket_unavailable', { day: state.day, tries: state.premarketTries });
        saveState(state);
        d = decide(cfg, state, now, { killSwitch: isKillSwitchOn() });
        state = d.state;
      } else if (Date.parse(state.premarketRetryAt) > now.getTime()) {
        // Waiting for its retry never holds up risk-reducing work: the pass goes on as if premarket were done
        // (trailing, leftover orders, housekeeping), and still starts no cycle (it isn't done: below, decide says so).
        const waiting = decide(cfg, { ...state, premarketDone: true }, now, { killSwitch: isKillSwitchOn() });
        d = { ...waiting, state: { ...waiting.state, premarketDone: false } };
        state = d.state;
      }
    }
    if (pendingClose && d.action !== 'eod') await recordClose(now);

    if (d.action === 'premarket' || d.action === 'eod') {
      let ok = true;
      // End of day flattens first, directly: the agents' run (reviews, the
      // journal) can fail or run long, and nothing may be open past the close.
      // Whether the day is done is decided by the check after the run.
      if (d.action === 'eod') await eodBackstop();
      // Each job is built with the account as it is when that run starts.
      // Each job's prompt is dated when it starts (a second symbol's premarket runs after the first).
      // The agents' end-of-day run happens once a day: a retry (the account not yet verified flat) only flattens.
      // With eodReview false (a replay saving model calls) end of day only flattens and records the close.
      const jobs = d.action === 'eod'
        ? (eodRunDay === d.state.day || d.state.eodReviewedDay === d.state.day || cfg.eodReview === false ? [] : [{ symbol: null, build: (acct, at) => prompts(cfg, at, root).eod({ state: acct, day: d.state.day }) }])
        : cfg.symbols.map(s => ({ symbol: s, build: (acct, at) => prompts(cfg, at, root).premarket(s, { state: acct }) }));
      const noTime = () => log(`${d.action}: no time left before ${d.action === 'eod' ? 'the close' : 'end of day'}; skipped`);
      for (const job of jobs) {
        const at = clock.now();
        // A premarket run never delays end of day.
        if (d.action === 'premarket' && decide(cfg, state, at, { killSwitch: isKillSwitchOn() }).action === 'eod') break;
        if (limitFor(d.action, at) < 30000) { noTime(); continue; }
        const acct = await accountSnapshot(at);
        // The time limit counts from after the account read.
        // A premarket retry before the session ends before the session's first bar is polled (the first try of
        // the day keeps the premarket's limit).
        const cap = d.action === 'premarket' && state.premarketTries > 0 ? msToSessionPoll(clock.now()) : null;
        const timeoutMs = cap === null ? limitFor(d.action, clock.now()) : Math.min(limitFor(d.action, clock.now()), cap);
        if (timeoutMs < 30000) {
          noTime();
          // A premarket retry with no time left is a try that failed; end of day is judged by its flatten alone.
          if (d.action === 'premarket') ok = false;
          continue;
        }
        if (acct) emit('account', accountEvent(acct));
        // What the prompt was built from, for the cycle log.
        const context = { action: d.action, day: d.state.day, symbol: job.symbol, account: acct ? accountEvent(acct) : null };
        const r = await timedCycle(d.action, job.build(acct, clock.now()), { timeoutMs, context });
        if (d.action !== 'eod') ok = ok && r.ok;
      }
      if (d.action === 'eod') {
        eodRunDay = d.state.day;
        // Kept in the saved state too, so a restarted runner (or a replay's next process) doesn't review twice.
        if (jobs.length) state = { ...state, eodReviewedDay: d.state.day };
      }
      // Then check again: flatten whatever the run left open; done only once verified flat.
      if (d.action === 'eod') ok = (await eodBackstop()) && ok;
      // The day's closing balance, once flat (the trailing floor moves on it).
      // A failed record never holds end of day open (the flatten is what can't
      // wait): it is retried on its own, and until it is recorded the gate
      // refuses prop entries (a missed close).
      if (d.action === 'eod' && ok && prop && !cfg.paper) {
        // The trading day being closed: a catch-up end of day runs on a later day.
        if (pendingClose && pendingClose.day !== d.state.day) log(`end of day: the close of ${pendingClose.day} is still unrecorded; the gate refuses prop entries until it is (combine.js record-day)`, 'error');
        pendingClose = { day: d.state.day, tries: 0, lastTry: 0 };
        await recordClose(now);
      }
      // A failed premarket is no failed run (never toward the kill switch): it isn't done, and is tried again
      // after a growing pause (1, 2, 5, then every 10 min) until a session window opens (above). A success
      // clears what a failure left.
      if (d.action === 'premarket') {
        if (ok) state = { ...recordRun(state, 'premarket', now), premarketTries: 0, premarketRetryAt: null, premarketUnavailable: null };
        else {
          const tries = (state.premarketTries || 0) + 1;
          state = { ...state, premarketTries: tries, premarketRetryAt: new Date(now.getTime() + PREMARKET_RETRY_MS[Math.min(tries, PREMARKET_RETRY_MS.length) - 1]).toISOString() };
          log(`premarket: failed (try ${tries}); tried again at ${state.premarketRetryAt} unless a session opens first`, 'error');
        }
        emit('premarket', { day: d.state.day, ok, cyclesToday: state.cycles });
        if (ok) record(true, false, now);
        saveState(state);
        return 0;
      }
      // A failed end of day is retried on the next pass: flattening matters most. A day whose end of day
      // was tried keeps its catch-up after the day rolls over, whether or not it ever traded.
      if (ok) state = recordRun(state, d.action, now);
      else state = { ...state, eodAttempted: true };
      emit(d.action, { day: d.state.day, ok, cyclesToday: state.cycles });
      // Waiting for closes to fill (the account read, not flat yet) is no failed run, for a while.
      const awaitingFlat = d.action === 'eod' && !ok && flattenRead && now.getTime() - unflatSince < UNFLAT_GRACE_MS;
      if (!awaitingFlat) record(ok, false, now);
      saveState(state);
      // A failed end of day is retried, with a growing pause (5 s .. 60 s).
      return ok ? 0 : awaitingFlat ? IDLE_MS : Math.min(MAX_RETRY_MS, IDLE_MS * 2 ** Math.min(errors - 1, 4));
    }
    if (d.action === null && (!inMarketHours(now) || state.eodDone || cfg.closedDates.includes(dayKey(now)))) {
      // Outside market hours, on an exchange holiday, or after today's end of
      // day nothing may be open: check once a minute and flatten whatever is.
      if (now.getTime() - lastHoursCheck >= 60000) {
        lastHoursCheck = now.getTime();
        await flattenAll('outside market hours');
      }
      return IDLE_MS;
    }
    if (d.action !== 'trade' && d.action !== 'manage' && d.action !== 'housekeep') return IDLE_MS;

    const ready = carried.filter(x => now.getTime() <= Date.parse(x.bar.t) + x.minutes * 60000 + delayMs + coalesceHoldMs + MAX_POLL_MS);
    for (let i = 0; i < syms.length; i += 1) {
      // A slow API can make a pass long: if end of day came due meanwhile, run it first.
      if (i > 0 && decide(cfg, state, clock.now(), { killSwitch: isKillSwitchOn() }).action === 'eod') return 0;
      const item = await pollSymbol(i, now);
      if (item) ready.push(item);
    }
    if (multi) {
      saveLaneClocks();
      // A lane of a symbol whose bar closed, due at that same close but not published yet: the cycle waits for it
      // (a few seconds at most), so one close is one cycle.
      const wait = coalesceWait(ready, clock.now());
      if (wait !== null) { held = ready; return wait; }
    }
    if (ready.length) {
      // Trailing stops and leftover orders first: they only ever reduce risk. Once per symbol (its first lane's bar
      // when that closed: the trail counts the first lane's bars), never twice on one account read's orders.
      const noCycles = d.action === 'housekeep';
      const keep = ready.filter(x => !ready.some(y => y !== x && y.symbol === x.symbol && (y.lane < x.lane || (y.lane === x.lane && ready.indexOf(y) < ready.indexOf(x)))));
      for (const item of keep) await housekeeping(item, { noCycles, trail: item.lane === 0 });
      // Then the session record hears each closed bar (its values taken, its bars archived): after the risk work.
      for (const x of ready) {
        try { barClosed(x.symbol, { bar: x.bar.t, stale: Boolean(x.stale), action: d.action, contractId: x.contractId, bars: x.bars, ...(multi ? { minutes: x.minutes } : {}) }); } catch (_err) { /* recording never stops the pass */ }
      }
      if (state.trails) saveState(state);
      // The account balance for the gate's prop-challenge checks, before any cycle.
      if (prop && cfg.account && !cfg.paper) {
        try {
          await prop.snapshot(clock.now());
        } catch (err) {
          log(`account balance unavailable (${err.message}); the gate refuses prop entries once the snapshot is 10 min old`, 'error');
        }
      }
      // Re-check: a symbol's poll may have taken a while, the kill switch may be on now.
      const again = decide(cfg, state, clock.now(), { killSwitch: isKillSwitchOn() });
      state = again.state;
      if (again.action === 'trade' || again.action === 'manage') {
        let manageOnly = again.action === 'manage';
        const run = [];
        for (const item of ready.filter(x => !x.stale)) {
          const w = await wanted(item, manageOnly);
          // A bar not scanned (manage only, or no cycle) still gets its briefing: the file is always this bar's.
          briefItem(item, null, 'not scanned this bar');
          const tag = `${item.symbol}${multi ? ` ${item.minutes}m` : ''}`;
          if (w.run) { run.push(item); log(`${tag} bar ${item.bar.t} close ${item.bar.c}: cycle (${w.reason})`); }
          else log(`${tag} bar ${item.bar.t} close ${item.bar.c}: no cycle (${w.reason})`);
        }
        // Several lanes: two policies' entry verdicts in one cycle are settled by priority (lane-cycle.js).
        const skipped = multi && run.length ? settlePolicies(run) : [];
        // A skip the gate can't read: no entry this cycle (fail closed), only managing what is open.
        if (skipped.some(k => k.unrecorded)) manageOnly = true;
        // The cycle's budget: the fastest closed lane's (one lane: the runner's cycleTimeoutMinutes).
        const closedLanes = multi ? lanes.filter((l, li) => run.some(x => x.lane === li)) : [];
        const budgetMin = multi ? cycleTimeoutMin(cfg, closedLanes) : cfg.cycleTimeoutMinutes;
        let cycleNow = clock.now();
        let timeoutMs = limitFor(again.action, cycleNow, budgetMin);
        let acct = null;
        if (run.length && timeoutMs >= 30000) {
          acct = await accountSnapshot(cycleNow);
          // The time limit counts from after the account read.
          cycleNow = clock.now();
          timeoutMs = limitFor(again.action, cycleNow, budgetMin);
        }
        if (run.length && timeoutMs < 30000) log(`no cycle: ${Math.round(timeoutMs / 1000)} s left before end of day`);
        else if (run.length) {
          // Every section of the prompt is built here; one that fails is named in the prompt
          // ("Context unavailable this cycle") and logged, never silently dropped.
          const unavailable = [];
          const failed = (what, err) => { unavailable.push(`${what} (${err.message})`); log(`prompt: ${what} unavailable (${err.message})`, 'error'); };
          const attempt = (what, fn, fallback) => { try { return fn(); } catch (err) { failed(what, err); return fallback; } };
          // The journal, read once for this prompt (open trades, track records, plans, reviewed trades, mistakes).
          const entries = attempt('the journal: no open-trade setups, live results, premarket plan, reviewed trades, or lessons', () => journalEntries() || [], null);
          const journal = entries || [];
          // Today's premarket failed until the session opened: no plan today, said in every cycle's prompt.
          if (state.premarketUnavailable) unavailable.push(`premarket plan unavailable (today's premarket run failed ${state.premarketUnavailable.tries} time(s); there is no plan for today: trade from the bars and your skills)`);
          for (const x of run) {
            if (x.dayError) unavailable.push(`${x.symbol} day context (${x.dayError})`);
            else if (dayContext && !x.bar.day) unavailable.push(`${x.symbol} day context (the bars don't hold today's open or a whole prior day)`);
            if (x.scanError && !manageOnly) unavailable.push(`${x.symbol} strategy scan (${x.scanError}): what fired is unknown`);
            if (x.screenError) unavailable.push(`${x.symbol} policy screen (${x.screenError}): no verdict, so no entry for ${(x.notEntries || []).join(', ') || 'its strategies'} this bar`);
          }
          // Each open position as a trade: setup, initial risk, stop, target, R now, best and worst, bars held.
          let tradeObjs = [];
          let manageAlso = [];
          if (acct && Array.isArray(acct.positions) && acct.positions.length) {
            try {
              // MNQ bars manage an NQ trade too (the same family); a contract with no bar this cycle has none.
              const item = p => run.find(x => x.contractId === p.contractId) || run.find(x => famOf(x.contractId) === famOf(p.contractId));
              // Its symbol's tick size even when its bar didn't close this cycle.
              const sym = p => syms.find(x => x.contractId && famOf(x.contractId) === famOf(p.contractId));
              const tickOf = p => (item(p) || sym(p) || {}).tickSize || null;
              tradeObjs = openTrades({ positions: acct.positions, orders: acct.orders || [], entries: journal, barsFor: p => (item(p) ? item(p).bars : null) });
              const history = t => { try { return t.setup ? tradeHistory(t) : null; } catch (err) { failed(`${t.setup}'s backtest excursions for the open trade`, err); return null; } };
              acct = { ...acct, openTrades: tradeObjs.map(t => describeOpenTrade(t, { tickSize: tickOf({ contractId: t.contractId }), et: etTime, history: history(t) })) };
              manageAlso = [...new Set(tradeObjs.filter(t => !item({ contractId: t.contractId })).map(t => (sym({ contractId: t.contractId }) || {}).symbol || contractRoot(t.contractId)))];
            } catch (err) {
              failed('the open trades\' details', err);
              acct = { ...acct, openTradesError: err.message };
            }
          }
          // Each strategy that fired carries its track record into the prompt.
          const withRecords = x => (Array.isArray(x.scan) ? x.scan.map(r => {
            if (!(r.candidate && r.direction)) return r;
            try {
              return { ...r, record: trackRecord(r.name, { regime: r.regime, at: new Date(Date.parse(x.bar.t) + x.minutes * 60000).toISOString(), entries: journal }) };
            } catch (err) {
              log(`prompt: ${x.symbol} track record for ${r.name} unavailable (${err.message})`, 'error');
              return { ...r, record: `track record unavailable (${err.message})` };
            }
          }) : x.scan);
          // Several lanes: the first lane's items first; a symbol's further lane says only its own bars and signals.
          const ordered = multi ? [...run].sort((a, b) => a.lane - b.lane) : run;
          const repeat = x => multi && ordered.some(y => y !== x && y.symbol === x.symbol && ordered.indexOf(y) < ordered.indexOf(x));
          const items = ordered.map(x => ({
            symbol: x.symbol, verdicts: x.verdicts, scan: withRecords(x), notEntries: x.notEntries || [],
            bar: { ...x.bar, plan: entries && !repeat(x) ? attempt(`${x.symbol} premarket plan`, () => premarketPlan(x.symbol, journal, cycleNow), null) : null },
            ...(multi ? { minutes: x.minutes, repeat: repeat(x) } : {}),
            // The closed bars, for what happened since each recent decision (decision-history.js; never in the prompt).
            bars: x.bars,
          }));
          const symbolsOf = list => (multi ? [...new Set(list.map(x => x.symbol))] : list.map(x => x.symbol));
          for (const k of skipped.filter(x => x.unrecorded)) unavailable.push(`${k.symbol} ${k.policy}'s skip for ${k.by} could not be recorded for the gate (${k.unrecorded}): this cycle is manage-only, no entry`);
          const newsLine = attempt('the news blackouts', () => news(cycleNow), null);
          const unreviewedText = entries ? attempt('the unreviewed entries', () => unreviewed(symbolsOf(items), journal, acct && !acct.error && Array.isArray(acct.positions) ? acct.positions : null, cycleNow, (acct && acct.orders) || []), null) : null;
          const lessonLines = entries ? attempt('your mistakes and lessons', () => lessons({ entries: journal }) || [], []) : [];
          const tradeLines = entries ? attempt('your reviewed trades', () => recentTrades({ entries: journal }) || [], []) : [];
          const summary = entries ? attempt('your reviewed trades\' record', () => tradesSummary({ entries: journal }), null) : null;
          // Trade cycles left today after this one (the cap counts this cycle).
          const cyclesLeft = Number.isInteger(cfg.maxCyclesPerDay) ? Math.max(0, cfg.maxCyclesPerDay - ((state && state.cycles) || 0) - 1) : null;
          // The reports still valid from earlier cycles (the roles the prompt lists: not when it lists none).
          // Keyed on the briefing's bar, the first lane's: a cycle with only another lane's bar is keyed on the first
          // lane's last bar (the briefing the analysts' reports rest on is still that one), so it reuses them.
          // Only until the first lane's next bar is due (its last bar's open plus two bars): one overdue (a bar that didn't
          // arrive, whatever a resync rearmed) means the
          // briefing may be past its parts' time, so the cycle is keyed on its own bar (no report served).
          const briefingBar = x => {
            if (!multi || x.lane === 0) return x.bar.t;
            const f = syms.find(s => s.symbol === x.symbol && s.lane === 0);
            const current = f && f.clock && f.clock.lastBarT && cycleNow.getTime() < Date.parse(f.clock.lastBarT) + 2 * f.minutes * 60000 + delayMs;
            return current ? f.clock.lastBarT : x.bar.t;
          };
          const cacheSymbols = ordered.filter((x, i) => !items[i].repeat).map(x => ({ symbol: x.symbol, bar: briefingBar(x), contractId: x.bar.contractId || null }));
          const fromCache = reportCache && !manageOnly && !cfg.paper ? attempt('the report cache: every role runs this cycle', () => reportCache.serve({ symbols: cacheSymbols, account: acct, now: cycleNow }), null) : null;
          // Several lanes: an analyst's report is served only until its parts' time (`until`, the next 15m close): a
          // first lane slower than that, or a bar of it that didn't arrive, never hands a report past it.
          const live = r => !r.until || Date.parse(r.until) > cycleNow.getTime();
          const served = multi && fromCache ? { ...fromCache, roles: fromCache.reports.filter(live).map(r => r.role), reports: fromCache.reports.filter(live) } : fromCache;
          // The entered decisions with their real positions (decision-history.js withPositions): an open trade's fill
          // and R; a position gone since its last cycle, closed (a failed account read closes nothing).
          const positionsKnown = Boolean(acct && !acct.error && !acct.openTradesError && Array.isArray(acct.positions));
          state = { ...state, history: attempt('your entered decisions\' positions', () => withPositions((state && state.history) || [], { trades: tradeObjs, known: positionsKnown, now: cycleNow, market: marketOf(items, cfg.timeframe), closes: state.runnerCloses || {} }), (state && state.history) || []) };
          // Several lanes: the decisions of the lanes that closed (and the first lane's and each open trade's lane's
          // last few), never a fast lane's flood; one lane: the last 10, as before.
          const firstLane = `${lanes[0].timeframe}m`;
          const openLanes = multi ? [...new Set(tradeObjs.map(t => { try { const s = t.setup ? strategyNamed(t.setup) : null; return s && s.timeframe ? s.timeframe : null; } catch (_err) { return null; } }).filter(Boolean))] : [];
          const shownHistory = multi
            ? laneHistory((state && state.history) || [], { closed: closedLanes.map(l => `${l.timeframe}m`), first: firstLane, open: openLanes })
            : (state && state.history) || [];
          // The recent decisions as the prompt shows them (its own call builds the same lines), for the session record.
          const historyShown = attempt('your recent decisions', () => historyShownLines(shownHistory, multi, marketOf(items, cfg.timeframe)), []);
          const prompt = prompts(cfg, cycleNow, root).trade(items, {
            manageOnly, recovered: recover, state: acct, history: shownHistory,
            lessons: lessonLines, trades: tradeLines, tradesSummary: summary, news: newsLine, unavailable,
            cyclesLeft,
            manageAlso, journalRead: entries !== null, cached: served, unreviewed: unreviewedText,
            ...(multi ? { lanes: lanesLine(closedLanes) } : {}),
          });
          // What the prompt was built from, for the cycle log (logs/cycles/): debug a line without rebuilding it.
          const context = {
            symbols: items.map(x => ({
              symbol: x.symbol, bar: { t: x.bar.t, c: x.bar.c, contractId: x.bar.contractId, file: x.bar.file }, trend: x.bar.trend || null, day: x.bar.day || null, plan: x.bar.plan || null,
              fired: (x.scan || []).filter(r => r.candidate && r.direction).map(r => ({ name: r.name, direction: r.direction, status: r.status, regime: r.regime || null, confluence: r.confluence || null, record: r.record || null })),
              verdicts: x.verdicts || [],
              ...(multi ? { lane: `${x.minutes}m` } : {}),
            })),
            account: acct ? accountEvent(acct) : null,
            openTrades: tradeObjs, openTradeLines: (acct && acct.openTrades) || [], manageAlso,
            recent: items.map(x => ({ symbol: x.symbol, bars: x.bar.recent || [] })),
            attempts: (acct && acct.attempts) || [], mode: { paper: Boolean(cfg.paper), cycle: cfg.cycle || null },
            eodAt: (() => { const eod = endOfDayAt(cfg, cycleNow); return eod ? new Date(tradingDayStart(cycleNow).getTime() + sessionMinuteOf(eod, cycleNow) * 60000).toISOString() : null; })(),
            cyclesLeft,
            news: newsLine, lessons: lessonLines, trades: tradeLines, tradesSummary: summary, history: shownHistory.slice(-(multi ? shownHistory.length : 10)), historyLines: historyShown,
            manageOnly, recovered: recover, unavailable,
            action: again.action, cachedRoles: served ? served.roles : [],
            // Several lanes: the lanes that closed, and the setups skipped for a higher-priority policy (labels see them).
            ...(multi ? { lanes: closedLanes.map(l => `${l.timeframe}m`), skipped } : {}),
          };
          recover = false;
          if (acct) emit('account', accountEvent(acct));
          const r = await timedCycle(again.action, prompt, { timeoutMs, context }, { symbols: run.map(x => x.symbol), bars: run.map(x => x.bar.t), manageOnly, cached: served ? served.roles : [], ...(multi ? { lanes: run.map(x => `${x.minutes}m`) } : {}), ...(historyShown.length ? { history: historyShown } : {}) });
          // The reports this cycle's roles returned, for the next cycles while what they rest on holds.
          // Only a trade cycle's roles (a manage-only or paper cycle's risk-manager isn't phase 1), from the stdout the gate reads.
          if (reportCache && r && !manageOnly && !cfg.paper) attempt('recording the report cache', () => reportCache.record({ symbols: cacheSymbols, account: acct, now: cycleNow, output: r.transcript || '', served: served ? served.roles : [] }), null);
          state = recordRun(state, 'trade', cycleNow);
          // The model's own recent decisions, carried into the next prompts (and across restarts with the state).
          // Several lanes: each entry tagged with its cycle's lanes, and kept to 10 per lane (not 10 in all).
          // Each with the facts at the decision (decision-history.js): the action, the setup, the price; an entry reads
          // the order it placed from the journal.
          const base = { at: cycleNow.toISOString(), symbols: symbolsOf(run), result: (r && r.result) || null, ...(multi ? { lanes: closedLanes.map(l => `${l.timeframe}m`) } : {}) };
          let entry = base;
          let placed = [];
          let journalFailed = false;
          if (parseResult(base.result).word === 'executed') {
            try {
              placed = journalEntries() || [];
            } catch (err) {
              journalFailed = true;
              log(`history: the journal unavailable (${err.message}); the entry's details unavailable`, 'error');
            }
          }
          try {
            entry = decisionEntry({ ...base, items: run, entries: placed, journalFailed });
          } catch (err) {
            log(`history: the decision's facts unavailable (${err.message}); its result line only`, 'error');
          }
          const history = [...((state && state.history) || []), entry];
          state = { ...state, history: multi ? boundHistory(history, firstLane) : history.slice(-10) };
          saveState(state);
          record(r.ok, r.timedOut, cycleNow);
        }
      }
    }
    // A premarket still missing is tried again when its pause is up: after this pass's cycle, never alongside one,
    // never under the kill switch, and never at or past end of day.
    // (A pass reaches here only on a trade, manage or housekeeping action: never at or after end of day.)
    if (state.premarketUnavailable && !isKillSwitchOn() && Date.parse(state.premarketRetryAt) <= clock.now().getTime()) await retryPremarket();
    return sleepMs(syms.map(s => s.clock), clock.now(), { delayMs });
  }

  /**
   * One more try at today's premarket, the trading day already under way without it. A success hands the next
   * cycles the plan (premarketAvailableAt; premarket_recovered); a failure waits the next pause. Never a failed
   * run: no try counts toward the kill switch.
   */
  async function retryPremarket() {
    // Outside the session windows it gets the premarket's whole limit; in one, never into the next bar (its limit
    // ends before the next bar's poll, so no bar is skipped for it). Skipped or cut short there: said, and counted.
    const limitNow = () => {
      const full = limitFor('premarket', clock.now());
      return inSession(cfg, clock.now()) ? { full, ms: Math.min(full, msToNextBar(clock.now())) } : { full, ms: full };
    };
    const starved = (how, l) => {
      // Counted once per bar (the passes that wait out the same bar count it once); a skip is said once per
      // session window (on short bars a retry rarely fits: every bar would say it), a cut-short retry each time.
      const due = nextBarDueAt();
      const nextPollAt = due === null ? 'unknown' : new Date(due).toISOString();
      if (how === 'skipped' && state.premarketRetryStarvedAt === nextPollAt) return;
      state = { ...state, premarketRetryStarved: (state.premarketRetryStarved || 0) + 1, premarketRetryStarvedAt: nextPollAt };
      const windowKey = `${state.day}|${sessionWindows.findIndex(w => inWindow(clock.now(), w))}`;
      if (how === 'skipped' && state.premarketRetrySkipSaid === windowKey) return;
      if (how === 'skipped') state = { ...state, premarketRetrySkipSaid: windowKey };
      emit('premarket_retry_starved', { day: state.day, how, timeoutMs: l.ms, fullMs: l.full, nextPollAt, count: state.premarketRetryStarved });
      log(`premarket: retry ${how} by the next bar (${Math.round(l.ms / 1000)} s of ${Math.round(l.full / 1000)} s)${how === 'skipped' ? '; said once this session window' : ''}`);
    };
    const first = limitNow();
    if (first.ms < 30000) {
      if (first.ms < first.full) starved('skipped', first);
      saveState(state);
      return; // no account read for a retry that can't run
    }
    // Never while a position is open (or the account can't be read): its management comes first. The retry waits.
    const acct = await accountSnapshot(clock.now());
    if (acct && (acct.error || !Array.isArray(acct.positions) || acct.positions.length > 0)) {
      log(`premarket: retry waits (${acct.error ? 'the account could not be read' : 'a position is open'})`);
      return;
    }
    let ok = true;
    let ran = false;
    for (const symbol of cfg.symbols) {
      const l = limitNow();
      const timeoutMs = l.ms;
      if (timeoutMs < 30000) { if (l.ms < l.full) starved('skipped', l); ok = false; continue; }
      if (timeoutMs < l.full) starved('capped', l);
      const context = { action: 'premarket', day: state.day, symbol, retry: true, account: acct ? accountEvent(acct) : null };
      const r = await timedCycle('premarket', prompts(cfg, clock.now(), root).premarket(symbol, { state: acct }), { timeoutMs, context }, { premarketRetry: true });
      ran = true;
      ok = ok && Boolean(r && r.ok);
    }
    const at = clock.now();
    if (!ran) {
      log('premarket: retry waits (not enough time before the next bar or end of day)');
      return;
    }
    if (ok) {
      log(`premarket: the retry succeeded after ${state.premarketTries} failed run(s); the next cycles have the plan`);
      emit('premarket_recovered', { day: state.day, tries: state.premarketTries });
      state = { ...state, premarketUnavailable: null, premarketAvailableAt: at.toISOString(), premarketTries: 0, premarketRetryAt: null };
    } else {
      const tries = (state.premarketTries || 0) + 1;
      state = { ...state, premarketTries: tries, premarketUnavailable: { ...state.premarketUnavailable, tries }, premarketRetryAt: new Date(at.getTime() + PREMARKET_RETRY_MS[Math.min(tries, PREMARKET_RETRY_MS.length) - 1]).toISOString() };
      log(`premarket: retry failed (try ${tries}); tried again at ${state.premarketRetryAt}`, 'error');
    }
    saveState(state);
  }

  return {
    // The first lane's clocks, as with one lane (the session record's bars).
    step, get state() { return state; }, get symbols() { return syms.filter(s => s.lane === 0).map(({ lane: _l, minutes: _m, restoredFor: _r, ...s }) => ({ ...s })); },
    // The last flatten pass read the account and found nothing open or working (the session record retries a
    // broker read only then: session/live.js).
    get verifiedFlat() { return flattenRead && unflatPasses === 0; },
  };
}

module.exports = { createRunner, IDLE_MS, ACCOUNT_READ_MS, FILL_GRACE_MS };
