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
 */

const { decide, recordRun, prompts, signalDecision, dayKey } = require('./autotrader');
const { barStep, sleepMs } = require('./bar-clock');

const IDLE_MS = 5000;
const RESYNCS_BEFORE_REROLL = 3;
const MAX_POLL_MS = 10000;

function createRunner(deps) {
  const {
    cfg, root, client, clock, runCycle, isKillSwitchOn, createKillSwitch,
    loadState, saveState, writeBars, scanFor, log = () => {},
  } = deps;
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
    if (now.getTime() - sym.lastPollAt < MAX_POLL_MS && !sym.contractId) return sym; // back off after a failed lookup
    const c = await client.activeContract(sym.symbol);
    if (c.id !== sym.contractId) {
      log(`${sym.symbol}: active contract ${sym.contractId ? `${sym.contractId} -> ` : ''}${c.id}`);
      return { ...sym, contractId: c.id, contractDay: day, clock: null, lastPollAt: 0, misses: 0, resyncs: 0 };
    }
    return { ...sym, contractDay: day, resyncs: 0 };
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
      if (step.event === 'stale' && !recover) {
        log(`${sym.symbol}: bar ${step.bar.t} skipped, closed too long ago to act on`);
        return null;
      }
      if (step.event !== 'bar' && step.event !== 'stale') return null;
      const file = writeBars(sym, step.bars);
      return { symbol: sym.symbol, contractId: sym.contractId, bars: step.bars, bar: { t: step.bar.t, c: step.bar.c, file, contractId: sym.contractId } };
    } catch (err) {
      syms[i] = { ...syms[i], lastPollAt: now.getTime() };
      log(`${sym.symbol}: ${err.message}`, 'error');
      return null;
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
      return signalDecision(scanFor(item.symbol, item.bars), net, working);
    } catch (err) {
      // Can't see the account: run the cycle rather than risk leaving a position unmanaged.
      return { run: true, reason: `account check failed (${err.message})` };
    }
  }

  async function step() {
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
      saveState(state);
      record(ok, false, now);
      return 0;
    }
    if (d.action !== 'trade' && d.action !== 'manage') return IDLE_MS;

    const ready = [];
    for (let i = 0; i < syms.length; i += 1) {
      const item = await pollSymbol(i, now);
      if (item) ready.push(item);
    }
    if (ready.length) {
      // Re-check: a symbol's poll may have taken a while, the kill switch may be on now.
      const again = decide(cfg, state, clock.now(), { killSwitch: isKillSwitchOn() });
      state = again.state;
      if (again.action === 'trade' || again.action === 'manage') {
        const manageOnly = again.action === 'manage';
        const run = [];
        for (const item of ready) {
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
