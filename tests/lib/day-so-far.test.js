'use strict';

// The day so far (trading/day-so-far.js): a description of the RTH morning so far from its own bars, and an RTH
// volatility against the same minutes on the prior sessions. Real bars: two recorded days (3m NQ, 09:27-10:42 ET).
const test = require('node:test');
const assert = require('node:assert');
const D = require('../../scripts/lib/trading/day-so-far');
const ind = require('../../scripts/lib/trading/indicators');
const { vwapCrosses } = require('../../scripts/lib/trading/regime');
const { RTH_OPEN_MIN, RTH_CLOSE_MIN } = require('../../scripts/lib/trading/clock');
const CFG = require('../../scripts/lib/tunables').analysis().daySoFar;

const rows = list => list.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
// 2024-05-31: the morning ran down (the 09:30-12:00 hindsight label: trend, efficiency 0.27).
const TREND = rows([
  ['2024-05-31T13:27:00Z', 18614.75, 18624.0, 18597.25, 18602.25, 5206], ['2024-05-31T13:30:00Z', 18602.0, 18615.5, 18594.5, 18599.5, 10993],
  ['2024-05-31T13:33:00Z', 18599.25, 18604.5, 18575.75, 18592.5, 10390], ['2024-05-31T13:36:00Z', 18592.25, 18617.25, 18586.25, 18604.25, 7312],
  ['2024-05-31T13:39:00Z', 18604.0, 18627.5, 18604.0, 18615.5, 6155], ['2024-05-31T13:42:00Z', 18615.5, 18631.5, 18608.75, 18618.0, 4923],
  ['2024-05-31T13:45:00Z', 18618.25, 18621.0, 18561.5, 18584.25, 10806], ['2024-05-31T13:48:00Z', 18584.75, 18593.75, 18559.5, 18567.25, 6699],
  ['2024-05-31T13:51:00Z', 18567.25, 18569.75, 18542.0, 18549.0, 6613], ['2024-05-31T13:54:00Z', 18549.0, 18558.0, 18529.0, 18545.0, 7366],
  ['2024-05-31T13:57:00Z', 18545.0, 18557.25, 18538.75, 18544.25, 4613], ['2024-05-31T14:00:00Z', 18543.5, 18545.0, 18503.5, 18512.75, 10523],
  ['2024-05-31T14:03:00Z', 18512.75, 18539.5, 18511.0, 18527.0, 5491], ['2024-05-31T14:06:00Z', 18527.25, 18548.75, 18524.25, 18541.25, 4052],
  ['2024-05-31T14:09:00Z', 18541.5, 18545.75, 18517.75, 18522.25, 4401], ['2024-05-31T14:12:00Z', 18522.0, 18525.5, 18482.25, 18489.0, 7840],
  ['2024-05-31T14:15:00Z', 18488.0, 18497.0, 18466.25, 18472.25, 9302], ['2024-05-31T14:18:00Z', 18472.0, 18486.0, 18457.75, 18473.0, 7286],
  ['2024-05-31T14:21:00Z', 18473.0, 18474.5, 18440.25, 18443.0, 7759], ['2024-05-31T14:24:00Z', 18442.5, 18442.5, 18415.0, 18436.0, 12700],
  ['2024-05-31T14:27:00Z', 18435.5, 18442.5, 18416.0, 18421.25, 7070], ['2024-05-31T14:30:00Z', 18421.0, 18421.0, 18386.25, 18397.25, 12667],
  ['2024-05-31T14:33:00Z', 18396.5, 18405.25, 18365.5, 18371.25, 9920], ['2024-05-31T14:36:00Z', 18371.5, 18395.5, 18366.75, 18383.0, 7874],
  ['2024-05-31T14:39:00Z', 18383.0, 18394.0, 18379.25, 18384.5, 5908], ['2024-05-31T14:42:00Z', 18385.0, 18385.0, 18362.75, 18370.25, 5496],
]);
// 2024-05-28: the morning rotated (hindsight label: chop, efficiency 0.003).
const CHOP = rows([
  ['2024-05-28T13:27:00Z', 18919.5, 18927.25, 18912.5, 18920.25, 2397], ['2024-05-28T13:30:00Z', 18920.25, 18936.5, 18913.75, 18920.0, 12039],
  ['2024-05-28T13:33:00Z', 18920.0, 18920.5, 18902.75, 18909.5, 8573], ['2024-05-28T13:36:00Z', 18910.25, 18910.5, 18890.25, 18892.25, 7202],
  ['2024-05-28T13:39:00Z', 18892.0, 18916.0, 18888.5, 18903.75, 7083], ['2024-05-28T13:42:00Z', 18904.5, 18907.75, 18869.0, 18872.5, 6731],
  ['2024-05-28T13:45:00Z', 18872.25, 18874.5, 18839.0, 18843.25, 11657], ['2024-05-28T13:48:00Z', 18843.5, 18861.75, 18843.0, 18860.0, 5954],
  ['2024-05-28T13:51:00Z', 18860.25, 18865.0, 18844.0, 18857.75, 5507], ['2024-05-28T13:54:00Z', 18857.75, 18862.0, 18848.75, 18859.5, 3910],
  ['2024-05-28T13:57:00Z', 18859.25, 18868.5, 18853.25, 18864.25, 3715], ['2024-05-28T14:00:00Z', 18864.5, 18871.5, 18842.5, 18869.75, 6640],
  ['2024-05-28T14:03:00Z', 18870.0, 18890.5, 18870.0, 18880.75, 6732], ['2024-05-28T14:06:00Z', 18880.5, 18895.5, 18879.0, 18885.25, 4746],
  ['2024-05-28T14:09:00Z', 18885.25, 18900.5, 18884.25, 18895.25, 3545], ['2024-05-28T14:12:00Z', 18895.5, 18899.5, 18879.25, 18879.75, 3921],
  ['2024-05-28T14:15:00Z', 18880.0, 18887.5, 18875.0, 18883.25, 3323], ['2024-05-28T14:18:00Z', 18883.25, 18903.0, 18881.5, 18888.75, 3718],
  ['2024-05-28T14:21:00Z', 18889.25, 18896.5, 18872.25, 18893.25, 3797], ['2024-05-28T14:24:00Z', 18893.75, 18900.5, 18890.5, 18898.25, 2853],
  ['2024-05-28T14:27:00Z', 18898.75, 18900.0, 18887.5, 18895.5, 2395], ['2024-05-28T14:30:00Z', 18895.5, 18908.5, 18890.25, 18902.75, 3460],
  ['2024-05-28T14:33:00Z', 18903.0, 18903.5, 18890.5, 18894.25, 2715], ['2024-05-28T14:36:00Z', 18894.25, 18895.25, 18877.75, 18885.5, 3583],
  ['2024-05-28T14:39:00Z', 18885.5, 18895.0, 18879.5, 18894.75, 2890], ['2024-05-28T14:42:00Z', 18894.75, 18914.25, 18891.25, 18911.5, 4496],
]);
const OPTS = { minutes: 3, atr: 20, adr: 400 };

/** Hand-worked from the bars: efficiency |last close - first RTH open| / the RTH bars' summed range. */
function byHand(bars) {
  const rth = bars.slice(1);
  const sum = rth.reduce((a, b) => a + (b.h - b.l), 0);
  const net = rth[rth.length - 1].c - rth[0].o;
  return { n: rth.length, eff: Math.abs(net) / sum, net, hi: Math.max(...rth.map(b => b.h)), lo: Math.min(...rth.map(b => b.l)) };
}

test('daySoFar: a trend morning reads directional its way, every number from its own RTH bars', () => {
  const d = D.daySoFar(TREND, OPTS);
  const h = byHand(TREND);
  assert.strictEqual(d.status, 'read');
  assert.strictEqual(d.bars, 25);
  assert.strictEqual(d.read, 'directional');
  assert.strictEqual(d.direction, 'down');
  assert.strictEqual(d.efficiency, Math.round(h.eff * 100) / 100);
  // The read rests on efficiency x sqrt(bars) (efficiency alone falls as bars add up).
  assert.strictEqual(d.score, Math.round(h.eff * Math.sqrt(h.n) * 100) / 100);
  assert.ok(d.score >= CFG.directional, `${d.score}`);
  assert.strictEqual(d.rangeAtr, Math.round(((h.hi - h.lo) / OPTS.atr) * 100) / 100);
  assert.strictEqual(d.rangeVsAdr, Math.round(((h.hi - h.lo) / OPTS.adr) * 100) / 100);
  assert.strictEqual(d.netAtr, Math.round((h.net / OPTS.atr) * 100) / 100);
  // The RTH VWAP crosses since 09:30, as the regime counts crosses (regime.js vwapCrosses on the RTH VWAP).
  assert.strictEqual(d.vwapCrosses, vwapCrosses(TREND, ind.anchoredVwap(TREND, RTH_OPEN_MIN, RTH_CLOSE_MIN), 1));
});

test('daySoFar: a rotating morning reads rotational; between the bands is mixed', () => {
  const d = D.daySoFar(CHOP, OPTS);
  assert.strictEqual(d.status, 'read');
  assert.strictEqual(d.read, 'rotational');
  assert.ok(d.score < CFG.rotational, `${d.score}`);
  assert.ok(d.vwapCrosses >= 3, `${d.vwapCrosses} crosses`);
  // The bands: from config (the score's place between them decides, nothing else).
  assert.strictEqual(D.readOf(CFG.directional), 'directional');
  assert.strictEqual(D.readOf(CFG.rotational), 'mixed');
  assert.strictEqual(D.readOf(CFG.rotational - 0.01), 'rotational');
  assert.strictEqual(D.readOf((CFG.rotational + CFG.directional) / 2), 'mixed');
});

test('daySoFar: before the opening range completes it is too early: the counts only, never a read', () => {
  // 09:30-09:39: 4 bars, 12 minutes (the 15-minute opening range is not done).
  const d = D.daySoFar(TREND.slice(0, 5), OPTS);
  assert.strictEqual(d.status, 'too early');
  assert.strictEqual(d.bars, 4);
  for (const k of ['read', 'direction', 'efficiency', 'score']) assert.ok(!(k in d), k);
  const line = D.daySoFarLine(d, { tf: '3m' });
  assert.match(line, /too early \(4 bars\)/);
  assert.doesNotMatch(line, /directional|rotational|mixed|efficiency/);
  // At the opening range's close (5 bars, 15 minutes) the read starts.
  assert.strictEqual(D.daySoFar(TREND.slice(0, 6), OPTS).status, 'read');
});

test('daySoFar: missing data is unknown, never a guess; outside RTH there is none', () => {
  // No 09:30 bar (the RTH day started before the data, or its first bar is missing).
  const late = D.daySoFar([TREND[0], ...TREND.slice(2)], OPTS);
  assert.strictEqual(late.status, 'unknown');
  assert.match(late.reason, /09:30/);
  assert.strictEqual(D.daySoFar(TREND.slice(1), OPTS).status, 'unknown', 'the data starts at 09:30: its RTH VWAP is unknown');
  assert.match(D.daySoFarLine(late, { tf: '3m' }), /unknown \(/);
  // No ATR or ADR: those numbers unknown, the read still from the bars.
  const noAtr = D.daySoFar(TREND, { minutes: 3 });
  assert.strictEqual(noAtr.read, 'directional');
  assert.deepStrictEqual([noAtr.rangeAtr, noAtr.rangeVsAdr, noAtr.netAtr], [null, null, null]);
  assert.match(D.daySoFarLine(noAtr, { tf: '3m' }), /range \? x 3m ATR\(14\)/);
  // Bars without range: unknown.
  const flat = TREND.map(b => ({ ...b, h: b.o, l: b.o, c: b.o }));
  assert.strictEqual(D.daySoFar(flat, OPTS).status, 'unknown');
  // The last bar before 09:30 or at 16:00 and after: none.
  assert.strictEqual(D.daySoFar(TREND.slice(0, 1), OPTS), null);
  assert.strictEqual(D.daySoFar([...TREND, { t: '2024-05-31T20:00:00Z', o: 1, h: 2, l: 1, c: 2, v: 1 }], OPTS), null);
  assert.strictEqual(D.daySoFar([], OPTS), null);
});

test('daySoFarLine: the read, its numbers, and where the rest is said, in one line', () => {
  const line = D.daySoFarLine(D.daySoFar(TREND, OPTS), { tf: '3m', dayType: 'trend down' });
  assert.strictEqual(line, '- Day so far (RTH since 09:30 ET, 25 3m bars; describes the morning so far, never the rest; `day-context`): directional down: efficiency 0.31 (x sqrt(bars) 1.55), RTH VWAP crosses 2, range 13.44 x 3m ATR(14) (0.67 ADR), net down (its size: Trend declared? day\'s move); IB day type: today.dayType.');
  const chop = D.daySoFarLine(D.daySoFar(CHOP, OPTS), { tf: '3m' });
  assert.match(chop, /: rotational: efficiency 0\.0\d \(x sqrt\(bars\) 0\.\d\d\), RTH VWAP crosses \d+,/);
  assert.doesNotMatch(chop, /IB day type/);
  assert.strictEqual(D.daySoFarLine(null), null);
});

// Recorded cycles (s2-combine30-05 and -08: every 42nd of the 1,708 cycles with a bar 09:30-10:57 ET and 3+ prior
// sessions): per cycle the windowMeans of its bars (today's last 30 minutes' mean 3m bar range, the same minutes' mean
// on each prior session, most recent first) and the regime's ATR ratio its briefing showed.
const VOL_CYCLES = require('../fixtures/day-so-far/vol-cycles.json');
const topShare = words => Math.max(...[...new Set(words)].map(w => words.filter(x => x === w).length)) / words.length;

test('volatilityRead: the RTH volatility varies across recorded mornings (no word on more than 90%); the regime word did not', () => {
  assert.strictEqual(VOL_CYCLES.length, 40);
  const words = VOL_CYCLES.map(c => D.volatilityRead(c.today, c.prior).word);
  assert.ok(topShare(words) <= 0.9, `top word share ${topShare(words)}`);
  assert.strictEqual(new Set(words).size, 3, `words: ${[...new Set(words)]}`);
  // The same cycles as the regime's word reads them (ATR(14) against its last 100 bars): "high" on 35 of 40 (on all
  // 1,858 recorded 09:30-10:59 cycles, 93%), never "low".
  const R = require('../../scripts/lib/tunables').analysis().regime;
  const old = VOL_CYCLES.map(c => (c.atrRatio >= R.highVol ? 'high' : c.atrRatio <= R.lowVol ? 'low' : 'normal'));
  assert.ok(topShare(old) >= 0.85 && !old.includes('low'), `regime word top share ${topShare(old)}`);
  assert.ok(topShare(words) < topShare(old) - 0.15);
});

test('volatilityRead: against the median of the prior sessions, banded from config; too few sessions is unknown', () => {
  const v = D.volatilityRead(20, [10, 10, 12, 8, 100]);
  assert.deepStrictEqual([v.status, v.ratio, v.word, v.sessions], ['read', 2, 'high', 5]);
  assert.strictEqual(D.volatilityRead(10, [10, 10, 10]).word, 'normal');
  assert.strictEqual(D.volatilityRead(10 * CFG.volLow, [10, 10, 10]).word, 'low');
  assert.strictEqual(D.volatilityRead(10 * CFG.volHigh, [10, 10, 10]).word, 'high');
  const few = D.volatilityRead(10, [10, 10]);
  assert.strictEqual(few.status, 'unknown');
  assert.match(few.reason, /2 prior sessions/);
  assert.strictEqual(D.volatilityRead(NaN, [10, 10, 10]).status, 'unknown');
  assert.strictEqual(D.volatilityRead(10, [0, 0, 0]).status, 'unknown');
});

/** A 3m RTH day (09:27 ET bar first) on `date` (EDT): `n` RTH bars of range `r`. */
function dayOf(date, n, r) {
  const t0 = Date.parse(`${date}T13:27:00Z`);
  return Array.from({ length: n + 1 }, (_, k) => ({ t: new Date(t0 + k * 180000).toISOString(), o: 100, h: 100 + r, l: 100, c: 100 + r / 2, v: 10 }));
}

test('rthVolatility: today\'s last 30 minutes against the same minutes on each prior session', () => {
  const prior = ['2024-05-20', '2024-05-21', '2024-05-22'].flatMap(d => dayOf(d, 30, 10));
  const today = dayOf('2024-05-23', 20, 15);
  const v = D.rthVolatility([...prior, ...today], { minutes: 3 });
  assert.deepStrictEqual([v.status, v.ratio, v.word, v.sessions, v.windowMinutes], ['read', 1.5, 'high', 3, CFG.volMinutes]);
  // Only the same minutes count: a prior session's later bars (wider) change nothing.
  const wideLater = ['2024-05-20', '2024-05-21', '2024-05-22'].flatMap(d => [...dayOf(d, 20, 10), ...dayOf(d, 30, 90).slice(21)]);
  assert.strictEqual(D.rthVolatility([...wideLater, ...today], { minutes: 3 }).ratio, 1.5);
  // A prior session missing one of the minutes is not that session's read: two left is unknown.
  const gappy = [...dayOf('2024-05-20', 30, 10).filter((_, k) => k !== 15), ...dayOf('2024-05-21', 30, 10), ...dayOf('2024-05-22', 30, 10)];
  assert.strictEqual(D.rthVolatility([...gappy, ...today], { minutes: 3 }).status, 'unknown');
  // Early: the bars since 09:30 only (fewer than the window).
  const early = D.rthVolatility([...prior, ...dayOf('2024-05-23', 2, 5)], { minutes: 3 });
  assert.deepStrictEqual([early.ratio, early.word, early.windowMinutes], [0.5, 'low', 6]);
  // Outside RTH: none.
  assert.strictEqual(D.rthVolatility(prior.slice(0, 1), { minutes: 3 }), null);
});

test('volatilityText: the RTH word beside the regime\'s, with its baseline named', () => {
  const v = D.volatilityRead(15, [10, 10, 10]);
  assert.strictEqual(D.volatilityText({ ...v, windowMinutes: 30 }, '3m'), ' RTH volatility: high (the last 30 min\'s 3m bar range 1.5x the same minutes\' median on 3 prior sessions).');
  assert.strictEqual(D.volatilityText({ ...D.volatilityRead(15, [10, 10]), windowMinutes: 30 }, '3m'), ' RTH volatility: unknown (2 prior sessions with these minutes; needs 3).');
  assert.strictEqual(D.volatilityText(null), '');
});
