'use strict';

// Trend capture (scripts/lib/replay/trend-capture.js): the legs of a run's sessions (legsOf), each decision cycle's first
// blocker by flow step (classifyCycle), and the run's document (captureReport) from fixture logs: post-run analysis only.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const tc = require('../../scripts/lib/replay/trend-capture');
const { FLOW_STEPS, STEPS } = require('../../scripts/lib/trading/composed-reads');
const { appendBars } = require('../../scripts/lib/session/bars-archive');
const { tmpDir } = require('../helpers');

const SESSION = '09:30-12:00@America/New_York';
const T0 = Date.parse('2026-04-23T13:30:00Z'); // 09:30 ET
const MIN3 = 3 * 60000;

/** 3m bars from closes: each bar opens at the previous close, its high and low a quarter point past both. */
function barsOf(closes, start = T0 - 2 * MIN3, first = 21500) {
  let prev = first;
  return closes.map((c, i) => {
    const b = { t: new Date(start + i * MIN3).toISOString(), o: prev, h: Math.max(prev, c) + 0.25, l: Math.min(prev, c) - 0.25, c, v: 100 };
    prev = c;
    return b;
  });
}
// Two bars before the session, then: up 4 points a bar for 10 bars, down 4 a bar for 10, then flat.
const path1 = [21500, 21500, ...Array.from({ length: 10 }, (_, i) => 21504 + 4 * i), ...Array.from({ length: 10 }, (_, i) => 21536 - 4 * i), 21497, 21497.5, 21497];

test('trend capture: FLOW_STEPS are the compose steps, then risk and execution, frozen', () => {
  assert.deepStrictEqual([...FLOW_STEPS], [...STEPS, 'risk', 'execution']);
  assert.ok(Object.isFrozen(FLOW_STEPS));
  assert.strictEqual(tc.FLOW_STEPS, FLOW_STEPS);
});

test('trend capture: legsOf finds the up and the down leg in the session, scaled by its mean true range', () => {
  const bars = barsOf(path1);
  const legs = tc.legsOf(bars, { session: SESSION, minMoveAtr: 2 });
  assert.deepStrictEqual(legs.map(l => [l.side, l.start, l.end, l.from, l.to, l.points]), [
    ['long', bars[2].t, bars[11].t, 21499.75, 21540.25, 40.5],
    ['short', bars[11].t, bars[22].t, 21540.25, 21496.75, 43.5],
  ]);
  // The scale: the session bars' mean true range (4.5 on the moving bars, less on the flat ones).
  assert.ok(legs[0].scale > 3 && legs[0].scale < 4.5, String(legs[0].scale));
  assert.strictEqual(legs[0].day, '2026-04-23');
  // A threshold past the moves finds none; bars outside the session are never read.
  assert.deepStrictEqual(tc.legsOf(bars, { session: SESSION, minMoveAtr: 20 }), []);
  assert.deepStrictEqual(tc.legsOf(bars, { session: '12:00-13:00@America/New_York', minMoveAtr: 2 }), []);
  assert.deepStrictEqual(tc.legsOf([], { session: SESSION }), []);
});

test('trend capture: legsOf on the trend-move set finds the named legs (11 of 12; the twelfth starts in the last, cut session)', () => {
  const { load } = require('../fixtures/trend-moves');
  const { bars, legs } = load();
  const found = tc.legsOf(bars.m3, { session: SESSION });
  const named = legs.legs.filter(x => found.some(y => y.side === x.side && Math.abs(Date.parse(y.start) - Date.parse(x.start)) <= 2 * MIN3));
  assert.strictEqual(named.length, 11);
});

const cycle = (o = {}) => ({ action: 'trade', timing: { barClose: '2026-04-23T14:00:00.000Z' }, result: 'CYCLE RESULT: no-trade - nothing', ...o });
const rec = (o = {}) => ({ id: 'r1', side: 'long', bar: '2026-04-23T13:57:00.000Z', ok: false, reads: [], problems: [], ...o });

test('trend capture: classifyCycle names each blocker by flow step and who blocked it', () => {
  const k = (c, o) => { const x = tc.classifyCycle(c, { side: 'long', ...o }); return [x.step, x.by, x.code]; };
  assert.deepStrictEqual(k(cycle()), [null, 'head', 'no-plan']);
  assert.deepStrictEqual(k(cycle({ result: 'CYCLE RESULT: no-trade - entries not allowed in the opening print' })), [null, 'rule', 'opening-print']);
  assert.deepStrictEqual(k(cycle({ result: 'CYCLE RESULT: managed - a long open' })), [null, 'head', 'position-open']);
  // compose refused: the first failing flow step, its message the false read's fact.
  const entryRec = rec({ reads: [{ step: 'entry', read: '3m volume high', check: true, agrees: true, skill: 'momentum-and-volume' }], problems: ['the entry has no read pointing up (long): state the reaction\'s confirmation the trade\'s way'] });
  const x = tc.classifyCycle(cycle(), { side: 'long', records: [entryRec] });
  assert.deepStrictEqual([x.step, x.by, x.code, x.planned], ['entry', 'compose_check', 'entry:pointing', true]);
  assert.match(x.message, /no read pointing up/);
  assert.deepStrictEqual(x.reads, [{ step: 'entry', read: '3m volume high', skill: 'momentum-and-volume', verified: true }]);
  const falseTarget = rec({ reads: [{ step: 'target', read: 'target 1h swing 1', check: false, agrees: true, fact: '1h swing is 2' }] });
  assert.deepStrictEqual(k(cycle(), { records: [falseTarget] }), ['target', 'compose_check', 'target:false']);
  assert.strictEqual(tc.classifyCycle(cycle(), { side: 'long', records: [falseTarget] }).message, 'target 1h swing 1: 1h swing is 2');
  assert.deepStrictEqual(k(cycle(), { records: [rec({ problems: ['steps not stated: stop, target (every step needs a read, D7)'] })] }), ['stop', 'compose_check', 'stop:missing']);
  assert.deepStrictEqual(k(cycle(), { records: [rec({ side: 'short', problems: ['x'] })] }), [null, 'head', 'no-plan'], 'the other side\'s record is not the leg\'s');
  // An OK record, then each stage past it.
  const ok = [rec({ ok: true })];
  assert.deepStrictEqual(k(cycle(), { records: ok }), ['risk', 'head', 'head-pass']);
  const entry = o => cycle({ entry: { record: 'r1', ...o } });
  assert.deepStrictEqual(k(entry({ outcome: 'executed' }), { records: ok }), ['execution', 'executor', 'entered']);
  const late = tc.classifyCycle(entry({ outcome: 'late', why: 'missed the plan\'s entry', late: { movedR: 0.4 } }), { side: 'long', records: ok });
  assert.deepStrictEqual([late.step, late.by, late.code, late.movedR], ['execution', 'gate', 'late-entry', 0.4]);
  assert.deepStrictEqual(k(entry({ outcome: 'vetoed', why: 'VERDICT: VETO - min-contracts: size 2 under the floor of 3' }), { records: ok }), ['risk', 'phase2', 'min-contracts']);
  assert.deepStrictEqual(k(entry({ outcome: 'vetoed', why: 'VERDICT: VETO - serious against' }), { records: ok }), ['risk', 'phase2', 'veto']);
  assert.deepStrictEqual(k(entry({ outcome: 'vetoed', why: '## Phase 2 verdict: MNQ long' }), { records: ok }), ['risk', 'phase2', 'verdict-unread']);
  assert.deepStrictEqual(k(entry({ outcome: 'blocked', why: 'ABORTED Orders: none sent' }), { records: ok }), ['execution', 'executor', 'executor-abort']);
  const gate = [{ tool: 'place_order', decision: 'refused', rationale: 'setup:trade_lifecycle long ... record r1', violations: [{ check: 'composed-reads', message: 'a read is false now' }] }];
  assert.deepStrictEqual(k(cycle(), { records: ok, gate }), ['execution', 'gate', 'composed-reads']);
  for (const c of [cycle(), entry({ outcome: 'executed' })]) assert.ok([null, ...FLOW_STEPS].includes(tc.classifyCycle(c, { side: 'long', records: ok }).step));
});

/** A run home with the served bars, the runner config, cycle logs, compose records, an entry and its fill. */
function runFixture({ fill = true } = {}) {
  const home = tmpDir();
  const runDir = path.join(home, 'replay', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  const bars = barsOf(path1);
  appendBars(runDir, '2026-04-23', { symbol: 'MNQ', contractId: 'MNQ', minutes: 3, bars });
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ timeframe: 3, sessions: [SESSION] }));
  const cycles = path.join(home, 'logs', 'cycles', '2026-04-23');
  fs.mkdirSync(cycles, { recursive: true });
  // The long leg (09:30 to 09:57): a refused compose on its second bar, then an OK record entered on its third.
  const at = i => new Date(Date.parse(bars[i].t) + MIN3).toISOString();
  fs.writeFileSync(path.join(cycles, 'a.json'), JSON.stringify(cycle({ timing: { barClose: at(3) } })));
  fs.writeFileSync(path.join(cycles, 'b.json'), JSON.stringify(cycle({ timing: { barClose: at(4) }, entry: { record: 'ok1', outcome: 'executed' } })));
  fs.writeFileSync(path.join(cycles, 'c.json'), JSON.stringify(cycle({ timing: { barClose: at(14) }, result: 'CYCLE RESULT: no-trade - entries not allowed now (news blackout)' })));
  const lc = path.join(home, 'trade-lifecycle', 'MNQ');
  fs.mkdirSync(lc, { recursive: true });
  const records = [
    rec({ id: 'no1', bar: bars[3].t, problems: ['the setup has no read pointing up (long): state the reaction the trade\'s way'] }),
    rec({ id: 'ok1', bar: bars[4].t, ok: true, plan: { stop: { ticks: 40 }, tick: 0.25 } }),
  ];
  fs.writeFileSync(path.join(lc, '2026-04-23.jsonl'), `${records.map(r => JSON.stringify(r)).join('\n')}\n`);
  fs.writeFileSync(path.join(home, 'entry-orders.json'), JSON.stringify([{ orderId: 7, at: at(4), composed: { record: 'ok1', side: 'long', entry: 21516 } }]));
  const trades = fill ? [{ orderId: 7, profitAndLoss: null, roundTripId: 1 }, { orderId: 8, profitAndLoss: 50, roundTripId: 1, exitReason: 'target', roundTrip: { r: 2.1 } }] : [];
  return { home, runDir, days: { '2026-04-23': [{ t: at(4), trades }] }, bars };
}

test('trend capture: the run\'s document: a caught leg, a missed one with its blocker chain, the totals by step', () => {
  const { runDir, days } = runFixture();
  const doc = tc.captureReport({ runDir, days, manifest: { runId: 'r1', fingerprints: { harness: 'abc' } } });
  assert.deepStrictEqual([doc.v, doc.runId, doc.treeDigest, doc.detector.version, doc.detector.session], [1, 'r1', 'abc', tc.DETECTOR, SESSION]);
  assert.match(doc.barsDigest, /^[0-9a-f]{64}$/);
  assert.strictEqual(doc.legs.length, 2);
  const [up, down] = doc.legs;
  assert.strictEqual(up.id, `2026-04-23|long|${up.start}`);
  assert.deepStrictEqual([up.captured, up.entry.filled, up.entry.r, up.entry.outcome, up.blocker], [true, true, 2.1, 'target', null]);
  assert.strictEqual(up.plannedStopPts, 10);
  assert.deepStrictEqual(up.cycles.slice(0, 3).map(c => [c.step, c.code]), [[null, 'outside-session'], ['setup', 'setup:pointing'], ['execution', 'entered']]);
  // The short leg: its first-half cycles had no plan its way, one a news rule.
  assert.strictEqual(down.captured, false);
  assert.ok(down.cycles.some(c => c.by === 'rule' && c.code === 'news'));
  assert.ok(down.cycles.some(c => c.code === 'outside-session'), 'a bar with no cycle log');
  assert.deepStrictEqual([down.blocker.code, down.blocker.by], ['news', 'rule']);
  assert.strictEqual(down.estimated, true, 'no stop planned its way: the run\'s median stop');
  assert.deepStrictEqual([doc.totals.legs, doc.totals.captured, doc.totals.captureRate], [2, 1, 0.5]);
  assert.deepStrictEqual(Object.keys(doc.totals.byStep), ['none']);
  assert.strictEqual(doc.totals.byStep.none.legs, 1);
  assert.deepStrictEqual(doc.noLegDays, []);
  // Written to the run's folder and read back; the report's lines.
  tc.writeCapture(runDir, doc);
  assert.deepStrictEqual(tc.readCapture(runDir), doc);
  const lines = tc.reportLines(doc);
  assert.match(lines[0], /^2 trend leg\(s\) \(\d+(\.\d+)? x the session's mean true range\), 1 caught \(50%\)/);
  assert.ok(lines.some(l => /CAUGHT/.test(l)) && lines.some(l => /missed: no step news \(rule, 1 cycle\(s\)\)/.test(l)));
});

test('trend capture: an entry that never filled is the leg\'s execution blocker (unfilled), never a catch', () => {
  const { runDir, days } = runFixture({ fill: false });
  const doc = tc.captureReport({ runDir, days });
  const up = doc.legs[0];
  assert.deepStrictEqual([up.captured, up.entry.filled, up.blocker.step, up.blocker.code], [false, false, 'execution', 'unfilled']);
  assert.ok(doc.totals.byStep.execution.legs === 1);
});

test('trend capture: the replay report writes trend-capture.json beside report.md and shows its section', () => {
  const { runDir, days } = runFixture();
  const { summarize, toMarkdown, toText } = require('../../scripts/lib/replay/report');
  const s = summarize(days, { runDir });
  assert.ok(fs.existsSync(path.join(runDir, tc.FILE)));
  assert.match(toMarkdown(s, {}), /## Trend capture\n\n- 2 trend leg\(s\)/);
  assert.match(toText(s), /trend capture: 2 trend leg\(s\)/);
});
