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

const FVG_RENDER_BUDGET = 700;

test('the briefing\'s fvgs: per timeframe, at most MAX each; within FVG_RENDER_BUDGET bytes of the rendered briefing', () => {
  const brief = B.buildBriefing({ symbol: 'NQ', bars: BARS, minutes: 3, roundSteps: defaultRoundSteps() });
  const d = brief.sections.m3.data;
  assert.deepStrictEqual(Object.keys(d.fvgs), ['5m', '15m', '1h']);
  assert.match(d.fvgs['5m'], /^unavailable/);
  for (const tf of ['15m', '1h']) assert.ok(Array.isArray(d.fvgs[tf]) && d.fvgs[tf].length <= F.MAX, tf);
  assert.deepStrictEqual(d.fvgs, F.fvgFrames({ bars: BARS, base: 3 }));
  const now = new Date(brief.closedAt);
  const without = JSON.parse(JSON.stringify(brief));
  delete without.sections.m3.data.fvgs;
  const added = Buffer.byteLength(B.renderBriefing(brief, { now })) - Buffer.byteLength(B.renderBriefing(without, { now }));
  assert.ok(added > 0 && added <= FVG_RENDER_BUDGET, `${added} bytes added`);
});
