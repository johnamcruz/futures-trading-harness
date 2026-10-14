'use strict';

// Fair value gaps per timeframe (scripts/lib/trading/fvg-frames.js; docs/COMPOSED-ENTRY.md section 8, item 3): the
// strong-middle-candle rule on each timeframe's completed candles, what is left of each gap, the last completed
// candle's retest, 5m from 1m bars only (never approximated from 3m), causality (as of a bar, the bars after it change
// nothing; a gap is a fact only once its third candle completes), and the bytes it adds to the rendered briefing.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const F = require('../../scripts/lib/trading/fvg-frames');
const CF = require('../../scripts/lib/trading/candle-facts');
const B = require('../../scripts/lib/trading/briefing');
const G = require('../fixtures/golden-bars');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { defaultRoundSteps } = require('../../scripts/lib/trading/round-numbers');

const MIN = 60000;
const T0 = Date.parse('2026-06-15T13:30:00Z'); // 09:30 ET

/** `step`-minute bars making the given candles of `per` bars each: open on the first, high and low inside, close on the last. */
function barsOf(candles, per = 5, step = 3) {
  const out = [];
  candles.forEach(([o, h, l, c], k) => {
    for (let i = 0; i < per; i += 1) {
      const t = new Date(T0 + (k * per + i) * step * MIN).toISOString();
      const first = i === 0;
      const lastBar = i === per - 1;
      const open = first ? o : (o + c) / 2;
      const close = lastBar ? c : (o + c) / 2;
      // The high on the second bar, the low on the third (per >= 3), so the candle's range is the given one.
      const hi = i === 1 ? h : Math.max(open, close);
      const lo = i === 2 ? l : Math.min(open, close);
      out.push({ t, o: open, h: hi, l: lo, c: close, v: 100 });
    }
  });
  return out;
}

const FLAT = Array.from({ length: 20 }, () => [100, 101, 99, 100.5]);
// A (high 101), M (a strong bullish candle, range 6 against an ATR about 2), C (low 103): a bullish gap 101-103.
const GAP = [[100, 101, 99, 100.5], [100.5, 106.25, 100.25, 106], [106, 107, 103, 106.5]];

test('a bullish gap on 15m candles: open when the third candle completes, no retest by its own third candle', () => {
  const b = barsOf([...FLAT, ...GAP]);
  const out = F.fvgFrames({ bars: b, base: 3, frames: [15] })['15m'];
  assert.deepStrictEqual(out, [{ side: 'bullish', low: 101, high: 103, at: new Date(T0 + 21 * 15 * MIN).toISOString(), state: 'open', retest: null }]);
  // One bar earlier the third candle is still forming: no gap yet.
  assert.deepStrictEqual(F.fvgFrames({ bars: b.slice(0, -1), base: 3, frames: [15] })['15m'], []);
});

test('the last completed candle\'s retest: closed out, closed inside; traded through is filled and dropped', () => {
  const out = d => F.fvgFrames({ bars: barsOf([...FLAT, ...GAP, d]), base: 3, frames: [15] })['15m'];
  // Into the gap to 102.5, closed back above it: partly filled, retested and closed out.
  assert.deepStrictEqual(out([106.5, 107, 102.5, 104]).map(g => [g.state, g.unfilled, g.retest]), [['partly', [101, 102.5], 'closed out']]);
  // Closed inside it.
  assert.deepStrictEqual(out([106.5, 107, 102.25, 102.75]).map(g => [g.state, g.unfilled, g.retest]), [['partly', [101, 102.25], 'closed inside']]);
  // Never reached: open, no retest.
  assert.deepStrictEqual(out([106.5, 108, 104, 107.5]).map(g => [g.state, g.retest]), [['open', null]]);
  // Traded through its low: filled, gone.
  assert.deepStrictEqual(out([106.5, 107, 100.75, 104]), []);
});

test('the strong-middle-candle rule: a weak middle candle makes no gap; a bearish gap is the mirror', () => {
  // The middle candle closes mid-range (body 0.5): no displacement, no gap.
  const weak = [[100, 101, 99, 100.5], [100.5, 106.25, 100.25, 103.25], [103.25, 107, 103, 106.5]];
  assert.deepStrictEqual(F.fvgFrames({ bars: barsOf([...FLAT, ...weak]), base: 3, frames: [15] })['15m'], []);
  const bear = [[100, 101, 99, 99.5], [99.5, 99.75, 93.75, 94], [94, 97, 93, 93.5], [93.5, 98, 93, 96]];
  const g = F.fvgFrames({ bars: barsOf([...FLAT, ...bear]), base: 3, frames: [15] })['15m'];
  assert.deepStrictEqual(g.map(x => [x.side, x.low, x.high, x.state, x.unfilled, x.retest]), [['bearish', 97, 99, 'partly', [98, 99], 'closed out']]);
});

test('5m: from 1m bars only, never from 3m bars; the candles are the briefing\'s own', () => {
  const b3 = barsOf([...FLAT, ...GAP]);
  assert.match(F.fvgFrames({ bars: b3, base: 3, frames: [5] })['5m'], /^unavailable \(not whole 3m bars; no 1m bars configured\)$/);
  // The same candles as 5m candles on 1m bars (5 bars each).
  // 24 candles, so the last closes on the 3m and 5m grids (11:30 ET).
  const b1 = barsOf([...FLAT, ...GAP, [106.5, 108, 104, 107.5]], 5, 1);
  const last = Date.parse(b1[b1.length - 1].t) + MIN;
  // 3m base bars closing with the last 1m bar.
  const base = Array.from({ length: 4 }, (_, i) => ({ t: new Date(last - (4 - i) * 3 * MIN).toISOString(), o: 106, h: 107, l: 105, c: 106.5, v: 1 }));
  const g = F.fvgFrames({ bars: base, base: 3, fine: b1, frames: [5] })['5m'];
  assert.deepStrictEqual(g.map(x => [x.side, x.low, x.high, x.state]), [['bullish', 101, 103, 'open']]);
  const c = CF.completedCandlesAt({ bars: base, base: 3, fine: b1, minutes: 5 });
  const bc = CF.briefingCandles({ bars: base, base: 3, fine: b1, timeframes: [5] })['5m'];
  assert.deepStrictEqual([c.candles[c.j].t, c.candles[c.j].closedAt], [bc.t, bc.closedAt], 'the briefing\'s 5m candle');
  // 1m bars that stopped: no current 5m candle, so none read.
  assert.match(F.fvgFrames({ bars: base, base: 3, fine: b1.slice(0, -12), frames: [5] })['5m'], /the 1m bars stop at/);
});

test('three candles not back to back (a feed gap, the daily break, a weekend): no gap', () => {
  // A, M, then a missing candle, then C: C's low over A's high, but price never traded between them.
  const b = barsOf([...FLAT, GAP[0], GAP[1], [106, 106.5, 105.5, 106], GAP[2]]);
  const cut = b.filter((_, i) => i < 22 * 5 || i >= 23 * 5);
  assert.deepStrictEqual(F.fvgFrames({ bars: cut, base: 3, frames: [15] })['15m'], []);
  // With the candle in between, A, M and it are back to back: that one is a gap.
  assert.deepStrictEqual(F.fvgFrames({ bars: b, base: 3, frames: [15] })['15m'].map(x => [x.low, x.high]), [[101, 105.5]]);
});

test('fvgLine: event-driven: only the gaps retested or near price; open, filled to, the retest; null when none qualifies', () => {
  const et = x => x.slice(11, 16);
  const fvgs = { '5m': 'unavailable (not whole 3m bars; no 1m bars configured)', '15m': [
    { side: 'bullish', low: 101, high: 103, at: '2026-06-15T18:45:00.000Z', state: 'partly', unfilled: [101, 102.5], retest: 'closed out' },
    { side: 'bearish', low: 97, high: 99, at: '2026-06-15T19:00:00.000Z', state: 'partly', unfilled: [98, 99], retest: null },
    { side: 'bearish', low: 120, high: 122, at: '2026-06-15T19:15:00.000Z', state: 'open', retest: null },
  ], '1h': [] };
  // Price 100, near 2.5 points: the retested one, the one 1 point away (its unfilled part 98-99); not the far one.
  assert.strictEqual(F.fvgLine(fvgs, et, { price: 100, near: 2.5 }), '- FVGs near price or retested (completed candles): 15m bullish 101-103 (18:45) filled to 102.5, retest closed out, bearish 97-99 (19:00) filled to 98.');
  // Nearer than 1 point: only the retest; with no price, only the retest.
  assert.match(F.fvgLine(fvgs, et, { price: 100, near: 0.5 }), /: 15m bullish 101-103 \(18:45\) filled to 102\.5, retest closed out\.$/);
  assert.match(F.fvgLine(fvgs, et), /retest closed out\.$/);
  // Nothing retested or near: no line (the JSON holds every gap); 1m bars that stopped are named.
  assert.strictEqual(F.fvgLine({ '15m': [fvgs['15m'][2]], '1h': [] }, et, { price: 100, near: 2.5 }), null);
  assert.strictEqual(F.fvgLine({ '5m': 'unavailable (the 1m bars stop at x: no current 5m candle)' }), '- FVGs near price or retested (completed candles): 5m unavailable (the 1m bars stop at x: no current 5m candle).');
  assert.strictEqual(F.fvgLine(null), null);
});

const BARS = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));

test('causality: as of each bar, the same gaps as the bars cut at its close; later bars change nothing', () => {
  const full = BARS.slice(0, 1500);
  let seen = 0;
  for (let i = 400; i < full.length; i += 37) {
    const at = F.fvgFrames({ bars: full, base: 3, at: i });
    assert.deepStrictEqual(at, F.fvgFrames({ bars: full.slice(0, i + 1), base: 3 }), `bar ${i}`);
    for (const tf of ['15m', '1h']) {
      for (const g of at[tf]) {
        seen += 1;
        // Known only once its third candle closed: the middle candle opened at least two candles before this close.
        const step = (tf === '1h' ? 60 : 15) * MIN;
        assert.ok(Date.parse(g.at) + 2 * step <= Date.parse(full[i].t) + 3 * MIN, `${tf} gap at ${g.at}, bar ${i}`);
      }
    }
  }
  assert.ok(seen > 0, 'the fixture has gaps');
});

// The bytes the FVG line adds to the rendered briefing (the detail leaves it out): on the fixture with a 1m lane's bars at
// every 25th bar, and the worst case, nine gaps all partly filled, retested, and dated (another ET day).
const FVG_RENDER_BUDGET = 600;
const FVG_TYPICAL_BUDGET = 120;
const FVG_WORST_BUDGET = 820;

test('the briefing\'s fvgs: per timeframe, at most MAX each; the line within FVG_RENDER_BUDGET bytes on any bar, FVG_TYPICAL_BUDGET on average', () => {
  const brief = B.buildBriefing({ symbol: 'NQ', bars: BARS, minutes: 3, roundSteps: defaultRoundSteps() });
  const d = brief.sections.m3.data;
  assert.deepStrictEqual(Object.keys(d.fvgs), ['5m', '15m', '1h']);
  assert.match(d.fvgs['5m'], /^unavailable/);
  for (const tf of ['15m', '1h']) assert.ok(Array.isArray(d.fvgs[tf]) && d.fvgs[tf].length <= F.MAX, tf);
  assert.deepStrictEqual(d.fvgs, F.fvgFrames({ bars: BARS, base: 3 }));
  const added = b => {
    const now = new Date(b.closedAt);
    const without = JSON.parse(JSON.stringify(b));
    delete without.sections.m3.data.fvgs;
    return Buffer.byteLength(B.renderBriefing(b, { now })) - Buffer.byteLength(B.renderBriefing(without, { now }));
  };
  assert.ok(added(brief) <= FVG_RENDER_BUDGET, `${added(brief)} bytes added`);
  const fine = G.toMinutes(BARS);
  const sizes = [];
  for (let i = 400; i < BARS.length; i += 25) sizes.push(added(B.buildBriefing({ symbol: 'NQ', bars: BARS.slice(0, i + 1), minutes: 3, fineBars: fine, roundSteps: defaultRoundSteps() })));
  const most = Math.max(...sizes);
  const typical = sizes.reduce((x, y) => x + y, 0) / sizes.length;
  assert.ok(most <= FVG_RENDER_BUDGET, `${most} bytes added with 1m bars`);
  assert.ok(typical <= FVG_TYPICAL_BUDGET, `typical ${typical} bytes with 1m bars`);
  const g = { side: 'bullish', low: 27521.25, high: 27526.75, at: '2026-04-24T01:45:00.000Z', state: 'partly', unfilled: [27521.25, 27523.25], retest: 'closed inside' };
  const worst = F.fvgLine({ '5m': [g, g, g], '15m': [g, g, g], '1h': [g, g, g] }, x => `04-23 ${x.slice(11, 16)}`, { price: 27522, near: 10 });
  assert.ok(Buffer.byteLength(worst) + 1 <= FVG_WORST_BUDGET, `${Buffer.byteLength(worst)} bytes`);
});
