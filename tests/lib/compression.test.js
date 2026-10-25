'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../../scripts/lib/trading/compression');

// Hand-worked parameters (the config's may change; these pin the definition's arithmetic). NR7 and inside are the box.
const P = { ...C.PARAMS, nr: [7], maxWidthAtr: 2, poleBars: 3, expandAtr: 1, minBeyondAtr: 0.1, recentBars: 3, maxRunAtr: 1, levelBandAtr: 0.25, maxLevels: 3 };
const T0 = Date.parse('2022-03-01T15:00:00Z');
const STEP = 3 * 60000;

/** Candles back to back from T0 (3m), each [o, h, l, c, v?]. */
function candles(rows, { gapAt = -1 } = {}) {
  let t = T0;
  return rows.map(([o, h, l, c, v = 100], i) => {
    if (i === gapAt) t += 60 * 60000;
    const x = { t: new Date(t).toISOString(), closedAt: new Date(t + STEP).toISOString(), o, h, l, c, v };
    t += STEP;
    return x;
  });
}
const at = (cs, j, opts = {}) => C.compressionAt(cs, j, { params: P, ...opts });
const last = (cs, opts) => at(cs, cs.length - 1, opts);
// 15 candles of range 10 around 100 (ATR(14) = 10 exactly: every true range is 10).
const PRE = Array.from({ length: 15 }, () => [100, 105, 95, 100]);
// An NR7 candle that is not inside the one before it (its high above 105): range 3, the box 103-106.
const NR = [104, 106, 103, 105];
// An expansion up out of it: range 12.5 (1.25 ATR), closing 10.5 above the box (1.05 ATR).
const UP = [105, 117, 104.5, 116.5];

test('compression: an NR7 candle is a box (its own range), measured against the ATR before it', () => {
  const x = last(candles([...PRE, NR]));
  assert.strictEqual(x.state, 'compressing');
  assert.deepStrictEqual([x.box.flavor, x.box.flavors, x.box.high, x.box.low, x.box.width, x.box.widthAtr, x.box.atr, x.box.pole], ['nr7', ['nr7'], 106, 103, 3, 0.3, 10, null]);
  // Not the narrowest of the last 7 (a narrower candle 3 back): no box.
  const wider = candles([...PRE.slice(0, 12), [100, 101, 99, 100], [100, 105, 95, 100], [100, 105, 95, 100], [104, 107, 103, 105]]);
  assert.strictEqual(last(wider).state, 'neither');
  // Ties count (the classic NR7): equal to the narrowest of the last 7.
  const tie = candles([...PRE.slice(0, 12), [100, 103, 100, 101], [100, 105, 95, 100], [100, 105, 95, 100], [104, 106, 103, 105]]);
  assert.strictEqual(last(tie).box.flavor, 'nr7');
  // Fewer than 7 back-to-back candles (a feed gap): no NR7.
  assert.strictEqual(last(candles([...PRE, NR], { gapAt: 12 })).state, 'neither');
  // NR4 is not in the config's family: a candle narrowest of 4 only is no box (with nr [7, 4] it is).
  const nr4 = candles([...PRE.slice(0, 11), [100, 102, 99, 101], [100, 105, 95, 100], [100, 105, 95, 100], [100, 105, 95, 100], [104, 107, 103, 105]]);
  assert.strictEqual(last(nr4).state, 'neither');
  assert.strictEqual(last(nr4, { params: { ...P, nr: [7, 4] } }).box.flavor, 'nr4');
});

test('compression: an inside candle (a stack inside one mother) is a box: the mother\'s range, its stack counted', () => {
  // [101, 103, 97, 102] inside the PRE candle 95-105 (and NR7 too): the box is the mother's range.
  const one = last(candles([...PRE, [101, 103, 97, 102]]));
  assert.deepStrictEqual([one.state, one.box.flavor, one.box.flavors, one.box.high, one.box.low, one.box.insideStack], ['compressing', 'inside', ['inside', 'nr7'], 105, 95, 1]);
  const two = last(candles([...PRE, [101, 103, 97, 102], [101, 102, 98, 100]]));
  assert.deepStrictEqual([two.box.flavor, two.box.insideStack, two.box.high, two.box.low], ['inside', 2, 105, 95]);
});

test('compression: the pole stays outside the box: a displacement candle just before it is a fact; inside a pole the box is the narrow candle\'s own', () => {
  // A wider candle (range 12: no box itself), a displacement candle (body 17 of an 18.5 range, 1.82 ATR), then an NR7
  // candle above its high: the pole, up.
  const pole = [100, 118.5, 100, 117];
  const LEAD = [...PRE, [100, 106, 94, 100]];
  const x = last(candles([...LEAD, pole, [117, 120, 118.75, 119]]));
  assert.strictEqual(x.state, 'compressing');
  assert.deepStrictEqual([x.box.flavor, x.box.pole && x.box.pole.dir, x.box.pole && x.box.pole.rangeAtr], ['nr7', 'up', 1.82]);
  // Inside the pole: the mother is the pole, so the box is the narrow candle's own range (NR7), never the pole's.
  const y = last(candles([...LEAD, pole, [116, 118, 115, 117]]));
  assert.deepStrictEqual([y.box.flavor, y.box.high, y.box.low, y.box.pole && y.box.pole.dir], ['nr7', 118, 115, 'up']);
  // A pole more than poleBars before the box is none.
  const far = last(candles([...LEAD, pole, [117, 122, 112, 117], [117, 122, 112, 117], [117, 122, 112, 117], [117, 123, 121, 122]]), { params: { ...P, poleBars: 3 } });
  assert.strictEqual(far.box.pole, null);
  // The break's way: withPole only when the pole points the break's way.
  const brk = last(candles([...LEAD, pole, [117, 120, 118.75, 119], [119.5, 132, 119, 131.5]]));
  assert.deepStrictEqual([brk.state, brk.break.withPole], ['expanding', true]);
  const down = last(candles([...LEAD, pole, [117, 120, 118.75, 119], [119, 119.5, 106, 106.5]]));
  assert.deepStrictEqual([down.state, down.break.dir, down.break.withPole], ['expanding', 'down', false]);
});

test('compression: an expansion candle closing out of the box is the transition (expanding), timed by its close', () => {
  const cs = candles([...PRE, NR, UP]);
  const x = last(cs);
  assert.strictEqual(x.state, 'expanding');
  assert.deepStrictEqual([x.break.dir, x.break.closedAt, x.break.close, x.break.expansion, x.break.barsAgo, x.break.backInside, x.break.beyondNow, x.break.late], ['up', cs[16].closedAt, 116.5, true, 0, false, true, false]);
  assert.deepStrictEqual([x.break.rangeAtr, x.break.beyondAtr], [1.25, 1.05]);
  assert.strictEqual(x.box.high, 106);
  // Down: the mirror.
  assert.deepStrictEqual([last(candles([...PRE, NR, [104, 104.5, 91.5, 92]])).state, last(candles([...PRE, NR, [104, 104.5, 91.5, 92]])).break.dir], ['expanding', 'down']);
  // Still expanding on the next candle while it holds; no longer after recentBars candles.
  const on = candles([...PRE, NR, UP, [116.5, 118, 116, 117.5]]);
  assert.deepStrictEqual([last(on).state, last(on).break.barsAgo], ['expanding', 1]);
  const old = candles([...PRE, NR, UP, [116.5, 118, 116, 117], [117, 118, 116, 117], [117, 118, 116, 117], [117, 118, 116, 117]]);
  assert.notStrictEqual(last(old, { params: { ...P, maxRunAtr: 99 } }).state, 'expanding');
});

test('compression: a poke, a small candle, a wick, a fakeout, price back inside and a late break are no expansion', () => {
  // Closing 0.5 above the box (0.05 ATR) on a wide candle: a poke.
  const p = last(candles([...PRE, NR, [105, 116, 104, 106.5]]));
  assert.deepStrictEqual([p.state === 'expanding', p.break.beyondAtr, p.break.expansion], [false, 0.05, false]);
  assert.strictEqual(last(candles([...PRE, NR, [105, 116, 104, 106.5]]), { params: { ...P, minBeyondAtr: 0 } }).state, 'expanding');
  // A range of 4 (0.4 ATR): a small candle.
  assert.strictEqual(last(candles([...PRE, NR, [105, 108, 104, 107.5]])).break.expansion, false);
  // A wick to 110, close back at 105: no break at all.
  assert.strictEqual(last(candles([...PRE, NR, [105, 110, 104, 105]])).break, null);
  // The expansion, then a close back inside the box.
  const f = last(candles([...PRE, NR, UP, [116, 116.5, 104, 105]]));
  assert.deepStrictEqual([f.state, f.break.backInside], ['neither', true]);
  // Price back inside the box on the expansion candle's own bar.
  const back = at(candles([...PRE, NR, UP]), 16, { price: 105.5 });
  assert.deepStrictEqual([back.break.beyondNow, back.state], [false, 'neither']);
  assert.match(C.compressionLine({ '3m': back }), /0 bars ago, price back inside\.$/);
  // Late: price 11.5 past the expansion candle's close (1.15 ATR).
  const late = at(candles([...PRE, NR, UP]), 16, { price: 128 });
  assert.deepStrictEqual([late.break.runAtr, late.break.late, late.state], [1.15, true, 'neither']);
  // Mutations of the thresholds fail.
  assert.notStrictEqual(last(candles([...PRE, NR, UP]), { params: { ...P, expandAtr: 1.3 } }).state, 'expanding');
  assert.notStrictEqual(last(candles([...PRE, NR, UP]), { params: { ...P, minBeyondAtr: 1.1 } }).state, 'expanding');
});

test('compression: a box is narrow: no wider than maxWidthAtr x ATR, back to back, no displacement in it', () => {
  // A mother 25 wide (2.5 ATR) with an inside candle: too wide for an inside box (maxWidthAtr 2), so the NR7 candle's own
  // range (97-103); with 3 the mother's is the box.
  const wide = candles([...PRE, [100, 112.5, 87.5, 101], [101, 103, 97, 102]]);
  assert.deepStrictEqual([last(wide).box.flavor, last(wide).box.high, last(wide).box.low], ['nr7', 103, 97]);
  assert.deepStrictEqual([last(wide, { params: { ...P, maxWidthAtr: 3 } }).box.flavor, last(wide, { params: { ...P, maxWidthAtr: 3 } }).box.high], ['inside', 112.5]);
  // An NR7 candle wider than maxWidthAtr x ATR is no box either (here 0.6 ATR: a cap of 0.5 refuses it).
  assert.strictEqual(last(wide, { params: { ...P, maxWidthAtr: 0.5 } }).state, 'neither');
  // An inside candle after a feed gap: the stack spans the gap, so no box.
  const gap = candles([...PRE, [101, 103, 97, 102]], { gapAt: 15 });
  assert.strictEqual(last(gap).state, 'neither');
  // A displacement candle inside the mother (body 7 of a 7.5 range, ATR about 4.6 after quiet candles): no box.
  const quiet = Array.from({ length: 15 }, () => [100, 102.25, 97.75, 100]);
  const disp = candles([...quiet, [100, 104, 96, 100], [96.5, 104, 96.5, 103.5]]);
  assert.ok(require('../../scripts/lib/trading/candle-facts').patternsOf({ o: 96.5, h: 104, l: 96.5, c: 103.5 }, { o: 100, h: 104, l: 96, c: 100 }, 4.5).includes('displacement'));
  assert.strictEqual(last(disp).state, 'neither');
  // When the inside box isn't narrow, an NR candle falls back to its own range: inside a too-wide mother, and (a flag)
  // after a displacement inside the mother, with that displacement as its pole.
  const inWide = last(candles([...PRE, [100, 112.5, 87.5, 101], [101, 102, 100, 101.5]]));
  assert.deepStrictEqual([inWide.state, inWide.box.flavor, inWide.box.high, inWide.box.low], ['compressing', 'nr7', 102, 100]);
  const flag = last(candles([...quiet, [100, 104, 96, 100], [96.5, 104, 96.5, 103.5], [103, 103.5, 102.5, 103]]));
  assert.deepStrictEqual([flag.state, flag.box.flavor, flag.box.high, flag.box.low, flag.box.pole && flag.box.pole.dir], ['compressing', 'nr7', 103.5, 102.5, 'up']);
});

test('compression: a close back inside after the expansion is a fakeout even when price is beyond again', () => {
  // UP, a close back inside the box, then a close back above it with price beyond: still no expansion.
  const cs = candles([...PRE, NR, UP, [116, 116.5, 104, 105], [105, 108, 104.5, 107.5]]);
  const x = last(cs);
  assert.deepStrictEqual([x.break && x.break.backInside, x.break && x.break.beyondNow, x.state === 'expanding'], [true, true, false]);
  // A new box after the failed expansion is the state (compressing), not the failure.
  const fresh = candles([...PRE, NR, UP, [116, 116.5, 104, 105], [105, 105.75, 104.5, 105.25]]);
  const y = last(fresh);
  assert.deepStrictEqual([y.state, y.box.to], ['compressing', fresh[fresh.length - 1].closedAt]);
});

test('compression: volume against the box candle\'s; a zero-range candle is no box', () => {
  const v = last(candles([...PRE, [...NR, 50], [...UP, 200]]));
  assert.strictEqual(v.break.volVsBox, 4);
  assert.strictEqual(C.boxAt(candles([...PRE, [106, 106, 106, 106]]), 15, C.seriesOf(candles([...PRE, [106, 106, 106, 106]]), P), P), null);
});

test('compression: no look-ahead: the state at candle j is the same with or without the candles after it', () => {
  const cs = candles([...PRE, NR, UP, [116, 116.5, 104, 105], [105, 106, 104, 105.5], [105, 105.5, 104.5, 105]]);
  for (let j = 14; j < cs.length; j += 1) assert.deepStrictEqual(at(cs, j), at(cs.slice(0, j + 1), j), `candle ${j}`);
  assert.strictEqual(at(cs, 16).state, 'expanding');
});

test('compression: the key levels the box sits at, with the edge', () => {
  const cs = candles([...PRE, NR]);
  const levels = [['prior RTH high', 106.5], ['VWAP (rth)', 104.5], ['session POC', 102.5], ['overnight low', 90], ['IB low', 103.25, 103.25]];
  const x = last(cs, { levels });
  // Band 2.5 (0.25 x ATR 10): every one but the overnight low; at most 3, nearest an edge first.
  assert.deepStrictEqual(x.box.levels, [{ name: 'IB low', price: 103.25, edge: 'bottom' }, { name: 'prior RTH high', price: 106.5, edge: 'top' }, { name: 'session POC', price: 102.5, edge: 'bottom' }]);
  assert.deepStrictEqual(last(cs, { params: { ...P, levelBandAtr: 0 }, levels }).box.levels.map(l => l.name), ['IB low', 'VWAP (rth)']);
});

test('compression: the briefing block (compressionFrames): a swing on the box\'s timeframe or lower is never its level; levels as of the box\'s start', () => {
  const t0 = Date.parse('2022-03-01T23:00:00Z');
  const bars = [...PRE, NR].map(([o, h, l, c], i) => ({ t: new Date(t0 + i * 3600000).toISOString(), o, h, l, c, v: 100 }));
  const levels = [['untested 1h swing high', 105.5], ['1h swing low 103', 103], ['15m swing high 106', 106], ['4h swing high 106.5', 106.5], ['prior RTH high', 104.5]];
  let asked = null;
  const out = C.compressionFrames({ bars, base: 60, frames: [60], params: P, levels: from => { asked = from; return levels; } });
  assert.strictEqual(out['1h'].state, 'compressing');
  assert.strictEqual(asked, bars[15].t, 'levels as they stood at the box\'s candle');
  assert.deepStrictEqual(out['1h'].box.levels.map(l => l.name).sort(), ['4h swing high 106.5', 'prior RTH high']);
});

test('compression: the summary line: expanding in full, a failed expansion with why, a box compact; a small break left out', () => {
  const cs = candles([...PRE, NR, UP]);
  const line = C.compressionLine({ '3m': last(cs, { levels: [['prior RTH high', 106.5]] }), '15m': { state: 'neither', box: null, break: null }, '5m': 'unavailable (x)' });
  assert.match(line, /^- Compression \(completed candles; a read, not a signal\): 3m expanding up: nr7 box 103-106 \(3 pts, 0\.3 ATR, at prior RTH high 106\.5 \(its top\)\), expansion closed .* above it \(range 1\.25 ATR, 1\.05 ATR beyond, volume 1x\), 0 bars ago\.$/);
  assert.strictEqual(C.compressionLine({ '15m': { state: 'neither', box: null, break: null } }), null);
  assert.doesNotMatch(String(C.compressionLine({ '3m': last(candles([...PRE, NR, [105, 108, 104, 107.5]])) })), /expansion/);
  assert.match(C.compressionLine({ '3m': last(candles([...PRE, NR, UP, [116, 116.5, 104, 105]])) }), /3m no expansion: nr7 box 103-106 .*, 1 bar ago, closed back inside\.$/);
  assert.match(C.compressionLine({ '15m': last(candles([...PRE, [101, 103, 97, 102], [101, 102, 98, 100]])) }), /: 15m inside x2 box 95-105 \(1 ATR\)\.$/);
});
