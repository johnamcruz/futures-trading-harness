'use strict';

/**
 * The side the shipped entry rule allows, per bar (BG: chain.js's bias frames, entry-rule.js's own check), for the rules
 * language (`chain_side`, rules.js): a strategy that fires only on that side fires where the gate would allow it.
 * Causal: bar i reads only bars up to it. On each bar a briefing holding only what the entry rule reads is built from
 * the bars' own facts, as the runner's briefing builds them:
 *
 *   the 4h, 1h and 15m trends    mtf.js ruleSeries (the trend rule's frames, as of the candles completed by the bar)
 *   the Trend declared? facts    trend-declared.js declaredFacts on the bar's close, ATR(14), the RTH VWAP distance
 *                                (market-snapshot.js distanceAtr: to 2 decimals), EMA20, the RTH open (day-context.js)
 *                                and the regime (regime.js primarySeries: classifyRegime on the bars up to the bar);
 *                                in RTH only (the RTH VWAP exists), as the briefing has them
 *
 *   chainSideSeries(bars)   [1 long, -1 short, 0 no side] per bar
 *   briefingAt(facts)       the minimal briefing for one bar's facts (exported for the tests)
 */

const ind = require('./indicators');
const mtf = require('./mtf');
const { primarySeries } = require('./regime');
const { declaredFacts } = require('./trend-declared');
const { dayContextSeries } = require('./day-context');
const { entryRuleOf, entryProblems, BIAS_FRAMES, NEUTRAL } = require('./entry-rule');
const { RTH_OPEN_MIN, RTH_CLOSE_MIN } = require('./clock');

// The shipped rule's side check: the chain's bias frames, BG; no lane (a rules series reads its own bars).
const RULE = entryRuleOf({ bias_frames: [...BIAS_FRAMES], bias_agree: NEUTRAL, regime_against: 'off', leg_turned: 'off' });
const EMA20 = require('../tunables').analysis().snapshot.emaSlow; // the snapshot's EMA20 (config/analysis.json)

const fin = x => typeof x === 'number' && Number.isFinite(x);
const word = b => (fin(b) ? (b > 0 ? 'up' : b < 0 ? 'down' : 'range') : null);
const round2 = x => Math.round(x * 100) / 100;

/** { t4h, t1h, t15, declared } -> the briefing the entry rule reads. */
function briefingAt({ t4h, t1h, t15, declared }) {
  return {
    sections: {
      h1: { data: { h4: { trend: t4h }, h1: { trend: t1h } } },
      m15: { data: { frame: { trend: t15 } } },
      m3: { data: declared ? { declared } : {} },
    },
  };
}

function chainSideSeries(bars) {
  const n = bars.length;
  const out = new Array(n).fill(0);
  if (!n) return out;
  const ser = mtf.ruleSeries(bars);
  const [h4, h1, m15] = mtf.RULE_FRAMES;
  const closes = bars.map(b => b.c);
  const atr = ind.atr(bars, ind.ATR_PERIOD);
  const ema = ind.ema(closes, EMA20);
  const vwapRth = ind.anchoredVwap(bars, RTH_OPEN_MIN, RTH_CLOSE_MIN);
  const regime = primarySeries(bars);
  let day = null;
  for (let i = 0; i < n; i += 1) {
    const t4h = word(ser[h4][i]);
    const t1h = word(ser[h1][i]);
    if (t4h === null || t1h === null) continue;
    let declared = null;
    // Only where it can matter (both bias frames ranging) and in RTH (the RTH VWAP exists), as the briefing has it.
    if (t4h === 'range' && t1h === 'range' && fin(vwapRth[i]) && fin(atr[i]) && atr[i] > 0) {
      if (!day) day = dayContextSeries(bars).day;
      const d = day[i];
      declared = declaredFacts({ price: bars[i].c, atr: atr[i], vwapAtr: round2((bars[i].c - vwapRth[i]) / atr[i]), ema20: ema[i], open: d ? d.open : null, regime: regime[i] });
    }
    const b = briefingAt({ t4h, t1h, t15: word(ser[m15][i]), declared });
    const long = !entryProblems({ briefing: b, side: 'long', reads: [], rule: RULE }).length;
    const short = !entryProblems({ briefing: b, side: 'short', reads: [], rule: RULE }).length;
    out[i] = long && !short ? 1 : short && !long ? -1 : 0;
  }
  return out;
}

module.exports = { chainSideSeries, briefingAt };
