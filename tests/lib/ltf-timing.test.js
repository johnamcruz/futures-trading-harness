'use strict';

// The base timeframe's timing against the side the 4h and 1h agree on (scripts/lib/trading/ltf-timing.js): its
// states, from closed bars only, and the briefing's summary line.

const test = require('node:test');
const assert = require('node:assert');
const { timingOf, timingLine, sideOf } = require('../../scripts/lib/trading/ltf-timing');
const { buildBriefing } = require('../../scripts/lib/trading/briefing');
const { breaksOf } = require('../../scripts/lib/trading/structure-events');

const STEP = 180000;
const T0 = Date.parse('2026-04-27T14:00:00.000Z');
const bars = n => Array.from({ length: n }, (_, i) => ({ t: new Date(T0 + i * STEP).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 1 }));
const B = bars(40);
const brk = (i, direction, kind = 'BOS') => ({ kind, direction, level: 1, at: B[i].t, i });
const UP = { '4h': 'up', '1h': 'up' };
const et = iso => new Date(iso).toISOString().slice(11, 16);

test('sideOf: the side the 4h and the 1h agree on; any disagreement or unknown: none', () => {
  assert.strictEqual(sideOf(UP), 'long');
  assert.strictEqual(sideOf({ '4h': 'down', '1h': 'down' }), 'short');
  for (const t of [{ '4h': 'up', '1h': 'range' }, { '4h': 'range', '1h': 'up' }, { '4h': 'up', '1h': 'down' }, { '4h': 'up' }, null]) assert.strictEqual(sideOf(t), null, JSON.stringify(t));
});

test('timingOf: with (the base regime the side\'s way), turned (its latest event after the latest against), else pullback since that break', () => {
  const at = o => timingOf({ trends: UP, regime: 'range', bars: B, minutes: 3, breaks: [], ...o });
  assert.deepStrictEqual(at({ regime: 'trend-up', breaks: [brk(30, 'down')] }), { side: 'long', state: 'with' });
  // A break down, then a CHoCH up after it: turned, at that bar, its age in bars.
  assert.deepStrictEqual(at({ breaks: [brk(20, 'down'), brk(30, 'up', 'CHoCH')] }), { side: 'long', state: 'turned', kind: 'CHoCH', dir: 'up', at: B[30].t, barsAgo: 9 });
  // The break against is the latest: the pullback, since it.
  assert.deepStrictEqual(at({ breaks: [brk(20, 'up'), brk(30, 'down')] }), { side: 'long', state: 'pullback', since: B[30].t });
  assert.deepStrictEqual(at({ regime: 'trend-down', breaks: [] }), { side: 'long', state: 'pullback', since: null }, 'no break known');
  // The base compression break the side's way after the break against: turned by it.
  const comp = { state: 'expanding', break: { dir: 'up', closedAt: new Date(T0 + 36 * STEP).toISOString(), barsAgo: 4 } };
  assert.deepStrictEqual(at({ breaks: [brk(30, 'down')], compression: comp }), { side: 'long', state: 'turned', kind: 'compression break', dir: 'up', at: B[35].t, barsAgo: 4 });
  // A compression break the other way, or before the break against, doesn't turn it.
  assert.strictEqual(at({ breaks: [brk(30, 'down')], compression: { break: { ...comp.break, dir: 'down' } } }).state, 'pullback');
  assert.strictEqual(at({ breaks: [brk(38, 'down')], compression: comp }).state, 'pullback');
  // Shorts mirror it.
  assert.deepStrictEqual(timingOf({ trends: { '4h': 'down', '1h': 'down' }, regime: 'range', bars: B, minutes: 3, breaks: [brk(20, 'up'), brk(25, 'down')] }), { side: 'short', state: 'turned', kind: 'BOS', dir: 'down', at: B[25].t, barsAgo: 14 });
  // No agreed side: nothing to time.
  assert.strictEqual(timingOf({ trends: { '4h': 'up', '1h': 'range' }, regime: 'trend-up', bars: B, minutes: 3 }), null);
  assert.strictEqual(timingOf({ trends: UP, bars: [], minutes: 3 }), null);
});

test('timingLine: one short line per state, its timeframe named', () => {
  assert.strictEqual(timingLine(null, et, '3m'), null);
  assert.strictEqual(timingLine({ side: 'long', state: 'with' }, et, '3m'), '- 3m timing (long: the 4h and 1h up): 3m with the HTF side.');
  assert.strictEqual(timingLine({ side: 'long', state: 'turned', kind: 'CHoCH', dir: 'up', at: B[30].t, barsAgo: 9 }, et, '3m'), '- 3m timing (long: the 4h and 1h up): 3m turned back: CHoCH up at 15:30 ET (9 bars ago).');
  assert.strictEqual(timingLine({ side: 'short', state: 'pullback', since: B[30].t }, et, '3m'), '- 3m timing (short: the 4h and 1h down): 3m pullback: trending against the HTF side since 15:30 ET.');
  assert.strictEqual(timingLine({ side: 'long', state: 'pullback', since: null }, et, '3m'), '- 3m timing (long: the 4h and 1h up): 3m pullback: trending against the HTF side.');
});

test('the briefing: m3.timing from the closed bars it is built on (no look-ahead: later bars never change it), and its summary line', () => {
  // Sixteen days rising (the 4h and 1h up), then a dip of 40 bars and the rise again: every state in turn.
  const t0 = Date.parse('2022-02-20T00:00:00.000Z');
  const n = (16 * 86400000) / STEP;
  let p = 20000;
  const all = Array.from({ length: n }, (_, i) => {
    const d = i > n - 120 && i <= n - 80 ? -1.5 : 0.5;
    p += d;
    const c = p + (i % 2 ? 1 : -1);
    return { t: new Date(t0 + i * STEP).toISOString(), o: c - d, h: c + 2, l: c - 2, c, v: 100 };
  });
  const seen = new Set();
  for (const k of [n - 130, n - 100, n - 82, n - 70, n - 40, n]) {
    const upTo = all.slice(0, k);
    const b = buildBriefing({ symbol: 'MNQ', bars: upTo, minutes: 3, now: new Date(Date.parse(upTo[k - 1].t) + STEP) });
    const m3 = b.sections.m3.data;
    const h = b.sections.h1.data;
    const want = timingOf({ trends: { '4h': h.h4.trend, '1h': h.h1.trend }, regime: m3.regime.primary, bars: upTo, minutes: 3, breaks: breaksOf(upTo), compression: typeof m3.compression['3m'] === 'object' ? m3.compression['3m'] : null });
    assert.deepStrictEqual(m3.timing, want, `bar ${k}`);
    if (want) seen.add(want.state);
    // Every time it names is a closed bar's (no look-ahead): at or before the last bar given.
    for (const x of [want && want.at, want && want.since].filter(Boolean)) assert.ok(Date.parse(x) <= Date.parse(upTo[k - 1].t), x);
    // The same bar with different bars after it (none are given to the briefing): the same timing.
    if (k < all.length) {
      const later = buildBriefing({ symbol: 'MNQ', bars: all.slice(0, k), minutes: 3, now: new Date(Date.parse(upTo[k - 1].t) + STEP) });
      assert.deepStrictEqual(later.sections.m3.data.timing, m3.timing);
    }
    const lines = require('../../scripts/lib/trading/briefing').renderBriefing(b, { now: new Date(b.closedAt) });
    assert.strictEqual(/- 3m timing \((long|short): the 4h and 1h (up|down)\): 3m (with the HTF side|turned back|pullback)/.test(lines), Boolean(want), `bar ${k}`);
  }
  assert.deepStrictEqual([...seen].sort(), ['pullback', 'turned', 'with'], 'each state met on the way');
});
