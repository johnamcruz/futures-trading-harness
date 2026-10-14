'use strict';

/**
 * Fibonacci retracement of a price leg: the one home for the ratios the
 * `fib-retracement` skill teaches and the CISD facts and the `cisd_ote`
 * strategy use (trading/cisd.js). Pure arithmetic, no bars.
 *
 * A leg runs from its ORIGIN (where the move started: a bullish leg's low, a
 * bearish leg's high) to its EXTREME (where it ended: the bullish leg's high,
 * the bearish leg's low). A retracement ratio r is measured back from the
 * extreme toward the origin: r = 0 is the extreme, r = 1 the origin, so a
 * level is  extreme - r * (extreme - origin)  for either direction.
 *
 *   LEVELS                the ratios a read names: 0.5, 0.618, 0.705, 0.79
 *   OTE                   the golden zone (optimal trade entry): 0.62 to 0.79, mid 0.705
 *   priceAt(leg, r)       the price at retracement r of the leg
 *   retracementOf(leg, p) how far back p sits (0 at the extreme, 1 at the origin; < 0 beyond the extreme, > 1 beyond the origin)
 *   levels(leg)           { '0.5': p, '0.618': p, '0.705': p, '0.79': p }
 *   zone(leg, from, to)   { top, bottom, mid, from, to } the band between two ratios (OTE by default)
 *   inZone(leg, p)        whether p is inside the OTE band (edges included)
 *   halfOf(leg, p)        'premium' (above the leg's 50% level), 'discount' (below it) or 'equilibrium' (on it)
 *
 * The ratios are hypotheses the skill and the census test, not facts about
 * markets (docs/research/cisd-ote-textbook.md).
 */

const LEVELS = Object.freeze([0.5, 0.618, 0.705, 0.79]);
const OTE = Object.freeze({ from: 0.62, to: 0.79, mid: 0.705 });

const finite = x => typeof x === 'number' && Number.isFinite(x);

/** A leg { origin, extreme } with two different finite prices, else an error. */
function check(leg) {
  if (!leg || !finite(leg.origin) || !finite(leg.extreme)) throw new Error('fib: a leg needs a finite origin and extreme');
  if (leg.origin === leg.extreme) throw new Error('fib: a leg needs an origin and an extreme that differ');
  return leg;
}

/** The leg's direction: 'bullish' (extreme above the origin) or 'bearish'. */
const direction = leg => (check(leg).extreme > leg.origin ? 'bullish' : 'bearish');

/** The price at retracement r (0 = the extreme, 1 = the origin). */
function priceAt(leg, r) {
  check(leg);
  return leg.extreme - r * (leg.extreme - leg.origin);
}

/** How far back from the extreme p sits, as a ratio of the leg (0 = the extreme, 1 = the origin). */
function retracementOf(leg, p) {
  check(leg);
  return (leg.extreme - p) / (leg.extreme - leg.origin);
}

/** Each named level's price, keyed by its ratio as text. */
function levels(leg) {
  return Object.fromEntries(LEVELS.map(r => [String(r), priceAt(leg, r)]));
}

/** The band between ratios `from` and `to` (OTE by default): its top and bottom prices and its mid (OTE.mid for the default band). */
function zone(leg, from = OTE.from, to = OTE.to) {
  const a = priceAt(leg, from);
  const b = priceAt(leg, to);
  const midRatio = from === OTE.from && to === OTE.to ? OTE.mid : (from + to) / 2;
  return { top: Math.max(a, b), bottom: Math.min(a, b), mid: priceAt(leg, midRatio), from, to };
}

/** Whether p is inside the OTE band (its edges count). */
function inZone(leg, p) {
  const z = zone(leg);
  return finite(p) && p >= z.bottom && p <= z.top;
}

/** Premium above the leg's 50% level, discount below it, equilibrium on it (by price, whichever way the leg runs). */
function halfOf(leg, p) {
  const half = priceAt(leg, 0.5);
  return p > half ? 'premium' : p < half ? 'discount' : 'equilibrium';
}

module.exports = { LEVELS, OTE, direction, priceAt, retracementOf, levels, zone, inZone, halfOf };
