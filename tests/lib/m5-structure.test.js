'use strict';

// 5m structure (scripts/lib/trading/m5-structure.js; docs/COMPOSED-ENTRY.md section 8, item 4): the latest BOS or
// CHoCH and the last swings on completed 5m candles, from base bars that divide 5m or a 1m lane's bars (no 5m lane),
// unavailable with why otherwise (never approximated); causality (as of a bar, the bars after it change nothing; a
// break is known only at its candle's close), and the bytes it adds to the rendered briefing.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { structure5m } = require('../../scripts/lib/trading/m5-structure');
const { lastBreaks } = require('../../scripts/lib/trading/structure-events');
const B = require('../../scripts/lib/trading/briefing');
const G = require('../fixtures/golden-bars');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { defaultRoundSteps } = require('../../scripts/lib/trading/round-numbers');

const MIN = 60000;
const T0 = Date.parse('2026-06-15T13:30:00Z'); // 09:30 ET

/** 1m bars making the given 5m candles: open on the first, the high on the second, the low on the third, close on the last. */
function minuteBars(candles) {
  const out = [];
  candles.forEach(([o, h, l, c], k) => {
    for (let i = 0; i < 5; i += 1) {
      const t = new Date(T0 + (k * 5 + i) * MIN).toISOString();
      const open = i === 0 ? o : (o + c) / 2;
      const close = i === 4 ? c : (o + c) / 2;
      out.push({ t, o: open, h: i === 1 ? h : Math.max(open, close), l: i === 2 ? l : Math.min(open, close), c: close, v: 100 });
    }
  });
  return out;
}

// Six flat candles, a swing high (105) confirmed two candles later, a swing low (94), then a close above 105: a break
// up. 15 candles, so the last closes at 10:45 ET, on the 3m grid too.
const CANDLES = [
  ...Array.from({ length: 6 }, () => [100, 101, 99, 100]),
  [100, 102, 99.5, 101], [101, 105, 100.5, 104], [104, 104.5, 101, 102], [102, 103, 98, 99],
  [99, 100, 94, 95], [95, 98, 94.5, 97], [97, 99, 95, 98.5], [98.5, 99.5, 96, 99], [99, 106.5, 98, 106],
];
const ONE = minuteBars(CANDLES);
const END = T0 + CANDLES.length * 5 * MIN;
/** 3m base bars closing at `end` (their own prices don't matter here). */
const base3 = (end = END, n = 4) => Array.from({ length: n }, (_, i) => ({ t: new Date(end - (n - i) * 3 * MIN).toISOString(), o: 100, h: 101, l: 99, c: 100, v: 1 }));
const at = k => new Date(T0 + k * 5 * MIN).toISOString();

test('3m bars without a 1m lane: unavailable, with why; never approximated', () => {
  assert.deepStrictEqual(structure5m({ bars: base3(), base: 3 }), { unavailable: 'not whole 3m bars; no 1m bars configured (never approximated)' });
});

test('from a 1m lane\'s bars: the break up through the 5m swing high, known at its candle\'s close; the last swings', () => {
  const s = structure5m({ bars: base3(), base: 3, fine: ONE });
  assert.strictEqual(s.source, '1m bars');
  assert.deepStrictEqual(s.lastBreak, {
    last: { kind: 'BOS', direction: 'up', level: 105, swingAt: at(7), at: at(14), barsAgo: 0, knownAt: new Date(END).toISOString() },
    previous: null,
  });
  assert.deepStrictEqual(s.swingHigh, { price: 105, at: at(7) });
  assert.deepStrictEqual(s.swingLow, { price: 94, at: at(10) });
  // One 3m bar earlier (10:42 ET close): the breaking candle is still forming, so no break yet.
  const before = structure5m({ bars: base3(END - 3 * MIN), base: 3, fine: ONE });
  assert.strictEqual(before.lastBreak.last, null);
  // The same candles on 1m base bars, and as 5m base bars: the same facts.
  assert.deepStrictEqual(structure5m({ bars: ONE, base: 1 }), s);
  const five = CANDLES.map(([o, h, l, c], k) => ({ t: at(k), o, h, l, c, v: 500 }));
  const s5 = structure5m({ bars: five, base: 5 });
  assert.deepStrictEqual({ ...s5, source: '1m bars' }, s);
  assert.strictEqual(s5.source, '5m bars');
  assert.strictEqual(s5.lastBreak.last.level, lastBreaks(five).last.level);
});

test('1m bars that stopped: no current 5m candle, so unavailable with why', () => {
  const s = structure5m({ bars: base3(), base: 3, fine: ONE.slice(0, -12) });
  assert.match(s.unavailable, /^the 1m bars stop at 2026-06-15T14:33:00.000Z: no current 5m candle \(never approximated\)$/);
});

const BARS = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
const FINE = G.toMinutes(BARS);

test('causality: as of each bar, the same as the bars cut at its close; a break is known by then', () => {
  let seen = 0;
  for (let i = 300; i < BARS.length; i += 41) {
    const s = structure5m({ bars: BARS, base: 3, fine: FINE, at: i });
    const close = Date.parse(BARS[i].t) + 3 * MIN;
    assert.deepStrictEqual(s, structure5m({ bars: BARS.slice(0, i + 1), base: 3, fine: FINE.filter(b => Date.parse(b.t) + MIN <= close) }), `bar ${i}`);
    for (const b of [s.lastBreak.last, s.lastBreak.previous].filter(Boolean)) {
      seen += 1;
      assert.ok(Date.parse(b.knownAt) <= close, `bar ${i}: known at ${b.knownAt}`);
    }
  }
  assert.ok(seen > 0, 'the fixture has 5m breaks');
});

const M5_RENDER_BUDGET = 450;

test('the briefing\'s structure5m: unavailable without 1m bars, built with them; within M5_RENDER_BUDGET bytes', () => {
  const steps = defaultRoundSteps();
  const none = B.buildBriefing({ symbol: 'NQ', bars: BARS, minutes: 3, roundSteps: steps });
  assert.match(none.sections.m3.data.structure5m.unavailable, /no 1m bars configured/);
  const brief = B.buildBriefing({ symbol: 'NQ', bars: BARS, minutes: 3, fineBars: FINE, roundSteps: steps });
  const d = brief.sections.m3.data.structure5m;
  assert.strictEqual(d.source, '1m bars');
  assert.deepStrictEqual(d, structure5m({ bars: BARS, base: 3, fine: FINE }));
  const now = new Date(brief.closedAt);
  const without = JSON.parse(JSON.stringify(brief));
  delete without.sections.m3.data.structure5m;
  const added = Buffer.byteLength(B.renderBriefing(brief, { now })) - Buffer.byteLength(B.renderBriefing(without, { now }));
  assert.ok(added > 0 && added <= M5_RENDER_BUDGET, `${added} bytes added`);
});
