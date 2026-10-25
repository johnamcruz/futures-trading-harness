'use strict';

// Trend catch & ride (scripts/lib/replay/trend-ride.js): each caught leg's entry lag, capture and ride share, peak and
// giveback R, hand-worked on long and short legs; the run's entries in a leg its way, against one or in none; the totals.

const test = require('node:test');
const assert = require('node:assert');
const TR = require('../../scripts/lib/replay/trend-ride');

const MIN3 = 3 * 60000;
const T = Date.parse('2026-04-23T13:30:00Z');
const at = i => new Date(T + i * MIN3).toISOString();
const LONG = { side: 'long', from: 100, to: 140, points: 40 };
const SHORT = { side: 'short', from: 200, to: 170, points: 30 };

test('trend ride: MEASURES are the per-leg measures, frozen, each said', () => {
  assert.deepStrictEqual(TR.MEASURES.map(m => m.key), ['entryLag', 'captureShare', 'rideShare', 'peakR', 'givebackR']);
  assert.ok(Object.isFrozen(TR.MEASURES) && TR.MEASURES.every(m => Object.isFrozen(m) && m.says.length > 10));
});

test('trend ride: a long leg: entry lag, capture share, ride share; the peak the round trip\'s, its giveback', () => {
  // 100 -> 140 (40 points); in at 110, out at 130, risk 10 points: +2R; the round trip's best 3.1R.
  const x = TR.rideOf(LONG, { entry: 110, exit: 130, r: 2, peakR: 3.1, riskPts: 10 });
  assert.deepStrictEqual(x, { entryLag: 0.25, captureShare: 0.5, rideShare: 0.67, peakR: 3.1, peakFrom: 'round-trip', givebackR: 1.1, r: 2, open: false });
});

test('trend ride: a short leg counts down; one that rode past the detector\'s extreme banks more than was left (uncapped)', () => {
  // 200 -> 170 (30 points); in at 194 (6 points in), out at 176: 18 of 30, 18 of the 24 left.
  assert.deepStrictEqual(TR.rideOf(SHORT, { entry: 194, exit: 176, r: 1.8, peakR: 2, riskPts: 10 }), { entryLag: 0.2, captureShare: 0.6, rideShare: 0.75, peakR: 2, peakFrom: 'round-trip', givebackR: 0.2, r: 1.8, open: false });
  // Out at 168, past the leg's 170: 26 of 30 (0.87), 26 of 24 (1.08).
  const past = TR.rideOf(SHORT, { entry: 194, exit: 168, r: 2.6, peakR: 2.6, riskPts: 10 });
  assert.deepStrictEqual([past.captureShare, past.rideShare, past.givebackR], [0.87, 1.08, 0]);
});

test('trend ride: a loss inside a leg: negative shares; the peak from the closed bars held, never below the exit', () => {
  // Long 100 -> 140, in at 120 (at bar 2's open), stopped at 112 at bar 6's open: -0.8R at 10 points of risk.
  const bars = [
    { t: at(1), h: 125, l: 99 }, // opened before the fill: not held
    { t: at(2), h: 123, l: 118 }, { t: at(3), h: 122.5, l: 117 }, { t: at(4), h: 121, l: 114 }, { t: at(5), h: 119, l: 112 },
    { t: at(6), h: 130, l: 111 }, // closed after the exit: not held
  ];
  const x = TR.rideOf(LONG, { entry: 120, exit: 112, r: -0.8, riskPts: 10, bars, from: Date.parse(at(2)), to: Date.parse(at(6)), stepMs: MIN3 });
  assert.deepStrictEqual(x, { entryLag: 0.5, captureShare: -0.2, rideShare: -0.4, peakR: 0.3, peakFrom: 'bars', givebackR: 1.1, r: -0.8, open: false });
  // The same short: its best is the lowest low held.
  const s = TR.rideOf(SHORT, { entry: 194, exit: 197, r: -0.3, riskPts: 10, bars: [{ t: at(2), h: 196, l: 190.5 }], from: Date.parse(at(2)), to: Date.parse(at(4)), stepMs: MIN3 });
  assert.deepStrictEqual([s.captureShare, s.rideShare, s.peakR, s.givebackR], [-0.1, -0.12, 0.35, 0.65], "-3 of 24 is -0.125: a half rounds up (Math.round), to -0.12");
  // A peak below the exit's own R (bars that never reached the exit price): the exit's R.
  const low = TR.rideOf(LONG, { entry: 110, exit: 125, r: 1.5, riskPts: 10, bars: [{ t: at(2), h: 112, l: 109 }], from: Date.parse(at(2)), to: Date.parse(at(9)), stepMs: MIN3 });
  assert.deepStrictEqual([low.peakR, low.givebackR, low.peakFrom], [1.5, 0, 'bars']);
  // No round-trip peak and no bar held: unknown, never a guess.
  const none = TR.rideOf(LONG, { entry: 110, exit: 105, r: -0.5, riskPts: 10, bars: [], from: 0, to: 1 });
  assert.deepStrictEqual([none.peakR, none.peakFrom, none.givebackR, none.captureShare], [null, null, null, -0.12]);
});

test('trend ride: an entry at or past the extreme has nothing left (ride share null); a trade still open has no exit measure', () => {
  assert.strictEqual(TR.rideOf(LONG, { entry: 140, exit: 141, r: 0.1, peakR: 0.1, riskPts: 10 }).rideShare, null);
  assert.strictEqual(TR.rideOf(LONG, { entry: 142, exit: 141, r: -0.1, peakR: 0, riskPts: 10 }).entryLag, 1.05);
  assert.deepStrictEqual(TR.rideOf(LONG, { entry: 110, exit: null }), { entryLag: 0.25, captureShare: null, rideShare: null, peakR: null, peakFrom: null, givebackR: null, r: null, open: true });
  // A given leg with no prices: every share unknown.
  const given = TR.rideOf({ side: 'long', from: null, to: null, points: 20 }, { entry: 110, exit: 120, r: 1, peakR: 1, riskPts: 10 });
  assert.deepStrictEqual([given.entryLag, given.captureShare, given.rideShare], [null, 0.5, null]);
});

test('trend ride: size buckets by the edges (sorted), in multiples of the threshold; no scale is unknown', () => {
  assert.deepStrictEqual([1, 1.99, 2, 3.99, 4, 9].map(x => TR.sizeBucket(x, [2, 4])), ['1-2x', '1-2x', '2-4x', '2-4x', '4x+', '4x+']);
  assert.deepStrictEqual([TR.sizeBucket(5, [4, 2]), TR.sizeBucket(2.5, [3]), TR.sizeBucket(3, [3]), TR.sizeBucket(null, [2])], ['4x+', '1-3x', '3x+', 'unknown']);
  // The shipped edges (config/replay.json trendCapture.sizeEdges).
  assert.deepStrictEqual(require('../../scripts/lib/tunables').replay().trendCapture.sizeEdges, [2, 4]);
  assert.strictEqual(TR.sizeBucket(3), '2-4x');
});

test('trend ride: an entry is in-trend inside a leg its way (start to the extreme bar\'s close), counter inside one the other way, else none', () => {
  const legs = [{ id: 'up', side: 'long', start: at(0), end: at(5) }, { id: 'down', side: 'short', start: at(5), end: at(9) }];
  const k = (side, i) => TR.entryKind({ side, at: at(i) }, legs, MIN3);
  assert.deepStrictEqual(k('long', 2), { kind: 'in-trend', leg: 'up' });
  assert.deepStrictEqual(k('short', 2), { kind: 'counter', leg: 'up' });
  assert.deepStrictEqual(k('long', 6), { kind: 'in-trend', leg: 'up' }, 'the extreme bar\'s close is still the leg');
  assert.deepStrictEqual(k('short', 6), { kind: 'in-trend', leg: 'down' }, 'on both legs: its own way wins');
  assert.deepStrictEqual(k('long', 7), { kind: 'counter', leg: 'down' });
  assert.deepStrictEqual(k('long', 11), { kind: 'none', leg: null });
  assert.deepStrictEqual(TR.entryKind({ side: 'long', at: 'never' }, legs, MIN3), { kind: 'none', leg: null });
});

const ride = (o = {}) => ({ entryLag: 0.25, captureShare: 0.5, rideShare: 0.67, peakR: 3, peakFrom: 'round-trip', givebackR: 1, r: 2, open: false, ...o });
const LEGS = [
  { id: 'a', captured: true, availableR: 4, size: { bucket: '2-4x' }, ride: ride() },
  { id: 'b', captured: true, availableR: 3, size: { bucket: '1-2x' }, ride: ride({ entryLag: 0.5, captureShare: -0.2, rideShare: -0.4, peakR: 0.3, givebackR: 1.1, r: -0.8 }) },
  { id: 'c', captured: true, availableR: null, size: { bucket: '4x+' }, ride: ride({ entryLag: 0.1, captureShare: null, rideShare: null, peakR: null, givebackR: null, r: null, open: true }) },
  { id: 'd', captured: false, availableR: 5, size: { bucket: '4x+' }, ride: null },
  { id: 'e', captured: false, availableR: 2.5, size: { bucket: 'unknown' }, ride: null },
];
const ENTRIES = [{ kind: 'in-trend', r: 2 }, { kind: 'in-trend', r: -0.8 }, { kind: 'in-trend', r: null }, { kind: 'counter', r: -1 }, { kind: 'none', r: -0.5 }];

test('trend ride: the totals: legs, caught, by size; medians and means over the caught legs; R caught vs available; entries by kind', () => {
  const t = TR.summarize({ legs: LEGS, entries: ENTRIES, edges: [2, 4] });
  assert.deepStrictEqual([t.legs, t.caught, t.catchRate, t.open], [5, 3, 0.6, 1]);
  assert.deepStrictEqual(t.bySize, { '1-2x': { legs: 1, caught: 1, catchRate: 1 }, '2-4x': { legs: 1, caught: 1, catchRate: 1 }, '4x+': { legs: 2, caught: 1, catchRate: 0.5 }, unknown: { legs: 1, caught: 0, catchRate: 0 } });
  // Two closed caught legs: an even count's median is the middle two's mean.
  assert.deepStrictEqual(t.captureShare, { n: 2, median: 0.15, mean: 0.15 });
  assert.deepStrictEqual(t.rideShare, { n: 2, median: 0.14, mean: 0.14 });
  assert.deepStrictEqual(t.givebackR, { n: 2, median: 1.05, mean: 1.05 });
  assert.deepStrictEqual(t.entryLag, { n: 3, median: 0.25, mean: 0.28 }, 'the open trade\'s entry counts');
  assert.deepStrictEqual([t.rCaught, t.rCaughtUnknown, t.rAvailable, t.rAvailableUnknown], [1.2, 1, 14.5, 1]);
  assert.deepStrictEqual(t.entries, { filled: 5, inTrend: { n: 3, r: 1.2, rUnknown: 1 }, counter: { n: 1, r: -1, rUnknown: 0 }, none: { n: 1, r: -0.5, rUnknown: 0 }, inTrendShare: 0.6 });
  // Nothing: no rate, no median, never a zero that reads as measured.
  const empty = TR.summarize({ legs: [], entries: [], edges: [2, 4] });
  assert.deepStrictEqual([empty.catchRate, empty.captureShare.median, empty.entries.inTrendShare, Object.keys(empty.bySize)], [null, null, null, ['1-2x', '2-4x', '4x+']]);
});

test('trend ride: the report\'s block and the one line', () => {
  const t = TR.summarize({ legs: LEGS, entries: ENTRIES, edges: [2, 4] });
  assert.strictEqual(TR.rideLine(t), '5 leg(s), 3 caught (60%), R caught 1.2 / R available 14.5 (1 unknown), median capture share 0.15, ride share 0.14, entry lag 0.25, giveback 1.05R, 1 still open, in-trend entries 3 of 5 (60%)');
  assert.deepStrictEqual(TR.rideLines(t), [
    `Trend catch & ride: ${TR.rideLine(t)}`,
    '  means: capture share 0.15, ride share 0.14, entry lag 0.28, peak 1.65R, giveback 1.05R (n 2)',
    '  by size (x the leg threshold): 1-2x 1/1, 2-4x 1/1, 4x+ 1/2, unknown 0/1',
    '  entries: in-trend 3 (+1.2R, 1 open), counter 1 (-1R), no leg 1 (-0.5R)',
  ]);
  const empty = TR.summarize({ legs: [], entries: [], edges: [2, 4] });
  assert.strictEqual(TR.rideLine(empty), '0 leg(s), 0 caught (-), R caught 0 / R available 0, median capture share -, ride share -, entry lag -, giveback -, in-trend entries 0 of 0 (-)');
  assert.deepStrictEqual([TR.rideLine(null), TR.rideLines(null)], ['n/a', []]);
});

test('trend ride: compact keeps only what the totals read; the totals of the compact equal the document\'s', () => {
  const doc = { legs: LEGS.map(l => ({ ...l, cycles: [{ code: 'x' }], move: { points: 9 } })), entries: ENTRIES.map((e, i) => ({ ...e, at: at(i), side: 'long', record: 'r', leg: null })) };
  const c = TR.compact(doc);
  assert.deepStrictEqual(Object.keys(c.legs[0]).sort(), ['availableR', 'captured', 'id', 'ride', 'size']);
  assert.deepStrictEqual(Object.keys(c.entries[0]).sort(), ['at', 'kind', 'leg', 'r', 'side']);
  assert.deepStrictEqual(TR.summarize({ ...c, edges: [2, 4] }), TR.summarize({ ...doc, edges: [2, 4] }));
  assert.deepStrictEqual([TR.compact(null), TR.compact({}), TR.compact({ legs: doc.legs })], [null, null, null], 'a document from before the ride (no entries) is unknown');
});
