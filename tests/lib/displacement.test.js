'use strict';

// Displacement, one definition (scripts/lib/trading/displacement.js; the owner's framework and separation, 2026-11-15:
// "Displacement measures strength. Structure determines confirmation. Protected swings determine structural
// invalidation."): the candle rule is cisd.js strongCandle (imported, never copied), a break's strength facts read the
// leg protectedOf defines, the weak reason comes from the rule's own parts, and the line prints strength only (never
// "confirmed"). Hand-built 3m candles, tick-correct (0.25), each expectation worked by hand in the comment beside it.

const test = require('node:test');
const assert = require('node:assert');
const D = require('../../scripts/lib/trading/displacement');
const cisd = require('../../scripts/lib/trading/cisd');
const SE = require('../../scripts/lib/trading/structure-events');
const ind = require('../../scripts/lib/trading/indicators');
const { patternsOf } = require('../../scripts/lib/trading/candle-facts');
const { analysis } = require('../../scripts/lib/tunables');

const AN = analysis();
const T0 = Date.UTC(2026, 2, 2, 14, 30); // 09:30 ET (EST)
const mk = rows => rows.map(([o, h, l, c], i) => ({ t: new Date(T0 + i * 180000).toISOString(), o, h, l, c, v: 1 }));
// A swing high 105 at bar 2 (k=2, confirmed at bar 4), the leg's low 100.25 at bar 5 (the protected low), the BOS up at
// bar 7 (close 107.75 > 105), its own FVG 103.25-106.5 known at bar 8, retraced to 106 (bar 9), to 104.5 with a close
// back under 105 (bar 10), traded through (bar 11), the protected low broken by a close at 100 (bar 12).
const ROWS = [
  [100, 101, 99.5, 100.75], [100.75, 102, 100.5, 101.75], [101.75, 105, 101.5, 104], [104, 104.5, 102.5, 103], [103, 103.5, 101.5, 102],
  [102, 102.5, 100.25, 101], [101, 103.25, 100.75, 103], [103, 108, 102.25, 107.75], [107.75, 109, 106.5, 108.5], [108.5, 108.75, 106, 106.25],
  [106.25, 106.5, 104.5, 104.75], [104.75, 105, 103, 103.25], [103.25, 103.5, 99.75, 100],
];
const ATR = 2.75;
const flatAtr = n => new Array(n).fill(ATR);
const setup = (rows = ROWS) => {
  const candles = mk(rows);
  const brk = SE.breaksOf(candles).find(b => b.direction === 'up');
  return { candles, brk, atr: flatAtr(candles.length) };
};
const q = (at, o = {}) => { const s = setup(o.rows); return D.breakQuality({ candles: s.candles, brk: s.brk, atr: o.atr || s.atr, at, minutes: 3, levels: o.levels || [] }); };

test('one rule: candleDisplaced is cisd.js strongCandle itself (imported, never copied), equal on a candle table', () => {
  assert.strictEqual(D.candleDisplaced, cisd.strongCandle);
  const k = (o, h, l, c) => ({ o, h, l, c });
  for (const [c, prev, dir, atr, want] of [
    [k(100, 104, 99.75, 103.75), k(101, 101.5, 99.5, 100), 1, 3, true], // body 0.88, top third, 1.42 ATR
    [k(100, 104, 99.75, 102), null, 1, 3, false], // body 0.47: wicks, closed mid
    [k(100, 101.25, 99.75, 101), k(100.75, 101, 99.75, 100), 1, 3, true], // 0.5 ATR, but its body 100-101 engulfs 100-100.75
    [k(100, 101.25, 99.75, 101), k(101.25, 101.5, 99.75, 100), 1, 3, false], // 0.5 ATR, body 100-101 inside 100-101.25: small
  ]) {
    assert.strictEqual(D.candleDisplaced(c, prev, dir, atr).strong, want);
    assert.deepStrictEqual(D.candleDisplaced(c, prev, dir, atr), cisd.strongCandle(c, prev, dir, atr));
  }
});

test('strengthAt: displaced, or weak with why from the rule\'s own parts (opposite colour, wicks, closed mid, small), on ATR of the candle before', () => {
  const { candles, atr } = setup();
  assert.deepStrictEqual(D.strengthAt(candles, 7, 1, atr), { displaced: true, why: [] });
  // Bar 7 closing mid: body 2.5 of 5.75 (0.43 < minBody 0.6: wicks), close at 0.57 of the range (not the top third).
  const mid = mk(ROWS.map((r, i) => (i === 7 ? [103, 108, 102.25, 105.5] : r)));
  assert.deepStrictEqual(D.strengthAt(mid, 7, 1, atr), { displaced: false, why: ['wicks', 'closed mid'] });
  // Small: range 5.75 under 1 x ATR 6, and bar 6 is the same colour (no engulfing).
  assert.deepStrictEqual(D.strengthAt(candles, 7, 1, flatAtr(13).fill(6)), { displaced: false, why: ['small'] });
  // The other colour: bar 7 read as a break down.
  assert.deepStrictEqual(D.strengthAt(candles, 7, -1, atr).why[0], 'opposite colour');
  // ATR of the candle BEFORE (the Market state's convention): ATR 2.75 at bar 6, 6 at bar 7 -> still displaced.
  const gapAtr = flatAtr(13); gapAtr[7] = 6;
  assert.strictEqual(D.strengthAt(candles, 7, 1, gapAtr).displaced, true, 'atr[i - 1], never atr[i]');
  const before = flatAtr(13); before[6] = 6;
  assert.strictEqual(D.strengthAt(candles, 7, 1, before).displaced, false, 'atr[i - 1] = 6: small');
  // Every weak candle names at least one part; a displaced one none.
  for (let i = 1; i < candles.length; i += 1) for (const dir of [1, -1]) {
    const s = D.strengthAt(candles, i, dir, atr);
    assert.strictEqual(s.displaced, s.why.length === 0, `${i} ${dir}`);
  }
});

test('the label is the large tier of the same rule: candle-facts\' displacement => candleDisplaced in its own colour (seeded property), and the config keeps it a subset', () => {
  assert.ok(AN.candles.dispBody >= AN.cisd.minBody && AN.candles.dispBody >= 2 / 3, 'dispBody >= minBody and >= 2/3 (a body that size closes in the extreme third)');
  assert.ok(AN.candles.dispAtr >= AN.cisd.minRangeAtr, 'dispAtr >= minRangeAtr');
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const tick = x => Math.round(x * 4) / 4;
  let labelled = 0;
  for (let n = 0; n < 4000; n += 1) {
    const o = tick(100 + rnd() * 10); const c = tick(o + (rnd() - 0.5) * 12);
    const h = tick(Math.max(o, c) + rnd() * 2); const l = tick(Math.min(o, c) - rnd() * 2);
    const prev = { o: tick(100 + rnd() * 10), c: tick(100 + rnd() * 10), h: 112, l: 98 };
    const atrPrev = 1 + rnd() * 6;
    if (!patternsOf({ o, h, l, c }, prev, atrPrev).includes('displacement')) continue;
    labelled += 1;
    assert.strictEqual(D.candleDisplaced({ o, h, l, c }, prev, c > o ? 1 : -1, atrPrev).strong, true, JSON.stringify({ o, h, l, c, atrPrev }));
  }
  assert.ok(labelled > 50, `${labelled} labelled candles checked`);
});

test('at cisd.minRangeAtr 1.0 the ATR at the candle and the candle before give the same word on gapless bars (Wilder); a gap candle can differ', () => {
  assert.strictEqual(AN.cisd.minRangeAtr, 1, 'the equivalence below holds at 1.0 only: a moved threshold fails here');
  let seed = 11;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const tick = x => Math.round(x * 4) / 4;
  const rows = []; let p = 20000;
  for (let n = 0; n < 3000; n += 1) {
    const o = p; const c = tick(o + (rnd() - 0.5) * 20);
    rows.push([o, tick(Math.max(o, c) + rnd() * 6), tick(Math.min(o, c) - rnd() * 6), c]); p = c;
  }
  const bars = mk(rows);
  const atr = ind.atr(bars);
  let strong = 0;
  for (let i = 15; i < bars.length; i += 1) for (const dir of [1, -1]) {
    const before = D.candleDisplaced(bars[i], bars[i - 1], dir, atr[i - 1]).strong;
    assert.strictEqual(D.candleDisplaced(bars[i], bars[i - 1], dir, atr[i]).strong, before, `bar ${i}`);
    if (before) strong += 1;
  }
  assert.ok(strong > 100, `${strong} displaced candles`);
  // A gap: the candle opens 10 points above the previous close, so its true range exceeds its range.
  const g = mk([...rows.slice(0, 40), [p + 10, p + 15, p + 9.75, p + 14.75]]);
  const ga = ind.atr(g);
  const k = g.length - 1;
  const r = g[k].h - g[k].l;
  assert.ok(r >= ga[k - 1] || r < ga[k], 'a gap candle exists whose word may differ');
});

test('breakQuality at the break\'s close: displaced, cleared in ATR, the leg protectedOf defines, its own FVG not known yet, holding', () => {
  const x = q(7);
  assert.strictEqual(x.displaced, true);
  assert.deepStrictEqual(x.why, []);
  assert.strictEqual(x.cleared, 1, '(107.75 - 105) / 2.75');
  // The leg from the protected low (bar 5) to the break: 3 candles; efficiency |107.75 - 100.25| / (2.25 + 2.5 + 5.75) =
  // 0.71; overlap: bar 6 in bar 5 1.75 / 2.5 = 0.7, bar 7 in bar 6 1 / 5.75 = 0.17: mean 0.44.
  assert.deepStrictEqual(x.leg, { bars: 3, eff: 0.71, overlap: 0.44 });
  // Body 4.75 against the mean body of the 7 candles before (9 / 7): 3.69.
  assert.strictEqual(x.bodyX, 3.69);
  assert.deepStrictEqual(x.origin, { side: 'low', price: 100.25, at: mk(ROWS)[5].t, sweep: null });
  assert.strictEqual(x.fvg, null);
  assert.strictEqual(x.fvgPending, true, 'the break candle\'s own gap needs the next candle');
  assert.deepStrictEqual(x.status, { holding: true });
});

test('breakQuality: the FVG with one meaning each: open, filled to (traded into, not through), filled (traded through, kept), no FVG', () => {
  const t7 = mk(ROWS)[7].t;
  assert.deepStrictEqual(q(8).fvg, { side: 'bullish', low: 103.25, high: 106.5, at: t7, state: 'open' });
  assert.strictEqual(q(8).fvgPending, false);
  assert.deepStrictEqual(q(9).fvg, { side: 'bullish', low: 103.25, high: 106.5, at: t7, state: 'filled to', to: 106 });
  assert.deepStrictEqual(q(10).fvg, { side: 'bullish', low: 103.25, high: 106.5, at: t7, state: 'filled to', to: 104.5 });
  assert.deepStrictEqual(q(11).fvg, { side: 'bullish', low: 103.25, high: 106.5, at: t7, state: 'filled' });
  // A gap behind a weak middle candle is no FVG (the owner's trap): bar 7 closing mid leaves no harness gap.
  const weak = ROWS.map((r, i) => (i === 7 ? [103, 108, 102.25, 105.5] : r));
  assert.strictEqual(q(8, { rows: weak }).fvg, null);
  assert.strictEqual(q(8, { rows: weak }).fvgPending, false, 'known now: no FVG');
});

test('breakQuality: holding until a close back through the level, then closed back (the first such close, its age)', () => {
  assert.deepStrictEqual(q(9).status, { holding: true });
  assert.deepStrictEqual(q(10).status, { closedBack: { at: mk(ROWS)[10].t, closedAt: mk(ROWS)[11].t, barsAgo: 0 } });
  assert.deepStrictEqual(q(11).status, { closedBack: { at: mk(ROWS)[10].t, closedAt: mk(ROWS)[11].t, barsAgo: 1 } });
  // A wick back under 105 that closes above it is no close back: still holding.
  const wick = ROWS.map((r, i) => (i === 9 ? [108.5, 108.75, 104.75, 106.25] : r));
  assert.deepStrictEqual(q(9, { rows: wick }).status, { holding: true });
});

test('breakQuality: the origin\'s sweep is the briefing\'s sweep rule (structure-events sweeps) with its close back inside the leg', () => {
  const levels = [{ name: 'overnight low', price: 100.5, side: 'low', key: true }, { name: 'prior RTH high', price: 109, side: 'high', key: true }];
  // Bar 5 trades to 100.25 under 100.5 from a close at 102 above it and closes back above (101): a sweep, back in the leg.
  assert.deepStrictEqual(q(7, { levels }).origin.sweep, { name: 'overnight low', price: 100.5 });
  // A level the leg never traded through: none.
  assert.strictEqual(q(7, { levels: [{ name: 'overnight low', price: 99, side: 'low', key: true }] }).origin.sweep, null);
  // A sweep before the leg (bar 1 trades to 99.75 under 100 and closes back above) is not the leg's origin.
  const early = ROWS.map((r, i) => (i === 1 ? [100.75, 102, 99.75, 101.75] : r));
  assert.strictEqual(q(7, { rows: early, levels: [{ name: 'overnight low', price: 100, side: 'low', key: true }] }).origin.sweep, null);
});

test('breakQuality is causal: candles after `at` change nothing; a break not yet in the candles is null', () => {
  const { candles, brk, atr } = setup();
  for (const at of [7, 8, 9, 10, 11]) {
    const full = D.breakQuality({ candles, brk, atr, at, minutes: 3 });
    const cut = D.breakQuality({ candles: candles.slice(0, at + 1), brk, atr, at, minutes: 3 });
    assert.deepStrictEqual(full, cut, `at ${at}`);
    const edited = candles.map((c, i) => (i > at ? { ...c, l: c.l - 50, c: c.c - 40 } : c));
    assert.deepStrictEqual(D.breakQuality({ candles: edited, brk, atr, at, minutes: 3 }), full, `at ${at}: later candles edited`);
  }
  assert.strictEqual(D.breakQuality({ candles, brk, atr, at: 6, minutes: 3 }), null);
  assert.strictEqual(D.breakQuality({ candles, brk: null, atr, at: 9 }), null);
});

test('qualityOf: the field `quality` on lastBreak.last, and on its protected status once a close breaks the protected swing (strength only; the close decides)', () => {
  const { candles } = setup();
  const lb = cut => { const c = candles.slice(0, cut + 1); const l = SE.lastBreaks(c); return { c, l: { last: l.last ? { ...l.last, protected: SE.protectedOf(c, l.last) } : null, previous: l.previous } }; };
  const { c: c11, l: l11 } = lb(11);
  const w11 = D.qualityOf(c11, l11, { minutes: 3, atr: flatAtr(12) });
  assert.strictEqual(w11.last.quality.displaced, true);
  assert.strictEqual(w11.last.protected.quality, undefined, 'the protected low holds: no invalidation read');
  assert.strictEqual(w11.previous, l11.previous, 'previous untouched');
  // Bar 12 closes at 100 under the protected low 100.25 (displaced: body 3.25 of 3.75, close in the bottom third). Read on
  // the BOS up, the last break before bar 12's own break down.
  const c12 = candles;
  const bos = SE.breaksOf(c12).find(b => b.direction === 'up');
  const prot = SE.protectedOf(c12, bos);
  assert.strictEqual(prot.brokenAt, c12[12].t);
  assert.deepStrictEqual(D.invalidationQuality(c12, bos, prot, flatAtr(13), D.PARAMS, 3), { displaced: true, why: [], barsAgo: 0, closedAt: new Date(T0 + 13 * 180000).toISOString() });
  // A weak close through it: body 1.5 of 3.75 (wicks). Still broken: the close decides, displacement says how strongly.
  const weakRows = ROWS.map((r, i) => (i === 12 ? [101.5, 103.5, 99.75, 100] : r));
  const w = mk(weakRows);
  const pw = SE.protectedOf(w, bos);
  assert.strictEqual(pw.brokenAt, w[12].t, 'broken by the close, weak or not');
  assert.deepStrictEqual(D.invalidationQuality(w, bos, pw, flatAtr(13)), { displaced: false, why: ['wicks'], barsAgo: 0, closedAt: null });
  assert.strictEqual(D.invalidationQuality(w, bos, { ...pw, brokenAt: null }, flatAtr(13)), null);
});

// The line: the shapes printed, the separation's words (strength only, never "confirmed"), recency, the cut order.
const base = (o = {}) => ({ kind: 'BOS', direction: 'up', level: 21412.25, barsAgo: 2, quality: { displaced: true, why: [], cleared: 0.6, bodyX: 2.1, leg: { bars: 4, eff: 0.74, overlap: 0.31 }, origin: { side: 'low', price: 21380.5, at: 'x', sweep: { name: 'overnight low', price: 21381 } }, fvg: { side: 'bullish', low: 21405.5, high: 21409, at: 'x', state: 'open' }, fvgPending: false, status: { holding: true }, ...o } });

test('breakLine: strength, status, cleared, FVG, origin, body (when it agrees), leg; header names the read and the skill', () => {
  const line = D.breakLine({ entry: { tf: '3m', brk: base(), minutes: 3 } });
  assert.strictEqual(line, '- Break quality (strength, not a forecast; `displacement`): 3m BOS up 21412.25 6 min ago: displaced, holding; cleared 0.6 ATR; FVG 21405.5-21409 open; from protected low 21380.5 (a sweep of overnight low 21381): holds; body 2.1x prior; leg 4 bars, efficiency 0.74, overlap 0.31.');
  const weak = base({ displaced: false, why: ['closed mid', 'small'], bodyX: 2.4, fvg: null, fvgPending: true, status: { closedBack: { at: 'x', barsAgo: 1 } }, origin: { side: 'low', price: 21380.5, at: 'x', sweep: null } });
  const wl = D.breakLine({ entry: { tf: '3m', brk: { ...weak, kind: 'CHoCH', barsAgo: 0 }, minutes: 3 } });
  // A body 2.4x prior beside `weak` would read as a contradiction (M3): the number prints only when it agrees with the word.
  assert.strictEqual(wl, '- Break quality (strength, not a forecast; `displacement`): 3m CHoCH up 21412.25 this bar: weak (closed mid, small), closed back below 21412.25 3 min ago; cleared 0.6 ATR; no FVG yet; from protected low 21380.5: holds; leg 4 bars, efficiency 0.74, overlap 0.31.');
  const filled = base({ fvg: { side: 'bullish', low: 1, high: 2, at: 'x', state: 'filled' } });
  assert.match(D.breakLine({ entry: { tf: '3m', brk: filled, minutes: 3 } }), /FVG 1-2 filled \(traded through\);/);
  const part = base({ fvg: { side: 'bullish', low: 1, high: 2, at: 'x', state: 'filled to', to: 1.5 } });
  assert.match(D.breakLine({ entry: { tf: '3m', brk: part, minutes: 3 } }), /FVG 1-2 filled to 1\.5;/);
  assert.match(D.breakLine({ entry: { tf: '3m', brk: base({ fvg: null }), minutes: 3 } }), /; no FVG;/);
  const down = { ...base(), direction: 'down', quality: { ...base().quality, status: { closedBack: { at: 'x', barsAgo: 0 } }, origin: { side: 'high', price: 21440, at: 'x', sweep: null } } };
  assert.match(D.breakLine({ entry: { tf: '3m', brk: down, minutes: 3 } }), /closed back above 21412\.25 this bar; .*from protected high 21440: holds/);
});

test('breakLine: a broken protected swing prints the invalidating close\'s strength (displaced or weak, with why); the words never say confirmed', () => {
  const brk = { ...base(), protected: { side: 'low', level: 21380.5, at: 'x', brokenAt: 'y', quality: { displaced: false, why: ['wicks'], barsAgo: 1 } } };
  const line = D.breakLine({ entry: { tf: '3m', brk, minutes: 3 } });
  assert.match(line, /from protected low 21380\.5 \(a sweep of overnight low 21381\): broken by a weak close \(wicks\) 3 min ago;/);
  const strong = { ...brk, protected: { ...brk.protected, quality: { displaced: true, why: [], barsAgo: 0 } } };
  assert.match(D.breakLine({ entry: { tf: '3m', brk: strong, minutes: 3 } }), /broken by a displaced close this bar;/);
  for (const l of [line, D.breakLine({ entry: { tf: '3m', brk: strong, minutes: 3 } })]) assert.doesNotMatch(l, /confirm/i);
});

test('breakLine: recency from config (recentEntry candles, recentSetup 15m candles); a stale break prints nothing; the setup frame names its close', () => {
  const p = { ...D.PARAMS, recentEntry: 6, recentSetup: 2 };
  assert.strictEqual(D.breakLine({ entry: { tf: '3m', brk: { ...base(), barsAgo: 7 }, minutes: 3 } }, { p }), null);
  assert.ok(D.breakLine({ entry: { tf: '3m', brk: { ...base(), barsAgo: 6 }, minutes: 3 } }, { p }));
  const setupBrk = { ...base(), kind: 'CHoCH', barsAgo: 1, knownAt: '2026-03-02T15:15:00.000Z' };
  const both = D.breakLine({ entry: { tf: '3m', brk: { ...base(), barsAgo: 9 }, minutes: 3 }, setup: { tf: '15m', brk: setupBrk, minutes: 15 } }, { p, et: () => '10:15' });
  assert.match(both, /: 15m CHoCH up 21412\.25 \(closed 10:15\): displaced/);
  // The setup frame's times are its candles' closes, never "N min ago" or "this bar" (a 15m candle is no 3m bar).
  const back = { ...setupBrk, quality: { ...setupBrk.quality, status: { closedBack: { at: '2026-03-02T15:30:00.000Z', closedAt: '2026-03-02T15:45:00.000Z', barsAgo: 0 } } } };
  const sb = D.breakLine({ setup: { tf: '15m', brk: back, minutes: 15 } }, { p, et: t => (t === '2026-03-02T15:45:00.000Z' ? '10:45' : '?') });
  assert.match(sb, /15m CHoCH up 21412\.25 \(closed \?\): displaced, closed back below 21412\.25 at 10:45;/);
  assert.doesNotMatch(sb, /this bar|min ago/);
  assert.doesNotMatch(both, /3m BOS/, 'the stale 3m break is not printed');
  assert.strictEqual(D.breakLine({ entry: { tf: '3m', brk: null, minutes: 3 }, setup: { tf: '15m', brk: { ...setupBrk, barsAgo: 3 }, minutes: 15 } }, { p }), null);
  assert.strictEqual(D.breakLine({ entry: { tf: '3m', brk: { kind: 'BOS', direction: 'up', level: 1, barsAgo: 0 }, minutes: 3 } }, { p }), null, 'no quality: nothing to print');
});

test('breakLine: over lineBytes it cuts body, then leg, then the setup frame, then the sweep note, keeping strength, status and cleared', () => {
  const worst = q2 => ({ ...base({ displaced: false, why: ['opposite colour', 'wicks', 'closed mid', 'small'], bodyX: 0.4, status: { closedBack: { at: 'x', barsAgo: 5 } }, fvg: { side: 'bearish', low: 21405.25, high: 21409.75, at: 'x', state: 'filled to', to: 21407.75 }, origin: { side: 'high', price: 21480.75, at: 'x', sweep: { name: 'prior session high', price: 21481.25 } }, ...q2 }), kind: 'CHoCH', direction: 'down', level: 21450.25, barsAgo: 5, protected: { side: 'high', level: 21480.75, at: 'x', brokenAt: 'y', quality: { displaced: false, why: ['opposite colour', 'wicks', 'closed mid', 'small'], barsAgo: 0 } } });
  const parts = { entry: { tf: '3m', brk: worst(), minutes: 3 }, setup: { tf: '15m', brk: { ...worst(), barsAgo: 1, knownAt: 'z' }, minutes: 15 } };
  const full = D.breakLine(parts, { p: { ...D.PARAMS, lineBytes: 100000 }, et: () => '10:15' });
  const cap = D.PARAMS.lineBytes;
  const line = D.breakLine(parts, { et: () => '10:15' });
  assert.ok(Buffer.byteLength(full) > cap, 'the worst case is over the budget uncut');
  assert.ok(Buffer.byteLength(line) <= cap, `${Buffer.byteLength(line)} bytes over ${cap}`);
  assert.match(line, /3m CHoCH down 21450\.25 15 min ago: weak \(opposite colour, wicks, closed mid, small\), closed back above 21450\.25 15 min ago; cleared 0\.6 ATR;/);
  // The order: body first, then leg.
  const at = n => D.breakLine(parts, { p: { ...D.PARAMS, lineBytes: n }, et: () => '10:15' });
  const noBody = full.replace(/; body 0\.4x prior/g, '');
  assert.strictEqual(at(Buffer.byteLength(noBody)), noBody, 'body goes first');
  const noLeg = noBody.replace(/; leg 4 bars, efficiency 0\.74, overlap 0\.31/g, '');
  assert.strictEqual(at(Buffer.byteLength(noLeg)), noLeg, 'then leg');
  assert.doesNotMatch(at(Buffer.byteLength(noLeg) - 1), /15m CHoCH/, 'then the setup frame');
  assert.match(at(Buffer.byteLength(noLeg) - 1), /cleared 0\.6 ATR/, 'cleared kept');
});

test('PARAMS: every number from config (config/analysis.json displacement and cisd)', () => {
  for (const k of ['bodyPrior', 'recentEntry', 'recentSetup', 'lineBytes']) assert.strictEqual(D.PARAMS[k], AN.displacement[k], k);
  assert.strictEqual(D.PARAMS.minBody, AN.cisd.minBody);
  assert.strictEqual(D.PARAMS.minRangeAtr, AN.cisd.minRangeAtr);
});
