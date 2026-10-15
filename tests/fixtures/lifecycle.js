'use strict';

/**
 * The trade_lifecycle tests' scenario-1 world (the composed-entry design, "the two acceptance trades"): a bar briefing
 * for MNQ on the 13:57 UTC bar of tests/helpers.js NOW's day (it closes at NOW, 14:00) whose facts make the owner's
 * scenario-1 long true: bias 1h up, price above the VWAP, the 15m candle rejected the prior VAH up, the 3m candle closed at its top, the
 * 15m low 21512.75 under the entry reference 21540.25, the next 1h swing 21598.00 above it. Tick-checked (MNQ, 0.25,
 * $0.50 a tick): the stop one tick beyond the level is 21512.50, 111 ticks ($55.50 a contract); the target 231 ticks,
 * 2.08R; the minimum stop the larger of 8 ticks and 0.25 x ATR(20) (oneR 12 points: ATR(20) 24, 6 points, 24 ticks).
 *
 *   BAR, CLOSE, EXPIRES        the cycle bar's open, its close (NOW) and the record's expiry (the next close)
 *   briefing(over)             the briefing (deep-merged over m3 data with `over.m3`)
 *   READS                      the six reads, one per step, each true on it for a long
 *   writeScenario(home, o)     writes the briefing and the compose record compose_check would ({ reads, side, size, at, b }) to home;
 *                              returns the record
 *   order(over)                the place_order the record gives: a limit buy 1 at 21540.25, 111 / 231 ticks
 *   config(home, over)         an order-gate config on that home, in a cycle on BAR (FTH_CYCLE_BARS)
 */

const { writeBriefing } = require('../../scripts/lib/trading/briefing');
const { buildRecord, appendRecord, planOf } = require('../../scripts/lib/trading/trade-lifecycle');
const { checkReads } = require('../../scripts/lib/trading/composed-reads');

const BAR = '2026-10-07T13:57:00.000Z';
const CLOSE = '2026-10-07T14:00:00.000Z';
const EXPIRES = '2026-10-07T14:03:00.000Z';

function briefing(over = {}) {
  return {
    symbol: 'MNQ', minutes: 3, asOf: BAR,
    sections: {
      m3: {
        version: 'v-scenario-1', validUntil: EXPIRES,
        data: {
          price: 21540.25, bar: { t: BAR, o: 21530, h: 21541, l: 21529, c: 21540.25, v: 500 }, oneR: { points: 12, basis: '0.5 x 3m ATR(20) 24' }, referenceStop: { distance: 12, long: 21528.25, short: 21552.25 },
          trendRule: 'Trend rule: prevailing trend 1h up; trend strategies may not go short.',
          vwap: { applies: 'rth', side: 'above' }, location: { priorValue: 'above' }, news: { inBlackout: false },
          candles: { '3m': { o: 21530, h: 21541, l: 21529, c: 21540.25, closeLocation: 'top' }, '15m': { o: 21520, h: 21545, l: 21512.75, c: 21540.25, closeLocation: 'top', relations: [{ name: 'prior VAH', price: 21530.13, rel: 'rejected', dir: 'up' }] } },
          swingTargets: { above: [{ frame: '1h', price: 21598, points: 57.75, ticks: 231, R: 4.81 }], below: [] },
          nearestLiquidity: { above: [{ name: 'prior VAH', price: 21570, points: 29.75, R: 2.48 }], below: [] },
          candidates: [],
          ...(over.m3 || {}),
        },
      },
      m15: { validUntil: EXPIRES, data: { frame: { trend: 'up' }, alignment: { long: 'aligned', short: 'counter' } } },
      h1: { validUntil: EXPIRES, data: { h1: { trend: 'up' }, h4: { trend: 'up' } } },
    },
  };
}

const READS = [
  { step: 'bias', skill: 'multi-timeframe-analysis', read: '1h up', why: '60m trend up: buyers in control' },
  { step: 'location', skill: 'vwap-volume-profile', read: 'vwap above', why: 'holding above the VWAP' },
  { step: 'setup', skill: 'rejection', read: '15m rejected prior VAH up', why: 'the 15m dipped under it and closed back above' },
  { step: 'entry', skill: 'candle-reading', read: '3m close top', why: 'the 3m bar closed at its high' },
  { step: 'stop', skill: 'invalidation', read: 'stop 15m low 21512.75', why: 'below the 15m low the idea is wrong' },
  { step: 'target', skill: 'top-down-entry', read: 'target 1h swing 21598.00', why: 'the next 60m swing high' },
];

/** The record compose_check writes for these reads on this briefing (harness-tools/compose.js, its steps). */
function composeRecord({ reads = READS, side = 'long', size = 1, at = '2026-10-07T13:59:50.000Z', b = briefing(), minRR = 2, maxRiskUsd = 300 } = {}) {
  const checked = checkReads({ reads, side, briefing: b, tick: 0.25 });
  const planned = checked.stop && checked.target ? planOf({ checked, briefing: b, side, size, tick: 0.25, tickValue: 0.5, minRR, maxRiskUsd }) : null;
  return buildRecord({ at, root: 'MNQ', symbol: 'MNQ', side, briefing: b, checked, planned });
}

function writeScenario(home, o = {}) {
  if (o.write !== false) writeBriefing(home, o.b || briefing());
  const rec = composeRecord(o);
  appendRecord(home, rec);
  return rec;
}

const order = (over = {}) => ({
  accountId: 1, contractId: 'MNQ', side: 'buy', type: 'limit', limitPrice: 21540.25, size: 1,
  stopLossBracket: { ticks: 111, type: 'stop' }, takeProfitBracket: { ticks: 231, type: 'limit' },
  rationale: 'setup:trade_lifecycle long, the 15m rejection with the 1h trend, stop 21512.50, target 21598.00', ...over,
});

module.exports = { BAR, CLOSE, EXPIRES, briefing, READS, composeRecord, writeScenario, order };
