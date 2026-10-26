'use strict';

/**
 * The bracket rule (the owner, 2026-10-26: "always manage risk using stop loss brackets and adjust it accordingly
 * using modify order"): a position's risk is its entry's own brackets, its stop-loss leg (and, where the exit plan has
 * one, its take-profit leg), sent with the entry; they are adjusted with modify_order. A separate `[protect]` order
 * beside them is refused:
 *
 *   - a `[protect]` limit (limit, join_bid, join_ask: a target) always: the interface links no stand-alone order to the
 *     stop (no OCO), so when the stop fills first it keeps working and can open a new, unprotected position (and the
 *     other way around). The target is the entry's takeProfitBracket, moved with modify_order; under a runner-managed
 *     exit (trail, target_then_trail) the runner owns the exit and wants none.
 *   - a `[protect]` stop while the working stops already cover the whole position: modify that stop instead. A
 *     position with no working stop, or stops for less than its size (a broker fault, a lost bracket), still gets one
 *     for what is uncovered: that is risk reduction (the gateway's exposure check caps its size).
 *
 * No resting exit either (the owner, 2026-10-26: "Yes refuse resting limit exits while stop is working. Maybe just use
 * trailing stop"): an `[exit]` that can rest in the book is a target by another name. Every limit / join_bid /
 * join_ask `[exit]` is refused, from the order alone (hook and gateway): whether a limit would fill at once can't be
 * told reliably at order time (a closed bar's close is not the bid or ask the order meets, and it can be stale), and
 * a market `[exit]` closes now without the doubt. Refused with or without a working stop: under the bracket invariant
 * a position has one (the runner restores a lost one within a poll, and a resting exit would sit beside it, unlinked).
 * Profit is taken by trailing the bracket's stop with modify_order; a discretionary close is a market `[exit]`.
 *
 * Never refused here: a market `[exit]` (whole or part), a market `[protect]`, partial_close_position, close_position,
 * cancels, stop moves. Hard (no skipChecks): an orphaned order can blow the account.
 *
 *   protectRefusal({ rationale, type, covered = null, size = null })   message | null
 *     covered: the working stops' size on the position's contract and protective side (the gateway's read), or null
 *     where it is unknown (the hook: no account read, so only the limit rule); size: the open position's size.
 *   restingExitRefusal({ rationale, type })   message | null
 */

const PROTECT = /^\s*\[protect\]/i;
const EXIT = /^\s*\[exit\]/i;
// By name (the interface's place_order types) or by the broker's numeric type ids the gate reads orders with.
const LIMIT_TYPES = new Set(['limit', 'join_bid', 'join_ask', '1', '6', '7']);
const STOP_TYPES = new Set(['stop', 'trailing_stop', 'stop_limit', '3', '4', '5']);

const LIMIT_REFUSAL = 'A [protect] limit is a stand-alone target: no order links it to the stop, so whichever fills first leaves the other working to open a new, unprotected position. '
  + 'Risk is managed with the entry\'s brackets: modify the bracket\'s stop/target with modify_order (under a trail or target_then_trail exit the runner manages the exit and wants no target). '
  + 'To take profit or get out now, send an [exit] (market), partial_close_position or close_position.';

function protectRefusal({ rationale, type, covered = null, size = null } = {}) {
  if (!PROTECT.test(String(rationale || ''))) return null;
  const t = String(type ?? '').trim().toLowerCase();
  if (LIMIT_TYPES.has(t)) return LIMIT_REFUSAL;
  if (!STOP_TYPES.has(t) || covered === null) return null;
  const need = Math.abs(Number(size));
  if (!(Number(covered) >= need) || !(need > 0)) return null;
  return `The position (${need}) already has working stops for ${covered}: a second [protect] stop is a separate order beside its bracket. `
    + 'Modify the bracket\'s stop/target with modify_order (toward the market only). A [protect] stop goes only when no working stop covers the position (a lost bracket).';
}

const RESTING_REFUSAL = 'A limit or join [exit] can rest in the book: a stand-alone target that outlives the stop if the stop fills first. '
  + 'Take profit by trailing the bracket stop with modify_order (toward the market), or close now with a market [exit] (or partial_close_position / close_position).';

function restingExitRefusal({ rationale, type } = {}) {
  if (!EXIT.test(String(rationale || ''))) return null;
  const t = String(type ?? '').trim().toLowerCase();
  return LIMIT_TYPES.has(t) ? RESTING_REFUSAL : null;
}

module.exports = { protectRefusal, restingExitRefusal, LIMIT_REFUSAL, RESTING_REFUSAL };
