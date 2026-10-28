'use strict';

// The open trade's read facts (trade-read.js): the pullback-vs-reversal read of an open trade, measured from its entry
// on closed bars only, its structure on the 15m frame the runner's own trail stands behind.
const test = require('node:test');
const assert = require('node:assert');
const { tradeRead, tradeReadLine, biasOf, SIGNS } = require('../../scripts/lib/trading/trade-read');

const START = Date.parse('2026-10-05T12:00:00.000Z'); // 08:00 ET (EDT): the bars hold the whole RTH session from its open
const STEP = 180000;
/** 3m bars from closes: open the previous close; the wick longer on the close's side. */
function mk(closes, { start = START, wick = 1 } = {}) {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: new Date(start + i * STEP).toISOString(), o, h: Math.max(o, c) + (c >= o ? wick : wick / 2), l: Math.min(o, c) - (c <= o ? wick : wick / 2), c, v: 100 };
  });
}
/** Legs from [bars, points per bar] pairs, from `from`. */
function legs(from, list) {
  const out = [];
  let p = from;
  for (const [n, d] of list) for (let i = 0; i < n; i += 1) out.push((p += d));
  return out;
}
// A trend up in 15m swings: four legs of 40 bars up 1 point, 20 bars down 1 point (each top above the last), then a dip.
const UP = [[40, 1], [20, -1], [40, 1], [20, -1], [40, 1], [20, -1], [40, 1], [4, -1]];
const at = (bars, i) => bars[i].t;
const mirror = (bars, m) => bars.map(b => ({ ...b, o: 2 * m - b.o, h: 2 * m - b.l, l: 2 * m - b.h, c: 2 * m - b.c }));
const EXIT = { trailBy: 'structure', swingMinutes: 15 }; // the policy's afterTarget plan, as the runner holds it
const read = (bars, o = {}) => tradeRead({ side: 'long', entry: bars[20].c, openedAt: at(bars, 20), bars, base: 3, tick: 0.25, exit: EXIT, ...o });

test('tradeRead: a long in a clean 15m trend up: pushes making new highs, nothing against it, healthy (no weakening, no reversal)', () => {
  const bars = mk(legs(21000, UP));
  const r = read(bars);
  assert.strictEqual(r.unavailable, undefined);
  assert.strictEqual(r.bars, bars.length - 20);
  assert.ok(r.pushes.length >= 2, `15m pushes ${r.pushes.length}`);
  assert.strictEqual(r.failed, false, 'each 15m push made a higher high');
  assert.deepStrictEqual([r.against['15m'], r.displacement, r.reversal], [null, null, null]);
  assert.strictEqual(r.weakening, false, r.signs.join(', '));
  assert.ok(r.pullback.depth > 0 && r.pullback.depth < 0.62, String(r.pullback.depth));
  assert.strictEqual(r.extreme.best, Math.max(...bars.slice(20).map(b => b.h)));
  // The runner's trail level: the last confirmed 15m swing low, the stop a tick under it.
  assert.ok(r.trail && r.trail.stop === r.trail.swing - 0.25 && r.trail.swing < r.close, JSON.stringify(r.trail));
  assert.match(tradeReadLine(r), /Weakening signs: [01] of 5[^;]*, 2 needed; reversal: none; tighten at most to the last confirmed 15m swing [\d.]+ \(stop [\d.]+, the runner's trail level\)\.$/);
});

test('tradeRead: a 15m push that fails to make a new high is the failed extreme (a lower high), never a 3m wick', () => {
  // The fourth leg tops 5 points under the third's.
  const bars = mk(legs(21000, [[40, 1], [20, -1], [40, 1], [20, -1], [15, 1], [20, -1], [5, 1]]));
  const r = read(bars);
  assert.ok(r.failed, JSON.stringify(r.pushes));
  assert.ok(r.failed.swing < r.failed.level);
  assert.ok(r.signs.includes('failed extreme'));
  assert.match(tradeReadLine(r), /15m push FAILED \(swing [\d.]+ short of [\d.]+\)/);
  // A 3m bar wicking past the best and closing back inside is no failed extreme: the 15m swings decide.
  const ok = mk(legs(21000, UP));
  const last = ok[ok.length - 1];
  const wick = [...ok, { t: new Date(Date.parse(last.t) + STEP).toISOString(), o: last.c, h: Math.max(...ok.map(b => b.h)) + 2, l: last.c - 1, c: last.c, v: 100 }];
  assert.strictEqual(read(wick).failed, false);
});

test('tradeRead: weakening needs two independent signs; one alone is a healthy pullback', () => {
  // Deep into a pullback (90% of the last impulse) without breaking the 15m swing low: a deep retrace (one sign however
  // many ways it shows: depth, below EMA20) and the 15m expansion down out of its box.
  const deep = mk(legs(21000, [[40, 1], [20, -1], [40, 1], [20, -1], [40, 1], [36, -1]]));
  const d = read(deep);
  assert.ok(d.pullback.depth > 0.618, String(d.pullback.depth));
  assert.deepStrictEqual(d.signs, ['deep retrace', 'compression against']);
  assert.strictEqual(d.weakening, true);
  assert.strictEqual(d.reversal, null, 'the 15m swing low still holds');
  // A shallow dip under the EMA20 is one sign at most: no weakening.
  const dip = mk(legs(21000, [[40, 1], [20, -1], [40, 1], [20, -1], [40, 1], [6, -1]]));
  const p = read(dip);
  assert.ok(p.signs.length < 2, p.signs.join(', '));
  assert.strictEqual(p.weakening, false);
  assert.deepStrictEqual(SIGNS, ['failed extreme', 'pushes fading', 'deep retrace', 'compression against', 'HTF flip']);
});

test('tradeRead: a 15m break down through the swing low is the reversal; a 3m CHoCH alone inside the 15m trend is not', () => {
  const bars = mk(legs(21000, [...UP.slice(0, 7), [60, -1.5]]));
  const r = read(bars);
  assert.strictEqual(r.against['15m'].direction, 'down');
  assert.match(r.reversal, /^15m (?:BOS|CHoCH) down$/);
  assert.match(tradeReadLine(r), /structure against since entry: 3m [^,]+, 15m (?:BOS|CHoCH) down [\d.]+ \d+ bars ago/);
  // A 3m CHoCH down in the last pullback, the 15m structure intact: no reversal.
  const pull = read(mk(legs(21000, UP)));
  assert.strictEqual(pull.reversal, null);
});

test('tradeRead: a 15m displacement candle through the swing low is a reversal fact, spent once a break the trade\'s way follows', () => {
  const base = legs(21000, UP.slice(0, 7));
  // One 15m candle (five 3m bars) falling 45 points from the top: a displacement through the last 15m swing low.
  const drop = legs(base[base.length - 1], [[5, -9]]);
  const bars = mk([...base, ...drop]);
  const r = read(bars);
  assert.deepStrictEqual([r.displacement.tf, r.displacement.barsAgo], ['15m', 0]);
  assert.ok(r.displacement.swing > r.close, 'closed through the last 15m swing low');
  assert.ok(r.reversal, 'a break or a displacement through the swing: a reversal');
  assert.match(tradeReadLine(r), /15m displacement against: 15m 0 bars ago, through the swing [\d.]+/);
  // Then price breaks back up through the swings: the displacement is spent (no stale fact).
  const back = mk([...base, ...drop, ...legs(drop[drop.length - 1], [[60, 1.5]])]);
  assert.strictEqual(read(back).displacement, null);
});

test('tradeRead: pushes fade when the last 15m push is smaller than the one before with no more momentum candles', () => {
  const bars = mk(legs(21000, [[60, 1], [20, -1], [40, 1], [20, -1], [25, 1], [20, -1], [5, 1]]));
  const r = read(bars);
  assert.ok(r.pushes.length >= 2, JSON.stringify(r.pushes));
  assert.strictEqual(r.fading, true, JSON.stringify(r.pushes));
  assert.match(tradeReadLine(r), /15m pushes [^;]*: fading;/);
  const grow = read(mk(legs(21000, [[20, 1], [20, -1], [40, 1], [20, -1], [60, 1], [20, -1], [5, 1]])));
  assert.strictEqual(grow.fading, false);
});

test('tradeRead: a short reads the mirror of a long (every fact side-signed)', () => {
  const bars = mk(legs(21000, [...UP.slice(0, 7), [60, -1.5]]));
  const long = read(bars);
  const short = tradeRead({ side: 'short', entry: 42000 - bars[20].c, openedAt: at(bars, 20), bars: mirror(bars, 21000), base: 3, tick: 0.25, exit: EXIT });
  assert.strictEqual(short.extreme.best, 42000 - long.extreme.best);
  assert.strictEqual(short.pullback.depth, long.pullback.depth);
  assert.deepStrictEqual(short.pushes.map(p => [p.sizeAtr, p.momentum, 42000 - p.swing]), long.pushes.map(p => [p.sizeAtr, p.momentum, p.swing]));
  assert.strictEqual(short.against['15m'].direction, 'up');
  assert.strictEqual(short.ema20.distAtr, long.ema20.distAtr);
  assert.strictEqual(short.trail.swing, 42000 - long.trail.swing);
  assert.strictEqual(short.trail.stop, short.trail.swing + 0.25, 'a short\'s stop a tick above its swing high');
});

test('tradeRead: the HTF bias at entry and now; a flip against the trade is one weakening sign, never a reversal alone', () => {
  // Five days up, then five days down: the 4h and 1h trends turn.
  const up = Array.from({ length: 2400 }, (_, i) => 20000 + i * 0.8 + (i % 7) * 0.25);
  const down = Array.from({ length: 2400 }, (_, i) => up[up.length - 1] - i * 0.8 - (i % 7) * 0.25);
  const bars = mk([...up, ...down], { start: Date.parse('2026-09-28T00:00:00.000Z') });
  const entryAt = 2000;
  const r = tradeRead({ side: 'long', entry: bars[entryAt].c, openedAt: at(bars, entryAt), bars, base: 3 });
  assert.strictEqual(r.bias.entry.dir, 'up');
  assert.strictEqual(r.bias.now.dir, 'down');
  assert.strictEqual(r.bias.flipAgainst, true);
  assert.ok(r.signs.includes('HTF flip'));
  assert.match(tradeReadLine(r), /HTF bias at entry (?:4h|1h) up, now (?:4h|1h) down \(FLIPPED against the trade\)/);
  const s = tradeRead({ side: 'short', entry: bars[entryAt].c, openedAt: at(bars, entryAt), bars, base: 3 });
  assert.strictEqual(s.bias.flipAgainst, false);
  assert.ok(!s.signs.includes('HTF flip'));
  assert.deepStrictEqual(tradeRead({ side: 'long', entry: bars[entryAt].c, openedAt: at(bars, entryAt), bars: bars.slice(0, entryAt + 5), base: 3 }).bias.entry, r.bias.entry);
  assert.strictEqual(biasOf([]), null);
});

test('tradeRead: unavailable without a side, an entry, a fill time or a bar since the fill; the line says so', () => {
  const bars = mk(legs(21000, UP.slice(0, 2)));
  assert.match(tradeRead({ side: 'flat', entry: 1, openedAt: at(bars, 0), bars, base: 3 }).unavailable, /no side/);
  assert.match(tradeRead({ side: 'long', entry: NaN, openedAt: at(bars, 0), bars, base: 3 }).unavailable, /no side, entry/);
  const late = new Date(Date.parse(bars[bars.length - 1].t) + STEP).toISOString();
  const r = tradeRead({ side: 'long', entry: 21000, openedAt: late, bars, base: 3 });
  assert.match(r.unavailable, /no closed bar since the fill/);
  assert.strictEqual(tradeReadLine(r), 'Trade read: unavailable (no closed bar since the fill yet).');
  assert.strictEqual(tradeReadLine(null), 'Trade read: unavailable (not computed).');
  // No tick: the trail's stop is the swing itself.
  const t = tradeRead({ side: 'long', entry: 21000, openedAt: at(mk(legs(21000, UP)), 20), bars: mk(legs(21000, UP)), base: 3, exit: EXIT });
  assert.strictEqual(t.trail.stop, t.trail.swing);
});

test('tradeRead: only the bars passed are read (no look-ahead): a decision\'s facts from the bars closed by it never change', () => {
  const bars = mk(legs(21000, UP));
  const k = 150;
  const a = read(bars.slice(0, k));
  const crash = bars.map((b, i) => (i < k ? b : { ...b, o: b.o - 500, h: b.h - 500, l: b.l - 500, c: b.c - 500 }));
  assert.deepStrictEqual(read(crash.slice(0, k)), a);
  assert.strictEqual(a.close, bars[k - 1].c);
});

test('tradeRead: the trail level is the active policy\'s own (its swing timeframe, as the runner reads it), never the structure frame\'s', () => {
  const bars = mk(legs(21000, UP));
  const sw = require('../../scripts/lib/trading/exit-trail').swingSeries(bars, 5);
  const r5 = read(bars, { exit: { trailBy: 'structure', swingMinutes: 5 } });
  assert.strictEqual(r5.trail.swing, sw.low[bars.length - 1], 'the runner\'s swingSeries on the 5m candles');
  assert.strictEqual(r5.trail.minutes, 5);
  assert.match(tradeReadLine(r5), /tighten at most to the last confirmed 5m swing [\d.]+ \(stop [\d.]+, the runner's trail level\)\.$/);
  // A trail by R has no swing level, and no plan given has none: the line says so.
  const byR = read(bars, { exit: { trailBy: 'r', swingMinutes: null, trailR: 1.5 } });
  assert.deepStrictEqual([byR.trail, byR.trailBy], [null, 'r']);
  assert.match(tradeReadLine(byR), /tighten at most to no swing level: the runner trails this trade by R behind the best price\.$/);
  const none = read(bars, { exit: null });
  assert.deepStrictEqual([none.trail, none.trailBy], [null, 'none']);
  assert.match(tradeReadLine(none), /no swing level: the runner holds no structure trail for this trade\.$/);
});
