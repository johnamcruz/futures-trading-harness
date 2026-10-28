'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const T = require('../../scripts/lib/trading/trend-declared');
const B = require('../../scripts/lib/trading/briefing');
const ind = require('../../scripts/lib/trading/indicators');
const { dayContextSeries } = require('../../scripts/lib/trading/day-context');
const { RTH_OPEN_MIN, RTH_CLOSE_MIN } = require('../../scripts/lib/trading/clock');
const { readBarsArg } = require('../../scripts/lib/backtest/data');

const BARS = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
// An RTH bar: 15:57 ET on 2026-04-27 (the 1354th bar), and one in the Globex session (22:15 ET on 2026-04-26).
const RTH_N = 1354;
const GLOBEX_N = 1000;

// Hand-worked: ATR 10, price 21510, RTH VWAP 15 points under price (+1.5 ATR up), EMA20 21515, RTH open 21480,
// overnight 21400-21500 (price 10 above its high).
const BASE = { price: 21510, atr: 10, vwapAtr: 1.5, ema20: 21515, open: 21480, overnight: { high: 21500, low: 21400 }, regime: 'trend-up' };

test('declaredFacts: side-signed in ATR, the short the long\'s mirror', () => {
  const d = T.declaredFacts(BASE);
  assert.deepStrictEqual(d.long, { vwapAtr: 1.5, ema20Atr: -0.5, overnight: 'broke out its way', dayMoveAtr: 3, regime: 'with' });
  assert.deepStrictEqual(d.short, { vwapAtr: -1.5, ema20Atr: 0.5, overnight: 'broke out against', dayMoveAtr: -3, regime: 'against' });
  // ATR units: the same points over twice the ATR are half the distance.
  const wide = T.declaredFacts({ ...BASE, atr: 20, vwapAtr: 0.75 });
  assert.deepStrictEqual([wide.long.ema20Atr, wide.long.dayMoveAtr, wide.long.vwapAtr], [-0.25, 1.5, 0.75]);
  // A down regime is the short's; range and transition are named for both.
  const down = T.declaredFacts({ ...BASE, regime: 'trend-down' });
  assert.deepStrictEqual([down.long.regime, down.short.regime], ['against', 'with']);
  for (const r of ['range', 'transition']) assert.deepStrictEqual([T.declaredFacts({ ...BASE, regime: r }).long.regime, T.declaredFacts({ ...BASE, regime: r }).short.regime], [r, r]);
});

test('declaredFacts: the overnight range by side: broke out, else the third inside it, front the side\'s edge', () => {
  const on = { high: 21500, low: 21400 };
  const at = (price, side) => T.overnightPlace(price, on, side);
  // At the edge it heads to counts as broke out; beyond the back edge is against.
  assert.deepStrictEqual([at(21500, 'long'), at(21400, 'short'), at(21399.75, 'long'), at(21500.25, 'short')], ['broke out its way', 'broke out its way', 'broke out against', 'broke out against']);
  // Inside: thirds of the range from the side's back edge (a long's back is the low, a short's the high).
  assert.deepStrictEqual([at(21400, 'long'), at(21420, 'long'), at(21450, 'long'), at(21480, 'long')], ['back third', 'back third', 'middle third', 'front third']);
  assert.deepStrictEqual([at(21480, 'short'), at(21450, 'short'), at(21420, 'short')], ['back third', 'middle third', 'front third']);
  // No range (missing, or no width): unknown.
  assert.deepStrictEqual([T.overnightPlace(21450, null, 'long'), T.overnightPlace(21450, { high: 21400, low: 21400 }, 'long')], [null, null]);
});

test('declaredFacts: unknown inputs are null, never a guess; no ATR or price is no facts', () => {
  assert.strictEqual(T.declaredFacts({ ...BASE, atr: 0 }), null);
  assert.strictEqual(T.declaredFacts({ ...BASE, atr: null }), null);
  assert.strictEqual(T.declaredFacts({ ...BASE, price: NaN }), null);
  const d = T.declaredFacts({ price: 21510, atr: 10 });
  assert.deepStrictEqual(d.long, { vwapAtr: null, ema20Atr: null, overnight: null, dayMoveAtr: null, regime: null });
});

test('declaredLine: both sides with their signs, in the timeframe\'s ATR; none without the RTH VWAP', () => {
  const line = T.declaredLine(T.declaredFacts(BASE), '3m');
  assert.strictEqual(line, '- Trend declared? (in 3m ATR(14), + = the side\'s way; `trend-vs-range`): long RTH VWAP +1.5, EMA20 -0.5, overnight range broke out its way, day\'s move +3, regime with; short RTH VWAP -1.5, EMA20 +0.5, overnight range broke out against, day\'s move -3, regime against.');
  assert.match(T.declaredLine(T.declaredFacts({ ...BASE, overnight: null, regime: null })), /overnight range \?, day's move \+3, regime \?;/);
  assert.strictEqual(T.declaredLine(T.declaredFacts({ ...BASE, vwapAtr: null })), null);
  assert.strictEqual(T.declaredLine(null), null);
});

test('briefing: m3.declared at an RTH bar is the causal series\' values at that bar (closed bars only), in the summary once', () => {
  const bars = BARS.slice(0, RTH_N);
  const k = bars.length - 1;
  const b = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3 });
  const d = b.sections.m3.data.declared;
  // The same series over the whole fixture, read at bar k: a value at k reads bars 0..k only, so nothing after k moved it.
  const atr = ind.atr(BARS, ind.ATR_PERIOD)[k];
  const ema20 = ind.ema(BARS.map(x => x.c), 20)[k];
  const vwap = ind.anchoredVwap(BARS, RTH_OPEN_MIN, RTH_CLOSE_MIN)[k];
  const day = dayContextSeries(BARS).day[k];
  const c = BARS[k].c;
  const near = (x, y, label) => assert.ok(Math.abs(x - y) <= 0.01, `${label}: ${x} vs ${y}`);
  near(d.long.vwapAtr, (c - vwap) / atr, 'vwap');
  near(d.long.ema20Atr, (c - ema20) / atr, 'ema20');
  near(d.long.dayMoveAtr, (c - day.open) / atr, 'day move');
  assert.strictEqual(d.long.overnight, T.overnightPlace(c, day.overnight, 'long'));
  assert.strictEqual(d.short.overnight, T.overnightPlace(c, day.overnight, 'short'));
  for (const f of ['vwapAtr', 'ema20Atr', 'dayMoveAtr']) assert.strictEqual(d.short[f], -d.long[f] || 0, f);
  // The VWAP distance is the VWAP line's own value (one value per fact).
  assert.strictEqual(Math.abs(d.long.vwapAtr), Math.abs(b.sections.m3.data.vwap.distanceAtr));
  assert.strictEqual(d.long.regime === 'with', b.sections.m3.data.regime.primary === 'trend-up');
  const text = B.renderBriefing(b, { now: new Date(b.closedAt) });
  const lines = text.split('\n').filter(l => l.startsWith('- Trend declared? '));
  assert.deepStrictEqual(lines, [T.declaredLine(d, '3m')]);
  // In the summary only: the detail leaves it out.
  assert.ok(!/^ {2}declared: /m.test(text));
  // Its bytes: one line, at most 400.
  assert.ok(Buffer.byteLength(lines[0]) <= 400, `${Buffer.byteLength(lines[0])} bytes`);
});

test('briefing: no declared facts outside RTH or on a frame (a session fact, the runner\'s bars only)', () => {
  const g = B.buildBriefing({ symbol: 'NQ', bars: BARS.slice(0, GLOBEX_N), minutes: 3 });
  assert.strictEqual(g.sections.m3.data.declared, null);
  assert.doesNotMatch(B.renderBriefing(g, { now: new Date(g.closedAt) }), /Trend declared\?/);
  const bars = BARS.slice(0, RTH_N);
  const first = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3 });
  const f = B.buildFrameBriefing({ symbol: 'NQ', bars: B.wholeBars(bars, 15), minutes: 15, first });
  assert.ok(!('declared' in f.sections.bar.data));
  assert.doesNotMatch(B.renderFrameBriefing(f, first, { now: new Date(f.closedAt) }), /Trend declared\?/);
});
