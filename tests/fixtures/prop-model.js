'use strict';

// Fixtures for the prop Monte Carlo of the model's replay trades (prop/model-stream.js and the modules beside it): a
// finished multi-day replay run (the learning fixtures' record, bars and run layout, one file per day), a test
// account, and model streams built from scripted decisions.

const fs = require('fs');
const path = require('path');
const { M3, record, bars, tmpHome } = require('./learning');
const { roleOf } = require('../../scripts/lib/learning/splits');

/** A small combine: $50,000, $3,000 target, $2,000 trailing max loss, $1,000 daily limit, 30 sessions. */
const ACCOUNT = Object.freeze({
  name: 'unit_50k', starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod', daily_loss_limit: 1000,
  daily_loss_soft: 0, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 },
});

/**
 * A finished replay run with several days: days [{ day, times, fills, refusals, records, rows, barsStart }], each day's
 * fills on its last line, every record in <home>/trade-lifecycle/MNQ.jsonl and every day's bars in one bars file.
 * gate: the learning-run.json decision (default: a learning run in the first day's role); null: none written.
 */
function multiDayRun({ home = tmpHome('fth-pmc-'), runId = 'run1', days = [], gate = undefined, autotrader = { timeframe: 3, symbols: ['MNQ'] } } = {}) {
  const dir = path.join(home, 'replay', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runId, finished: true, daysDone: days.map(d => d.day), broker: 'replay' }));
  const g = gate === undefined ? { learning: true, role: roleOf(days[0].day), look: null, hideOutcomes: false } : gate;
  if (g) for (const d of [dir, home]) fs.writeFileSync(path.join(d, 'learning-run.json'), JSON.stringify(g));
  fs.writeFileSync(path.join(dir, 'autotrader.json'), JSON.stringify(autotrader));
  const allBars = [];
  const allRecords = [];
  for (const d of days) {
    const lines = d.times.map((t, i) => ({
      t, day: d.day, kind: 'trade', ran: [{ action: 'trade', ok: true }], cycles: [{ action: 'trade', at: t, ok: true }],
      refusals: (d.refusals || {})[t] || [], trades: i === d.times.length - 1 ? d.fills || [] : [],
    }));
    fs.writeFileSync(path.join(dir, `${d.day}.jsonl`), lines.map(l => `${JSON.stringify(l)}\n`).join(''));
    allRecords.push(...(d.records || []));
    allBars.push(...bars(d.barsStart || d.times[0], d.rows || []));
  }
  fs.mkdirSync(path.join(home, 'trade-lifecycle'), { recursive: true });
  fs.writeFileSync(path.join(home, 'trade-lifecycle', 'MNQ.jsonl'), allRecords.map(r => `${JSON.stringify(r)}\n`).join(''));
  fs.mkdirSync(path.join(home, 'bars'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify(allBars.map(({ ms: _m, ...b }) => b)));
  return { home, dir };
}

/** The first n weekdays from `from` (YYYY-MM-DD). */
function weekdays(from, n) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); out.length < n; t += 86400000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** A model stream trade (prop/model-stream.js's shape) on MNQ: a 40-tick stop, `move` ticks, its facts. */
function modelTrade(id, move, facts = {}, extra = {}) {
  return {
    id, symbol: 'MNQ', strategy: 'trade_lifecycle', direction: 'long', tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37,
    stopTicks: 40, moveTicks: move, r: move / 40, troughTicks: move < 0 ? [move] : [-8], adverse: 'bars', overshootTicks: move <= -40 ? 0 : null, noStop: null,
    facts: { regime: null, volatility: 'normal', window: 'ny-am', biasSide: 'with', alignment: 'aligned', dayType: 'normal', ...facts }, ...extra,
  };
}

/** A model stream over `dayList`, tradesFor(day, k) -> trades. */
function modelStreamOf(dayList, tradesFor, extra = {}) {
  const days = dayList.map((day, k) => ({ day, regime: 'normal', passes: 0, trades: tradesFor(day, k).map((t, seq) => ({ ...t, day, seq })) }));
  return { source: 'model', days, trades: days.flatMap(d => d.trades), excluded: [], fieldBranch: [], entryDelayMs: null, adverse: { bars: 0, bound: 0 }, runtimeMs: 0, ...extra };
}

module.exports = { M3, ACCOUNT, record, bars, tmpHome, multiDayRun, weekdays, modelTrade, modelStreamOf };
