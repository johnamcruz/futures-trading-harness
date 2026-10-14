'use strict';

// 5m structure (scripts/lib/trading/m5-structure.js; docs/COMPOSED-ENTRY.md section 8, item 4): the latest BOS or
// CHoCH and the last swings on completed 5m candles, from base bars that divide 5m or a 1m lane's bars (no 5m lane),
// unavailable with why otherwise (never approximated); causality (as of a bar, the bars after it change nothing; a
// break is known only at its candle's close), and the bytes it adds to the rendered briefing.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { structure5m, structureLine, RECENT } = require('../../scripts/lib/trading/m5-structure');
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

// The 5m line's bytes in the rendered briefing (event-driven: only a recent break): on the fixture with a 1m lane's bars
// at every 20th bar, at most M5_RENDER_BUDGET on any bar and M5_TYPICAL_BUDGET on average.
const M5_RENDER_BUDGET = 160;
const M5_TYPICAL_BUDGET = 60;

test('knownAt is when the breaking candle was known complete: its last 1m bar missing, the next bar\'s close', () => {
  // The 1m bar 10:44 ET (the breaking candle's last) is missing: the 10:40 candle completes on the 10:45 bar, at 10:46.
  // Its 10:43 bar closes at 106 (above the swing high), so the candle still breaks without its last bar.
  const gap = ONE.filter(b => b.t !== new Date(END - MIN).toISOString()).map(b => (b.t === new Date(END - 2 * MIN).toISOString() ? { ...b, c: 106, h: Math.max(b.h, 106) } : b));
  const next = { t: new Date(END).toISOString(), o: 106, h: 106.5, l: 105.5, c: 106, v: 100 };
  const s = structure5m({ bars: [...gap, next], base: 1 });
  assert.strictEqual(s.lastBreak.last.at, at(14));
  assert.strictEqual(s.lastBreak.last.knownAt, new Date(END + MIN).toISOString());
  // Without the missing bar, its own close.
  assert.strictEqual(structure5m({ bars: ONE, base: 1 }).lastBreak.last.knownAt, new Date(END).toISOString());
});

test('structureLine: only a break at most RECENT candles old; unavailable only when 1m bars are configured', () => {
  const s = structure5m({ bars: base3(), base: 3, fine: ONE });
  const et = x => x.slice(11, 16);
  assert.strictEqual(structureLine(s, et), '- 5m structure: BOS up through 105 (known 14:45, 0 candles ago); swing high 105, swing low 94.');
  const old = { ...s, lastBreak: { last: { ...s.lastBreak.last, barsAgo: RECENT + 1 }, previous: null } };
  assert.strictEqual(structureLine(old, et), null);
  assert.strictEqual(structureLine({ ...s, lastBreak: { last: null, previous: null } }, et), null);
  assert.strictEqual(structureLine(structure5m({ bars: base3(), base: 3 })), null, 'no 1m lane: nothing to say');
  assert.match(structureLine(structure5m({ bars: base3(), base: 3, fine: ONE.slice(0, -12) })), /^- 5m structure: unavailable \(the 1m bars stop at /);
});

test('the briefing\'s structure5m: unavailable without 1m bars, built with them; the line within its byte budgets', () => {
  const steps = defaultRoundSteps();
  const none = B.buildBriefing({ symbol: 'NQ', bars: BARS, minutes: 3, roundSteps: steps });
  assert.match(none.sections.m3.data.structure5m.unavailable, /no 1m bars configured/);
  const brief = B.buildBriefing({ symbol: 'NQ', bars: BARS, minutes: 3, fineBars: FINE, roundSteps: steps });
  const d = brief.sections.m3.data.structure5m;
  assert.strictEqual(d.source, '1m bars');
  assert.deepStrictEqual(d, structure5m({ bars: BARS, base: 3, fine: FINE }));
  const added = b => {
    const now = new Date(b.closedAt);
    const without = JSON.parse(JSON.stringify(b));
    delete without.sections.m3.data.structure5m;
    return Buffer.byteLength(B.renderBriefing(b, { now })) - Buffer.byteLength(B.renderBriefing(without, { now }));
  };
  const sizes = [];
  for (let i = 400; i < BARS.length; i += 20) sizes.push(added(B.buildBriefing({ symbol: 'NQ', bars: BARS.slice(0, i + 1), minutes: 3, fineBars: FINE, roundSteps: steps })));
  const typical = sizes.reduce((x, y) => x + y, 0) / sizes.length;
  const worst = Math.max(...sizes);
  assert.ok(worst > 0, 'a recent break shows somewhere');
  assert.ok(worst <= M5_RENDER_BUDGET, `worst ${worst} bytes`);
  assert.ok(typical <= M5_TYPICAL_BUDGET, `typical ${typical} bytes`);
});
