'use strict';

// The Market state's behavior layer (scripts/lib/trading/market-behavior.js, round 20): overlap, efficiency, net in ATR,
// displacement count, rejection episodes at one boundary, interior pivots, the 3m and 15m words at their thresholds.

const test = require('node:test');
const assert = require('node:assert');
const MB = require('../../scripts/lib/trading/market-behavior');

const P = { overlapHigh: 0.7, effLow: 0.3, rejectMin: 2, lossStale: 10, trendNetAtr: 1, interior: 0.25, earlyBars: 3, early15: 2 };
const bar = (o, h, l, c) => ({ o, h, l, c });

test('behavior: overlap 0 for candles that do not overlap, 1 for inside candles; efficiency 1 for a straight line, 0 for a round trip', () => {
  const stairs = [bar(100, 101, 100, 101), bar(101.5, 102.5, 101.5, 102.5), bar(103, 104, 103, 104)];
  const b = MB.behavior(stairs, 10, 2);
  assert.deepStrictEqual([b.bars, b.overlap, b.eff, b.net, b.netAtr], [3, 0, +(4 / 3).toFixed(2), 4, 2]);
  const inside = [bar(100, 104, 96, 101), bar(101, 103, 97, 100), bar(100, 102, 98, 101)];
  assert.strictEqual(MB.behavior(inside, 10, 2).overlap, 1);
  const trip = [bar(100, 102, 100, 102), bar(102, 102, 100, 100)];
  assert.strictEqual(MB.behavior(trip, 10, 2).eff, 0);
  assert.strictEqual(MB.behavior([bar(1, 2, 0, 1)], 10, 2), null, 'one candle: no overlap');
  assert.strictEqual(MB.behavior([...stairs, ...inside], 3, 2).bars, 3, 'the last w only');
  // A strong candle in its own colour counts as displacement (body >= 0.6, close in the extreme third, range >= 1 ATR).
  assert.strictEqual(MB.behavior([bar(100, 100.5, 99.5, 100), bar(100, 104.25, 99.75, 104)], 10, 2).disp, 1);
});

test('rejections: an episode is a run of bars touching an edge within tol and closing back inside; equal highs within tol are one boundary', () => {
  const xs = [bar(100, 105, 99, 101), bar(101, 104.9, 100, 102), bar(102, 103, 100, 101), bar(101, 105, 100, 102), bar(102, 103, 99.1, 101)];
  const r = MB.rejections(xs, 20, 0.25, P);
  assert.deepStrictEqual([r.top, r.bot, r.atTop, r.atBot], [105, 99, 2, 2], 'bars 0-1 one episode at 105 (104.9 within tol), bar 3 the second');
  assert.strictEqual(MB.rejections(xs, 20, 0, P).atTop, 2, 'without tol 104.9 is no touch: still two episodes (bars 0 and 3)');
  const closeAt = [bar(100, 105, 99, 104.75), bar(104, 106, 103, 105.9)];
  assert.strictEqual(MB.rejections([...closeAt, bar(105, 105.5, 104, 105)], 20, 0.25, P).atTop, 0, 'a close at top - tol or above is not back inside');
  assert.strictEqual(MB.rejections(xs.slice(0, 2), 20, 0.25, P), null, 'fewer than 3 bars');
  // Interior pivots: a k=2 swing high in the middle of the window's range (chop fails mid-range); at an edge it is none.
  const mid = [bar(100, 101, 99, 100), bar(100, 102, 99, 101), bar(101, 105, 100, 104), bar(104, 104.5, 96, 97), bar(97, 98, 95, 96), bar(96, 103, 95, 102.5), bar(102, 102.5, 101, 102), bar(102, 102.2, 101.5, 101.8)];
  const r2 = MB.rejections([...mid, bar(101.8, 112, 101.8, 111), bar(111, 111.5, 88, 89)], 20, 0.25, P);
  assert.ok(r2.interior >= 1, `a mid-range swing: interior ${r2.interior}`);
  assert.strictEqual(MB.rejections(mid.slice(0, 5), 20, 0.25, P).interior, 0, 'the only swing high is the top edge');
});

test('word3: trending needs a fresh extreme (within lossStale) AND the net the leg\'s way >= trendNetAtr x ATR; then failing, overlapping, rotating, mixed', () => {
  const beh = (net, overlap = 0.5, eff = 0.5) => ({ bars: 10, overlap, eff, net });
  const w = o => MB.word3({ rthBars: 12, side: 'up', sinceProgress: 2, loss: false, atr: 4, beh: beh(4), ...o }, P);
  assert.strictEqual(w({}), 'trending');
  assert.strictEqual(w({ beh: beh(3.99) }), 'mixed', 'net under 1 ATR');
  assert.strictEqual(w({ side: 'down' }), 'mixed', 'the net against the leg');
  assert.strictEqual(w({ side: 'down', beh: beh(-4) }), 'trending', 'the mirror');
  assert.strictEqual(w({ sinceProgress: 10 }), 'mixed', 'no new extreme for lossStale bars');
  assert.strictEqual(w({ sinceProgress: 9 }), 'trending');
  assert.strictEqual(w({ side: null }), 'mixed', 'no intact leg: never trending');
  assert.strictEqual(w({ beh: beh(0), loss: true }), 'failing');
  assert.strictEqual(w({ beh: beh(0, 0.7) }), 'overlapping');
  assert.strictEqual(w({ beh: beh(0, 0.69, 0.29) }), 'rotating');
  assert.strictEqual(w({ beh: beh(0, 0.69, 0.3) }), 'mixed');
  assert.strictEqual(w({ rthBars: 2 }), 'early');
});

test('word15: trending <way> on the 15m candles\' own ATR; else overlapping, rotating, mixed; early under 2 candles', () => {
  assert.strictEqual(MB.word15({ bars: 4, overlap: 0.3, eff: 0.6, net: -12 }, 10, P), 'trending down');
  assert.strictEqual(MB.word15({ bars: 4, overlap: 0.8, eff: 0.2, net: 9 }, 10, P), 'overlapping');
  assert.strictEqual(MB.word15({ bars: 4, overlap: 0.5, eff: 0.2, net: 9 }, 10, P), 'rotating');
  assert.strictEqual(MB.word15({ bars: 1, overlap: null, eff: 1, net: 9 }, 10, P), 'early');
  assert.strictEqual(MB.word15(null, 10, P), 'early');
});
