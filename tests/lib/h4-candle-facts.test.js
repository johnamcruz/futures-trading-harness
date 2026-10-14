'use strict';

// Scenario 2's first facts (docs/COMPOSED-ENTRY.md section 8, items 1 and 2): the 4h candle facts (candle-facts.js,
// TIMEFRAMES with 240: shape, pattern, the levels it met, its sweep of the previous 4h candle) and the 4h swing targets.
// The 4h grid from the 18:00 ET open (the session's last candle runs into the daily break and completes on the next
// session's first bar), causality (a 4h candle is a fact only once COMPLETED; bars cut at a bar's close give the same
// fact), and the bytes it adds to the rendered briefing.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const CF = require('../../scripts/lib/trading/candle-facts');
const B = require('../../scripts/lib/trading/briefing');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { defaultRoundSteps } = require('../../scripts/lib/trading/round-numbers');

const MIN = 60000;
const ET_OFFSET_EDT = 4 * 60; // minutes UTC is ahead of ET in June

/** 3m bars over [from, to) (ISO), skipping the daily break (17:00-18:00 ET, EDT) and anything `skip` names. */
function sessionBars(from, to, { step = 3, price = () => 100, skip = () => false } = {}) {
  const out = [];
  for (let t = Date.parse(from); t < Date.parse(to); t += step * MIN) {
    const et = ((new Date(t).getUTCHours() * 60 + new Date(t).getUTCMinutes() - ET_OFFSET_EDT) + 1440) % 1440;
    if (et >= 17 * 60 && et < 18 * 60) continue;
    if (skip(t)) continue;
    const p = price(t);
    out.push({ t: new Date(t).toISOString(), o: p, h: p + 1, l: p - 1, c: p + 0.5, v: 100 });
  }
  return out;
}

test('4h candles: the 18:00 ET grid; the session\'s last one (14:00 ET) completes on the next session\'s first bar', () => {
  // Sunday 2026-06-14 18:00 ET (22:00Z) to Monday 18:30 ET: Monday's session, then the break, then Tuesday's open.
  const b = sessionBars('2026-06-14T22:00:00Z', '2026-06-15T22:30:00Z');
  const s = CF.completedSeries(b, 240, 3);
  assert.ok(s.available);
  // 18:00, 22:00, 02:00, 06:00, 10:00, 14:00 ET.
  assert.deepStrictEqual(s.candles.map(c => c.t), ['2026-06-14T22:00:00.000Z', '2026-06-15T02:00:00.000Z', '2026-06-15T06:00:00.000Z',
    '2026-06-15T10:00:00.000Z', '2026-06-15T14:00:00.000Z', '2026-06-15T18:00:00.000Z']);
  // The 14:00 ET candle holds the bars up to the break; its close is the 18:00 ET boundary.
  const last = s.candles[5];
  assert.strictEqual(last.closedAt, '2026-06-15T22:00:00.000Z');
  assert.strictEqual(b[last.last].t, '2026-06-15T20:57:00.000Z', 'its last bar opens 16:57 ET');
  // Not complete on its own last bar (no clock says the session is over), only on the next session's first bar.
  const lastBar = b.findIndex(x => x.t === '2026-06-15T20:57:00.000Z');
  assert.strictEqual(s.candles[s.lastAt[lastBar]].t, '2026-06-15T14:00:00.000Z', 'the 10:00 ET candle');
  assert.strictEqual(s.candles[s.lastAt[lastBar + 1]].t, '2026-06-15T18:00:00.000Z', 'the 18:00 ET bar completes it');
  // A 4h candle that closes on its boundary is complete on that bar: 10:00-14:00 ET on the 13:57 ET bar.
  const k = b.findIndex(x => x.t === '2026-06-15T17:57:00.000Z');
  assert.strictEqual(s.candles[s.lastAt[k]].t, '2026-06-15T14:00:00.000Z');
  assert.strictEqual(s.candles[s.lastAt[k - 1]].t, '2026-06-15T10:00:00.000Z', 'never the one forming');
});

test('4h candles across the weekend and DST: Friday\'s last one completes on Sunday\'s open; the grid follows ET', () => {
  // Friday 2026-10-30 (EDT) from 10:00 ET to the daily break, then Sunday 2026-11-01 (EST) from 18:00 ET (23:00Z).
  const fri = sessionBars('2026-10-30T14:00:00Z', '2026-10-30T21:00:00Z');
  const sun = Array.from({ length: 90 }, (_, i) => ({ t: new Date(Date.parse('2026-11-01T23:00:00Z') + i * 3 * MIN).toISOString(), o: 100, h: 101, l: 99, c: 100.5, v: 100 }));
  const all = [...fri, ...sun];
  const s = CF.completedSeries(all, 240, 3);
  assert.deepStrictEqual(s.candles.map(c => [c.t, c.closedAt]), [
    ['2026-10-30T14:00:00.000Z', '2026-10-30T18:00:00.000Z'],
    ['2026-10-30T18:00:00.000Z', '2026-10-30T22:00:00.000Z'],
    ['2026-11-01T23:00:00.000Z', '2026-11-02T03:00:00.000Z'],
  ]);
  assert.strictEqual(s.lastAt[fri.length - 1], 0, 'Friday\'s 14:00 ET candle is not complete on Friday');
  assert.strictEqual(s.lastAt[fri.length], 1, 'Sunday\'s first bar completes it');
  // The briefing on Sunday's first bar: Friday's 14:00 ET candle, closed at its 18:00 ET boundary.
  const out = CF.briefingCandles({ bars: all.slice(0, fri.length + 1), base: 3, timeframes: [240] })['4h'];
  assert.strictEqual(out.t, '2026-10-30T18:00:00.000Z');
  assert.strictEqual(out.closedAt, '2026-10-30T22:00:00.000Z');
});

test('prevSweep: traded beyond the previous candle\'s high or low, closed back inside or beyond', () => {
  const prev = { o: 100, h: 104, l: 98, c: 102 };
  assert.deepStrictEqual(CF.prevSweep({ o: 101, h: 103, l: 97, c: 100 }, prev), { side: 'low', closedBack: true, closedBeyond: null });
  assert.deepStrictEqual(CF.prevSweep({ o: 101, h: 103, l: 96, c: 97.5 }, prev), { side: 'low', closedBack: false, closedBeyond: 'low' });
  assert.deepStrictEqual(CF.prevSweep({ o: 101, h: 105, l: 99, c: 103 }, prev), { side: 'high', closedBack: true, closedBeyond: null });
  assert.deepStrictEqual(CF.prevSweep({ o: 101, h: 105, l: 97, c: 104.5 }, prev), { side: 'both', closedBack: false, closedBeyond: 'high' });
  assert.deepStrictEqual(CF.prevSweep({ o: 101, h: 105, l: 97, c: 97.5 }, prev), { side: 'both', closedBack: false, closedBeyond: 'low' });
  // A close on the previous extreme is not back inside.
  assert.deepStrictEqual(CF.prevSweep({ o: 101, h: 103, l: 97, c: 98 }, prev), { side: 'low', closedBack: false, closedBeyond: 'low' });
  // Equal to the extreme is no sweep; no previous candle, none.
  assert.strictEqual(CF.prevSweep({ o: 101, h: 104, l: 98, c: 100 }, prev), null);
  assert.strictEqual(CF.prevSweep({ o: 101, h: 105, l: 97, c: 100 }, null), null);
  assert.deepStrictEqual(CF.SWEEP_FRAMES, [240]);
});

// Monday 2026-06-15: the 06:00-10:00 ET candle holds 99-101; the 10:00-14:00 ET candle trades to 96 at 11:00 ET and
// closes back at 100.5: a sweep of the prior 4h low, closed back inside.
const sweepDay = () => sessionBars('2026-06-14T22:00:00Z', '2026-06-15T18:30:00Z', {
  price: t => (t === Date.parse('2026-06-15T15:00:00Z') ? 98 : 100),
}).map(x => (x.t === '2026-06-15T15:00:00.000Z' ? { ...x, l: 96, c: 99 } : x));

test('the briefing\'s 4h candle: the sweep of the prior 4h low and the close back, its relation, and the summary line', () => {
  const b = sweepDay();
  const h4 = CF.briefingCandles({ bars: b, base: 3 })['4h'];
  assert.strictEqual(h4.t, '2026-06-15T14:00:00.000Z');
  assert.strictEqual(h4.l, 96);
  assert.strictEqual(h4.c, 100.5);
  assert.deepStrictEqual(h4.sweep, { of: 'previous 4h low', closedBack: true, closedBeyond: null });
  assert.strictEqual(h4.levels['previous 4h low'], 'rejected: closed back above');
  // Only the 4h states a sweep; the other timeframes keep their relation to "previous <tf> low".
  const all = CF.briefingCandles({ bars: b, base: 3 });
  for (const tf of ['3m', '15m', '1h']) assert.ok(!('sweep' in all[tf]), tf);
  // A 4h candle without a sweep says so (null), never leaves it out.
  const quiet = CF.briefingCandles({ bars: sessionBars('2026-06-14T22:00:00Z', '2026-06-15T18:30:00Z'), base: 3 })['4h'];
  assert.strictEqual(quiet.sweep, null);
  // The rendered summary line.
  const brief = B.buildBriefing({ symbol: 'MNQ', bars: b, minutes: 3, roundSteps: defaultRoundSteps(), now: new Date('2026-06-15T18:30:00Z') });
  const text = B.renderBriefing(brief, { now: new Date('2026-06-15T18:30:00Z') });
  assert.match(text, /^- 4h \(closed 14:00\): [^\n]*; swept the previous 4h low, closed back inside its range; /m);
  // Its relation to the previous 4h low may be past the four levels listed (rejected levels sort by level first): the
  // sweep is stated on its own, so the read never depends on that cut.
  assert.ok(!('previous 4h low' in brief.sections.m3.data.candles['4h'].levels));
  assert.deepStrictEqual(brief.sections.m3.data.candles['4h'].sweep, { of: 'previous 4h low', closedBack: true, closedBeyond: null });
});

test('the summary: a sweep only when the close is back inside; else the side it closed beyond', () => {
  const line = sweep => B.renderBriefing({ symbol: 'MNQ', minutes: 3, asOf: '2026-06-15T18:27:00.000Z', closedAt: '2026-06-15T18:30:00.000Z', price: 100, sections: { m3: { version: 'v', validUntil: '2026-06-15T18:33:00.000Z', data: { candles: { '4h': { closedAt: '2026-06-15T18:00:00.000Z', pattern: 'none', closeLocation: null, rangeAtr: null, volRatio: null, levels: {}, sweep } } } } } }, { now: new Date('2026-06-15T18:30:00Z') }).split('\n').find(l => l.startsWith('- 4h'));
  assert.match(line({ of: 'previous 4h low', closedBack: true, closedBeyond: null }), /; swept the previous 4h low, closed back inside its range\.$/);
  assert.match(line({ of: 'previous 4h low', closedBack: false, closedBeyond: 'low' }), /; traded beyond the previous 4h low, closed below its low\.$/);
  assert.match(line({ of: 'previous 4h high and low', closedBack: false, closedBeyond: 'high' }), /; traded beyond the previous 4h high and low, closed above its high\.$/);
  assert.ok(!/swept/.test(line({ of: 'previous 4h high', closedBack: false, closedBeyond: 'high' })));
  assert.strictEqual(line(null), '- 4h (closed 14:00): none.');
});

test('a 4h candle is a fact only once completed: rebuilt with the bars cut at each bar\'s close, the same fact', () => {
  const b = sweepDay();
  const s = CF.completedSeries(b, 240, 3);
  for (let i = 300; i < b.length; i += 7) {
    const cut = b.slice(0, i + 1);
    const out = CF.briefingCandles({ bars: cut, base: 3, timeframes: [240] })['4h'];
    const j = s.lastAt[i];
    const c = s.candles[j];
    // The candle the full bars say was the last completed at bar i, closed by then, and nothing later.
    assert.strictEqual(out.t, c.t, `bar ${i}`);
    assert.ok(Date.parse(out.closedAt) <= Date.parse(b[i].t) + 3 * MIN, `bar ${i}: closed by the bar's close`);
    assert.deepStrictEqual([out.o, out.h, out.l, out.c], [c.o, c.h, c.l, c.c], `bar ${i}`);
    assert.deepStrictEqual(out.sweep, (o => (o ? { of: `previous 4h ${o.side === 'both' ? 'high and low' : o.side}`, closedBack: o.closedBack, closedBeyond: o.closedBeyond } : null))(CF.prevSweep(c, s.candles[j - 1] || null)), `bar ${i}`);
    // Bars after bar i, however wild, never change the candle the series says was completed by bar i.
    const wild = [...cut, ...b.slice(i + 1).map(x => ({ ...x, h: x.h + 40, l: x.l - 40, c: x.c + 7 }))];
    const ws = CF.completedSeries(wild, 240, 3);
    const w = ws.candles[ws.lastAt[i]];
    assert.deepStrictEqual([w.t, w.o, w.h, w.l, w.c], [out.t, out.o, out.h, out.l, out.c], `bar ${i}`);
  }
});

const BARS = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));

test('4h swing targets: in swingTargets, as the 4h series says at the bar, unchanged by later bars', () => {
  const n = BARS.length;
  const full = CF.swingTargetSeries(BARS, 240, 3);
  assert.ok(full.available);
  let seen = 0;
  for (const i of [n - 1, n - 200, n - 600, n - 1100]) {
    const cut = BARS.slice(0, i + 1);
    const part = CF.swingTargetSeries(cut, 240, 3);
    assert.ok(Object.is(part.high[i], full.high[i]) && Object.is(part.low[i], full.low[i]), `bar ${i}`);
    const t = CF.briefingTargets({ bars: cut, minutes: 3, price: cut[i].c, oneR: 10, tick: 0.25 });
    for (const [list, p] of [[t.above, full.high[i]], [t.below, full.low[i]]]) {
      const h4 = list.find(x => x.frame === '4h');
      if (Number.isFinite(p)) { seen += 1; assert.strictEqual(h4 && h4.price, p, `bar ${i}`); } else assert.strictEqual(h4, undefined);
    }
  }
  assert.ok(seen > 0, 'the fixture has a 4h swing target');
  // The briefing passes 4h with the other frames.
  const brief = B.buildBriefing({ symbol: 'NQ', bars: BARS, minutes: 3, roundSteps: defaultRoundSteps() });
  const st = brief.sections.m3.data.swingTargets;
  assert.ok([...st.above, ...st.below].some(x => x.frame === '4h'));
});

// The bytes the 4h facts add to the rendered briefing (the tool's text: docs/COMPOSED-ENTRY.md section 8). The head
// trader's prompt doesn't carry the briefing; the skills that describe it stay within their bytes (no prompt growth).
const H4_RENDER_BUDGET = 600;

test('byte budget: the 4h candle and targets add at most H4_RENDER_BUDGET bytes to the rendered briefing', () => {
  const brief = B.buildBriefing({ symbol: 'NQ', bars: BARS, minutes: 3, roundSteps: defaultRoundSteps() });
  const now = new Date(brief.closedAt);
  const without = JSON.parse(JSON.stringify(brief));
  const m3 = without.sections.m3.data;
  delete m3.candles['4h'];
  m3.swingTargets = { above: m3.swingTargets.above.filter(x => x.frame !== '4h'), below: m3.swingTargets.below.filter(x => x.frame !== '4h') };
  const added = Buffer.byteLength(B.renderBriefing(brief, { now })) - Buffer.byteLength(B.renderBriefing(without, { now }));
  assert.ok(added > 0, 'the 4h facts are rendered');
  assert.ok(added <= H4_RENDER_BUDGET, `${added} bytes added`);
});
