'use strict';

/**
 * Whether the day's trend has declared itself a side's way at a closed bar: the trend-vs-range skill's "trend declared
 * vs not yet" facts, as code computes them (never the model's claim). Each is side-signed (+ is the side's way) and in
 * ATR(14) of the bars it reads, with the false-start detection study's definitions (its fact bins read these values):
 *
 *   vwapAtr     (close - RTH VWAP) / ATR, signed by the side: the snapshot's own distance (market-snapshot.js
 *               vwap.distanceAtr, the RTH VWAP's in RTH), so the briefing states one value
 *   ema20Atr    (close - EMA20) / ATR, signed by the side
 *   overnight   the close against the finished overnight range, side-relative: 'broke out its way' (at or beyond
 *               the edge the side heads to), 'broke out against' (beyond the side's back edge), else inside it: 'front
 *               third' (nearest the side's edge), 'middle third' or 'back third'; null without the range
 *   dayMoveAtr  (close - the RTH open) / ATR, signed by the side
 *   regime      the computed regime against the side: 'with' (trend-up for a long, trend-down for a short),
 *               'against' (the other trend), else its name (range, transition)
 *
 * Pure: the caller hands it the bar's values (the briefing's: its close, ATR(14), RTH VWAP distance, EMA20, the day context's
 * RTH open and overnight range, the regime), each from closed bars only.
 *
 *   declaredFacts({ price, atr, vwapAtr, ema20, open, overnight, regime })   { long, short } | null (no ATR or price)
 *   declaredLine(declared, tf)                                                 the briefing summary's line, or null
 */

const SIDES = ['long', 'short'];
const THIRDS = ['back third', 'middle third', 'front third'];

const finite = x => typeof x === 'number' && Number.isFinite(x);
const round2 = x => (finite(x) ? Math.round(x * 100) / 100 : null);
const sign = side => (side === 'long' ? 1 : -1);

/** The close's place in the overnight range for a side: 0 the side's back edge, 1 the edge it heads to. */
function overnightPlace(price, overnight, side) {
  if (!overnight || !finite(overnight.high) || !finite(overnight.low) || !(overnight.high > overnight.low)) return null;
  const pos = side === 'long' ? (price - overnight.low) / (overnight.high - overnight.low) : (overnight.high - price) / (overnight.high - overnight.low);
  if (pos >= 1) return 'broke out its way';
  if (pos < 0) return 'broke out against';
  return THIRDS[Math.floor(pos * THIRDS.length)];
}

function regimeFor(regime, side) {
  if (typeof regime !== 'string' || !regime) return null;
  const way = side === 'long' ? 'trend-up' : 'trend-down';
  const other = side === 'long' ? 'trend-down' : 'trend-up';
  return regime === way ? 'with' : regime === other ? 'against' : regime;
}

function declaredFacts({ price, atr, vwapAtr = null, ema20 = null, open = null, overnight = null, regime = null } = {}) {
  if (!finite(price) || !finite(atr) || !(atr > 0)) return null;
  const dist = (level, side) => (finite(level) ? round2((sign(side) * (price - level)) / atr) : null);
  return Object.fromEntries(SIDES.map(side => [side, {
    vwapAtr: finite(vwapAtr) ? round2(sign(side) * vwapAtr) : null,
    ema20Atr: dist(ema20, side),
    overnight: overnightPlace(price, overnight, side),
    dayMoveAtr: dist(open, side),
    regime: regimeFor(regime, side),
  }]));
}

const signed = x => (x === null ? '?' : `${x > 0 ? '+' : ''}${x}`);
const sideText = f => `RTH VWAP ${signed(f.vwapAtr)}, EMA20 ${signed(f.ema20Atr)}, overnight range ${f.overnight || '?'}, day's move ${signed(f.dayMoveAtr)}, regime ${f.regime || '?'}`;

/** The summary line: each side's facts, in the base timeframe's ATR(14) (null: none, outside RTH or no facts). */
function declaredLine(d, tf = '3m') {
  if (!d || !d.long || !d.short || d.long.vwapAtr === null) return null;
  return `- Trend declared? (in ${tf} ATR(14), + = the side's way; \`trend-vs-range\`): long ${sideText(d.long)}; short ${sideText(d.short)}.`;
}

module.exports = { declaredFacts, declaredLine, overnightPlace };
