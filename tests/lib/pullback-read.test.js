'use strict';

// The flat cycle's Pullback read (trading/pullback-read.js): when price has moved against the prevailing side on the
// 15m, the leg it pulls back from (the Trade read's own impulse definition, one home), its depth, whether the leg's
// 15m and 1h swings hold, the counter-move's bars and volume against the leg's, and the 15m/1h breaks against it.
// Facts only: no verdict, nothing reads it but the summary line and the situational skill.
const test = require('node:test');
const assert = require('node:assert');
const PR = require('../../scripts/lib/trading/pullback-read');
const { tradeRead } = require('../../scripts/lib/trading/trade-read');

const START = Date.parse('2026-10-05T12:00:00.000Z'); // 08:00 ET (EDT): bar 30 is the 09:30 RTH open
const STEP = 180000;
/** 3m bars from closes: open the previous close; the wick longer on the close's side (the Trade read's fixture). */
function mk(closes, { start = START, wick = 1, vol = () => 100 } = {}) {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: new Date(start + i * STEP).toISOString(), o, h: Math.max(o, c) + (c >= o ? wick : wick / 2), l: Math.min(o, c) - (c <= o ? wick : wick / 2), c, v: vol(i) };
  });
}
function legs(from, list) {
  const out = [];
  let p = from;
  for (const [n, d] of list) for (let i = 0; i < n; i += 1) out.push((p += d));
  return out;
}
// Four 15m legs up (40 bars up a point, 20 down: each top above the last), the last one tops at 21101 (close 21100 + the
// 1-point wick) from the trough at 21059 (close 21060 - the 1-point wick): a 42-point leg.
const UP = [[40, 1], [20, -1], [40, 1], [20, -1], [40, 1], [20, -1], [40, 1]];
const mirror = (bars, m) => bars.map(b => ({ ...b, o: 2 * m - b.o, h: 2 * m - b.l, l: 2 * m - b.h, c: 2 * m - b.c }));
const read = (bars, prevailing = '4h up') => PR.pullbackRead({ bars, base: 3, prevailing });

test('pullbackRead: a 20-bar dip from the last 15m leg up, the 4h up: the leg, its depth by hand, the swings hold, no break against', () => {
  const bars = mk(legs(21000, [...UP, [20, -1]]));
  const p = read(bars);
  assert.ok(p, 'a counter-move: four 15m candles closed under the leg\'s top');
  assert.strictEqual(p.side, 'long');
  assert.strictEqual(p.frame, '15m');
  assert.strictEqual(p.prevailing, '4h up');
  // By hand: top 21101, origin 21059, close 21080: (21101 - 21080) / 42 = 0.5.
  assert.deepStrictEqual([p.leg.origin, p.leg.extreme, p.close, p.depth], [21059, 21101, 21080, 0.5]);
  assert.strictEqual(p.leg.at, bars[219].t, 'the extreme is the leg\'s last up bar (the first at the high)');
  assert.strictEqual(p.counter.bars, 20);
  assert.strictEqual(p.swing['15m'].price, 21059);
  assert.strictEqual(p.swing['15m'].holds, true);
  assert.strictEqual(p.against['15m'], null);
  assert.strictEqual(p.against['1h'], null);
  assert.strictEqual(p.stacked, false);
  // Equal volume: even (a plain comparison, no threshold).
  assert.deepStrictEqual([p.counter.volRatio, p.counter.volume], [1, 'even']);
  // A later bar touching the same high: the extreme stays the first bar at it (the Trade read's rule).
  const tie = bars.map((b, i) => (i === 222 ? { ...b, h: 21101 } : b));
  assert.strictEqual(read(tie).leg.at, bars[219].t);
  assert.strictEqual(read(tie).counter.bars, 20);
});

test('pullbackRead: with the trend (the last 15m candles at new highs, or fewer than swingK 15m candles since the top) it is absent', () => {
  assert.strictEqual(read(mk(legs(21000, UP))), null, 'price at the leg\'s high');
  // One 15m candle (five 3m bars) down from the top: the top is not a confirmed 15m swing yet.
  assert.strictEqual(read(mk(legs(21000, [...UP, [5, -1]]))), null);
  // Two 15m candles down: confirmed (swingK 2).
  assert.ok(read(mk(legs(21000, [...UP, [10, -1]]))));
  // No prevailing trend (the trend rule shows none): absent.
  assert.strictEqual(read(mk(legs(21000, [...UP, [20, -1]])), null), null);
  assert.strictEqual(read(mk(legs(21000, [...UP, [20, -1]])), 'none'), null);
});

test('pullbackRead: a lower high inside the pullback never becomes the leg: the leg is the impulse to the top', () => {
  // From the top: down 15, a 15m bounce up 7.5 (a lower high, a confirmed 15m swing high), down 15.
  const bars = mk(legs(21000, [...UP, [15, -1], [10, 0.75], [15, -1]]));
  const p = read(bars);
  assert.ok(p);
  assert.deepStrictEqual([p.leg.origin, p.leg.extreme], [21059, 21101]);
  assert.strictEqual(p.close, 21100 - 15 + 7.5 - 15);
  assert.strictEqual(p.depth, Math.round(((21101 - p.close) / 42) * 100) / 100);
});

test('pullbackRead: a fall through the leg\'s origin: depth past 100%, the 15m swing broken, the 15m break against named', () => {
  const bars = mk(legs(21000, [...UP, [40, -1.5]]));
  const p = read(bars);
  assert.ok(p.depth > 1, String(p.depth));
  assert.strictEqual(p.swing['15m'].holds, false, 'a 3m close went under the 15m swing low');
  assert.ok(p.against['15m'] && p.against['15m'].direction === 'down', JSON.stringify(p.against));
  assert.match(p.against['15m'].kind, /^(?:BOS|CHoCH)$/);
  assert.deepStrictEqual([p.against['1h'], p.stacked], [null, false], 'the 15m alone: not stacked');
  assert.match(PR.pullbackLine(p), /depth \d+% of the leg \(past its origin\)/);
  assert.match(PR.pullbackLine(p), /15m break against: (?:BOS|CHoCH) down [\d.]+ \(\d+ bars ago\)/);
});

test('pullbackRead: the 15m and 1h breaks against stacked', () => {
  // 1h-sized legs (100 bars up, 60 down: 1h swings), then a 150-bar fall through both the 15m and the 1h swing lows.
  const bars = mk(legs(21000, [[100, 1], [60, -1], [100, 1], [60, -1], [100, 1], [60, -1], [100, 1], [150, -1]]));
  const p = read(bars);
  assert.deepStrictEqual([p.leg.origin, p.leg.extreme, p.depth], [21119, 21221, 1.48], 'by hand: (21221 - 21070) / 102');
  assert.ok(p.against['15m'] && p.against['1h'], JSON.stringify(p.against));
  assert.strictEqual(p.stacked, true);
  assert.strictEqual(p.swing['1h'].holds, false);
  assert.match(PR.pullbackLine(p), /1h: (?:BOS|CHoCH) down [\d.]+ \(\d+ bars ago\); stacked/);
});

test('pullbackRead: a short reads the mirror of a long', () => {
  const bars = mk(legs(21000, [...UP, [20, -1]]));
  const long = read(bars);
  const short = read(mirror(bars, 21000), '1h down');
  assert.strictEqual(short.side, 'short');
  assert.deepStrictEqual([short.leg.origin, short.leg.extreme, short.close], [42000 - long.leg.origin, 42000 - long.leg.extreme, 42000 - long.close]);
  assert.strictEqual(short.depth, long.depth);
  assert.strictEqual(short.counter.bars, long.counter.bars);
  assert.strictEqual(short.swing['15m'].price, 42000 - long.swing['15m'].price);
  assert.strictEqual(short.swing['15m'].holds, true);
  assert.strictEqual(short.counter.volume, long.counter.volume);
});

test('pullbackRead: the counter-move\'s volume and range against the leg\'s, in one session part (never across the RTH open)', () => {
  const closes = legs(21000, [...UP, [20, -1]]);
  // The counter-move (bars 220-239) at 60 a bar, the leg at 100: 0.6x, falling.
  const fall = read(mk(closes, { vol: i => (i >= 220 ? 60 : 100) }));
  assert.deepStrictEqual([fall.counter.volRatio, fall.counter.volume], [0.6, 'falling']);
  const rise = read(mk(closes, { vol: i => (i >= 220 ? 150 : 100) }));
  assert.deepStrictEqual([rise.counter.volRatio, rise.counter.volume], [1.5, 'rising']);
  // The range per bar: every bar here is 2.5 points (a 1-point body, a 1-point wick its way, half a point the other): even.
  assert.strictEqual(fall.counter.rangeRatio, 1);
  // No volume on the bars: unknown, never a guess.
  const none = read(mk(closes, { vol: () => undefined }));
  assert.deepStrictEqual([none.counter.volRatio, none.counter.volume], [null, null]);
  assert.match(PR.pullbackLine(none), /volume unknown/);
  // The leg built before the 09:30 open, the counter-move after it: the leg has no RTH bars to compare: unknown.
  const shift = Date.parse('2026-10-05T13:30:00.000Z') - 220 * STEP; // bar 220 opens at 09:30 ET (EDT)
  const open = read(mk(closes, { start: shift, vol: i => (i >= 220 ? 300 : 100) }));
  assert.deepStrictEqual([open.counter.volRatio, open.counter.volume], [null, null], 'no leg bars in the RTH part of the session');
  assert.strictEqual(open.counter.bars, 20);
});

test('pullbackRead: the leg\'s numbers equal the Trade read\'s once a trade opens on that leg (one definition, parity)', () => {
  const cases = [
    { name: 'dip', bars: mk(legs(21000, [...UP, [20, -1]])), side: 'long', prevailing: '4h up' },
    { name: 'lower high', bars: mk(legs(21000, [...UP, [15, -1], [10, 0.8], [15, -1]])), side: 'long', prevailing: '4h up' },
    { name: 'deep', bars: mk(legs(21000, [...UP, [40, -1.5]])), side: 'long', prevailing: '4h up' },
  ];
  cases.push({ name: 'short', bars: mirror(cases[0].bars, 21000), side: 'short', prevailing: '1h down' });
  for (const c of cases) {
    const p = PR.pullbackRead({ bars: c.bars, base: 3, prevailing: c.prevailing });
    assert.ok(p, c.name);
    // A long opened in the leg (bar 190: after the 15m break up, before its top; 15m candles closed since the fill).
    const t = tradeRead({ side: c.side, entry: c.bars[190].c, openedAt: c.bars[190].t, bars: c.bars, base: 3, tick: 0.25 });
    assert.strictEqual(t.extreme.best, p.leg.extreme, c.name);
    assert.deepStrictEqual(t.pullback, { origin: p.leg.origin, best: p.leg.extreme, depth: p.depth }, c.name);
  }
  // Before any 15m candle closes after the fill the Trade read measures from the fill, as before the extraction.
  const early = mk(legs(21000, [...UP, [2, -1]]));
  const t = tradeRead({ side: 'long', entry: early[220].c, openedAt: early[220].t, bars: early, base: 3, tick: 0.25 });
  assert.deepStrictEqual([t.pullback.origin, t.pullback.best], [early[220].l, early[220].h]);
});

test('pullbackLine: facts in order, no verdict word; the leg by its endpoints', () => {
  const p = read(mk(legs(21000, [...UP, [20, -1]]), { vol: i => (i >= 220 ? 60 : 100) }));
  const line = PR.pullbackLine(p);
  assert.strictEqual(line, '- Pullback (15m, long leg 21059 -> 21101): depth 50% of the leg; 20 bars against it, volume 0.6x the leg\'s per bar (falling), range 1x; '
    + `15m swing 21059 holds, 1h swing ${p.swing['1h'] ? `${p.swing['1h'].price} holds` : 'unknown'}; 15m break against: none, 1h: none.`);
  // No conclusion a rule could read: no verdict word after the line's name; nothing another line says (the price, the
  // prevailing side, the clock) and no disclaimer (the skills say it once).
  const rest = line.replace(/^- Pullback /, '');
  assert.ok(!/pullback|reversal|healthy|weak|continu|prevailing|close \d|weigh|ET\b|\d{1,2}:\d{2}/i.test(rest), rest);
  assert.strictEqual(PR.pullbackLine(null), null);
  assert.strictEqual(PR.pullbackLine(undefined), null);
  // A level shown on the contract's tick, as the briefing shows prices.
  assert.match(PR.pullbackLine(p, { level: x => x.toFixed(2) }), /long leg 21059\.00 -> 21101\.00/);
});
