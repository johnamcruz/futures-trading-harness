'use strict';

const test = require('node:test');
const assert = require('node:assert');
const GP = require('../../scripts/lib/eval/goal-path');

// A synthetic tier 2 day: one long, entered at market on the bar after B, its bracket stop 80 ticks (20 points) under the
// fill, the 2R target leg cancelled at the first managed cycle, the stop moved once at 2.1R, out on the trailed stop at
// +1R, the end of day recorded. Prices in points (tick 0.25).
const B = '2022-03-30T13:42:00.000Z';
const C = '2022-03-30T13:45:00.000Z';
const F = '2022-03-30T13:45:02.000Z';
const X = '2022-03-30T15:00:00.000Z';
function day(o = {}) {
  return {
    day: '2022-03-30', tick: 0.25,
    decisions: [{ bar: B, side: 'long', setup: 'momentum_continuation fired up', kind: 'cited', bias: 'Bias: long only (4h up, 1h up; short refused)', compose: 'ok' }],
    records: [{ id: 'aaaaaaaaaaaaaaaa', at: F, ok: true, side: 'long', cycleBar: B, plan: { stop: { ticks: 80 }, target: { ticks: 160 } }, problems: [] }],
    cycles: [{ at: F, timing: { decision: F }, entry: { record: 'aaaaaaaaaaaaaaaa', outcome: 'executed', size: { approved: 5 }, timing: { barClose: C, orderMs: 2500 } } }],
    gate: [{ tool: 'place_order', source: 'gateway', decision: 'allowed', violations: [], rationale: 'setup:prop_portfolio long trade_lifecycle record aaaaaaaaaaaaaaaa', cycle: 'c1' }],
    sent: [{ at: F, barClose: C }],
    calls: [{ tool: 'place_order', args: { size: 5, rationale: 'setup:prop_portfolio long trade_lifecycle record aaaaaaaaaaaaaaaa' } }],
    orders: [
      { id: 100, parentId: null, type: 2, side: 0, size: 5, status: 2, filledPrice: 100, brackets: { stop: 80, target: 160 }, creationTimestamp: F, updateTimestamp: F },
      { id: 103, parentId: 100, type: 4, side: 1, size: 5, status: 2, stopPrice: 110, creationTimestamp: F, updateTimestamp: X },
      { id: 104, parentId: 100, type: 1, side: 1, size: 5, status: 3, limitPrice: 140, creationTimestamp: F, updateTimestamp: '2022-03-30T13:48:02.000Z' },
    ],
    fills: [
      { id: 101, orderId: 100, price: 100, size: 5, side: 0, profitAndLoss: null, creationTimestamp: F },
      { id: 105, orderId: 103, price: 120, size: 5, side: 1, profitAndLoss: 50, creationTimestamp: X },
    ],
    events: [{ kind: 'stop_moved', at: '2022-03-30T14:30:02.000Z', from: 80, to: 110, peakR: 2.1 }, { kind: 'close_recorded', day: '2022-03-30', at: '2022-03-30T19:53:02.000Z' }],
    attempt: { days: [{ day: '2022-03-30', balance: 100050 }] },
    legs: [{ day: '2022-03-30', side: 'long', start: '2022-03-30T13:42:00.000Z', until: '2022-03-30T14:00:00.000Z', end: '2022-03-30T14:20:00.000Z', to: 160, startClose: 100 }],
    snaps: [], faults: [],
    ...o,
  };
}
const one = d => GP.dayTrades(d, { tick: 0.25 });

test('dayTrades: the trade and its whole trace, every step in order', () => {
  const [t] = one(day());
  assert.deepStrictEqual(t.steps, ['bias', 'setup', 'compose', 'phase2', 'gate', 'order', 'fill', 'bracket', 'trail', 'exit', 'eod']);
  assert.deepStrictEqual([t.key, t.side, t.entry, t.size, t.exitReason, t.exitPrice, t.R, t.riskPts], [`2022-03-30|long|${B}`, 'long', 100, 5, 'trail', 120, 1, 20]);
  assert.strictEqual(t.trace.find(x => x.step === 'order').afterCloseS, 2);
  assert.strictEqual(t.trace.find(x => x.step === 'bracket').price, 80);
  assert.deepStrictEqual(GP.traceProblems(t), []);
  // An earlier limit that never filled (its record expired) shifts nothing: each order is its own call's.
  const r2 = 'setup:prop_portfolio long trade_lifecycle record bbbbbbbbbbbbbbbb';
  const d = day();
  const early = day({
    orders: [{ id: 90, parentId: null, type: 1, side: 0, size: 3, status: 3, limitPrice: 99, creationTimestamp: C, updateTimestamp: C }, ...d.orders],
    calls: [{ tool: 'place_order', args: { size: 3, rationale: r2 } }, ...d.calls],
    gate: [{ ...d.gate[0], rationale: r2, cycle: 'c0' }, ...d.gate],
  });
  assert.strictEqual(one(early)[0].record, 'aaaaaaaaaaaaaaaa');
});

test('traceProblems: a step that failed or went missing, a trail move before the target\'s R, a step out of time', () => {
  assert.match(GP.traceProblems(one(day({ events: [day().events[0]] }))[0]).join(), /eod failed/);
  assert.match(GP.traceProblems(one(day({ events: [{ ...day().events[0], peakR: 1.4 }, day().events[1]] }))[0]).join(), /trail failed/);
  assert.match(GP.traceProblems(one(day({ orders: day().orders.filter(o => o.type !== 4 || o.status !== 2).concat([{ ...day().orders[1], type: 2 }]) }))[0]).join(), /bracket failed/);
  assert.match(GP.traceProblems(one(day({ gate: [{ ...day().gate[0], violations: [{ check: 'x', message: 'y' }] }] }))[0]).join(), /gate failed/);
});

test('compareTrades: each lost or changed trade named by the category of its break, with its reason', () => {
  const main = one(day());
  const cat = (d, trades = one(d)) => GP.compareTrades(main, trades, [d]).map(c => [c.category, c.why]);
  assert.deepStrictEqual(cat(day()), []);
  const flat = { fills: [], orders: [] };
  assert.deepStrictEqual(cat(day({ ...flat, decisions: [{ bar: B, pass: 'no setup listed' }] })), [['a', 'lost: no setup listed']]);
  assert.deepStrictEqual(cat(day({ ...flat, decisions: [{ ...day().decisions[0], compose: 'FALSE entry: no' }] })), [['b', 'lost: FALSE entry: no']]);
  assert.deepStrictEqual(cat(day({ ...flat, cycles: [{ ...day().cycles[0], entry: { record: 'aaaaaaaaaaaaaaaa', outcome: 'vetoed', why: 'VERDICT: VETO' } }] })), [['c', 'lost: VERDICT: VETO']]);
  const refused = (check, message) => day({ ...flat, cycles: [{ ...day().cycles[0], entry: { record: 'aaaaaaaaaaaaaaaa', outcome: 'blocked' } }], gate: [{ ...day().gate[0], decision: 'refused', violations: [{ check, message }] }] });
  assert.deepStrictEqual(cat(refused('max-risk', 'too big')), [['d', 'lost: [max-risk] too big']]);
  assert.match(cat(refused('composed-reads', 'the compose record expired at 13:51'))[0].join(), /^e,lost: \[composed-reads\] the compose record expired at 13:51 \(the order 2 s after the bar close\)$/);
  assert.deepStrictEqual(cat(day({ ...flat, cycles: [{ ...day().cycles[0], entry: { record: 'aaaaaaaaaaaaaaaa', outcome: 'late', why: 'missed', timing: { orderMs: null } } }] }))[0][0], 'e');
  assert.deepStrictEqual(cat(day({ fills: [{ ...day().fills[0], price: 100.5 }, day().fills[1]] }))[0][0], 'f');
  assert.match(cat(day({ fills: [day().fills[0], { ...day().fills[1], price: 118 }] }))[0].join(), /^g,exit trail 120 \(1R, trailed to 110\) on main, trail 118 \(0\.9R, trailed to 110\) now$/);
  const noTrail = day({ events: [day().events[1]] });
  assert.deepStrictEqual(cat(noTrail)[0][0], 'g', 'the trail\'s moves are part of the exit');
  const added = [...main, { ...main[0], key: 'new|long|x' }];
  assert.deepStrictEqual(GP.compareTrades(main, added, [day()]).map(c => c.category), ['new']);
});

test('summarize, fillShare, tier2Rows and tier2RiseProblems: the tier 2 metrics and their gate', () => {
  const t = one(day());
  const mech = [{ day: '2022-03-30', side: 'long', entryTime: '2022-03-30T13:48:00.000Z' }];
  const s = GP.summarize(t, { legs: day().legs, mechanical: mech, spanMs: 15 * 60000, blows: 0 });
  assert.deepStrictEqual(s, { trades: 1, totalR: 1, meanR: 1, caught: 0.3333, fills: 1, blows: 0 });
  assert.strictEqual(GP.fillShare(t, [{ ...mech[0], side: 'short' }], 15 * 60000), 0);
  const tol = { trades: 0, totalR: 0.25, fills: 0.1 };
  assert.ok(GP.tier2Rows(s, s, tol).every(r => r.ok));
  assert.deepStrictEqual(GP.tier2Rows(s, { ...s, blows: 1, totalR: 0.7, fills: 0.85, trades: 0 }, tol).filter(r => !r.ok).map(r => r.key), ['blows', 'trades', 'totalR', 'fills']);
  assert.deepStrictEqual(GP.tier2RiseProblems(s, { ...s, totalR: 2 }), []);
  assert.match(GP.tier2RiseProblems(s, { ...s, fills: 0.5 }).join(), /fills/);
  assert.match(GP.tier2RiseProblems(s, { ...s, trades: 0 }).join(), /trades/);
  assert.match(GP.tier2RiseProblems(s, null).join(), /no summary/);
  assert.ok(GP.tier2Rows({ ...s, totalR: null }, s, tol).some(r => !r.ok), 'a baseline value missing fails, never passes');
});

test('pickDays: seeded, the trend and other days split over both halves', () => {
  const blocks = [{ half: 'A', sessions: ['a1', 'a2', 'a3', 'a4'], trend: ['a1', 'a2'] }, { half: 'B', sessions: ['b1', 'b2', 'b3', 'b4'], trend: ['b3', 'b4'] }, { half: 'M', sessions: ['m1'], trend: ['m1'] }];
  const d = GP.pickDays(blocks, { seed: 1, trendDays: 2, otherDays: 2 });
  assert.deepStrictEqual(d, GP.pickDays(blocks, { seed: 1, trendDays: 2, otherDays: 2 }));
  assert.strictEqual(d.length, 4);
  assert.ok(!d.includes('m1'), 'never a move day');
  assert.strictEqual(d.filter(x => ['a1', 'a2', 'b3', 'b4'].includes(x)).length, 2);
});

test('faultChecks: a position uncovered more than one pass (a late fill: any pass), an exit refused (a working stop cancelled too), a duplicate position, no recovery: each a problem', () => {
  const pos = (at, stops) => ({ at, position: { side: 'long', size: 5, price: 100 }, stops });
  const ok = [pos('2022-03-30T13:45:02.000Z', [{ side: 1, size: 5, price: 80 }]), { at: '2022-03-30T15:03:02.000Z', position: null, stops: [] }];
  const faults = [{ at: '2022-03-30T13:45:02.000Z', kind: 'lost-reply' }];
  const good = GP.faultChecks(day({ snaps: ok, faults }));
  assert.deepStrictEqual(good.problems, []);
  assert.deepStrictEqual(good.trace.map(x => x.step), ['fault', 'recovery']);
  const gap = [pos('2022-03-30T13:45:02.000Z', []), pos('2022-03-30T13:48:02.000Z', [{ side: 1, size: 2, price: 80 }]), pos('2022-03-30T13:51:02.000Z', [{ side: 1, size: 5, price: 80 }])];
  assert.match(GP.faultChecks(day({ snaps: gap, faults })).problems.join(), /2 passes in a row without a stop covering it/);
  assert.match(GP.faultChecks(day({ snaps: ok, faults, gate: [...day().gate, { tool: 'close_position', decision: 'refused', violations: [{ check: 'x' }] }] })).problems.join(), /an exit refused: close_position/);
  const cancel = { tool: 'cancel_order', decision: 'refused', violations: [{ check: 'cancel-protection' }], ts: '2022-03-30T13:46:00.000Z' };
  const late = [{ at: '2022-03-30T13:45:02.000Z', kind: 'late-fill' }];
  // The runner trying to cancel the position's working stop is a problem on every day, a late-fill day too.
  assert.match(GP.faultChecks(day({ snaps: ok, faults: late, gate: [...day().gate, cancel] })).problems.join(), /an exit refused: cancel_order \[cancel-protection\]/, 'on a late-fill day');
  assert.match(GP.faultChecks(day({ snaps: ok, faults, gate: [...day().gate, cancel] })).problems.join(), /an exit refused: cancel_order/, 'on any other day');
  // A late fill keeps its bracket stop: one pass uncovered is a problem there (elsewhere one managed cycle is allowed).
  const once = [pos('2022-03-30T13:45:02.000Z', []), pos('2022-03-30T13:48:02.000Z', [{ side: 1, size: 5, price: 80 }]), ok[1]];
  assert.deepStrictEqual(GP.faultChecks(day({ snaps: once, faults })).problems, []);
  assert.match(GP.faultChecks(day({ snaps: once, faults: [{ at: '2022-03-30T13:45:02.000Z', kind: 'late-fill-long' }] })).problems.join(), /1 passes in a row without a stop covering it \(at most none/);
  assert.deepStrictEqual(GP.faultChecks(day({ snaps: ok, faults: late })).problems, []);
  assert.match(GP.faultChecks(day({ snaps: [{ ...ok[0], position: { side: 'long', size: 10, price: 100 }, stops: [{ side: 1, size: 10, price: 80 }] }], faults })).problems.join(), /a duplicate position: 10 held, the largest entry 5/);
  assert.match(GP.faultChecks(day({ snaps: ok, faults: [] })).problems.join(), /no fault was armed/);
  assert.match(GP.faultChecks(day({ snaps: [ok[0]], faults })).problems.join(), /no recovery after it/, 'the fault\'s own pass is no recovery');
  const modify = [{ at: '2022-03-30T13:45:02.000Z', kind: 'modify-refused' }];
  assert.match(GP.faultChecks(day({ snaps: ok, faults: modify, faultState: { modifyFaults: 2 } })).problems.join(), /never fired/);
  assert.match(GP.faultChecks(day({ snaps: ok, faults: modify, faultState: { modifyFaults: 0 }, events: [] })).problems.join(), /never moved after the refused move/);
  assert.deepStrictEqual(GP.faultChecks(day({ snaps: ok, faults: modify, faultState: { modifyFaults: 0 } })).problems, []);
  assert.match(GP.faultChecks(day({ snaps: ok, faults: modify, faultState: { modifyFaults: 0 }, events: [{ ...day().events[0], why: 'plan stop' }] })).problems.join(), /never moved/, 'a re-anchor is no trail retry');
});

test('moveLayers and moveDiff: each layer of the day\'s first trade, a change named by its layer', () => {
  const exit = { afterTarget: { lockGivebackR: 1.5 } };
  const L = GP.moveLayers(day(), { tick: 0.25, exit });
  assert.deepStrictEqual(L.entry, { bar: B, type: null, price: 100, size: 5 });
  assert.deepStrictEqual(L.stop, { price: 80, riskPts: 20 });
  assert.deepStrictEqual([L.exit.target, L.exit.heldToTarget, L.exit.lockFirst, L.exit.reason, L.exit.R], ['cancelled at the first managed cycle', true, true, 'trail', 1]);
  assert.deepStrictEqual(L.capture, { caught: true, leg: 'long 2022-03-30T13:42:00.000Z to 2022-03-30T14:20:00.000Z', availR: 3, share: 0.3333 });
  assert.deepStrictEqual(GP.moveDiff(L, L, { tick: 0.25 }), []);
  assert.deepStrictEqual(GP.moveDiff(L, { ...L, setup: { ...L.setup, read: '15m choch up' } }, { tick: 0.25 }).map(x => x.split(':')[0]), ['SETUP']);
  assert.deepStrictEqual(GP.moveDiff(L, { ...L, entry: { ...L.entry, price: 100.25 } }, { tick: 0.25 }), [], 'within a tick');
  assert.match(GP.moveDiff(L, null, { tick: 0.25 }).join('\n'), /^BIAS: expected .*, got no trade/);
  assert.match(GP.moveDiff(L, { ...L, capture: { ...L.capture, share: 0.2 } }, { tick: 0.25 }).join(), /CAPTURE: expected at least 0.3333/);
  assert.strictEqual(GP.moveLayers(day({ fills: [] }), { tick: 0.25, exit }), null);
});

test('floorChecks: the floor refusal, its stop not widened, the binding term of the day, no trade; each break a problem', () => {
  const rule = { bufferTicks: 1, floorTicks: 8, floorAtr: 0.25 };
  const rec = (o = {}) => ({ id: 'f1', at: '2024-06-03T14:18:02.000Z', ok: false, side: 'long', plan: { stop: { level: 100, price: 99.75, ticks: 6, bufferTicks: 1, floorTicks: 8, ...o } }, problems: ['the stop is 6 ticks, under the minimum 8 (max of 8 ticks and 0.25 x ATR(20)): refused, never widened'] });
  const d = (records, extra = {}) => ({ day: '2024-06-03', tick: 0.25, records, decisions: [], cycles: [], gate: [], sent: [], calls: [], orders: [], fills: [], events: [], ...extra });
  assert.deepStrictEqual(GP.floorChecks(d([rec()]), { rule, bind: 'ticks' }).problems, []);
  assert.strictEqual(GP.floorChecks(d([rec()]), { rule, bind: 'ticks' }).refused.id, 'f1');
  assert.match(GP.floorChecks(d([]), { rule, bind: 'ticks' }).problems[0], /no compose record refused by the stop floor/);
  assert.match(GP.floorChecks(d([{ ...rec(), problems: ['R:R 1.5 is under the strategy\'s min 2'] }]), { rule, bind: 'ticks' }).problems[0], /no compose record refused/);
  assert.match(GP.floorChecks(d([rec({ price: 99 })]), { rule, bind: 'ticks' }).problems.join(), /widened/);
  assert.match(GP.floorChecks(d([rec({ floorTicks: 11 })]), { rule, bind: 'ticks' }).problems.join(), /the tick term must bind/);
  // The ATR term: the floor above the ticks', the stop at least the ticks'.
  assert.deepStrictEqual(GP.floorChecks(d([rec({ ticks: 10, floorTicks: 11 })]), { rule, bind: 'atr' }).problems, []);
  assert.match(GP.floorChecks(d([rec()]), { rule, bind: 'atr' }).problems.join(), /the ATR term must bind/);
  assert.match(GP.floorChecks(d([rec({ ticks: 7, floorTicks: 11 })]), { rule, bind: 'atr' }).problems.join(), /the ATR term must bind/);
  // A short's stop over the level.
  assert.deepStrictEqual(GP.floorChecks(d([{ ...rec({ level: 100, price: 100.25 }), side: 'short' }]), { rule, bind: 'ticks' }).problems, []);
  // A trade that day.
  const traded = day();
  assert.match(GP.floorChecks({ ...traded, records: [...traded.records, rec()] }, { rule, bind: 'ticks' }).problems.join(), /trade\(s\)/);
});

test('shardOf, shardDays and shardCoverage: k/n parsed or refused; every n-th day from the k-th; every shard once, every day once, one fixture', () => {
  assert.strictEqual(GP.shardOf(undefined), null);
  assert.strictEqual(GP.shardOf(''), null);
  assert.deepStrictEqual(GP.shardOf('2/3'), { k: 2, n: 3 });
  for (const bad of ['0/3', '4/3', '1', 'a/b', '1/0', ' 1/2']) assert.throws(() => GP.shardOf(bad), /k\/n/, bad);
  const days = ['d1', 'd2', 'd3', 'd4', 'd5'];
  assert.deepStrictEqual(GP.shardDays(days, null), days);
  const parts = [1, 2, 3].map(k => ({ shard: { k, n: 3 }, days: GP.shardDays(days, { k, n: 3 }), fixture: 'h' }));
  assert.deepStrictEqual(parts.map(p => p.days), [['d1', 'd4'], ['d2', 'd5'], ['d3']]);
  assert.deepStrictEqual(GP.shardCoverage(parts, { days, fixture: 'h' }), []);
  assert.deepStrictEqual(GP.shardCoverage([], { days, fixture: 'h' }), ['no shard results']);
  assert.match(GP.shardCoverage(parts.slice(0, 2), { days, fixture: 'h' }).join('; '), /shards 1,2 of 3.*days no shard ran: d3/);
  assert.match(GP.shardCoverage([...parts, parts[0]], { days, fixture: 'h' }).join('; '), /shards 1,1,2,3 of 3.*days run twice: d1, d4/);
  assert.match(GP.shardCoverage([{ ...parts[0], shard: { k: 1, n: 2 } }, ...parts.slice(1)], { days, fixture: 'h' }).join('; '), /disagree on their count/);
  assert.match(GP.shardCoverage([{ ...parts[0], fixture: 'x' }, ...parts.slice(1)], { days, fixture: 'h' }).join('; '), /another fixture/);
  assert.match(GP.shardCoverage([{ ...parts[0], days: ['d1', 'd4', 'd9'] }, ...parts.slice(1)], { days, fixture: 'h' }).join('; '), /not tier 2's: d9/);
});
