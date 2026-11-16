'use strict';

// The Market state's structure layers (scripts/lib/trading/structure-layers.js, round 20): the RTH breaks, the protected
// machine (the owner's protected swing as the only invalidation, his CHoCH then BOS as the confirmed transition) and the
// momentum condition around an intact leg. Synthetic 3m bars (a path of closes; each bar opens halfway from the previous
// close, high and low one point beyond its body), every expectation stated against the primitives it reuses.

const test = require('node:test');
const assert = require('node:assert');
const L = require('../../scripts/lib/trading/structure-layers');
const SE = require('../../scripts/lib/trading/structure-events');
const { strongCandle } = require('../../scripts/lib/trading/cisd');
const ind = require('../../scripts/lib/trading/indicators');

const P = { followBars: 3, dispBars: 3, equalAtr: 0.05, structBars: 20, pressBars: 6, lossStale: 10 };
const FLAT = Array.from({ length: 16 }, (_, i) => 100 + (i % 2));
const mk = cs => { let p = cs[0]; return cs.map((c, i) => { const o = (p + c) / 2; p = c; return { t: new Date(Date.UTC(2026, 0, 6, 14, 0) + i * 180000).toISOString(), o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 1 }; }); };
// An up leg: BOS up at bar 24, its follow-through fails (bar 27 closes back under 109), a second BOS up at bar 30.
const UP = [102, 104, 106, 108, 106, 104, 105, 107, 110, 113, 111, 108, 109, 112, 116];
// The up leg, then a close through its protected HL 103 at bar 31.
const BREAK = [102, 104, 106, 108, 106, 104, 105, 107, 110, 113, 111, 108, 106, 107, 104, 101, 103, 99, 97];
// An up leg whose protected HL (103) holds while a CHoCH down (bar 34) and then a BOS down (bar 39) break internal lows.
const CHOCH_BOS = [102, 104, 106, 108, 110, 108, 106, 104, 106, 109, 112, 115, 118, 116, 114, 115, 117, 115, 112, 111, 112, 113, 111, 109, 107];
const FROM = 16;
const setup = (cs, p = P, edit = x => x) => {
  const bars = edit(mk([...FLAT, ...cs]));
  const atr = ind.atr(bars);
  const breaks = L.rthBreaks(bars, FROM, atr, p);
  return { bars, atr, breaks, series: L.structureSeries(bars, breaks, FROM, atr, p) };
};

test('rthBreaks: the k=2 breaks from the RTH bar on, each with its displacement (strongCandle the break\'s way)', () => {
  const { bars, atr, breaks } = setup(UP);
  const all = SE.breaksOf(bars);
  assert.deepStrictEqual(breaks.map(b => [b.i, b.kind, b.direction, b.level]), all.filter(b => b.i >= FROM).map(b => [b.i, b.kind, b.direction, b.level]));
  for (const b of breaks) assert.strictEqual(b.strong, strongCandle(bars[b.i], bars[b.i - 1], b.direction === 'up' ? 1 : -1, atr[b.i - 1]).strong);
  assert.deepStrictEqual(L.rthBreaks(bars, 25, atr, P).map(b => b.i), [30], 'a break before the RTH bar is not an RTH break');
  assert.throws(() => L.rthBreaks(bars, FROM, atr, {}), /followBars/, 'never a literal');
});

test('failedAt: a close back through the level within followBars, as of the bar asked (causal)', () => {
  const { bars, breaks } = setup(UP);
  const b = breaks[0]; // BOS up 109 at bar 24; bar 27 closes 108
  assert.strictEqual(L.failedAt(bars, b, 26, P), false, 'not yet');
  assert.strictEqual(L.failedAt(bars, b, 27, P), true);
  assert.strictEqual(L.failedAt(bars, b, 27, { ...P, followBars: 2 }), false, 'a close back after followBars is no failure');
});

test('the machine: the first RTH break sets the leg and its protected level (protectedOf); a continuation moves it; legOK follows the follow-through', () => {
  const { bars, breaks, series } = setup(UP);
  assert.strictEqual(series[23], null, 'no RTH break yet');
  assert.deepStrictEqual([series[24].side, series[24].status, series[24].level], ['up', 'intact', SE.protectedOf(bars, SE.breaksOf(bars)[0]).level]);
  assert.strictEqual(series[26].legOK, true, 'undecided counts as held');
  assert.strictEqual(series[27].legOK, false, 'the leg\'s only break failed: not established');
  assert.strictEqual(series[30].legOK, true, 'a new break its way holds');
  assert.strictEqual(series[30].level, SE.protectedOf(bars, SE.breaksOf(bars)[1]).level, 'the level trails to the last break\'s origin');
  assert.notStrictEqual(series[30].level, series[24].level);
  assert.deepStrictEqual([series[29].sinceProgress, series[30].sinceProgress], [4, 0], 'bars since a new high by close');
  assert.strictEqual(breaks.length, 2);
});

test('the machine: a close through the protected level beyond the tie tolerance is the one invalidation; within it, a tie', () => {
  const { series } = setup(BREAK);
  assert.deepStrictEqual([series[30].side, series[30].status], ['up', 'intact'], 'a close above the HL');
  const f = series[31];
  assert.deepStrictEqual([f.side, f.status, f.flip.byRule, f.flip.oldLevel, f.flip.held, f.legOK], ['down', 'broken', 'close', 103, true, false]);
  assert.strictEqual(f.level, 114, 'the new side\'s level: the old leg\'s extreme');
  const tie = setup(BREAK, { ...P, equalAtr: 5 }).series;
  assert.deepStrictEqual([tie[31].side, tie[31].status], ['up', 'intact'], 'a close within the tolerance is a tie, not a break');
});

test('the machine: a close back through the broken level within followBars hands the leg back (the protected break failed)', () => {
  const { series } = setup([...BREAK.slice(0, 15), 99, 104, 106]); // bar 31 closes 99 through 103, bar 32 back to 104
  assert.strictEqual(series[31].status, 'broken');
  assert.deepStrictEqual([series[32].side, series[32].status, series[32].resumed, series[32].flip.held], ['up', 'intact', true, false]);
});

test('the machine: inside an intact leg a CHoCH against then a BOS the same way is the transition confirmed (the owner\'s rule); one CHoCH alone is internal', () => {
  const { series } = setup(CHOCH_BOS);
  assert.deepStrictEqual([series[34].side, series[34].status, series[34].internal, series[34].level], ['up', 'intact', 1, 103], 'the CHoCH down: internal, the HL holds');
  assert.deepStrictEqual([series[34].lastInternal.direction, series[34].lastInternal.barsAgo], ['down', 0]);
  const f = series[39];
  assert.deepStrictEqual([f.side, f.status, f.flip.byRule, f.legOK], ['down', 'intact', 'choch-bos', true]);
  // The CHoCH failed before the BOS (a close back above it within followBars): no transition.
  const failed = setup([...CHOCH_BOS.slice(0, 18), 112, 113, 114, 112, 110, 108]).series;
  assert.ok(failed.slice(FROM).every(s => !s || s.side === 'up'), 'a failed CHoCH confirms nothing');
});

test('the machine (round 20c, item 4): a CHoCH-then-BOS flip keeps the old protected level unbroken (oldBroken false) until a close goes through it', () => {
  const f = setup(CHOCH_BOS).series[39];
  assert.deepStrictEqual([f.flip.byRule, f.flip.oldLevel, f.flip.oldBroken], ['choch-bos', 103, false], 'the BOS down at 109: the HL 103 unbroken');
  const later = setup([...CHOCH_BOS, 105, 101, 99]).series;
  assert.strictEqual(later[41].flip.oldBroken, false, 'a close at 105: still above 103');
  assert.strictEqual(later[42].flip.oldBroken, true, 'a close at 101 through 103');
  assert.strictEqual(later[43].flip.oldBroken, true, 'once broken, broken');
  const tie = setup([...CHOCH_BOS, 105, 102.9]);
  assert.ok(0.1 < P.equalAtr * tie.atr[42], `the tie tolerance ${P.equalAtr * tie.atr[42]} covers a 0.1 close under 103`);
  assert.strictEqual(tie.series[42].flip.oldBroken, false, 'a close 0.1 under 103, within the tie (decision 8): not broken');
  // The BOS bar itself closing through the old level (the review's case, 2022-08-11 11:03 on real bars): broken at once.
  const through = setup([...CHOCH_BOS.slice(0, 23), 101]).series[39];
  assert.deepStrictEqual([through.flip.byRule, through.flip.barsAgo, through.flip.oldBroken], ['choch-bos', 0, true], 'the BOS bar closes at 101, under 103');
  const close = setup(BREAK).series[31];
  assert.deepStrictEqual([close.flip.byRule, close.flip.oldBroken], ['close', true], 'a close-through flip: broken by definition');
});

test('the machine is causal: the snapshot at bar k from bars[0..k] equals the one inside the longer run', () => {
  for (const cs of [UP, BREAK, CHOCH_BOS]) {
    const full = setup(cs);
    for (let k = FROM; k < full.bars.length; k += 1) {
      const bars = full.bars.slice(0, k + 1);
      const atr = ind.atr(bars);
      const part = L.structureSeries(bars, L.rthBreaks(bars, FROM, atr, P), FROM, atr, P);
      assert.deepStrictEqual(part[k], full.series[k], `bar ${k}`);
    }
  }
});

test('momentumAt: the weakening trigger needs a break against that is strong, or a break against with displacement against; loss of control by staleness or a failed break', () => {
  // A strong bear candle as the CHoCH down at bar 34 (body 0.86 of its range, the close in the low third, range >= 1 ATR).
  const strong = bars => { bars[34] = { ...bars[34], o: 116.5, h: 116.75, l: 111.5, c: 111.75 }; return bars; };
  const s = setup(CHOCH_BOS, P, strong);
  const m = L.momentumAt(s.bars, s.breaks, s.series[34], 34, FROM, s.atr, P);
  assert.ok(s.breaks.find(b => b.i === 34).strong, 'the fixture\'s break is displaced');
  assert.deepStrictEqual([m.trigger, m.breakAgainst.direction, m.breakAgainst.strong, m.dispAgainst.barsAgo], [true, 'down', true, 0]);
  const plain = setup(CHOCH_BOS);
  const m2 = L.momentumAt(plain.bars, plain.breaks, plain.series[34], 34, FROM, plain.atr, P);
  assert.deepStrictEqual([m2.trigger, Boolean(m2.breakAgainst), m2.dispAgainst], [false, true, null], 'an internal break with no displacement: no trigger');
  // The owner's second clause: a break against that is not itself strong, with a strong candle against in the window.
  const disp33 = bars => { bars[33] = { ...bars[33], o: 117.75, h: 118, l: 114.25, c: 114.5 }; return bars; };
  const d = setup(CHOCH_BOS, P, disp33);
  assert.ok(L.barStrong(d.bars, 33, d.atr) && !d.breaks.find(b => b.i === 34).strong, 'the fixture: a displaced bar 33, an undisplaced CHoCH at 34');
  const m3 = L.momentumAt(d.bars, d.breaks, d.series[34], 34, FROM, d.atr, P);
  assert.deepStrictEqual([m3.trigger, m3.breakAgainst.strong, m3.dispAgainst.barsAgo], [true, false, 1], 'a break against with displacement against: the trigger');
  assert.strictEqual(L.momentumAt(d.bars, d.breaks, d.series[34], 34, FROM, d.atr, { ...P, pressBars: 1 }).trigger, false, 'the displacement outside the window: no trigger');
  const late = L.momentumAt(s.bars, s.breaks, s.series[34], 34, FROM, s.atr, { ...P, pressBars: 1 });
  assert.strictEqual(late.trigger, true, 'the break at this bar is inside a one-bar window');
  const stale = L.momentumAt(plain.bars, plain.breaks, plain.series[38], 38, FROM, plain.atr, P);
  assert.strictEqual(stale.loss, true, 'no new high by close for lossStale (10) bars');
  assert.strictEqual(L.momentumAt(plain.bars, plain.breaks, plain.series[37], 37, FROM, plain.atr, P).loss, false, '9 bars: not yet');
  const u = setup(UP);
  assert.strictEqual(L.momentumAt(u.bars, u.breaks, u.series[27], 27, FROM, u.atr, P).loss, true, 'the leg\'s last break its way failed');
  const b = setup(BREAK);
  assert.deepStrictEqual(L.momentumAt(b.bars, b.breaks, b.series[31], 31, FROM, b.atr, P), { dispAgainst: null, breakAgainst: null, trigger: false, loss: false }, 'no intact leg: no warning');
});
