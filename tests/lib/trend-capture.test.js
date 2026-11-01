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
function runFixture({ fill = true, trades: given = null, orders: more = [] } = {}) {
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
  fs.writeFileSync(path.join(home, 'entry-orders.json'), JSON.stringify([{ orderId: 7, at: at(4), composed: { record: 'ok1', side: 'long', entry: 21516 } }, ...more.map(o => ({ ...o, at: at(o.bar) }))]));
  const trades = given ? given(at) : fill ? [{ orderId: 7, profitAndLoss: null, roundTripId: 1 }, { orderId: 8, profitAndLoss: 50, roundTripId: 1, exitReason: 'target', roundTrip: { r: 2.1 } }] : [];
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

test('trend capture: given legs (a windowed run\'s, the census\'s) replace the detector\'s; their move from the start bar served', () => {
  const { runDir, days } = runFixture();
  const found = tc.captureReport({ runDir, days });
  const up = found.legs[0];
  // The same leg given as the census holds it (no prices): caught the same, its available R from the start bar's low.
  const given = tc.captureReport({ runDir, days, legs: [{ day: up.day, side: up.side, start: up.start, end: up.end, points: up.move.points }] });
  assert.deepStrictEqual(given.legs.map(l => [l.id, l.captured, l.availableR, l.move.from, l.move.to]), [[up.id, true, up.availableR, up.move.from, up.move.to]]);
  // A given leg whose start bar was never served: caught or not as before, its available R unknown (never a guess).
  const unserved = tc.captureReport({ runDir, days, legs: [{ day: up.day, side: 'short', start: '2026-04-23T18:00:00.000Z', end: '2026-04-23T18:30:00.000Z', points: 20 }] });
  assert.deepStrictEqual([unserved.legs.length, unserved.legs[0].availableR, unserved.legs[0].move.from], [1, null, null]);
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

// The up leg as legsOf finds it: from bars[2]'s low 21499.75 to bars[11]'s high 21540.25, 40.5 points.
const OPEN = at => ({ orderId: 7, profitAndLoss: null, roundTripId: 1, price: 21516, creationTimestamp: at(4) });

test('trend capture: a caught leg\'s ride from its round trip: lag, capture and ride share, peak and giveback; its size bucket', () => {
  // In at 21516 (16.25 of 40.5 points in), out at 21536.25 (20.25 banked of the 24.25 left), the round trip's best 2.5R.
  const trades = at => [OPEN(at), { orderId: 8, profitAndLoss: 40.5, roundTripId: 1, roundTrip: { r: 2.1, entryPrice: 21516, exitPrice: 21536.25, exitTime: at(9), mfeR: 2.5, risk: 10, open: false } }];
  const { runDir, days } = runFixture({ trades });
  const doc = tc.captureReport({ runDir, days });
  const [up, down] = doc.legs;
  assert.deepStrictEqual(up.ride, { entryLag: 0.4, captureShare: 0.5, rideShare: 0.84, peakR: 2.5, peakFrom: 'round-trip', givebackR: 0.4, r: 2.1, open: false });
  assert.strictEqual(up.ride.r, up.entry.r, 'the ride\'s R is the entry\'s');
  assert.strictEqual(down.ride, null, 'a missed leg has no ride');
  // Its size: its points over the threshold (minMoveAtr x the session's scale), bucketed.
  const x = Math.round((up.move.points / (doc.detector.minMove.atr * legScale(runDir))) * 100) / 100;
  assert.deepStrictEqual(up.size, { x, bucket: require('../../scripts/lib/replay/trend-ride').sizeBucket(x) });
  assert.ok(x >= 1, String(x));
  // The totals and the report's block.
  assert.deepStrictEqual([doc.totals.ride.legs, doc.totals.ride.caught, doc.totals.ride.captureShare.median, doc.totals.ride.rCaught], [2, 1, 0.5, 2.1]);
  const lines = tc.reportLines(doc);
  assert.ok(lines.some(l => /^Trend catch & ride: 2 leg\(s\), 1 caught \(50%\), R caught 2.1 \/ R available [\d.]+, median capture share 0.5, ride share 0.84, entry lag 0.4, giveback 0.4R, in-trend entries 1 of 1 \(100%\)$/.test(l)), lines.join('\n'));
});

/** The session's scale as legsOf computes it (the served bars' mean true range in the session). */
function legScale(runDir) {
  const { readArchive } = require('../../scripts/lib/session/bars-archive');
  const bars = readArchive(path.join(runDir, 'bars-2026-04-23.jsonl.gz')).map(x => x.bar);
  return tc.legsOf(bars, { session: SESSION })[0].scale;
}

test('trend capture: no round-trip peak: the peak from the closed bars held; a loss inside the leg shares negative', () => {
  // Out at 21510 at at(9) (bars[9]'s close), -0.6R: the bars closed before it, bars[5]..bars[8], top at bars[8]'s high
  // 21528.25 (bars[9], the exit's own bar, may hold its high after the stop filled in it).
  const trades = at => [OPEN(at), { orderId: 8, profitAndLoss: -12, roundTripId: 1, roundTrip: { r: -0.6, entryPrice: 21516, exitPrice: 21510, exitTime: at(9), risk: 10 } }];
  const { runDir, days } = runFixture({ trades });
  const up = tc.captureReport({ runDir, days }).legs[0];
  assert.deepStrictEqual(up.ride, { entryLag: 0.4, captureShare: -0.15, rideShare: -0.25, peakR: 1.23, peakFrom: 'bars', givebackR: 1.83, r: -0.6, open: false });
});

test('trend capture: a trade still open at the run\'s end: caught, open, no exit measure; its R unknown in the totals', () => {
  const { runDir, days } = runFixture({ trades: at => [OPEN(at)] });
  const doc = tc.captureReport({ runDir, days });
  const up = doc.legs[0];
  assert.deepStrictEqual([up.captured, up.ride.open, up.ride.captureShare, up.ride.givebackR, up.ride.entryLag], [true, true, null, null, 0.4]);
  assert.deepStrictEqual([doc.totals.ride.open, doc.totals.ride.rCaught, doc.totals.ride.rCaughtUnknown, doc.totals.ride.entries.inTrend], [1, 0, 1, { n: 1, r: 0, rUnknown: 1 }]);
});

test('trend capture: the run\'s filled entries: in a leg its way, against one, or in none, each with its R; an unfilled one not counted', () => {
  const trades = at => [
    OPEN(at), { orderId: 8, profitAndLoss: 40, roundTripId: 1, roundTrip: { r: 2, entryPrice: 21516, exitPrice: 21536, exitTime: at(9), mfeR: 2, risk: 10 } },
    { orderId: 9, profitAndLoss: null, roundTripId: 2, price: 21520, creationTimestamp: at(5) }, { orderId: 10, profitAndLoss: -20, roundTripId: 2, roundTrip: { r: -1 } },
    { orderId: 11, profitAndLoss: null, roundTripId: 3, price: 21497, creationTimestamp: at(23) }, { orderId: 12, profitAndLoss: -5, roundTripId: 3, roundTrip: { r: -0.5 } },
  ];
  // A short during the up leg (counter), a long after the last leg (none), and a long placed that never filled.
  const orders = [{ orderId: 9, bar: 5, composed: { record: 'c1', side: 'short', entry: 21520 } }, { orderId: 11, bar: 23, composed: { record: 'n1', side: 'long', entry: 21497 } }, { orderId: 13, bar: 24, composed: { record: 'u1', side: 'long', entry: 21490 } }];
  const { runDir, days, bars } = runFixture({ trades, orders });
  const doc = tc.captureReport({ runDir, days });
  const up = doc.legs[0];
  assert.deepStrictEqual(doc.entries.map(e => [e.side, e.kind, e.leg, e.r]), [['long', 'in-trend', up.id, 2], ['short', 'counter', up.id, -1], ['long', 'none', null, -0.5]]);
  assert.deepStrictEqual(doc.entries.map(e => e.at), [4, 5, 23].map(i => new Date(Date.parse(bars[i].t) + MIN3).toISOString()));
  assert.deepStrictEqual(doc.totals.ride.entries, { filled: 3, inTrend: { n: 1, r: 2, rUnknown: 0 }, counter: { n: 1, r: -1, rUnknown: 0 }, none: { n: 1, r: -0.5, rUnknown: 0 }, inTrendShare: 0.33 });
  assert.ok(tc.reportLines(doc).includes('  entries: in-trend 1 (+2R), counter 1 (-1R), no leg 1 (-0.5R)'));
  // The legs' catch is unchanged by the other entries.
  assert.deepStrictEqual(doc.legs.map(l => l.captured), [true, false]);
});

test('trend capture: each filled entry carries its round trip\'s peak R, so the round report\'s false starts read real entries', () => {
  // The real entry shape, built by captureReport: the fixture's round trips name mfeR only where the broker sent it.
  const trades = at => [
    OPEN(at), { orderId: 8, profitAndLoss: 40, roundTripId: 1, roundTrip: { r: 2, entryPrice: 21516, exitPrice: 21536, exitTime: at(9), mfeR: 2.4, risk: 10 } },
    { orderId: 9, profitAndLoss: null, roundTripId: 2, price: 21520, creationTimestamp: at(5) }, { orderId: 10, profitAndLoss: -20, roundTripId: 2, roundTrip: { r: -1, mfeR: 0.2 } },
    { orderId: 11, profitAndLoss: null, roundTripId: 3, price: 21497, creationTimestamp: at(23) }, { orderId: 12, profitAndLoss: -5, roundTripId: 3, roundTrip: { r: -0.5 } },
  ];
  const orders = [{ orderId: 9, bar: 5, composed: { record: 'c1', side: 'short', entry: 21520 } }, { orderId: 11, bar: 23, composed: { record: 'n1', side: 'long', entry: 21497 } }];
  const { runDir, days } = runFixture({ trades, orders });
  const doc = tc.captureReport({ runDir, days });
  assert.deepStrictEqual(doc.entries.map(e => [e.r, e.peakR]), [[2, 2.4], [-1, 0.2], [-0.5, null]]);
  // Through the round report's chop drag: one false start of the two with a peak (the -1R loser that never passed 0.5R).
  const c = require('../../scripts/lib/train/loss-diagnostics').chopDrag(doc.entries, { falseStartPeakR: 0.5, smallN: 30 });
  assert.deepStrictEqual([c.byReaction['not recorded'].falseStarts, c.byReaction['not recorded'].of], [1, 2]);
});

test('trend capture: the day\'s other known legs (context) classify the entries only: an entry in a lead-in bar is in its leg, never none', () => {
  const trades = at => [OPEN(at), { orderId: 8, profitAndLoss: 40, roundTripId: 1, roundTrip: { r: 2, entryPrice: 21516, exitPrice: 21536, exitTime: at(9), mfeR: 2, risk: 10 } },
    { orderId: 9, profitAndLoss: null, roundTripId: 2, price: 21520, creationTimestamp: at(5) }, { orderId: 10, profitAndLoss: -20, roundTripId: 2, roundTrip: { r: -1 } }];
  const { runDir, days } = runFixture({ trades, orders: [{ orderId: 9, bar: 5, composed: { record: 'c1', side: 'short', entry: 21520 } }] });
  const [up, down] = tc.captureReport({ runDir, days }).legs;
  const g = l => ({ id: l.id, day: l.day, side: l.side, start: l.start, end: l.end, points: l.move.points });
  // Only the down leg given (a windowed run's drawn leg): the up leg's long and short read none without it.
  const alone = tc.captureReport({ runDir, days, legs: [g(down)] });
  assert.deepStrictEqual(alone.entries.map(e => e.kind), ['none', 'none']);
  const withContext = tc.captureReport({ runDir, days, legs: [g(down)], context: [g(up)] });
  assert.deepStrictEqual(withContext.entries.map(e => [e.kind, e.leg]), [['in-trend', up.id], ['counter', up.id]]);
  assert.deepStrictEqual(withContext.legs.map(l => l.id), [down.id], 'a context leg is never a leg of the document');
});

test('trend capture: given legs carry no session scale unless given one: their size is unknown', () => {
  const { runDir, days } = runFixture();
  const up = tc.captureReport({ runDir, days }).legs[0];
  const given = tc.captureReport({ runDir, days, legs: [{ day: up.day, side: up.side, start: up.start, end: up.end, points: up.move.points }] });
  assert.deepStrictEqual(given.legs[0].size, { x: null, bucket: 'unknown' });
  const scaled = tc.captureReport({ runDir, days, legs: [{ day: up.day, side: up.side, start: up.start, end: up.end, points: up.move.points, scale: 6 }] });
  assert.deepStrictEqual(scaled.legs[0].size, { x: Math.round((up.move.points / (scaled.detector.minMove.atr * 6)) * 100) / 100, bucket: '2-4x' });
});

test('trend capture: the ride reads the fills, never the plan: the opening fill\'s price without a round-trip entry; an open round trip has no exit', () => {
  // Filled a point worse than the plan's 21516 (21517), the round trip naming no entry price: the lag from the fill.
  const slip = at => [{ ...OPEN(at), price: 21517 }, { orderId: 8, profitAndLoss: 30, roundTripId: 1, roundTrip: { r: 1.9, exitPrice: 21536, exitTime: at(9), mfeR: 2, risk: 10 } }];
  let x = runFixture({ trades: slip });
  const up = tc.captureReport({ runDir: x.runDir, days: x.days }).legs[0];
  assert.deepStrictEqual([up.ride.entryLag, up.ride.captureShare], [0.43, 0.47], '17.25 and 19 of 40.5 points');
  // A round trip still open (the broker's interim record, its last price as exitPrice): open, no exit measure.
  const open = at => [OPEN(at), { orderId: 8, profitAndLoss: 0, roundTripId: 1, roundTrip: { r: 0.5, entryPrice: 21516, exitPrice: 21521, mfeR: 1, risk: 10, open: true } }];
  x = runFixture({ trades: open });
  const o = tc.captureReport({ runDir: x.runDir, days: x.days }).legs[0];
  assert.deepStrictEqual([o.ride.open, o.ride.captureShare, o.ride.givebackR], [true, null, null]);
});

test('trend capture: the run\'s exits: a model stop tighten from a cycle transcript took the trade out; scored by what came next, with its facts', () => {
  // In at 21516 at at(4); the runner trailed at at(6) (its event log), the model tightened to 21524 at at(8) (its cycle's
  // transcript); the stop filled at at(14), past the leg's top: price then fell on, so the exit was right.
  const trades = at => [OPEN(at), { orderId: 8, profitAndLoss: 16, roundTripId: 1, roundTrip: { id: 1, contractId: 'MNQ', direction: 'long', r: 0.8, entryTime: at(4), averageEntryPrice: 21516, exitPrice: 21524, exitTime: at(14), mfeR: 2.4, risk: 10, open: false, reason: 'stop' } }];
  const { home, runDir, days, bars } = runFixture({ trades });
  const at = i => new Date(Date.parse(bars[i].t) + MIN3).toISOString();
  const use = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  fs.writeFileSync(path.join(home, 'logs', 'cycles', '2026-04-23', 'd.json'), JSON.stringify(cycle({ action: 'manage', result: 'CYCLE RESULT: managed', timing: { barClose: at(8) }, transcript: use('mcp__broker__modify_order', { orderId: 9, stopPrice: 21524 }) })));
  fs.writeFileSync(path.join(home, 'logs', 'events-2026-04-23.jsonl'), `${JSON.stringify({ at: at(6), kind: 'stop_moved', to: 21510 })}\n`);
  const doc = tc.captureReport({ runDir, home, days });
  const [d] = doc.exits.decisions;
  assert.deepStrictEqual([d.exitBy, d.cls, d.late, d.decidedAt], ['model-stop', 'right', true, at(8)]);
  assert.strictEqual(d.facts.side, 'long');
  // Its facts read only the bars closed by the decision: the last close is bar 8's.
  assert.strictEqual(d.facts.close, bars[8].c);
  assert.deepStrictEqual(doc.exits.tightens.map(x => [x.stopped, x.cls]), [[true, 'right']]);
  assert.strictEqual(doc.exits.totals.byExit['model-stop'].right, 1);
  const lines = tc.reportLines(doc);
  assert.ok(lines.some(l => /Exit decisions/.test(l)) && lines.some(l => /model-stop: 1 exit\(s\)/.test(l)), lines.join('\n'));
});

test('trend capture: the run\'s exits from the gateway\'s records: a trade-executor\'s own-session tighten (no transcript) is the model\'s', () => {
  const trades = at => [OPEN(at), { orderId: 8, profitAndLoss: 16, roundTripId: 1, roundTrip: { id: 1, contractId: 'MNQ', direction: 'long', r: 0.8, entryTime: at(4), averageEntryPrice: 21516, exitPrice: 21524, exitTime: at(14), mfeR: 2.4, risk: 10, open: false, reason: 'stop' } }];
  const { home, runDir, days, bars } = runFixture({ trades });
  const at = i => new Date(Date.parse(bars[i].t) + MIN3).toISOString();
  // The managed cycle at bar 8 ran 18:00:00-18:00:30 wall clock; the executor's modify_order reached the gateway at 18:00:10.
  fs.writeFileSync(path.join(home, 'logs', 'cycles', '2026-04-23', 'e.json'), JSON.stringify(cycle({ action: 'manage', result: 'CYCLE RESULT: managed', at: '2026-10-27T18:00:00.000Z', durationMs: 30000, timing: { barClose: at(8) } })));
  fs.writeFileSync(path.join(home, 'logs', 'gate-log.jsonl'), `${JSON.stringify({ ts: '2026-10-27T18:00:10.000Z', source: 'gateway', tool: 'modify_order', decision: 'allowed', violations: [], orderId: 9, stopPrice: 21524, contractId: 'MNQ' })}\n`);
  fs.writeFileSync(path.join(home, 'logs', 'events-2026-04-23.jsonl'), `${JSON.stringify({ at: at(2), kind: 'order_placed' })}\n`);
  const doc = tc.captureReport({ runDir, home, days });
  const [d] = doc.exits.decisions;
  assert.deepStrictEqual([d.exitBy, d.decidedAt], ['model-stop', at(8)]);
  // The late threshold is the rulebook's lock (1.5), never the config's 1 below it: a 2.4R peak, 0.8R kept: 1.6R given.
  assert.strictEqual(doc.exits.thresholds.lateGivebackR, 1.5);
  assert.deepStrictEqual([d.late, d.lateR], [true, 0.1]);
});

test('trend capture: the run\'s exits: the transcript and the gateway record of one modify_order are one tighten; no runner events read = unattributed, no finding', () => {
  const trades = at => [OPEN(at), { orderId: 8, profitAndLoss: 16, roundTripId: 1, roundTrip: { id: 1, contractId: 'MNQ', direction: 'long', r: 0.8, entryTime: at(4), averageEntryPrice: 21516, exitPrice: 21524, exitTime: at(14), mfeR: 2.4, risk: 10, open: false, reason: 'stop' } }];
  const { home, runDir, days, bars } = runFixture({ trades });
  const at = i => new Date(Date.parse(bars[i].t) + MIN3).toISOString();
  const use = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  // The head trader's modify_order (no contract in its input) and the gateway's record of it (with the contract).
  fs.writeFileSync(path.join(home, 'logs', 'cycles', '2026-04-23', 'd.json'), JSON.stringify(cycle({ action: 'manage', result: 'CYCLE RESULT: managed', at: '2026-10-27T18:00:00.000Z', durationMs: 30000, timing: { barClose: at(8) }, transcript: use('mcp__broker__modify_order', { orderId: 9, stopPrice: 21524 }) })));
  fs.writeFileSync(path.join(home, 'logs', 'gate-log.jsonl'), `${JSON.stringify({ ts: '2026-10-27T18:00:10.000Z', source: 'gateway', tool: 'modify_order', decision: 'allowed', violations: [], orderId: 9, stopPrice: 21524, contractId: 'MNQ' })}\n`);
  fs.writeFileSync(path.join(home, 'logs', 'events-2026-04-23.jsonl'), `${JSON.stringify({ at: at(6), kind: 'stop_moved', to: 21510 })}\n`);
  const doc = tc.captureReport({ runDir, home, days });
  assert.deepStrictEqual([doc.exits.decisions[0].exitBy, doc.exits.tightens.length], ['model-stop', 1]);
  // No runner events: the stop's last mover is unknown, so it is not called the initial stop (a false late-exit finding).
  fs.rmSync(path.join(home, 'logs', 'events-2026-04-23.jsonl'));
  const blind = tc.captureReport({ runDir, home, days });
  assert.strictEqual(blind.exits.decisions[0].exitBy, 'unattributed');
  assert.strictEqual(require('../../scripts/lib/train/exit-findings').MODEL_DECIDED.has('unattributed'), false);
});

test('trend capture: an entry placed before the leg\'s start is its catch when it fills in the leg\'s first half; filled before the start or after that half, not', () => {
  // The up leg runs bars[2] to bars[11]: its first half ends at bars[7]'s open. A long placed at bars[0]'s close, before
  // the leg (2021-06-28: placed 75 s before the leg's start bar, filled at its open); the plan's order 7 never fills.
  const placedEarly = filledAt => at => [{ orderId: 20, profitAndLoss: null, roundTripId: 1, price: 21500, creationTimestamp: filledAt(at) },
    { orderId: 21, profitAndLoss: 30, roundTripId: 1, exitReason: 'target', roundTrip: { r: 1.5, entryTime: filledAt(at), entryPrice: 21500, exitPrice: 21530, exitTime: at(12), mfeR: 2, risk: 20, open: false } }];
  const run = filledAt => { const x = runFixture({ trades: placedEarly(filledAt), orders: [{ orderId: 20, bar: 0, composed: { record: 'early', side: 'long', entry: 21500 } }] }); return tc.captureReport({ runDir: x.runDir, days: x.days }); };
  // Filled at the leg's start bar's open (the edge): caught, and the entry is in the leg (at its fill, not its order).
  const atStart = run(at => at(1));
  assert.deepStrictEqual([atStart.legs[0].captured, atStart.legs[0].entry.r], [true, 1.5]);
  assert.deepStrictEqual(atStart.entries.map(e => [e.kind, e.leg]), [['in-trend', atStart.legs[0].id]]);
  // Filled at the end of the first half (bars[6]'s close): caught.
  assert.strictEqual(run(at => at(6)).legs[0].captured, true);
  // Filled a bar after the half: not caught (the plan's unfilled order is the blocker).
  const late = run(at => at(7)).legs[0];
  assert.deepStrictEqual([late.captured, late.blocker.code], [false, 'unfilled']);
  // Filled before the leg's start (bars[0]'s close, a bar before bars[2]'s open): not this leg's catch.
  assert.strictEqual(run(at => at(0)).legs[0].captured, false);
});

test('trend capture: a trade\'s R, peak and the leg\'s available R on the stop it held after the runner\'s move to the plan\'s stop', () => {
  // In at 21516 with a 10-point bracket stop (21506), moved by the runner to the plan's 21508 (8 points) after the fill:
  // the broker's 2.1R (21 points over 10) is 2.625R on the stop it held, its 2.5R best 3.125R (the ride's peak at 0.01: 3.13).
  const trades = at => [OPEN(at), { orderId: 8, profitAndLoss: 40.5, roundTripId: 1, roundTrip: { contractId: 'MNQ', direction: 'long', r: 2.1, entryTime: at(4), entryPrice: 21516, exitPrice: 21537, exitTime: at(9), mfeR: 2.5, risk: 10, initialStop: 21506, open: false } }];
  const x = runFixture({ trades });
  const before = tc.captureReport({ runDir: x.runDir, days: x.days }).legs[0];
  assert.deepStrictEqual([before.entry.r, before.entry.rBasis, before.ride.peakR], [2.1, 'bracket stop', 2.5], 'no move: the broker\'s');
  fs.mkdirSync(path.join(x.home, 'logs'), { recursive: true });
  const moved = { at: new Date(Date.parse(x.bars[5].t) + 1000).toISOString(), kind: 'stop_moved', symbol: 'MNQ', contractId: 'MNQ', from: 21506, to: 21508, why: 'plan stop' };
  fs.writeFileSync(path.join(x.home, 'logs', 'events-2026-04-23.jsonl'), `${JSON.stringify(moved)}\n`);
  const up = tc.captureReport({ runDir: x.runDir, days: x.days }).legs[0];
  assert.deepStrictEqual([up.entry.r, up.entry.rBasis, up.ride.r, up.ride.peakR], [2.625, 'held stop', 2.625, 3.13]);
  // Its available R on that 8-point stop (the plan's record planned 10), never estimated.
  // From bars[3]'s close (21508) to the leg's high (21540.25): 32.25 points, 4.03R on 8 (3.23R on the planned 10).
  assert.deepStrictEqual([before.availableR, up.availableR, up.estimated], [3.23, 4.03, false]);
});

test('trend capture: the broker\'s "trail" for an exit at the stop the trade held (the trail never armed) reads "stop"', () => {
  // A long stopped a tick under the plan's stop the runner moved it to (21508): the broker calls a moved stop a trail.
  const trades = at => [OPEN(at), { orderId: 8, profitAndLoss: -16.5, roundTripId: 1, exitReason: 'trail', roundTrip: { contractId: 'MNQ', direction: 'long', r: -0.825, entryTime: at(4), entryPrice: 21516, exitPrice: 21507.75, exitTime: at(9), mfeR: 0.5, risk: 10, initialStop: 21506, reason: 'trail', open: false } }];
  const x = runFixture({ trades });
  fs.mkdirSync(path.join(x.home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(x.home, 'logs', 'events-2026-04-23.jsonl'), `${JSON.stringify({ at: new Date(Date.parse(x.bars[5].t) + 1000).toISOString(), kind: 'stop_moved', symbol: 'MNQ', to: 21508, why: 'plan stop' })}\n`);
  const up = tc.captureReport({ runDir: x.runDir, days: x.days }).legs[0];
  assert.deepStrictEqual([up.entry.outcome, up.entry.r], ['stop', -1.031]);
});
