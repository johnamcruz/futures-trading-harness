'use strict';

/**
 * The value area strategies on constructed sessions: a balanced RTH day
 * gives the prior value area, then the next day either opens below it and
 * comes back inside (value_area_reentry) or opens inside and breaks out on
 * volume (value_area_breakout). Each fires once, on the bar the rules say,
 * with its stop and target from the profile.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { createEvaluator } = require('../../scripts/lib/trading/evaluator');
const { profileSeries } = require('../../scripts/lib/trading/volume-profile');

const ROOT = path.resolve(__dirname, '..', '..');
const STRATS = Object.fromEntries(loadStrategies(ROOT, {}).strategies.map(s => [s.name, s]));
const S = 180000;
const bar = (ms, o, c, v = 100) => ({ t: new Date(ms).toISOString(), o, h: Math.max(o, c) + 0.5, l: Math.min(o, c) - 0.5, c, v });
const DAY1 = Date.UTC(2026, 9, 7, 13, 30); // 09:30 ET, 2026-10-07 (UTC-4)
const DAY2 = DAY1 + 864e5;

/** A day-1 RTH session (most volume near 100), quiet overnight bars at `overnight`, and the prior value area. */
function history(overnight) {
  const bars = [bar(DAY1 - S, 100, 100)];
  for (let k = 0; k < 130; k += 1) {
    const c = 100 + 40 * Math.sin(k / 6) * (k % 2 ? 1 : 0.3);
    bars.push(bar(DAY1 + k * S, bars[bars.length - 1].c, c, 100 + Math.round(200 * Math.exp(-((c - 100) ** 2) / 200))));
  }
  // 18:00 ET to 09:27 ET next day: 30 quiet bars, so ATR(20) and the last 10 bars are the new session's.
  for (let k = 0; k < 30; k += 1) bars.push(bar(DAY2 - (30 - k) * S, overnight, overnight));
  const p = profileSeries(bars, 'prior_rth').profile.at(-1);
  assert.ok(p && p.val < p.poc && p.poc < p.vah, 'day 1 has a value area');
  return { bars, p };
}

const fires = (s, bars) => {
  const ev = createEvaluator(bars);
  return bars.map((b, i) => ({ i, r: ev.at(s, i, { describe: false }) })).filter(x => x.r.direction);
};

test('value_area_reentry: open below value, two closes back inside, long to the value area high', () => {
  const { bars, p } = history(0);
  bars.splice(bars.length - 30, 30, ...Array.from({ length: 30 }, (_, k) => bar(DAY2 - (30 - k) * S, p.val - 3, p.val - 3)));
  const v = p.val;
  // 09:30 opens at VAL - 2, two more closes outside, then 09:39 and 09:42 close inside.
  for (const [k, c] of [[0, v - 2], [1, v - 1.5], [2, v - 1], [3, v + 1], [4, v + 2], [5, v + 3]]) bars.push(bar(DAY2 + k * S, k ? bars.at(-1).c : v - 2, c));
  const f = fires(STRATS.value_area_reentry, bars);
  assert.strictEqual(f.length, 1, JSON.stringify(f.map(x => bars[x.i].t)));
  const { i, r } = f[0];
  assert.strictEqual(bars[i].t, new Date(DAY2 + 4 * S).toISOString(), 'the second close inside, 09:42 ET');
  assert.strictEqual(r.direction, 'long');
  assert.ok(Math.abs(r.targetDistance - (p.vah - bars[i].c)) < 1e-3, 'target: the prior value area high');
  assert.ok(r.stopDistance > bars[i].c - (v - 2.5) && r.targetDistance >= 2 * r.stopDistance);
  assert.strictEqual(STRATS.value_area_reentry.mtf, 'reversal');
  // No reentry when the session opened inside value.
  const inside = history(p.poc).bars;
  for (const [k, c] of [[0, v + 5], [1, v - 1], [2, v - 1], [3, v + 1], [4, v + 2]]) inside.push(bar(DAY2 + k * S, k ? inside.at(-1).c : v + 5, c));
  assert.strictEqual(fires(STRATS.value_area_reentry, inside).length, 0);
});

test('value_area_breakout: two closes above value on volume after 10:00 ET, long, trend style', () => {
  const { bars, p } = history(0);
  const h = p.vah;
  bars.splice(bars.length - 30, 30, ...Array.from({ length: 30 }, (_, k) => bar(DAY2 - (30 - k) * S, h - 3, h - 3)));
  // 09:30-09:57 inside value, 10:00 still inside, 10:03 and 10:06 close above, 10:06 on 5x volume.
  for (let k = 0; k < 10; k += 1) bars.push(bar(DAY2 + k * S, h - 3, h - 2.5));
  bars.push(bar(DAY2 + 10 * S, h - 2.5, h - 1));
  bars.push(bar(DAY2 + 11 * S, h - 1, h + 1));
  bars.push(bar(DAY2 + 12 * S, h + 1, h + 2, 500));
  bars.push(bar(DAY2 + 13 * S, h + 2, h + 3, 500));
  const f = fires(STRATS.value_area_breakout, bars);
  assert.strictEqual(f.length, 1, JSON.stringify(f.map(x => bars[x.i].t)));
  const { i, r } = f[0];
  assert.strictEqual(bars[i].t, new Date(DAY2 + 12 * S).toISOString(), 'the second close above, 10:06 ET');
  assert.strictEqual(r.direction, 'long');
  assert.ok(r.stopDistance > bars[i].c - h && r.stopDistance < bars[i].c - h + 5, `stop: half an ATR(20) back inside value (${r.stopDistance})`);
  assert.strictEqual(STRATS.value_area_breakout.mtf, 'trend');
  // Without volume it doesn't fire.
  bars[bars.length - 2] = { ...bars[bars.length - 2], v: 50 };
  assert.strictEqual(fires(STRATS.value_area_breakout, bars).length, 0);
});

/** Day 2 from 09:30 ET: `flat` bars at a price, then the given bars ({ o, h, l, c, v }). */
function day2(bars, flatAt, n, extra) {
  for (let k = 0; k < n; k += 1) bars.push({ ...bar(DAY2 + k * S, flatAt, flatAt + 0.25), v: 100 });
  extra.forEach((x, k) => bars.push({ t: new Date(DAY2 + (n + k) * S).toISOString(), v: 100, ...x }));
  return bars;
}

test('value_area: a POC rejection confirmed by order flow fires long, to the value area high', () => {
  const { bars, p } = history(0);
  const poc = p.poc;
  bars.splice(bars.length - 30, 30, ...Array.from({ length: 30 }, (_, k) => bar(DAY2 - (30 - k) * S, poc + 4, poc + 4)));
  // 10:00 closes above the POC; 10:03 dips to it and closes near its high, on buying.
  day2(bars, poc + 4, 10, [
    { o: poc + 3, h: poc + 3.25, l: poc + 2, c: poc + 3 },
    { o: poc + 1, h: poc + 2.5, l: poc - 0.05, c: poc + 2.4 },
  ]);
  const f = fires(STRATS.value_area, bars);
  assert.strictEqual(f.length, 1, JSON.stringify(f.map(x => bars[x.i].t)));
  const { i, r } = f[0];
  assert.strictEqual(i, bars.length - 1);
  assert.strictEqual(r.direction, 'long');
  const [setup, confirm] = [r.rules.long[2], r.rules.long[3]];
  assert.deepStrictEqual(setup.parts.map(x => x.ok), [true, false], 'the rejection branch');
  assert.deepStrictEqual(confirm.parts.map(x => x.ok), [true, false], 'confirmed by order flow, not expansion');
  assert.ok(Math.abs(r.targetDistance - (p.vah - bars[i].c)) < 1e-3, 'target: the value area high');
  assert.ok(r.targetDistance >= 2 * r.stopDistance);
  // The same bar without the buying (sellers over the last 3 bars): no trade.
  const weak = bars.slice(0, -2).concat([{ ...bars.at(-2), c: poc + 2.1 }, { ...bars.at(-1), o: poc + 2.4, c: poc + 1 }]);
  assert.strictEqual(fires(STRATS.value_area, weak).length, 0);
});

test('value_area: a POC breakout confirmed by range expansion on volume fires short, to the value area low', () => {
  const { bars, p } = history(0);
  const poc = p.poc;
  bars.splice(bars.length - 30, 30, ...Array.from({ length: 30 }, (_, k) => bar(DAY2 - (30 - k) * S, poc + 3, poc + 3)));
  // 10:03: one wide bar down through the POC on 5x volume, closing mid-range (no selling signal from flow).
  day2(bars, poc + 3, 11, [{ o: poc + 2, h: poc + 2.5, l: poc - 10, c: poc - 3, v: 500 }]);
  const f = fires(STRATS.value_area, bars);
  assert.strictEqual(f.length, 1, JSON.stringify(f.map(x => bars[x.i].t)));
  const { r } = f[0];
  assert.strictEqual(r.direction, 'short');
  assert.deepStrictEqual(r.rules.short[2].parts.map(x => x.ok), [false, true], 'the breakout branch');
  assert.deepStrictEqual(r.rules.short[3].parts.map(x => x.ok), [false, true], 'confirmed by expansion, not order flow');
  // Without the volume, nothing confirms it.
  bars[bars.length - 1] = { ...bars.at(-1), v: 120 };
  assert.strictEqual(fires(STRATS.value_area, bars).length, 0);
});

test('value_area: price sitting on the POC fires one rejection, not one per bar', () => {
  const { bars, p } = history(0);
  const poc = p.poc;
  bars.splice(bars.length - 30, 30, ...Array.from({ length: 30 }, (_, k) => bar(DAY2 - (30 - k) * S, poc + 4, poc + 4)));
  // 10:00 closes above the POC, then six bars in a row dip to it and close near their highs.
  day2(bars, poc + 4, 10, [{ o: poc + 3, h: poc + 3.25, l: poc + 2, c: poc + 3 }, ...Array.from({ length: 6 }, () => ({ o: poc + 1, h: poc + 2.5, l: poc - 0.05, c: poc + 2.4 }))]);
  const f = fires(STRATS.value_area, bars);
  assert.ok(f.length >= 1 && f.length <= 3, `fired on ${f.length} of 6 bars`);
  assert.strictEqual(f[0].i, bars.length - 6, 'the first rejection');
  for (let k = 1; k < f.length; k += 1) assert.ok(f[k].i - f[k - 1].i >= 2, 'never on two bars in a row');
});

test('value_area_reentry: the opening bar closing back inside counts, and the stop is below the whole excursion', () => {
  const { bars, p } = history(0);
  const v = p.val;
  bars.splice(bars.length - 30, 30, ...Array.from({ length: 30 }, (_, k) => bar(DAY2 - (30 - k) * S, v - 3, v - 3)));
  // 09:30 opens at VAL - 2 and closes inside; 09:33 closes inside too: the acceptance.
  const open = bars.slice();
  open.push(bar(DAY2, v - 2, v + 1), bar(DAY2 + S, v + 1, v + 2));
  const f = fires(STRATS.value_area_reentry, open);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(open[f[0].i].t, new Date(DAY2 + S).toISOString(), '09:33 ET');
  // A long excursion: the low (VAL - 7) comes 15 bars before the acceptance; the stop goes below it.
  const long = bars.slice();
  long.push(bar(DAY2, v - 2, v - 6));
  for (let k = 1; k < 15; k += 1) long.push(bar(DAY2 + k * S, v - 3, v - 2.5));
  long.push(bar(DAY2 + 15 * S, v - 2.5, v + 1), bar(DAY2 + 16 * S, v + 1, v + 2));
  const g = fires(STRATS.value_area_reentry, long);
  assert.strictEqual(g.length, 1);
  const close = long[g[0].i].c;
  assert.ok(g[0].r.stopDistance > close - (v - 6.5), `stop ${close - g[0].r.stopDistance} must be under the excursion low ${v - 6.5}`);
});

test('backtest: a level target the fill leaves under min_rr is not traded', () => {
  const { runEngine } = require('../../scripts/lib/backtest/engine');
  const { bars, p } = history(0);
  const v = p.val;
  bars.splice(bars.length - 30, 30, ...Array.from({ length: 30 }, (_, k) => bar(DAY2 - (30 - k) * S, v - 3, v - 3)));
  bars.push(bar(DAY2, v - 2, v + 1), bar(DAY2 + S, v + 1, v + 2));
  const s = STRATS.value_area_reentry;
  const r = fires(s, bars)[0].r;
  // The next bar opens so far up that the value area high is under 2R from the fill.
  const gapTo = p.vah - 1.5 * r.stopDistance;
  const run = extra => runEngine([{ symbol: 'MNQ', bars: [...bars, ...extra], tickSize: 0.25, tickValue: 0.5, feesPerSide: 0 }], [s], { timeframe: 3, gate: false, window: 100 }).trades; // a short warm-up: these bars start a day before
  assert.strictEqual(run([bar(DAY2 + 2 * S, gapTo, gapTo)]).length, 0, 'gapped under 2R: skipped');
  assert.strictEqual(run([bar(DAY2 + 2 * S, v + 2, v + 2.5), bar(DAY2 + 3 * S, v + 2.5, p.vah + 1)]).length, 1, 'a normal fill trades');
});
