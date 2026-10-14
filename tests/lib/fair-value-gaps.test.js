'use strict';

// A fair value gap needs a strong displacement middle candle (market-snapshot.js fvgAt / fairValueGaps): the CISD
// strength rule (cisd.js strongCandle), the gap's way, against ATR(14) as known at the middle bar; causal (the gap is
// known when its third bar completes).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { fvgAt, fairValueGaps } = require('../../scripts/lib/trading/market-snapshot');
const cisd = require('../../scripts/lib/trading/cisd');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { normalizeBars, atr: atrOf } = require('../../scripts/lib/trading/indicators');

const t = k => new Date(Date.UTC(2026, 9, 7, 14, 3 * k)).toISOString();
const K = (k, o, h, l, c) => ({ t: t(k), o, h, l, c, v: 1 });
// A bullish gap 10-12 around middle bar `m`: bar 0 (up-closing, so nothing engulfs it) high 10, bar 2 low 12.
const up = (m, first = K(0, 9.5, 10, 9, 9.75)) => [first, { ...m, t: t(1) }, K(2, 12.5, 13, 12, 12.75)];
const ones = (v = 1) => [v, v, v];
const at3 = bars => fvgAt(bars, 2, ones());

test('a strong middle candle the gap\'s way makes an FVG; a doji or small-bodied one does not', () => {
  assert.deepStrictEqual(at3(up(K(1, 10, 13, 10, 12.75))), { side: 'bullish', low: 10, high: 12, at: t(1) });
  assert.strictEqual(at3(up(K(1, 11, 13, 9.5, 11))), null, 'a doji middle candle');
  assert.strictEqual(at3(up(K(1, 10.5, 13, 10, 11))), null, 'a small body (1/6 of the range)');
  assert.strictEqual(at3(up(K(1, 9, 15, 9, 12.75))), null, 'body 0.625 but a close mid-range (not in the upper third)');
});

test('a middle candle in the wrong direction is no FVG, either way', () => {
  assert.strictEqual(at3(up(K(1, 13, 13.25, 9.75, 10))), null, 'a strong DOWN candle inside a bullish gap');
  // The bearish mirror: bar 0 low 14, bar 2 high 12.
  const down = m => [K(0, 14.25, 15, 14, 14.5), { ...m, t: t(1) }, K(2, 11.5, 12, 11, 11.25)];
  assert.deepStrictEqual(fvgAt(down(K(1, 14, 14, 11, 11.25)), 2, ones()), { side: 'bearish', low: 12, high: 14, at: t(1) });
  assert.strictEqual(fvgAt(down(K(1, 11, 14.25, 11, 14)), 2, ones()), null, 'a strong UP candle inside a bearish gap');
});

test('the thresholds: body exactly 0.6 of the range counts, less does not; range exactly 1.0 x ATR counts, less does not', () => {
  const m = K(1, 12, 15, 10, 15); // body 3 of range 5: exactly 0.6; close at the high
  assert.ok(at3(up(m)));
  assert.strictEqual(at3(up(K(1, 12.25, 15, 10, 15))), null, 'body 2.75 / 5 = 0.55');
  assert.ok(fvgAt(up(m), 2, ones(5)), 'range 5 = 1.0 x ATR 5');
  assert.strictEqual(fvgAt(up(m), 2, ones(5.25)), null, 'range 5 < ATR 5.25 (and engulfing nothing)');
  assert.strictEqual(fvgAt(up(m), 2, [NaN, NaN, NaN]), null, 'no ATR yet and no engulfing: not strong');
});

test('the close in the extreme third: exactly at 2/3 of the range counts, just below does not, either way', () => {
  assert.ok(at3(up(K(1, 9, 15, 9, 13))), 'close 4 of range 6 above the low: exactly 2/3 (body 0.67)');
  assert.strictEqual(at3(up(K(1, 9, 15, 9, 12.75))), null, 'close 3.75 of 6: 0.625 (body 0.625)');
  const down = m => [K(0, 14.25, 15, 14, 14.5), { ...m, t: t(1) }, K(2, 11.5, 12, 11, 11.25)];
  assert.ok(fvgAt(down(K(1, 15, 15, 9, 11)), 2, ones()), 'close 4 of range 6 below the high: exactly 2/3');
  assert.strictEqual(fvgAt(down(K(1, 15, 15, 9, 11.25)), 2, ones()), null, 'close 3.75 of 6 below the high');
});

test('fvgAt without an ATR series computes ATR(14) of the bars itself, as fairValueGaps does', () => {
  const bars = normalizeBars(readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'))).slice(0, 400);
  const atr = atrOf(bars, 14);
  let gaps = 0;
  for (let j = 2; j < bars.length; j += 1) {
    const g = fvgAt(bars, j);
    assert.deepStrictEqual(g, fvgAt(bars, j, atr), `bar ${j}`);
    if (g) gaps += 1;
  }
  assert.ok(gaps > 0);
});

test('an engulfing middle candle counts even when its range is under ATR; the ATR read is the middle bar\'s', () => {
  const m = K(1, 9.25, 13, 9.25, 12.75); // range 3.75, body 3.5
  const bearFirst = K(0, 10, 10, 9, 9.25); // a bearish body 9.25-10, which the middle body covers
  assert.ok(fvgAt(up(m, bearFirst), 2, ones(100)), 'engulfing, range far under ATR');
  assert.strictEqual(fvgAt(up(m), 2, ones(100)), null, 'the same candle after an up-closing bar engulfs nothing');
  assert.ok(fvgAt(up(m), 2, [100, 1, 100]), 'ATR at the middle bar (1) is the one read');
  assert.strictEqual(fvgAt(up(m), 2, [1, 100, 1]), null, 'not the first bar\'s or the third\'s');
});

test('the identical rule as the CISD confirming candle: fvgAt holds exactly where cisd.displacementOf is strong', () => {
  const bars = normalizeBars(readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv')));
  const atr = atrOf(bars, 14);
  let gaps = 0;
  let weak = 0;
  for (let j = 2; j < bars.length; j += 1) {
    const dir = bars[j - 2].h < bars[j].l ? 1 : bars[j - 2].l > bars[j].h ? -1 : 0;
    if (!dir) { assert.strictEqual(fvgAt(bars, j, atr), null); continue; }
    const strong = cisd.displacementOf(bars, j - 1, dir, atr).strong;
    assert.strictEqual(Boolean(fvgAt(bars, j, atr)), strong, `bar ${j}`);
    if (strong) gaps += 1; else weak += 1;
  }
  assert.ok(gaps > 0 && weak > 0, `the fixture has both strong (${gaps}) and weak-middle (${weak}) gaps`);
});

/** What fairValueGaps must say at bar `i` from the full series: each gap of the last 60 bars, filled by bars to i only. */
function expected(full, atr, i) {
  const open = [];
  const partly = [];
  for (let j = Math.max(2, i + 1 - 60); j <= i; j += 1) {
    const g = fvgAt(full, j, atr);
    if (!g) continue;
    const later = full.slice(j + 1, i + 1);
    if (g.side === 'bullish') {
      const deepest = Math.min(Infinity, ...later.map(b => b.l));
      if (deepest >= g.high) open.push(g);
      else if (deepest > g.low) partly.push({ side: 'bullish', low: g.low, high: deepest, gapLow: g.low, gapHigh: g.high, at: g.at });
    } else {
      const highest = Math.max(-Infinity, ...later.map(b => b.h));
      if (highest <= g.low) open.push(g);
      else if (highest < g.high) partly.push({ side: 'bearish', low: highest, high: g.high, gapLow: g.low, gapHigh: g.high, at: g.at });
    }
  }
  return { open, partly };
}

const nq = normalizeBars(readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv')));
const rty = normalizeBars(readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'RTY-3m.csv')));
for (const [label, bars] of [['NQ-3m', nq], ['RTY-3m', rty], ['NQ-3m with a bar in seven missing', nq.filter((_, i) => i % 7 !== 3)]]) {
  test(`causal on ${label}: at every bar the FVGs from the bars so far equal the full series' cut there`, () => {
    const atr = atrOf(bars, 14);
    let seen = 0;
    for (let i = 2; i < bars.length; i += 1) {
      const cut = bars.slice(0, i + 1);
      assert.deepStrictEqual(fvgAt(cut, i, atrOf(cut, 14)), fvgAt(bars, i, atr), `${label}: the gap at ${i}`);
      const got = fairValueGaps(cut);
      assert.deepStrictEqual(got, expected(bars, atr, i), `${label}: the gaps at ${i}`);
      seen += got.open.length + got.partly.length;
    }
    assert.ok(seen > 0, `${label}: the fixture has gaps`);
  });
}
