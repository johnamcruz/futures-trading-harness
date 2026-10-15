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
 * combine.DEFAULT_SIZING).
 *
 * Trade variants for the robustness runs (R9): an expectancy cut, a resampled stop overshoot, and a stop
 * fault (a stop placed late, missing or refused: the trade runs unprotected to the end of its day).
 */

const combine = require('../trading/combine');
const { familyOf, specFor } = require('../trading/contracts');
const { pick } = require('./stats');
const { loadConfig } = require('../trading/config');
const { tradingDayStart } = require('../trading/clock');

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
 * account states the attempt passed through, prop/account-states.js), onTrade({ before, after, trade, net, forced,
 * dayIndex, counters }) after each trade taken and onSkip({ cs, trade, dayIndex, counters, why }) for each one the
 * account layer passed over (both read only: the risk attribution, prop/evaluator.js) }. `counters`: the day's trades
 * and losing trades so far and the losing streak across the attempt, as the attempt line shows them
 * (combine.attemptFacts); the multiplier sees them too (multiplier(trade, { cs, counters })).
 * Returns { status, sessions, profit, taken, skipped }.
 */
function runAttempt(days, ctx) {
  const { account, sizing, size = defaultSize, multiplier = fullVerdict, mode = 'auto', legsOf, maxDailyLoss = 0, variant = null, outageDay = null, onDay = null, onTrade = null, onSkip = null } = ctx;
  const gate = ctx.gate === undefined ? gateLimits() : ctx.gate;
  let cs = combine.start(account);
  let taken = 0;
  let skipped = 0;
  const view = x => Object.freeze({ ...x, days: Object.freeze([...x.days]) });
  let streak = 0;
  for (let d = 0; d < days.length && cs.status === 'active'; d += 1) {
    if (onDay) onDay(view(cs), d);
    let closed = 0;
    const outage = outageDay ? outageDay(d) : false;
    let first = true;
    let tradesToday = 0;
    let lossesToday = 0;
    // The gate's view of the day: its losses, its losing streak (the gate's is the day's) and the last loss's exit.
    const gday = { losses: 0, streak: 0, lastLossAt: NaN };
    const counters = () => Object.freeze({ tradesToday, lossesToday, lossStreak: streak });
    const skip = (t0, why) => { skipped += 1; if (onSkip) onSkip({ cs: view(cs), trade: t0, dayIndex: d, counters: counters(), why }); };
    for (const t0 of days[d].trades) {
      if (combine.entryBlock(cs)) { skip(t0, 'blocked'); continue; }
      if ((maxDailyLoss > 0 && closed <= -maxDailyLoss) || (outage && !first)) { skip(t0, outage && !first ? 'outage' : 'daily-stop'); continue; }
      const refused = gateRefusal(gate, gday, t0);
      if (refused) { skip(t0, refused); continue; }
      const m = Number(multiplier(t0, { cs, counters: counters() }));
      if (!(m > 0)) { skip(t0, 'multiplier'); continue; }
      const { legs, ratio } = legsOf(t0);
      const plan = size({ cs, trade: t0, sizing, legs, mode, ratio, fraction: Math.min(1, m) });
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
      cs = combine.applyClose(cs, net);
      taken += 1;
      closed += net;
      tradesToday += 1;
      if (net < 0) { lossesToday += 1; streak += 1; } else if (net > 0) streak = 0;
      if (net < 0) { gday.losses += 1; gday.streak += 1; gday.lastLossAt = intoSession(Date.parse(t.exitTime), Date.parse(t0.entryTime)); } else if (net > 0) gday.streak = 0;
      if (forced === 'blow') cs = combine.blow(cs);
      if (forced === 'daily') cs = { ...cs, dayStopped: true };
      if (onTrade) onTrade({ before: view(before), after: view(cs), trade: t0, net, forced, dayIndex: d, counters: counted });
      if (forced === 'blow') break;
    }
    if (cs.status === 'active') cs = combine.endDay(cs);
  }
  return {
    status: cs.status === 'active' ? 'unfinished' : cs.status, sessions: cs.days.length,
    profit: Math.round((cs.balance - cs.start) * 100) / 100, taken, skipped,
  };
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

module.exports = { fullVerdict, defaultSize, legsFor, gateLimits, gateRefusal, runAttempt, withExit, expectancyR, cutTrade, overshootPools, redrawOvershoot, stopFault };
