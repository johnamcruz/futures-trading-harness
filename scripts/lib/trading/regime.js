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

const REGIME_PARAMS = {
  trendAdx: 20,
  rangeAdx: 18,
  slopeBars: 5,
  slopeAtr: 0.3, // EMA(20) move over slopeBars, in ATR(14) units
  crossBars: 30,
  maxTrendCrosses: 3,
  rangeCrosses: 5,
  volLookback: 100,
  highVol: 1.4,
  lowVol: 0.7,
};

const PRIMARY = ['trend-up', 'trend-down', 'range', 'transition'];
const TAGS = [...PRIMARY, 'trend', 'high-vol', 'normal-vol', 'low-vol'];

const finite = v => (Number.isFinite(v) ? v : null);
const round = (x, d = 3) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

function vwapCrosses(bars, vwap, from) {
  let crosses = 0;
  for (let i = Math.max(1, from); i < bars.length; i += 1) {
    const a = bars[i - 1].c - vwap[i - 1];
    const b = bars[i].c - vwap[i];
    if (Number.isFinite(a) && Number.isFinite(b) && a !== 0 && Math.sign(a) !== Math.sign(b)) crosses += 1;
  }
  return crosses;
}

/** Classify normalized bars (oldest first). Returns { primary, volatility, tags, metrics } or null if too few bars. */
function classifyRegime(bars, overrides = {}) {
  const p = { ...REGIME_PARAMS, ...overrides };
  const n = bars.length;
  if (n < Math.max(60, p.slopeBars + 30)) return null;
  const i = n - 1;
  const closes = bars.map(b => b.c);
  const adx = ind.adx(bars, 14);
  const atr = ind.atr(bars, 14);
  const ema20 = ind.ema(closes, 20);
  const ema50 = ind.ema(closes, 50);
  const vwap = ind.anchoredVwap(bars, 18 * 60); // session VWAP is defined around the clock

  const adxNow = finite(adx[i]);
  const atrNow = finite(atr[i]);
  if (adxNow === null || atrNow === null || atrNow <= 0) return null;
  const slope = (ema20[i] - ema20[i - p.slopeBars]) / atrNow;
  const crosses = vwapCrosses(bars, vwap, n - p.crossBars);
  const atrWindow = atr.slice(Math.max(0, n - p.volLookback)).filter(Number.isFinite);
  const atrAvg = atrWindow.reduce((a, b) => a + b, 0) / atrWindow.length;
  const volRatio = atrAvg > 0 ? atrNow / atrAvg : 1;
  const above50 = closes[i] > ema50[i];

  let primary = 'transition';
  if (adxNow >= p.trendAdx && crosses <= p.maxTrendCrosses && slope >= p.slopeAtr && above50) primary = 'trend-up';
  else if (adxNow >= p.trendAdx && crosses <= p.maxTrendCrosses && slope <= -p.slopeAtr && !above50) primary = 'trend-down';
  else if (adxNow < p.rangeAdx || crosses >= p.rangeCrosses) primary = 'range';

  const volatility = volRatio >= p.highVol ? 'high' : volRatio <= p.lowVol ? 'low' : 'normal';
  const tags = [primary, ...(primary.startsWith('trend-') ? ['trend'] : []), `${volatility}-vol`];
  return {
    primary,
    volatility,
    tags,
    metrics: {
      adx: round(adxNow, 2), ema20SlopeAtr: round(slope), vwapCrosses: crosses,
      atrRatio: round(volRatio), closeAboveEma50: above50,
    },
  };
}

/** Does a strategy's `regimes` list fit the current regime? Any listed tag matching is a fit; no list fits everything. */
function regimeFits(strategyRegimes, regime) {
  if (!Array.isArray(strategyRegimes) || strategyRegimes.length === 0) return true;
  if (!regime) return false;
  return strategyRegimes.some(r => regime.tags.includes(r));
}

module.exports = { REGIME_PARAMS, PRIMARY, TAGS, classifyRegime, regimeFits };
