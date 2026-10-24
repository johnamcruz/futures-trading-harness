'use strict';

/**
 * A prop-firm challenge as a state machine over one attempt, from an account
 * profile (accounts/<name>/ACCOUNT.md). Pure: the prop simulator, the
 * backtester, the runner, and the gateway all drive the same functions.
 *
 *   start(account)                  a fresh attempt
 *   applyClose(s, net, gross)       a closed trade's net P&L (after fees); gross (before fees) moves the loss streak
 *   streakAfter(streak, gross)      the session's loss streak after a closed trade
 *   touches(s, openPnl)             would equity at openPnl reach the floor?
 *   endDay(s)                       the session closed: floor, pass, timeout
 *   entryBlock(s)                   why no new entry now (or null)
 *   budget(s, sizing)               dollars a new trade may risk (sizing: a policy's rulebook entry, every key; else 0)
 *   sizingErrors(z), requireSizing(z)  what a sizing lacks (SIZING_KEYS: no code default)
 *   attemptFacts(s, counts)         the attempt line's further facts (room to the limits, today's counts, consistency)
 *   contracts(budget, riskPerContract, max, guard, room)
 *
 * The floor (max_loss_mode trailing_eod) trails the highest end-of-day
 * balance by max_loss and stops rising at the starting balance. Equity at or
 * below it at any moment is a blow. A pass is checked at the end of a day:
 * profit at or above the target, and the best day at most consistency_pct of
 * the profit. A firm daily limit stops trading for the rest of the day; it
 * doesn't end the attempt. The harness's soft daily limit only stops new
 * entries, and so does its loss streak stop (the rulebook's loss_streak_stop):
 * that many losing trades in a row in a session stop new entries until the
 * next one. A loss (gross P&L below 0, as the gate counts it) extends the
 * streak, a win ends it, and a scratch (gross 0) does neither.
 */

/**
 * The sizing keys a policy's rulebook entry states (accounts/<name>/RULEBOOK.md, rulebook.js SIZING_RULES). There is
 * no code default for any of them: the rulebook is the one home of their values. A sizing that leaves one out sizes
 * nothing (budget 0), and every caller refuses it with sizingErrors' reason.
 *   cushion_frac        risk at most this share of the cushion on one trade
 *   cap_usd             and at most this many dollars (0 = no cap: the rulebook's `off`)
 *   clock_k             > 0: also at most k x (target - profit) / (sessions left x r_per_session)
 *   r_per_session       the R a session makes (clock sizing)
 *   min_size_guard      one contract is still taken when it risks at most guard x budget (only with min_contracts 1:
 *                       a floor above 1 refuses the one contract the guard would allow)
 *   min_contracts       the floor: the size, in micro-equivalents (a mini counts as the family's ratio of micros), is at
 *                       least this many, else no size (skip); never rounded up past the budget or the room
 *   drawdown_halve_usd  > 0: halve the budget while the balance is at least this far below its peak
 *   stop_slippage_ticks a stop's expected slippage, in ticks per contract, counted in each contract's risk: a full
 *                       stop plus this never reaches the floor or the daily limit
 */
const SIZING_KEYS = Object.freeze(['cushion_frac', 'cap_usd', 'clock_k', 'r_per_session', 'min_size_guard', 'drawdown_halve_usd', 'stop_slippage_ticks', 'min_contracts']);
/**
 * The floor under a stop's expected slippage: the schema's (rulebook.js refuses less), not a value. A missing or
 * smaller slippage only ever sizes the same or down. The backtester's fill slippage (engine.js DEFAULTS.slippageTicks)
 * is this floor too, so a backtest sizes and fills as live.
 */
const MIN_STOP_SLIPPAGE_TICKS = 1;

/** What a sizing lacks (empty: every key stated, each a number 0 or more, the slippage at least its floor). */
function sizingErrors(z) {
  if (!z || typeof z !== 'object' || Array.isArray(z)) return [`no sizing: a policy's rulebook entry states every key (${SIZING_KEYS.join(', ')}); there is no code default`];
  const out = [];
  for (const k of SIZING_KEYS) {
    const v = z[k];
    if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0)) out.push(`sizing.${k}: ${v === undefined ? 'missing' : JSON.stringify(v)}; the policy's rulebook states it (no code default)`);
  }
  if (!out.length && z.stop_slippage_ticks < MIN_STOP_SLIPPAGE_TICKS) out.push(`sizing.stop_slippage_ticks: at least ${MIN_STOP_SLIPPAGE_TICKS}`);
  if (!out.length && !(Number.isInteger(z.min_contracts) && z.min_contracts >= 1)) out.push(`sizing.min_contracts: ${JSON.stringify(z.min_contracts)}; a whole number of contracts, 1 or more`);
  return out;
}

/** The sizing when it is whole, else throws naming what it lacks: a run is refused, never sized by a guess. */
function requireSizing(z, where = 'sizing') {
  const errors = sizingErrors(z);
  if (errors.length) throw new Error(`${where}: ${errors.join('; ')}`);
  return z;
}

const round2 = x => Math.round(x * 100) / 100;

function start(account) {
  const floor = account.starting_balance - account.max_loss;
  return {
    account: account.name,
    start: account.starting_balance,
    target: account.profit_target,
    maxLoss: account.max_loss,
    mode: account.max_loss_mode,
    dailyLimit: account.daily_loss_limit || 0,
    dailySoft: account.daily_loss_soft || 0,
    lossStreakStop: account.loss_streak_stop || 0, // 0: off (the rulebook's `off`)
    lossStreak: 0, // losing trades in a row this session
    consistency: account.consistency_pct || 0,
    sessions: account.sessions,
    balance: account.starting_balance,
    peak: account.starting_balance, // the highest balance reached (closed trades)
    eodHigh: account.starting_balance,
    floor,
    dayPnl: 0,
    dayStopped: false, // the firm's daily limit was hit: no trading until tomorrow
    days: [], // closed days' P&L
    status: 'active', // active | passed | blown | timeout
  };
}

const profit = s => s.balance - s.start;
const cushion = s => s.balance - s.floor;
const sessionsLeft = s => Math.max(0, s.sessions - s.days.length);

/** The loss streak after a trade closed at `gross` (before fees): a loss extends it, a win ends it, a scratch neither. */
const streakAfter = (streak, gross) => (gross < 0 ? (streak || 0) + 1 : gross > 0 ? 0 : streak || 0);

function applyClose(s, net, gross = net) {
  if (s.status !== 'active') return s;
  const n = { ...s, balance: round2(s.balance + net), dayPnl: round2(s.dayPnl + net), lossStreak: streakAfter(s.lossStreak, gross) };
  n.peak = Math.max(s.peak ?? s.start, n.balance);
  if (n.balance <= n.floor) return { ...n, status: 'blown' };
  if (n.dailyLimit > 0 && n.dayPnl <= -n.dailyLimit) n.dayStopped = true;
  return n;
}

/** Equity with an open trade at `openPnl` (unrealized, after fees) at or below the floor? */
function touches(s, openPnl) {
  return s.balance + openPnl <= s.floor;
}

/** Marks an intraday blow (equity reached the floor with a trade open). */
function blow(s) {
  return s.status === 'active' ? { ...s, status: 'blown' } : s;
}

/** Would an open trade at `openPnl` breach the firm's daily limit? */
function dailyBreached(s, openPnl = 0) {
  return s.dailyLimit > 0 && s.dayPnl + openPnl <= -s.dailyLimit;
}

/**
 * The profit a pass needs: the target, or more while the consistency rule
 * isn't met (the best day must be at most consistency% of the profit).
 */
function profitNeeded(s, days = s.days) {
  if (!s.consistency) return s.target;
  return Math.max(s.target, Math.max(0, ...days) / (s.consistency / 100));
}

function passes(s) {
  const p = profit(s);
  if (p < s.target) return false;
  if (!s.consistency) return true;
  const best = Math.max(0, ...s.days);
  return best <= (s.consistency / 100) * p + 1e-9;
}

function endDay(s) {
  if (s.status !== 'active') return s;
  const n = { ...s, days: [...s.days, s.dayPnl], dayPnl: 0, dayStopped: false, lossStreak: 0 };
  if (n.mode === 'trailing_eod') {
    n.eodHigh = Math.max(n.eodHigh, n.balance);
    n.floor = Math.min(n.start, n.eodHigh - n.maxLoss);
  }
  if (passes(n)) return { ...n, status: 'passed' };
  if (n.days.length >= n.sessions) return { ...n, status: 'timeout' };
  return n;
}

/** Why a new entry isn't allowed now, or null. */
function entryBlock(s) {
  if (s.status === 'passed') return 'the challenge is passed: protect it, no new entries';
  if (s.status !== 'active') return `the attempt is over (${s.status})`;
  if (s.dayStopped) return `the daily loss limit ($${s.dailyLimit}) was hit: no trading until the next session`;
  if (s.dailySoft > 0 && s.dayPnl <= -s.dailySoft) return `down $${-s.dayPnl} today, at the soft daily limit ($${s.dailySoft}): no new entries until the next session`;
  if (s.lossStreakStop > 0 && (s.lossStreak || 0) >= s.lossStreakStop) {
    return `${s.lossStreak} losing trade${s.lossStreak === 1 ? '' : 's'} in a row this session, at the loss streak stop (loss_streak_stop ${s.lossStreakStop}): no new entries until the next session`;
  }
  // At the target, stop once today's close would pass. When the best day is
  // still too large a share of the profit (consistency), the attempt has to
  // keep trading to pass at all: blocking it there would only run out the clock.
  if (profit(s) >= s.target && passes({ ...s, days: [...s.days, s.dayPnl] })) return 'at the profit target: no new entries (the pass is checked at end of day)';
  // Past the target with today the best day, each dollar more today raises the
  // best day by a dollar but what consistency allows by less: today can't help.
  if (s.consistency && profit(s) >= s.target && s.dayPnl > 0 && s.dayPnl >= Math.max(0, ...s.days)) {
    return `past the profit target with today the best day ($${round2(s.dayPnl)}): more today can't meet consistency (${s.consistency}% best day); entries resume next session`;
  }
  return null;
}

/**
 * Dollars a new trade may risk: a share of the cushion, under the dollar cap,
 * and (clock sizing) under what is still needed per session left. Never more
 * than the room to the floor or to the firm's daily limit.
 */
function budget(s, sizing) {
  // No whole sizing (the rulebook's), no budget: fails closed, never a code default.
  if (sizingErrors(sizing).length) return 0;
  const z = sizing;
  if (entryBlock(s)) return 0;
  let b = z.cushion_frac * cushion(s);
  if (z.cap_usd > 0) b = Math.min(b, z.cap_usd);
  // In a drawdown from the peak, risk half until it is recovered.
  if (z.drawdown_halve_usd > 0 && (s.peak ?? s.start) - s.balance >= z.drawdown_halve_usd) b /= 2;
  if (z.clock_k > 0) {
    const left = Math.max(1, sessionsLeft(s));
    // What a pass still needs, consistency included (0 would stop the attempt at the target).
    const need = Math.max(0, profitNeeded(s, [...s.days, s.dayPnl]) - profit(s));
    b = Math.min(b, (z.clock_k * need) / (left * z.r_per_session));
  }
  if (s.dailyLimit > 0) b = Math.min(b, s.dailyLimit + s.dayPnl);
  return Math.max(0, round2(b));
}

/** Whole contracts for a budget; 0 when even one risks more than guard x budget (no guard given: 0, none over budget). */
function contracts(dollars, riskPerContract, max, guard = 0, room = Infinity) {
  if (!(riskPerContract > 0) || !(dollars > 0)) return 0;
  if (!(typeof guard === 'number' && Number.isFinite(guard) && guard >= 0)) guard = 0;
  // Never a full stop's worth of risk that reaches the floor or the daily limit.
  const fit = Number.isFinite(room) ? Math.floor((room - 0.01) / riskPerContract) : Infinity;
  const n = Math.floor(dollars / riskPerContract);
  if (n >= 1) return Math.max(0, Math.min(n, max, fit));
  return riskPerContract <= guard * dollars && max >= 1 && fit >= 1 ? 1 : 0;
}

const CONTRACT_MODES = ['micro', 'mini', 'auto'];

/**
 * The contract and size for a trade in a micro/mini family (contracts.js
 * familyOf). The size is worked out in micros from the budget and the room
 * (contracts above), times `fraction` (the verdict's multiplier, rounded down:
 * 0 means no contract fits), then traded as:
 *   micro: that many micros;
 *   mini:  whole minis only (10 micros each, rounded down; 0 if under one);
 *   auto:  minis once the size reaches one mini, else micros.
 * Rounding is always down, so the mini trade never risks more than the micro
 * one would. legs: { micro: { root, tickValue, fee, max }, mini: { ... } | null }.
 * A contract's risk is its stop plus `slipTicks` (the stop's expected
 * slippage, sizing.stop_slippage_ticks) in ticks, plus fees both ways, so a
 * stopped trade's expected loss fits the budget and never reaches the room.
 * The floor (`minContracts`, sizing.min_contracts): the size traded, in micro-equivalents (a mini counts as `ratio`
 * micros; a contract with no family as one), is at least the floor, else null (the setup is skipped). In micro and auto
 * mode the floor is that many micros, and a whole mini clears any floor up to `ratio`. The floor never rounds a size up:
 * a budget or room that fits fewer sizes nothing. A missing or invalid floor sizes nothing (fails closed).
 * Returns { root, size, riskPerContract } or null when no contract fits.
 */
function contractPlan({ dollars, room = Infinity, stopTicks, legs, mode = 'auto', guard = 0, fraction = 1, ratio = 10, slipTicks = MIN_STOP_SLIPPAGE_TICKS, minContracts }) {
  if (!(Number.isInteger(minContracts) && minContracts >= 1)) return null;
  const mi = legs.micro;
  const mn = legs.mini;
  // Never less than the floor: a missing or smaller expected slippage only ever sizes the same or down.
  const slip = Math.max(MIN_STOP_SLIPPAGE_TICKS, Number(slipTicks) || 0);
  const riskOf = leg => (stopTicks + slip) * leg.tickValue + 2 * leg.fee;
  // A leg is priced only with its tick value and the account's fee (a null fee would count as $0): else it sizes nothing.
  const priced = leg => Boolean(leg) && leg.tickValue > 0 && typeof leg.fee === 'number' && Number.isFinite(leg.fee) && leg.fee >= 0;
  const canMini = mode !== 'micro' && priced(mn) && mn.max > 0;
  const canMicro = mode !== 'mini' && priced(mi) && mi.max > 0;
  // The most micros the account allows, counting a mini as `ratio` micros.
  const cap = Math.max(canMicro ? mi.max : 0, canMini ? mn.max * ratio : 0);
  if (!cap) return null;
  const unit = priced(mi) ? mi : { tickValue: mn.tickValue / ratio, fee: mn.fee / ratio };
  let n = contracts(dollars, riskOf(unit), cap, guard, room);
  // Never more than the whole budget; a fraction that isn't a number sizes nothing (fails closed).
  const f = typeof fraction === 'number' && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  if (f < 1 && n > 0) n = Math.floor(n * f);
  if (!n) return null;
  const minis = Math.floor(n / ratio);
  const useMini = canMini && (mode === 'mini' || (mode === 'auto' && (minis >= 1 || !canMicro)));
  if (useMini) {
    const size = Math.min(minis, mn.max);
    if (size < 1 || size * ratio < minContracts || size * riskOf(mn) > room - 0.01) return null;
    return { root: mn.root, size, riskPerContract: riskOf(mn) };
  }
  if (!canMicro) return null;
  const size = Math.min(n, mi.max);
  if (size < minContracts) return null;
  return { root: mi.root, size, riskPerContract: riskOf(mi) };
}

/**
 * Why contractPlan(args) sized nothing because of the floor alone, or null: without the floor (a floor of 1) a size
 * fits, but fewer than args.minContracts micro-equivalents. The reason names what the floor's size would risk against
 * the budget: the setup is a skip, never a tighter stop or a size rounded up.
 */
function floorReason(args) {
  const min = args.minContracts;
  if (!(Number.isInteger(min) && min > 1) || contractPlan(args)) return null;
  const under = contractPlan({ ...args, minContracts: 1 });
  if (!under) return null;
  // The floor in the contract that would trade: minis, the whole minis it takes (a mini is the ratio contractPlan sized with).
  const mini = under.root === (args.legs.mini && args.legs.mini.root);
  const need = mini ? Math.ceil(min / args.ratio) : min;
  const risk = round2(need * under.riskPerContract);
  // The cap that binds, as contractPlan applies them: the budget, the room (a cent kept off it), else the account's max.
  const f = typeof args.fraction === 'number' && args.fraction > 0 && args.fraction < 1 ? args.fraction : 1;
  const caps = [
    ...(risk > args.dollars * f ? [`over the $${round2(args.dollars * f).toFixed(2)} budget${f < 1 ? ` (${f} x $${round2(args.dollars).toFixed(2)}, the rulebook's multiplier)` : ''}`] : []),
    ...(Number.isFinite(args.room) && risk > args.room - 0.01 ? [`over the $${round2(args.room).toFixed(2)} room`] : []),
  ];
  return `${need} ${under.root}${mini ? ` (the floor of ${min} micro-equivalents)` : ''} at this stop risk $${risk.toFixed(2)}, ${caps.length ? caps.join(' and ') : 'more than the account\'s max contracts allow'}`
    + ` (the rulebook's min_contracts ${min}; ${under.size} ${under.root} would fit): skip; never a tighter stop`;
}

/** Dollars a stopped trade may lose without touching the floor or the firm's daily limit. */
function room(s) {
  const toDaily = s.dailyLimit > 0 ? s.dailyLimit + s.dayPnl : Infinity;
  return Math.max(0, Math.min(cushion(s), toDaily));
}

/** A short state summary for prompts, logs, and the gateway. */
function summary(s) {
  return {
    account: s.account, status: s.status, balance: s.balance, floor: s.floor, cushion: round2(cushion(s)),
    profit: round2(profit(s)), target: s.target, progress: round2(profit(s) / s.target),
    dayPnl: s.dayPnl, sessionsDone: s.days.length, sessionsLeft: sessionsLeft(s),
  };
}

/**
 * The attempt line's further facts, from one function the live prompt (autotrader accountText, through
 * prop/live-runner.js summaries), practice and the simulator (prop/attempts.js counters, the risk attribution)
 * read, so practice and the Monte Carlo see what live shows. Facts only: nothing here blocks or sizes (entryBlock,
 * budget and the gate do). Counts the caller knows (trades and losing trades closed today, the losing streak: from the
 * day's fills live, from the attempt in the simulator) are passed in; null when unknown.
 *   dailyRoom       dollars to the firm's daily limit (null without one)
 *   softStop, softRoom   the rulebook's soft daily stop and the dollars to it (null without one)
 *   day             the session of the attempt this is (1 on the first)
 *   consistencyCap  with a consistency rule and profit before today: the most today may make and stay within it
 *                   (pct x profit / (1 - pct), today counted in the profit); null otherwise
 *   needed          profit still needed to pass, consistency included
 */
function attemptFacts(s, { tradesToday = null, lossesToday = null, lossStreak = null } = {}) {
  const p = profit(s);
  const before = p - s.dayPnl;
  const c = s.consistency ? s.consistency / 100 : 0;
  const count = x => (Number.isInteger(x) && x >= 0 ? x : null);
  return {
    dailyRoom: s.dailyLimit > 0 ? round2(Math.max(0, s.dailyLimit + s.dayPnl)) : null,
    softStop: s.dailySoft > 0 ? s.dailySoft : null,
    softRoom: s.dailySoft > 0 ? round2(Math.max(0, s.dailySoft + s.dayPnl)) : null,
    tradesToday: count(tradesToday), lossesToday: count(lossesToday), lossStreak: count(lossStreak),
    day: s.days.length + 1, sessions: s.sessions, sessionsLeft: sessionsLeft(s),
    consistencyCap: c > 0 && c < 1 && before > 0 ? round2((c * before) / (1 - c)) : null,
    needed: round2(Math.max(0, profitNeeded(s, [...s.days, s.dayPnl]) - p)),
  };
}

/** A summary's sessions left; a live attempt past its training length (`sessions`) says so rather than "0 left". */
const sessionsText = m => (m.sessionsLeft > 0 || m.status !== 'active'
  ? `${m.sessionsLeft} session${m.sessionsLeft === 1 ? '' : 's'} left`
  : `${m.sessionsDone} sessions done, past the training length (the attempt runs on until it passes or blows)`);

module.exports = {
  SIZING_KEYS, MIN_STOP_SLIPPAGE_TICKS, sizingErrors, requireSizing, CONTRACT_MODES, start, applyClose, streakAfter, touches, blow, dailyBreached, endDay, entryBlock, budget, contracts, contractPlan, floorReason, room, summary, attemptFacts,
  profit, cushion, sessionsLeft, profitNeeded, sessionsText,
};
