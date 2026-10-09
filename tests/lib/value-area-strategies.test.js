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
