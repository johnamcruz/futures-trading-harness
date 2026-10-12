'use strict';

/**
 * Market features for a whole series, causal (each value at bar i from bars
 * 0..i only): ATR(20), ATR(100), ADX(14), the trend rule's frames
 * (trading/mtf.js), the RTH and session VWAPs, and the prior RTH day's
 * volume profile, set by `params` (a strategy's: vpRows, vpRowSize, ...).
 * The replay labels' stop ATR (replay/labels.js atrAt) is this ATR(20).
 */

const ind = require('./indicators');
const { ruleSeries } = require('./mtf');
const { profileSeries, optionsFromParams } = require('./volume-profile');

const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;
const GLOBEX_OPEN = 18 * 60;

function marketFeatures(bars, params = {}) {
  return {
    atr20: ind.atr(bars, 20),
    atr100: ind.atr(bars, 100),
    adx: ind.adx(bars, 14),
    mtf: ruleSeries(bars),
    vwapRth: ind.anchoredVwap(bars, RTH_OPEN, RTH_CLOSE),
    vwapSession: ind.anchoredVwap(bars, GLOBEX_OPEN),
    profile: profileSeries(bars, 'prior_rth', { options: optionsFromParams(params || {}) }),
  };
}

module.exports = { marketFeatures };
