'use strict';

// A bar briefing holding only what the entry rule reads, built from a census bar's facts the way the runner's briefing
// builds them: the 4h, 1h and 15m trends (h1.h4.trend, h1.h1.trend, m15.frame.trend) from the trend signs, and the
// Trend declared? facts (m3.declared) from the shipped trend-declared.js declaredFacts on the close, ATR(14), the RTH
// VWAP distance (market-snapshot.js distanceAtr: (close - VWAP) / ATR to 2 decimals), EMA20, the RTH open and the regime.
// Used by the BG parity test (tests/lib/bias-bg-parity.test.js) and its scratch full run.

const { declaredFacts } = require('../../../scripts/lib/trading/trend-declared');
const { entryProblems } = require('../../../scripts/lib/trading/entry-rule');

const TREND = { 1: 'up', '-1': 'down', 0: 'range' };
const fin = x => typeof x === 'number' && Number.isFinite(x);
const trend = s => (fin(s) ? TREND[String(s)] || null : null);

/** { h4, h1, t15 (signs), c, atr, vwap, ema20, open, regime } -> the briefing. */
function briefingOfFacts({ h4, h1, t15, c, atr, vwap, ema20, open, regime }) {
  const vwapAtr = fin(vwap) && fin(atr) && atr > 0 ? Math.round(((c - vwap) / atr) * 100) / 100 : null;
  const declared = declaredFacts({ price: c, atr, vwapAtr, ema20, open, overnight: null, regime });
  return {
    minutes: 3,
    sections: {
      m3: { data: { price: c, regime: regime ? { primary: regime } : null, ...(declared ? { declared } : {}) } },
      m15: { data: { frame: { trend: trend(t15) } } },
      h1: { data: { h4: { trend: trend(h4) }, h1: { trend: trend(h1) } } },
    },
  };
}

/** The shipped rule's verdict on a bar: { allowed, problems }. */
function shippedAllows(rule, briefing, side) {
  const problems = entryProblems({ briefing, side, reads: [], rule });
  return { allowed: problems.length === 0, problems };
}

module.exports = { briefingOfFacts, shippedAllows };
