'use strict';

/**
 * A prop-firm challenge as a state machine over one attempt, from an account
 * profile (accounts/<name>/ACCOUNT.md). Pure: the env, the backtester, the
 * runner, and the gateway all drive the same functions.
 *
 *   start(account)                  a fresh attempt
 *   applyClose(s, net)              a closed trade's net P&L (after fees)
 *   touches(s, openPnl)             would equity at openPnl reach the floor?
 *   endDay(s)                       the session closed: floor, pass, timeout
 *   entryBlock(s)                   why no new entry now (or null)
 *   budget(s, sizing)               dollars a new trade may risk
 *   contracts(budget, riskPerContract, max, guard, room)
 *
 * The floor (max_loss_mode trailing_eod) trails the highest end-of-day
 * balance by max_loss and stops rising at the starting balance. Equity at or
 * below it at any moment is a blow. A pass is checked at the end of a day:
 * profit at or above the target, and the best day at most consistency_pct of
 * the profit. A firm daily limit stops trading for the rest of the day; it
 * doesn't end the attempt. The harness's soft daily limit only stops new
 * entries.
 */

const DEFAULT_SIZING = {
  cushion_frac: 0.2, // risk at most this share of the cushion on one trade
  cap_usd: 0, // and at most this many dollars (0 = no cap)
  clock_k: 0, // > 0: also at most k x (target - profit) / (sessions left x r_per_session)
  r_per_session: 0.3,
  min_size_guard: 1.5, // skip when one contract risks more than guard x budget
  drawdown_halve_usd: 0, // > 0: halve the budget while the balance is at least this far below its peak
};

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

function applyClose(s, net) {
  if (s.status !== 'active') return s;
  const n = { ...s, balance: round2(s.balance + net), dayPnl: round2(s.dayPnl + net) };
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

function passes(s) {
  const p = profit(s);
  if (p < s.target) return false;
  if (!s.consistency) return true;
  const best = Math.max(0, ...s.days);
  return best <= (s.consistency / 100) * p + 1e-9;
}

function endDay(s) {
  if (s.status !== 'active') return s;
  const n = { ...s, days: [...s.days, s.dayPnl], dayPnl: 0, dayStopped: false };
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
  if (profit(s) >= s.target) return 'at the profit target: no new entries (the pass is checked at end of day)';
  return null;
}

/**
 * Dollars a new trade may risk: a share of the cushion, under the dollar cap,
 * and (clock sizing) under what is still needed per session left. Never more
 * than the room to the floor or to the firm's daily limit.
 */
function budget(s, sizing = {}) {
  const z = { ...DEFAULT_SIZING, ...sizing };
  if (entryBlock(s)) return 0;
  let b = z.cushion_frac * cushion(s);
  if (z.cap_usd > 0) b = Math.min(b, z.cap_usd);
  // In a drawdown from the peak, risk half until it is recovered.
  if (z.drawdown_halve_usd > 0 && (s.peak ?? s.start) - s.balance >= z.drawdown_halve_usd) b /= 2;
  if (z.clock_k > 0) {
    const left = Math.max(1, sessionsLeft(s));
    const need = Math.max(0, s.target - profit(s));
    b = Math.min(b, (z.clock_k * need) / (left * z.r_per_session));
  }
  if (s.dailyLimit > 0) b = Math.min(b, s.dailyLimit + s.dayPnl);
  return Math.max(0, round2(b));
}

/** Whole contracts for a budget; 0 when even one risks more than guard x budget. */
function contracts(dollars, riskPerContract, max, guard = DEFAULT_SIZING.min_size_guard, room = Infinity) {
  if (!(riskPerContract > 0) || !(dollars > 0)) return 0;
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
 * (contracts above), times `fraction` (a half-size verdict), then traded as:
 *   micro: that many micros;
 *   mini:  whole minis only (10 micros each, rounded down; 0 if under one);
 *   auto:  minis once the size reaches one mini, else micros.
 * Rounding is always down, so the mini trade never risks more than the micro
 * one would. legs: { micro: { root, tickValue, fee, max }, mini: { ... } | null }.
 * Returns { root, size, riskPerContract } or null when no contract fits.
 */
function contractPlan({ dollars, room = Infinity, stopTicks, legs, mode = 'auto', guard = DEFAULT_SIZING.min_size_guard, fraction = 1, ratio = 10 }) {
  const mi = legs.micro;
  const mn = legs.mini;
  const riskOf = leg => stopTicks * leg.tickValue + 2 * leg.fee;
  const canMini = mode !== 'micro' && mn && mn.max > 0;
  const canMicro = mode !== 'mini' && mi && mi.max > 0;
  // The most micros the account allows, counting a mini as `ratio` micros.
  const cap = Math.max(canMicro ? mi.max : 0, canMini ? mn.max * ratio : 0);
  if (!cap) return null;
  const unit = mi || { tickValue: mn.tickValue / ratio, fee: mn.fee / ratio };
  let n = contracts(dollars, riskOf(unit), cap, guard, room);
  if (fraction < 1 && n > 0) n = Math.max(1, Math.floor(n * fraction));
  if (!n) return null;
  const minis = Math.floor(n / ratio);
  const useMini = canMini && (mode === 'mini' || (mode === 'auto' && (minis >= 1 || !canMicro)));
  if (useMini) {
    const size = Math.min(minis, mn.max);
    if (size < 1 || size * riskOf(mn) > room - 0.01) return null;
    return { root: mn.root, size, riskPerContract: riskOf(mn) };
  }
  if (!canMicro) return null;
  return { root: mi.root, size: Math.min(n, mi.max), riskPerContract: riskOf(mi) };
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

module.exports = {
  DEFAULT_SIZING, CONTRACT_MODES, start, applyClose, touches, blow, dailyBreached, endDay, entryBlock, budget, contracts, contractPlan, room, summary,
  profit, cushion, sessionsLeft,
};
