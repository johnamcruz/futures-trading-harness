'use strict';

/**
 * The autonomous runner's loop body, with every side effect injected so it
 * can be driven by a simulated clock in tests. scripts/autotrader.js wires it
 * to the real clock, ProjectX REST, the filesystem, and the harness CLI.
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
 *   6. Prop challenges (rl/live-runner.js), for strategies with an account:
 *      the balance is snapshotted every bar and recorded at end of day; a
 *      policy screens each setup (a skip starts no cycle; the verdict is
 *      what the gate allows) and, past the ratchet, may close the trade.
 */

const { decide, recordRun, prompts, signalDecision, dayKey, endOfDayAt } = require('./autotrader');
const { barStep, sleepMs } = require('./bar-clock');
const { contractRoot } = require('./trading/journal');
const { familyRoot } = require('./trading/contracts');

// Micros and minis of one index share bars: a position or order in either
// belongs to the symbol polled (MNQ bars manage an NQ trade too).
const famOf = contractId => familyRoot(contractRoot(contractId));
const { trailStep } = require('./trading/trail');
const { tradingDayStart, inMarketHours, sessionMinuteOf, MARKET_CLOSE_MIN, MARKET_TZ } = require('./trading/clock');
const { exitPlan } = require('./trading/strategies');

const IDLE_MS = 5000;
const RESYNCS_BEFORE_REROLL = 3;
const MAX_POLL_MS = 10000;
const LOOKUP_RETRY_MS = 30000;
const MAX_RETRY_MS = 60000;
const FILL_GRACE_MS = 30000;
// The account read for a run's prompt never holds a run up longer than this.
const ACCOUNT_READ_MS = 5000;
// A closing balance that couldn't be recorded is retried this often, this many times.
const CLOSE_RETRY_MS = 60000;
const CLOSE_TRIES = 5;
const STOP_ORDER_TYPES = new Set([3, 4, 5]);

function createRunner(deps) {
  const {
    cfg, root, client, clock, runCycle, isKillSwitchOn, createKillSwitch,
    loadState, saveState, writeBars, scanFor, log = () => {}, entryOrders = () => [], strategyNamed = () => null,
    flow = null, // order-flow recorder: annotate(contractId, bars, minutes) adds real buy/sell volume
    prop = null, // prop-challenge hooks (rl/live-runner.js createPropHooks)
    accountReadMs = ACCOUNT_READ_MS,
  } = deps;
  const entryOrderIds = () => new Set(entryOrders().map(e => Number(e.orderId)));
  let state = loadState();
  let errors = 0;
  let recover = false; // the last trade cycle was stopped mid-run
  let pendingClose = null; // { day, tries, lastTry }: a closing balance still to record
  const syms = cfg.symbols.map(symbol => ({ symbol, contractId: null, contractDay: null, clock: null, lastPollAt: 0, misses: 0, resyncs: 0 }));
  const minutes = cfg.timeframe;
  const delayMs = cfg.barDelaySeconds * 1000;
  const timeoutMs = cfg.barTimeoutSeconds * 1000;

  function record(ok, timedOut, now) {
    errors = ok ? 0 : errors + 1;
    if (errors >= cfg.maxConsecutiveErrors && !isKillSwitchOn()) {
      createKillSwitch(`created by autotrader after ${errors} failed runs at ${now.toISOString()}`);
      log(`${errors} failed runs in a row: kill switch created. Remove it to resume.`, 'error');
    }
    if (timedOut) recover = true;
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
    if (c.id !== sym.contractId) {
      log(`${sym.symbol}: active contract ${sym.contractId ? `${sym.contractId} -> ` : ''}${c.id}`);
      return { ...sym, contractId: c.id, tickSize: c.tickSize, contractDay: day, clock: null, lastPollAt: 0, misses: 0, resyncs: 0, lookupFailedAt: 0 };
    }
    return { ...sym, tickSize: c.tickSize || sym.tickSize, contractDay: day, resyncs: 0, lookupFailedAt: 0 };
  }

  async function pollSymbol(i, now) {
    let sym = syms[i];
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
      let bars = step.bars;
      if (flow) {
        try {
          bars = flow.annotate(sym.contractId, step.bars, minutes);
        } catch (err) {
          log(`${sym.symbol}: order flow unavailable this bar (${err.message})`, 'error');
        }
      }
      let file = null;
      try {
        file = writeBars(sym, bars);
      } catch (err) {
        // No bars file means no cycle, but housekeeping (stops, flattening)
        // must still see this bar. Counted toward the kill switch.
        log(`${sym.symbol}: could not write the bars file (${err.message}); housekeeping only`, 'error');
        record(false, false, now);
      }
      return { symbol: sym.symbol, contractId: sym.contractId, tickSize: sym.tickSize, bars, stale: stale || file === null, bar: { t: step.bar.t, c: step.bar.c, file, contractId: sym.contractId } };
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
    if (positions.some(p => famOf(p.contractId) === root && Number(p.size || 0) > 0)) return;
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
    const sameMonth = x => x.contractId === item.contractId || (famOf(x.contractId) === fam && String(x.contractId).split('.').pop() === String(item.contractId).split('.').pop());
    const p = positions.find(x => sameMonth(x) && Number(x.size || 0) > 0);
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
      const ok = plan && plan.trailActivateR !== null && tick > 0 && risk >= 4 * tick - 1e-9;
      t = ok
        ? { key, setup: rec.setup, sign, entry, risk, stop: entry - sign * risk, peakR: 0, troughR: 0, barsHeld: 0, plan, since: fillAt, lastBarT: null }
        : { key, skip: true };
      save(t);
      if (ok) log(`${item.symbol}: trailing ${rec.setup} ${sign > 0 ? 'long' : 'short'} from ${entry}, 1R = ${risk} (activate ${plan.trailActivateR}R, give back ${plan.trailGivebackR}R)`);
      else if (plan && plan.trailActivateR !== null) log(`${item.symbol}: ${rec.setup} position not trailed: no usable initial stop (1R ${risk}, needs 4+ ticks)`, 'error');
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
      await client.closePosition(cfg.account, cid);
      save({ ...t, peakR, troughR, barsHeld, lastBarT });
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
    // Past the ratchet, a strategy's policy may bank the trade (as in training).
    if (prop && t.plan.trailActivateR !== null && peakR >= t.plan.trailActivateR) {
      let action = null;
      try {
        action = prop.position({ strategy: strategyNamed(t.setup), contractId: cid, bars: item.bars, pos: { sign, entry: t.entry, risk: t.risk, size: Number(p.size), peakR, troughR, barsHeld } });
      } catch (err) {
        log(`${item.symbol}: policy decision failed (${err.message}); the trail manages the trade`, 'error');
      }
      if (action === 'close') {
        await closeOut(`policy: close past the ratchet at ${peakR.toFixed(2)}R`);
        return;
      }
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
    const open = positions.filter(p => famOf(p.contractId) === root && Number(p.size || 0) > 0);
    const closed = [];
    for (const p of open) {
      const sign = p.type === 1 ? 1 : -1;
      const covered = orders
        .filter(o => o.contractId === p.contractId && STOP_ORDER_TYPES.has(Number(o.type)) && (Number(o.side) === 0 ? 1 : -1) === -sign)
        .reduce((a, o) => a + Number(o.size || 0), 0);
      if (covered === Number(p.size)) continue;
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

  async function housekeeping(item, { noCycles = false } = {}) {
    if (!cfg.account || cfg.paper || typeof client.accountState !== 'function') return;
    try {
      const account = await client.accountState(cfg.account);
      await cleanupFlat(item, account, { noCycles });
      // No cycle will come to protect a position whose stops don't cover it
      // exactly (none, too small, or big enough to flip it): flatten it.
      if (noCycles && await flattenUncovered(item, account)) return;
      await trailPosition(item, account);
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
    const mine = positions.filter(p => famOf(p.contractId) === fam && Number(p.size || 0) > 0);
    const net = mine.reduce((n, p) => n + (p.type === 1 ? 1 : p.type === 2 ? -1 : 0) * Number(p.size || 0), 0);
    // A long in one month and a short in another still needs managing.
    return [net || mine.reduce((n, p) => n + Number(p.size || 0), 0), orders.filter(o => famOf(o.contractId) === fam).length];
  }

  async function wanted(item, manageOnly) {
    if (cfg.trigger === 'bar' && !manageOnly) {
      // Every bar runs a cycle; a policy still records its verdicts for the gate.
      if (prop && cfg.account) {
        try {
          const [net, working] = await exposure(item);
          if (net === 0 && working === 0) {
            const screened = prop.screen(scanFor(item.symbol, item.bars), { symbol: item.symbol, contractId: item.contractId, bars: item.bars, now: clock.now() });
            item.verdicts = screened.filter(r => r.verdict).map(r => r.verdict);
          }
        } catch (err) {
          log(`${item.symbol}: policy screen failed (${err.message}); the gate refuses its entries`, 'error');
        }
      }
      return { run: true, reason: 'bar closed' };
    }
    if (!cfg.account) return { run: false, reason: 'cap reached and no account configured to check positions' };
    try {
      const [net, working] = await exposure(item);
      if (manageOnly) {
        return net !== 0 || working > 0 ? { run: true, reason: 'manage only' } : { run: false, reason: 'cap reached and flat' };
      }
      const results = scanFor(item.symbol, item.bars);
      // A policy screens its strategy's setups (only when flat: a verdict is for a new entry).
      const screened = prop && net === 0 && working === 0
        ? prop.screen(results, { symbol: item.symbol, contractId: item.contractId, bars: item.bars, now: clock.now() })
        : results;
      item.verdicts = screened.filter(r => r.verdict).map(r => r.verdict);
      return signalDecision(screened, net, working, { paper: cfg.paper });
    } catch (err) {
      // Can't see the account: run the cycle rather than risk leaving a position unmanaged.
      return { run: true, reason: `account check failed (${err.message})` };
    }
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
      try {
        record(false, false, clock.now());
      } catch (_err) {
        // the kill switch could not be written either; keep going
      }
      return Math.min(MAX_RETRY_MS, IDLE_MS * 2 ** Math.min(errors, 4));
    }
  }

  /**
   * Close every position in the traded roots and cancel their orders: after
   * the end-of-day run, and whenever one turns up outside market hours (hard
   * rule: no position is held outside the 18:00-16:00 ET session).
   */
  async function flattenAll(why) {
    if (!cfg.account || cfg.paper || typeof client.accountState !== 'function') return true;
    try {
      const { positions, orders } = await client.accountState(cfg.account);
      const roots = new Set(cfg.symbols.map(familyRoot));
      const open = positions.filter(p => roots.has(famOf(p.contractId)) && Number(p.size || 0) > 0);
      for (const p of open) {
        await client.closePosition(cfg.account, p.contractId);
        log(`${why}: ${p.contractId} was open; closed at market`, 'error');
      }
      for (const o of orders.filter(x => roots.has(famOf(x.contractId)))) await client.cancelOrder(cfg.account, o.id);
      return true;
    } catch (err) {
      log(`${why}: could not check the account (${err.message}); retrying`, 'error');
      return false;
    }
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
        positions: state ? state.positions.filter(p => Number(p.size || 0) > 0) : null,
        workingOrders: state ? state.orders.length : null,
        attempts,
      };
    } catch (err) {
      log(`account state for the prompt unavailable (${err.message})`, 'error');
      return { id: cfg.account, error: err.message };
    } finally {
      clearTimeout(timer);
    }
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
  function limitFor(action, now) {
    const base = cfg.cycleTimeoutMinutes * 60000;
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
      pendingClose = null;
    } catch (err) {
      const final = /already recorded/.test(err.message) || pendingClose.tries >= CLOSE_TRIES;
      log(`end of day: could not record the close of ${day} (${err.message}); `
        + (final ? `giving up: prop entries stay refused until it is recorded (node scripts/combine.js record-day --account <name> --day ${day} --balance <dollars>)` : 'retrying in a minute'), 'error');
      if (final) pendingClose = null;
    }
  }

  async function stepOnce() {
    const now = clock.now();
    const d = decide(cfg, state, now, { killSwitch: isKillSwitchOn() });
    state = d.state;
    if (pendingClose && d.action !== 'eod') await recordClose(now);

    if (d.action === 'premarket' || d.action === 'eod') {
      const p = prompts(cfg, now, root);
      let ok = true;
      // End of day flattens first, directly: the agents' run (reviews, the
      // journal) can fail or run long, and nothing may be open past the close.
      if (d.action === 'eod') ok = await eodBackstop();
      // Each job is built with the account as it is when that run starts.
      const jobs = d.action === 'eod' ? [acct => p.eod({ state: acct })] : cfg.symbols.map(s => acct => p.premarket(s, { state: acct }));
      const noTime = () => log(`${d.action}: no time left before ${d.action === 'eod' ? 'the close' : 'end of day'}; skipped`);
      for (const prompt of jobs) {
        const at = clock.now();
        // A premarket run never delays end of day.
        if (d.action === 'premarket' && decide(cfg, state, at, { killSwitch: isKillSwitchOn() }).action === 'eod') break;
        if (limitFor(d.action, at) < 30000) { noTime(); continue; }
        const acct = await accountSnapshot(at);
        // The time limit counts from after the account read.
        const timeoutMs = limitFor(d.action, clock.now());
        if (timeoutMs < 30000) { noTime(); continue; }
        const r = await runCycle(d.action, prompt(acct), { timeoutMs });
        if (d.action !== 'eod') ok = ok && r.ok;
      }
      // Then check again: flatten whatever the run left open.
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
      // A failed end of day is retried on the next pass: flattening matters most.
      if (ok || d.action !== 'eod') state = recordRun(state, d.action, now);
      record(ok, false, now);
      saveState(state);
      // A failed end of day is retried, with a growing pause (5 s .. 60 s).
      return ok ? 0 : Math.min(MAX_RETRY_MS, IDLE_MS * 2 ** Math.min(errors - 1, 4));
    }
    if (d.action === null && (!inMarketHours(now) || state.eodDone)) {
      // Outside market hours (or after today's end of day) nothing may be
      // open: check once a minute and flatten whatever is.
      if (now.getTime() - lastHoursCheck >= 60000) {
        lastHoursCheck = now.getTime();
        await flattenAll('outside market hours');
      }
      return IDLE_MS;
    }
    if (d.action !== 'trade' && d.action !== 'manage' && d.action !== 'housekeep') return IDLE_MS;

    const ready = [];
    for (let i = 0; i < syms.length; i += 1) {
      // A slow API can make a pass long: if end of day came due meanwhile, run it first.
      if (i > 0 && decide(cfg, state, clock.now(), { killSwitch: isKillSwitchOn() }).action === 'eod') return 0;
      const item = await pollSymbol(i, now);
      if (item) ready.push(item);
    }
    if (ready.length) {
      // Trailing stops and leftover orders first: they only ever reduce risk.
      const noCycles = d.action === 'housekeep';
      for (const item of ready) await housekeeping(item, { noCycles });
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
        const manageOnly = again.action === 'manage';
        const run = [];
        for (const item of ready.filter(x => !x.stale)) {
          const w = await wanted(item, manageOnly);
          if (w.run) run.push(item);
          else log(`${item.symbol} bar ${item.bar.t}: no cycle (${w.reason})`);
        }
        let cycleNow = clock.now();
        let timeoutMs = limitFor(again.action, cycleNow);
        let acct = null;
        if (run.length && timeoutMs >= 30000) {
          acct = await accountSnapshot(cycleNow);
          // The time limit counts from after the account read.
          cycleNow = clock.now();
          timeoutMs = limitFor(again.action, cycleNow);
        }
        if (run.length && timeoutMs < 30000) log(`no cycle: ${Math.round(timeoutMs / 1000)} s left before end of day`);
        else if (run.length) {
          const prompt = prompts(cfg, cycleNow, root).trade(run.map(x => ({ symbol: x.symbol, bar: x.bar, verdicts: x.verdicts })), { manageOnly, recovered: recover, state: acct });
          recover = false;
          const r = await runCycle(again.action, prompt, { timeoutMs });
          state = recordRun(state, 'trade', cycleNow);
          saveState(state);
          record(r.ok, r.timedOut, cycleNow);
        }
      }
    }
    return sleepMs(syms.map(s => s.clock), clock.now(), { delayMs });
  }

  return { step, get state() { return state; }, get symbols() { return syms.map(s => ({ ...s })); } };
}

module.exports = { createRunner, IDLE_MS, ACCOUNT_READ_MS };
