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
 */

const { decide, recordRun, prompts, signalDecision, dayKey } = require('./autotrader');
const { barStep, sleepMs } = require('./bar-clock');
const { contractRoot } = require('./trading/journal');
const { trailStep } = require('./trading/trail');
const { tradingDayStart } = require('./trading/clock');
const { exitPlan } = require('./trading/strategies');

const IDLE_MS = 5000;
const RESYNCS_BEFORE_REROLL = 3;
const MAX_POLL_MS = 10000;
const LOOKUP_RETRY_MS = 30000;
const MAX_RETRY_MS = 60000;
const FILL_GRACE_MS = 30000;

function createRunner(deps) {
  const {
    cfg, root, client, clock, runCycle, isKillSwitchOn, createKillSwitch,
    loadState, saveState, writeBars, scanFor, log = () => {}, entryOrders = () => [], strategyNamed = () => null,
  } = deps;
  const entryOrderIds = () => new Set(entryOrders().map(e => Number(e.orderId)));
  let state = loadState();
  let errors = 0;
  let recover = false; // the last trade cycle was stopped mid-run
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
      const file = writeBars(sym, step.bars);
      return { symbol: sym.symbol, contractId: sym.contractId, tickSize: sym.tickSize, bars: step.bars, stale, bar: { t: step.bar.t, c: step.bar.c, file, contractId: sym.contractId } };
    } catch (err) {
      syms[i] = { ...syms[i], lastPollAt: now.getTime() };
      log(`${sym.symbol}: ${err.message}`, 'error');
      return null;
    }
  }

  /** Cancel leftover orders on a flat contract root (never pending entries). */
  async function cleanupFlat(item, { positions, orders }) {
    const root = contractRoot(item.contractId);
    // Flat means no position in any month of the root (not months netting to zero).
    if (positions.some(p => contractRoot(p.contractId) === root && Number(p.size || 0) > 0)) return;
    const entries = entryOrderIds();
    for (const o of orders.filter(x => contractRoot(x.contractId) === root && !entries.has(Number(x.id)))) {
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
    const p = positions.find(x => x.contractId === item.contractId && Number(x.size || 0) > 0);
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
    const protective = orders.filter(o => o.contractId === item.contractId && Number(o.type) === 4 && (Number(o.side) === 0 ? 1 : -1) === -sign);
    const stopOrder = protective.length === 1 ? protective[0] : null;
    let t = trails[item.contractId];
    if (!t || t.key !== key) {
      const side = sign > 0 ? 'buy' : 'sell';
      const firstSeen = clock.now().getTime();
      const fillAt = Number.isFinite(opened) ? opened : firstSeen;
      const dayStart = tradingDayStart(new Date(fillAt)).getTime();
      const rec = [...entryOrders()].reverse().find(e => {
        const at = Date.parse(e.at);
        return contractRoot(e.contractId) === contractRoot(item.contractId) && e.setup && (!e.side || e.side === side)
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
        ? { key, setup: rec.setup, sign, entry, risk, stop: entry - sign * risk, peakR: 0, plan, since: fillAt, lastBarT: null }
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
    const resting = stopOrder ? Number(stopOrder.stopPrice) : t.stop;
    let peakR = t.peakR;
    let target = resting;
    let cross = null;
    for (const bar of bars) {
      // A level the resting stop never reached (a modify that failed or came
      // too late) protects nothing: a bar through it means out at market.
      if (sign * (target - resting) > 0 && (sign > 0 ? bar.l <= target : bar.h >= target)) { cross = { bar, stop: target }; break; }
      const step = trailStep({ ...t, stop: target, peakR }, bar, t.plan, tick);
      peakR = step.peakR;
      target = step.stop;
      if (step.close) { cross = { bar, stop: step.stop }; break; }
    }
    const lastBarT = bars[bars.length - 1].t;
    if (cross) {
      const level = cross.stop;
      await client.closePosition(cfg.account, item.contractId);
      save({ ...t, peakR, lastBarT });
      log(`${item.symbol}: trail: price went through the new stop ${level} (resting ${resting}); closed ${t.setup} at market (peak ${peakR.toFixed(2)}R)`);
      for (const o of orders.filter(x => x.contractId === item.contractId)) {
        try {
          await client.cancelOrder(cfg.account, o.id);
        } catch (err) {
          log(`${item.symbol}: could not cancel ${o.id} after the trail close (${err.message}); the next bar retries`, 'error');
        }
      }
      return;
    }
    save({ ...t, peakR, lastBarT });
    if (sign * (target - resting) < tick - 1e-9) return;
    if (!stopOrder) {
      log(`${item.symbol}: trail wants the stop at ${target} but there is no single working stop order to move`, 'error');
      return;
    }
    await client.modifyStop(cfg.account, stopOrder.id, target);
    save({ ...trails[item.contractId], stop: target });
    log(`${item.symbol}: trail: stop ${resting} -> ${target} (peak ${peakR.toFixed(2)}R)`);
  }

  /** Account housekeeping before a cycle: leftover orders and trailing stops. */
  async function housekeeping(item) {
    if (!cfg.account || cfg.paper || typeof client.accountState !== 'function') return;
    try {
      const account = await client.accountState(cfg.account);
      await cleanupFlat(item, account);
      await trailPosition(item, account);
    } catch (err) {
      log(`${item.symbol}: account housekeeping failed (${err.message})`, 'error');
    }
  }

  async function wanted(item, manageOnly) {
    if (cfg.trigger === 'bar' && !manageOnly) return { run: true, reason: 'bar closed' };
    if (!cfg.account) return { run: false, reason: 'cap reached and no account configured to check positions' };
    try {
      const [net, working] = await Promise.all([
        client.netPosition(cfg.account, item.contractId),
        client.workingOrders(cfg.account, item.contractId),
      ]);
      if (manageOnly) {
        return net !== 0 || working > 0 ? { run: true, reason: 'manage only' } : { run: false, reason: 'cap reached and flat' };
      }
      return signalDecision(scanFor(item.symbol, item.bars), net, working, { paper: cfg.paper });
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

  async function stepOnce() {
    const now = clock.now();
    const d = decide(cfg, state, now, { killSwitch: isKillSwitchOn() });
    state = d.state;

    if (d.action === 'premarket' || d.action === 'eod') {
      const p = prompts(cfg, now, root);
      let ok = true;
      const jobs = d.action === 'eod' ? [p.eod()] : cfg.symbols.map(s => p.premarket(s));
      for (const prompt of jobs) {
        const r = await runCycle(d.action, prompt);
        ok = ok && r.ok;
      }
      // A failed end of day is retried on the next pass: flattening matters most.
      if (ok || d.action !== 'eod') state = recordRun(state, d.action, now);
      record(ok, false, now);
      saveState(state);
      // A failed end of day is retried, with a growing pause (5 s .. 60 s).
      return ok ? 0 : Math.min(MAX_RETRY_MS, IDLE_MS * 2 ** Math.min(errors - 1, 4));
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
      for (const item of ready) await housekeeping(item);
      if (state.trails) saveState(state);
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
        if (run.length) {
          const cycleNow = clock.now();
          const prompt = prompts(cfg, cycleNow, root).trade(run.map(x => ({ symbol: x.symbol, bar: x.bar })), { manageOnly, recovered: recover });
          recover = false;
          const r = await runCycle(again.action, prompt);
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

module.exports = { createRunner, IDLE_MS };
