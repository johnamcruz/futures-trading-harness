'use strict';

/**
 * A protected swing's status: the one predicate every printer of "holds" / "broken" uses (the 3m Market state machine,
 * the break record's protected swings on the 3m and the 15m, the Break quality line, the Manage read). The owner's rule:
 * a protected level X of a leg on side S (up: its HL; down: its LH) is broken at the first candle of its own frame whose
 * close is through X against the leg by more than the tie, equalAtr x ATR(14) at that candle (R1: a wick never counts;
 * a close past by exactly the tie holds; a non-finite ATR is a tie of 0), and once broken it is broken at every later
 * candle (R2). A close back the old way afterwards is a fact about the break's follow-through; it restores nothing here
 * (the 3m machine's hand-back is the machine's own rule, structure-layers.js, and its line says the level was broken).
 * Pure: no config read, no clock; equalAtr is always passed in (config/analysis.json marketState.equalAtr).
 *
 *   through(close, level, legSide, tol)       a close through `level` against a leg on `legSide` ('up' | 'down') by more
 *                                             than `tol` (R1)
 *   tieAt(atr, j, equalAtr)                   the tie at candle j: equalAtr x atr[j], 0 when that ATR is not finite
 *   firstCloseThrough(candles, o)             the first index after o.after whose close is through o.level past the tie
 *                                             at that candle, or -1 (R1; R2: the first is the break) o { level, legSide,
 *                                             after, atr, equalAtr }
 *   statusOf(candles, o)                      { broken, brokenI, tied (a close beyond the level inside the tie and no
 *                                             break), backI (the first close back the leg's way past the tie after
 *                                             brokenI, or -1) }, the same o
 */

/** The leg's sign: +1 up, -1 down (as structure-layers.js sgn); anything else throws. */
function sideOf(legSide) {
  if (legSide !== 'up' && legSide !== 'down') throw new Error(`protected-status: legSide must be 'up' or 'down' (got ${legSide})`);
  return legSide === 'up' ? 1 : -1;
}

/** A close through `level` against a leg on `legSide` by more than `tol` (R1). */
function through(close, level, legSide, tol) {
  const s = sideOf(legSide);
  if (!Number.isFinite(close) || !Number.isFinite(level)) return false;
  return s * (level - close) > tol;
}

/** The tie at candle j: equalAtr x ATR14[j], 0 when the ATR is not finite. */
function tieAt(atr, j, equalAtr) {
  if (!Number.isFinite(equalAtr)) throw new Error('protected-status: equalAtr is required (config/analysis.json marketState, never a literal)');
  const a = Array.isArray(atr) ? atr[j] : NaN;
  return equalAtr * (Number.isFinite(a) ? a : 0);
}

/** The first candle after `after` whose close is through the level past the tie, or -1 (R1, R2). */
function firstCloseThrough(candles, { level, legSide, after = -1, atr, equalAtr } = {}) {
  sideOf(legSide);
  tieAt(atr, 0, equalAtr);
  for (let j = Math.max(0, after + 1); j < candles.length; j += 1) if (through(candles[j].c, level, legSide, tieAt(atr, j, equalAtr))) return j;
  return -1;
}

/** The level's status on these candles (R1, R2), with the tie before any break and the first close back after it. */
function statusOf(candles, { level, legSide, after = -1, atr, equalAtr } = {}) {
  const s = sideOf(legSide);
  const brokenI = firstCloseThrough(candles, { level, legSide, after, atr, equalAtr });
  let tied = false;
  if (brokenI < 0) for (let j = Math.max(0, after + 1); j < candles.length && !tied; j += 1) if (Number.isFinite(candles[j].c) && s * (level - candles[j].c) > 0) tied = true;
  let backI = -1;
  if (brokenI >= 0) for (let j = brokenI + 1; j < candles.length && backI < 0; j += 1) if (Number.isFinite(candles[j].c) && s * (candles[j].c - level) > tieAt(atr, j, equalAtr)) backI = j;
  return { broken: brokenI >= 0, brokenI, tied, backI };
}

module.exports = { through, tieAt, firstCloseThrough, statusOf };
