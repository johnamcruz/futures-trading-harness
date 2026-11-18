'use strict';

// The protected swing's status, one predicate for every printer (scripts/lib/trading/protected-status.js): a close
// through the level against the leg by more than equalAtr x ATR(14) at that candle breaks it (R1: a wick never counts, a
// tie holds, a non-finite ATR is a tie of 0), and once broken it stays broken (R2). Pure; equalAtr is always passed in.

const test = require('node:test');
const assert = require('node:assert');
const PS = require('../../scripts/lib/trading/protected-status');

const EQ = 0.05; // config/analysis.json marketState.equalAtr (the tests state it; the module never does)
// Candles from closes (high and low one point beyond the body); an ATR of 20 on every candle: a tie of 1.
const mk = (cs, wick = 1) => cs.map((c, i) => ({ t: new Date(Date.UTC(2026, 0, 6, 14, 30 + 3 * i)).toISOString(), o: i ? cs[i - 1] : c, h: Math.max(c, i ? cs[i - 1] : c) + wick, l: Math.min(c, i ? cs[i - 1] : c) - wick, c, v: 1 }));
const ATR = n => Array(n).fill(20);

test('through: a close past the level against the leg by more than the tie; an up leg breaks below its HL, a down leg above its LH', () => {
  assert.strictEqual(PS.through(98.9, 100, 'up', 1), true, '1.1 under the HL, tie 1');
  assert.strictEqual(PS.through(99, 100, 'up', 1), false, 'exactly the tie: holds (strict)');
  assert.strictEqual(PS.through(100, 100, 'up', 1), false, 'at the level: holds');
  assert.strictEqual(PS.through(105, 100, 'up', 1), false, 'the leg\'s way: holds');
  assert.strictEqual(PS.through(101.1, 100, 'down', 1), true, '1.1 over the LH');
  assert.strictEqual(PS.through(101, 100, 'down', 1), false, 'exactly the tie over the LH');
  assert.strictEqual(PS.through(99.99, 100, 'up', 0), true, 'a tie of 0: any close past breaks');
  assert.strictEqual(PS.through(NaN, 100, 'up', 1), false, 'no close: no break');
  assert.strictEqual(PS.through(90, NaN, 'up', 1), false, 'no level: no break');
  assert.throws(() => PS.through(90, 100, 'sideways', 1), /legSide/);
});

test('tieAt: equalAtr x ATR(14) at the candle; a non-finite ATR is a tie of 0; equalAtr is required (never a literal)', () => {
  assert.strictEqual(PS.tieAt([10, 20, 40], 1, EQ), 1);
  assert.strictEqual(PS.tieAt([10, NaN, 40], 1, EQ), 0);
  assert.strictEqual(PS.tieAt([10], 5, EQ), 0, 'past the series');
  assert.strictEqual(PS.tieAt(null, 0, EQ), 0, 'no ATR series');
  assert.throws(() => PS.tieAt([10], 0, undefined), /equalAtr/);
  assert.throws(() => PS.tieAt([10], 0, NaN), /equalAtr/);
});

test('firstCloseThrough: the first candle after `after` whose close is through past the tie; a wick or a tie is no break', () => {
  const cs = mk([105, 103, 100.5, 99.5, 98.9, 97, 104]);
  const o = { level: 100, legSide: 'up', after: 0, atr: ATR(cs.length), equalAtr: EQ };
  assert.strictEqual(PS.firstCloseThrough(cs, o), 4, '99.5 is a tie (0.5 < 1); 98.9 breaks');
  assert.strictEqual(PS.firstCloseThrough(cs, { ...o, after: 4 }), 5, 'only candles after `after`');
  assert.strictEqual(PS.firstCloseThrough(cs, { ...o, level: 90 }), -1, 'none');
  const wick = mk([105, 103, 102, 101], 5); // lows to 96, closes above 100
  assert.ok(wick.some(c => c.l < 99), 'the wick goes past the level and the tie');
  assert.strictEqual(PS.firstCloseThrough(wick, { ...o, atr: ATR(4) }), -1, 'a wick never counts');
  const noAtr = PS.firstCloseThrough(cs, { ...o, atr: Array(cs.length).fill(NaN) });
  assert.strictEqual(noAtr, 3, 'no ATR: a tie of 0, the 99.5 close breaks');
  assert.throws(() => PS.firstCloseThrough(cs, { ...o, equalAtr: undefined }), /equalAtr/);
});

test('firstCloseThrough on gaps: the close decides (opens past and closes past: broken; opens past and closes back inside: holds)', () => {
  const past = [{ t: 'a', o: 105, h: 106, l: 104, c: 105 }, { t: 'b', o: 97, h: 98, l: 96, c: 97 }];
  assert.strictEqual(PS.firstCloseThrough(past, { level: 100, legSide: 'up', after: 0, atr: [20, 20], equalAtr: EQ }), 1);
  const back = [{ t: 'a', o: 105, h: 106, l: 104, c: 105 }, { t: 'b', o: 97, h: 102, l: 96, c: 101 }];
  assert.strictEqual(PS.firstCloseThrough(back, { level: 100, legSide: 'up', after: 0, atr: [20, 20], equalAtr: EQ }), -1);
});

test('statusOf: broken at the first close past the tie and sticky (R2); tied before any break; the first close back the old way past the tie', () => {
  const o = { level: 100, legSide: 'up', after: 0, atr: ATR(8), equalAtr: EQ };
  const s = PS.statusOf(mk([105, 103, 99.5, 98, 100.5, 101.5, 103, 97]), o);
  assert.deepStrictEqual(s, { broken: true, brokenI: 3, tied: false, backI: 5 }, '100.5 is back above the level inside the tie (no close back), 101.5 is back past it; 97 later changes nothing');
  assert.deepStrictEqual(PS.statusOf(mk([105, 103, 99.5, 101, 104]), { ...o, atr: ATR(5) }), { broken: false, brokenI: -1, tied: true, backI: -1 }, 'a tie, no break');
  assert.deepStrictEqual(PS.statusOf(mk([105, 103, 100, 101, 104]), { ...o, atr: ATR(5) }), { broken: false, brokenI: -1, tied: false, backI: -1 }, 'a close at the level: neither');
  assert.deepStrictEqual(PS.statusOf(mk([95, 97, 101.5, 98.5]), { level: 100, legSide: 'down', after: 0, atr: ATR(4), equalAtr: EQ }), { broken: true, brokenI: 2, tied: false, backI: 3 }, 'the mirror: an LH');
  const stuck = PS.statusOf(mk([105, 98, 97, 96]), { ...o, atr: ATR(4) });
  assert.deepStrictEqual([stuck.broken, stuck.brokenI, stuck.backI], [true, 1, -1], 'never back');
});
