'use strict';

// Fixtures for the learning loop's tests: trade_lifecycle records in the design's shape (the composed-entry design,
// section 3.3), 3-minute bars, and a finished replay run directory.

const fs = require('fs');
const os = require('os');
const path = require('path');

const M3 = 180000;
const ms = iso => Date.parse(iso);

/** A trade_lifecycle record as compose_check appends it (the design's fields). */
function record({ at = '2023-03-15T14:00:00.000Z', side = 'long', ok = true, entry = 100, stop = 98, target = 104, expiresAt = null, regime = 'trend-up', window = 'ny-am', trendRule = 'allows', skills = null, root = 'MNQ' } = {}) {
  const sk = skills || ['bos-vs-choch', 'vwap-volume-profile', 'rejection', 'candle-reading', 'invalidation', 'top-down-entry'];
  const up = side === 'long';
  return {
    root, contract: `${root}:2023-06`, side, bar: new Date(ms(at) - M3).toISOString(), at, expiresAt: expiresAt || new Date(ms(at) + M3).toISOString(),
    runId: 'run1', lane: 3,
    context: { regime: { primary: regime, volatility: 'normal' }, window, trendRule, alignment: up ? 'aligned' : 'counter', dayType: 'normal' },
    reads: [
      { step: 'bias', skill: sk[0], read: `1h bos ${up ? 'up' : 'down'}`, why: 'broke the last swing', check: 'true' },
      { step: 'location', skill: sk[1], read: 'at prior VAH', check: 'true' },
      { step: 'setup', skill: sk[2], read: `15m rejected prior VAH ${up ? 'up' : 'down'}`, check: 'true' },
      { step: 'entry', skill: sk[3], read: `3m close ${up ? 'top' : 'bottom'}`, check: 'true' },
      { step: 'stop', skill: sk[4], read: `stop 15m ${up ? 'low' : 'high'} ${stop}`, check: 'true' },
      { step: 'target', skill: sk[5], read: `target 60m swing ${target}`, check: 'true' },
    ],
    plan: { entry, stop, target, size: 1, rr: Math.abs(target - entry) / Math.abs(entry - stop) },
    exploratory: false, ok, reasons: ok ? [] : ['a read is false'],
  };
}

/** 3-minute bars from a start time: [[o, h, l, c], ...]. */
const bars = (start, rows) => rows.map(([o, h, l, c], i) => ({ t: new Date(ms(start) + i * M3).toISOString(), ms: ms(start) + i * M3, o, h, l, c, v: 100 }));

function tmpHome(prefix = 'fth-learn-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A finished replay run under <home>/replay/<runId>: one day, trade cycles at `times`, fills in the first line,
 * the records in <home>/trade-lifecycle/MNQ.jsonl and bars in <home>/bars/MNQ-3m.json.
 */
function runDir({ home = tmpHome(), day = '2023-03-15', times = [], fills = [], refusals = {}, records = [], barRows = [], barsStart = null, runId = 'run1', gate = undefined } = {}) {
  const dir = path.join(home, 'replay', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runId, finished: true, daysDone: [day], broker: 'replay' }));
  // The learning gate's decision (learning/run-gate.js): a learning run in its day's window by default; null: none.
  const g = gate === undefined ? { learning: true, role: require('../../scripts/lib/learning/splits').roleOf(day), look: null, hideOutcomes: false } : gate;
  if (g) fs.writeFileSync(path.join(home, 'learning-run.json'), JSON.stringify(g));
  fs.writeFileSync(path.join(dir, 'autotrader.json'), JSON.stringify({ timeframe: 3, symbols: ['MNQ'] }));
  const lines = times.map((t, i) => ({ t, day, kind: 'trade', ran: [{ action: 'trade', ok: true }], cycles: [{ action: 'trade', at: t, ok: true }], refusals: refusals[t] || [], trades: i === times.length - 1 ? fills : [] }));
  fs.writeFileSync(path.join(dir, `${day}.jsonl`), lines.map(l => `${JSON.stringify(l)}\n`).join(''));
  fs.mkdirSync(path.join(home, 'trade-lifecycle'), { recursive: true });
  fs.writeFileSync(path.join(home, 'trade-lifecycle', 'MNQ.jsonl'), records.map(r => `${JSON.stringify(r)}\n`).join(''));
  fs.mkdirSync(path.join(home, 'bars'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify(bars(barsStart || times[0], barRows).map(({ ms: _m, ...b }) => b)));
  return { home, dir };
}

module.exports = { M3, record, bars, runDir, tmpHome };
