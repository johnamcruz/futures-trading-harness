'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../../scripts/lib/trading/compression');

// Hand-worked parameters (the config's may change; these pin the definition's arithmetic).
const P = { ...C.PARAMS, minBars: 5, maxBars: 30, boxAtr: 2.5, barAtr: 0.7, convergeShare: 0.6, driftShare: 0.5, expandRange: 2, expandAtr: 1, recentBars: 3, maxRunAtr: 1, levelBandAtr: 0.25, maxLevels: 3 };
const T0 = Date.parse('2022-03-01T15:00:00Z');
const STEP = 3 * 60000;

/** Candles back to back from T0 (3m), each [o, h, l, c]. */
function candles(rows, { gapAt = -1 } = {}) {
  let t = T0;
  return rows.map(([o, h, l, c], i) => {
    if (i === gapAt) t += 60 * 60000;
    const x = { t: new Date(t).toISOString(), closedAt: new Date(t + STEP).toISOString(), o, h, l, c };
    t += STEP;
    return x;
  });
}
// 15 candles of range 10 around 130 (ATR(14) = 10 exactly: every true range is 10), well above the box below: none of
// them fits in it (the box is the longest run ending on a candle, so a run of candles in its range would extend it).
const PRE = Array.from({ length: 15 }, () => [130, 135, 125, 130]);
// A box of 6 candles, each range 3, inside 100-103: width 3 = 0.3 ATR, mean range 0.3 ATR.
const BOX = [[101, 103, 100, 102], [102, 103, 100, 101], [101, 103, 100, 102], [102, 103, 100, 101], [101, 103, 100, 102], [102, 103, 100, 101.5]];

test('compression: a box of 5+ tight candles against the ATR before it is compressing, with its facts', () => {
  const cs = candles([...PRE, ...BOX]);
  const x = C.compressionAt(cs, cs.length - 1, { params: P });
  assert.strictEqual(x.state, 'compressing');
  assert.deepStrictEqual([x.box.high, x.box.low, x.box.width, x.box.widthAtr, x.box.bars, x.box.meanRangeAtr, x.box.atr, x.box.volContract], [103, 100, 3, 0.3, 6, 0.3, 10, null]);
  assert.strictEqual(x.box.from, cs[15].t);
  assert.strictEqual(x.box.to, cs[20].closedAt);
  assert.strictEqual(x.break, null);
});

test('compression: an expansion candle closing out of the box is the transition (expanding, up), timed by its close', () => {
  const cs = candles([...PRE, ...BOX, [102, 112.5, 101.75, 112]]);
  const x = C.compressionAt(cs, cs.length - 1, { params: P });
  assert.strictEqual(x.state, 'expanding');
  assert.deepStrictEqual([x.break.dir, x.break.closedAt, x.break.close, x.break.expansion, x.break.barsAgo, x.break.backInside, x.break.late], ['up', cs[21].closedAt, 112, true, 0, false, false]);
  // Range 10.75: 3.58x the box's mean range 3, 1.08 ATR.
  assert.deepStrictEqual([x.break.rangeVsBox, x.break.rangeAtr], [3.58, 1.08]);
  assert.strictEqual(x.box.high, 103);
  // Down: the mirror.
  const dn = candles([...PRE, ...BOX, [101, 101.25, 90, 90.5]]);
  const y = C.compressionAt(dn, dn.length - 1, { params: P });
  assert.deepStrictEqual([y.state, y.break.dir], ['expanding', 'down']);
  // Still expanding on the next candle (1 ago) while it holds outside; no longer after recentBars candles.
  const on = candles([...PRE, ...BOX, [102, 112.5, 101.75, 112], [112, 114, 111, 113]]);
  assert.deepStrictEqual([C.compressionAt(on, on.length - 1, { params: P }).state, C.compressionAt(on, on.length - 1, { params: P }).break.barsAgo], ['expanding', 1]);
  const old = candles([...PRE, ...BOX, [102, 112.5, 101.75, 112], [112, 114, 111, 113], [113, 115, 112, 114], [114, 116, 113, 115], [115, 117, 114, 116]]);
  assert.notStrictEqual(C.compressionAt(old, old.length - 1, { params: { ...P, maxRunAtr: 99 } }).state, 'expanding');
});

test('compression: a small candle out (no expansion), a wick out (no break), a fakeout and a late break are no expansion', () => {
  // Closes out on a range of 4: 1.33x the box's candles, under 2x: a drift out.
  const small = candles([...PRE, ...BOX, [102.5, 104.5, 100.5, 104.25]]);
  const s = C.compressionAt(small, small.length - 1, { params: P });
  assert.notStrictEqual(s.state, 'expanding');
  assert.deepStrictEqual([s.break.dir, s.break.expansion], ['up', false]);
  // A wick to 110, close back inside at 102: no break at all.
  const wick = candles([...PRE, ...BOX, [102, 110, 101, 102]]);
  assert.strictEqual(C.compressionAt(wick, wick.length - 1, { params: P }).break, null);
  // The expansion, then a close back inside the box: a fakeout.
  const fake = candles([...PRE, ...BOX, [102, 112.5, 101.75, 112], [112, 112.5, 101, 102]]);
  const f = C.compressionAt(fake, fake.length - 1, { params: P });
  assert.notStrictEqual(f.state, 'expanding');
  assert.deepStrictEqual([f.break.dir, f.break.backInside], ['up', true]);
  // Late: price 11.5 past the expansion candle's close 112, 1.15 ATR (maxRunAtr 1): the leg already left.
  const late = C.compressionAt(candles([...PRE, ...BOX, [102, 112.5, 101.75, 112]]), 21, { params: P, price: 123.5 });
  assert.deepStrictEqual([late.break.runAtr, late.break.late, late.state === 'expanding'], [1.15, true, false]);
  const inTime = C.compressionAt(candles([...PRE, ...BOX, [102, 112.5, 101.75, 112]]), 21, { params: P, price: 118 });
  assert.deepStrictEqual([inTime.break.runAtr, inTime.state], [0.6, 'expanding']);
});

test('compression: a poke of a tick or two beyond the box is no expansion; acceptance is price still beyond it; volume facts', () => {
  // A wide candle (range 10.5) closing 0.5 above the box (0.05 ATR, under minBeyondAtr 0.1): a poke.
  const poke = candles([...PRE, ...BOX, [101, 111, 100.5, 103.5]]);
  const p = C.compressionAt(poke, poke.length - 1, { params: P });
  assert.deepStrictEqual([p.state === 'expanding', p.break.beyondAtr, p.break.expansion], [false, 0.05, false]);
  assert.strictEqual(C.compressionAt(poke, poke.length - 1, { params: { ...P, minBeyondAtr: 0 } }).state, 'expanding');
  // Price (the latest base close) still above the box high; back inside it, on the expansion candle's own bar, the
  // transition is undone, and the line says why.
  const brk = candles([...PRE, ...BOX, [102, 112.5, 101.75, 112]]);
  assert.strictEqual(C.compressionAt(brk, 21, { params: P, price: 104 }).break.beyondNow, true);
  const back = C.compressionAt(brk, 21, { params: P, price: 102.5 });
  assert.deepStrictEqual([back.break.beyondNow, back.break.barsAgo, back.state], [false, 0, 'neither']);
  assert.match(C.compressionLine({ '3m': back }), /0 bars ago, price back inside\.$/);
  // Volume: the break candle's against the box's mean; the box's second half against its first (falling: under 1).
  const withVol = (rows, vols) => candles(rows).map((x, i) => ({ ...x, v: vols[i] }));
  const v = withVol([...PRE, ...BOX, [102, 112.5, 101.75, 112]], [...PRE.map(() => 100), 60, 60, 60, 30, 30, 30, 180]);
  const x = C.compressionAt(v, v.length - 1, { params: P });
  assert.deepStrictEqual([x.box.volContract, x.break.volVsBox], [0.5, 4]);
  assert.strictEqual(C.compressionAt(brk, 21, { params: P }).box.volContract, null, 'no volume: unknown');
});

test('compression: no box holds a displacement candle (the pole is the move before it); a zero-range run is none', () => {
  // A displacement candle (body 0.85 of a 20-point range, over 1.5 ATR) as the box's third candle: the box can't run through
  // it, so the 3 candles after it are too few.
  const pole = candles([...PRE, [101, 103, 100, 102], [102, 103, 100, 101], [101, 121, 101, 118], [113, 114.5, 112, 113.5], [113.5, 114.5, 112, 113], [113, 114.5, 112.5, 114]]);
  assert.strictEqual(C.compressionAt(pole, pole.length - 1, { params: P }).state, 'neither');
  // Without it (a small candle in its place), the same run is a box.
  const quiet = candles([...PRE, [101, 103, 100, 102], [102, 103, 100, 101], [101, 103, 100, 102], [102, 103, 100.5, 101], [101, 102.5, 100.5, 102], [102, 103, 101, 102.5]]);
  assert.strictEqual(C.compressionAt(quiet, quiet.length - 1, { params: P }).state, 'compressing');
  const flat = candles([...PRE, ...Array.from({ length: 6 }, () => [100, 100, 100, 100])]);
  assert.strictEqual(C.compressionAt(flat, flat.length - 1, { params: P }).state, 'neither');
});

test('compression: at the config\'s own values, a box and what is not one', () => {
  const Q = C.PARAMS;
  assert.strictEqual(C.compressionAt(candles([...PRE, ...BOX]), 20, { params: Q }).state, 'compressing');
  // Candles stepping 8 points with a range of 3: 43 wide after 6 (about 3.8 ATR, over the config's boxAtr).
  const step = candles([...PRE, ...Array.from({ length: 6 }, (_, i) => [100 + 8 * i, 103 + 8 * i, 100 + 8 * i, 103 + 8 * i])]);
  assert.ok(43 / 11.4 > Q.boxAtr, 'the run is wider than the config allows');
  assert.strictEqual(C.compressionAt(step, step.length - 1, { params: Q }).state, 'neither');
  // Each candle a range of 14 (over the config's barAtr x the ATR before it).
  const wide = candles([...PRE, ...Array.from({ length: 6 }, (_, i) => [100 + i, 107 + i, 93 + i, 101 + i])]);
  assert.strictEqual(C.compressionAt(wide, wide.length - 1, { params: Q }).state, 'neither');
  const one = candles([...PRE, [101, 103, 97, 102], [101, 102, 98, 101]]);
  assert.strictEqual(C.compressionAt(one, one.length - 1, { params: Q }).state, 'neither');
  const brk = candles([...PRE, ...BOX, [102, 112.5, 101.75, 112]]);
  assert.strictEqual(C.compressionAt(brk, brk.length - 1, { params: Q }).state, 'expanding');
});

test('compression: what is not a box: a single inside bar, wide drifting candles, a run wider than boxAtr, a feed gap', () => {
  const one = candles([...PRE, [101, 103, 97, 102], [101, 102, 98, 101]]);
  assert.strictEqual(C.compressionAt(one, one.length - 1, { params: P }).state, 'neither');
  // Each candle range 12 (about 1 ATR, over barAtr 0.7).
  const wide = candles([...PRE, ...Array.from({ length: 6 }, (_, i) => [100 + i, 106 + i, 94 + i, 101 + i])]);
  assert.strictEqual(C.compressionAt(wide, wide.length - 1, { params: P }).state, 'neither');
  // Small candles stepping 8 points a candle: 35 wide after 5 (about 3 ATR, over boxAtr 2.5).
  const step = candles([...PRE, ...Array.from({ length: 6 }, (_, i) => [100 + 8 * i, 103 + 8 * i, 100 + 8 * i, 103 + 8 * i])]);
  assert.strictEqual(C.compressionAt(step, step.length - 1, { params: P }).state, 'neither');
  // The same box split by an hour's gap after its third candle: no 5 back-to-back candles.
  const gap = candles([...PRE, ...BOX], { gapAt: 18 });
  assert.strictEqual(C.compressionAt(gap, gap.length - 1, { params: P }).state, 'neither');
});

test('compression: the box is measured against the ATR before it, and boxAtr and barAtr bound it (mutations fail)', () => {
  const cs = candles([...PRE, ...BOX]);
  // Width 3 and mean range 3 against an ATR of 10 to about 11.4 (the first box candle's gap down raises it): under 0.26
  // of it, no run of 5 is a box.
  assert.strictEqual(C.compressionAt(cs, cs.length - 1, { params: { ...P, boxAtr: 0.26 } }).state, 'neither');
  assert.strictEqual(C.compressionAt(cs, cs.length - 1, { params: { ...P, barAtr: 0.26 } }).state, 'neither');
  assert.strictEqual(C.compressionAt(cs, cs.length - 1, { params: { ...P, minBars: 7 } }).state, 'neither');
  const brk = candles([...PRE, ...BOX, [102, 112.5, 101.75, 112]]);
  assert.notStrictEqual(C.compressionAt(brk, brk.length - 1, { params: { ...P, expandRange: 3.6 } }).state, 'expanding');
  assert.notStrictEqual(C.compressionAt(brk, brk.length - 1, { params: { ...P, expandAtr: 1.1 } }).state, 'expanding');
});

test('compression: no look-ahead: the state at candle j is the same with or without the candles after it', () => {
  const cs = candles([...PRE, ...BOX, [102, 112.5, 101.75, 112], [112, 112.5, 101, 102], [102, 103, 100, 101]]);
  for (let j = 14; j < cs.length; j += 1) {
    assert.deepStrictEqual(C.compressionAt(cs, j, { params: P }), C.compressionAt(cs.slice(0, j + 1), j, { params: P }), `candle ${j}`);
  }
  // At the expansion candle it is expanding; the fakeout after it changes nothing at j = 21.
  assert.strictEqual(C.compressionAt(cs, 21, { params: P }).state, 'expanding');
});

test('compression: shape: converging (a pennant\'s box), drifting (a flag\'s), flat', () => {
  const conv = candles([...PRE, [100, 106, 98, 104], [104, 106, 98.5, 100], [100, 105, 99, 103], [103, 103.5, 100.5, 101], [101, 103, 101, 102.5], [102.5, 102.75, 101.25, 102]]);
  assert.strictEqual(C.compressionAt(conv, conv.length - 1, { params: { ...P, boxAtr: 1 } }).box.shape, 'converging');
  const down = candles([...PRE, [104, 105, 102, 103], [103, 104, 101, 102], [102, 103, 100, 101], [101, 102, 99, 100], [100, 101, 98, 99], [99, 100, 97, 98]]);
  assert.strictEqual(C.compressionAt(down, down.length - 1, { params: P }).box.shape, 'drifting down');
  assert.strictEqual(C.compressionAt(candles([...PRE, ...BOX]), 20, { params: P }).box.shape, 'flat');
});

test('compression: the key levels the box sits at, with the edge; the base bars\' own levels are the caller\'s to leave out', () => {
  const cs = candles([...PRE, ...BOX]);
  const levels = [['prior RTH high', 103.5], ['VWAP (rth)', 101.5], ['session POC', 99], ['overnight low', 90], ['IB low', 100.25, 100.25]];
  const x = C.compressionAt(cs, cs.length - 1, { params: P, levels });
  // Band 2.5 (0.25 x ATR 10): 103.5 at the top, 100.25 and 99 at the bottom, 101.5 inside; 90 none; at most 3, nearest first.
  assert.deepStrictEqual(x.box.levels, [{ name: 'IB low', price: 100.25, edge: 'bottom' }, { name: 'prior RTH high', price: 103.5, edge: 'top' }, { name: 'session POC', price: 99, edge: 'bottom' }]);
  assert.deepStrictEqual(C.compressionAt(cs, cs.length - 1, { params: { ...P, maxLevels: 5 }, levels }).box.levels.map(l => l.name), ['IB low', 'prior RTH high', 'session POC', 'VWAP (rth)']);
  assert.deepStrictEqual(C.compressionAt(cs, cs.length - 1, { params: { ...P, levelBandAtr: 0 }, levels }).box.levels.map(l => l.name), ['IB low', 'VWAP (rth)']);
  // The day's or session's running extreme on the box's own edge is the box's own; off its edge it is a level.
  const own = [['day high', 103], ['session low', 100], ['day low', 99.5]];
  assert.deepStrictEqual(C.compressionAt(cs, cs.length - 1, { params: P, levels: own }).box.levels.map(l => l.name), ['day low']);
});

test('compression: the briefing block (compressionFrames): a swing on the box\'s timeframe or lower is never its level; levels as of the box\'s start', () => {
  // 1h bars from 18:00 ET (23:00 UTC in March), the PRE candles then the box: one 1h box.
  const t0 = Date.parse('2022-03-01T23:00:00Z');
  const bars = [...PRE, ...BOX].map(([o, h, l, c], i) => ({ t: new Date(t0 + i * 3600000).toISOString(), o, h, l, c, v: 100 }));
  const levels = [['untested 1h swing high', 103.25], ['1h swing low 100', 100], ['15m swing high 103', 103], ['4h swing high 103.5', 103.5], ['prior RTH high', 101.5]];
  let asked = null;
  const out = C.compressionFrames({ bars, base: 60, frames: [60], params: P, levels: from => { asked = from; return levels; } });
  assert.strictEqual(out['1h'].state, 'compressing');
  assert.strictEqual(asked, bars[15].t, 'levels as they stood at the box\'s first candle');
  assert.deepStrictEqual(out['1h'].box.levels.map(l => l.name).sort(), ['4h swing high 103.5', 'prior RTH high']);
});

test('compression: the summary line only for a timeframe compressing or with a recent break', () => {
  const cs = candles([...PRE, ...BOX, [102, 112.5, 101.75, 112]]);
  const block = { '3m': C.compressionAt(cs, cs.length - 1, { params: P, levels: [['prior RTH high', 103.5]] }), '15m': { state: 'neither', box: null, break: null }, '5m': 'unavailable (x)' };
  const line = C.compressionLine(block);
  assert.match(line, /^- Compression \(completed candles; a read, not a signal\): 3m expanding up: box 100-103 \(3 pts, 0\.3 ATR, 6 bars, flat, at prior RTH high 103\.5 \(its top\)\), expansion closed .* above it \(range 3\.58x the box's candles, 1\.08 ATR\), 0 bars ago\.$/);
  assert.strictEqual(C.compressionLine({ '15m': { state: 'neither', box: null, break: null } }), null);
  // A small candle out is left out; a fakeout of an expansion is said; a box compressing is compact.
  const small = candles([...PRE, ...BOX, [102.5, 104.5, 100.5, 104.25]]);
  const smallState = C.compressionAt(small, small.length - 1, { params: P });
  assert.doesNotMatch(String(C.compressionLine({ '3m': smallState })), /expansion|small candle/);
  const fake = candles([...PRE, ...BOX, [102, 112.5, 101.75, 112], [112, 112.5, 101, 102]]);
  assert.match(C.compressionLine({ '3m': C.compressionAt(fake, fake.length - 1, { params: P }) }), /3m no expansion: box 100-103 .*, 1 bar ago, closed back inside\.$/);
  assert.match(C.compressionLine({ '15m': C.compressionAt(candles([...PRE, ...BOX]), 20, { params: P }) }), /: 15m compressing 6 bars in 100-103 \(0\.3 ATR, flat\)\.$/);
});
