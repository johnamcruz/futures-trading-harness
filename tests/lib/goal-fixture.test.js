'use strict';

const test = require('node:test');
const assert = require('node:assert');
const GF = require('../../scripts/lib/eval/goal-fixture');

const bar = (t, o, h, l, c, v = 10) => ({ t, o, h, l, c, v });

test('encodeBars / decodeBars: ticks from the bar before, gaps in base bars; the round trip is exact', () => {
  const bars = [bar('2022-01-03T14:30:00.000Z', 100, 101.25, 99.5, 100.75), bar('2022-01-03T14:33:00.000Z', 100.75, 102, 100.5, 101.5, 7), bar('2022-01-03T14:42:00.000Z', 101, 101, 100, 100.25, 3)];
  const enc = GF.encodeBars(bars, 0.25, 3);
  assert.deepStrictEqual(enc.rows[2][0], 3, 'a gap of three bars');
  assert.deepStrictEqual(GF.decodeBars(enc), bars);
  assert.throws(() => GF.encodeBars([bar('2022-01-03T14:30:00.000Z', 100.1, 101, 99, 100)], 0.25, 3), /off the 0.25 tick/);
  assert.throws(() => GF.encodeBars([bars[0], bar('2022-01-03T14:31:00.000Z', 100, 100, 100, 100)], 0.25, 3), /off the 3m grid/);
});

test('pickBlocks: seeded, the same for the same seed, non-overlapping, each half its own dates, the trend mix exact', () => {
  const days = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2022, 0, 3 + i)).toISOString().slice(0, 10));
  const trend = new Set(days.filter((_, i) => i % 3 === 0));
  const o = { trend, seed: 1, split: days[30], perHalf: 2, length: 4, trendPerHalf: 3 };
  const a = GF.pickBlocks(days, o);
  assert.deepStrictEqual(GF.pickBlocks(days, o), a);
  assert.notDeepStrictEqual(GF.pickBlocks(days, { ...o, seed: 2 }), a);
  for (const h of ['A', 'B']) {
    const mine = a.filter(b => b.half === h);
    assert.strictEqual(mine.length, 2);
    const all = mine.flatMap(b => b.sessions);
    assert.strictEqual(new Set(all).size, all.length, 'no session twice');
    assert.ok(all.every(d => (h === 'A' ? d < o.split : d >= o.split)));
    assert.strictEqual(mine.reduce((n, b) => n + b.trend.length, 0), 3, 'exactly trendPerHalf trend days');
  }
  assert.throws(() => GF.pickBlocks(days, { ...o, perHalf: 20 }), /only \d+ of 20 blocks/);
});

test('sessionDays: dates with bars in the session window that the runner trades; blockBars: the history before the first', () => {
  const bars = [bar('2022-01-03T14:30:00.000Z', 1, 1, 1, 1), bar('2022-01-04T03:00:00.000Z', 1, 1, 1, 1), bar('2022-01-04T15:00:00.000Z', 1, 1, 1, 1), bar('2022-01-05T15:00:00.000Z', 1, 1, 1, 1)];
  const session = '09:30-12:00@America/New_York';
  assert.deepStrictEqual(GF.sessionDays(bars, { from: '2022-01-01', to: '2022-02-01', session }), ['2022-01-03', '2022-01-04', '2022-01-05']);
  assert.deepStrictEqual(GF.sessionDays(bars, { from: '2022-01-01', to: '2022-02-01', session, inSession: ms => ms < Date.parse('2022-01-05T00:00:00Z') }), ['2022-01-03', '2022-01-04']);
  assert.deepStrictEqual(GF.blockBars(bars, ['2022-01-05'], { historyHours: 36, minutes: 3 }).map(b => b.t), ['2022-01-04T03:00:00.000Z', '2022-01-04T15:00:00.000Z', '2022-01-05T15:00:00.000Z']);
});

test('labelsFor: a trend day by its aligned leg, else non-trend with what the mechanical tier did; moveBlocks: near move days share a block', () => {
  const legs = new Map([['d1', [{ side: 'long', start: '2022-01-03T14:30:00.000Z', end: '2022-01-03T15:00:00.000Z', points: 40 }]]]);
  const trades = new Map([['d2', [{ R: -1.01, reason: 'stop' }]]]);
  const L = GF.labelsFor(['d1', 'd2', 'd3'], legs, trades);
  assert.deepStrictEqual(Object.values(L).map(x => x.kind), ['trend', 'non-trend', 'non-trend']);
  assert.match(L.d1.why, /PPC trend leg long 14:30-15:00 UTC \(40 pts\)/);
  assert.match(L.d2.why, /a fakeout: the first entry stopped at -1.01R/);
  assert.match(L.d3.why, /no trade/);
  const days = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.deepStrictEqual(GF.moveBlocks(days, ['h', 'a', 'c'], 2).map(b => b.sessions), [['a', 'c'], ['h']]);
});
