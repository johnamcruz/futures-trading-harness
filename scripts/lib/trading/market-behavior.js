'use strict';

/**
 * The Market state's behavior layer (round 20, the owner's third layer: "Price behavior: Whether price is trending,
 * overlapping, consolidating, or repeatedly failing to continue"), on the 3m bars from 09:30 ET (premarket excluded,
 * decision 5) and today's completed 15m RTH candles beside it. Pure; thresholds passed in (config/analysis.json
 * marketState); every size is a share or an ATR(14) multiple, never points.
 *
 *   behavior(rth, w, atr)        the last w bars: overlap (mean share of each candle's range inside the previous candle's),
 *                                efficiency (|net| / the sum of ranges), net (last close - first open), netAtr (net in
 *                                ATR), disp (candles strong in their own colour, cisd.js strongCandle on this ATR)
 *   rejections(rth, w, tol, p)   the last w bars' top and bottom; rejection episodes at each (a run of bars touching the
 *                                edge within tol and closing back inside by more than tol: equal highs or lows within
 *                                tol are one boundary, decision 8); interior = confirmed k=2 pivots more than
 *                                `interior` of the range from both edges (chop fails mid-range; a range travels edge to
 *                                edge, decision 1)
 *   word3({ rthBars, beh, side, sinceProgress, loss, atr }, p)   trending (a new extreme by close within lossStale bars
 *                                and the window's net the leg's way >= trendNetAtr x ATR) | failing (loss of control) |
 *                                overlapping (overlap >= overlapHigh) | rotating (efficiency < effLow) | mixed | early
 *                                (fewer than earlyBars RTH bars)
 *   word15(beh, atr15, p)        the 15m candles' word: moving <way> (|net| >= trendNetAtr x the 15m ATR) |
 *                                overlapping | rotating | mixed | early (fewer than early15 candles); printed, never a rule.
 *                                Never "trending" (read audit F4): the 15m trend word in the prompt is the 15m frame's
 *                                (m15.frame.trend), one per prompt; this one is the last candles' movement, printed
 *                                "15m <word>" (market-state.js)
 */

const SE = require('./structure-events');
const { strongCandle } = require('./cisd');


function behavior(rth, w, atr) {
  const xs = rth.slice(-w);
  if (xs.length <= 1) return null;
  let ov = 0; let cnt = 0; let sum = 0; let disp = 0;
  for (let k = 0; k < xs.length; k += 1) {
    const c = xs[k];
    sum += c.h - c.l;
    if (k > 0) {
      const pv = xs[k - 1];
      const r = c.h - c.l;
      if (r > 0) { ov += Math.max(0, Math.min(c.h, pv.h) - Math.max(c.l, pv.l)) / r; cnt += 1; }
      if (strongCandle(c, pv, c.c >= c.o ? 1 : -1, atr).strong) disp += 1;
    }
  }
  const net = xs[xs.length - 1].c - xs[0].o;
  const r2 = x => Math.round(x * 100) / 100;
  return { bars: xs.length, overlap: cnt ? r2(ov / cnt) : null, eff: sum > 0 ? r2(Math.abs(net) / sum) : null, net: r2(net), netAtr: atr > 0 ? r2(net / atr) : null, disp };
}

function rejections(rth, w, tol, p) {
  const xs = rth.slice(-w);
  if (xs.length < p.earlyBars) return null;
  const top = Math.max(...xs.map(c => c.h));
  const bot = Math.min(...xs.map(c => c.l));
  const count = t => { let ep = 0; let on = false; for (const c of xs) { const x = t(c); if (x && !on) ep += 1; on = x; } return ep; };
  const atTop = count(c => c.h >= top - tol && c.c < top - tol);
  const atBot = count(c => c.l <= bot + tol && c.c > bot + tol);
  const range = top - bot;
  const interior = SE.pivots(xs).filter(x => x.price > bot + p.interior * range && x.price < top - p.interior * range).length;
  return { top, bot, atTop, atBot, interior };
}

function word3({ rthBars, beh, side, sinceProgress, loss, atr }, p) {
  if (!beh || rthBars < p.earlyBars || beh.overlap === null) return 'early';
  const s = side === 'up' ? 1 : side === 'down' ? -1 : 0;
  if (s && Number.isInteger(sinceProgress) && sinceProgress < p.lossStale && atr > 0 && s * beh.net >= p.trendNetAtr * atr) return 'trending';
  if (loss) return 'failing';
  if (beh.overlap >= p.overlapHigh) return 'overlapping';
  if (beh.eff !== null && beh.eff < p.effLow) return 'rotating';
  return 'mixed';
}

function word15(beh, atr15, p) {
  if (!beh || beh.bars < p.early15 || beh.overlap === null) return 'early';
  if (atr15 > 0 && Math.abs(beh.net) >= p.trendNetAtr * atr15) return `moving ${beh.net > 0 ? 'up' : 'down'}`;
  if (beh.overlap >= p.overlapHigh) return 'overlapping';
  if (beh.eff !== null && beh.eff < p.effLow) return 'rotating';
  return 'mixed';
}

module.exports = { behavior, rejections, word3, word15 };
