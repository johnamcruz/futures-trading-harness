'use strict';

// The model's replay trades as a trade stream (scripts/lib/prop/model-stream.js): a known run becomes the expected
// stream, field by field; passes are no-trade days; an unsettled entry is left out, said why; hidden outcomes refused.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readModelStream, modelStream, adversePath } = require('../../scripts/lib/prop/model-stream');
const { M3, record, multiDayRun } = require('../fixtures/prop-model');

const at = (iso, k) => new Date(Date.parse(iso) + k * M3).toISOString();

/** Three practice days: a long closed above its stop, a short stopped with 2 ticks of overshoot, a pass. */
function knownRun(extra = {}) {
  const d1 = '2023-03-15T14:00:00.000Z';
  const d2 = '2023-03-16T14:00:00.000Z';
  const d3 = '2023-03-17T14:00:00.000Z';
  return multiDayRun({
    days: [
      {
        day: '2023-03-15', times: [d1, at(d1, 1)], records: [record({ at: d1 })],
        fills: [
          { id: 1, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:01:00Z', price: 100, size: 1, side: 0, profitAndLoss: null },
          { id: 2, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:20:00Z', price: 98.5, size: 1, side: 1, profitAndLoss: -3 },
        ],
        rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 101, 99.5, 100.5], [100.5, 100.75, 99, 99.25], [99.25, 99.5, 98.75, 99], [99, 99.5, 99, 99.25], [99.25, 99.25, 97.5, 98], [98, 98.75, 98.25, 98.5]],
      },
      {
        day: '2023-03-16', times: [d2], records: [record({ at: d2, side: 'short', entry: 101, stop: 103, target: 97 })],
        fills: [
          { id: 3, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-16T14:01:00Z', price: 101, size: 1, side: 1, profitAndLoss: null },
          { id: 4, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-16T14:07:00Z', price: 103.75, size: 1, side: 0, profitAndLoss: -5.5 },
        ],
        rows: [[101, 101.5, 100.5, 101.25], [101.25, 102.5, 101, 102.25], [102.25, 104, 102, 103.5]],
      },
      { day: '2023-03-17', times: [d3, at(d3, 1)], records: [record({ at: d3 })], rows: [[100.5, 100.75, 100.25, 100.5], [100.5, 100.75, 100.25, 100.5]] },
    ],
    ...extra,
  });
}

test('readModelStream: a known replay run becomes the expected stream (R and ticks from the fills, the adverse path and no-stop path from its bars)', () => {
  const { dir } = knownRun();
  const { stream, run } = readModelStream(dir);
  assert.strictEqual(stream.source, 'model');
  assert.deepStrictEqual(stream.days.map(d => [d.day, d.trades.length, d.passes, d.regime]), [['2023-03-15', 1, 0, 'normal'], ['2023-03-16', 1, 0, 'normal'], ['2023-03-17', 0, 1, 'low']], "the regime: the day's range against the days before it (trade-stream.js dayRegimes)");
  const [a, b] = stream.trades;
  // Long from 100 (the fill), out at 98.5: -6 ticks of an 8-tick stop, R -0.75; troughs from the bars, the 97.5 low
  // held at the stop's fill (-9: 8 ticks and a tick of slippage); closed above the stop: no overshoot.
  assert.deepStrictEqual(
    [a.day, a.seq, a.symbol, a.direction, a.stopTicks, a.moveTicks, a.r, a.troughTicks, a.adverse, a.overshootTicks, a.reason, a.noStop],
    ['2023-03-15', 0, 'MNQ', 'long', 8, -6, -0.75, [-1, -2, -4, -5, -9], 'bars', null, 'closed', { worstTicks: -10, closeTicks: -6 }],
  );
  assert.deepStrictEqual([a.entryTime, a.exitTime, a.tickSize, a.tickValue], ['2023-03-15T14:01:00.000Z', '2023-03-15T14:20:00.000Z', 0.25, 0.5]);
  // Short from 101, stopped at 103.75: 3 ticks past the 103 stop, 2 beyond the expected tick of slippage.
  assert.deepStrictEqual(
    [b.day, b.direction, b.stopTicks, b.moveTicks, b.r, b.troughTicks, b.overshootTicks, b.reason, b.noStop],
    ['2023-03-16', 'short', 8, -11, -1.375, [-2, -6, -11], 2, 'stop', { worstTicks: -12, closeTicks: -10 }],
  );
  assert.deepStrictEqual(a.facts, { regime: 'trend-up', volatility: 'normal', window: 'ny-am', biasSide: 'with', alignment: 'aligned', dayType: 'normal', skill: a.facts.skill, exploratory: false, frame: 'default', list: null });
  assert.ok(a.facts.skill, 'the skill signature');
  assert.deepStrictEqual([stream.excluded, stream.adverse, stream.noStop, stream.rBasis], [[], { bars: 2, bound: 0 }, { known: 2, missing: 0 }, 'gross']);
  assert.deepStrictEqual([run.runId, run.from, run.to, run.learning, run.role, run.hideOutcomes], ['run1', '2023-03-15', '2023-03-18', true, 'practice-train', false]);
});

test('modelStream: without the bars, the stop bound (fails closed); an unsettled entry is left out, said why', () => {
  const entered = { id: 'x', decision: 'entered', root: 'MNQ', side: 'long', day: '2023-03-15', bar: '2023-03-15T13:57:00.000Z', plan: { entry: 100, stop: 98 }, context: {}, signatures: {},
    outcome: { source: 'fills', entryPrice: 100, exitPrice: 101, entryTime: '2023-03-15T14:01:00Z', exitTime: '2023-03-15T14:20:00Z', exitReason: 'closed', R: 0.5 } };
  const s = modelStream({ decisions: [entered], dayKeys: ['2023-03-15'], tfMs: M3 });
  assert.deepStrictEqual([s.trades[0].troughTicks, s.trades[0].adverse, s.trades[0].noStop], [[-9], 'bound', null]);
  const open = { ...entered, id: 'y', outcome: { ...entered.outcome, exitPrice: null, exitReason: 'open', R: null } };
  const t = modelStream({ decisions: [open, { ...entered, id: 'z', plan: { entry: 100, stop: null } }], dayKeys: ['2023-03-15'], tfMs: M3 });
  assert.deepStrictEqual(t.excluded.map(x => [x.id, x.why]), [['y', 'not closed (open)'], ['z', 'no stop distance in the record']]);
  assert.strictEqual(t.trades.length, 0);
  assert.deepStrictEqual(t.days.map(d => d.day), ['2023-03-15'], 'a day with no trade is still a day');
  assert.throws(() => modelStream({ decisions: [{ ...entered, hidden: true }], dayKeys: [], tfMs: M3 }), /hidden/);
});

test('adversePath: each deeper trough, never below the floor; null when no bar covers the trade', () => {
  const bars = [{ ms: 0, l: 99, h: 101 }, { ms: M3, l: 97, h: 100 }, { ms: 2 * M3, l: 90, h: 99 }];
  assert.deepStrictEqual(adversePath(bars, { entryMs: 10, exitMs: 2 * M3 + 5, tfMs: M3, side: 'long', entry: 100, tick: 0.25, floor: -20 }), [-4, -12, -20]);
  assert.strictEqual(adversePath(bars, { entryMs: 10 * M3, exitMs: 11 * M3, tfMs: M3, side: 'long', entry: 100, tick: 0.25, floor: -20 }), null);
});

test('readModelStream: a reasoning-fix look hides its outcomes, so no stream; an unfinished run is refused; a run before the gate reads as not learning', () => {
  const { dir } = knownRun({ gate: { learning: true, role: 'practice-train', look: { purpose: 'reasoning-fix' }, hideOutcomes: true } });
  assert.throws(() => readModelStream(dir), /reasoning-fix look/);
  const open = knownRun();
  const m = JSON.parse(fs.readFileSync(path.join(open.dir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(open.dir, 'manifest.json'), JSON.stringify({ ...m, finished: false }));
  assert.throws(() => readModelStream(open.dir), /not finished/);
  const { run } = readModelStream(knownRun({ gate: null }).dir);
  assert.deepStrictEqual([run.learning, run.role, run.look], [false, null, null]);
});

test('fault injection fires on model trades: every trade carries the full set of fields layer 2 reads', () => {
  const at = require('../../scripts/lib/prop/attempts');
  const { checkModelWindow, scoreStream } = require('../../scripts/lib/prop/evaluator');
  const { ACCOUNT } = require('../fixtures/prop-model');
  const { stream } = readModelStream(knownRun().dir);
  for (const t of stream.trades) {
    assert.ok(Array.isArray(t.troughTicks) && t.troughTicks.length, 'an adverse path');
    assert.ok(t.noStop, 'a no-stop path');
    assert.ok(at.stopFault(t), 'so a stop fault changes the trade, never silently drops out');
    assert.notDeepStrictEqual(at.stopFault(t), t);
  }
  assert.ok(stream.days.every(d => typeof d.regime === 'string'));
  assert.ok(stream.trades.some(t => t.overshootTicks !== null), 'a stop exit carries its overshoot');
  const score = faults => scoreStream(stream, { pass: checkModelWindow({ run: { runId: 'run1', from: '2023-03-15', to: '2023-03-18', learning: true, role: 'practice-train' } }), account: ACCOUNT, contracts: 'micro', paths: 300, reps: 100, seed: 2, faults, attribution: true });
  const faulty = score({ stopFault: 1 });
  assert.strictEqual(faulty.inputs.noFaultPath, 0);
  assert.ok(faulty.resampled.faults.injected > 0, 'stop faults fired on the model trades');
  assert.strictEqual(faulty.resampled.faults.missed, 0, 'none dropped out for want of a no-stop path');
  assert.deepStrictEqual(score({}).resampled.faults, { injected: 0, missed: 0 });
});

test('a fill no record placed is left out (a real score refuses it); trades open together are listed; the no-stop worst covers the fill\'s bar', () => {
  const entered = (id, entryTime, exitTime, extra = {}) => ({ id, decision: 'entered', root: 'MNQ', side: 'long', day: '2023-03-15', bar: '2023-03-15T13:57:00.000Z', plan: { entry: 100, stop: 98 }, context: {}, signatures: {},
    outcome: { source: 'fills', entryPrice: 100, exitPrice: 101, entryTime, exitTime, exitReason: 'closed', R: 0.5 }, ...extra });
  const a = entered('a', '2023-03-15T14:01:00.000Z', '2023-03-15T14:20:00.000Z');
  const trips = [
    { family: 'MNQ', side: 'buy', openMs: Date.parse('2023-03-15T14:01:00.000Z') },
    { family: 'MNQ', side: 'buy', openMs: Date.parse('2023-03-15T15:30:00.000Z') }, // filled after its record expired: no owner
  ];
  const s = modelStream({ decisions: [a], dayKeys: ['2023-03-15'], tfMs: M3, trips });
  assert.deepStrictEqual(s.excluded.map(x => [x.why, x.bar]), [['a fill no record placed', '2023-03-15T15:30:00.000Z']]);
  // A scale-in (a second leg while the first is open): both kept, the pair listed.
  const b = entered('b', '2023-03-15T14:10:00.000Z', '2023-03-15T14:20:00.000Z');
  const o = modelStream({ decisions: [a, b], dayKeys: ['2023-03-15'], tfMs: M3 });
  assert.deepStrictEqual(o.overlaps.map(x => [x.a, x.b]), [['a', 'b']]);
  assert.deepStrictEqual(modelStream({ decisions: [a, entered('c', '2023-03-15T14:30:00.000Z', '2023-03-15T14:40:00.000Z')], dayKeys: ['2023-03-15'], tfMs: M3 }).overlaps, []);
  // A mid-bar fill whose own bar holds the deepest low: the no-stop worst is at least as deep as the adverse path.
  const bars = [{ ms: Date.parse('2023-03-15T14:00:00.000Z'), o: 100, h: 100.5, l: 97, c: 99.5 }, { ms: Date.parse('2023-03-15T14:03:00.000Z'), o: 99.5, h: 101.5, l: 99.25, c: 101 }];
  const t = modelStream({ decisions: [entered('d', '2023-03-15T14:01:00.000Z', '2023-03-15T14:05:00.000Z')], dayKeys: ['2023-03-15'], tfMs: M3, barsFor: () => bars }).trades[0];
  assert.deepStrictEqual([t.troughTicks, t.noStop.worstTicks], [[-9], -12], 'held at the stop\'s fill with the stop working; unprotected, the fill bar\'s whole 97 low');
});

test('two fills opening at one instant: one entered decision credits one of them; the other is left out', () => {
  const d = { id: 'a', decision: 'entered', root: 'MNQ', side: 'long', day: '2023-03-15', bar: '2023-03-15T13:57:00.000Z', plan: { entry: 100, stop: 98 }, context: {}, signatures: {},
    outcome: { source: 'fills', entryPrice: 100, exitPrice: 101, entryTime: '2023-03-15T14:01:00.000Z', exitTime: '2023-03-15T14:20:00.000Z', exitReason: 'closed', R: 0.5 } };
  const ms = Date.parse('2023-03-15T14:01:00.000Z');
  const s = modelStream({ decisions: [d], dayKeys: ['2023-03-15'], tfMs: M3, trips: [{ family: 'MNQ', side: 'buy', openMs: ms }, { family: 'MNQ', side: 'buy', openMs: ms }] });
  assert.deepStrictEqual(s.excluded.map(x => x.why), ['a fill no record placed']);
});

test('day-stop: a pass after a net loss that day, only when no entry followed it; a scratch that pays its fees is a loss', () => {
  const ent = (id, entryTime, exitTime, exitPrice) => ({ id, decision: 'entered', root: 'MNQ', side: 'long', day: '2023-03-15', bar: entryTime, cycleAt: entryTime, plan: { entry: 100, stop: 98, target: 104 }, context: {}, signatures: {},
    outcome: { source: 'fills', entryPrice: 100, exitPrice, entryTime, exitTime, exitReason: 'closed', R: (exitPrice - 100) / 2 } });
  const pass = { id: 'p', decision: 'passed', root: 'MNQ', side: 'long', day: '2023-03-15', bar: '2023-03-15T14:36:00.000Z', cycleAt: '2023-03-15T14:39:00.000Z', plan: { entry: 100, stop: 98, target: 104 }, context: {}, signatures: {},
    outcome: { source: 'counterfactual', filled: true, entryPrice: 100, exitPrice: 104, entryTime: '2023-03-15T14:42:00.000Z', exitTime: '2023-03-15T14:51:00.000Z', exitReason: 'target', R: 2 } };
  const loss = ent('l', '2023-03-15T14:30:00.000Z', '2023-03-15T14:36:00.000Z', 99);
  const later = ent('n', '2023-03-15T14:45:00.000Z', '2023-03-15T14:50:00.000Z', 101);
  const kind = decisions => modelStream({ decisions, dayKeys: ['2023-03-15'], tfMs: M3 }).days[0].passed[0].actions[0];
  assert.strictEqual(kind([loss, pass, later]), 'pass', 'the model entered again at 14:45: it did not stop for the day');
  assert.strictEqual(kind([loss, pass]), 'day-stop');
  // A scratch: out at its entry price, so it loses its fees (net), as attempts.js counts a loss.
  assert.strictEqual(kind([ent('s', '2023-03-15T14:30:00.000Z', '2023-03-15T14:36:00.000Z', 100), pass]), 'day-stop');
  assert.strictEqual(kind([ent('w', '2023-03-15T14:30:00.000Z', '2023-03-15T14:36:00.000Z', 100.5), pass]), 'pass', 'two ticks won ($1.00) pay the $0.74 of fees: no loss');
});

test('early-exit hold: the real fill\'s price, the bracket placed from it (a mid-bar fill at 100.00, the bar opening at 99.50)', () => {
  const ms = iso => Date.parse(iso);
  // Fill at 100.00 at 14:01 inside the 14:00 bar (open 99.50); closed early at 100.50 at 14:05. Stop 98.00 from the real
  // fill (8 ticks), target 104.00. The 14:06 bar reaches 97.75: the stop from 100 is hit; from 99.50 (97.50) it would not be.
  const bars = [
    { ms: ms('2023-03-15T14:00:00.000Z'), o: 99.5, h: 104.5, l: 99.25, c: 100.25 }, // its high at the target: before or after the fill, unknown
    { ms: ms('2023-03-15T14:03:00.000Z'), o: 100.25, h: 101, l: 99, c: 99.5 },
    { ms: ms('2023-03-15T14:06:00.000Z'), o: 99.5, h: 99.5, l: 97.75, c: 98 },
  ];
  const d = { id: 'e', decision: 'entered', root: 'MNQ', side: 'long', day: '2023-03-15', bar: '2023-03-15T13:57:00.000Z', plan: { entry: 100, stop: 98, target: 104 }, context: {}, signatures: {},
    outcome: { source: 'fills', entryPrice: 100, exitPrice: 100.5, entryTime: '2023-03-15T14:01:00.000Z', exitTime: '2023-03-15T14:05:00.000Z', exitReason: 'closed', R: 0.25 } };
  const t = modelStream({ decisions: [d], dayKeys: ['2023-03-15'], tfMs: M3, barsFor: () => bars }).trades[0];
  assert.deepStrictEqual(t.actions, ['early-exit']);
  assert.deepStrictEqual([t.hold.reason, t.hold.moveTicks, t.hold.r, t.hold.stopTicks], ['hold (stop)', -9, -1.125, 8], 'stopped at 98 less a tick of slippage, from the 100.00 fill');
});

test('bracketExit: on the fill bar only the worse is taken (the stop at its fill, never the open; no target); later bars as usual', () => {
  const { bracketExit } = require('../../scripts/lib/learning/experience-log');
  const t0 = Date.parse('2023-03-15T14:00:00.000Z');
  const args = { tfMs: M3, side: 'long', fill: 100, risk: 2, targetDist: 4, tick: 0.25 };
  // The fill bar opened at 97.00 (before the fill) and dipped to 97.90: stopped at 97.75, not at the open.
  assert.deepStrictEqual(bracketExit({ ...args, bars: [{ ms: t0, o: 97, h: 100.5, l: 97.9, c: 100 }], i: 0, partial: true }), { exitPrice: 97.75, exitMs: t0 + M3, reason: 'stop' });
  // Its high reached the 104 target: not credited on the fill bar; the next bar's is.
  const up = [{ ms: t0, o: 99.5, h: 104.5, l: 99, c: 101 }, { ms: t0 + M3, o: 101, h: 104.25, l: 100.5, c: 104 }];
  assert.deepStrictEqual(bracketExit({ ...args, bars: up, i: 0, partial: true }), { exitPrice: 104, exitMs: t0 + 2 * M3, reason: 'target' });
  assert.deepStrictEqual(bracketExit({ ...args, bars: up, i: 0, partial: false }), { exitPrice: 104, exitMs: t0 + M3, reason: 'target' }, 'a fill at the bar\'s open: the whole bar follows it');
  assert.strictEqual(bracketExit({ ...args, bars: [{ ms: t0, o: 100, h: 101, l: 99, c: 100 }], i: 0, partial: true }), null, 'the bars end first');
});
