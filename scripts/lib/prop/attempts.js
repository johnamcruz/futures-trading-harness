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
 * `full`; 0 skips the setup) and `sizing` (the rulebook's pacing numbers, every key: the policy's `sizing`, no code
 * default; `clock_k` and `r_per_session` are the pacing a trial tunes). An exit mode is applied to the
 * stream before any attempt (exitAs: each trade re-exited from its recorded path under the policy's exit), so the
 * variants below cut or redraw the re-exited trade. The account's loss_streak_stop applies through combine (a
 * trade's P&L before fees moves the streak; entryBlock skips the rest of the session).
 *
 * Trade variants for the robustness runs (R9): an expectancy cut, a resampled stop overshoot, and a stop
 * fault (a stop placed late, missing or refused: the trade runs unprotected to the end of its day).
 */

const combine = require('../trading/combine');
const { familyOf, specFor } = require('../trading/contracts');
const { requireFee, feePerSide } = require('../trading/accounts');
const { pick } = require('./stats');
const { loadConfig } = require('../trading/config');
const { tradingDayStart } = require('../trading/clock');
const { trailStep } = require('../trading/trail');
const { SWING_TFS, afterTargetStep } = require('../trading/exit-trail');
const { entryPlan } = require('./size-translate');

const round6 = x => Math.round(x * 1e6) / 1e6;

/** The verdict today: every setup the budget sizes is `full` (verdict.js); the rulebook's multiplier replaces it. */
const fullVerdict = () => 1;

/**
 * Today's sizing, the live rule (prop/size-translate.js entryPlan, as translateSize): the most contracts the composed
 * strategy's risk.max_risk_usd fits all in (`limits`: { capUsd, orderMax }; the rulebook's healthy_risk_usd in its place
 * while healthy, when on), lowered by the size budget and the room (combine.contractPlan), near the target, the account's
 * and the broker's max; under the floor the floor stretch while healthy, else a skip. `limits` null: the budget alone.
 */
function defaultSize({ cs, trade, sizing, legs, mode, ratio, fraction, limits = null, lossesToday = null }) {
  // The floor stretch as live: the rulebook's floor_stretch_max_usd, the attempt's health from its own state (cs) and the
  // day's losing trades so far (runAttempt's counters, as live reads the snapshot's day counts).
  return entryPlan({
    dollars: combine.budget(cs, sizing), room: combine.room(cs), stopTicks: trade.stopTicks, legs, mode,
    guard: sizing.min_size_guard, fraction, ratio, slipTicks: sizing.stop_slippage_ticks, minContracts: sizing.min_contracts,
  }, { limits, healthyUsd: sizing.healthy_risk_usd, stretchUsd: sizing.floor_stretch_max_usd, state: { ...cs, lossesToday }, nearTargetUsd: sizing.near_target_usd });
}

/**
 * A market's micro and mini legs on the account, as the engine prices them (engine.js legOf): the account's
 * fee (accounts.js requireFee: none is refused, never assumed); the account's max contracts (0 = none).
 * { legs: { micro, mini }, ratio }.
 */
function legsFor(account, symbol, { tickValue } = {}) {
  const fam = familyOf(symbol);
  const leg = root => {
    const spec = { ...(specFor(root) || {}), ...(root === symbol && tickValue ? { tickValue } : {}) };
    const max = (account.max_contracts && account.max_contracts[root]) || 0;
    // A leg the account may trade needs its fee; one it may not (max 0) is never sized, so it needs none.
    return { root, tickValue: spec.tickValue, fee: max > 0 ? requireFee(account, root) : feePerSide(account, root), max };
  };
  return fam ? { legs: { micro: leg(fam.micro), mini: leg(fam.mini) }, ratio: fam.ratio } : { legs: { micro: leg(symbol), mini: null }, ratio: 10 };
}

/** The net at a forced exit wanting `want` dollars, rounded a tick against the trade (sim-broker priceForNet). */
const forcedNet = (want, perTick, fees) => Math.floor((want + fees) / perTick + 1e-9) * perTick - fees;

/**
 * The order gate's own loss limits (trading/config.js loadConfig, the one config the live gate reads, from the same
 * env): the losing trades a trading day allows (FTH_MAX_DAILY_LOSSES, order-gate.js daily-loss-count) and the losses in
 * a row that start a cooldown (FTH_MAX_CONSECUTIVE_LOSSES, FTH_LOSS_COOLDOWN_MIN, order-gate.js loss-streak). An
 * autonomous run can't skip either (config.js skipChecks), so the simulator never takes an entry they would refuse.
 */
function gateLimits(env = process.env) {
  const c = loadConfig(env);
  return Object.freeze({ maxDailyLosses: c.maxDailyLosses, maxConsecutiveLosses: c.maxConsecutiveLosses, lossCooldownMin: c.lossCooldownMin });
}

/** A moment's offset into its trading day (ms), or NaN: a reweighted day joins trades of different dates by it. */
const intoSession = (ms, dayOf = ms) => (Number.isFinite(ms) && Number.isFinite(dayOf) ? ms - tradingDayStart(new Date(dayOf)).getTime() : NaN);

/**
 * The gate's refusal of an entry, as order-gate.js gives it on the day's closes so far: `daily-losses` once the day's
 * losing trades reach maxDailyLosses; `loss-cooldown` while the day's losing streak (a loss extends it, a win ends it,
 * a scratch neither) is at maxConsecutiveLosses and the entry comes within lossCooldownMin of the last loss's exit,
 * by the time into the session (a trade without times can't show the cooldown passed: refused, fails closed). Null
 * when it would let the entry through.
 */
function gateRefusal(gate, day, t) {
  if (!gate) return null;
  if (day.losses >= gate.maxDailyLosses) return 'daily-losses';
  if (day.streak >= gate.maxConsecutiveLosses) {
    const at = intoSession(Date.parse(t.entryTime));
    if (!(Number.isFinite(at) && Number.isFinite(day.lastLossAt) && at - day.lastLossAt >= gate.lossCooldownMin * 60000)) return 'loss-cooldown';
  }
  return null;
}

/**
 * One attempt over `days` ([{ day, trades }], in order) from a fresh account state. ctx: { account, sizing,
 * size, multiplier, mode, legsOf(trade) -> { legs, ratio }, maxDailyLoss (the engine's realized daily stop, 0
 * off), gate (the order gate's loss limits, gateLimits(); default the env's, as live; null only for a test that
 * isolates another rule), variant(trade, { first }) -> the trade to replay (or null to keep it), outageDay(dayIndex) -> true when
 * the runner is down that day, onDay(cs, dayIndex) -> called with the account as each day opens (read only: the
 * account states the attempt passed through, prop/account-states.js), onTrade({ before, after, trade, net, gross, forced,
 * dayIndex, counters }) after each trade taken and onSkip({ cs, trade, dayIndex, counters, why }) for each one the
 * account layer passed over (both read only: the risk attribution, prop/evaluator.js) }. `counters`: the day's trades
 * and losing trades so far and the session's losing streak (combine's lossStreak, live's prop-state.sessionLossStreak),
 * as the attempt line shows them (combine.attemptFacts); the multiplier sees them too (multiplier(trade, { cs, counters })).
 * Each trade (already re-exited under the policy's exit, exitAs, by the evaluator) meets the checks in this order, the
 * first that refuses skipping it: (0) with ctx.onePosition, a trade entered before the day's last taken trade exited
 * (`position-open`: one position at a time, decided after sizing, so a trade skipped below never holds the slot; the
 * day's trades in entry order); (1) combine.entryBlock (the attempt over, the firm's daily limit, the soft daily stop,
 * the account's loss_streak_stop for the rest of the session); (2) the engine's realized daily stop and a runner outage;
 * (3) the order gate's count rules (gateRefusal: daily-losses, then loss-cooldown); (4) the multiplier; (5) the size.
 * The streak is counted once (cs.lossStreak) and read by both (1) and (3): loss_streak_stop ends the session's entries,
 * the gate's cooldown only pauses them, and a trade skipped by one is never counted again by the other.
 * Returns { status, sessions, profit, taken, skipped }.
 */
function runAttempt(days, ctx) {
  const { account, sizing, size = defaultSize, multiplier = fullVerdict, mode = 'auto', legsOf, maxDailyLoss = 0, variant = null, outageDay = null, onDay = null, onTrade = null, onSkip = null, limits = null, onePosition = false } = ctx;
  const gate = ctx.gate === undefined ? gateLimits() : ctx.gate;
  let cs = combine.start(account);
  let taken = 0;
  let skipped = 0;
  const view = x => Object.freeze({ ...x, days: Object.freeze([...x.days]) });
  for (let d = 0; d < days.length && cs.status === 'active'; d += 1) {
    if (onDay) onDay(view(cs), d);
    let closed = 0;
    const outage = outageDay ? outageDay(d) : false;
    let first = true;
    let tradesToday = 0;
    let lossesToday = 0;
    // The last loss's exit, by the time into the session (the gate's loss cooldown runs from it).
    let lastLossAt = NaN;
    // One position at a time (ctx.onePosition): the last taken trade's exit; a trade entered before it is skipped.
    let openUntil = -Infinity;
    // One count of the day's losses and losing streak for the gate, the attempt line and the loss streak stop: by the
    // trade's P&L before fees, as the gate counts the broker's; the streak is combine's (cs.lossStreak, the session's).
    const counters = () => Object.freeze({ tradesToday, lossesToday, lossStreak: cs.lossStreak || 0 });
    const skip = (t0, why) => { skipped += 1; if (onSkip) onSkip({ cs: view(cs), trade: t0, dayIndex: d, counters: counters(), why }); };
    for (const t0 of days[d].trades) {
      if (onePosition && Date.parse(t0.entryTime) < openUntil) { skip(t0, 'position-open'); continue; }
      if (combine.entryBlock(cs)) { skip(t0, 'blocked'); continue; }
      if ((maxDailyLoss > 0 && closed <= -maxDailyLoss) || (outage && !first)) { skip(t0, outage && !first ? 'outage' : 'daily-stop'); continue; }
      const refused = gateRefusal(gate, { losses: lossesToday, streak: cs.lossStreak || 0, lastLossAt }, t0);
      if (refused) { skip(t0, refused); continue; }
      const m = Number(multiplier(t0, { cs, counters: counters() }));
      if (!(m > 0)) { skip(t0, 'multiplier'); continue; }
      const { legs, ratio } = legsOf(t0);
      const plan = size({ cs, trade: t0, sizing, legs, mode, ratio, fraction: Math.min(1, m), limits, lossesToday });
      if (!plan || !(plan.size >= 1)) { skip(t0, 'no-size'); continue; }
      const before = cs;
      const counted = counters();
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
      const gross = Math.round((net + fees) * 100) / 100;
      cs = combine.applyClose(cs, net, gross);
      taken += 1;
      closed += net;
      tradesToday += 1;
      // A re-exited trade's exit time is its exit bar's close (exitAs), or null when unknown: the cooldown then refuses.
      // An exit time unknown holds the slot for the rest of the day (never a second position on a guess).
      if (onePosition) openUntil = Number.isFinite(Date.parse(t.exitTime)) ? Date.parse(t.exitTime) : Infinity;
      if (gross < 0) { lossesToday += 1; lastLossAt = intoSession(Date.parse(t.exitTime), Date.parse(t0.entryTime)); }
      if (forced === 'blow') cs = combine.blow(cs);
      if (forced === 'daily') cs = { ...cs, dayStopped: true };
      if (onTrade) onTrade({ before: view(before), after: view(cs), trade: t0, net, gross, forced, dayIndex: d, counters: counted });
      if (forced === 'blow') break;
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
  let k = 0;
  for (; k < t.path.length; k += 1) {
    const [o, adv, fav, close] = t.path[k];
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
  return { ...t, moveTicks: round6(move), troughTicks: troughs, exitedAs: exit.mode, ...exitTimeAt(t, k) };
}

/**
 * The re-exited trade's exit time (the order gate's loss cooldown runs from it): the close of its exit bar `k`
 * (t.pathEnds, ms per path bar; the end of the path when it ran out), never earlier than the fill exited; without
 * pathEnds a recorded exit time is no longer the exit's, so it becomes null (the cooldown then refuses: fails closed).
 */
function exitTimeAt(t, k) {
  if (Array.isArray(t.pathEnds) && t.pathEnds.length === t.path.length) return { exitTime: new Date(t.pathEnds[Math.min(k, t.pathEnds.length - 1)]).toISOString() };
  return t.exitTime === undefined ? {} : { exitTime: null };
}

/** exitAs in mode target_then_trail: in the trade's own frame (ticks its way, 1R = its stop), exit-trail.js's rule. */
function afterTargetExit(t, exit, slipTicks) {
  const own = t.ownExit || {};
  const minutes = exit.trail_by === 'structure' ? SWING_TFS[exit.swing_tf] : null;
  if (!(exit.lock_giveback_r > 0 && exit.trail_r > 0) || !['r', 'structure'].includes(exit.trail_by) || (exit.trail_by === 'structure' && !minutes)) return t;
  if (![undefined, 'off', 'on'].includes(exit.ratchet)) return t;
  const plan = { afterTarget: { lockGivebackR: exit.lock_giveback_r, trailBy: exit.trail_by, trailR: exit.trail_r, swingMinutes: minutes, ...(exit.ratchet === 'on' ? { ratchet: true } : {}) } };
  const swings = minutes && t.swingPath ? t.swingPath[exit.swing_tf] || [] : [];
  const trade = { sign: 1, entry: 0, risk: t.stopTicks, stop: -t.stopTicks, peakR: 0, armed: false, target: own.targetTicks > 0 ? own.targetTicks : null };
  let low = 0;
  const troughs = [];
  const deeper = x => { if (x < low) { low = x; troughs.push(round6(x)); } };
  let move = null;
  let k = 0;
  for (; k < t.path.length; k += 1) {
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
    if (step.close) { move = close; break; }
  }
  if (move === null) move = t.path[t.path.length - 1][3];
  return { ...t, moveTicks: round6(move), troughTicks: troughs, exitedAs: exit.mode, ...exitTimeAt(t, k) };
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

module.exports = { fullVerdict, defaultSize, legsFor, gateLimits, gateRefusal, runAttempt, exitAs, withExit, expectancyR, cutTrade, overshootPools, redrawOvershoot, stopFault };
