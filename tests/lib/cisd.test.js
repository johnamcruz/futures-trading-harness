'use strict';

// The CISD hypotheses (scripts/lib/trading/cisd.js), each pinned: what a run is, the level, the confirming close, the
// sweep of a key level, the displacement leg and its OTE zone (fib.js), the bounce, the void, the expiry, symmetry
// between long and short, and causality (completed candles only).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const cisd = require('../../scripts/lib/trading/cisd');
const fib = require('../../scripts/lib/trading/fib');
const rules = require('../../scripts/lib/trading/rules');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { normalizeBars, atr: atrOf } = require('../../scripts/lib/trading/indicators');

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} vs ${b}`);
const K = (o, h, l, c) => ({ o, h, l, c });

test('a bullish CISD: a run of 2+ bearish candles, then a close above the run\'s first open', () => {
  const ev = cisd.findCisds([K(100, 101, 99.5, 100.75), K(100.75, 101, 99, 99.5), K(99.5, 99.75, 97, 97.5), K(97.5, 101.5, 97.25, 101.25)]);
  assert.deepStrictEqual(ev, [{ dir: 1, level: 100.75, runStart: 1, runEnd: 2, confirm: 3 }]);
});

test('a bearish CISD is the mirror: a run of 2+ bullish candles, then a close below the run\'s first open', () => {
  const ev = cisd.findCisds([K(100, 100.5, 99, 99.25), K(99.25, 101, 99, 100.5), K(100.5, 103, 100.25, 102.5), K(102.5, 102.75, 98.5, 98.75)]);
  assert.deepStrictEqual(ev, [{ dir: -1, level: 99.25, runStart: 1, runEnd: 2, confirm: 3 }]);
});

test('the run hypothesis: one opposing candle is no run (minRun 2); a doji ends a run; minRun is a parameter', () => {
  const one = [K(100, 101, 99, 100.5), K(100.5, 100.75, 99, 99.5), K(99.5, 101.5, 99.25, 101.25)];
  assert.deepStrictEqual(cisd.findCisds(one), []);
  assert.strictEqual(cisd.findCisds(one, { minRun: 1 }).filter(e => e.dir === 1).length, 1);
  const doji = [K(101, 101, 99, 100), K(100, 100.25, 99.5, 100), K(100, 100.25, 98, 99), K(99, 101.5, 98.75, 101.25)];
  assert.deepStrictEqual(cisd.findCisds(doji), [], 'the doji split the bearish candles into runs of one');
});

test('the close must come within maxWait candles of the run\'s end; a newer run replaces the reference', () => {
  const run = [K(101, 101.25, 99.75, 100), K(100, 100.25, 98.75, 99)];
  const flat = Array.from({ length: 6 }, () => K(99, 99.5, 98.5, 99));
  const late = [...run, ...flat, K(99, 101.5, 99, 101.25)];
  assert.deepStrictEqual(cisd.findCisds(late), [], 'the 7th candle after the run is too late');
  assert.strictEqual(cisd.findCisds(late, { maxWait: 7 }).length, 1);
  // A second, lower run: its open (99.5) is the level now, not the first run's 101.
  const newer = [...run, K(99, 99.75, 98.5, 99.5), K(99.5, 99.75, 98, 98.25), K(98.25, 98.5, 97, 97.5), K(97.5, 99.75, 97.25, 99.6)];
  assert.deepStrictEqual(cisd.findCisds(newer), [{ dir: 1, level: 99.5, runStart: 3, runEnd: 4, confirm: 5 }]);
});

// The scenario on 3m bars, each its own candle (m = 3): a bearish run from 100.75 sweeps the prior RTH low 98 and a
// bullish candle closes above 100.75; the leg extends to 103, price retraces into the OTE zone and bounces.
const T0 = Date.parse('2026-03-02T15:00:00Z'); // 10:00 ET
const at = i => new Date(T0 + i * 180000).toISOString();
const SCENARIO = [
  [100, 101, 99.5, 100.75], [100.75, 101, 99, 99.5], [99.5, 99.75, 97, 97.5], [97.5, 101.5, 97.25, 101.25],
  [101.25, 103, 101, 102.75], [102.75, 102.75, 100, 100.25], [100.25, 100.5, 99, 99.25], [99.25, 100.25, 98.75, 100],
  [100, 100.5, 99.75, 100.25],
];
const barsOf = rows => rows.map(([o, h, l, c], i) => ({ t: at(i), o, h, l, c, v: 100 }));
const levelsOf = (n, { low = NaN, high = NaN } = {}) => ({
  prior_high: new Array(n).fill(high), prior_low: new Array(n).fill(low), overnight_high: new Array(n).fill(NaN), overnight_low: new Array(n).fill(NaN),
});
const run = (rows, opts = {}) => {
  const bars = barsOf(rows);
  return cisd.cisdSeries(bars, 3, { levels: levelsOf(bars.length, opts.levels || { low: 98 }), atr: new Array(bars.length).fill(2), params: opts.params });
};

test('the leg, the zone and the bounce: the OTE of the extended leg, entry on the completed bar closing above the zone', () => {
  const s = run(SCENARIO);
  assert.deepStrictEqual(s.dir, [0, 0, 0, 1, 1, 1, 1, 1, 1], 'known from the confirming bar on');
  assert.strictEqual(s.level[3], 100.75);
  assert.deepStrictEqual(s.sweep.slice(3), [1, 1, 1, 1, 1, 1], 'the prior RTH low 98 was swept and closed back above');
  // At the CISD: origin 97 (the sweep low), extreme 101.5.
  const z0 = fib.zone({ origin: 97, extreme: 101.5 });
  close(s.top[3], z0.top); close(s.bottom[3], z0.bottom); close(s.mid[3], z0.mid);
  // Bar 4 makes a new high before any touch: the leg extends to 103 (zone 98.26-99.28).
  const z = fib.zone({ origin: 97, extreme: 103 });
  close(s.top[4], z.top, 'top'); close(s.bottom[4], z.bottom, 'bottom');
  // Bar 6 trades into the zone (low 99) and closes in it, bearish: no bounce. Bar 7 closes 100 above the top: the bounce.
  assert.deepStrictEqual(s.entry, [0, 0, 0, 0, 0, 0, 0, 1, 0], 'one entry per CISD, on the bounce bar');
  close(s.risk[7], 100 - (97 - 0.1 * 2), 'risk: the close to 0.1 x ATR beyond the origin');
  assert.deepStrictEqual(s.inOte, [0, 0, 0, 0, 0, 0, 1, 0, 0]);
  assert.strictEqual(s.last.status, 'bounced');
  assert.deepStrictEqual(s.entries.get(7).sweep, 'prior RTH low');
});

test('a bounce may close inside the zone: bullish, its close in the upper third of its range', () => {
  const rows = SCENARIO.slice(0, 7).concat([[98.9, 99.2, 98.5, 99.15]]);
  assert.strictEqual(run(rows).entry[7], 1);
  // Bullish but closing in its middle third: not a bounce.
  assert.strictEqual(run(SCENARIO.slice(0, 7).concat([[98.9, 99.6, 98.5, 99.1]])).entry[7], 0);
});

test('no bounce before price trades into the zone; never anticipated', () => {
  const rows = SCENARIO.slice(0, 5).concat([[102.75, 103, 100.5, 102.5], [102.5, 102.75, 100, 102.25]]);
  assert.deepStrictEqual(run(rows).entry, [0, 0, 0, 0, 0, 0, 0]);
});

test('void: a close beyond the 0.79 level by more than voidTol of the leg, or beyond the origin; then no entry', () => {
  // Bottom 98.26, tolerance 0.05 x 6 = 0.3: a close at 97.75 voids it.
  const rows = SCENARIO.slice(0, 6).concat([[100.25, 100.5, 97.5, 97.75], [97.75, 100.25, 97.5, 100], [100, 100.5, 99.75, 100.25]]);
  const s = run(rows);
  assert.deepStrictEqual(s.entry, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(Number.isNaN(s.top[6]) && Number.isNaN(s.top[8]), 'a void zone has no OTE');
  assert.strictEqual(s.last.status, 'void');
  // Within the tolerance (a close at 98.0): still live, the next bar bounces.
  const within = SCENARIO.slice(0, 6).concat([[100.25, 100.5, 97.75, 98], [98, 100.25, 97.9, 100]]);
  assert.strictEqual(run(within).entry[7], 1);
});

test('expiry: the zone is good for `expiry` CISD candles after the CISD closed', () => {
  const s = run(SCENARIO, { params: { expiry: 2 } });
  assert.deepStrictEqual(s.entry, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.strictEqual(s.last.status, 'expired');
});

test('the sweep: of a key level at or below the level, traded through and closed back above; else none', () => {
  assert.deepStrictEqual(run(SCENARIO, { levels: {} }).sweep.slice(3), [0, 0, 0, 0, 0, 0], 'no key level');
  assert.deepStrictEqual(run(SCENARIO, { levels: { low: 96 } }).sweep[3], 0, 'never traded below 96');
  assert.deepStrictEqual(run(SCENARIO, { levels: { low: 101 } }).sweep[3], 0, 'above the level: the run started under it');
  // A key high doesn't count for a bullish CISD.
  assert.deepStrictEqual(run(SCENARIO, { levels: { high: 98 } }).sweep[3], 0);
});

test('long and short are symmetric: mirrored prices give the mirrored CISD, zone, entry and the same risk', () => {
  const M = 200;
  const mirror = SCENARIO.map(([o, h, l, c]) => [M - o, M - l, M - h, M - c]);
  const up = run(SCENARIO);
  const down = run(mirror, { levels: { high: M - 98 } });
  assert.deepStrictEqual(down.dir, up.dir.map(x => 0 - x || 0));
  assert.deepStrictEqual(down.entry, up.entry.map(x => 0 - x || 0));
  assert.deepStrictEqual(down.sweep, up.sweep);
  assert.deepStrictEqual(down.inOte, up.inOte);
  for (let i = 3; i < SCENARIO.length; i += 1) {
    close(down.top[i], M - up.bottom[i]); close(down.bottom[i], M - up.top[i]); close(down.mid[i], M - up.mid[i]);
    close(down.level[i], M - up.level[i]);
  }
  close(down.risk[7], up.risk[7]);
});

test('a timeframe the bars can\'t build is unavailable, never guessed: 5m from 3m bars, 1m from 3m bars', () => {
  const bars = barsOf(SCENARIO);
  assert.match(cisd.cisdSeries(bars, 5, { levels: levelsOf(bars.length), atr: [] }).unavailable, /not built from 3m bars/);
  assert.match(cisd.cisdSeries(bars, 1, { levels: levelsOf(bars.length), atr: [] }).unavailable, /finer than the 3m bars/);
  assert.match(cisd.cisdFacts(bars, 5, { levels: levelsOf(bars.length), atr: [] }).unavailable, /not built/);
});

test('a 15m CISD counts only when its candle has closed: nothing at the bars inside it', () => {
  // Five 3m bars per 15m candle, from a 15m boundary: candles 0 (bull), 1 and 2 (bear), 3 (closes above candle 1's open).
  const candle = ([o, h, l, c]) => [[o, h, l, (o + c) / 2], [(o + c) / 2, h, l, (o + c) / 2], [(o + c) / 2, h, l, (o + c) / 2], [(o + c) / 2, h, l, (o + c) / 2], [(o + c) / 2, h, l, c]];
  const rows = SCENARIO.slice(0, 4).flatMap(candle);
  const bars = barsOf(rows);
  const s = cisd.cisdSeries(bars, 15, { levels: levelsOf(bars.length, { low: 98 }), atr: new Array(bars.length).fill(2) });
  assert.deepStrictEqual(s.dir.slice(15, 20), [0, 0, 0, 0, 1], 'known on the last 3m bar of the confirming 15m candle');
  assert.strictEqual(s.level[19], 100.75);
});

test('causal on real bars: every series at bar t is the same with or without the bars after t (3m, 15m, 60m)', () => {
  const bars = normalizeBars(readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv')));
  const opts = b => ({ levels: rules.causalLevels(b), atr: atrOf(b, 20) });
  for (const m of [3, 15, 60]) {
    const full = cisd.cisdSeries(bars, m, opts(bars));
    for (let t = 200; t < bars.length; t += 157) {
      const cut = bars.slice(0, t + 1);
      const part = cisd.cisdSeries(cut, m, opts(cut));
      for (const k of ['dir', 'level', 'top', 'bottom', 'inOte', 'sweep', 'entry', 'risk']) {
        const a = part[k][t]; const b = full[k][t];
        assert.ok(Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b)), `${m}m ${k} at ${t}: ${a} vs ${b}`);
      }
    }
    assert.ok(full.entry.some(x => x !== 0), `${m}m: the fixture has an entry`);
  }
});

test('the facts: the latest CISD per timeframe, compact, with the zone and whether price is in it now', () => {
  const bars = barsOf(SCENARIO.slice(0, 7));
  const f = cisd.cisdFacts(bars, 3, { levels: levelsOf(bars.length, { low: 98 }), atr: new Array(bars.length).fill(2) });
  assert.deepStrictEqual(Object.keys(f), ['tf', 'dir', 'level', 'confirmedAt', 'confirmedClose', 'run', 'sweep', 'leg', 'ote', 'status', 'priceInOte', 'retracement']);
  assert.strictEqual(f.dir, 'bullish');
  assert.deepStrictEqual(f.sweep, { name: 'prior RTH low', price: 98 });
  assert.deepStrictEqual(f.leg, { origin: 97, originAt: at(2), extreme: 103 });
  assert.strictEqual(f.status, 'touched');
  assert.strictEqual(f.priceInOte, true);
  close(f.retracement, (103 - 99.25) / 6);
  assert.strictEqual(f.confirmedAt, at(3));
  assert.strictEqual(f.confirmedClose, at(4));
  assert.deepStrictEqual(cisd.cisdFacts(barsOf(SCENARIO.slice(0, 3)), 3, { levels: levelsOf(3), atr: [] }), { tf: '3m', none: true });
  assert.strictEqual(cisd.cisdFacts(bars, 60, { levels: levelsOf(bars.length), atr: [] }).tf, '1h');
});

test('the strategy params override the hypotheses; the defaults are the documented ones', () => {
  assert.deepStrictEqual({ ...cisd.PARAMS }, { minRun: 2, maxWait: 6, expiry: 12, voidTol: 0.05, bufferAtr: 0.1 });
  assert.deepStrictEqual(cisd.paramsFrom({ cisdMinRun: 3, cisdBufferAtr: 0 }), { minRun: 3, maxWait: 6, expiry: 12, voidTol: 0.05, bufferAtr: 0 });
  assert.deepStrictEqual({ ...cisd.SNAPSHOT_PARAMS }, { cisdMinRun: 2, cisdMaxWait: 6, cisdExpiry: 12, cisdVoidTol: 0.05, cisdBufferAtr: 0.1 });
});

test('the rules language names the series: cisd_*(m), ote_*(m), in_ote(m), on completed m-minute candles', () => {
  const bars = normalizeBars(readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv')));
  const get = rules.seriesSource(bars, {});
  const s = cisd.cisdSeries(bars, 15, { levels: rules.causalLevels(bars), atr: atrOf(bars, 20) });
  const map = { cisd_dir: 'dir', cisd_level: 'level', cisd_sweep: 'sweep', ote_top: 'top', ote_bot: 'bottom', in_ote: 'inOte', cisd_entry: 'entry', cisd_risk: 'risk' };
  for (const [f, k] of Object.entries(map)) assert.deepStrictEqual(get(`${f}(15)`), s[k], f);
  assert.ok(get('cisd_dir(5)').every(Number.isNaN), '5m from 3m bars: missing, never guessed');
  const i = s.entry.findIndex(x => x !== 0);
  assert.deepStrictEqual(get.explain(i)['cisd(15)'], s.entries.get(i));
  assert.throws(() => rules.compileCondition('cisd_entry(7) > 0'), /must divide a day/);
  assert.doesNotThrow(() => rules.compileExpression('cisd_risk(15)'));
  assert.ok(!rules.NAMES.has('cisd_ote_dir') && !rules.NAMES.has('cisd_ote_risk'), 'the old port\'s series are gone');
});
