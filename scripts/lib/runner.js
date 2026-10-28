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
 *      is kept in the state (a replay pass is a new process; saved at the end
 *      of a pass in which no cycle failed, so a retry finds its bars new). A data lane
 *      (trigger "data") only brings its 1m bars to the first lane's briefing:
 *      polled, its clock kept and coalesced like any lane, but it scans
 *      nothing, starts no cycle, writes no bars file, gets no housekeeping and
 *      no session-record point, and never sets a cycle's budget; its bars count
 *      even when they closed a while ago (closed bars only); with one trading lane the
 *      cycles, prompts and history are the one-lane runner's.
 */

const { openTrades, describeOpenTrade, tradeReadText } = require('./trading/open-trades');
const { workingEntryLines } = require('./trading/working-entries');
const { zonedParts } = require('./trading/clock');
const { decide, recordRun, prompts, signalDecision, dayKey, endOfDayAt, historyShownLines } = require('./autotrader');
const CD = require('./cycle-data');
const { decisionEntry, marketOf, parseResult, withPositions, exitRecords, appendExit, fillsNeededSince } = require('./trading/decision-history');
const { barStep, sleepMs } = require('./bar-clock');
const { contractRoot, contractMonthTag } = require('./trading/journal');
const { familyRoot, familyOf } = require('./trading/contracts');
const { specMismatch, validSpec, noSpecsMessage } = require('./trading/broker-specs');
const { isOpen, signedSize } = require('./trading/positions');
const { protectiveStops, legRole } = require('./trading/bracket-legs');
const { coverageError } = require('./trading/exchange-calendar');
const { writeReviews, tickValueFor } = require('./trading/runner-reviews');

// Micros and minis of one index share bars: a position or order in either
// belongs to the symbol polled (MNQ bars manage an NQ trade too).
const famOf = contractId => familyRoot(contractRoot(contractId));
const etTime = iso => { const p = zonedParts(new Date(iso), 'America/New_York'); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ET`; };
const { trailStep } = require('./trading/trail');
const { afterTargetStep, liveTarget, swingAtBar } = require('./trading/exit-trail');
const { tradingDayStart, inMarketHours, sessionMinuteOf, MARKET_CLOSE_MIN, MARKET_TZ, parseWindows, inWindow } = require('./trading/clock');

/** Whether a session window of the runner's is open at `now` (a trade cycle could run). */
const inSession = (cfg, now) => inMarketHours(now) && parseWindows(cfg.sessions.join(',')).windows.some(w => inWindow(now, w));
const { exitPlan } = require('./trading/strategies');
const { timeframeMs } = require('./trading/evaluator');
const { lanesOf, tfLabel, retiredLaneText, isDataLane } = require('./lanes');
const { cycleTimeoutMin, settleCollisions, skippedVerdict, lanesLine, LOWER_PRIORITY, boundHistory, laneHistory, laneBarsOf } = require('./lane-cycle');

// The runner's timing (config/runner.json `runner`; closeSettleMs only rises, fillGraceMs and minManagedRiskTicks pinned).
const TUN = require('./tunables').runner();
const RUN = TUN.runner;
const IDLE_MS = RUN.idleMs;
const RESYNCS_BEFORE_REROLL = RUN.resyncsBeforeReroll;
const MAX_POLL_MS = TUN.bars.maxPollMs;
const LOOKUP_RETRY_MS = RUN.lookupRetryMs;
const MAX_RETRY_MS = RUN.maxRetryMs;
// A close sent this recently may not have filled yet: the contract is not closed (or its orders cancelled) again
// until it settles, so two closes in flight never over-close into the other side.
const CLOSE_SETTLE_MS = RUN.closeSettleMs;
// End of day that reads the account but doesn't find it flat yet counts as failed runs (kill switch) only after this long.
const { ORDER_GRACE_MS } = require('./trading/gate-timing');
const LR = require('./trading/lifecycle-runner');
const { ENUMS } = require('./broker/interface');
// The 1m bars read for the price before a composed fill's stop moves, as many as the signal age limit counts.
const SIGNAL_BARS = TUN.gate.signalMaxAgeBars;
const { expectedRoles } = require('./trading/desk-check');
const { withSkillsMissing } = require('./role-skills-record');
const { historySince } = require('./prop/attempt-scope');
const UNFLAT_GRACE_MS = ORDER_GRACE_MS; // gate-timing.js: one home (shorter is stricter here)
const FILL_GRACE_MS = RUN.fillGraceMs;
// The account read for a run's prompt never holds a run up longer than this.
const ACCOUNT_READ_MS = RUN.accountReadMs;
// A closing balance that couldn't be recorded is retried this often, this many times.
const CLOSE_RETRY_MS = RUN.closeRetryMs;
const CLOSE_TRIES = RUN.closeTries;
const STOP_ORDER_TYPES = new Set([3, 4, 5]);
// A failed premarket is tried again after these pauses (then every 10 min), until a session window opens.
const PREMARKET_RETRY_MS = RUN.premarketRetryMs;
// Several lanes: how long a lane due at the same close as one that already closed may keep the cycle waiting.
const COALESCE_HOLD_MS = TUN.cycle.coalesceHoldMs;

function createRunner(deps) {
  const {
    cfg, root, client, clock, runCycle, isKillSwitchOn, createKillSwitch, exitsOnly = false,
    loadState, saveState, writeBars, scanFor, log = () => {}, entryOrders = () => [], strategyNamed = () => null, exitStrategy = null, exitPlanOf = exitPlan,
    scanLog = () => {}, // the decision log: one record per scanned bar (trading/scan-log.js scanRecord)
    // The multi-timeframe record the order gate reads (trading/mtf-state.js); returns its trend-rule line.
    recordMtf = () => null,
    // The composed plans walked forward, settled by this bar (trading/lesson-shadow.js): (sym, bars), the first lane's.
    recordShadow = () => 0,
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
    // A 1m lane's closed bars, noted before the pass's briefings (the runner's briefing builds 5m candles from them).
    recordFineBars = () => {},
    // The report cache (trading/report-cache.js): serve({ symbols, account, now }) -> { roles, reports } still valid,
    // record({ symbols, account, now, output, served }) after the cycle. null: every role runs every cycle.
    reportCache = null,
    // The runner's desk (runner-wiring.js deskFor: workflows/desk/WORKFLOW.md run by the orchestration engine):
    // run({ symbols, roles, now, laneBars, at }) -> { reports, missing, results }, the roles the cache didn't serve, run
    // by the runner before the head trader decides. null: the head trader launches its desk itself, as before.
    desk = null,
    // The runner's entry (runner-wiring.js entryFor: workflows/entry/WORKFLOW.md): run(cycle) after the head trader's
    // run in a cycle where the runner runs the entry (entryCycle below), recordFile() a role record for a cycle the
    // desk didn't write one for. null: the head trader runs phase 2 and the trade-executor itself, as before.
    entry: entryWorkflow = null,
    // The latest local price of a symbol's family (trading/late-entry.js readPrice: the runner's entry recorded it before
    // its order): (symbol) -> { price, closedAt } or null. A composed fill's check reads the newer of it and the bars.
    latestPrice = () => null,
    // Record the latest price for the gate (trading/late-entry.js recordPrice): (symbol, { price, closedAt, minutes,
    // source }, { now, log }). null: none recorded during cycles.
    recordPrice = null,
    // The top instincts from the journal's reviews (trading/instincts.js), for the prompt.
    lessons = () => [],
    // The last 10 reviewed trades' outcomes (trading/instincts.js recentTrades), for the prompt.
    recentTrades = () => [],
    // When a fresh combine attempt's in-prompt history starts (prop/attempt-scope.js historyFrom: ms), or null: the
    // prompt's last cycles are only its own. null (any other run): every one, as before.
    historyFrom = () => null,
    event = () => {}, // the event log: one record per thing that happens (cycles, positions, stops, closes, errors)
    prop = null, // prop-challenge hooks (prop/live-runner.js createPropHooks)
    // A closed bar this pass polled: (symbol, { bar, stale, action, contractId, bars }), stale when it closed too long
    // ago to start a cycle, action the pass's (trade, manage, housekeep), bars the window polled (never to be changed).
    // The session record's decision point (session/live.js).
    barClosed = () => {},
    accountReadMs = ACCOUNT_READ_MS,
    // The analysts on a timeframe of their own (lanes.js analystFrames: [{ role, minutes, lane }]): a lane of theirs
    // gets its bar briefing too, and the prompt names each one's timeframe. None: every role reads the first lane's.
    analystFrames = [],
    // Several lanes: how long a lane due at the same close may hold the cycle. A one-pass process (a replay step)
    // passes 0: it can't wait (its bars are all there at the point; one missing is a gap live would wait out too).
    coalesceHoldMs = COALESCE_HOLD_MS,
    // The trade lifecycle's composed limits (trading/lifecycle-runner.js, wired by runner-wiring.js): due(orders, now)
    // the working composed entries whose record expired (the gateway stamped each at placement; one with no readable
    // expiry is due at once), stamped(roots, sinceMs) a composed entry on these roots that could still be working in a
    // cycle begun at sinceMs (lifecycle-runner.js liveComposed), onlyComposed() the lane runs composed strategies only, unrecorded(orders, positions,
    // contractId) the working entry limits the gateway never recorded, forItem(item) the compose records on an item's
    // bar, byOrder() order id -> its record id. null: none.
    composed = null,
    // How often a running cycle's composed limits are checked for expiry (watchComposed).
    composedWatchMs = RUN.composedWatchMs,
    // Setup-focused practice (learning/setup-moments.js selectBar, wired only on a practice replay): (item, open) ->
    // { run, why, reason }, whether a bar the trigger would run a cycle on runs one. null: every bar as live.
    practiceSelect = null,
  } = deps;
  const entryOrderIds = () => new Set(entryOrders().map(e => Number(e.orderId)));
  // The composed entries this process cancelled at their record's expiry: their review is due at once (runner-reviews.js).
  const cancelledEntries = new Set();
  const reviewWaits = new Map(); // order id -> why its review waits, logged only when it changes
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
  // `polled`: several bar clocks (a data lane's too): each lane's clock kept in the state, a shared close coalesced.
  // `multi`: several trading lanes (a data lane never cycles): lane-tagged cycles, prompts, history and budgets.
  const polled = lanes.length > 1;
  const multi = lanes.filter(l => !isDataLane(l)).length > 1;
  const laneKey = s => `${s.symbol}|${s.minutes}m`;
  // Several lanes: each lane's last bar, kept in the state (a replay pass is a new process: without it a 3m lane
  // would take its last bar for a new one at every 1m close).
  // { lastBarT, contractId } per lane: a clock is restored only for the contract it was kept on (a roll since starts over).
  const restored = (symbol, minutes) => {
    const r = polled && state && state.laneClocks ? state.laneClocks[`${symbol}|${minutes}m`] : null;
    const ok = r && typeof r.lastBarT === 'string' && Number.isFinite(Date.parse(r.lastBarT)) && typeof r.contractId === 'string';
    return ok ? { restoredFor: r.contractId, clock: { lastBarT: r.lastBarT, expectedCloseAt: Date.parse(r.lastBarT) + 2 * minutes * 60000, pollingSince: null } } : { restoredFor: null, clock: null };
  };
  const syms = lanes.flatMap((lane, li) => cfg.symbols.map(symbol => ({ symbol, lane: li, minutes: lane.timeframe, contractId: null, contractDay: null, ...restored(symbol, lane.timeframe), lastPollAt: 0, misses: 0, resyncs: 0 })));
  let held = []; // several lanes: closed bars waiting (briefly) for a lane due at the same close
  const frameLanes = new Set(analystFrames.filter(f => f.lane > 0).map(f => f.lane));
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
  // A lane that lists a retired strategy (lanes.js retireLanes): said loudly at start, in the log and the event log.
  lanes.forEach((l, i) => {
    if (!l.retired) return;
    log(`lanes[${i}] (${l.timeframe}m) ${retiredLaneText(l)}`, 'error');
    emit('lane_retired', { lane: i, timeframe: `${l.timeframe}m`, retired: l.retired });
  });

  /**
   * The account's fills since `sinceMs` for the decision history's outcomes (decision-history.js withPositions), or
   * null: none needed (no unresolved decision), no live account, or the read failed (logged; outcomes stay unknown).
   * The prop hooks' read is reused only when this pass's snapshot made it (`snapshotAt`, its time) and it covers
   * `sinceMs`; else one adapter read.
   */
  async function historyFills(sinceMs, snapshotAt) {
    if (sinceMs === null || !cfg.account || cfg.paper || typeof client.fillsSince !== 'function') return null;
    const read = prop && typeof prop.recentFills === 'function' ? prop.recentFills() : null;
    if (read && Array.isArray(read.fills) && snapshotAt !== null && read.atMs === snapshotAt && read.sinceMs <= sinceMs) return read.fills;
    try {
      const fills = await client.fillsSince(cfg.account, new Date(sinceMs));
      return Array.isArray(fills) ? fills : null;
    } catch (err) {
      log(`history: the fills could not be read (${err.message}); closed entries' outcomes stay unknown`, 'error');
      return null;
    }
  }

  /** Run an agent cycle, timed, with its outcome in the event log. */
  async function timedCycle(action, prompt, limits, info = {}) {
    const t0 = clock.now().getTime();
    emit('cycle_start', { action, timeoutMs: limits.timeoutMs, ...info });
    const r = await runCycle(action, prompt, limits);
    // agentError: the agent's own "CYCLE RESULT: error", a decision (replay records it as live and goes on).
    // reportedResult: the line the agent wrote when the runner scores it otherwise (autotrader.js scoredResult), kept.
    emit('cycle_end', { action, ms: clock.now().getTime() - t0, ok: Boolean(r && r.ok), timedOut: Boolean(r && r.timedOut), result: (r && r.result) || null, ...(r && r.reportedResult ? { reportedResult: r.reportedResult } : {}), ...(r && r.agentError ? { agentError: true } : {}), ...info });
    if (r && r.reportedResult) log(`${action}: the agent wrote "${r.reportedResult}"; ${r.resultNote || 'scored otherwise'}`);
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
      return { ...sym, contractId: c.id, tickSize: c.tickSize, tickValue: c.tickValue || null, contractDay: day, clock: !sym.contractId && sym.restoredFor === c.id ? sym.clock : null, lastPollAt: 0, misses: 0, resyncs: 0, lookupFailedAt: 0 };
    }
    return { ...sym, tickSize: c.tickSize || sym.tickSize, tickValue: c.tickValue || sym.tickValue || null, contractDay: day, resyncs: 0, lookupFailedAt: 0 };
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
      // A data lane's bars (lanes.js) only go to the briefing (recordFineBars): no bars file, no trend or day read, and
      // a bar that closed a while ago (after a long cycle) still counts: its window is closed bars, never later ones.
      if (isDataLane(lanes[sym.lane])) return { symbol: sym.symbol, lane: sym.lane, minutes, contractId: sym.contractId, tickSize: sym.tickSize, bars: step.bars, stale: false, data: true, bar: { t: step.bar.t, c: step.bar.c, contractId: sym.contractId } };
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
      try {
        if (first) recordShadow(sym, bars);
      } catch (err) {
        // A lesson's record only: its lessons show without the newest composed plans.
        log(`${sym.symbol}: could not record the composed plans' shadow outcomes (${err.message})`, 'error');
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

  /**
   * Cancel a composed limit entry still working at its record's expiry (the next base-bar close): the broker interface
   * has no time in force, so an unfilled composed entry never outlives its record. Cancels are risk-reducing.
   */
  async function expireComposed(item, { orders, positions }, { unrecorded = false } = {}) {
    if (!composed) return;
    const root = famOf(item.contractId);
    // Outside a cycle, on a lane of composed strategies only: a working entry limit the gateway never recorded can't be
    // tied to a record, so it goes too (during a cycle its own entry may not be recorded yet: never then).
    const stray = unrecorded && composed.onlyComposed() ? composed.unrecorded(orders || [], positions || [], item.contractId).map(o => ({ order: o, entry: null })) : [];
    for (const { order: o, entry } of [...composed.due((orders || []).filter(x => famOf(x.contractId) === root), clock.now()), ...stray]) {
      try {
        await client.cancelOrder(cfg.account, o.id);
      } catch (err) {
        log(`${item.symbol}: could not cancel the expired composed entry ${o.id} (${err.message}); the next bar retries`, 'error');
        continue;
      }
      cancelledEntries.add(String(o.id));
      const c = (entry && entry.composed) || {};
      log(`${item.symbol}: cancelled the composed entry ${o.id}: ${!entry ? 'the gateway never recorded it as an entry' : c.expiresAt ? `its record expired at ${c.expiresAt}` : 'no record expiry was stamped for it'}`);
      emit('composed_expired', { symbol: item.symbol, orderId: o.id, expiresAt: c.expiresAt || null, record: c.record || null });
    }
  }

  /**
   * While a cycle runs (the runner awaits it), its composed limits still expire: every `composedWatchMs` the run's
   * symbols' due composed entries are cancelled (expireComposed), so a cycle outlasting a record's expiry never leaves
   * its limit working, and a composed fill is checked against its plan at once (guardFill). Returns the stop.
   */
  function watchComposed(items) {
    if (!composed || !cfg.account || cfg.paper || typeof client.accountState !== 'function' || !(composedWatchMs > 0)) return () => {};
    let busy = false;
    const since = clock.now().getTime();
    const roots = items.map(x => x.contractId || x.symbol);
    const timer = setInterval(async () => {
      if (busy) return;
      // No account read unless a composed entry stamped for these roots could still be working (one placed this cycle,
      // or one whose stamp has no expiry): most cycles place none.
      if (!composed.stamped(roots, since)) return;
      busy = true;
      try {
        for (const item of items) {
          const account = await client.accountState(cfg.account);
          await expireComposed(item, account);
          // A fill during the cycle: checked against its plan at once, not at the next bar.
          await guardFill(item, account);
        }
      } catch (err) {
        log(`composed expiry during the cycle: ${err.message}`, 'error');
      } finally {
        busy = false;
      }
    }, composedWatchMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  /**
   * While a trade cycle that may enter runs (any harness: the model may place its own composed entry), every
   * `composedWatchMs` the newest closed 1m bar of each of the run's symbols is read through the adapter at the harness
   * clock and recorded (recordPrice: trading/late-entry.js, never backwards), so the gate's [late-entry] judges the
   * order on a price at most a poll and a 1m bar old, not the briefing's close alone. One read per symbol a poll, none
   * outside trade cycles; a failed read is logged and the gate fails closed on what it has. Returns the stop.
   */
  function watchPrice(items) {
    if (!recordPrice || typeof client.closedBars !== 'function' || !(composedWatchMs > 0)) return () => {};
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        for (const item of items) {
          try {
            const now = clock.now();
            const bars = await client.closedBars(item.contractId, { minutes: 1, limit: SIGNAL_BARS, now });
            const b = Array.isArray(bars) && bars.length ? bars[bars.length - 1] : null;
            const closed = b ? Date.parse(b.t) + 60000 : NaN;
            if (b && Number.isFinite(Number(b.c)) && Number.isFinite(closed) && closed <= now.getTime()) {
              recordPrice(item.symbol, { price: Number(b.c), closedAt: new Date(closed).toISOString(), minutes: 1, source: 'runner' }, { now, log: m => log(`${item.symbol}: ${m}`) });
            }
          } catch (err) {
            log(`${item.symbol}: the latest 1m bar for the gate could not be read or recorded (${err.message})`, 'error');
          }
        }
      } finally {
        busy = false;
      }
    }, composedWatchMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  /** Cancel leftover orders on a flat contract root (never pending entries). */
  async function cleanupFlat(item, { positions, orders }, { noCycles = false } = {}) {
    const root = famOf(item.contractId);
    // Flat means no position in any month or size (micro, mini) of the root (not months netting to zero).
    if (positions.some(p => famOf(p.contractId) === root && isOpen(p))) return;
    // When no cycle may run (kill switch, outside the sessions), a pending
    // entry that fills would have no one to manage it: cancel those too.
    const entries = noCycles ? new Set() : entryOrderIds();
    // Each cancel on its own: one the broker refuses, loses or answers late never skips the others (or the rest of the
    // housekeeping); the next bar reads the account again and retries what is still working.
    for (const o of orders.filter(x => famOf(x.contractId) === root && !entries.has(Number(x.id)))) {
      try {
        await client.cancelOrder(cfg.account, o.id);
        log(`${item.symbol}: cancelled leftover order ${o.id} (type ${o.type}, side ${o.side}, size ${o.size}) on a flat ${root} position`);
      } catch (err) {
        log(`${item.symbol}: could not cancel leftover order ${o.id} on a flat ${root} position (${err.message}); the next bar retries`, 'error');
        emit('leftover_cancel_failed', { symbol: item.symbol, orderId: o.id, error: err.message });
      }
    }
  }

  /** After a refused stop move: the account read again; a flat root has its leftover orders cancelled now. */
  async function reconcileAfterRefusedMove(item, err) {
    try {
      const fresh = await client.accountState(cfg.account);
      const root = famOf(item.contractId);
      if (fresh.positions.some(p => famOf(p.contractId) === root && isOpen(p))) return;
      log(`${item.symbol}: the stop move was refused (${err.message}) and the ${root} position reads flat: its bracket filled or was cancelled; cancelling the leftovers`, 'error');
      await cleanupFlat(item, fresh);
    } catch (e) {
      log(`${item.symbol}: could not re-read the account after a refused stop move (${e.message}); the next bar reconciles`, 'error');
    }
  }

  /**
   * Trailing exit for a position whose strategy trails (exit block), the
   * backtester's rule applied live:
   *   - the trade is matched to the entry the gateway recorded for it (same
   *     root and side, recorded this trading day and no later than the fill);
   *   - 1R comes from a composed trade's plan stop (from the fill), else the planned bracket, else the working stop when the
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
          && at >= dayStart && at <= fillAt + ORDER_GRACE_MS;
      });
      // Exits only: a strategy that stopped loading while its position is open keeps its last exit plan (exitStrategy).
      const strategy = rec && (exitStrategy || strategyNamed)(rec.setup, { symbol: item.symbol, contractId: cid, position: key });
      // A composed trade: its policy's exit, in an attempt or not (runner-wiring.js: evaluator.js composedExit).
      const plan = strategy ? exitPlanOf(strategy) : null;
      const entry = Number(p.averagePrice);
      let risk = null;
      // A composed trade: the risk actually taken, from the fill to the plan's stop (where guardFill re-anchors it).
      const planStop = rec && rec.composed && Number.isFinite(rec.composed.stop) ? rec.composed.stop : null;
      if (planStop !== null && sign * (entry - planStop) > 0) risk = sign * (entry - planStop);
      else if (rec && rec.stopTicks && tick) risk = rec.stopTicks * tick;
      else if (stopOrder && sign * (entry - Number(stopOrder.stopPrice)) > 0) risk = sign * (entry - Number(stopOrder.stopPrice));
      else if (rec && rec.stopPrice && sign * (entry - rec.stopPrice) > 0) risk = sign * (entry - rec.stopPrice);
      // Managed: a trailing exit, or a time stop (max_bars), or a trail past the target (exit mode target_then_trail).
      const managed = plan && (plan.trailActivateR !== null || plan.maxBars || plan.afterTarget);
      // max_bars counts the strategy's own bars; the runner sees its own timeframe's.
      const tfMin = ((strategy && timeframeMs(strategy.timeframe)) || cfg.timeframe * 60000) / 60000;
      const maxRunnerBars = plan && plan.maxBars ? Math.ceil((plan.maxBars * tfMin) / cfg.timeframe) : null;
      // Past the target: the trade's own target (its bracket), whose resting order is cancelled so the trail can run.
      const ok = managed && tick > 0 && risk >= RUN.minManagedRiskTicks * tick - 1e-9;
      const after = ok && plan.afterTarget ? liveTarget({ rec, entry, sign, tick, orders, contractId: cid }) : null;
      t = ok
        ? { key, setup: rec.setup, sign, entry, risk, stop: entry - sign * risk, peakR: 0, troughR: 0, barsHeld: 0, plan, maxRunnerBars, since: fillAt, lastBarT: null, ...(after ? { target: after.price, armed: false } : {}) }
        : { key, skip: true };
      if (after && after.price === null) log(`${item.symbol}: ${rec.setup}: no target to trail past (${after.why}); the stop holds until its own exit`, 'error');
      for (const o of after ? after.cancel : []) {
        try {
          await client.cancelOrder(cfg.account, o.id);
          log(`${item.symbol}: cancelled the target order ${o.id} at ${o.limitPrice}: past its target ${rec.setup} is trailed, not closed (exit mode target_then_trail)`);
        } catch (err) {
          log(`${item.symbol}: could not cancel the target order ${o.id} (${err.message}); it may fill at the target`, 'error');
        }
      }
      save(t);
      if (ok) {
        const how = [plan.trailActivateR !== null ? `activate ${plan.trailActivateR}R, give back ${plan.trailGivebackR}R` : '', plan.afterTarget ? `past the target ${t.target}: lock at its R less ${plan.afterTarget.lockGivebackR}R${plan.afterTarget.ratchet ? ' (ratchet on: from the best R reached)' : ''}, trail ${plan.afterTarget.trailBy === 'structure' ? `behind ${plan.afterTarget.swingMinutes}m swings (${plan.afterTarget.trailR}R until one is confirmed)` : `${plan.afterTarget.trailR}R`}` : '', plan.maxBars ? `time stop ${plan.maxBars} ${strategy.timeframe} bars = ${maxRunnerBars} ${cfg.timeframe}m bars` : ''].filter(Boolean).join('; ');
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
    let armed = Boolean(t.armed);
    let fellBack = false;
    for (const bar of bars) {
      // A level the resting stop never reached (a modify that failed or came
      // too late) protects nothing: a bar through it means out at market.
      if ((resting === null || sign * (target - resting) > 0) && (sign > 0 ? bar.l <= target : bar.h >= target)) { cross = { bar, stop: target }; break; }
      troughR = Math.min(troughR, (sign * ((sign > 0 ? bar.l : bar.h) - t.entry)) / t.risk);
      const after = t.plan.afterTarget;
      // Past the target: exit-trail.js on this closed bar, the swing confirmed by its close (never a later bar).
      const step = after ? afterTargetStep({ ...t, stop: target, peakR, armed }, bar, t.plan, tick, after.trailBy === 'structure' ? swingAtBar(item.bars, bar, after.swingMinutes, sign) : null)
        : trailStep({ ...t, stop: target, peakR }, bar, t.plan, tick);
      if (after) { armed = step.armed; fellBack = fellBack || step.fellBack; }
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
      save({ ...t, peakR, troughR, barsHeld, lastBarT, armed });
      // The runner's own exit, one record per position (append-only, the last few kept), for the decision history's
      // real R (decision-history.js withPositions).
      state = { ...state, runnerExits: appendExit(state.runnerExits, { contractId: cid, side: sign > 0 ? 'long' : 'short', openedAt: new Date(t.since).toISOString(), size: Number(p.size), at: clock.now().toISOString(), r: Math.round(((sign * (last.c - t.entry)) / t.risk) * 100) / 100 }) };
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
    if (fellBack && !t.fellBackSaid) log(`${item.symbol}: structure trail: no ${t.plan.afterTarget.swingMinutes}m swing confirmed yet; trailing ${t.plan.afterTarget.trailR}R behind the best price (the fallback)`);
    save({ ...t, peakR, troughR, barsHeld, lastBarT, armed, fellBackSaid: Boolean(t.fellBackSaid || fellBack) });
    if (!stopOrder) {
      if (sign * (target - t.stop) < tick - 1e-9) return;
      log(`${item.symbol}: trail wants the stop at ${target} but there is no single working stop order to move`, 'error');
      return;
    }
    if (sign * (target - resting) < tick - 1e-9) return;
    if (Number(stopOrder.size) > Number(p.size)) {
      log(`${item.symbol}: trail: stop ${stopOrder.id} (size ${stopOrder.size}) is bigger than the position (${p.size}); not moving it toward the market`, 'error');
      // Anti-flip: a stop bigger than the position would reverse it when it fires. Cut to the position's size (the
      // bracket order itself, with modify_order: never a new order); the move waits for the next bar's read.
      if (typeof client.resizeStop === 'function' && Number(p.size) > 0) {
        try {
          await client.resizeStop(cfg.account, stopOrder.id, Number(p.size), `[protect] stop cut to the position's size ${p.size}`);
          log(`${item.symbol}: trail: stop ${stopOrder.id} cut from ${stopOrder.size} to the position's size ${p.size}`);
          emit('stop_resized', { symbol: item.symbol, contractId: cid, orderId: stopOrder.id, from: Number(stopOrder.size), to: Number(p.size) });
        } catch (err) {
          log(`${item.symbol}: trail: could not cut stop ${stopOrder.id} to ${p.size} (${err.message}); the next bar retries`, 'error');
        }
      }
      return;
    }
    // Never a stop that isn't a price (a broken exit plan gives NaN): the broker's stop stays where it is.
    if (!(typeof target === 'number' && Number.isFinite(target) && target > 0)) {
      log(`${item.symbol}: trail: the new stop for ${t.setup} is not a price (${target}); not sent, stop ${stopOrder.id} stays at ${resting}`, 'error');
      emit('stop_not_moved', { symbol: item.symbol, contractId: cid, setup: t.setup, resting, target: String(target) });
      return;
    }
    try {
      await client.modifyStop(cfg.account, stopOrder.id, target);
    } catch (err) {
      // A refused move ("order not found" or the like) may mean the bracket's stop filled or was cancelled: read the
      // account again at once and, flat, cancel the leftovers now (never a dead order retried every bar).
      await reconcileAfterRefusedMove(item, err);
      throw err;
    }
    emit('stop_moved', { symbol: item.symbol, contractId: cid, setup: t.setup, from: resting, to: target, peakR, barsHeld });
    save({ ...trails[item.contractId], stop: target });
    log(`${item.symbol}: trail: stop ${resting} -> ${target} (peak ${peakR.toFixed(2)}R)`);
  }

  /**
   * A composed entry's fill against its plan (lifecycle-runner.js fillGuard), checked once per position:
   *   - the position is matched to the latest entry the gateway recorded for its root and side at or before the fill
   *     (any setup, as the trailing manager matches it); only a composed one is judged;
   *   - at or beyond the plan's stop (the fill, or the latest price): closed at market ([exit]). Only its target is
   *     cancelled then; its protective stop stays until the position reads flat (cleanupFlat cancels the leftovers),
   *     and the close is sent again every CLOSE_SETTLE_MS while it still reads open (a lost, refused or ghost close);
   *   - filled away from the plan's limit: before its stop moves to the plan's price ([protect]), the newest closed 1m
   *     bar is read through the adapter at the harness clock; at or beyond the plan's stop, or unknown, it is closed
   *     instead (never a stop moved through the market).
   * Returns true when it acted (the trail waits for the next account read). A failed move is tried again next pass.
   */
  async function guardFill(item, { positions, orders }) {
    const fam = famOf(item.contractId);
    const guards = { ...(state.fillGuards || {}) };
    const tick = Number(item.tickSize) || 0;
    const keyOf = x => `${x.contractId}|${String(x.id ?? `${x.creationTimestamp}|${x.averagePrice}`)}`;
    let acted = false;
    const sendClose = async (p, why, first) => {
      closedAt.set(p.contractId, clock.now().getTime()); // end of day won't send a second close while this one fills
      try {
        await client.closePosition(cfg.account, p.contractId);
        log(`${item.symbol}: [exit] ${why}; ${first ? 'closed' : 'closed again'} at market`, 'error');
      } catch (err) {
        log(`${item.symbol}: [exit] could not close the composed fill (${err.message}); sent again in ${CLOSE_SETTLE_MS / 1000} s while it reads open`, 'error');
      }
    };
    for (const p of (positions || []).filter(x => famOf(x.contractId) === fam && isOpen(x))) {
      const key = keyOf(p);
      const was = guards[key];
      // A close sent and the position still open: sent again once the last one had time to fill.
      if (was && was.closing) {
        if (clock.now().getTime() - (closedAt.get(p.contractId) ?? -Infinity) >= CLOSE_SETTLE_MS) await sendClose(p, `${was.why} (still open)`, false);
        acted = true;
        continue;
      }
      if (was) continue;
      let sign;
      try { sign = Math.sign(signedSize(p)); } catch (_err) { sign = 0; }
      const opened = Date.parse(p.creationTimestamp);
      const fillAt = Number.isFinite(opened) ? opened : clock.now().getTime();
      const dayStart = tradingDayStart(new Date(fillAt)).getTime();
      const side = sign > 0 ? 'buy' : 'sell';
      const rec = [...entryOrders()].reverse().find(e => {
        const at = Date.parse(e && e.at);
        return e && e.setup && contractRoot(e.contractId) === contractRoot(p.contractId) && (!e.side || e.side === side) && at >= dayStart && at <= fillAt + ORDER_GRACE_MS;
      });
      if (!rec || !rec.composed) { guards[key] = 'none'; continue; }
      // The newest price the runner holds: its bars' last close, or the price its entry recorded, whichever closed later.
      const last = item.bars && item.bars.length ? item.bars[item.bars.length - 1] : null;
      const known = [last ? { price: Number(last.c), at: Date.parse(last.t) + (item.minutes || cfg.timeframe) * 60000 } : null, (() => { const r = latestPrice(item.symbol); return r ? { price: Number(r.price), at: Date.parse(r.closedAt) } : null; })()]
        .filter(x => x && Number.isFinite(x.price) && Number.isFinite(x.at));
      const price = known.length ? known.reduce((a, b) => (b.at > a.at ? b : a)).price : null;
      let g = LR.fillGuard({ position: p, entry: rec, orders, tick, price });
      if (g.action === 'reanchor') {
        // The market now, before a stop moves: the newest closed 1m bar; through the plan's stop, or unknown, out.
        let now1m = null;
        try {
          const nowMs = clock.now().getTime();
          const bars = await client.closedBars(p.contractId, { minutes: 1, limit: SIGNAL_BARS, now: clock.now() });
          const b = Array.isArray(bars) && bars.length ? bars[bars.length - 1] : null;
          // Closed by now and current (within the signal age of 1m bars): an old bar after a data stall is unknown.
          const closed = b ? Date.parse(b.t) + 60000 : NaN;
          const current = Number.isFinite(closed) && closed <= nowMs && nowMs - closed <= SIGNAL_BARS * 60000;
          now1m = b && current && Number.isFinite(Number(b.c)) ? Number(b.c) : null;
        } catch (err) {
          log(`${item.symbol}: the latest 1m bar can't be read before moving the composed fill's stop (${err.message})`, 'error');
        }
        const checked = now1m === null ? null : LR.fillGuard({ position: p, entry: rec, orders, tick, price: now1m });
        if (!checked) g = { action: 'flatten', why: `the price now is unknown, so the stop can't be moved to the plan's ${g.to} safely (filled at ${Number(p.averagePrice)})` };
        else g = checked;
      }
      if (g.action === 'flatten') {
        guards[key] = { closing: true, why: g.why };
        emit('position_closed', { symbol: item.symbol, contractId: p.contractId, setup: rec.setup, side: sign > 0 ? 'long' : 'short', entry: Number(p.averagePrice), why: `[exit] ${g.why}` });
        await sendClose(p, g.why, true);
        // Only the target goes now (it could open the other side once flat); the protective stop stays until flat.
        for (const o of (orders || []).filter(x => x.contractId === p.contractId && Number(x.type) === ENUMS.orderType.limit && (Number(x.side) === ENUMS.side.buy ? 1 : -1) === -sign)) {
          try { await client.cancelOrder(cfg.account, o.id); } catch (err) { log(`${item.symbol}: could not cancel the target ${o.id} after the close (${err.message}); cancelled once flat`, 'error'); }
        }
        acted = true;
        continue;
      }
      try {
        if (g.action === 'reanchor') {
          await client.modifyStop(cfg.account, g.orderId, g.to, `[protect] the plan's stop ${g.to}: ${g.why}`);
          emit('stop_moved', { symbol: item.symbol, contractId: p.contractId, setup: rec.setup, from: g.from, to: g.to, why: 'plan stop' });
          log(`${item.symbol}: [protect] ${g.why}`);
          acted = true;
        }
        guards[key] = g.action;
      } catch (err) {
        log(`${item.symbol}: could not move the stop of the composed fill (${err.message}); the next pass retries`, 'error');
      }
    }
    // Only open positions' keys are kept (a flat one's, a close that filled among them, go).
    const openKeys = new Set((positions || []).filter(isOpen).map(keyOf));
    state = { ...state, fillGuards: Object.fromEntries(Object.entries(guards).filter(([k]) => openKeys.has(k))) };
    return acted;
  }

  /**
   * The bracket invariant (the owner, 2026-10-26: "make sure we avoid orphan orders by ensuring we always have a
   * bracket"), on every poll, in the sessions and out: every open position of this root has its protective stop
   * (bracket-legs.js: the server's bracket role when it gives one, else the order's type), sized to the position.
   *   - one stop bigger than the position: cut to its size (anti-flip; modify_order on that stop);
   *   - several stops over its size: the surplus cancelled (the runner's gateway may), keeping one stop of exactly its
   *     size; none such, or a cancel that fails: closed at market (they could reverse it);
   *   - stops for less than its size (a lost bracket, a broker fault), once the position is older than the fill grace
   *     (a fresh fill's leg may not be listed yet) and still so on a second read of the account (a leg that just
   *     filled, a positions view behind the orders'): the runner's own [protect] stop for the uncovered size at the
   *     plan's stop (the trail's, else the entry record's), the one separate stop the gate lets through; at market
   *     instead when that level is unknown or already through the last close, the position is in another month than
   *     the bars read (their prices aren't its), or the stop can't be placed.
   * Every action is an alert. A cut or close that fails is logged and the loop goes on (the next poll retries).
   * Returns true when it acted (the next poll reads the account again).
   */
  async function ensureProtected(item, { positions, orders }) {
    if (typeof client.placeStop !== 'function') return false;
    const root = famOf(item.contractId);
    let acted = false;
    for (const p of positions.filter(x => famOf(x.contractId) === root && isOpen(x))) {
      let net;
      try { net = signedSize(p); } catch (_err) { continue; } // a size that can't be read: end of day and the gate fail closed on it
      const sign = Math.sign(net);
      const size = Math.abs(net);
      if (!sign) continue;
      const stops = protectiveStops(orders, p.contractId, sign);
      const covered = stops.reduce((n, o) => n + Number(o.size || 0), 0);
      if (covered === size) continue;
      const closeAt = async why => {
        closedAt.set(p.contractId, clock.now().getTime());
        log(`${item.symbol}: ALERT ${p.contractId} ${sign > 0 ? 'long' : 'short'} ${size}: ${why}; closed at market`, 'error');
        emit('protection_closed', { symbol: item.symbol, contractId: p.contractId, size, covered, why });
        try {
          await client.closePosition(cfg.account, p.contractId);
        } catch (err) {
          // Not counted as sent: the next poll closes again (close_position flattens whatever is open, never more).
          closedAt.delete(p.contractId);
          log(`${item.symbol}: ALERT the close of ${p.contractId} failed (${err.message}); the next poll retries`, 'error');
        }
      };
      if (covered > size) {
        acted = true;
        const [only, ...more] = stops;
        if (!more.length && typeof client.resizeStop === 'function') {
          try {
            await client.resizeStop(cfg.account, only.id, size, `[protect] stop cut to the position's size ${size}`);
            log(`${item.symbol}: ALERT stop ${only.id} (${covered}) was bigger than the ${p.contractId} position (${size}); cut to its size`, 'error');
            emit('stop_resized', { symbol: item.symbol, contractId: p.contractId, orderId: only.id, from: covered, to: size });
          } catch (err) {
            await closeAt(`its stop for ${covered} could reverse it and could not be cut (${err.message})`);
          }
          continue;
        }
        // The bracket's own leg first (the server's role), else the oldest: never the stand-alone one beside it.
        const sized = stops.filter(o => Number(o.size) === size).sort((a, b) => (legRole(b) === 'stop') - (legRole(a) === 'stop') || (Date.parse(a.creationTimestamp) || 0) - (Date.parse(b.creationTimestamp) || 0));
        const keep = sized[0];
        try {
          if (!keep) throw new Error('no single stop of its size to keep');
          for (const o of stops.filter(x => x !== keep)) await client.cancelOrder(cfg.account, o.id);
          log(`${item.symbol}: ALERT ${p.contractId} had stops for ${covered} of ${size}: kept stop ${keep.id}, cancelled the rest`, 'error');
          emit('stops_trimmed', { symbol: item.symbol, contractId: p.contractId, kept: keep.id, covered, size });
        } catch (err) {
          await closeAt(`stops for ${covered} could reverse it (${err.message})`);
        }
        continue;
      }
      const opened = Date.parse(p.creationTimestamp);
      if (Number.isFinite(opened) && clock.now().getTime() - opened < FILL_GRACE_MS) continue;
      if (closedAt.has(p.contractId) && clock.now().getTime() - closedAt.get(p.contractId) < ORDER_GRACE_MS) continue;
      // A second read: a leg that just filled (flat now) or a stop listed late is never answered with a stray stop.
      let fresh;
      try {
        fresh = await client.accountState(cfg.account);
      } catch (err) {
        log(`${item.symbol}: ALERT ${p.contractId} reads unprotected and the account can't be read again (${err.message}); the next poll checks again`, 'error');
        acted = true;
        continue;
      }
      const again = fresh.positions.find(x => x.contractId === p.contractId && isOpen(x));
      let againNet;
      try { againNet = again ? signedSize(again) : 0; } catch (_err) { continue; }
      if (againNet !== net || protectiveStops(fresh.orders, p.contractId, sign).reduce((n, o) => n + Number(o.size || 0), 0) !== covered) continue;
      acted = true;
      // Another month than the bars read: their prices aren't this position's (the old rule: closed).
      if (contractMonthTag(p.contractId) !== contractMonthTag(item.contractId)) {
        await closeAt(`stops cover ${covered}, in another month than the bars the runner reads`);
        continue;
      }
      const level = planStopOf(item, p, sign);
      const bar = Array.isArray(item.bars) && item.bars.length ? item.bars[item.bars.length - 1] : null;
      const last = bar ? Number(bar.c) : NaN;
      if (!(level > 0) || !Number.isFinite(last) || sign * (last - level) <= 0) {
        await closeAt(`stops cover ${covered} and the plan's stop ${level > 0 ? `${level} is through the last close ${last}` : 'is unknown'}`);
        continue;
      }
      try {
        await client.placeStop(cfg.account, p.contractId, sign > 0 ? 'sell' : 'buy', size - covered, level, `[protect] runner: the bracket's stop is missing; restored at the plan's stop ${level}`);
        log(`${item.symbol}: ALERT ${p.contractId} had stops for ${covered} of ${size}: restored a stop for ${size - covered} at ${level}`, 'error');
        emit('protection_restored', { symbol: item.symbol, contractId: p.contractId, size: size - covered, stop: level });
      } catch (err) {
        await closeAt(`its stop could not be restored (${err.message})`);
      }
    }
    return acted;
  }

  /** The plan's stop for a position: the trail's current one for it, else its entry record's (price, or ticks from the fill). */
  function planStopOf(item, p, sign) {
    const t = (state.trails || {})[item.contractId];
    const key = String(p.id ?? `${p.creationTimestamp}|${p.averagePrice}`);
    if (t && t.key === key && !t.skip && Number(t.stop) > 0) return Number(t.stop);
    const fillAt = Date.parse(p.creationTimestamp);
    const side = sign > 0 ? 'buy' : 'sell';
    const dayStart = tradingDayStart(new Date(Number.isFinite(fillAt) ? fillAt : clock.now().getTime())).getTime();
    const rec = [...entryOrders()].reverse().find(e => {
      const at = Date.parse(e.at);
      return contractRoot(e.contractId) === contractRoot(p.contractId) && (!e.side || e.side === side) && at >= dayStart && (!Number.isFinite(fillAt) || at <= fillAt + ORDER_GRACE_MS);
    });
    if (!rec) return null;
    if (Number(rec.stopPrice) > 0) return Number(rec.stopPrice);
    const tick = Number(item.tickSize) || 0;
    if (Number.isInteger(rec.stopTicks) && rec.stopTicks > 0 && tick > 0 && Number(p.averagePrice) > 0) {
      return Math.round((Number(p.averagePrice) - sign * rec.stopTicks * tick) * 1e9) / 1e9;
    }
    return null;
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
      await expireComposed(item, account, { unrecorded: true });
      await cleanupFlat(item, account, { noCycles });
      // The kill switch on: no cycle will come, so a position whose stops don't cover it exactly is closed, as before.
      if (noCycles && isKillSwitchOn() && await flattenUncovered(item, account)) return;
      // Every open position keeps its bracket's stop, sized to it (in the sessions and out): restored or cut here.
      if (await ensureProtected(item, account)) return;
      // No cycle will come to protect a position whose stops don't cover it
      // exactly (none, too small, or big enough to flip it): flatten it.
      if (noCycles && await flattenUncovered(item, account)) return;
      // A composed fill beyond its plan's stop goes at once; one away from its limit gets the plan's stop.
      if (await guardFill(item, account)) return;
      if (trail) await trailPosition(item, account);
    } catch (err) {
      log(`${item.symbol}: account housekeeping failed (${err.message})`, 'error');
    }
  }

  /**
   * The runner's factual review of each entry of today it has seen end, unfilled or flat (trading/runner-reviews.js),
   * through the adapter's journal_add, after the pass's risk work: the gate's review-before-next-entry never waits on a
   * review the model skipped; the trade-reviewer adds the grade. The ids written are kept in the state for the trading
   * day (a restart writes none again; the journal says so too). A failure is logged and tried again on the next pass.
   */
  async function factualReviews() {
    if (!cfg.account || cfg.paper || typeof client.journalAdd !== 'function' || typeof client.accountState !== 'function') return;
    const now = clock.now();
    const day = dayKey(now);
    const kept = state.runnerReviews && state.runnerReviews.day === day && Array.isArray(state.runnerReviews.ids) ? state.runnerReviews.ids : [];
    const specOf = r => syms.find(s => s.contractId && s.tickSize && famOf(s.contractId) === familyRoot(r)) || {};
    const tickOf = r => specOf(r).tickSize || null;
    // The root's own tick value (a mini's is not its micro's; the tick size is the family's).
    const tickValueOf = r => tickValueFor(r, syms);
    try {
      const ids = await writeReviews({ client, accountId: cfg.account, entries: journalEntries, entryOrders: entryOrders(), now, cancelled: cancelledEntries, tickOf, tickValueOf, written: kept, waits: reviewWaits, log, emit });
      if (ids.length !== kept.length) {
        state = { ...state, runnerReviews: { day, ids } };
        saveState(state);
      }
    } catch (err) {
      log(`the runner's reviews: ${err.message}; the next bar tries again`, 'error');
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
    // The briefing is the symbol's, built on the first lane's bars (another lane's bar keeps the last one); another
    // lane's bars brief only an analyst on that lane's timeframe.
    if (item.lane > 0 && !frameLanes.has(item.lane)) return;
    try {
      // A lane's briefing that couldn't be built (its setups' room unread): no entry on that bar (laneBlocked).
      const r = recordBriefing(item, results, scanError);
      if (item.lane > 0 && r && r.error) item.briefError = r.error;
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

  /**
   * A lane's bar whose briefing couldn't be built: its setups have no room read, so no entry on it (fail closed). Only
   * that symbol's lane: the gate's signal record for its timeframe says nothing fired on the bar (the gate refuses an
   * entry on it), no verdict is screened, its setups leave the prompt, and it runs a cycle only to manage what is open.
   * Other lanes and symbols in the cycle trade as usual (their records are their own). Logged, and an event
   * (lane_briefing_unavailable) so a failure that persists is seen.
   */
  async function laneBlocked(item) {
    const why = `the ${item.minutes}m lane's bar briefing can't be built (${item.briefError}): no entry on this bar, only managing what is open`;
    item.verdicts = [];
    item.scan = [];
    item.entryBlocked = why;
    log(`${item.symbol} ${item.minutes}m: ${why}`, 'error');
    emit('lane_briefing_unavailable', { symbol: item.symbol, lane: `${item.minutes}m`, bar: item.bar.t, reason: item.briefError });
    let decision;
    if (!cfg.account) decision = { run: false, reason: why };
    else {
      try {
        const [net, working] = await exposure(item);
        decision = net !== 0 || working > 0 ? { run: true, reason: `manage only: ${why}` } : { run: false, reason: why };
      } catch (err) {
        decision = { run: true, reason: `manage only: account check failed (${err.message}); ${why}` };
      }
    }
    logScan(item, [], decision);
    return decision;
  }

  async function wanted(item, manageOnly) {
    // Each lane's own trigger (one lane: the config's).
    // A lane that lists a retired strategy (lanes.js retireLanes) enters nothing: no cycle per bar, only to manage.
    if ((multi ? lanes[item.lane].trigger : cfg.trigger) === 'bar' && !manageOnly && !lanes[item.lane].retired) {
      // Every bar runs a cycle with what fired; a policy still records its verdicts for the gate.
      const results = scanItem(item);
      if (item.briefError) return laneBlocked(item);
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
        // Setup-focused practice: only a selected bar runs its cycle (what fired is recorded either way).
        const decision = await practiced(item, { run: true, reason: 'bar closed' });
        // The decision log gets every bar: what fired, so live can be reconciled with the scan (reconcile.js).
        logScan(item, screened, decision);
        return decision;
      }
      return practiced(item, { run: true, reason: 'bar closed' });
    }
    // A retired lane with no account to see positions: a manage cycle every bar, as its bar trigger ran before (the
    // scan is empty, so it offers nothing to enter and the gate refuses any entry on it).
    if (lanes[item.lane].retired && !cfg.account && !manageOnly) {
      const results = scanItem(item);
      const decision = { run: true, reason: 'manage only: this lane lists a retired strategy and enters nothing; no account is configured to see positions, so every bar' };
      if (results) logScan(item, results, decision);
      return decision;
    }
    if (!cfg.account) return { run: false, reason: 'cap reached and no account configured to check positions' };
    let net;
    let working;
    try {
      [net, working] = await exposure(item);
    } catch (err) {
      // Can't see the account: run the cycle rather than risk leaving a position unmanaged.
      scanItem(item);
      if (item.briefError) return laneBlocked(item);
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
    if (item.briefError) return laneBlocked(item);
    // A failed scan: run the cycle (it says so) when there is something to manage, else wait for the next bar.
    if (!results) return net !== 0 || working > 0 ? { run: true, reason: 'manage (the scan failed)' } : { run: false, reason: 'the scan failed' };
    const screened = prop && net === 0 && working === 0 ? screenItem(item) : results;
    if (!(prop && net === 0 && working === 0)) item.verdicts = [];
    const decision = await practiced(item, signalDecision(screened, net, working, { paper: cfg.paper }), net !== 0 || working > 0);
    logScan(item, screened, decision);
    return decision;
  }

  /**
   * Setup-focused practice (practiceSelect, learning/setup-moments.js): a cycle the trigger asked for runs only on a
   * selected bar (a setup moment, the quiet sample, or something open: every bar while it is). The account is read
   * for what is open (`open`, when the caller already read it); an unreadable account or a failed selector runs the
   * bar. Each bar's choice goes to the event log (practice_<why>), which the replay report counts.
   */
  async function practiced(item, decision, open = null) {
    if (!practiceSelect || !decision.run) return decision;
    let isOpen = open;
    if (isOpen === null) {
      try {
        const [net, working] = await exposure(item);
        isOpen = net !== 0 || working > 0;
      } catch (err) {
        emit('practice_manage', { symbol: item.symbol, bar: item.bar.t, run: true, reason: `account check failed (${err.message})` });
        return { ...decision, reason: `${decision.reason}; practice: account check failed (${err.message}), the bar runs` };
      }
    }
    let s;
    try {
      s = practiceSelect(item, isOpen);
    } catch (err) {
      log(`${item.symbol}: practice selector failed (${err.message}); the bar runs`, 'error');
      s = { run: true, why: 'unavailable', reason: `practice: selector failed (${err.message}); the bar runs` };
    }
    emit(`practice_${s.why}`, { symbol: item.symbol, bar: item.bar.t, run: s.run, reason: s.reason });
    return s.run ? { ...decision, reason: `${decision.reason}; ${s.reason}` } : { run: false, reason: s.reason };
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
        // Each working entry's bracket from the runner's record (attaches on the fill): a fact, not a model claim.
        entryLines: state ? workingEntryLines(state.orders, entryOrders(), now) : [],
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
      if (inSession(cfg, new Date(t))) return Math.max(0, t + delayMs - now.getTime() - RUN.wakeEarlyMs);
    }
    return null;
  }

  /** Time from `now` to the next bar's poll, less a margin for the run's own start: 0 when one is due or unknown. */
  function msToNextBar(now) {
    const due = nextBarDueAt();
    return due === null ? 0 : Math.max(0, due - now.getTime() - RUN.wakeEarlyMs);
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
    let d = decide(cfg, state, now, { killSwitch: isKillSwitchOn(), exitsOnly });
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
        d = decide(cfg, state, now, { killSwitch: isKillSwitchOn(), exitsOnly });
        state = d.state;
      } else if (Date.parse(state.premarketRetryAt) > now.getTime()) {
        // Waiting for its retry never holds up risk-reducing work: the pass goes on as if premarket were done
        // (trailing, leftover orders, housekeeping), and still starts no cycle (it isn't done: below, decide says so).
        const waiting = decide(cfg, { ...state, premarketDone: true }, now, { killSwitch: isKillSwitchOn(), exitsOnly });
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
        if (d.action === 'premarket' && decide(cfg, state, at, { killSwitch: isKillSwitchOn(), exitsOnly }).action === 'eod') break;
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
      if (i > 0 && decide(cfg, state, clock.now(), { killSwitch: isKillSwitchOn(), exitsOnly }).action === 'eod') return 0;
      const item = await pollSymbol(i, now);
      if (item) ready.push(item);
    }
    // Several lane clocks: saved at the end of the pass, and only when no cycle of it failed, so a
    // replay's retry of a failed cycle (a new process) and a live restart find the bars still new, as with one lane.
    let cycleFailed = false;
    if (polled) {
      // A lane of a symbol whose bar closed, due at that same close but not published yet: the cycle waits for it
      // (a few seconds at most), so one close is one cycle.
      const wait = coalesceWait(ready, clock.now());
      if (wait !== null) { held = ready; return wait; }
    }
    // A 1m lane's bars that closed this pass (a data lane's too), before any briefing: a 5m candle ending at this close
    // is complete only with its last 1m bar, so the 1m bars of the same close count (replay and live: the same pass,
    // the same order).
    for (const x of ready) {
      if ((!x.stale || x.data) && x.minutes === 1) { try { recordFineBars(x); } catch (_err) { /* recording never stops the pass */ } }
    }
    // A data lane's bars end there (lanes.js): no housekeeping, no session-record point, no scan, no cycle.
    const traded = ready.filter(x => !x.data);
    if (traded.length) {
      // Trailing stops and leftover orders first: they only ever reduce risk. Once per symbol (its first lane's bar
      // when that closed: the trail counts the first lane's bars), never twice on one account read's orders.
      const noCycles = d.action === 'housekeep';
      const keep = traded.filter(x => !traded.some(y => y !== x && y.symbol === x.symbol && (y.lane < x.lane || (y.lane === x.lane && traded.indexOf(y) < traded.indexOf(x)))));
      for (const item of keep) await housekeeping(item, { noCycles, trail: item.lane === 0 });
      // Then the factual reviews of the entries that ended (never before an exit, a stop or a flatten).
      await factualReviews();
      // Then the session record hears each closed bar (its values taken, its bars archived): after the risk work.
      for (const x of traded) {
        try { barClosed(x.symbol, { bar: x.bar.t, stale: Boolean(x.stale), action: d.action, contractId: x.contractId, bars: x.bars, ...(multi ? { minutes: x.minutes } : {}) }); } catch (_err) { /* recording never stops the pass */ }
      }
      if (state.trails) saveState(state);
      // The account balance for the gate's prop-challenge checks, before any cycle. `snapshotAt`: this pass's
      // snapshot time, so the decision history reuses only a fills read made by this pass's snapshot.
      let snapshotAt = null;
      if (prop && cfg.account && !cfg.paper) {
        try {
          snapshotAt = clock.now().getTime();
          await prop.snapshot(new Date(snapshotAt));
        } catch (err) {
          log(`account balance unavailable (${err.message}); the gate refuses prop entries once the snapshot is 10 min old`, 'error');
        }
      }
      // Re-check: a symbol's poll may have taken a while, the kill switch may be on now.
      const again = decide(cfg, state, clock.now(), { killSwitch: isKillSwitchOn(), exitsOnly });
      state = again.state;
      if (again.action === 'trade' || again.action === 'manage') {
        let manageOnly = again.action === 'manage';
        const run = [];
        const due = traded.filter(x => !x.stale);
        // The first lane's bars are decided (and briefed) first: a lane's briefing takes its session levels from the
        // runner's briefing of the bar holding at its close, which a carried lane item listed first would miss.
        const decided = new Map();
        for (const item of [...due].sort((a, b) => a.lane - b.lane)) {
          decided.set(item, await wanted(item, manageOnly));
          // A bar not scanned (manage only, or no cycle) still gets its briefing: the file is always this bar's.
          briefItem(item, null, 'not scanned this bar');
        }
        for (const item of due) {
          const w = decided.get(item);
          const tag = `${item.symbol}${multi ? ` ${item.minutes}m` : ''}`;
          if (w.run) { run.push(item); log(`${tag} bar ${item.bar.t} close ${item.bar.c}: cycle (${w.reason})`); }
          else log(`${tag} bar ${item.bar.t} close ${item.bar.c}: no cycle (${w.reason})`);
        }
        // Several lanes: two policies' entry verdicts in one cycle are settled by priority (lane-cycle.js).
        const skipped = multi && run.length ? settlePolicies(run) : [];
        // A skip the gate can't read: no entry this cycle (fail closed), only managing what is open.
        if (skipped.some(k => k.unrecorded)) manageOnly = true;
        // A lane's bar without its briefing allows no entry on it (its own record says nothing fired); a cycle of only
        // such bars is manage-only. Other lanes and symbols in a cycle with one trade as usual.
        if (run.length && run.every(x => x.entryBlocked)) manageOnly = true;
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
              // Its read facts (trade-read.js) from its contract's bars: the pullback-vs-reversal read of an open trade.
              // The trail the runner holds for the trade (state.trails: its exit plan's afterTarget), read as the runner reads it.
              const read = t => {
                const x = item({ contractId: t.contractId });
                const held = x ? (state.trails || {})[x.contractId] : null;
                const exit = held && held.plan ? held.plan.afterTarget || null : null;
                return x ? tradeReadText(t, { bars: x.bars, base: x.minutes || cfg.timeframe, tickSize: tickOf({ contractId: t.contractId }), exit }) : null;
              };
              acct = { ...acct, openTrades: tradeObjs.map(t => describeOpenTrade(t, { tickSize: tickOf({ contractId: t.contractId }), et: etTime, history: history(t), read: read(t) })) };
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
            symbol: x.symbol, verdicts: x.verdicts, scan: withRecords(x), notEntries: x.notEntries || [], entryBlocked: x.entryBlocked || null,
            bar: { ...x.bar, plan: entries && !repeat(x) ? attempt(`${x.symbol} premarket plan`, () => premarketPlan(x.symbol, journal, cycleNow), null) : null },
            ...(multi ? { minutes: x.minutes, repeat: repeat(x) } : {}),
            // The closed bars, for what happened since each recent decision (decision-history.js; never in the prompt).
            bars: x.bars,
          }));
          const symbolsOf = list => (multi ? [...new Set(list.map(x => x.symbol))] : list.map(x => x.symbol));
          for (const x of run.filter(y => y.entryBlocked)) unavailable.push(`${x.symbol} ${x.minutes}m: ${x.entryBlocked} (no ${x.symbol} entry on ${x.minutes}m bars this cycle; its other lanes and the other symbols as usual)`);
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
          const fromCache = reportCache && !manageOnly && !cfg.paper ? attempt('the report cache: every role runs this cycle', () => reportCache.serve({ symbols: cacheSymbols, account: acct, now: cycleNow, laneBars: multi ? laneBarsOf(run) : {} }), null) : null;
          // Several lanes: an analyst's report is served only until its parts' time (`until`, the next 15m close): a
          // first lane slower than that, or a bar of it that didn't arrive, never hands a report past it.
          const live = r => !r.until || Date.parse(r.until) > cycleNow.getTime();
          const cached = multi && fromCache ? { ...fromCache, roles: fromCache.reports.filter(live).map(r => r.role), reports: fromCache.reports.filter(live) } : fromCache;
          // The desk, run by the runner (docs/TOOL-CALLS-AND-ORCHESTRATION.md): the roles the cache didn't serve, before the
          // head trader decides; their reports join the cached ones in the prompt, and the gate counts them from the runner's role
          // record (runner-roles.js, FTH_CYCLE_ROLES), with each run's times, report and lookups.
          // A role whose run didn't count is missing: the head trader may launch it, the gate refuses an entry without it.
          // One-symbol cycles only (a desk report's lookups are credited under one symbol's facts key): with several, the
          // head trader launches its desk, as before.
          // Started flat with no working orders (the account read: unknown is not flat), one symbol and lane, a full trade
          // cycle with the runner's entry wired: a cycle whose entry the runner may run (entryCycle below).
          const startedFlat = Boolean(acct && !acct.error && Array.isArray(acct.positions) && !acct.positions.length && Array.isArray(acct.orders) && !acct.orders.length);
          // Started managing: the account read shows a position or a working order open (no account or an unread one is
          // neither flat nor this: such a cycle runs as before). Only where this machine opts in (the runner config's
          // deskOnManagedCycles, off by default: such a cycle runs as before).
          const startedManaging = cfg.deskOnManagedCycles === true && Boolean(acct && !acct.error && Array.isArray(acct.positions) && Array.isArray(acct.orders) && (acct.positions.length || acct.orders.length));
          const entryPossible = Boolean(entryWorkflow) && again.action === 'trade' && !manageOnly && !cfg.paper && cacheSymbols.length === 1 && run.length === 1 && startedFlat;
          // A harness whose transcript doesn't time the head trader's own launches (desk.timed false: Claude Code's
          // stream-json) can't order a phase 2 it launched itself against the runner's record (the gate refuses such an
          // entry, roles-ran.js), so there the runner runs its desk in a cycle whose entry it may run, and in a managed
          // cycle (startedManaging), whose job is managing them: the desk is complete from the runner's record, and the gate
          // refuses any entry in the cycle (managedCycle below).
          const deskHere = Boolean(desk) && (desk.timed !== false || entryPossible || startedManaging);
          const deskRoles = deskHere && again.action === 'trade' && !manageOnly && !cfg.paper && cacheSymbols.length === 1 ? expectedRoles({ action: 'trade', cycle: cfg.cycle, cachedRoles: cached ? cached.roles : [] }) : [];
          // A managed cycle (startedManaging: this machine opted in, and the cycle started with a position or working order
          // open) on an untimed harness, where the runner's desk applies: manage only, whatever the desk did. The gate
          // refuses every entry in it (FTH_CYCLE_MANAGE, order-gate.js managed-cycle); exits, stop moves, closes and cancels
          // are risk-reducing and go before that check, as always.
          const managedCycle = startedManaging && Boolean(desk) && desk.timed === false && again.action === 'trade' && !manageOnly && !cfg.paper && cacheSymbols.length === 1;
          // This machine's opt-in (cycleDataInPrompt, Claude Code only): the cycle's store of reads (cycle-data.js), filled by
          // the runner once a cycle, the desk's reads first; the desk's roles and the head trader take their reads from it.
          const cycleStore = CD.on(cfg) ? CD.createStore({ root, broker: client, now: () => clock.now(), paper: Boolean(cfg.paper) }) : null;
          let deskRun = null;
          let deskMs = 0;
          if (deskRoles.length) {
            // The desk's time is the cycle's: it runs within the cycle's budget, leaving the head trader its minimum,
            // and what it took comes off the head trader's limit and counts in the cycle's timing (cycle-timing.js).
            const deskStart = clock.now().getTime();
            const minHeadMs = TUN.cycle.timeoutMinMinutes * 60000;
            const stop = new AbortController();
            // A managed cycle's desk gets at most config/runner.json desk.managedBudgetShare of the cycle (half): the head
            // trader's own management is never starved (a desk cut short is incomplete: the head trader runs its desk, and
            // the gate still refuses an entry).
            const deskBudgetMs = managedCycle ? Math.min(Math.max(0, timeoutMs - minHeadMs), Math.floor(timeoutMs * TUN.desk.managedBudgetShare)) : Math.max(0, timeoutMs - minHeadMs);
            const timer = setTimeout(() => stop.abort(), deskBudgetMs);
            // The roles' runs get the cycle's own context (its bars, lanes and start), as the head trader's does.
            const deskContext = {
              action: 'trade', manageOnly: false, cachedRoles: [],
              symbols: items.map(x => ({ symbol: x.symbol, bar: { t: x.bar.t, contractId: x.bar.contractId, file: x.bar.file }, ...(multi ? { lane: `${x.minutes}m` } : {}) })),
              ...(multi ? { cycleBars: Object.fromEntries(cacheSymbols.map(s => [s.symbol, s.bar])) } : {}),
              ...(analystFrames.length ? { cycleAt: cycleNow.toISOString(), frames: analystFrames.map(f => ({ role: f.role, timeframe: tfLabel(f.minutes) })) } : {}),
            };
            try {
              deskRun = await desk.run({ symbols: cacheSymbols, roles: deskRoles, now: cycleNow, laneBars: multi ? laneBarsOf(run) : {}, at: cycleNow.toISOString(), bars: (items.find(x => x.minutes === cfg.timeframe) || items[0] || { bar: {} }).bar.file || null, context: deskContext, signal: stop.signal, budgetMs: deskBudgetMs, ...(cycleStore ? { store: cycleStore } : {}) });
            } catch (err) {
              failed('the desk: the head trader launches it', err);
            } finally {
              clearTimeout(timer);
            }
            deskMs = Math.max(0, clock.now().getTime() - deskStart);
            // Never past the cycle's own limit (limitFor: the end of day's cap): what the desk took, else the head's minimum.
            timeoutMs = Math.max(timeoutMs - deskMs, Math.min(minHeadMs, timeoutMs));
          }
          // The desk's reports the runner's role record holds (runner-roles.js): the gate credits those from it (FTH_CYCLE_ROLES),
          // never as cached; a report it couldn't record isn't given (the head trader may launch that role).
          const recordedReports = deskRun ? deskRun.reports.filter(r => (deskRun.recorded || []).includes(r.role)) : [];
          // The runner runs the entry (runner-entry.js, workflows/entry) when the head trader decides a trade in this
          // cycle: entryPossible (above) with the runner's desk wired, and its desk complete in the runner's record
          // or the report cache (the trade-executor is a session of its own: the gate sees the head trader's own launches
          // only in the head trader's transcript, so a role it launched itself would be missing there). Otherwise the
          // head trader runs phase 2 and the trade-executor, as before.
          const deskDone = expectedRoles({ action: 'trade', cycle: cfg.cycle, cachedRoles: [...(cached ? cached.roles : []), ...recordedReports.map(r => r.role)] }).length === 0;
          const entryCycle = entryPossible && Boolean(desk) && deskDone;
          // Its desk complete from the runner's record or the report cache: kept, record and reports, the desk check
          // complete, and the prompt says the cycle manages, with no roster (autotrader.js MANAGED_DESK_TEXT). Not complete:
          // the head trader runs its desk, as before (dropDesk below), and still enters nothing (MANAGED_NO_ENTRY_TEXT).
          const managedDesk = managedCycle && !entryCycle && deskDone;
          // An untimed harness's desk that didn't complete (no entry cycle, no managed desk): dropped, record and reports, so
          // the head trader runs its whole desk in its session, as before (a record beside its own untimed launches would
          // refuse its entry).
          const dropDesk = Boolean(deskRun) && desk.timed === false && !entryCycle && !managedDesk;
          if (dropDesk) {
            log(`the desk: ${deskRun.missing.map(m => m.role).join(', ') || 'a role'} missing: the head trader runs its desk this cycle`, 'error');
            if (deskRun.rolesFile) attempt('removing the desk\'s role record', () => require('./trading/runner-roles').removeRoleRuns(deskRun.rolesFile), null);
          }
          const deskReports = dropDesk ? [] : recordedReports;
          // Its runs go in the cycle's role record: the desk's, or a fresh one when the cache served the whole desk.
          let rolesFile = deskRun && deskRun.rolesFile && !dropDesk ? deskRun.rolesFile : null;
          if (entryCycle && !rolesFile) rolesFile = attempt('the role record for the runner\'s entry', () => entryWorkflow.recordFile(), null);
          const served = deskReports.length
            ? { roles: [...(cached ? cached.roles : []), ...deskReports.map(r => r.role)], reports: [...(cached ? cached.reports : []), ...deskReports] }
            : cached;
          // The entered decisions with their real positions (decision-history.js withPositions): an open trade's fill
          // and R; a position gone since its last cycle, closed (a failed account read closes nothing).
          const positionsKnown = Boolean(acct && !acct.error && !acct.openTradesError && Array.isArray(acct.positions));
          // Their closing fills (search_trades), read once a cycle and only while a decision of today's is unresolved:
          // the prop hooks' read of this pass when it covers them, else the adapter's. Unread: their R stays unknown.
          const fills = positionsKnown ? await historyFills(fillsNeededSince((state && state.history) || [], cycleNow), snapshotAt) : null;
          state = { ...state, history: attempt('your entered decisions\' positions', () => withPositions((state && state.history) || [], { trades: tradeObjs, known: positionsKnown, now: cycleNow, exits: exitRecords(state.runnerExits, state.runnerCloses), fills }), (state && state.history) || []) };
          // Several lanes: the decisions of the lanes that closed (and the first lane's and each open trade's lane's
          // last few), never a fast lane's flood; one lane: the last 10, as before.
          const firstLane = `${lanes[0].timeframe}m`;
          const openLanes = multi ? [...new Set(tradeObjs.map(t => { try { const s = t.setup ? strategyNamed(t.setup) : null; return s && s.timeframe ? s.timeframe : null; } catch (_err) { return null; } }).filter(Boolean))] : [];
          // A fresh combine attempt's prompt shows only its own decisions (the history itself stays whole).
          const ownHistory = historySince((state && state.history) || [], attempt('the attempt\'s start', () => historyFrom(), null));
          const shownHistory = multi
            ? laneHistory(ownHistory, { closed: closedLanes.map(l => `${l.timeframe}m`), first: firstLane, open: openLanes })
            : ownHistory;
          // The recent decisions as the prompt shows them (its own call builds the same lines), for the session record.
          const historyShown = attempt('your recent decisions', () => historyShownLines(shownHistory, multi, marketOf(items, cfg.timeframe)), []);
          const runsEntry = entryCycle && Boolean(rolesFile);
          const prompt = prompts(cfg, cycleNow, root).trade(items, {
            manageOnly, recovered: recover, state: acct, history: shownHistory,
            lessons: lessonLines, trades: tradeLines, tradesSummary: summary, news: newsLine, unavailable,
            cyclesLeft, entry: runsEntry, managedDesk, managedCycle,
            manageAlso, journalRead: entries !== null, cached: served, unreviewed: unreviewedText,
            ...(multi ? { lanes: lanesLine(closedLanes) } : {}),
            ...(analystFrames.length ? { frames: analystFrames.map(f => ({ role: f.role, timeframe: tfLabel(f.minutes) })) } : {}),
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
            // The roles served from the report cache (FTH_CYCLE_CACHED), and those the runner ran itself this cycle, with its
            // record of them (FTH_CYCLE_ROLES): the gate credits each from its own source.
            action: again.action, cachedRoles: cached ? cached.roles : [],
            // skillsMissing: the desk roles that ran without some of their role-skills (role-skills-record.js), detection only.
            ...(deskRun ? { desk: { results: deskRun.results, missing: deskRun.missing, ms: deskMs, ...withSkillsMissing(deskRun.results) }, runnerRoles: deskReports.map(r => r.role) } : {}),
            ...(rolesFile ? { rolesFile } : {}),
            // The runner runs the entry this cycle (FTH_CYCLE_ENTRY: the entry-route rule; the prompt says the route).
            ...(runsEntry ? { entry: true } : {}),
            // A managed cycle (managedCycle: this machine's opt-in only): FTH_CYCLE_MANAGE, the gate refuses every entry.
            ...(managedCycle ? { manage: true } : {}),
            // Index mode: each cached report's own lookups and their facts key, which the gate counts for that role under that
            // key only (FTH_CYCLE_CACHED_LOOKUPS).
            cachedLookups: cached ? Object.fromEntries(cached.reports.filter(x => Array.isArray(x.lookups) && x.lookups.length && x.lookupsKey).map(x => [x.role, { skills: x.lookups, key: x.lookupsKey }])) : {},
            // Several lanes: the lanes that closed, and the setups skipped for a higher-priority policy (labels see them).
            ...(multi ? { lanes: closedLanes.map(l => `${l.timeframe}m`), skipped } : {}),
            // Several lanes: the bar each symbol's bar briefing is on (the first lane's), which the cycle's roles read
            // as this cycle's (bar_briefing), whichever lane's bar closed.
            ...(multi ? { cycleBars: Object.fromEntries(cacheSymbols.map(s => [s.symbol, s.bar])) } : {}),
            // The analysts on their own timeframe, and the cycle's start: each one's briefing is the bar holding then.
            ...(analystFrames.length ? { cycleAt: cycleNow.toISOString(), frames: analystFrames.map(f => ({ role: f.role, timeframe: tfLabel(f.minutes) })) } : {}),
          };
          recover = false;
          if (acct) emit('account', accountEvent(acct));
          const stopWatch = watchComposed(run);
          // A cycle that may enter: the latest price kept fresh for the gate's [late-entry] on every harness (watchPrice).
          const stopPrices = again.action === 'trade' && !manageOnly ? watchPrice(run) : () => {};
          // The runner's entry after the head trader's run (cycle-run.js runs it inside the cycle's time, before the cycle
          // log): phase 2 and the trade-executor on the decision's compose record (runner-entry.js).
          const entryHook = runsEntry ? ({ result, output, env: headEnv, startedWall, budgetMs }) => entryWorkflow.run({
            result, output, headEnv, startedWall, symbol: cacheSymbols[0].symbol, contractId: cacheSymbols[0].contractId || run[0].contractId || null, bar: cacheSymbols[0].bar,
            bars: run[0].bar.file || null, at: cycleNow.toISOString(), now: cycleNow, laneBars: multi ? laneBarsOf(run) : {},
            accountId: Number.isInteger(Number(cfg.account)) && Number(cfg.account) >= 1 ? Number(cfg.account) : null,
            context, rolesFile, reports: served ? served.reports.map(x => ({ role: x.role, text: x.text })) : [], budgetMs,
          }) : null;
          // This machine's opt-in (the runner config's cycleDataInPrompt, Claude Code only): the head trader's first reads,
          // made by the runner with its run's own environment just before its run (cycle-run.js), in its prompt (cycle-data.js).
          const precollect = CD.on(cfg) ? runEnv => CD.collect({
            symbols: [...new Set(items.map(x => x.symbol))], accountId: Number.isInteger(Number(cfg.account)) && Number(cfg.account) >= 1 ? Number(cfg.account) : null,
            env: runEnv, root, broker: client, now: () => clock.now(), paper: Boolean(cfg.paper), store: cycleStore,
          }) : null;
          let r;
          let ranRuns = [];
          try {
            r = await timedCycle(again.action, prompt, { timeoutMs, context, ...(entryHook ? { entry: entryHook } : {}), ...(precollect ? { precollect } : {}) }, { symbols: run.map(x => x.symbol), bars: run.map(x => x.bar.t), manageOnly, cached: served ? served.roles : [], ...(multi ? { lanes: run.map(x => `${x.minutes}m`) } : {}), ...(historyShown.length ? { history: historyShown } : {}) });
          } finally {
            stopWatch();
            stopPrices();
            // The cycle's role record ends with it (the cycle log has read it: cycle-run.js); its runs, read first, go to
            // the report cache and the decision history (a phase 2 or a trade-executor the runner ran).
            if (rolesFile) {
              const RR = require('./trading/runner-roles');
              ranRuns = RR.readRoleRuns(rolesFile);
              RR.removeRoleRuns(rolesFile);
            }
          }
          // The reports this cycle's roles returned, for the next cycles while what they rest on holds.
          // Only a trade cycle's roles (a manage-only or paper cycle's risk-manager isn't phase 1), from the stdout the gate reads.
          if (reportCache && r && !manageOnly && !cfg.paper) attempt('recording the report cache', () => reportCache.record({ symbols: cacheSymbols, account: acct, now: cycleNow, output: r.transcript || '', served: cached ? cached.roles : [], fresh: deskReports, runs: ranRuns, lookups: Array.isArray(r.lookups) ? r.lookups : [], laneBars: multi ? laneBarsOf(run) : {} }), null);
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
            entry = decisionEntry({ ...base, items: composed ? (byOrder => run.map(x => ({ ...x, composed: composed.forItem(x), composedOrders: byOrder })))(composed.byOrder()) : run, entries: placed, journalFailed, output: (r && r.transcript) || '', cycle: cfg.cycle, cached: served ? served.roles : [], runs: ranRuns, positions: acct && !acct.error && Array.isArray(acct.positions) ? acct.positions : null });
          } catch (err) {
            log(`history: the decision's facts unavailable (${err.message}); its result line only`, 'error');
          }
          const history = [...((state && state.history) || []), entry];
          state = { ...state, history: multi ? boundHistory(history, firstLane) : history.slice(-10) };
          saveState(state);
          record(r.ok, r.timedOut, cycleNow);
          if (!r || !r.ok || r.timedOut) cycleFailed = true;
        }
      }
    }
    if (polled && !cycleFailed) saveLaneClocks();
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
