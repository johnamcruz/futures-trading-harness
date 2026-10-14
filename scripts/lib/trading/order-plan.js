'use strict';

/**
 * Order arithmetic for a scan candidate, so no agent does it: a strategy's
 * stop and target distances (price points, from the scan) in whole ticks for
 * the brackets, the prices on the tick and on the right sides of the entry,
 * the dollar risk, and the place_order arguments with the rationale the order
 * gate reads (order-gate.js: the `setup:<name> <side>` tag first, then the
 * stop and target prices, which must agree with the brackets).
 *
 * Rounding, as the skills teach it (trade-session, broker-mcp): a stop away
 * from the entry, ceil(distance / tickSize), so a stop is never tighter than
 * the strategy's distance; a target toward the entry, floor. Pure: no files,
 * no clock.
 *
 *   stopTicks(distance, tickSize)          whole ticks >= 1, or null without a positive distance
 *   targetTicks(distance, tickSize)        whole ticks (floor), or null below one tick
 *   distanceText(points, ticks, root, spec) "8.4579 pts = 34 ticks ($17.00/MNQ contract)"
 *   ticksText(ticks, root, spec)           "34 ticks ($17.00/MNQ contract)"
 *   sideTarget(target, side)               a strategy's target level for one side: its own formula, or null
 *   buildPlan({...})                       { plan, args, line } (throws on anything it can't plan)
 */

const EPS = 1e-9;

/** Ticks for a stop distance (points): rounded away from the entry, at least 1. */
function stopTicks(distance, tickSize) {
  if (!(Number.isFinite(distance) && distance > 0 && tickSize > 0)) return null;
  return Math.max(1, Math.ceil(distance / tickSize - EPS));
}

/** Ticks for a target distance (points): rounded toward the entry; null when under one tick. */
function targetTicks(distance, tickSize) {
  if (!(Number.isFinite(distance) && distance > 0 && tickSize > 0)) return null;
  const t = Math.floor(distance / tickSize + EPS);
  return t >= 1 ? t : null;
}

const decimals = tick => (String(tick).split('.')[1] || '').length;
/** A price on the tick, as a number with the tick's decimals (no float noise). */
const onTick = (x, tick) => Number((Math.round(x / tick) * tick).toFixed(decimals(tick)));
const fmt = (x, tick) => x.toFixed(decimals(tick));
const usd = x => `$${x.toFixed(2)}`;
const pts = x => String(Math.round(x * 1e4) / 1e4);

/** Ticks with one contract's dollars at them: "34 ticks ($17.00/MNQ contract)". */
const ticksText = (ticks, root, spec) => `${ticks} ticks (${usd(ticks * spec.tickValue)}/${root} contract)`;

/** A distance in points and in ticks for the instrument, with a contract's dollars at those ticks. */
function distanceText(points, ticks, root, spec) {
  if (!spec || !ticks) return `${pts(points)} pts`;
  return `${pts(points)} pts = ${ticksText(ticks, root, spec)}`;
}

/**
 * A strategy's target level (`exit.target`, a distance expression) for one
 * side: a per-side target ({ long, short }) gives that side's own, a single one
 * is both sides'. Null without one or without a known side.
 */
function sideTarget(target, side) {
  if (target === null || target === undefined) return null;
  if (typeof target !== 'object') return String(target);
  const own = side === 'long' || side === 'short' ? target[side] : undefined;
  return own === null || own === undefined ? null : String(own);
}

/**
 * The target in ticks for a stop of `stop` ticks under the strategy's exit:
 * targetR (a bracket at R x the placed stop), a level (`exit.target`: the
 * scan's targetDistance), or none (a trailing exit: stop only).
 * Returns { ticks, why } or { ticks: null, why }.
 */
function targetFor(exit, stop, targetDistance, tickSize) {
  const x = exit || {};
  if (x.targetR !== null && x.targetR !== undefined) {
    const t = targetTicks(x.targetR * stop * tickSize, tickSize);
    return { ticks: t, why: `${x.targetR}R` };
  }
  if (x.target !== null && x.target !== undefined) {
    const t = targetTicks(targetDistance, tickSize);
    if (!t) throw new Error(`the strategy's target level has no distance of a tick or more on this bar (targetDistance ${targetDistance})`);
    return { ticks: t, why: `the level ${pts(targetDistance)} pts away` };
  }
  if (x.trailActivateR !== null && x.trailActivateR !== undefined) {
    return { ticks: null, why: `no target order: trail from ${x.trailActivateR}R giving back ${x.trailGivebackR ?? '-'}R` };
  }
  return { ticks: null, why: 'no target in the strategy\'s exit' };
}

/**
 * The order for one setup:
 *   name        the setup tag's strategy (a policy strategy for its verdict)
 *   side        'long' | 'short'
 *   contract    the root to trade (MNQ, NQ); spec its tick specs (contracts.js)
 *   entryRef    the signal bar's close; stop ticks (stopTicks above, or a verdict's)
 *   exit, targetDistance   the strategy's exit plan (evaluator.js exitPlan) and the scan's level distance
 *   stopDistance  the strategy's stop in points (for the text), minRR (its risk.min_rr, to say when the
 *   target in whole ticks falls under it), size, sizeWhy, accountId?, notes[]
 * Market entry with brackets: the stop and target brackets in ticks, the
 * rationale's stop and target prices that many ticks from the entry
 * reference, so the gate's bracket-to-price span check holds exactly.
 */
function buildPlan({ name, side, contract, spec, entryRef, stop, stopDistance = null, exit, targetDistance = null, minRR = null, size, sizeWhy, accountId, notes = [] }) {
  const sign = side === 'long' ? 1 : side === 'short' ? -1 : 0;
  if (!sign) throw new Error(`side must be long or short (got ${side})`);
  if (!spec) throw new Error(`no tick specs for ${contract}`);
  if (!(Number.isInteger(stop) && stop >= 1)) throw new Error(`the stop must be a whole number of ticks, 1 or more (got ${stop})`);
  if (!(Number.isInteger(size) && size >= 1)) throw new Error(`no size: ${sizeWhy || 'nothing fits'}`);
  if (!Number.isFinite(entryRef)) throw new Error('no entry reference (the signal bar\'s close)');
  const tick = spec.tickSize;
  const entry = onTick(entryRef, tick);
  const stopPrice = onTick(entry - sign * stop * tick, tick);
  const target = targetFor(exit, stop, targetDistance, tick);
  const targetPrice = target.ticks ? onTick(entry + sign * target.ticks * tick, tick) : null;
  const perContract = stop * spec.tickValue;
  const risk = perContract * size;
  const rationale = `setup:${name} ${side} at market from ${fmt(entry, tick)} (the signal bar's close), stop ${fmt(stopPrice, tick)} (${stop} ticks)`
    + `${targetPrice !== null ? `, target ${fmt(targetPrice, tick)} (${target.ticks} ticks)` : ''}, ${size} ${contract} risks ${usd(risk)}`;
  const args = {
    ...(Number.isInteger(accountId) ? { accountId } : {}),
    contractId: contract, side: sign > 0 ? 'buy' : 'sell', type: 'market', size,
    stopLossBracket: { ticks: stop, type: 'stop' },
    ...(target.ticks ? { takeProfitBracket: { ticks: target.ticks, type: 'limit' } } : {}),
    rationale,
  };
  const where = sign > 0 ? 'below' : 'above';
  const line = [
    `${name} ${side}: ${size} ${contract} at market (entry ref ${fmt(entry, tick)})`,
    `stop ${fmt(stopPrice, tick)}, ${where} the entry: ${stopDistance !== null ? distanceText(stopDistance, stop, contract, spec) : ticksText(stop, contract, spec)}, stopLossBracket.ticks ${stop}`,
    target.ticks ? `target ${fmt(targetPrice, tick)} (${target.why}): ${target.ticks} ticks, takeProfitBracket.ticks ${target.ticks}` : target.why,
    `risk ${usd(risk)} = ${size} x ${stop} ticks x ${usd(spec.tickValue)}/tick (before fees)`,
    `size ${size}: ${sizeWhy}`,
    // A fact the plan needs, not advice: the target as placed (whole ticks) against the strategy's min R:R.
    ...(target.ticks && Number.isFinite(minRR) && target.ticks < minRR * stop - EPS ? [`the target is ${(target.ticks / stop).toFixed(2)}R in whole ticks, under the strategy's min_rr ${minRR}`] : []),
    ...notes,
  ].join(' | ');
  return {
    plan: { strategy: name, side, contract, size, entry, stopPrice, stopTicks: stop, targetPrice, targetTicks: target.ticks, riskUsd: Number(risk.toFixed(2)) },
    args,
    line,
  };
}

module.exports = { stopTicks, targetTicks, ticksText, distanceText, targetFor, sideTarget, buildPlan };
