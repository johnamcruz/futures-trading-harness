'use strict';

// The open trade's read facts (trade-read.js): the pullback-vs-reversal read of an open trade, measured from its entry
// on closed bars only.
const test = require('node:test');
const assert = require('node:assert');
const { tradeRead, tradeReadLine, biasOf } = require('../../scripts/lib/trading/trade-read');

const START = Date.parse('2026-10-05T12:00:00.000Z'); // 08:00 ET (EDT): the bars hold the whole RTH session from its open
const STEP = 180000;
/** 3m bars from closes: open the previous close, high and low past the body. */
function mk(closes, { start = START, wick = 1 } = {}) {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    // The wick is longer on the close's side: a top (bottom) bar's high (low) stands above the next bar's.
    return { t: new Date(start + i * STEP).toISOString(), o, h: Math.max(o, c) + (c >= o ? wick : wick / 2), l: Math.min(o, c) - (c <= o ? wick : wick / 2), c, v: 100 };
  });
}
/** A zigzag up: `n` legs of `up` bars rising `rise` each, then `down` bars falling `fall` each. */
function zigzag(from, n, { up = 8, down = 4, rise = 2, fall = 1.5 } = {}) {
  const out = [];
  let p = from;
  for (let k = 0; k < n; k += 1) {
    for (let i = 0; i < up; i += 1) out.push((p += rise));
    for (let i = 0; i < down; i += 1) out.push((p -= fall));
  }
  return out;
}
const at = (bars, i) => bars[i].t;
// The mirror of a bar series around `m`: a short's view of a long's.
const mirror = (bars, m) => bars.map(b => ({ ...b, o: 2 * m - b.o, h: 2 * m - b.l, l: 2 * m - b.h, c: 2 * m - b.c }));

test('tradeRead: a long in a clean zigzag up: nothing against it, its pushes counted, depth measured, the trade\'s way positive', () => {
  const bars = mk(zigzag(21000, 6));
  const r = tradeRead({ side: 'long', entry: bars[12].c, openedAt: at(bars, 12), bars, base: 3 });
  assert.strictEqual(r.unavailable, undefined);
  assert.strictEqual(r.bars, bars.length - 12);
  assert.deepStrictEqual(r.against, { '3m': null, '15m': null });
  assert.strictEqual(r.displacement, null);
  assert.ok(r.pushes.length >= 3, `pushes ${r.pushes.length}`);
  assert.ok(r.pushes.every(p => p.sizeAtr > 0));
  // The series ends 4 bars into a pullback: depth is the share of the last impulse given back, between 0 and 1.
  assert.ok(r.pullback.depth > 0 && r.pullback.depth < 1, String(r.pullback.depth));
  assert.strictEqual(r.extreme.best, Math.max(...bars.slice(12).map(b => b.h)));
  assert.ok(r.ema20.distAtr > 0, 'the close above its EMA20, the trade\'s way');
  assert.ok(r.vwap.rth !== null && r.vwap.distAtr > 0, 'above the RTH VWAP');
});

test('tradeRead: a new extreme that closed back inside the best before it is a failed extreme; one that closed beyond held', () => {
  const closes = zigzag(21000, 4);
  const bars = mk(closes);
  const prior = Math.max(...bars.slice(10).map(b => b.h));
  const last = bars[bars.length - 1];
  // A bar trading 3 points past the prior best and closing back under it.
  const fail = [...bars, { t: new Date(Date.parse(last.t) + STEP).toISOString(), o: last.c, h: prior + 3, l: last.c - 1, c: prior - 2, v: 100 }];
  const r = tradeRead({ side: 'long', entry: bars[10].c, openedAt: at(bars, 10), bars: fail, base: 3 });
  assert.deepStrictEqual([r.extreme.failed.level, r.extreme.barsAgo, r.extreme.failed.barsAgo], [prior, 0, 0]);
  assert.match(tradeReadLine(r), /new extreme FAILED \(traded past [\d.]+, closed back inside, 0 bars ago\)/);
  const held = [...bars, { t: new Date(Date.parse(last.t) + STEP).toISOString(), o: last.c, h: prior + 3, l: last.c - 1, c: prior + 2, v: 100 }];
  assert.strictEqual(tradeRead({ side: 'long', entry: bars[10].c, openedAt: at(bars, 10), bars: held, base: 3 }).extreme.failed, false);
  // The first candle since entry made the best: no prior extreme to fail.
  const one = tradeRead({ side: 'long', entry: bars[7].c, openedAt: at(bars, bars.length - 1), bars, base: 3 });
  assert.strictEqual(one.extreme.failed, null);
});

test('tradeRead: a break down through the last swing low and a wide bearish candle are against a long, and through its swing', () => {
  const bars = mk(zigzag(21000, 5));
  const last = bars[bars.length - 1];
  const big = { t: new Date(Date.parse(last.t) + STEP).toISOString(), o: last.c, h: last.c + 0.25, l: last.c - 30.25, c: last.c - 30, v: 400 };
  const r = tradeRead({ side: 'long', entry: bars[12].c, openedAt: at(bars, 12), bars: [...bars, big], base: 3 });
  assert.strictEqual(r.against['3m'].direction, 'down');
  assert.strictEqual(r.against['3m'].barsAgo, 0);
  assert.deepStrictEqual([r.displacement.tf, r.displacement.barsAgo, r.displacement.throughSwing], ['3m', 0, true]);
  assert.ok(r.pullback.depth > 1, 'past the impulse origin');
  assert.ok(r.ema20.distAtr < 0, 'below its EMA20: against the long');
  // The same bars before the entry are no break "since entry": a break before the fill is not the trade's.
  const before = tradeRead({ side: 'long', entry: big.c, openedAt: big.t, bars: [...bars, big], base: 3 });
  assert.strictEqual(before.against['3m'].direction, 'down', 'it happened on the entry candle itself: since entry');
  const line = tradeReadLine(r);
  assert.match(line, /structure against since entry: 3m (?:BOS|CHoCH) down [\d.]+ 0 bars ago/);
  assert.match(line, /displacement against: 3m 0 bars ago, closed through the last swing [\d.]+/);
});

test('tradeRead: a short reads the mirror of a long (every fact side-signed)', () => {
  const bars = mk(zigzag(21000, 5));
  const last = bars[bars.length - 1];
  const all = [...bars, { t: new Date(Date.parse(last.t) + STEP).toISOString(), o: last.c, h: last.c + 0.25, l: last.c - 30.25, c: last.c - 30, v: 400 }];
  const long = tradeRead({ side: 'long', entry: bars[12].c, openedAt: at(bars, 12), bars: all, base: 3 });
  const short = tradeRead({ side: 'short', entry: 42000 - bars[12].c, openedAt: at(bars, 12), bars: mirror(all, 21000), base: 3 });
  assert.strictEqual(short.extreme.best, 42000 - long.extreme.best);
  assert.strictEqual(short.pullback.depth, long.pullback.depth);
  assert.deepStrictEqual(short.pushes.map(p => [p.sizeAtr, p.momentum]), long.pushes.map(p => [p.sizeAtr, p.momentum]));
  assert.strictEqual(short.against['3m'].direction, 'up');
  assert.strictEqual(short.displacement.throughSwing, true);
  assert.strictEqual(short.ema20.distAtr, long.ema20.distAtr);
});

test('tradeRead: pushes fade when the last is smaller than the one before with no more momentum candles', () => {
  // Three legs up, each shorter than the one before.
  const closes = [];
  let p = 21000;
  for (const n of [10, 6, 3]) {
    for (let i = 0; i < n; i += 1) closes.push((p += 2));
    for (let i = 0; i < 4; i += 1) closes.push((p -= 1.5));
  }
  const bars = mk(closes);
  const r = tradeRead({ side: 'long', entry: bars[0].c, openedAt: at(bars, 0), bars, base: 3 });
  assert.ok(r.pushes.length >= 2);
  assert.strictEqual(r.fading, true, JSON.stringify(r.pushes));
  assert.match(tradeReadLine(r), /: fading;/);
  // Growing legs do not fade.
  const g = [];
  p = 21000;
  for (const n of [3, 6, 10]) {
    for (let i = 0; i < n; i += 1) g.push((p += 2));
    for (let i = 0; i < 4; i += 1) g.push((p -= 1.5));
  }
  const gb = mk(g);
  assert.strictEqual(tradeRead({ side: 'long', entry: gb[0].c, openedAt: at(gb, 0), bars: gb, base: 3 }).fading, false);
});

test('tradeRead: the HTF bias at entry and now; a flip against the trade is flagged, its own way never', () => {
  // Five days up, then five days down: the 4h and 1h trends turn.
  const up = Array.from({ length: 2400 }, (_, i) => 20000 + i * 0.8 + (i % 7) * 0.25);
  const down = Array.from({ length: 2400 }, (_, i) => up[up.length - 1] - i * 0.8 - (i % 7) * 0.25);
  const bars = mk([...up, ...down], { start: Date.parse('2026-09-28T00:00:00.000Z') });
  const entryAt = 2000;
  const r = tradeRead({ side: 'long', entry: bars[entryAt].c, openedAt: at(bars, entryAt), bars, base: 3 });
  assert.strictEqual(r.bias.entry.dir, 'up');
  assert.ok(['4h', '1h'].includes(r.bias.entry.frame));
  assert.strictEqual(r.bias.now.dir, 'down');
  assert.strictEqual(r.bias.flipAgainst, true);
  assert.match(tradeReadLine(r), /HTF bias at entry (?:4h|1h) up, now (?:4h|1h) down \(FLIPPED against the trade\)/);
  // A short entered then: the bias turned its way, no flip against it.
  const s = tradeRead({ side: 'short', entry: bars[entryAt].c, openedAt: at(bars, entryAt), bars, base: 3 });
  assert.strictEqual(s.bias.flipAgainst, false);
  // The bias at entry reads only the bars closed by the fill: the same whatever came after.
  assert.deepStrictEqual(tradeRead({ side: 'long', entry: bars[entryAt].c, openedAt: at(bars, entryAt), bars: bars.slice(0, entryAt + 5), base: 3 }).bias.entry, r.bias.entry);
  assert.strictEqual(biasOf([]), null);
});

test('tradeRead: unavailable without a side, an entry, a fill time or a bar since the fill; the line says so', () => {
  const bars = mk(zigzag(21000, 2));
  assert.match(tradeRead({ side: 'flat', entry: 1, openedAt: at(bars, 0), bars, base: 3 }).unavailable, /no side/);
  assert.match(tradeRead({ side: 'long', entry: NaN, openedAt: at(bars, 0), bars, base: 3 }).unavailable, /no side, entry/);
  const late = new Date(Date.parse(bars[bars.length - 1].t) + STEP).toISOString();
  const r = tradeRead({ side: 'long', entry: 21000, openedAt: late, bars, base: 3 });
  assert.match(r.unavailable, /no closed bar since the fill/);
  assert.strictEqual(tradeReadLine(r), 'Trade read: unavailable (no closed bar since the fill yet).');
  assert.strictEqual(tradeReadLine(null), 'Trade read: unavailable (not computed).');
});

test('tradeRead: only the bars passed are read (no look-ahead): a decision\'s facts from the bars closed by it never change', () => {
  const bars = mk(zigzag(21000, 6));
  const k = 50;
  const a = tradeRead({ side: 'long', entry: bars[12].c, openedAt: at(bars, 12), bars: bars.slice(0, k), base: 3 });
  // Whatever came after bar k (here: a crash) changes nothing about the read at k.
  const crash = bars.map((b, i) => (i < k ? b : { ...b, o: b.o - 500, h: b.h - 500, l: b.l - 500, c: b.c - 500 }));
  assert.deepStrictEqual(tradeRead({ side: 'long', entry: bars[12].c, openedAt: at(bars, 12), bars: crash.slice(0, k), base: 3 }), a);
  assert.strictEqual(a.close, bars[k - 1].c);
});
