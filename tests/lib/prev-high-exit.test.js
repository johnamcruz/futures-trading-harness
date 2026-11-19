'use strict';

// P1 (feat/p1-mtf-entries): the exit option `prev_high_or_trail` (scripts/lib/trading/prev-high-exit.js): the target is
// the MTF entry's previous high (long) or low (short), the parent impulse extreme. Each closed 3m bar: a 15m candle
// completing at this close beyond the target past the tie -> broken (ride today's trail, no more target checks); else a
// 3m bar that touched the target and closed back on the entry side -> rejected (close at market). Before the target,
// nothing changes. A gap through the target is the same rule. Tick-checked (MNQ 0.25).

const test = require('node:test');
const assert = require('node:assert/strict');
const PH = require('../../scripts/lib/trading/prev-high-exit');

const long = (target = 21598) => PH.initial({ target, sign: 1 });
const short = (target = 21402) => PH.initial({ target, sign: -1 });
const bar = (o, h, l, c) => ({ t: '2026-10-07T14:03:00.000Z', o, h, l, c });

test('initial: pending with its target; no target (none known at entry) or a bad sign: none (today\'s exit)', () => {
  assert.deepEqual(long(), { target: 21598, sign: 1, state: 'pending', at: null, why: null });
  assert.equal(PH.initial({ target: null, sign: 1 }), null);
  assert.equal(PH.initial({ target: 21598, sign: 0 }), null);
  assert.equal(PH.initial({ target: NaN, sign: -1 }), null);
});

test('long: under the target nothing; a 3m touch closing back under it is the rejection (exit); a 15m close past the tie is broken (ride)', () => {
  assert.deepEqual(PH.step(long(), { bar: bar(21580, 21597.75, 21578, 21590) }).state, 'pending');
  const rej = PH.step(long(), { bar: bar(21590, 21598, 21588, 21595) });
  assert.deepEqual([rej.state, rej.exit], ['rejected', true]);
  assert.match(rej.why, /previous high 21598 rejected: the 3m bar touched it \(high 21598\) and closed back under it at 21595/);
  // A 3m close above it: no rejection; the 15m candle completing at this close beyond it past the tie: broken.
  const above = PH.step(long(), { bar: bar(21590, 21604, 21589, 21603) });
  assert.deepEqual([above.state, above.exit], ['pending', false]);
  const brk = PH.step(long(), { bar: bar(21590, 21604, 21589, 21603), candle15: { c: 21603 }, tie15: 1 });
  assert.deepEqual([brk.state, brk.exit], ['broken', false]);
  // Within the tie: not broken (the module's COMPLETED rule: past the tie).
  assert.equal(PH.step(long(), { bar: bar(21590, 21600, 21589, 21598.5), candle15: { c: 21598.5 }, tie15: 1 }).state, 'pending');
  // Broken stays broken; a later rejection-shaped bar is nothing (today's trail rides).
  const after = PH.step(brk, { bar: bar(21603, 21604, 21590, 21592) });
  assert.deepEqual([after.state, after.exit], ['broken', false]);
  // Rejected stays rejected (the close is sent once).
  assert.deepEqual(PH.step(rej, { bar: bar(21590, 21598, 21588, 21595) }).exit, false);
});

test('short: the mirror (a touch of the previous low closing back above it; a 15m close under it past the tie)', () => {
  const rej = PH.step(short(), { bar: bar(21410, 21412, 21402, 21405) });
  assert.deepEqual([rej.state, rej.exit], ['rejected', true]);
  assert.match(rej.why, /previous low 21402 rejected/);
  assert.equal(PH.step(short(), { bar: bar(21410, 21412, 21402.25, 21405) }).state, 'pending');
  assert.equal(PH.step(short(), { bar: bar(21405, 21406, 21396, 21397), candle15: { c: 21397 }, tie15: 1 }).state, 'broken');
});

test('a gap through the target: open beyond and close back inside is a rejection; open beyond and a 15m close past the tie is broken', () => {
  const g = PH.step(long(), { bar: bar(21610, 21612, 21590, 21594) });
  assert.deepEqual([g.state, g.exit], ['rejected', true]);
  const gb = PH.step(long(), { bar: bar(21610, 21615, 21605, 21612), candle15: { c: 21612 }, tie15: 1 });
  assert.equal(gb.state, 'broken');
  const gs = PH.step(short(), { bar: bar(21390, 21410, 21388, 21406) });
  assert.equal(gs.state, 'rejected');
});

test('the Position line clause: not reached, rejected, broken: riding', () => {
  assert.equal(PH.clause(long(), x => x), 'target 21598 (previous high): not reached');
  assert.equal(PH.clause({ ...long(), state: 'rejected' }, x => x), 'target 21598 (previous high): rejected');
  assert.equal(PH.clause({ ...short(), state: 'broken' }, x => x), 'target 21402 (previous low): broken: riding');
  assert.equal(PH.clause(null, x => x), null);
});

test('at15: the 15m candle a 3m bar completes (its close, the tie = equalAtr x the 15m ATR(14) by then), never one still forming', () => {
  const T0 = Date.parse('2026-10-07T13:00:00.000Z');
  const bars = Array.from({ length: 40 }, (_, i) => ({ t: new Date(T0 + i * 180000).toISOString(), o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 1 }));
  // The bar opening at 13:12 closes 13:15: it completes the 13:00 candle (its close is that bar's close).
  const at = PH.at15({ bars, bar: bars[4], equalAtr: 0.05, minutes: 15 });
  assert.deepEqual([at.candle15.c, at.candle15.t], [bars[4].c, bars[0].t]);
  assert.ok(at.tie15 >= 0);
  assert.deepEqual(PH.at15({ bars, bar: bars[5], equalAtr: 0.05, minutes: 15 }), { candle15: null, tie15: 0 }, 'mid-candle: none');
  // Causal: the bars after the bar never change it.
  assert.deepEqual(PH.at15({ bars: bars.slice(0, 5), bar: bars[4], equalAtr: 0.05, minutes: 15 }), at);
  assert.throws(() => PH.at15({ bars, bar: bars[4], minutes: 15 }), /equalAtr is required/);
  assert.throws(() => PH.at15({ bars, bar: bars[4], equalAtr: 0.05 }), /minutes is required/);
});

test('no state without a numeric target (a null stamp is no target, never 0), nor for a target not ahead of the entry', () => {
  for (const target of [null, undefined, '21530', NaN]) assert.equal(PH.initial({ target, sign: 1, entry: 21500 }), null, String(target));
  assert.equal(PH.initial({ target: 21495, sign: 1, entry: 21500 }), null, 'a long\'s previous high under its entry');
  assert.equal(PH.initial({ target: 21500, sign: 1, entry: 21500 }), null, 'at the entry');
  assert.equal(PH.initial({ target: 21505, sign: -1, entry: 21500 }), null, 'a short\'s previous low above its entry');
  assert.deepEqual(PH.initial({ target: 21530, sign: 1, entry: 21500 }), { target: 21530, sign: 1, state: 'pending', at: null, why: null });
  assert.deepEqual(PH.initial({ target: 21470, sign: -1, entry: 21500 }).state, 'pending');
});
