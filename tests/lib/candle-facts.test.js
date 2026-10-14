'use strict';

// Completed-candle facts (scripts/lib/trading/candle-facts.js): each pattern definition (a hypothesis) with its edge
// cases, the level relations, the swing targets, timeframe alignment (18:00 ET open, DST, the weekend), and causality:
// the candle forming is never read, and bars after a bar never change its facts.

const test = require('node:test');
const assert = require('node:assert');
const CF = require('../../scripts/lib/trading/candle-facts');

const c = (o, h, l, cl, v = 100) => ({ o, h, l, c: cl, v });
const MIN = 60000;

/** Bars of `step` minutes from `start` (ISO), price drifting by a pattern, volume 100. */
function bars(start, count, step = 3, fn = i => 100 + (i % 7) - (i % 3)) {
  const t0 = Date.parse(start);
  return Array.from({ length: count }, (_, i) => {
    const p = fn(i);
    return { t: new Date(t0 + i * step * MIN).toISOString(), o: p, h: p + 1, l: p - 1, c: p + 0.5, v: 100 + i };
  });
}

test('patterns: each definition, with its edges', () => {
  // Doji: body at most 10% of the range.
  assert.deepStrictEqual(CF.patternsOf(c(100, 102, 98, 100.25)), ['doji']);
  assert.ok(!CF.patternsOf(c(100, 102, 98, 100.5)).includes('doji'), 'body 12.5% is no doji');
  // Zero range (equal OHLC): no shape, no pattern.
  assert.deepStrictEqual(CF.patternsOf(c(100, 100, 100, 100)), []);
  assert.strictEqual(CF.patternLabel([]), 'none');
  assert.deepStrictEqual(CF.shape(c(100, 100, 100, 100)), { body: null, upperWick: null, lowerWick: null, closeAt: null });
  assert.strictEqual(CF.closeLocation(c(100, 100, 100, 100)), null);
  // Hammer: lower wick >= 2 bodies and >= 60% of range, upper wick <= 15%.
  assert.deepStrictEqual(CF.patternsOf(c(107.5, 110, 100, 109)), ['hammer']);
  assert.ok(!CF.patternsOf(c(107, 110, 100, 108)).includes('hammer'), 'upper wick 20%');
  // A dragonfly doji is a hammer first (label priority), a doji too.
  assert.deepStrictEqual(CF.patternsOf(c(110, 110, 100, 110)), ['hammer', 'doji']);
  // Shooting star: the mirror.
  assert.deepStrictEqual(CF.patternsOf(c(102.5, 110, 100, 101)), ['shooting star']);
  assert.ok(!CF.patternsOf(c(103, 110, 100, 102)).includes('shooting star'), 'lower wick 20%');
  // Engulfing: opposite colours, the body covers the previous body and is bigger.
  const prevBear = c(104, 105, 101, 102);
  assert.ok(CF.patternsOf(c(101.75, 106, 101, 105), prevBear).includes('bullish engulfing'));
  assert.ok(!CF.patternsOf(c(102, 104.5, 101.5, 104), prevBear).includes('bullish engulfing'), 'equal bodies do not engulf');
  assert.ok(!CF.patternsOf(c(101.75, 106, 101, 105), c(102, 105, 101, 104)).includes('bullish engulfing'), 'same colour');
  const prevBull = c(102, 105, 101, 104);
  assert.strictEqual(CF.patternsOf(c(104.25, 105, 100, 101), prevBull)[0], 'bearish engulfing');
  // Inside: within the previous range and smaller; equal highs and lows are not inside or outside.
  assert.ok(CF.patternsOf(c(102, 103, 101.5, 102.5), c(100, 105, 100, 104)).includes('inside'));
  const same = c(100, 105, 100, 103);
  assert.ok(!CF.patternsOf(same, c(101, 105, 100, 104)).includes('inside'));
  assert.ok(!CF.patternsOf(same, c(101, 105, 100, 104)).includes('outside'));
  // Outside: beyond both sides (one may be equal) and bigger.
  assert.ok(CF.patternsOf(c(102, 106, 100, 103), c(101, 105, 100, 104)).includes('outside'));
  // Displacement: body >= 70% of range and range >= 1.5 x ATR as of the candle before.
  assert.strictEqual(CF.patternsOf(c(100, 108.25, 99.75, 108), null, 5)[0], 'displacement');
  assert.ok(!CF.patternsOf(c(100, 108.25, 99.75, 108), null, 6).includes('displacement'), 'range 8.5 < 1.5 x 6');
  assert.ok(!CF.patternsOf(c(100, 108.25, 99.75, 108)).includes('displacement'), 'no ATR, no displacement');
  // Close location thirds.
  assert.strictEqual(CF.closeLocation(c(100, 103, 100, 102)), 'top');
  assert.strictEqual(CF.closeLocation(c(100, 103, 100, 1.5 + 100)), 'middle');
  assert.strictEqual(CF.closeLocation(c(100, 103, 100, 101)), 'bottom');
});

test('level relations: rejected, broke, touched, none, by where the candle came from', () => {
  const L = 100;
  assert.deepStrictEqual(CF.relation(c(98, 99.75, 97, 99), L), { relation: 'none', dir: null });
  // From below: wick above, close back below.
  assert.deepStrictEqual(CF.relation(c(98, 101, 97, 99), L), { relation: 'rejected', dir: 'down' });
  // From above: wick below, close back above.
  assert.deepStrictEqual(CF.relation(c(102, 103, 99, 101), L), { relation: 'rejected', dir: 'up' });
  // Broke: close beyond with most of the body beyond.
  assert.deepStrictEqual(CF.relation(c(99, 103, 98.5, 102), L), { relation: 'broke', dir: 'up' });
  assert.deepStrictEqual(CF.relation(c(101, 101.5, 97, 98), L), { relation: 'broke', dir: 'down' });
  // Closed beyond with most of the body still behind: touched.
  assert.deepStrictEqual(CF.relation(c(97, 101, 96.5, 100.5), L), { relation: 'touched', dir: null });
  // Reached exactly: touched.
  assert.deepStrictEqual(CF.relation(c(98, 100, 97, 99), L), { relation: 'touched', dir: null });
  // Opened on the level: the previous close says where it came from; without one, touched.
  assert.deepStrictEqual(CF.relation(c(100, 101, 99.5, 99.75), L, 99), { relation: 'rejected', dir: 'down' });
  assert.deepStrictEqual(CF.relation(c(100, 101, 99.5, 99.75), L), { relation: 'touched', dir: null });
  assert.strictEqual(CF.relation(c(98, 101, 97, 99), NaN), null);
});

test('completed candles: the forming one is never used; 5m from 3m bars is unavailable, from 1m bars built', () => {
  // 3m bars from 09:30 ET (13:30Z, EDT) to the 09:54 open: 09:30-09:45 is the last completed 15m (09:45-10:00 forms).
  const b3 = bars('2026-06-15T13:30:00Z', 9);
  const s15 = CF.completedSeries(b3, 15, 3);
  const j = s15.lastAt.at(-1);
  assert.strictEqual(s15.candles[j].t, '2026-06-15T13:30:00.000Z');
  assert.strictEqual(s15.candles[j].closedAt, '2026-06-15T13:45:00.000Z');
  // The bar that closes 09:45-10:00 completes it.
  const b3b = bars('2026-06-15T13:30:00Z', 10);
  assert.strictEqual(CF.completedSeries(b3b, 15, 3).candles.at(-1).closedAt, '2026-06-15T14:00:00.000Z');
  // Changing the forming candle's bars changes nothing.
  const tweaked = b3.map((x, i) => (i >= 5 ? { ...x, h: x.h + 50, l: x.l - 50, c: x.c + 9 } : x));
  const a = CF.candleSeries(b3, 15, 3);
  const b = CF.candleSeries(tweaked, 15, 3);
  for (const k of ['htfd_open', 'htfd_high', 'htfd_low', 'htfd_close', 'htfd_volume', 'htfd_body']) assert.strictEqual(a[k].at(-1), b[k].at(-1), k);
  // 5m from 3m: unavailable, never approximated.
  const s5 = CF.completedSeries(b3, 5, 3);
  assert.strictEqual(s5.available, false);
  assert.match(s5.reason, /not whole 3m bars/);
  assert.ok(CF.candleSeries(b3, 5, 3).htfd_close.every(Number.isNaN));
  // From 1m bars: built on the 5m grid.
  const b1 = bars('2026-06-15T13:30:00Z', 12, 1);
  const s51 = CF.completedSeries(b1, 5, 1);
  assert.ok(s51.available);
  assert.deepStrictEqual(s51.candles.map(x => x.t), ['2026-06-15T13:30:00.000Z', '2026-06-15T13:35:00.000Z']);
  assert.strictEqual(s51.candles[1].h, Math.max(...b1.slice(5, 10).map(x => x.h)));
  assert.strictEqual(s51.candles[1].v, b1.slice(5, 10).reduce((t, x) => t + x.v, 0));
});

test('alignment: candles open on the 18:00 ET grid across the open, DST and the weekend; a missing sub-bar never moves one', () => {
  // Friday 2026-10-30 (EDT) 15:00-16:00 ET, then Sunday 2026-11-01 (EST) from the 18:00 ET open.
  const fri = bars('2026-10-30T19:00:00Z', 20); // 15:00-16:00 ET
  const sun = bars('2026-11-01T23:00:00Z', 20); // 18:00-19:00 ET, after the DST change
  const all = [...fri, ...sun];
  const s60 = CF.completedSeries(all, 60, 3);
  assert.deepStrictEqual(s60.candles.map(x => [x.t, x.closedAt]), [
    ['2026-10-30T19:00:00.000Z', '2026-10-30T20:00:00.000Z'],
    ['2026-11-01T23:00:00.000Z', '2026-11-02T00:00:00.000Z'],
  ]);
  // The 15m candles on Sunday open at 18:00, 18:15, 18:30, 18:45 ET.
  const s15 = CF.completedSeries(all, 15, 3);
  assert.deepStrictEqual(s15.candles.slice(-4).map(x => x.t), ['2026-11-01T23:00:00.000Z', '2026-11-01T23:15:00.000Z', '2026-11-01T23:30:00.000Z', '2026-11-01T23:45:00.000Z']);
  // Friday's last 60m candle is complete on its own last bar (it closes on the boundary), never on Sunday's.
  const k = fri.length - 1;
  assert.strictEqual(s60.candles[s60.lastAt[k]].closedAt, '2026-10-30T20:00:00.000Z');
  // A missing first sub-bar: the hour still opens on its boundary.
  const gap = bars('2026-06-15T13:00:00Z', 45).filter((_, i) => i !== 20); // 14:00Z missing
  const sg = CF.completedSeries(gap, 60, 3);
  assert.strictEqual(sg.candles.at(-1).t, '2026-06-15T14:00:00.000Z');
  // A missing last sub-bar: the hour is completed on the next hour's first bar, not before.
  const tail = bars('2026-06-15T13:00:00Z', 22).filter((_, i) => i !== 19); // 13:57Z missing
  const st = CF.completedSeries(tail, 60, 3);
  assert.strictEqual(st.lastAt[18], -1, 'the 13:54 bar does not complete 13:00-14:00');
  assert.strictEqual(st.candles[st.lastAt[19]].closedAt, '2026-06-15T14:00:00.000Z', 'the 14:00 bar does');
  // A first candle the bars start partway into is dropped.
  const mid = bars('2026-06-15T13:06:00Z', 40);
  assert.strictEqual(CF.completedSeries(mid, 60, 3).candles[0].t, '2026-06-15T14:00:00.000Z');
});

test('swing targets: the nearest untaken confirmed swing above and below; taken once traded beyond', () => {
  // 3m bars: a swing high at bar 5 (110), confirmed at bar 7; price then below it.
  const px = [100, 101, 102, 103, 104, 110, 104, 103, 102, 101, 100, 99, 98, 99, 100];
  const b = px.map((p, i) => ({ t: new Date(Date.parse('2026-06-15T13:30:00Z') + i * 3 * MIN).toISOString(), o: p, h: p + 0.5, l: p - 0.5, c: p, v: 100 }));
  const s = CF.swingTargetSeries(b, 3, 3);
  assert.ok(Number.isNaN(s.high[6]), 'not confirmed before 2 bars after it');
  assert.strictEqual(s.high[7], 110.5);
  assert.strictEqual(s.low.at(-1), 97.5, 'the low at bar 12, confirmed at bar 14');
  // Traded beyond: taken, no longer a target.
  const taken = [...b, { t: new Date(Date.parse(b.at(-1).t) + 3 * MIN).toISOString(), o: 100, h: 111, l: 99, c: 100, v: 1 }];
  assert.ok(Number.isNaN(CF.swingTargetSeries(taken, 3, 3).high.at(-1)));
  // Bars after a bar never change its value.
  const s2 = CF.swingTargetSeries(taken, 3, 3);
  for (let i = 0; i < b.length; i += 1) assert.ok(Object.is(s.high[i], s2.high[i]) && Object.is(s.low[i], s2.low[i]), `bar ${i}`);
  // The briefing block: distance in points, ticks and R.
  const t = CF.briefingTargets({ bars: b, minutes: 3, price: 99, oneR: 2, tick: 0.25, frames: [3] });
  assert.deepStrictEqual(t.above, [{ frame: '3m', price: 110.5, points: 11.5, ticks: 46, R: 5.75 }]);
  assert.deepStrictEqual(t.below, [{ frame: '3m', price: 97.5, points: 1.5, ticks: 6, R: 0.75 }]);
});

test('briefing candles: per timeframe, unavailable ones named, levels met, previous candle and CRT range', () => {
  const b = bars('2026-06-15T13:30:00Z', 60);
  const out = CF.briefingCandles({ bars: b, base: 3, levelsAt: () => [['prior RTH high', 101], ['far', 500]] });
  assert.deepStrictEqual(Object.keys(out), ['3m', '5m', '15m', '1h', '4h']);
  assert.match(out['5m'].unavailable, /not whole 3m bars/);
  const m15 = out['15m'];
  assert.strictEqual(m15.closedAt, '2026-06-15T16:30:00.000Z');
  assert.ok(!('far' in m15.levels));
  assert.ok(Object.keys(m15.levels).some(k => /previous 15m (high|low)|prior RTH high|CRT 1h range/.test(k)));
  assert.ok(['top', 'middle', 'bottom'].includes(m15.closeLocation));
  assert.ok(CF.LABELS.concat('none').includes(m15.pattern));
});

test('candle series at bar t are unchanged by the bars after t (every htfd series, every timeframe)', () => {
  const b = bars('2026-06-15T13:00:00Z', 200, 1, i => 100 + Math.sin(i / 5) * 6 + (i % 4));
  for (const m of [3, 5, 15, 60]) {
    const full = CF.candleSeries(b, m, 1);
    const fullT = CF.swingTargetSeries(b, m, 1);
    for (const t of [30, 77, 120, 181]) {
      const cut = b.slice(0, t + 1);
      const part = CF.candleSeries(cut, m, 1);
      const partT = CF.swingTargetSeries(cut, m, 1);
      for (const k of Object.keys(part)) assert.ok(Object.is(part[k][t], full[k][t]), `${m}m ${k} at ${t}`);
      assert.ok(Object.is(partT.high[t], fullT.high[t]) && Object.is(partT.low[t], fullT.low[t]), `${m}m targets at ${t}`);
    }
  }
});

test('5m from 1m bars: complete only once its last 1m bar has closed, else the one before; never a partial one; 1m bars after the close never read', () => {
  const b3 = bars('2026-06-15T13:30:00Z', 15); // 09:30 to the 10:12 bar, closing 10:15
  const b1 = bars('2026-06-15T13:30:00Z', 45, 1); // 09:30 to the 10:14 bar, closing 10:15
  const out = CF.briefingCandles({ bars: b3, base: 3, fine: b1, timeframes: [5] })['5m'];
  assert.strictEqual(out.closedAt, '2026-06-15T14:15:00.000Z');
  assert.strictEqual(out.h, Math.max(...b1.slice(40, 45).map(x => x.h)));
  assert.strictEqual(out.v, b1.slice(40, 45).reduce((t, x) => t + x.v, 0));
  // The 1m bar ending on the boundary not here yet: the 10:05-10:10 candle, never 10:10-10:14 as a partial one.
  assert.strictEqual(CF.briefingCandles({ bars: b3, base: 3, fine: b1.slice(0, -1), timeframes: [5] })['5m'].closedAt, '2026-06-15T14:10:00.000Z');
  // 1m bars after the base bar's close change nothing.
  const more = [...b1, ...bars('2026-06-15T14:15:00Z', 7, 1, () => 500)];
  assert.deepStrictEqual(CF.briefingCandles({ bars: b3, base: 3, fine: more, timeframes: [5] }), CF.briefingCandles({ bars: b3, base: 3, fine: b1, timeframes: [5] }));
  // No 1m bars: unavailable, and why.
  assert.match(CF.briefingCandles({ bars: b3, base: 3, timeframes: [5] })['5m'].unavailable, /not whole 3m bars; no 1m bars configured/);
  // 1m bars that stopped: no current 5m candle.
  assert.match(CF.briefingCandles({ bars: b3, base: 3, fine: b1.slice(0, 20), timeframes: [5] })['5m'].unavailable, /the 1m bars stop at/);
});

test('a thin stretch of a 1m feed never reads as 2m bars: the hour keeps its :59 bar', () => {
  const t0 = Date.parse('2026-06-15T13:00:00Z'); // 09:00 ET
  const at = (min, p) => ({ t: new Date(t0 + min * MIN).toISOString(), o: p, h: p + 1, l: p - 1, c: p, v: 1 });
  const b = [at(0, 100), at(1, 100), ...Array.from({ length: 29 }, (_, k) => at(2 + 2 * k, 100)), at(59, 130), at(60, 100)];
  const s = CF.completedSeries(b, 60, 1);
  assert.strictEqual(s.candles[0].h, 131, 'the :59 bar is in the 09:00 hour');
  assert.strictEqual(s.candles[0].c, 130);
});

test('holding swings as of a bar: confirmed by then, and no close beyond from the swing\'s close to that bar', () => {
  const px = [100, 101, 102, 103, 104, 110, 104, 103, 102, 101, 100, 101, 102, 103, 104, 112];
  const b = px.map((p, i) => ({ t: new Date(Date.parse('2026-06-15T13:30:00Z') + i * 3 * MIN).toISOString(), o: p, h: p + 0.5, l: p - 0.5, c: p, v: 100 }));
  const highs = idx => CF.holdingSwingsAt(b, 3, 3, idx).filter(x => x.type === 'high').map(x => x.price);
  assert.deepStrictEqual(highs(6), [], 'not confirmed yet');
  assert.deepStrictEqual(highs(14), [110.5]);
  assert.deepStrictEqual(highs(15), [], 'bar 15 closed above it');
});

test('the bar size is given, never guessed: one bar off the grid changes neither what is whole nor when a candle closes', () => {
  const clean = bars('2026-06-15T13:30:00Z', 10); // 09:30 to the 09:57 bar
  // An extra bar at 09:31 (off the 3m grid): a 1-minute gap among 3m bars.
  const odd = [...clean.slice(0, 1), { ...clean[0], t: '2026-06-15T13:31:00.000Z' }, ...clean.slice(1)];
  assert.strictEqual(CF.completedSeries(odd, 5, 3).available, false, '5m stays unavailable from 3m bars');
  const a = CF.completedSeries(clean, 15, 3);
  const b = CF.completedSeries(odd, 15, 3);
  // The 09:30-09:45 candle completes on the 09:42 bar in both (index 4 clean, 5 with the extra bar), not one bar late.
  assert.strictEqual(a.candles[a.lastAt[4]].closedAt, '2026-06-15T13:45:00.000Z');
  assert.strictEqual(b.candles[b.lastAt[5]].closedAt, '2026-06-15T13:45:00.000Z');
  assert.strictEqual(b.lastAt[4], -1, 'the 09:39 bar does not complete it');
  // Without the bar size: no candle facts at all.
  assert.match(CF.completedSeries(clean, 15).reason, /bar size is not known/);
});

test('5m from 1m bars that stop short of the close: the one before the last boundary at most; older is not current', () => {
  const b3 = bars('2026-06-15T13:30:00Z', 15);
  const b1 = bars('2026-06-15T13:30:00Z', 45, 1);
  // The last 1m bar closes 10:09: the 10:05-10:10 candle is not complete, 10:00-10:05 is two candles old.
  assert.match(CF.briefingCandles({ bars: b3, base: 3, fine: b1.slice(0, -6), timeframes: [5] })['5m'].unavailable, /no current 5m candle/);
});

test('the briefing lists at most four level relations per candle, strongest first: rejected, broke, touched; then by level', () => {
  const b = bars('2026-06-15T13:30:00Z', 10, 3, () => 100);
  // Each bar: o 100, h 101, l 99, c 100.5; the 15m candle 09:30-09:45: o 100, h 101, l 99, c 100.5.
  const levels = [['round-ish', 99.5], ['prior RTH high', 100.75], ['session POC', 100.25], ['VWAP (rth)', 100], ['overnight low', 99.25], ['IB high', 100.6]];
  const c = CF.briefingCandles({ bars: b, base: 3, levelsAt: () => levels, timeframes: [15] })['15m'];
  const names = Object.keys(c.levels);
  assert.strictEqual(names.length, 4);
  assert.ok(c.moreLevels >= 2);
  const rank = r => (r.startsWith('rejected') ? 0 : r.startsWith('broke') ? 1 : 2);
  const ranks = names.map(n => rank(c.levels[n]));
  assert.deepStrictEqual(ranks, [...ranks].sort((x, y) => x - y), JSON.stringify(c.levels));
  assert.strictEqual(names[0], 'prior RTH high', 'among rejections, the prior day first');
});

test('round numbers: the multiples of the family\'s step inside the candle\'s range; none without a step', () => {
  const b = bars('2026-06-15T13:30:00Z', 10, 3, () => 100);
  // The 15m candle 09:30-09:45: o 100, h 101, l 99, c 100.5.
  assert.ok(Object.keys(CF.briefingCandles({ bars: b, base: 3, roundStep: 1, timeframes: [15] })['15m'].levels).includes('round number 100'));
  assert.ok(!Object.keys(CF.briefingCandles({ bars: b, base: 3, roundStep: null, timeframes: [15] })['15m'].levels).some(n => /^round number/.test(n)));
});
