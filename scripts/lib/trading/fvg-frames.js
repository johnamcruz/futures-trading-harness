'use strict';

/**
 * Fair value gaps per timeframe (the composed entry's scenario 2): on the COMPLETED 5m, 15m and 1h candles
 * as of a bar's close, the gaps still unfilled, each with whether the last completed candle of its timeframe retested
 * it. The base bars' own gaps stay the snapshot's (`m3.liquidity`); these are the same rule on each timeframe's candles.
 *
 * A gap is market-snapshot.js fvgAt on the timeframe's candles: three candles, the first's high under the third's low
 * (bullish; the mirror bearish), the middle one a strong displacement candle the gap's way (cisd.js strongCandle: body
 * at least 0.6 of its range, close in its extreme third, range at least 1 x the timeframe's ATR(14) as of the middle
 * candle, or its body engulfing the first's). It is known when the third candle completes. Over the last WINDOW
 * candles; the bars closed since the third candle (the source bars up to this bar's close, the candle forming
 * included) say what is left of it: `open` (not traded into), `partly` (traded into, not through: `unfilled` is the
 * part left) or filled (traded through: dropped). The last MAX of the unfilled ones, oldest first.
 *
 * `retest`, by the last completed candle of the timeframe when it came after the gap was known: `closed out` (traded
 * into the gap and closed back beyond it the gap's way: above a bullish gap, below a bearish one), `closed inside`
 * (traded into it and closed in it), null (didn't trade into it, or it is the gap's own third candle).
 *
 * The candles (candle-facts.js completedCandlesAt) follow the briefing's candle rule (briefingCandles): from the base
 * bars when the timeframe is whole base bars, else from 1m bars (a 1m lane's) closed by the bar's close, and only a
 * current candle (the one ending on the last boundary, or the one before while the 1m bars don't reach the close yet);
 * otherwise unavailable, with why: never approximated. Everything is as of base bar `at` (default the last): only the
 * bars closed by its close are read, so bars after it change nothing.
 *
 *   gapsOn({ src, upto, candles, j }, { window, max })  the unfilled gaps as of source bar upto
 *   fvgFrames({ bars, base, fine, frames, at })         the briefing's `fvgs`: { '5m': [...] | 'unavailable (...)', ... }
 */

const ind = require('./indicators');
const { fvgAt } = require('./market-snapshot');
const { completedCandlesAt, label } = require('./candle-facts');

const FRAMES = [5, 15, 60];
const WINDOW = 60;
const MAX = 3;

/** The unfilled gaps of candles[0..j] as of source bar `upto`, each with the last completed candle's retest. */
function gapsOn({ src, upto, candles, j }, { window = WINDOW, max = MAX } = {}) {
  const cs = candles.slice(0, j + 1);
  const atr = ind.atr(cs, 14);
  const last = cs[j];
  const out = [];
  for (let k = Math.max(2, cs.length - window); k < cs.length; k += 1) {
    const g = fvgAt(cs, k, atr);
    if (!g) continue;
    const bull = g.side === 'bullish';
    // How far the bars since the third candle have traded into it: the lowest low (bullish), the highest high (bearish).
    const later = src.slice(cs[k].last + 1, upto + 1);
    const reach = later.length ? (bull ? Math.min(...later.map(b => b.l)) : Math.max(...later.map(b => b.h))) : (bull ? Infinity : -Infinity);
    if (bull ? reach < g.low : reach > g.high) continue; // traded through: filled
    const open = bull ? reach >= g.high : reach <= g.low;
    const into = j > k && (bull ? last.l <= g.high : last.h >= g.low);
    const beyond = bull ? last.c > g.high : last.c < g.low;
    out.push({
      side: g.side, low: g.low, high: g.high, at: g.at, state: open ? 'open' : 'partly',
      ...(open ? {} : { unfilled: bull ? [g.low, reach] : [reach, g.high] }),
      retest: into ? (beyond ? 'closed out' : 'closed inside') : null,
    });
  }
  return out.slice(-max);
}

/** The briefing's `fvgs`: per timeframe the unfilled gaps on its completed candles, or why there are none to read. */
function fvgFrames({ bars, base, fine = null, frames = FRAMES, at = bars.length - 1 } = {}) {
  const out = {};
  for (const m of frames) {
    const c = completedCandlesAt({ bars, base, fine, minutes: m, at });
    out[label(m)] = c.unavailable ? `unavailable (${c.unavailable})` : gapsOn(c);
  }
  return out;
}

module.exports = { FRAMES, WINDOW, MAX, gapsOn, fvgFrames };
