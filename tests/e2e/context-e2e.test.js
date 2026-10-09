'use strict';

/**
 * The decision context end to end: the runner polls a fake ProjectX serving
 * real NQ bars, with an open long on the account and its entry in the
 * journal, and a recorded backtest track record. The 13:15 ET bar of
 * 2026-04-27 closes (value_area fires short on it). The cycle prompt the
 * model gets must carry, built by the production functions:
 *   - the day so far (day-context.js): the open against the prior day, the
 *     opening type, the initial balance, the day type, the range against the ADR;
 *   - the track record of the strategy that fired (track-record.js);
 *   - the open trade (open-trades.js): setup, initial risk, stop, target, R
 *     now, best and worst, bars held.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createRunner } = require('../../scripts/lib/runner');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { loadStrategies, scan } = require('../../scripts/lib/trading/strategies');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { dayContextSeries, describeDay } = require('../../scripts/lib/trading/day-context');
const { readRecord, liveRecord, describeRecord, writeRecord, excursionNote } = require('../../scripts/lib/trading/track-record');
const { readJournal } = require('../../scripts/lib/trading/journal');
const { tmpDir, writeJournal } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const BARS = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv')).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
const STEP = 180000;
const CONTRACT = 'CON.F.US.MNQ.M26';
const NQ = 'CON.F.US.ENQ.M26'; // the open trade is a mini, managed on the micro's bars (the same family)

test('context e2e: the cycle prompt carries the day, the fired strategy\'s track record, and the open trade', async () => {
  const home = tmpDir();
  // A long opened at 12:58:30 ET (16:58:30Z) on an orb setup, stop 27390.00; the stop since trailed to 27399.00.
  const journal = writeJournal(home, [
    { ts: '2026-04-27T16:58:20.000Z', kind: 'order_placed', contractId: NQ, text: 'setup:orb long, stop 27,390.00', data: { result: { success: true } } },
    { ts: '2026-04-20T15:00:00.000Z', kind: 'review', text: 'value_area short R = -1', tags: ['result:loss', 'setup:value_area', 'regime:range'] },
  ]);
  writeRecord(home, {
    strategy: 'value_area', source: 'backtest', runId: 'r1', symbols: ['MNQ'], timeframe: 3, start: '2025-01-02T00:00:00.000Z', end: '2025-04-01T00:00:00.000Z',
    summary: { trades: 120, winRate: 0.42, meanR: 0.21, meanRCI95: [0.02, 0.4], edge: 'positive', profitFactorR: 1.4 },
    byRegime: {}, byHour: { '13:00 ET': { trades: 14, winRate: 0.5, meanR: 0.35 } },
  });
  // orb's recorded excursions: its winners rarely went below -0.6R.
  writeRecord(home, {
    strategy: 'orb', source: 'backtest', summary: { trades: 80, winRate: 0.4, meanR: 0.15, meanRCI95: null, edge: 'unproven (the interval includes 0)' }, byRegime: {}, byHour: {},
    excursions: { winners: 32, losers: 48, winnersMedianMfeR: 2.4, winnersMaeFloorR: -0.6, losersMedianMfeR: 0.4, reached1R: 40, gaveBackAfter1R: 0.2 },
  });
  const strategies3m = loadStrategies(ROOT, {}).strategies.filter(s => s.timeframe === '3m');
  const clockRef = { t: Date.parse('2026-04-27T17:18:20Z') }; // 20 s after the 13:15 ET bar closed
  const prompts = [];
  const position = { contractId: NQ, type: 1, size: 1, averagePrice: 27410.5, creationTimestamp: '2026-04-27T16:58:30.000Z' };
  const orders = [{ id: 7, contractId: NQ, type: 4, side: 1, size: 1, stopPrice: 27399 }];
  const client = {
    async activeContract() { return { id: CONTRACT, tickSize: 0.25, tickValue: 0.5 }; },
    async closedBars(_id, { limit }) { return BARS.filter(b => Date.parse(b.t) + STEP <= clockRef.t).slice(-limit); },
    async netPosition() { return 1; },
    async workingOrders() { return 1; },
    async accountState() { return { positions: [position], orders }; },
    async accountBalance() { return 50000; },
  };
  const runner = createRunner({
    cfg: validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', symbols: ['MNQ'], timeframe: 3, barDelaySeconds: 0, account: 1 }),
    root: ROOT, client, clock: { now: () => new Date(clockRef.t) },
    runCycle: async (action, prompt) => { prompts.push(prompt); return { ok: true, timedOut: false, result: 'CYCLE RESULT: managed' }; },
    isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => null, saveState: () => {},
    writeBars: (sym, bars) => { const f = path.join(home, `${sym.symbol}-3m.json`); fs.writeFileSync(f, JSON.stringify({ contractId: sym.contractId, bars })); return f; },
    scanFor: (symbol, bars) => scan(strategies3m, { bars }, { symbol, now: new Date(clockRef.t) }),
    // As scripts/autotrader.js wires them.
    dayContext: (sym, bars) => describeDay(dayContextSeries(bars).day.at(-1), { symbol: sym.symbol, round: x => Number((Math.round(x / 0.25) * 0.25).toFixed(6)) }),
    trackRecord: (name, { regime, at }) => describeRecord({ backtest: readRecord(home, name), live: liveRecord(readJournal(journal), name, regime), regime, at }),
    journalEntries: () => readJournal(journal),
    tradeHistory: t => excursionNote(readRecord(home, t.setup), t),
  });
  for (let guard = 0; !prompts.length && guard < 50; guard += 1) {
    const ms = await runner.step();
    clockRef.t += Math.max(ms, 1000);
  }
  assert.strictEqual(prompts.length, 1, 'one cycle on the closed bar');
  const p = prompts[0];
  // 1. The day so far.
  assert.match(p, /MNQ day: opened 27410\.75 inside the prior value area, gap -23\.25 from the prior close; opening type open-[a-z-]+( up| down)?; initial balance 27298\.5-27435 \(136\.5 points\), extended 0 up and 0 down: inside the initial balance; range so far 136\.5 \(no 10-day average yet\)\./);
  // 2. value_area fired short, with its track record (backtest, the 13:00 ET slice, the live review).
  assert.match(p, /value_area short[^|]*\[value_area track record: backtest 120 trades \(MNQ 3m 2025-01-02\.\.2025-04-01\): win 42%, E \+0\.21R \[95% CI \+0\.02R, \+0\.4R\], edge positive; at 13:00 ET: 14 trades, E \+0\.35R; live: 1 reviewed, 0W\/1L, E -1R \(in range: 1, E -1R\)\]/);
  // 3. The open NQ trade, on the MNQ bars: entered on orb with a 20.50-point risk (the "27,390.00" stop read
  // as a price), stop trailed to 27399, six bars since the fill, its worst against orb's winners.
  assert.match(p, new RegExp(`Open trade ${NQ.replace(/\./g, '\\.')} long 1 @ 27410\\.5 since 12:58 ET, 6 bars closed since \\(setup:orb\\): initial stop 27390: risk 20\\.5 points = 82 ticks; working stop 27399 \\(-0\\.56R\\), no target order; now -0\\.79R at 27394\\.25, best \\+0\\.38R, worst -0\\.95R\\. orb winners in its backtest: median best \\+2\\.4R, 80% never went below -0\\.6R; this trade's worst -0\\.95R is deeper than 80% of its winners went\\.`));
});
