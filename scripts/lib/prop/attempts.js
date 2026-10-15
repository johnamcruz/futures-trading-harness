'use strict';

/**
 * The evaluator's second layer (docs/LEARNED-RULEBOOK.md R6.2, R7, R9): attempt simulation, fast. From the
 * trade stream (prop/trade-stream.js) an attempt replays a sequence of trading days under the account's rules
 * (trading/combine.js: the trailing end-of-day floor, the firm's daily limit that stops the day, the soft
 * daily stop, the target and the consistency rule, `sessions`), sizing each trade as the backtester and the
 * order gate do (combine.contractPlan, from the budget and the room) times the rulebook's multiplier, and
 * replaying the trade's adverse path against the floor and the daily limit as the engine does inside a bar
 * (a blow is liquidated at the floor, a daily breach flattened at the limit, each rounded a tick against the
 * trade). Pacing and sizing trials re-run only this layer.
 *
 * Injected (so the rulebook and the slippage-safe sizing plug in when they land): `size` (default: today's
 * contractPlan sizing), `multiplier` (the verdict's size multiplier from the recorded facts; default 1, today's
 * `full`; 0 skips the setup) and `sizing` (the rulebook's pacing numbers; default the policy's `sizing` over
 * combine.DEFAULT_SIZING; `clock_k` and `r_per_session` are the pacing a trial tunes). An exit mode is applied to the
 * stream before any attempt (exitAs: each trade re-exited from its recorded path under the policy's exit), so the
 * variants below cut or redraw the re-exited trade. The account's loss_streak_stop applies through combine (a
 * trade's P&L before fees moves the streak; entryBlock skips the rest of the session).
 *
 * Trade variants for the robustness runs (R9): an expectancy cut, a resampled stop overshoot, and a stop
 * fault (a stop placed late, missing or refused: the trade runs unprotected to the end of its day).
 */

const combine = require('../trading/combine');
const { familyOf, specFor } = require('../trading/contracts');
const { pick } = require('./stats');
const { trailStep } = require('../trading/trail');
const { SWING_TFS, afterTargetStep } = require('../trading/exit-trail');

const round6 = x => Math.round(x * 1e6) / 1e6;

/** The verdict today: every setup the budget sizes is `full` (verdict.js); the rulebook's multiplier replaces it. */
const fullVerdict = () => 1;

/** Today's sizing (verdict.js, the engine, the gate): combine.contractPlan from the budget and the room. */
function defaultSize({ cs, trade, sizing, legs, mode, ratio, fraction }) {
  return combine.contractPlan({
    dollars: combine.budget(cs, sizing), room: combine.room(cs), stopTicks: trade.stopTicks, legs, mode,
    guard: sizing.min_size_guard, fraction, ratio, slipTicks: sizing.stop_slippage_ticks,
  });
}

/**
 * A market's micro and mini legs on the account, as the engine prices them (engine.js legOf): the account's
 * fee, else the contract spec's; the account's max contracts (0 = none). { legs: { micro, mini }, ratio }.
 */
function legsFor(account, symbol, { tickValue, feesPerSide = 0.37 } = {}) {
  const fam = familyOf(symbol);
  const leg = root => {
    const spec = { ...(specFor(root) || {}), ...(root === symbol && tickValue ? { tickValue } : {}) };
    const fees = account.fees_per_side || {};
    const fee = fees[root] !== undefined ? fees[root] : spec.feesPerSide ?? feesPerSide;
    return { root, tickValue: spec.tickValue, fee, max: (account.max_contracts && account.max_contracts[root]) || 0 };
  };
  return fam ? { legs: { micro: leg(fam.micro), mini: leg(fam.mini) }, ratio: fam.ratio } : { legs: { micro: leg(symbol), mini: null }, ratio: 10 };
}

/** The net at a forced exit wanting `want` dollars, rounded a tick against the trade (sim-broker priceForNet). */
const forcedNet = (want, perTick, fees) => Math.floor((want + fees) / perTick + 1e-9) * perTick - fees;

/**
 * One attempt over `days` ([{ day, trades }], in order) from a fresh account state. ctx: { account, sizing,
 * size, multiplier, mode, legsOf(trade) -> { legs, ratio }, maxDailyLoss (the engine's realized daily stop, 0
 * off), variant(trade, { first }) -> the trade to replay (or null to keep it), outageDay(dayIndex) -> true when
 * the runner is down that day }. Returns { status, sessions, profit, taken, skipped, passDays }.
 */
function runAttempt(days, ctx) {
  const { account, sizing, size = defaultSize, multiplier = fullVerdict, mode = 'auto', legsOf, maxDailyLoss = 0, variant = null, outageDay = null } = ctx;
  let cs = combine.start(account);
  let taken = 0;
  let skipped = 0;
  for (let d = 0; d < days.length && cs.status === 'active'; d += 1) {
    let closed = 0;
    const outage = outageDay ? outageDay(d) : false;
    let first = true;
    for (const t0 of days[d].trades) {
      if (combine.entryBlock(cs) || (maxDailyLoss > 0 && closed <= -maxDailyLoss) || (outage && !first)) { skipped += 1; continue; }
      const m = Number(multiplier(t0, { cs }));
      if (!(m > 0)) { skipped += 1; continue; }
      const { legs, ratio } = legsOf(t0);
      const plan = size({ cs, trade: t0, sizing, legs, mode, ratio, fraction: Math.min(1, m) });
      if (!plan || !(plan.size >= 1)) { skipped += 1; continue; }
      const leg = plan.root === legs.micro.root ? legs.micro : legs.mini;
      // A runner outage leaves the day's first trade unmanaged (a stop fault), and no more entries that day.
      const t = (outage ? stopFault(t0) : null) || (variant ? variant(t0, { first }) : null) || t0;
      first = false;
      const perTick = leg.tickValue * plan.size;
      const fees = 2 * leg.fee * plan.size;
      let net = null;
      let forced = null;
      for (const trough of t.troughTicks) {
        const worst = trough * perTick - fees;
        if (combine.touches(cs, worst)) { net = forcedNet(cs.floor - cs.balance, perTick, fees); forced = 'blow'; break; }
        if (combine.dailyBreached(cs, worst)) { net = forcedNet(-cs.dailyLimit - cs.dayPnl, perTick, fees); forced = 'daily'; break; }
      }
      if (net === null) net = t.moveTicks * perTick - fees;
      net = Math.round(net * 100) / 100;
      // The loss streak counts the trade's P&L before fees, as the gate counts the broker's (a scratch moves it neither way).
      cs = combine.applyClose(cs, net, Math.round((net + fees) * 100) / 100);
      taken += 1;
      closed += net;
      if (forced === 'blow') { cs = combine.blow(cs); break; }
      if (forced === 'daily') cs = { ...cs, dayStopped: true };
    }
    if (cs.status === 'active') cs = combine.endDay(cs);
  }
  return {
    status: cs.status === 'active' ? 'unfinished' : cs.status, sessions: cs.days.length,
    profit: Math.round((cs.balance - cs.start) * 100) / 100, taken, skipped,
  };
}

/**
 * The trade exited under a policy exit (`exit`: { mode, trail_activate_r?, trail_giveback_r? }, as the strategy loader
 * reads the rulebook's) from its recorded price path (trade-stream.js pricePath), as the engine's broker exits it:
 * each bar the resting stop first (filled at the stop, or a worse open, less `slipTicks`), then the target (at it,
 * or a better open), then the trail at the bar's close (trail.js trailStep, the live and backtest rule); still open
 * at the path's end, out at its last close. Mode `target`: the trade's own target (trade.ownExit) and its own trail,
 * or the policy's trail on top when it has one; mode `target_then_trail`: the original stop until the trade's own
 * target, then no exit there but the lock and the swing or R trail at each close (trading/exit-trail.js
 * afterTargetStep, the runner's and the backtester's rule, on the recorded swing levels: trade.swingPath);
 * mode `trail`: the policy's trail, no target. moveTicks and
 * troughTicks are worked out again (a component's time stop is not replayed). A trade without a path or a stop, or an
 * exit without a mode, is kept as recorded.
 */
function exitAs(t, exit, slipTicks = 1) {
  if (!exit || !Array.isArray(t.path) || !t.path.length || !(t.stopTicks > 0)) return t;
  if (!['target', 'target_then_trail', 'trail'].includes(exit.mode)) return t;
  if (exit.mode === 'target_then_trail') return afterTargetExit(t, exit, slipTicks);
  const own = t.ownExit || {};
  const policyTrail = exit.trail_activate_r !== undefined && exit.trail_giveback_r !== undefined ? { a: exit.trail_activate_r, g: exit.trail_giveback_r } : null;
  const ownTrail = own.trailActivateR !== null && own.trailActivateR !== undefined ? { a: own.trailActivateR, g: own.trailGivebackR } : null;
  const trail = exit.mode === 'target' ? policyTrail || ownTrail : policyTrail;
  if (exit.mode === 'trail' && !trail) return t;
  const target = exit.mode === 'target' && own.targetTicks > 0 ? own.targetTicks : null;
  const plan = { trailActivateR: trail ? trail.a : null, trailGivebackR: trail ? trail.g : null };
  const initial = -t.stopTicks;
  let stop = initial;
  let peakR = 0;
  let low = 0;
  const troughs = [];
  const deeper = x => { if (x < low) { low = x; troughs.push(round6(x)); } };
  let move = null;
  for (const [o, adv, fav, close] of t.path) {
    if (adv <= stop) {
      const fill = Math.min(o, stop) - slipTicks;
      deeper(fill);
      move = fill;
      break;
    }
    deeper(adv);
    if (target !== null && fav >= target) { move = Math.max(o, target); break; }
    const step = trailStep({ sign: 1, entry: 0, risk: t.stopTicks, stop, peakR }, { h: fav, l: adv, c: close }, plan, 1);
    peakR = step.peakR;
    stop = step.stop;
    if (step.close) { move = close; break; }
  }
  if (move === null) move = t.path[t.path.length - 1][3];
  return { ...t, moveTicks: round6(move), troughTicks: troughs, exitedAs: exit.mode };
}

/** exitAs in mode target_then_trail: in the trade's own frame (ticks its way, 1R = its stop), exit-trail.js's rule. */
function afterTargetExit(t, exit, slipTicks) {
  const own = t.ownExit || {};
  const minutes = exit.trail_by === 'structure' ? SWING_TFS[exit.swing_tf] : null;
  if (!(exit.lock_giveback_r > 0 && exit.trail_r > 0) || !['r', 'structure'].includes(exit.trail_by) || (exit.trail_by === 'structure' && !minutes)) return t;
  const plan = { afterTarget: { lockGivebackR: exit.lock_giveback_r, trailBy: exit.trail_by, trailR: exit.trail_r, swingMinutes: minutes } };
  const swings = minutes && t.swingPath ? t.swingPath[exit.swing_tf] || [] : [];
  const trade = { sign: 1, entry: 0, risk: t.stopTicks, stop: -t.stopTicks, peakR: 0, armed: false, target: own.targetTicks > 0 ? own.targetTicks : null };
  let low = 0;
  const troughs = [];
  const deeper = x => { if (x < low) { low = x; troughs.push(round6(x)); } };
  let move = null;
  for (let k = 0; k < t.path.length && move === null; k += 1) {
    const [o, adv, fav, close] = t.path[k];
    if (adv <= trade.stop) {
      move = Math.min(o, trade.stop) - slipTicks;
      deeper(move);
      break;
    }
    deeper(adv);
    const swing = swings[k] === undefined ? null : swings[k];
    const step = afterTargetStep(trade, { h: fav, l: adv, c: close }, plan, 1, swing);
    Object.assign(trade, { stop: step.stop, peakR: step.peakR, armed: step.armed });
    if (step.close) move = close;
  }
  if (move === null) move = t.path[t.path.length - 1][3];
  return { ...t, moveTicks: round6(move), troughTicks: troughs, exitedAs: exit.mode };
}

/** The trade with its exit moved to `move` ticks (a deeper exit becomes its last trough). */
function withExit(t, move) {
  const last = t.troughTicks.length ? t.troughTicks[t.troughTicks.length - 1] : 0;
  return { ...t, moveTicks: round6(move), troughTicks: move < Math.min(0, last) ? [...t.troughTicks, round6(move)] : t.troughTicks };
}

/** The per-trade expectancy in R over the stream (mean move over stop). */
function expectancyR(trades) {
  if (!trades.length) return 0;
  return trades.reduce((a, t) => a + t.moveTicks / t.stopTicks, 0) / trades.length;
}

/** The trade with the expectancy cut by `cut` (0.25, 0.5): every trade gives up cut x E R (nothing when E <= 0). */
function cutTrade(t, cut, eR) {
  return eR > 0 && cut > 0 ? withExit(t, t.moveTicks - cut * eR * t.stopTicks) : t;
}

/** Stop overshoots observed in the stream, by symbol: Map symbol -> [ticks] (stop exits only, zeros included). */
function overshootPools(trades) {
  const m = new Map();
  for (const t of trades) {
    if (t.overshootTicks === null || t.overshootTicks === undefined) continue;
    if (!m.has(t.symbol)) m.set(t.symbol, []);
    m.get(t.symbol).push(t.overshootTicks);
  }
  return m;
}

/** A stop exit with its overshoot redrawn from its market's observed ones (the stop fill moves; nothing else). */
function redrawOvershoot(t, pool, rand) {
  if (t.overshootTicks === null || t.overshootTicks === undefined || !pool || !pool.length) return t;
  const drawn = pool[pick(rand, pool.length)];
  const move = t.moveTicks + t.overshootTicks - drawn;
  return { ...t, moveTicks: round6(move), troughTicks: [...t.troughTicks.filter(x => x > t.moveTicks), round6(move)].filter(x => x < 0) };
}

/** A stop that wasn't working (late, missing, refused): the trade runs to its day's end, its worst move first. */
function stopFault(t) {
  if (!t.noStop) return null;
  const w = t.noStop.worstTicks;
  return { ...t, moveTicks: t.noStop.closeTicks, troughTicks: w < 0 ? [...t.troughTicks.filter(x => x > w), w] : t.troughTicks.filter(x => x < 0) };
}

module.exports = { fullVerdict, defaultSize, legsFor, runAttempt, exitAs, withExit, expectancyR, cutTrade, overshootPools, redrawOvershoot, stopFault };
