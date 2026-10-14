'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, FX_GOLDEN } = require('../helpers');
const fsy = require('../../scripts/lib/field-study');
const fcf = require('../../scripts/lib/field-confluence');
const { compileRules } = require('../../scripts/lib/trading/rules');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');

const ROOT = path.resolve(__dirname, '..', '..');
const TICK = 0.25;
const MIN = 60000;

function gauss(u) {
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

/**
 * Synthetic 1-minute bars over `days` weekdays from 2022-02-07 (Train), 08:00-16:59 New York, with wide
 * bars (about 6%) and a field `x.f` on every bar, drawn independently of prices. With `plant`, a wide bar
 * whose field agrees with it (field x direction > 0.5) is followed by 5 bars drifting its way, and one whose
 * field disagrees (< -0.5) by 5 bars drifting against it; a neutral field is followed by nothing. Without,
 * the field says nothing (the null). `x.g` is pure noise always.
 */
function synthBars({ days = 60, seed = 1, plant = true, step = 1 } = {}) {
  const u = fsy.rng(seed);
  const g = gauss(u);
  const bars = [];
  let c = 15000;
  let day = 0;
  for (let d = 0; day < days; d += 1) {
    const base = Date.parse('2022-02-07T13:00:00Z') + d * 86400000;
    const wd = new Date(base).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    day += 1;
    let left = 0;
    let drift = 0;
    for (let m = 0; m < 540; m += step) {
      let inc = Math.round(1.5 * g());
      if (left > 0) { inc += 2 * drift; left -= 1; }
      const wide = u() < 0.06;
      if (wide) inc = (u() < 0.5 ? -1 : 1) * (8 + Math.floor(u() * 4));
      const o = c;
      c = o + inc * TICK;
      const x = g();
      if (wide && plant) {
        const dir = Math.sign(inc);
        if (x * dir > 0.5) { drift = dir; left = 5; } else if (x * dir < -0.5) { drift = -dir; left = 5; }
      }
      bars.push({ t: new Date(base + m * MIN).toISOString(), ms: base + m * MIN, o, h: Math.max(o, c) + TICK, l: Math.min(o, c) - TICK, c, v: 10, x: { f: x, g: g() } });
    }
  }
  return bars;
}

const FIELDS = ['x.f', 'x.g'].map(fsy.parseFieldSpec);
const table = (bars, fields = FIELDS, tf = 1) => fsy.joinChunks([fsy.columns(bars, fields)], { timeframeMin: tf });
const strat = (rules, extra = {}) => ({ name: 'test_rules', valid: true, signal: 'rules', status: 'paper', timeframe: '1m', params: {}, compiledRules: compileRules(rules).compiled, ...extra });

test('events parse: expansion:<k>, breakout:<n>, strategy:<name|all>; anything else refused', () => {
  assert.deepStrictEqual(fcf.parseEvents('expansion:1.5, breakout:20,strategy:orb,expansion:1.5'), [
    { spec: 'expansion:1.5', kind: 'expansion', k: 1.5 }, { spec: 'breakout:20', kind: 'breakout', n: 20 }, { spec: 'strategy:orb', kind: 'strategy', name: 'orb' },
  ]);
  for (const bad of ['', 'expansion', 'expansion:0', 'expansion:-1', 'expansion:21', 'breakout:0', 'breakout:1.5', 'breakout:501', 'strategy:', 'strategy:Bad Name', 'momentum:3']) {
    assert.throws(() => fcf.parseEvents(bad), /--event/, bad);
  }
});

test('the prior ATR(14) is Wilder\'s over earlier bars of the same run, reset at a trading day', () => {
  const bars = synthBars({ days: 2, plant: false });
  const t = table(bars);
  const atr = fcf.priorAtr(t);
  const tr = i => (i === 0 || i === 540 ? bars[i].h - bars[i].l : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  for (let i = 0; i <= 13; i += 1) assert.ok(Number.isNaN(atr[i]), `no ATR before 14 earlier bars (bar ${i})`);
  let want = 0;
  for (let i = 0; i < 14; i += 1) want += tr(i) / 14;
  assert.ok(Math.abs(atr[14] - want) < 1e-9, 'bar 14 sees the mean of bars 0..13');
  want = (want * 13 + tr(14)) / 14;
  assert.ok(Math.abs(atr[15] - want) < 1e-9, 'then Wilder smoothing');
  // The second day (bar 540) starts over: its first true range is its own range, its ATR unknown for 14 bars.
  assert.strictEqual(t.runStart[545], 540);
  assert.ok(Number.isNaN(atr[553]) && Number.isFinite(atr[554]));
});

test('price events: expansion by range vs the prior ATR with the bar\'s own direction; breakout of the prior n bars in the run', () => {
  const mk = (i, o, h, l, c) => ({ t: new Date(Date.parse('2022-03-01T15:00:00Z') + i * MIN).toISOString(), ms: Date.parse('2022-03-01T15:00:00Z') + i * MIN, o, h, l, c, v: 1, x: { f: 1, g: 1 } });
  const bars = Array.from({ length: 20 }, (_, i) => mk(i, 100, 101, 99, 100));
  bars.push(mk(20, 100, 104, 99.5, 103.5)); // range 4.5 vs ATR 2: an up expansion and a breakout
  bars.push(mk(21, 103.5, 104, 99, 99.25)); // range 5, down, closes inside the prior 20 bars' range
  bars.push(mk(22, 99.25, 99.5, 97.75, 97.75)); // range 1.75: no expansion; a close below the 20-bar low
  const t = table(bars);
  const atr = fcf.priorAtr(t);
  const e = fcf.priceEvents(t, { spec: 'expansion:2', kind: 'expansion', k: 2 }, atr);
  assert.deepStrictEqual([e[19], e[20], e[21], e[22]], [0, 1, -1, 0]);
  // The ATR is the bars' before t, never t's own: at 2.2 x 2 = 4.4 bar 20 (4.5) fires; with its own range in the ATR (2.18) it wouldn't.
  assert.strictEqual(fcf.priceEvents(t, { spec: 'expansion:2.2', kind: 'expansion', k: 2.2 }, atr)[20], 1);
  const flat = fcf.priceEvents(t, { spec: 'expansion:20', kind: 'expansion', k: 20 }, atr);
  assert.ok(flat.every(v => v === 0));
  const b = fcf.priceEvents(t, { spec: 'breakout:20', kind: 'breakout', n: 20 });
  assert.deepStrictEqual([b[19], b[20], b[21], b[22]], [0, 1, 0, -1]);
  // Fewer than n earlier bars in the run: no breakout, however far the close.
  assert.strictEqual(fcf.priceEvents(t, { spec: 'breakout:21', kind: 'breakout', n: 21 })[20], 0);
  // A doji has no direction.
  bars[20] = mk(20, 100, 105, 95, 100);
  assert.strictEqual(fcf.priceEvents(table(bars), { spec: 'expansion:2', kind: 'expansion', k: 2 })[20], 0);
});

test('no look-ahead: events and the field at t never change when only later bars change', () => {
  const bars = synthBars({ days: 3, plant: true });
  const cut = 900;
  const later = bars.map((b, i) => (i > cut ? { ...b, h: b.h + 50, l: b.l - 50, c: b.c + 7, x: { f: 1e6, g: -1e6 } } : b));
  const evs = [{ spec: 'expansion:1.5', kind: 'expansion', k: 1.5 }, { spec: 'breakout:20', kind: 'breakout', n: 20 }];
  for (const ev of evs) {
    const a = fcf.priceEvents(table(bars), ev);
    const b = fcf.priceEvents(table(later), ev);
    assert.deepStrictEqual(Array.from(a.subarray(0, cut + 1)), Array.from(b.subarray(0, cut + 1)), ev.spec);
    assert.ok(a.some(Boolean), `${ev.spec} fires`);
    // Cut right at each of its first events: the bars after it, made wild, never change it.
    for (const at of [...a.keys()].filter(i => a[i]).slice(0, 15)) {
      const wild = bars.map((x, i) => (i > at ? { ...x, h: x.h + 50, l: x.l - 50 } : x));
      assert.strictEqual(fcf.priceEvents(table(wild), ev)[at], a[at], `${ev.spec} at bar ${at} moved with later bars`);
    }
  }
  // A strategy's events: the rules on bars 0..i, the same whether later bars exist or not.
  const s = strat({ long: ['close > highest(10)[1]', 'close > ema(20)'], short: ['close < lowest(10)[1]', 'close < ema(20)'] });
  const opts = { strategies: [s], fields: FIELDS, timeframeMin: 1 };
  const ev = [{ spec: 'strategy:test_rules', kind: 'strategy', name: 'test_rules' }];
  const full = fcf.chunkStrategyEvents(bars, ev, opts)[0].perField[0].dir;
  const mutated = fcf.chunkStrategyEvents(later, ev, opts)[0].perField[0].dir;
  const truncated = fcf.chunkStrategyEvents(bars.slice(0, cut + 1), ev, opts)[0].perField[0].dir;
  assert.ok(full.some(Boolean));
  assert.deepStrictEqual(Array.from(mutated.subarray(0, cut + 1)), Array.from(full.subarray(0, cut + 1)));
  assert.deepStrictEqual(Array.from(truncated), Array.from(full.subarray(0, cut + 1)));
  // Fixture strategies too (the retired strategies' rules, tests/fixtures/strategies-golden: their own series, evaluated causally).
  const fixtures = loadStrategies(ROOT, { FTH_STRATEGIES_DIRS: FX_GOLDEN }).strategies.filter(x => x.valid && x.signal === 'rules' && x.timeframe === '3m').slice(0, 3);
  assert.strictEqual(fixtures.length, 3);
  const bars3 =synthBars({ days: 10, plant: false, step: 3 });
  const cut3 = 1200;
  const ev3 = fixtures.map(x => ({ spec: `strategy:${x.name}`, kind: 'strategy', name: x.name }));
  const o3 = { strategies: fixtures, fields: FIELDS.slice(0, 1), timeframeMin: 3 };
  const f3 = fcf.chunkStrategyEvents(bars3, ev3, o3);
  const t3 = fcf.chunkStrategyEvents(bars3.slice(0, cut3 + 1), ev3, o3);
  f3.forEach((e, j) => assert.deepStrictEqual(Array.from(t3[j].perField[0].dir), Array.from(e.perField[0].dir.subarray(0, cut3 + 1)), e.spec));
  // The field paired with an event is bar t's own value; the outcomes start at t+1.
  const t = table(bars);
  const dir = fcf.priceEvents(t, evs[0]);
  const E = fcf.eventPairs(t, dir, 0, 0, 5, { tick: TICK, atr: fcf.priorAtr(t) });
  for (let m = 0; m < E.n; m += 1) assert.strictEqual(E.x[m], bars[E.at[m]].x.f);
  const lagged = fcf.eventPairs(t, dir, 0, 1, 5, { tick: TICK, atr: fcf.priorAtr(t) });
  for (let m = 0; m < lagged.n; m += 1) assert.strictEqual(lagged.x[m], bars[lagged.at[m] - 1].x.f);
});

test('outcomes: the move signed by the event, excursions over t+1..t+k, which of +1R and -1R comes first; breaks skipped', () => {
  const mk = (i, o, h, l, c) => ({ t: new Date(Date.parse('2022-03-01T15:00:00Z') + i * MIN).toISOString(), ms: Date.parse('2022-03-01T15:00:00Z') + i * MIN, o, h, l, c, v: 1, x: { f: 0.5, g: 0 } });
  const bars = [mk(0, 100, 102, 99, 102), mk(1, 102, 102.5, 101, 101.5), mk(2, 101.5, 105.25, 101, 105), mk(3, 105, 110, 98, 99)];
  const t = table(bars);
  const atr = fcf.priorAtr(t);
  const longAt0 = Int8Array.from([1, 0, 0, 0]);
  let E = fcf.eventPairs(t, longAt0, 0, 0, 2, { tick: TICK, atr });
  assert.strictEqual(E.n, 1);
  // Long from 102: after 2 bars 105 (+12 ticks), best high 105.25 (+13), worst low 101 (-4); R = 3 points, +1R (105) first.
  assert.deepStrictEqual([E.fwd[0], E.mfe[0], E.mae[0], E.first[0]], [12, 13, 4, 1]);
  E = fcf.eventPairs(t, Int8Array.from([-1, 0, 0, 0]), 0, 0, 3, { tick: TICK, atr });
  // Short from 102: after 3 bars 99 (+12 ticks for a short), +1R is 99 (bar 3), -1R is 105 (bar 2): -1R first.
  // Its excursions: down to 98 (+16 ticks), up to 110 (-32).
  assert.deepStrictEqual([E.fwd[0], E.mfe[0], E.mae[0], E.first[0]], [12, 16, 32, -1]);
  // Both in one bar is a tie; R from the ATR is unknown here (too few bars), so first is NaN.
  E = fcf.eventPairs(t, Int8Array.from([0, 0, 1, 0]), 0, 0, 1, { tick: TICK, atr });
  assert.strictEqual(E.first[0], 2, 'bar 3 (98 to 110) reaches both +1R and -1R of bar 2 (R 4.25 from 105)');
  assert.ok(Number.isNaN(fcf.eventPairs(t, longAt0, 0, 0, 1, { tick: TICK, rMode: 'atr', atr }).first[0]));
  // Past a gap, a trading day or the data's end: counted, never paired.
  const gap = [mk(0, 100, 101, 99, 100), mk(1, 100, 101, 99, 100), mk(5, 100, 101, 99, 100), mk(6, 100, 101, 99, 100)];
  const tg = table(gap);
  E = fcf.eventPairs(tg, Int8Array.from([1, 1, 1, 1]), 0, 0, 1, { tick: TICK, atr: fcf.priorAtr(tg) });
  assert.deepStrictEqual([E.events, E.n, E.skipped, E.tail], [4, 2, 1, 1]);
  const day = [mk(0, 100, 101, 99, 100), { ...mk(0, 100, 101, 99, 100), t: '2022-03-01T22:59:00Z', ms: Date.parse('2022-03-01T22:59:00Z') }, { ...mk(0, 100, 101, 99, 100), t: '2022-03-01T23:00:00Z', ms: Date.parse('2022-03-01T23:00:00Z') }, { ...mk(0, 100, 101, 99, 100), t: '2022-03-01T23:01:00Z', ms: Date.parse('2022-03-01T23:01:00Z') }];
  const td = table(day);
  E = fcf.eventPairs(td, Int8Array.from([0, 1, 0, 0]), 0, 0, 1, { tick: TICK, atr: fcf.priorAtr(td) });
  assert.deepStrictEqual([E.n, E.skipped], [0, 1], 'the 18:00 ET rollover is never crossed');
  // A missing field is counted, not classed.
  const miss = bars.map((b, i) => (i === 0 ? { ...b, x: {} } : b));
  assert.strictEqual(fcf.eventPairs(table(miss), longAt0, 0, 0, 1, { tick: TICK, atr }).missing, 1);
});

test('classes: agree, disagree past the threshold, neutral otherwise; per-class stats and the differences', () => {
  assert.strictEqual(fcf.classOf(0.9, 1, 0.5), 0);
  assert.strictEqual(fcf.classOf(-0.9, -1, 0.5), 0);
  assert.strictEqual(fcf.classOf(-0.9, 1, 0.5), 1);
  assert.strictEqual(fcf.classOf(0.4, 1, 0.5), 2);
  assert.strictEqual(fcf.classOf(0, 1, 0), 2, 'a zero field never agrees');
  const E = { n: 6, x: Float64Array.from([1, 2, -1, -2, 0.1, 0]), d: Int8Array.from([1, -1, 1, -1, 1, -1]), fwd: Float64Array.from([4, -2, -3, 6, 1, 0]), mfe: Float64Array.from([5, 1, 1, 7, 2, 1]), mae: Float64Array.from([1, 3, 4, 0, 1, 1]), first: Float64Array.from([1, -1, -1, 1, NaN, 0]), day: Int32Array.from([0, 0, 1, 1, 2, 2]), hour: new Int8Array(6), rth: new Uint8Array(6) };
  const r = fcf.summarizeClasses(E, 0.5, { costTicks: 2 });
  const [a, d, n] = r.classes;
  // agree: bars 0 and 3 (field with the event); disagree: 1 and 2; neutral: 4 and 5.
  assert.deepStrictEqual([a.n, a.mean, a.follow, a.mfe, a.mae, a.plusFirst, a.minusFirst], [2, 5, 1, 6, 0.5, 1, 0]);
  assert.deepStrictEqual([d.n, d.mean, d.follow, d.plusFirst], [2, -2.5, 0, 0]);
  assert.deepStrictEqual([n.n, n.mean, n.follow, n.plusFirst], [2, 0.5, 0.5, 0], 'R unknown on one: shares over the other');
  assert.deepStrictEqual(r.diff.agreeMinusDisagree, { mean: 7.5, follow: 1, plusFirst: 1 });
  assert.deepStrictEqual(r.diff.agreeMinusNeutral, { mean: 4.5, follow: 0.5, plusFirst: 1 });
  assert.strictEqual(r.ci, null, 'no intervals unless asked');
});

test('intervals: one trading day a block, so correlated events in a day are not counted as independent; the cost needs the whole interval', () => {
  // 20 days of 50 agreeing events; every event in a day has that day's move (+10 or -10 ticks), mean near 0.
  const u = fsy.rng(9);
  const days = 20; const per = 50; const n = days * per;
  const dayMove = Array.from({ length: days }, () => (u() < 0.5 ? -10 : 10));
  const E = { n, x: new Float64Array(n).fill(1), d: new Int8Array(n).fill(1), fwd: Float64Array.from({ length: n }, (_, i) => dayMove[Math.floor(i / per)]), mfe: new Float64Array(n), mae: new Float64Array(n), first: new Float64Array(n), day: Int32Array.from({ length: n }, (_, i) => Math.floor(i / per)), hour: new Int8Array(n), rth: new Uint8Array(n) };
  const r = fcf.summarizeClasses(E, 0.5, { costTicks: 2, boot: { reps: 400, seed: 3 } });
  assert.strictEqual(r.days, days);
  const [lo, hi] = r.classes[0].ciMean;
  // Day blocks: about 2 x 1.96 x 10 / sqrt(20) = 8.8 ticks wide; resampling events alone would give about 1.2.
  assert.ok(hi - lo > 5, `interval [${lo}, ${hi}] is too narrow for 20 independent days`);
  // A class clears the cost only when its interval's low end is above it: one wholly above, one straddling.
  const mk = fwd => ({ ...E, fwd: Float64Array.from(fwd) });
  const above = fcf.summarizeClasses(mk(Array.from({ length: n }, (_, i) => 5 + (i % 2))), 0.5, { costTicks: 2, boot: { reps: 200 } });
  assert.strictEqual(above.classes[0].clearsCost, true);
  const straddle = fcf.summarizeClasses(mk(Array.from({ length: n }, (_, i) => dayMove[Math.floor(i / per)] + 3)), 0.5, { costTicks: 2, boot: { reps: 200 } });
  assert.ok(straddle.classes[0].ciMean[0] < 2 && straddle.classes[0].ciMean[1] > 2, `${straddle.classes[0].ciMean}`);
  assert.strictEqual(straddle.classes[0].clearsCost, false);
  assert.strictEqual(straddle.agreeOnlyClears, false);
  // A class with too few events or days gets no interval, no difference interval and no cost verdict.
  const few = { ...E, x: Float64Array.from({ length: n }, (_, i) => (i < 40 ? -1 : i < 40 + per * 8 ? 0 : 1)), fwd: new Float64Array(n).fill(5) };
  const fr = fcf.summarizeClasses(few, 0.5, { costTicks: 2, boot: { reps: 200 } });
  // agree: 560 events over days 8-19; disagree: 40 in day 0 (too few); neutral: 400 over days 0-8 (too few days).
  assert.deepStrictEqual(fr.classes.map(k => [k.n, k.days, k.tested]), [[560, 12, true], [40, 1, false], [400, 9, false]]);
  assert.ok(fr.classes[1].ciMean === null && fr.classes[1].clearsCost === false && fr.classes[2].ciMean === null);
  assert.ok(fr.diff.agreeMinusDisagree.meanCi === null && fr.diff.agreeMinusNeutral.followCi === null);
  assert.ok(fr.classes[0].clearsCost);
  assert.strictEqual(fr.agreeOnlyClears, null, 'the others too few to test: no "agree only" claim');
});

test('a planted confluence is found and clears the cost in the agree class only; a planted null is not', () => {
  const ev = fcf.parseEvents('expansion:1.5');
  const t = table(synthBars({ plant: true }));
  const res = fcf.confluence(t, { fields: FIELDS, events: ev, horizons: [5], tick: TICK, by: ['session'], reps: 300, seed: 5 });
  assert.strictEqual(res.length, 4, '2 fields x 1 horizon x the p60 and p80 thresholds');
  for (const r of res.filter(x => x.field === 'x.f')) {
    assert.ok(r.quantile === 0.6 || r.quantile === 0.8);
    const ad = r.diff.agreeMinusDisagree; const an = r.diff.agreeMinusNeutral;
    assert.ok(ad.mean > 10 && ad.meanCi[0] > 5, `agree - disagree ${ad.mean} ${ad.meanCi}`);
    assert.ok(an.mean > 4 && an.meanCi[0] > 0, `agree - neutral ${an.mean} ${an.meanCi}`);
    assert.ok(ad.followCi[0] > 0.2, `follow-through ${ad.follow} ${ad.followCi}`);
    assert.ok(ad.plusFirstCi[0] > 0);
    assert.deepStrictEqual(r.classes.map(k => k.clearsCost), [true, false, false]);
    assert.strictEqual(r.agreeOnlyClears, true);
    assert.ok(r.by.session.length >= 1 && r.by.session.every(g => g.ci));
  }
  // The noise field on the same events finds nothing.
  for (const r of res.filter(x => x.field === 'x.g')) {
    for (const c of [r.diff.agreeMinusDisagree.meanCi, r.diff.agreeMinusNeutral.meanCi, r.diff.agreeMinusDisagree.followCi]) assert.ok(!fcf.excludesZero(c), `noise: ${c}`);
    assert.strictEqual(r.agreeOnlyClears, false);
  }
  // The null: the same generator without the plant, over 20 seeds. Nothing is found beyond the 5% an
  // interval misses by chance (about 1 in 20; 4 or more would be 1.6% likely), and nothing clears the cost.
  let found = 0;
  for (let seed = 1; seed <= 20; seed += 1) {
    const [r] = fcf.confluence(table(synthBars({ plant: false, seed: 100 + seed, days: 40 })), { fields: FIELDS.slice(0, 1), events: ev, horizons: [5], thresholds: [0.84], tick: TICK, reps: 200, seed });
    if (fcf.excludesZero(r.diff.agreeMinusDisagree.meanCi)) found += 1;
    assert.ok(Math.abs(r.diff.agreeMinusDisagree.mean) < 3, `null seed ${seed}: ${r.diff.agreeMinusDisagree.mean}`);
    assert.ok(r.classes.every(k => !k.clearsCost), `null seed ${seed} clears the cost`);
  }
  assert.ok(found <= 3, `the null was "found" on ${found} of 20 seeds`);
  // Seeded: the same intervals twice.
  const again = fcf.confluence(t, { fields: FIELDS.slice(0, 1), events: ev, horizons: [5], tick: TICK, reps: 300, seed: 5 });
  assert.deepStrictEqual(again[0].ci, res[0].ci);
});

test('a strategy event never confirms itself: its conditions reading the field are removed and listed', () => {
  const rules = {
    long: ['close > highest(10)[1]', { any: ['field("x.f") > 0.5', 'close > open + 1'] }, 'field("x.g") > -9'],
    short: ['close < lowest(10)[1]', 'field("x.f") < -0.5'],
  };
  const w = fcf.withoutField(compileRules(rules).compiled, 'x.f');
  assert.deepStrictEqual(w.excluded, ['field("x.f") > 0.5', 'field("x.f") < -0.5']);
  assert.deepStrictEqual(w.reads, ['x.g']);
  assert.deepStrictEqual(w.compiled.long.map(c => c.text), ['close > highest(10)[1]', 'any(close > open + 1)', 'field("x.g") > -9']);
  assert.deepStrictEqual(w.compiled.short.map(c => c.text), ['close < lowest(10)[1]']);
  const bars = synthBars({ days: 3 });
  const s = strat(rules);
  const [e] = fcf.chunkStrategyEvents(bars, [{ spec: 'strategy:test_rules', kind: 'strategy', name: 'test_rules' }], { strategies: [s], fields: FIELDS, timeframeMin: 1 });
  const [onF, onG] = e.perField;
  // Tested on x.f, the strategy fires short with x.f anywhere (its x.f condition is gone)...
  assert.ok([...onF.dir.keys()].some(i => onF.dir[i] === -1 && bars[i].x.f >= -0.5), 'fires whatever x.f is');
  // ...tested on x.g, its own rules hold in full: never short unless x.f < -0.5.
  assert.ok([...onG.dir.keys()].every(i => onG.dir[i] !== -1 || bars[i].x.f < -0.5));
  assert.deepStrictEqual(onG.excluded, ['field("x.g") > -9']);
  // Never in a chunk's first WARMUP bars, where its series are cold.
  assert.ok(onF.dir.subarray(0, fcf.WARMUP).every(v => v === 0) && onF.dir.subarray(fcf.WARMUP).some(Boolean));
  // Sessions: outside them it never fires (the bar's close inside 09:30-16:00 New York, 14:30Z-21:00Z in February).
  const ny = fcf.chunkStrategyEvents(bars, [{ spec: 'strategy:test_rules', kind: 'strategy', name: 'test_rules' }], { strategies: [{ ...s, sessions: ['ny'] }], fields: FIELDS, timeframeMin: 1 });
  const nyDir = ny[0].perField[0].dir;
  assert.ok(nyDir.some(Boolean));
  for (const i of nyDir.keys()) {
    if (!nyDir[i]) continue;
    const close = new Date(bars[i].ms + MIN).toISOString().slice(11, 16);
    assert.ok(close >= '14:30' && close <= '21:00', `fired at a bar closing ${close}Z`);
  }
  assert.ok(onF.dir.some((v, i) => v && new Date(bars[i].ms + MIN).toISOString().slice(11, 16) < '14:30'), 'without sessions it fires before the open too');
  // A side with every condition removed never fires, and the report says so.
  const gone = fcf.withoutField(compileRules({ long: ['field("x.f") > 0'], short: ['close < open'] }).compiled, 'x.f');
  assert.deepStrictEqual(gone.excluded, ['field("x.f") > 0', '(the long side has no condition left: it never fires)']);
  // A strategy on another timeframe, unknown, or not rules: refused.
  assert.throws(() => fcf.strategiesFor({ spec: 'strategy:test_rules', name: 'test_rules' }, [{ ...s, timeframe: '3m' }], 1), /trades 3m bars/);
  assert.throws(() => fcf.strategiesFor({ spec: 'strategy:nope', name: 'nope' }, [s], 1), /no strategy/);
  assert.throws(() => fcf.strategiesFor({ spec: 'strategy:test_rules', name: 'test_rules' }, [{ ...s, signal: 'manual' }], 1), /not a valid rules/);
  assert.throws(() => fcf.strategiesFor({ spec: 'strategy:test_rules', name: 'test_rules' }, [{ ...s, status: 'disabled' }], 1), /is disabled/);
  assert.throws(() => fcf.strategiesFor({ spec: 'strategy:all', name: 'all' }, [s], 5), /no rules strategy trades 5m bars/);
  assert.deepStrictEqual(fcf.strategiesFor({ spec: 'strategy:all', name: 'all' }, [s, { ...s, name: 'b', timeframe: '3m' }, { ...s, name: 'c', status: 'disabled' }], 1).map(x => x.name), ['test_rules']);
  // Chunks joined in order; chunks naming different strategies are refused.
  const one = { spec: 'strategy:a', name: 'a', perField: [{ excluded: [], reads: [], dir: Int8Array.from([1, 0]) }] };
  const two = { ...one, perField: [{ excluded: [], reads: [], dir: Int8Array.from([0, -1, 1]) }] };
  const j2 = fcf.joinStrategyEvents([[{ ...one, warmup: 2, cold: 1 }], [{ ...two, warmup: 3, cold: 1 }]], 5)[0];
  assert.deepStrictEqual(Array.from(j2.perField[0].dir), [1, 0, 0, -1, 1]);
  assert.deepStrictEqual([j2.warmupBars, j2.coldFiles], [5, 2]);
  assert.throws(() => fcf.joinStrategyEvents([[one], [{ ...one, spec: 'strategy:b' }]], 4), /different strategies/);
});

test('the CLI: --event runs the confluence study, writes Markdown and JSON, and keeps the split rule', () => {
  const dir = tmpDir();
  const bars = synthBars({ days: 8 });
  const line = b => JSON.stringify({ ...b, ms: undefined });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), bars.slice(0, 2160).map(line).join('\n'));
  fs.writeFileSync(path.join(dir, 'b.jsonl'), bars.slice(2160).map(line).join('\n'));
  // The fixture strategies (the retired strategies' rules): strategy:all finds fx_ofi and fx_ofi_absorption (1m).
  const run = args => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'field-study.js'), ...args], { encoding: 'utf8', env: { ...process.env, FTH_HOME: dir, FTH_STRATEGIES_DIRS: FX_GOLDEN } });
  const out = path.join(dir, 'out');
  const r = run(['--data', dir, '--symbol', 'MNQ', '--fields', 'x.f', '--event', 'expansion:1.5,breakout:20,strategy:all', '--horizons', '1,5', '--by', 'session', '--r', 'atr', '--reps', '50', '--out', out]);
  assert.strictEqual(r.status, 0, r.stderr);
  const json = JSON.parse(fs.readFileSync(path.join(out, 'field-confluence.json'), 'utf8'));
  assert.strictEqual(json.header.rMode, 'atr');
  assert.deepStrictEqual(json.header.months.map(m => m.role), ['train']);
  const events = [...new Set(json.results.map(x => x.event))];
  assert.ok(events.includes('expansion:1.5') && events.includes('breakout:20'));
  assert.ok(events.filter(e => e.startsWith('strategy:')).length >= 1, 'strategy:all names the 1m strategies');
  assert.strictEqual(json.results.length, events.length * 2 * 2);
  assert.match(fs.readFileSync(path.join(out, 'field-confluence.md'), 'utf8'), /# Field-confluence study[\s\S]*By session/);
  // Its own report in the data directory is never read back as bars.
  fs.copyFileSync(path.join(out, 'field-confluence.json'), path.join(dir, 'field-confluence.json'));
  assert.strictEqual(run(['--data', dir, '--symbol', 'MNQ', '--fields', 'x.f', '--event', 'expansion:2', '--reps', '20']).status, 0);
  // A strategy on another timeframe, a bad event, a bad R: refused.
  const fixture3m = loadStrategies(ROOT, { FTH_STRATEGIES_DIRS: FX_GOLDEN }).strategies.find(x => x.valid && x.signal === 'rules' && x.timeframe === '3m');
  assert.match(run(['--data', dir, '--symbol', 'MNQ', '--fields', 'x.f', '--event', `strategy:${fixture3m.name}`]).stderr, /trades 3m bars/);
  assert.match(run(['--data', dir, '--symbol', 'MNQ', '--fields', 'x.f', '--event', 'gap:3']).stderr, /--event/);
  assert.match(run(['--data', dir, '--symbol', 'MNQ', '--fields', 'x.f', '--event', 'expansion:2', '--r', 'range']).stderr, /--r: bar or atr/);
  assert.match(run(['--data', dir, '--symbol', 'MNQ', '--fields', 'x.f', '--r', 'atr']).stderr, /--r is for the confluence study/);
  // Strategy events from two files line up with the bars: a field-free strategy (from FTH_STRATEGIES_DIRS) gives
  // the same per-file events through the CLI as the lib computes on each file.
  const sdir = path.join(dir, 'strategies', 'test_break');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'STRATEGY.md'), ['---', 'name: test_break', 'description: a test 1-minute breakout of the last ten bars, used only by the confluence tests.', 'version: 1', 'status: paper', 'instruments: [MNQ]', 'timeframe: 1m', 'signal: rules', 'rules:', '  long:', '    - close > highest(10)[1]', '  short:', '    - close < lowest(10)[1]', 'risk:', '  stop: atr:1', '  min_rr: 2', 'source: test', '---', '', '# Test', '', '## When to Use', '', 'Tests.', '', '## How It Works', '', 'Tests.', '', '## Examples', '', 'Tests.', ''].join('\n'));
  const env2 = { FTH_STRATEGIES_DIRS: path.join(dir, 'strategies') };
  const mine = loadStrategies(ROOT, env2).strategies.find(x => x.name === 'test_break');
  assert.ok(mine && mine.valid, JSON.stringify(mine && mine.errors));
  const two = path.join(dir, 'two');
  fs.mkdirSync(two);
  fs.copyFileSync(path.join(dir, 'a.jsonl'), path.join(two, 'a.jsonl'));
  fs.copyFileSync(path.join(dir, 'b.jsonl'), path.join(two, 'b.jsonl'));
  const out2 = path.join(dir, 'out2');
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'field-study.js'), '--data', two, '--symbol', 'MNQ', '--fields', 'x.f', '--event', 'strategy:test_break', '--horizons', '1', '--thresholds', '0', '--reps', '20', '--out', out2], { encoding: 'utf8', env: { ...process.env, FTH_HOME: dir, ...env2 } });
  assert.strictEqual(r2.status, 0, r2.stderr);
  const got = JSON.parse(fs.readFileSync(path.join(out2, 'field-confluence.json'), 'utf8')).results[0];
  // Expected: the lib on each file alone, joined, paired at k=1 over the joined table.
  const files = [bars.slice(0, 2160), bars.slice(2160)];
  const joined = fcf.joinStrategyEvents(files.map(f => fcf.chunkStrategyEvents(f, [{ spec: 'strategy:test_break', kind: 'strategy', name: 'test_break' }], { strategies: [mine], fields: [FIELDS[0]], timeframeMin: 1 })), bars.length);
  const tj = fsy.joinChunks(files.map(f => fsy.columns(f, [FIELDS[0]])), { timeframeMin: 1 });
  const E = fcf.eventPairs(tj, joined[0].perField[0].dir, 0, 0, 1, { tick: TICK, atr: fcf.priorAtr(tj) });
  assert.ok(E.n > 50);
  assert.deepStrictEqual([got.events, got.n, got.classes.map(k => k.n)], [E.events, E.n, fcf.summarizeClasses(E, 0).classes.map(k => k.n)]);
  // The second file's events start WARMUP bars into it, as the first's do.
  const d = joined[0].perField[0].dir;
  assert.ok(d.subarray(2160, 2160 + fcf.WARMUP).every(v => v === 0) && d.subarray(2160 + fcf.WARMUP).some(Boolean));
  // A file too short to warm a strategy up is warned about.
  const short = path.join(dir, 'short');
  fs.mkdirSync(short);
  fs.writeFileSync(path.join(short, 's.jsonl'), bars.slice(0, 400).map(line).join('\n'));
  const sr = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'field-study.js'), '--data', short, '--symbol', 'MNQ', '--fields', 'x.f', '--event', 'strategy:test_break', '--reps', '20'], { encoding: 'utf8', env: { ...process.env, FTH_HOME: dir, ...env2 } });
  assert.strictEqual(sr.status, 0, sr.stderr);
  assert.match(sr.stderr, /WARNING: 1 file\(s\) hold no more than 500 bars/);
  assert.match(sr.stdout, /WARNING: 1 file\(s\) hold no more than 500 bars/);
  // Held-out months are refused here too.
  const late = path.join(dir, 'late');
  fs.mkdirSync(late);
  fs.writeFileSync(path.join(late, 'l.jsonl'), bars.map(b => JSON.stringify({ ...b, ms: undefined, t: new Date(Date.parse(b.t) + 600 * 86400000).toISOString() })).join('\n'));
  const refused = run(['--data', late, '--symbol', 'MNQ', '--fields', 'x.f', '--event', 'expansion:2']);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /refused: .*held-out-look/);
});
