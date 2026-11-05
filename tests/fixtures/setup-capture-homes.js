'use strict';

// Tiny synthetic run homes for the setup-capture tests (scripts/lib/analysis/setup-capture.js): one session day of 3m
// bars, the runner config, the replay day records (decision times, skipped ones, fills), trade cycle logs, compose
// records, entry orders and the gate log, laid out as a replay writes them. Built in a temp folder at test time (no
// committed homes, no real data), with neutral names only.

const fs = require('fs');
const path = require('path');
const { appendBars } = require('../../scripts/lib/session/bars-archive');
const { buildCensus } = require('../../scripts/lib/learning/leg-census');

const DAY = '2021-06-14'; // a Monday in the practice-train window (EDT: the session opens 13:30Z)
const SESSION = '09:30-12:00@America/New_York';
const MIN3 = 3 * 60000;
const START = Date.parse(`${DAY}T13:24:00Z`); // two bars before the open

/** Up 4 points a bar for 9 bars from the open (09:30-09:57), down 4 a bar for 10, then flat. */
const CLOSES = [21500, 21500, ...Array.from({ length: 9 }, (_, i) => 21504 + 4 * i), ...Array.from({ length: 10 }, (_, i) => 21532 - 4 * i), 21492, 21492.5, 21492, 21492.5, 21492, 21492.5, 21492, 21492.5];

function barsOf(closes = CLOSES) {
  let prev = closes[0];
  return closes.map((c, i) => {
    const b = { t: new Date(START + i * MIN3).toISOString(), o: prev, h: Math.max(prev, c) + 0.25, l: Math.min(prev, c) - 0.25, c, v: 100 };
    prev = c;
    return b;
  });
}

const barT = i => new Date(START + i * MIN3).toISOString();
/** Bar i's close (the decision on it). */
const closeT = i => new Date(START + (i + 1) * MIN3).toISOString();
const plus = (iso, s) => new Date(Date.parse(iso) + s * 1000).toISOString();

/** The census legs of the fixture day: long from bar 2 (09:30) to bar 10 (09:54), short from 10 to 20. */
const LONG = { day: DAY, side: 'long', start: barT(2), end: barT(10), points: 36.5 };
const SHORT = { day: DAY, side: 'short', start: barT(10), end: barT(20), points: 40.5 };
const legId = g => `${g.day}|${g.side}|${g.start}`;

function census(legs = [LONG, SHORT]) {
  return buildCensus([], { legs, detector: { version: 'fixture' } }, { use: 'practice', seed: 1, now: new Date(0) });
}

/**
 * A run home under root/name. spec:
 *   times: bar indices with a decision time (default: every session bar); skipped: those passed while a cycle ran
 *   cycles: [{ i, result, entry, listed, fired: [{ name, direction }], on (prepare.on), overran, blocked, skips }]
 *   records: [{ id, side, i, ok, reads: [read], stopTicks }]   (reads: setup reads; bias etc. are not needed)
 *   orders: [{ orderId, i, record, side, entry, at? }]; fills: [{ orderId, i, r }] (an opening fill and its round trip)
 *   gate: gate-log lines; sessionBars: the session's bar indices
 */
function makeHome(root, name, spec = {}) {
  const home = path.join(root, name);
  const runDir = path.join(home, 'replay', name);
  fs.mkdirSync(runDir, { recursive: true });
  const bars = barsOf(spec.closes);
  appendBars(runDir, DAY, { symbol: 'MNQ', contractId: 'MNQ', minutes: 3, bars });
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ timeframe: 3, sessions: [SESSION] }));
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ v: 1, runId: name, source: 'replay' }));
  const session = spec.sessionBars || bars.map((_, i) => i).filter(i => i >= 2);
  const times = spec.times || session;
  const skipped = new Set(spec.skipped || []);
  const fills = spec.fills || [];
  const trades = i => fills.filter(f => f.i === i).flatMap(f => [
    { orderId: f.orderId, profitAndLoss: null, roundTripId: f.orderId, creationTimestamp: plus(closeT(f.i), 10), price: String(bars[f.i].c) },
    { orderId: f.orderId + 1000, profitAndLoss: f.r * 10, roundTripId: f.orderId, exitReason: f.r > 0 ? 'target' : 'stop', creationTimestamp: plus(closeT(f.i + 3), 10), roundTrip: { r: f.r, entryTime: plus(closeT(f.i), 10), exitTime: plus(closeT(f.i + 3), 10) } },
  ]);
  const lines = times.filter(i => !skipped.has(i)).map(i => ({ v: 1, t: plus(closeT(i), 2), day: DAY, kind: 'trade', trades: trades(i), skipped: [...skipped].filter(s => s > i && !times.some(j => j > i && j < s && !skipped.has(j))).map(s => plus(closeT(s), 2)) }));
  fs.writeFileSync(path.join(runDir, `${DAY}.jsonl`), `${lines.map(l => JSON.stringify(l)).join('\n')}\n`);
  const cdir = path.join(home, 'logs', 'cycles', DAY);
  fs.mkdirSync(cdir, { recursive: true });
  for (const c of spec.cycles || []) {
    const log = {
      action: 'trade', cycleAt: plus(closeT(c.i), 3), result: c.result || 'CYCLE RESULT: no-trade - nothing',
      timing: { barClose: closeT(c.i), overran: c.overran === true },
      context: { setupsListed: c.listed || [], symbols: [{ symbol: 'MNQ', fired: c.fired || [] }], account: { attempts: [{ status: 'active', entryBlock: c.blocked ? 'the attempt is blocked' : null }] } },
      summary: { setupSkips: c.skips || [] },
      ...(c.entry ? { entry: c.entry } : {}),
      ...(c.on ? { prepare: { on: c.on } } : {}),
    };
    fs.writeFileSync(path.join(cdir, `${closeT(c.i).slice(11, 19).replace(/:/g, '')}-trade.json`), JSON.stringify(log));
  }
  const lc = path.join(home, 'trade-lifecycle', 'MNQ');
  fs.mkdirSync(lc, { recursive: true });
  const recs = (spec.records || []).map(r => ({ id: r.id, side: r.side, bar: barT(r.i), ok: r.ok === true, reads: (r.reads || []).map(read => ({ step: 'setup', read, check: true, agrees: true })), problems: r.ok ? [] : ['refused'], plan: { stop: { ticks: r.stopTicks || 40 }, tick: 0.25 } }));
  fs.writeFileSync(path.join(lc, `${DAY}.jsonl`), recs.length ? `${recs.map(r => JSON.stringify(r)).join('\n')}\n` : '');
  fs.writeFileSync(path.join(home, 'entry-orders.json'), JSON.stringify((spec.orders || []).map(o => ({ orderId: o.orderId, at: o.at || plus(closeT(o.i), 5), contractId: 'MNQ', composed: { record: o.record, side: o.side, entry: o.entry || bars[o.i].c } }))));
  fs.writeFileSync(path.join(home, 'logs', 'gate-log.jsonl'), (spec.gate || []).map(g => JSON.stringify(g)).join('\n'));
  return home;
}

module.exports = { DAY, SESSION, MIN3, CLOSES, LONG, SHORT, legId, barsOf, barT, closeT, plus, census, makeHome };
