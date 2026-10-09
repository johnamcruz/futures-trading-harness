'use strict';

/**
 * Live against the scan: for a trading day, which rules-strategy signals the
 * runner saw (the decision log, logs/scans-<day>.jsonl) were traded, how long
 * after the bar closed, which were passed and why (the nearest journal note),
 * and which entries had no signal behind them (manual strategies, or trades
 * the scan never saw). The pass rate and the results of taken vs passed
 * signals are the evidence for whether the LLM's judgment adds anything over
 * the mechanical rules, which a backtest can't show.
 */

const { contractRoot, entryTime } = require('./journal');
const { familyRoot } = require('./contracts');

const SETUP = /^\s*setup:([a-z0-9][a-z0-9_-]*)(?:\s+(long|short|buy|sell))?\b/i;
const RISK_REDUCING = /^\s*\[(exit|protect)\]/i;
const DIR = { long: 'long', buy: 'long', short: 'short', sell: 'short' };

/** Signals in scan records: [{ symbol, name, direction, bar, closedAt }]. */
function signalsOf(scans, timeframeMin) {
  const out = [];
  for (const rec of scans) {
    if (!rec || !rec.bar || !rec.bar.t) continue;
    const closedAt = Date.parse(rec.bar.t) + timeframeMin * 60000;
    for (const r of rec.results || []) {
      if (r.candidate && r.direction) out.push({ symbol: rec.symbol, name: r.name, direction: r.direction, bar: rec.bar.t, closedAt });
    }
  }
  return out;
}

/** Live entries in the journal: [{ ts, setup, direction, root, text }]. */
function entriesOf(journal) {
  return journal
    .filter(e => e.kind === 'order_placed' && e.data && e.data.result && e.data.result.success === true && !RISK_REDUCING.test(e.text || ''))
    .map(e => {
      const m = SETUP.exec(e.text || '');
      return { ts: entryTime(e), setup: m ? m[1].toLowerCase() : null, direction: m && m[2] ? DIR[m[2].toLowerCase()] : null, root: e.contractId ? contractRoot(e.contractId) : null, text: e.text };
    });
}

/**
 * @param scans the day's decision-log records
 * @param journal the journal entries of the day
 * @param opts { timeframeMin, windowMin (how long after the bar's close an entry still counts as taking it; default 10) }
 */
function reconcile(scans, journal, { timeframeMin = 3, windowMin = 10 } = {}) {
  const signals = signalsOf(scans, timeframeMin);
  const entries = entriesOf(journal);
  const notes = journal.filter(e => e.kind === 'note' || e.kind === 'plan');
  const used = new Set();
  const taken = [];
  const passed = [];
  for (const s of signals) {
    const k = entries.findIndex((e, idx) => !used.has(idx) && e.setup === s.name
      && (!e.direction || e.direction === s.direction)
      && (!e.root || familyRoot(e.root) === familyRoot(s.symbol))
      && e.ts >= s.closedAt && e.ts - s.closedAt <= windowMin * 60000);
    if (k >= 0) {
      used.add(k);
      taken.push({ ...s, enteredAt: new Date(entries[k].ts).toISOString(), latencySec: Math.round((entries[k].ts - s.closedAt) / 1000) });
    } else {
      const why = notes.find(n => entryTime(n) >= s.closedAt && entryTime(n) - s.closedAt <= windowMin * 60000);
      passed.push({ ...s, note: why ? String(why.text || '').slice(0, 160) : null });
    }
  }
  const offScan = entries.filter((_e, idx) => !used.has(idx));
  const lat = taken.map(t => t.latencySec).sort((a, b) => a - b);
  const byStrategy = {};
  for (const s of signals) {
    const b = (byStrategy[s.name] = byStrategy[s.name] || { signals: 0, taken: 0 });
    b.signals += 1;
  }
  for (const t of taken) byStrategy[t.name].taken += 1;
  return {
    signals: signals.length,
    taken: taken.length,
    passed: passed.length,
    takeRate: signals.length ? Math.round((taken.length / signals.length) * 100) / 100 : null,
    latencySec: lat.length ? { median: lat[Math.floor(lat.length / 2)], max: lat[lat.length - 1] } : null,
    offScanEntries: offScan.map(e => ({ at: new Date(e.ts).toISOString(), setup: e.setup, direction: e.direction, text: String(e.text || '').slice(0, 160) })),
    byStrategy,
    takenSignals: taken,
    passedSignals: passed,
  };
}

function toText(r, day) {
  const lines = [
    `Reconcile ${day}: ${r.signals} signal(s) from the scan, ${r.taken} taken (${r.takeRate === null ? '-' : `${Math.round(r.takeRate * 100)}%`}), ${r.passed} passed; ${r.offScanEntries.length} entr${r.offScanEntries.length === 1 ? 'y' : 'ies'} without a scan signal.`,
    r.latencySec ? `Entry latency after the bar closed: median ${r.latencySec.median} s, max ${r.latencySec.max} s.` : 'No entries matched a signal.',
    ...Object.entries(r.byStrategy).map(([k, v]) => `  ${k}: ${v.taken}/${v.signals} taken`),
    ...r.passedSignals.slice(0, 20).map(p => `  passed ${p.name} ${p.direction} on ${p.bar}${p.note ? `: ${p.note}` : ' (no note: why?)'}`),
    ...r.offScanEntries.map(e => `  off-scan entry ${e.at} ${e.setup || '?'} ${e.direction || ''}: ${e.text}`),
  ];
  return `${lines.join('\n')}\n`;
}

module.exports = { signalsOf, entriesOf, reconcile, toText };
