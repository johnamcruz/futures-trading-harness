'use strict';

/**
 * P1 (feat/p1-mtf-entries): the MTF entry world on the trade_lifecycle scenario-1 bar (tests/fixtures/lifecycle.js): the
 * same briefing with an MTF entry record in m3.mtfStructure, built as briefing.js builds it in an MTF arm: its mode, the
 * 1h structure UP (the parent side long), the 4h DOWN as context (the EMA bias frames of the scenario stay up; a test
 * turns them down to show the 4h+1h rule no longer binds an MTF entry), and the primary's aggressive ready LONG on a 3m
 * CHoCH at the cycle bar, its origin 21529 and structural stop 21528.75 (one tick under: the D3 buffer), the impulse high
 * 21598 the exit target, the trigger's close the reference 21540.25 (drift 0). Tick-checked (MNQ 0.25, $0.50 a tick): from the reference 21540.25 the stop is 11.50 points =
 * 46 ticks ($23.00 a contract); the 2R mark 92 ticks above, 21563.25; the target 57.75 points, 5.02R.
 *
 *   MODE(arm, over)          a replay mode (mtf-entry.js modeOf with the replay check true)
 *   record(over)             the m3.mtfStructure record (over: { mode, side1h, entry, withheld, rank, levels... }); its
 *                            pullback 45% deep (moderate)
 *   briefing(over)           the scenario briefing with the record (over.mtf: record overrides; over.m3: m3 overrides)
 *   READS                    an MTF long's six reads: bias, location, `mtf ready aggressive long`, entry, `stop mtf
 *                            21528.75`, `target trail`
 *   order(over)              the place_order its record gives: a limit buy 1 at 21540.25, 46 / 92 ticks
 */

const LC = require('./lifecycle');
const ME = require('../../scripts/lib/trading/mtf-entry');

const MODE = (arm = 'A', over = {}) => ME.modeOf({ arm, exitMode: 'trail', minStage: 'established', ...over }, {}, { isReplay: () => true });
const LEG = { kind: 'BOS', at: '2026-10-07T12:00:00.000Z', et: '08:00' };

function record({ mode = MODE('A'), side1h = 'long', entry = {}, withheld = null, rank = 1, stage = 'WEAKENING', context = { frame: '4h', way: 'down' }, extra = {} } = {}) {
  const e = { model: 'aggressive', side: 'long', since: { at: LC.CLOSE, barsAgo: 0, minAgo: 0, et: '10:00', beforeOpen: false }, stop: 21528.75, stopTicks: 46, also: null, origin: 21529, target: 21598, targetR: 5.02, by: 'CHoCH', triggerClose: 21540.25, maxRun: 0, ...entry };
  return {
    hierarchy: 'intraday', sideMode: 'parent', side: side1h, sides: { rule: 'long', parent: side1h },
    mode: ME.recordMode(mode), context,
    levels: [{
      name: '1h>15m', role: 'primary', frames: { parent: '1h', setup: '15m', timing: '3m' }, partial: false,
      parent: { way: side1h === 'short' ? 'down' : 'up', protected: { side: 'low', level: 21400, at: null }, via: 'break', against: null, biasRead: 'up', differs: false, leg: LEG },
      stage, instance: { id: 1, openedAt: { at: '2026-10-07T13:15:00.000Z' }, pullbackWay: 'down', rank, leg: LEG, developing: { at: '2026-10-07T13:15:00.000Z' }, impulseExtreme: 21598, depth: 0.45, depthClass: 'moderate' },
      warning: null, entry: e, entryWithheld: withheld, stopTraded: null, pullbacks: [{ at: '2026-10-07T13:15:00.000Z', way: 'down' }],
    }],
    sizing: { tick: 0.25, tickValue: 0.5, capUsd: 300, minContracts: 3, stretchUsd: 500, slipTicks: 1, feePerSide: 0.37 },
    ...extra,
  };
}

function briefing(over = {}) {
  const b = LC.briefing({ m3: { mtfStructure: record(over.mtf || {}), ...(over.m3 || {}) } });
  if (over.h1) b.sections.h1.data = { ...b.sections.h1.data, ...over.h1 };
  return b;
}

const READS = [
  { step: 'bias', skill: 'multi-timeframe-analysis', read: '1h up', why: 'the 1h trend up' },
  { step: 'location', skill: 'vwap-volume-profile', read: 'vwap above', why: 'holding above the VWAP' },
  { step: 'setup', skill: 'mtf-entry', read: 'mtf ready aggressive long', why: 'the 15m pullback, the 3m CHoCH back up' },
  { step: 'entry', skill: 'candle-reading', read: '3m close top', why: 'the 3m closed at its high' },
  { step: 'stop', skill: 'mtf-entry', read: 'stop mtf 21528.75', why: 'the structural stop, the CHoCH origin' },
  { step: 'target', skill: 'top-down-entry', read: 'target trail', why: 'the trail' },
];

const order = (over = {}) => LC.order({ stopLossBracket: { ticks: 46, type: 'stop' }, takeProfitBracket: { ticks: 92, type: 'limit' }, rationale: 'setup:trade_lifecycle long, the MTF aggressive ready with the 1h structure, stop 21528.75, target 21563.25', ...over });

module.exports = { MODE, LEG, record, briefing, READS, order };
