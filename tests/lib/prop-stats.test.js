'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stats = require('../../scripts/lib/prop/stats');

/** n outcomes in time order, a share `p` of them 1, in runs of `run` (overlapping attempts share outcomes). */
function outcomes(n, p, run = 5, seed = 3) {
  const r = stats.rng(seed);
  const out = [];
  while (out.length < n) {
    const v = r() < p ? 1 : 0;
    for (let k = 0; k < run && out.length < n; k += 1) out.push(v);
  }
  return out;
}

test('stats: a seed gives the same draws; streams per label are independent and reproducible', () => {
  const a = stats.rng(7);
  const b = stats.rng(7);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepStrictEqual(xs, Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every(x => x >= 0 && x < 1));
  assert.notDeepStrictEqual(xs, Array.from({ length: 5 }, stats.rng(8)));
  const s1 = stats.streamFor(1, 'paths');
  const s2 = stats.streamFor(1, 'paths');
  assert.strictEqual(s1(), s2());
  assert.notStrictEqual(stats.streamFor(1, 'paths')(), stats.streamFor(1, 'interval')());
  assert.throws(() => stats.rng(1.5), /seed/);
});

test('stats: the block bootstrap interval holds the rate and shrinks as the attempts grow', () => {
  const width = n => {
    const iv = stats.blockBootstrap(outcomes(n, 0.4), { block: 30, reps: 1500, rand: stats.rng(11) });
    assert.ok(iv.lo <= iv.rate && iv.rate <= iv.hi, JSON.stringify(iv));
    assert.strictEqual(iv.level, 0.9);
    return iv.hi - iv.lo;
  };
  const w = [width(120), width(600), width(3000)];
  assert.ok(w[0] > w[1] && w[1] > w[2], `widths ${w}`);
  // Larger blocks (more overlap) give a wider interval on the same outcomes: overlap is never counted as independence.
  const xs = outcomes(600, 0.4, 30);
  const iv1 = stats.blockBootstrap(xs, { block: 1, reps: 1500, rand: stats.rng(2) });
  const iv30 = stats.blockBootstrap(xs, { block: 30, reps: 1500, rand: stats.rng(2) });
  assert.ok(iv30.hi - iv30.lo > iv1.hi - iv1.lo, `${JSON.stringify(iv1)} ${JSON.stringify(iv30)}`);
  assert.deepStrictEqual(stats.blockBootstrap([], { block: 5, rand: stats.rng(1) }).rate, null);
  assert.throws(() => stats.blockBootstrap([1], { block: 0, rand: stats.rng(1) }), /block/);
});

test('stats: the Wilson interval shrinks with n and stays in [0, 1]', () => {
  const a = stats.wilson(4, 10);
  const b = stats.wilson(40, 100);
  const c = stats.wilson(400, 1000);
  assert.ok(a.hi - a.lo > b.hi - b.lo && b.hi - b.lo > c.hi - c.lo);
  assert.deepStrictEqual([stats.wilson(0, 5).lo, stats.wilson(5, 5).hi], [0, 1]);
  assert.strictEqual(stats.wilson(0, 0).rate, null);
  assert.throws(() => stats.wilson(1, 2, 0.5), /level/);
});

test('stats: the effective sample size counts non-overlapping attempts (R7 scale: 222 starts at 30 sessions = 8)', () => {
  assert.strictEqual(stats.effectiveSampleSize(Array.from({ length: 222 }, (_, i) => i), 30), 8);
  assert.strictEqual(stats.effectiveSampleSize(Array.from({ length: 516 }, (_, i) => i), 30), 18);
  assert.strictEqual(stats.effectiveSampleSize([0, 10, 29, 30, 59, 60], 30), 3);
  assert.strictEqual(stats.effectiveSampleSize([], 30), 0);
});

test('stats: the stationary bootstrap walks forward in blocks and joins only days of the same regime', () => {
  const regimes = Array.from({ length: 200 }, (_, i) => (Math.floor(i / 20) % 2 ? 'high' : 'low'));
  const rand = stats.rng(5);
  let joins = 0;
  let runs = 0;
  for (let p = 0; p < 300; p += 1) {
    const path = stats.stationaryPath(200, 30, { meanBlock: 7, rand, regimes });
    assert.strictEqual(path.length, 30);
    for (let k = 1; k < path.length; k += 1) {
      if (path[k] === path[k - 1] + 1) runs += 1;
      else {
        joins += 1;
        assert.strictEqual(regimes[path[k]], regimes[path[k - 1]], 'a new block starts on a day of the regime just placed');
      }
    }
  }
  // Mean block 7: about one join in seven steps.
  const share = joins / (joins + runs);
  assert.ok(share > 0.09 && share < 0.2, `join share ${share}`);
  assert.deepStrictEqual(stats.stationaryPath(50, 10, { meanBlock: 5, rand: stats.rng(9) }), stats.stationaryPath(50, 10, { meanBlock: 5, rand: stats.rng(9) }));
  assert.throws(() => stats.stationaryPath(0, 5, { meanBlock: 5, rand }), /no days/);
});

test('stats: median (upper middle, as the combine report) and quantile', () => {
  assert.strictEqual(stats.median([3, 1, 2]), 2);
  assert.strictEqual(stats.median([4, 1, 2, 3]), 3);
  assert.strictEqual(stats.median([]), null);
  assert.strictEqual(stats.quantile([1, 2, 3, 4, 5], 0.05), 1);
  assert.strictEqual(stats.quantile([], 0.5), null);
});
