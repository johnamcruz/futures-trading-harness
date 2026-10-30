'use strict';

/**
 * Deterministic market-regime classification from closed bars, so the agents
 * start from the same regime facts every cycle and strategies can declare
 * which regimes they fit (STRATEGY.md `regimes:`).
 *
 * Primary regime (one of):
 *   trend-up / trend-down  ADX(14) >= trendAdx, EMA(20) sloping, close on the
 *                          same side of EMA(50), and few VWAP crosses
 *   range                  ADX(14) < rangeAdx, or price chopping through VWAP
 *   transition             anything in between (trend forming or fading)
 * Volatility: high / normal / low, from ATR(14) vs its own recent average.
 * Tags used for matching: the primary regime, "trend" for either trend
 * direction, and "<volatility>-vol".
 */

const ind = require('./indicators');
const { GLOBEX_OPEN_MIN } = require('./clock'); // the session boundaries' one home

// config/analysis.json regime (slopeAtr: EMA(20) move over slopeBars, in ATR(14) units); minBars and minBarsOverSlope
// are the bars a classification needs, max(minBars, slopeBars + minBarsOverSlope).
const { minBars: MIN_BARS, minBarsOverSlope: MIN_BARS_OVER_SLOPE, ...REGIME_DEFAULTS } = require('../tunables').analysis().regime;
const REGIME_PARAMS = { ...REGIME_DEFAULTS };

const PRIMARY = ['trend-up', 'trend-down', 'range', 'transition'];
const TAGS = [...PRIMARY, 'trend', 'high-vol', 'normal-vol', 'low-vol'];

const finite = v => (Number.isFinite(v) ? v : null);
const round = (x, d = 3) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

/**
 * Closes crossing a VWAP from bar `from` on (each bar against the one before; bars without a VWAP skipped): many
 * crosses = rotation, few = trend. The regime counts them on the session VWAP; the snapshot shows its counts with it.
 */
function vwapCrosses(bars, vwap, from) {
  let crosses = 0;
  for (let i = Math.max(1, from); i < bars.length; i += 1) {
    const a = bars[i - 1].c - vwap[i - 1];
    const b = bars[i].c - vwap[i];
    if (Number.isFinite(a) && Number.isFinite(b) && a !== 0 && Math.sign(a) !== Math.sign(b)) crosses += 1;
  }
  return crosses;
}

/** The indicators the regime reads, over all the bars (each causal from the first bar). */
function seriesOf(bars) {
  const closes = bars.map(b => b.c);
  return {
    closes,
    adx: ind.adx(bars, 14),
    atr: ind.atr(bars, ind.ATR_PERIOD),
    ema20: ind.ema(closes, 20),
    ema50: ind.ema(closes, 50),
    vwap: ind.anchoredVwap(bars, GLOBEX_OPEN_MIN), // session VWAP is defined around the clock
  };
}

/** The primary regime at bar i from the series and its VWAP crosses: { primary, adxNow, atrNow, slope, above50 } or null. */
function primaryAt(x, i, crosses, p) {
  const adxNow = finite(x.adx[i]);
  const atrNow = finite(x.atr[i]);
  if (adxNow === null || atrNow === null || atrNow <= 0) return null;
  const slope = (x.ema20[i] - x.ema20[i - p.slopeBars]) / atrNow;
  const above50 = x.closes[i] > x.ema50[i];
  let primary = 'transition';
  if (adxNow >= p.trendAdx && crosses <= p.maxTrendCrosses && slope >= p.slopeAtr && above50) primary = 'trend-up';
  else if (adxNow >= p.trendAdx && crosses <= p.maxTrendCrosses && slope <= -p.slopeAtr && !above50) primary = 'trend-down';
  else if (adxNow < p.rangeAdx || crosses >= p.rangeCrosses) primary = 'range';
  return { primary, adxNow, atrNow, slope, above50 };
}

const needOf = p => Math.max(MIN_BARS, p.slopeBars + MIN_BARS_OVER_SLOPE);

/** Classify normalized bars (oldest first). Returns { primary, volatility, tags, metrics } or null if too few bars. */
function classifyRegime(bars, overrides = {}) {
  const p = { ...REGIME_PARAMS, ...overrides };
  const n = bars.length;
  if (n < needOf(p)) return null;
  const i = n - 1;
  const x = seriesOf(bars);
  const crosses = vwapCrosses(bars, x.vwap, n - p.crossBars);
  const at = primaryAt(x, i, crosses, p);
  if (!at) return null;
  const { primary, adxNow, atrNow, slope, above50 } = at;
  const atrWindow = x.atr.slice(Math.max(0, n - p.volLookback)).filter(Number.isFinite);
  const atrAvg = atrWindow.reduce((a, b) => a + b, 0) / atrWindow.length;
  const volRatio = atrAvg > 0 ? atrNow / atrAvg : 1;

  const volatility = volRatio >= p.highVol ? 'high' : volRatio <= p.lowVol ? 'low' : 'normal';
  const tags = [primary, ...(primary.startsWith('trend-') ? ['trend'] : []), `${volatility}-vol`];
  return {
    primary,
    volatility,
    tags,
    metrics: {
      adx: round(adxNow, 2), ema20SlopeAtr: round(slope), sessionVwapCrosses: crosses,
      atrRatio: round(volRatio), closeAboveEma50: above50,
    },
  };
}

/**
 * Per bar: the primary regime classifyRegime gives on the bars up to and including it (classifyRegime(bars.slice(0,
 * i + 1)).primary, causal), in one pass: the indicators are causal from the first bar, so their values at i are the
 * prefix's, and the VWAP crosses read the same window (a running count). null where classifyRegime is.
 */
function primarySeries(bars, overrides = {}) {
  const p = { ...REGIME_PARAMS, ...overrides };
  const n = bars.length;
  const out = new Array(n).fill(null);
  if (n < needOf(p)) return out;
  const x = seriesOf(bars);
  // crossesTo[j]: the crosses at bars 1..j (each close against the one before it), vwapCrosses' count.
  const crossesTo = bars.map((_, j) => (j ? vwapCrosses(bars.slice(j - 1, j + 1), x.vwap.slice(j - 1, j + 1), 1) : 0));
  for (let j = 1; j < n; j += 1) crossesTo[j] += crossesTo[j - 1];
  for (let i = needOf(p) - 1; i < n; i += 1) {
    const from = Math.max(1, i + 1 - p.crossBars);
    const at = primaryAt(x, i, crossesTo[i] - crossesTo[from - 1], p);
    if (at) out[i] = at.primary;
  }
  return out;
}

/** Does a strategy's `regimes` list fit the current regime? Any listed tag matching is a fit; no list fits everything. */
function regimeFits(strategyRegimes, regime) {
  if (!Array.isArray(strategyRegimes) || strategyRegimes.length === 0) return true;
  if (!regime) return false;
  return strategyRegimes.some(r => regime.tags.includes(r));
}

module.exports = { REGIME_PARAMS, PRIMARY, TAGS, classifyRegime, primarySeries, regimeFits, vwapCrosses };
