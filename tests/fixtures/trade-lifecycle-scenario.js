'use strict';

// The owner's scenario 1 for the trade-lifecycle tests (composed-reads, trade-lifecycle, compose_check): a bar
// briefing shaped as buildBriefing writes it, and the model's reads.

/**
 * Scenario 1 (MNQ, 3m bars): the 60m broke up (BOS) and price holds above the prior RTH high; the 15m candle traded
 * below the prior VAH 21530.13 and closed back above it (14:30-14:45 UTC); a later 3m candle (closing 15:00, the
 * confirmation after the reaction) closed at its high with momentum; the 15m low 21512.75 is the invalidation; the next 60m swing above is 21598.00. Entry reference 21540.25; ATR(20) 40 points
 * (the reference stop 0.5 x ATR(20) = 20).
 */
function scenario1() {
  const relations15 = [
    { name: 'prior VAH', price: 21530.13, rel: 'rejected', dir: 'up' },
    { name: 'prior RTH high', price: 21520, rel: 'touched', dir: null },
    { name: 'VWAP (rth)', price: 21525.4, rel: 'broke', dir: 'up' },
    { name: 'previous 15m low', price: 21515, rel: 'touched', dir: null },
    { name: 'IB high', price: 21533, rel: 'touched', dir: null },
    // Past the four the text keeps: still verifiable.
    { name: '1h swing low 21514.5', price: 21514.5, rel: 'rejected', dir: 'up' },
  ];
  return {
    symbol: 'MNQ', minutes: 3, asOf: '2026-04-23T14:57:00.000Z', closedAt: '2026-04-23T15:00:00.000Z', price: 21540.25,
    keyLevels: [['prior VAH', 21530.13, 21530.25], ['prior RTH high', 21520], ['VWAP (rth)', 21525.4], ['IB high', 21533]],
    sections: {
      m3: {
        validUntil: '2026-04-23T15:03:00.000Z',
        data: {
          price: 21540.25,
          bar: { t: '2026-04-23T14:57:00.000Z', o: 21530.5, h: 21541, l: 21529.75, c: 21540.25, v: 900, rangeAtr: 1.3 },
          window: 'opening drive',
          regime: { primary: 'trend', volatility: 'normal' },
          referenceStop: { distance: 20, long: 21520.25, short: 21560.25 },
          vwap: { applies: 'rth', side: 'above' },
          location: { priorValue: 'above', priorRthRange: 'above', initialBalance: 'above' },
          trendRule: 'Trend rule: prevailing trend 1h up; trend strategies may not go short.',
          today: { dayType: 'trend day' },
          swings: { high: 21545, low: 21512.75 },
          liquidity: { swingHighs: [{ price: 21545, t: 'x' }], swingLows: [{ price: 21512.75, t: 'y' }], equalHighs: [], equalLows: [] },
          htfLevels: [{ name: '15m swing low', type: 'low', price: 21512.75, brokenAt: null }],
          nearestLiquidity: { above: [{ name: 'last 3m swing high', price: 21545, points: 4.75, R: 0.24 }, { name: '15m swing high', price: 21560, points: 19.75, R: 0.99 }], below: [{ name: 'IB high', price: 21533, points: 7.25, R: 0.36 }] },
          lastBreak: { last: { kind: 'BOS', direction: 'up', level: 21535 }, previous: null },
          sweeps: [{ name: 'prior RTH high', price: 21520, side: 'high', key: true }],
          cisd: { '3m': 'none in these bars', '15m': { dir: 'bullish', level: 21520, status: 'touched', priceInOte: false }, '5m': 'unavailable (not whole 3m bars; no 1m bars configured)' },
          candles: {
            '3m': { t: '2026-04-23T14:57:00.000Z', closedAt: '2026-04-23T15:00:00.000Z', o: 21530.5, h: 21541, l: 21529.75, c: 21540.25, closeLocation: 'top', rangeAtr: 1.3, volRatio: 1.6, pattern: 'displacement', dir: 'up', levels: {}, relations: [{ name: 'prior VAH', price: 21530.13, rel: 'broke', dir: 'up' }] },
            '5m': { unavailable: 'not whole 3m bars; no 1m bars configured' },
            '15m': { t: '2026-04-23T14:30:00.000Z', closedAt: '2026-04-23T14:45:00.000Z', o: 21536, h: 21545, l: 21512.75, c: 21541, closeLocation: 'top', rangeAtr: 1.1, volRatio: 1.2, pattern: 'hammer',
              levels: { 'prior VAH': 'rejected: closed back above', 'VWAP (rth)': 'broke above', 'prior RTH high': 'touched', 'IB high': 'touched' }, moreLevels: 2, relations: relations15 },
            '1h': { t: '2026-04-23T14:00:00.000Z', o: 21500, h: 21545, l: 21490, c: 21541, closeLocation: 'top', rangeAtr: 1.4, volRatio: 1.1, pattern: 'none', levels: {}, relations: [] },
          },
          swingTargets: { above: [{ frame: '15m', price: 21560, R: 0.7 }, { frame: '1h', price: 21598, R: 2.1 }], below: [{ frame: '1h', price: 21480 }] },
        },
      },
      m15: { data: { frame: { trend: 'up' }, alignment: { long: 'aligned', short: 'counter' }, lastBreak: { last: { kind: 'BOS', direction: 'up', level: 21530 } } } },
      h1: { data: { h1: { trend: 'up' }, h4: { trend: 'range' }, lastBreak: { last: { kind: 'BOS', direction: 'up', level: 21500 }, previous: null } } },
      day: { data: { priorRth: { high: 21520, low: 21400 }, priorProfile: { vah: 21530.25, val: 21450, poc: 21480 } } },
    },
  };
}

const SCENARIO_1 = [
  { step: 'bias', skill: 'bos-vs-choch', read: '1h bos up', why: '60m broke the last swing high: buyers in control' },
  { step: 'bias', skill: 'daily-bias', read: 'above prior RTH range', why: 'holding above the prior day high' },
  { step: 'location', skill: 'vwap-volume-profile', read: 'at prior VAH', why: 'back at the prior value high' },
  { step: 'setup', skill: 'rejection', read: '15m rejected prior VAH up', why: 'the 15m dipped under it and closed back above' },
  { step: 'entry', skill: 'candle-reading', read: '3m close top', why: 'closed at its high' },
  { step: 'entry', skill: 'momentum-and-volume', read: '3m momentum up', why: 'a full-range bar on volume' },
  { step: 'stop', skill: 'invalidation', read: 'stop 15m low 21512.75', why: 'below the rejection low it is wrong' },
  { step: 'target', skill: 'top-down-entry', read: 'target 60m swing 21598.00', why: 'the next 60m swing high' },
];
const SKILLS = ['bos-vs-choch', 'daily-bias', 'vwap-volume-profile', 'rejection', 'candle-reading', 'momentum-and-volume', 'invalidation', 'top-down-entry', 'cisd'];

module.exports = { scenario1, SCENARIO_1, SKILLS };
