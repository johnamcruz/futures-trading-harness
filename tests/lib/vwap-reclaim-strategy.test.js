'use strict';

/**
 * vwap_reclaim on constructed bars: three days of a steady uptrend (ADX high,
 * EMA(20) rising, close above EMA(50), the 1h and 15m up), then in RTH a
 * pullback through the RTH VWAP, still above EMA(50), and a close back above
 * it. That close is the strategy's long; the same bars before 10:00 ET, or a
 * close too far above VWAP, are not.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { createEvaluator } = require('../../scripts/lib/trading/evaluator');

const ROOT = path.resolve(__dirname, '..', '..');
const VWAP_RECLAIM = loadStrategies(ROOT, {}).strategies.find(s => s.name === 'vwap_reclaim');
const S = 180000;
const OPEN = Date.UTC(2026, 9, 7, 13, 30); // 09:30 ET, 2026-10-07 (UTC-4)

/** The uptrend up to `upTo` (3 up, then 1 down of 4, every 5 bars), then two bars down `drop` and one back up `back`. */
function bars(upTo, drop, back) {
  const out = [];
  let p = 20000;
  const add = (t, c) => {
    const o = out.length ? out[out.length - 1].c : c;
    out.push({ t: new Date(t).toISOString(), o, h: Math.max(o, c) + 0.5, l: Math.min(o, c) - 0.5, c, v: 100 });
  };
  for (let t = OPEN - 3 * 864e5; t < upTo; t += S) {
    p += out.length % 5 === 4 ? -4 : 3;
    add(t, p);
  }
  add(upTo, p - drop / 2);
  add(upTo + S, p - drop);
  add(upTo + 2 * S, p - drop + back);
  return out;
}

const fires = b => {
  const ev = createEvaluator(b);
  return b.map((x, i) => ({ i, r: ev.at(VWAP_RECLAIM, i, { describe: true }) })).filter(x => x.r.candidate);
};

test('vwap_reclaim: an RTH close back above VWAP, above EMA(50), ADX >= 20, in a trend regime, is a long', () => {
  assert.strictEqual(VWAP_RECLAIM.status, 'active');
  const b = bars(OPEN + 20 * S, 20, 10); // the reclaim closes 10:36 ET
  const f = fires(b);
  assert.strictEqual(f.length, 1, JSON.stringify(f.map(x => b[x.i].t)));
  const { i, r } = f[0];
  assert.strictEqual(i, b.length - 1, 'the reclaim bar, not the pullback');
  assert.strictEqual(b[i].t, new Date(OPEN + 22 * S).toISOString());
  assert.strictEqual(r.direction, 'long');
  assert.deepStrictEqual(r.rules.long.map(x => x.ok), [true, true, true]);
  assert.ok(r.regime.startsWith('trend') && r.inRegime, r.regime);
  assert.ok(r.mtf.longAllowed, 'the trend rule allows a long');
  assert.ok(r.stopDistance > 0, 'stop: 1 ATR(20)');
  assert.strictEqual(r.minRR, 2);
});

test('vwap_reclaim: the same reclaim before 10:00 ET, or closing over 1.5 ATR above VWAP, is not a candidate', () => {
  // Reclaim at 09:51 ET: the rules hold but the session starts at 10:00.
  const early = bars(OPEN + 5 * S, 10, 10); // a smaller pullback: VWAP is only 15 minutes old
  const r = createEvaluator(early).at(VWAP_RECLAIM, early.length - 1, { describe: true });
  assert.deepStrictEqual(r.rules.long.map(x => x.ok), [true, true, true], 'control: the rules hold');
  assert.strictEqual(r.inSession, false);
  assert.strictEqual(fires(early).length, 0);
  // A reclaim bar that closes far above VWAP: the max_vwap_distance_atr filter.
  const far = bars(OPEN + 20 * S, 16, 22);
  const f = createEvaluator(far).at(VWAP_RECLAIM, far.length - 1, { describe: true });
  assert.match(f.filtersFailed.join(' '), /VWAP distance [\d.]+ ATR > 1\.5/);
  assert.strictEqual(f.candidate, false);
});
