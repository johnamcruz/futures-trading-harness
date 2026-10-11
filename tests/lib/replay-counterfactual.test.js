'use strict';

// Counterfactual outcomes (scripts/lib/replay/counterfactual.js): the backtester's fills and exits on synthetic bars.

const test = require('node:test');
const assert = require('node:assert');
const { simulate, fromFills } = require('../../scripts/lib/replay/counterfactual');

const MNQ = { tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 };
const TF = 180000;
const S0 = Date.parse('2026-03-03T15:00:00Z'); // the signal bar's open (10:00 ET)
const EOD = Date.parse('2026-03-03T20:50:00Z'); // 15:50 ET
const flat = (n, from = 1) => Array.from({ length: n }, (_, k) => ({ o: 100, h: 101, l: 99, c: 100, ms: S0 + (from + k) * TF }));
const series = (...moves) => [{ o: 100, h: 101, l: 99, c: 100, ms: S0 }, ...moves.map((b, k) => ({ o: 100, h: 101, l: 99, c: 100, ...b, ms: S0 + (k + 1) * TF }))];
const RR2 = { name: 'orb', signal: 'rules', risk: { min_rr: 2 }, exit: {} };
const sim = (bars, x = {}) => simulate({ bars, tfMs: TF, signalMs: S0, signalClose: 100, direction: 'long', stopDistance: 9.9, strategy: RR2, spec: MNQ, eodMs: EOD, ...x });

test('counterfactual: a long hits its target - next-open fill with slippage, order_plan\'s brackets (stop ceiled to ticks, never tighter)', () => {
  const cf = sim(series({}, { h: 121 }));
  // Entry 100 + 1 tick; stop 9.9 -> 40 ticks = 10 points; target 2R of the placed stop: 80 ticks = 20 points.
  assert.deepStrictEqual([cf.entry, cf.stop, cf.target, cf.exitPrice, cf.exitReason], [100.25, 90.25, 120.25, 120.25, 'target']);
  assert.deepStrictEqual([cf.R, cf.result, cf.simulated, cf.source], [2, 'win', true, 'simulated']);
  // P&L per contract: 80 ticks x $0.50, less $0.37 a side.
  assert.deepStrictEqual([cf.pnl, cf.net], [40, 39.26]);
  assert.strictEqual(cf.mfeR, 2.075, 'the high was 20.75 points over the entry');
  assert.strictEqual(cf.exitTime, new Date(S0 + 3 * TF).toISOString(), 'the close of the bar it exited in');
});

test('counterfactual: a short stopped out - stop fill less slippage, R negative', () => {
  const cf = sim(series({}, { h: 111 }), { direction: 'short' });
  // Entry 100 - 1 tick = 99.75; stop 109.75, filled a tick worse at 110.
  assert.deepStrictEqual([cf.entry, cf.stop, cf.exitPrice, cf.exitReason, cf.R, cf.result], [99.75, 109.75, 110, 'stop', -1.025, 'loss']);
  assert.strictEqual(cf.maeR, -1.025);
});

test('counterfactual: a bar reaching both the stop and the target is a loss (stop first, conservative)', () => {
  const cf = sim(series({}, { h: 125, l: 85 }));
  assert.deepStrictEqual([cf.exitReason, cf.result], ['stop', 'loss']);
});

test('counterfactual: neither stop nor target by end of day exits at the end-of-day bar\'s close', () => {
  const bars = [{ o: 100, h: 101, l: 99, c: 100, ms: S0 }, ...flat(200)];
  const cf = sim(bars);
  assert.strictEqual(cf.exitReason, 'eod');
  assert.strictEqual(cf.exitTime, new Date(EOD + 60000).toISOString(), 'the first bar closing at or after 15:50 ET (the 15:48 bar)');
  assert.deepStrictEqual([cf.exitPrice, cf.R, cf.result], [100, -0.025, 'loss']);
  // Into another trading day without a bar at end of day: closed at the last bar of the day.
  const gap = [{ o: 100, h: 101, l: 99, c: 100, ms: S0 }, ...flat(3), { o: 100, h: 101, l: 99, c: 104, ms: S0 + 4 * TF }, { o: 100, h: 101, l: 99, c: 100, ms: EOD + 3 * 3600000 }];
  const g = sim(gap);
  assert.deepStrictEqual([g.exitReason, g.exitPrice], ['eod', 104]);
});

test('counterfactual: a trailing exit runs as the backtester trails it', () => {
  const trail = { name: 'trend', signal: 'rules', risk: { min_rr: 1 }, exit: { trail_activate_r: 1, trail_giveback_r: 0.5 } };
  // Up to +1.525R (the stop trails to entry + 1.025R = 110.5), then back through it: filled a tick worse.
  const cf = sim(series({}, { h: 115.5, l: 113, c: 114 }, { o: 112, h: 112, l: 108, c: 109 }), { strategy: trail });
  assert.deepStrictEqual([cf.exitReason, cf.exitPrice, cf.R, cf.target], ['trail', 110.25, 1, null]);
});

test('counterfactual: entries that never happen and exits that can\'t be simulated', () => {
  // The next bar opens through the stop: no trade (simulated, expired).
  const gapped = sim(series({ o: 85, h: 86, l: 84, c: 85 }));
  assert.deepStrictEqual([gapped.simulated, gapped.exitReason, gapped.result, gapped.R], [true, 'expired', 'no-trade', null]);
  const why = cf => [cf.simulated, cf.reason, cf.R];
  assert.deepStrictEqual(why(sim(series({}), { strategy: null })), [false, 'strategy not found', null]);
  assert.deepStrictEqual(why(sim(series({}), { stopDistance: null })), [false, 'no stop distance', null]);
  assert.deepStrictEqual(why(sim(series({}), { strategy: { ...RR2, exit: { target: 'crt_far_side' } } })), [false, 'no target distance', null]);
  assert.deepStrictEqual(why(sim(series())), [false, 'no bars after the signal', null]);
  assert.deepStrictEqual(why(sim(series({}, {}))), [false, 'the bars end before the exit', null]);
  assert.deepStrictEqual(why(sim(series({}), { strategy: { ...RR2, signal: 'manual' } })), [false, 'manual strategy', null]);
  // An exit.target level: the scan's distance floored to ticks (44 = 11 points), from the fill, as order_plan places it.
  const level = sim(series({}, { h: 112 }), { strategy: { ...RR2, risk: { min_rr: 1 }, exit: { target: 'crt_far_side' } }, targetDistance: 11.1 });
  assert.deepStrictEqual([level.target, level.exitReason], [111.25, 'target']);
});

test('counterfactual: a taken trade\'s same fields from its fills (MAE/MFE from the bars when the broker sends none)', () => {
  const out = { filled: true, entryTime: new Date(S0 + TF).toISOString(), entryPrice: 100, side: 'sell', size: 2, exitTime: new Date(S0 + 3 * TF).toISOString(), exitPrice: 95, exitReason: null, pnl: 20, net: 18.52, r: 1, maeR: null, mfeR: null, result: 'win' };
  const bars = series({ h: 102, l: 97 }, { h: 101, l: 94 }, { h: 130, l: 70 });
  const cf = fromFills(out, { stopPoints: 5, targetTicks: 20, spec: MNQ, bars, tfMs: TF, strategy: 'orb', direction: 'short' });
  assert.deepStrictEqual([cf.entry, cf.stop, cf.target, cf.R, cf.pnl, cf.net, cf.simulated, cf.source], [100, 105, 95, 1, 10, 9.26, false, 'fills']);
  // Over the bars the trade spanned (the bar after the exit isn't): worst 102 (-0.4R), best 94 (+1.2R).
  assert.deepStrictEqual([cf.maeR, cf.mfeR], [-0.4, 1.2]);
  assert.deepStrictEqual([fromFills({ filled: false, result: 'unfilled' }).simulated, fromFills({ filled: false, result: 'unfilled' }).reason], [false, 'not filled']);
  // A fill in the middle of a bar: that bar's extremes may come before it, so it is left out.
  const mid = fromFills({ ...out, entryTime: new Date(S0 + TF + 60000).toISOString() }, { stopPoints: 5, spec: MNQ, bars, tfMs: TF });
  assert.deepStrictEqual([mid.maeR, mid.mfeR], [-0.2, 1.2]);
});

test('counterfactual: the stop is ceiled to ticks where rounding would tighten it', () => {
  // 4.30 points = 17.2 ticks: 18 ticks (4.5 points), not 17.
  const cf = sim(series({}, { l: 90 }), { stopDistance: 4.3, strategy: { ...RR2, exit: {}, risk: { min_rr: 1 } } });
  assert.strictEqual(cf.stop, 100.25 - 4.5);
});

test('counterfactual: end of day - a next bar closing at end of day is no entry; a bar closing exactly at end of day exits there', () => {
  // The grid puts a bar's close exactly at 15:50 ET (20:50Z): the 20:47 bar.
  const at = (hhmm, x = {}) => ({ o: 100, h: 101, l: 99, c: 100, ms: Date.parse(`2026-03-03T${hhmm}:00Z`), ...x });
  const signal = Date.parse('2026-03-03T20:44:00Z');
  const run = (list, s) => simulate({ bars: list, tfMs: TF, signalMs: s, signalClose: 100, direction: 'long', stopDistance: 9.9, strategy: RR2, spec: MNQ, eodMs: EOD });
  const expired = run([at('20:44'), at('20:47'), at('20:50')], signal);
  assert.deepStrictEqual([expired.exitReason, expired.reason], ['expired', 'the next bar is past end of day']);
  const s2 = Date.parse('2026-03-03T20:41:00Z');
  const cf = run([at('20:41'), at('20:44'), at('20:47', { c: 101 }), at('20:50', { c: 105 })], s2);
  assert.deepStrictEqual([cf.exitReason, cf.exitPrice, cf.exitTime], ['eod', 101, '2026-03-03T20:50:00.000Z']);
});
