'use strict';

// The prior candle's range as targets, one fact (candle-facts.js briefingRangeTargets, the briefing's m3.rangeTargets):
// per 1h and 4h, the last COMPLETED candle's high, mid and low with side, points, ticks and R; and, only when it
// happened, the side the candle forming since has taken (the shared prevSweep) and whether this bar closed back
// inside. Causal; one capped summary line. Also the half of the session's range (m3.location.sessionRangeHalf).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { normalizeBars } = require('../../scripts/lib/trading/indicators');
const { briefingRangeTargets, prevSweep } = require('../../scripts/lib/trading/candle-facts');
const { halfOf } = require('../../scripts/lib/trading/fib');
const B = require('../../scripts/lib/trading/briefing');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { snapshot } = require('../../scripts/lib/trading/market-snapshot');

// 2026-10-07 is EDT (UTC-4): 09:00 ET = 13:00 UTC.
const et = (h, m = 0) => Date.UTC(2026, 9, 7, h + 4, m);
const mk = rows => normalizeBars(rows.map(([t, o, h, l, c]) => ({ t: new Date(t).toISOString(), o, h, l, c, v: 100 })));
const flat = (from, to, c) => {
  const rows = [];
  for (let t = from; t < to; t += 180000) rows.push([t, c, c + 2, c - 2, c]);
  return rows;
};
const idx = (bars, ms) => bars.findIndex(b => Date.parse(b.t) === ms);

/** The 10:00 hour: 21480 to 21540 (mid 21510); the 11:00 hour from 21490, its 11:06 bar takes 21470 and closes back. */
function hours(extra = []) {
  const a = flat(et(10, 0), et(11, 0), 21500);
  a[3][2] = 21540;
  a[7][3] = 21480;
  const b = flat(et(11, 0), et(11, 30), 21490);
  b[2][3] = 21470;
  return mk([...a, ...b, ...extra]);
}
const at = (bars, i) => briefingRangeTargets({ bars, base: 3, price: bars[i].c, oneR: 5, index: i });

test('the last completed hour\'s high, mid and low as targets, with side, points, ticks and R; 4h when it has one', () => {
  const bars = hours();
  const x = at(bars, idx(bars, et(11, 3)))['1h'];
  assert.deepStrictEqual([x.t, x.closedAt], [new Date(et(10, 0)).toISOString(), new Date(et(11, 0)).toISOString()]);
  assert.deepStrictEqual(x.high, { price: 21540, side: 'above', points: 50, ticks: 200, R: 10 });
  assert.deepStrictEqual(x.mid, { price: 21510, side: 'above', points: 20, ticks: 80, R: 4 });
  assert.deepStrictEqual(x.low, { price: 21480, side: 'below', points: 10, ticks: 40, R: 2 });
  assert.ok(!('taken' in x), 'nothing taken yet: no key');
  assert.match(at(bars, idx(bars, et(11, 3)))['4h'].unavailable, /no completed candle/);
  assert.strictEqual(briefingRangeTargets({ bars, base: 3, price: 1, oneR: NaN })['1h'].high.R, null, 'no 1R: R unknown');
});

test('taken, only when it happened: the side the candle forming since took, closed back inside or beyond; both sides is none', () => {
  const bars = hours();
  assert.deepStrictEqual(at(bars, idx(bars, et(11, 6)))['1h'].taken, { side: 'low', closedBack: true });
  const beyond = hours([[et(11, 30), 21490, 21491, 21470, 21475]]);
  assert.deepStrictEqual(at(beyond, beyond.length - 1)['1h'].taken, { side: 'low', closedBack: false });
  const both = hours([[et(11, 30), 21490, 21545, 21488, 21500]]);
  assert.ok(!('taken' in at(both, both.length - 1)['1h']));
  // On the bar that completes an hour, no candle is forming: nothing taken.
  const whole = hours(flat(et(11, 30), et(12, 0), 21490));
  assert.ok(!('taken' in at(whole, whole.length - 1)['1h']));
  // The side and the close are prevSweep's own reading.
  assert.deepStrictEqual(prevSweep({ h: 21492, l: 21470, c: 21490 }, { h: 21540, l: 21480 }), { side: 'low', closedBack: true, closedBeyond: null });
});

const NQ = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));

test('no look-ahead: the range targets at a bar are the same with the later bars present or cut at its close', () => {
  let taken = 0;
  for (let i = 100; i < NQ.length; i += 13) {
    const full = at(NQ, i);
    assert.deepStrictEqual(full, at(NQ.slice(0, i + 1), i), `bar ${i}`);
    taken += Object.values(full).filter(x => x.taken).length;
  }
  assert.ok(taken > 20, `taken on the golden days (${taken})`);
});

test('in the briefing: one summary line (high, mid, low per frame; the taken side only when it happened) within its cap; never in the detail; the session range half', () => {
  const RANGE_LINE_MAX = 400;
  let most = 0;
  let typical = 0;
  let n = 0;
  for (let k = 200; k <= NQ.length; k += 31) {
    const bars = NQ.slice(0, k);
    const b = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3, blackouts: { items: [] } });
    const d = b.sections.m3.data;
    const ref = briefingRangeTargets({ bars: normalizeBars(bars), base: 3, price: d.price, oneR: d.oneR.points, tick: 0.25 });
    // The briefing's R is its own (unrounded) reference stop: compare prices and the taken side, not the R.
    const shape = r => Object.fromEntries(Object.entries(r).map(([tf, x]) => [tf, x.unavailable ? x : [x.high.price, x.mid.price, x.low.price, x.taken || null]]));
    assert.deepStrictEqual(shape(d.rangeTargets), shape(ref));
    const text = B.renderBriefing(b, { now: new Date(b.closedAt) });
    const line = text.split('\n').find(l => l.startsWith('- Prior candle range: '));
    assert.ok(line, `bar ${k - 1}`);
    for (const [tf, x] of Object.entries(d.rangeTargets)) {
      if (x.unavailable) continue;
      assert.ok(line.includes(`${tf} (closed `));
      assert.strictEqual(line.includes(`${tf} (closed `) && new RegExp(`${tf} \\(closed [^;]*taken`).test(line), Boolean(x.taken), `bar ${k - 1} ${tf}`);
    }
    assert.doesNotMatch(text, /rangeTargets/, 'not in the detail');
    most = Math.max(most, Buffer.byteLength(line));
    typical += Buffer.byteLength(line);
    n += 1;
    const s = (snapshot({ bars }).context || {}).session;
    assert.strictEqual(d.location.sessionRangeHalf, s ? halfOf({ origin: s.low, extreme: s.high }, d.price) : null);
  }
  assert.ok(most <= RANGE_LINE_MAX, `the line is at most ${most} bytes (mean ${Math.round(typical / n)})`);
  const f = B.buildFrameBriefing({ symbol: 'NQ', bars: B.wholeBars(NQ.slice(0, 900), 15), minutes: 15, first: B.buildBriefing({ symbol: 'NQ', bars: NQ.slice(0, 900), minutes: 3, blackouts: { items: [] } }) });
  assert.ok(!('rangeTargets' in f.sections.bar.data), 'a frame points to the runner\'s');
});
