'use strict';

/**
 * The evaluator's statistics (docs/LEARNED-RULEBOOK.md R7-R9, R15): a seeded random source, so every result
 * reproduces from its seed; the block bootstrap interval on a rate over overlapping attempts (blocks of at
 * least an attempt's length, R15); the Wilson interval; the effective sample size (non-overlapping attempts,
 * R7); and the stationary block bootstrap over trading days with regime-matched joins (R9). Pure.
 */

/** A seeded uniform [0, 1) source (mulberry32): the same seed, the same draws. */
function rng(seed) {
  if (!Number.isInteger(seed)) throw new Error(`seed: a whole number, not ${String(seed)}`);
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An independent stream for one purpose, from the run's seed and a label (so adding draws to one never moves another). */
function streamFor(seed, label) {
  let h = 2166136261 ^ (seed >>> 0);
  for (const c of String(label)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return rng(h >>> 0);
}

/** A whole number in [0, n). */
const pick = (rand, n) => Math.min(n - 1, Math.floor(rand() * n));

/** The q-quantile (0..1) of an ascending list, by the nearest rank below (conservative for a lower bound). */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const k = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[k];
}

const round4 = x => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);

/**
 * The circular moving block bootstrap interval of a rate over a sequence of 0/1 outcomes in time order
 * (neighbouring attempts share sessions, so they are resampled in blocks of `block` consecutive outcomes):
 * { rate, lo, hi, level, block, reps }. `level` is two-sided (0.9: lo is the 5th percentile). Empty: nulls.
 * Fewer than two whole blocks (n < 2 x block) is one independent observation or less: resampling it would
 * only rotate the same outcomes and give a zero-width interval, a false certainty. The interval is then
 * [0, 1], no information, with `degenerate: true`, and reps 0.
 */
function blockBootstrap(outcomes, { block, reps = 2000, level = 0.9, rand }) {
  const n = outcomes.length;
  if (!Number.isInteger(block) || block < 1) throw new Error(`block: a whole number of outcomes, not ${String(block)}`);
  if (!n) return { rate: null, lo: null, hi: null, level, block, reps: 0 };
  const sum = outcomes.reduce((a, x) => a + x, 0);
  if (n < 2 * block) return { rate: round4(sum / n), lo: 0, hi: 1, level, block, reps: 0, degenerate: true };
  const b = block;
  const blocks = Math.ceil(n / b);
  const means = new Array(reps);
  for (let r = 0; r < reps; r += 1) {
    let s = 0;
    let taken = 0;
    for (let k = 0; k < blocks; k += 1) {
      const start = pick(rand, n);
      for (let j = 0; j < b && taken < n; j += 1, taken += 1) s += outcomes[(start + j) % n];
    }
    means[r] = s / n;
  }
  means.sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  return { rate: round4(sum / n), lo: round4(quantile(means, tail)), hi: round4(quantile(means, 1 - tail)), level, block: b, reps };
}

/** The Wilson score interval for k of n at a two-sided level (0.9 by default): { rate, lo, hi, level, n }. */
function wilson(k, n, level = 0.9) {
  if (!(n > 0)) return { rate: null, lo: null, hi: null, level, n: 0 };
  const z = { 0.8: 1.2816, 0.9: 1.6449, 0.95: 1.96, 0.99: 2.5758 }[level];
  if (!z) throw new Error(`level: one of 0.8, 0.9, 0.95, 0.99, not ${level}`);
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { rate: round4(p), lo: round4(Math.max(0, c - h)), hi: round4(Math.min(1, c + h)), level, n };
}

/**
 * The effective sample size of attempts started on trading-day indices `starts` (ascending) that each span
 * `sessions` sessions: the most attempts among them that share no session, taken greedily from the first.
 */
function effectiveSampleSize(starts, sessions) {
  let n = 0;
  let free = -Infinity;
  for (const s of starts) {
    if (s >= free) { n += 1; free = s + sessions; }
  }
  return n;
}

/**
 * A stationary block bootstrap path of `length` day indices over `n` days (Politis-Romano): it starts on a
 * random day and walks forward; each next day begins a new block with probability 1 / meanBlock (or when
 * the walk runs off the end). A new block starts on a random day whose regime (`regimes[i]`) is the regime
 * of the day just placed, when one exists, so regime runs stay together across the join.
 */
function stationaryPath(n, length, { meanBlock, rand, regimes = null, byRegime = null }) {
  if (!(n > 0)) throw new Error('no days to resample');
  if (!(meanBlock >= 1)) throw new Error(`meanBlock: at least 1 day, not ${String(meanBlock)}`);
  const pool = byRegime || (regimes ? groupBy(regimes) : null);
  const path = [pick(rand, n)];
  while (path.length < length) {
    const last = path[path.length - 1];
    if (last + 1 < n && rand() >= 1 / meanBlock) { path.push(last + 1); continue; }
    const same = pool && regimes ? pool.get(regimes[last]) : null;
    path.push(same && same.length ? same[pick(rand, same.length)] : pick(rand, n));
  }
  return path;
}

/** Indices by key: Map key -> [i, ...]. */
function groupBy(keys) {
  const m = new Map();
  keys.forEach((k, i) => { if (!m.has(k)) m.set(k, []); m.get(k).push(i); });
  return m;
}

/** The median of a list of numbers (the upper middle for an even count), or null. */
function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * The q-quantile of a list of numbers by the nearest rank above (the slow side for days to pass: a p90 never
 * reads faster than the attempts were), or null.
 */
function quantileUp(xs, q) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * (s.length - 1))))];
}

module.exports = { rng, streamFor, pick, quantile, quantileUp, blockBootstrap, wilson, effectiveSampleSize, stationaryPath, groupBy, median, round4 };
