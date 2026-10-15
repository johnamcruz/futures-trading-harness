'use strict';

/**
 * The momentum read, a bar read only (the owner's decision D4): a completed candle has momentum when its range is at
 * least 1 x ATR(14) of its timeframe (as of the candle before it), its close is in the far third of its range, and
 * its volume is at least its timeframe's average (the mean of up to the 20 candles before it, at least 5:
 * candle-facts.js volRatio). The trend (ADX(14), EMA20 against EMA50) is a separate read with its own facts
 * (`m3.trend`, `m15.frame`, `h1.h1`), never part of this one: pairing them is the model's choice.
 *
 * candle-facts.js puts it on each completed candle (`m3.candles.<tf>.momentum`) from the rounded values it shows, so a
 * read stated from the text checks against the same numbers.
 *
 *   momentumRead({ rangeAtr, closeLocation, volRatio })   'up' (close in the top third), 'down' (the bottom third),
 *                                                          'none' (no momentum), or null (an input is missing: unknown)
 */

const RANGE_ATR = require('../tunables').analysis().momentum.rangeAtr; // config/analysis.json momentum
const VOL_RATIO = require('../tunables').analysis().momentum.volRatio;

function momentumRead(c) {
  if (!c || !Number.isFinite(c.rangeAtr) || !Number.isFinite(c.volRatio) || !c.closeLocation) return null;
  if (!(c.rangeAtr >= RANGE_ATR && c.volRatio >= VOL_RATIO)) return 'none';
  return c.closeLocation === 'top' ? 'up' : c.closeLocation === 'bottom' ? 'down' : 'none';
}

module.exports = { RANGE_ATR, VOL_RATIO, momentumRead };
