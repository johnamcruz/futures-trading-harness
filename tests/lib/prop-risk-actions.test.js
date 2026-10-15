'use strict';

// The model's risk actions (scripts/lib/prop/risk-actions.js): each detected from a fixture run (prop/model-stream.js),
// each scored against its counterfactual through the same Monte Carlo paths (prop/evaluator.js scoreArms), with the
// paired difference of the right sign on a scripted case, and the per-state record under 4 KB with its sample sizes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readModelStream } = require('../../scripts/lib/prop/model-stream');
const { checkModelWindow } = require('../../scripts/lib/prop/evaluator');
const { scoreRiskActions, riskActionRecord, KINDS, STATES } = require('../../scripts/lib/prop/risk-actions');
const { ACCOUNT, M3, record, multiDayRun, weekdays, modelTrade, modelStreamOf } = require('../fixtures/prop-model');

const at = (iso, k) => new Date(Date.parse(iso) + k * M3).toISOString();
const fill = (id, t, price, side, pnl, size = 1) => ({ id, contractId: 'MNQ:2023-06', creationTimestamp: t, price, size, side, profitAndLoss: pnl });

test('each risk action is detected from a fixture run: a size under the ceiling, an early exit (with its hold counterfactual), a pass, a stop for the day', () => {
  const d1 = '2023-03-15T14:00:00.000Z';
  const d2 = '2023-03-16T14:00:00.000Z';
  const d3 = '2023-03-17T14:00:00.000Z';
  const { home, dir } = multiDayRun({
    days: [
      { // 1 contract under a ceiling of 4, closed at 101 well before the 98 stop and the 104 target.
        day: '2023-03-15', times: [d1, at(d1, 3)], records: [record({ at: d1 })],
        fills: [fill(1, '2023-03-15T14:01:00Z', 100, 0, null), fill(2, '2023-03-15T14:05:00Z', 101, 1, 2)],
        rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 101.25, 100, 101], [101, 101.25, 98.5, 98.75], [98.75, 99, 97.5, 97.75]],
      },
      { // A loss at the stop, then a pass on a valid setup: standing down for the day.
        day: '2023-03-16', times: [d2, at(d2, 3)], records: [record({ at: d2 }), record({ at: at(d2, 3) })],
        fills: [fill(3, '2023-03-16T14:01:00Z', 100, 0, null), fill(4, '2023-03-16T14:04:00Z', 97.75, 1, -4.5)],
        rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 100.5, 97.5, 97.75], [97.75, 98, 97.5, 98], [100.5, 100.75, 99.75, 100], [100, 104.5, 99.5, 104.25]],
      },
      { // A pass on a fresh day: its counterfactual fills at 100 and reaches the 104 target.
        day: '2023-03-17', times: [d3], records: [record({ at: d3 })],
        rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 104.5, 100, 104.25]],
      },
    ],
  });
  fs.writeFileSync(path.join(home, 'policy-verdicts.jsonl'), `${JSON.stringify({ bar: record({ at: d1 }).bar, direction: 'long', symbol: 'MNQ', action: 'full', maxSize: 4 })}\n`);
  const { stream } = readModelStream(dir);
  const [a, b] = stream.trades;
  assert.deepStrictEqual([a.actions, a.sizeFraction], [['size-down', 'early-exit'], 0.25]);
  // Held to its bracket (limitOutcome from the fill's bar): the 98 stop, a tick of slippage: -2.25 / 2.
  assert.deepStrictEqual([a.hold.r, a.hold.reason, a.hold.moveTicks], [-1.125, 'hold (stop)', -9]);
  assert.deepStrictEqual([b.actions, b.sizeFraction, b.hold], [[], null, null], 'a stop exit is no early exit; no verdict, no size action');
  const passed = stream.days.flatMap(d => d.passed);
  assert.deepStrictEqual(passed.map(p => [p.day, p.actions[0], p.counterfactual, p.r]), [['2023-03-16', 'day-stop', true, 2], ['2023-03-17', 'pass', true, 2]]);
  assert.ok(stream.trades.every(t => !t.counterfactual), 'a pass is never a trade of the score');
  // Each scored against its counterfactual.
  const run = { runId: 'run1', from: '2023-03-15', to: '2023-03-18', learning: true, role: 'practice-train' };
  const r = scoreRiskActions(stream, { pass: checkModelWindow({ run }), account: ACCOUNT, contracts: 'micro', paths: 100, reps: 100, seed: 1 });
  assert.strictEqual(r.counterfactual, true);
  for (const k of KINDS) {
    assert.strictEqual(r.actions[k].n, 1, k);
    assert.ok(r.actions[k].byState.all.applied > 0, `${k}: its counterfactual changed paths`);
    assert.deepStrictEqual(Object.keys(r.actions[k].byState), STATES);
  }
  // The run's score carries them, labelled counterfactual.
  const { scoreRun, scoreText } = require('../../scripts/lib/prop/model-score');
  const scored = scoreRun(dir, { account: ACCOUNT, paths: 50, reps: 50 });
  assert.strictEqual(scored.riskActions.counterfactual, true);
  assert.match(scoreText(scored), /Risk action day-stop \(counterfactual: reverted on the same paths; 1 decision\(s\)\): pass rate/);
  assert.strictEqual(scoreRun(dir, { account: ACCOUNT, paths: 50, reps: 50, riskActions: false }).riskActions, null);
});

/**
 * A scripted case: every day a winner the model took, and a setup it passed on that, taken, loses with a gap 60 ticks
 * past the stop; and an entry it closed early at -10 ticks that, held, would have run to its stop with the same gap.
 */
function scripted() {
  const days = weekdays('2022-01-03', 120);
  return modelStreamOf(days, (d, k) => {
    const take = modelTrade(`${d}-w`, k % 3 === 2 ? -40 : 60, {}, { entryTime: `${d}T14:00:00.000Z`, actions: [] });
    const early = modelTrade(`${d}-e`, -10, {}, { entryTime: `${d}T15:00:00.000Z`, actions: ['early-exit'], hold: { moveTicks: -101, troughTicks: [-101], overshootTicks: 60, r: -101 / 40, noStop: null } });
    return k % 2 ? [take, early] : [take];
  }, {}).days.map((day, k) => ({
    ...day,
    passed: k % 2 ? [] : [modelTrade(`${day.day}-p`, -101, {}, { entryTime: `${day.day}T15:00:00.000Z`, troughTicks: [-101], overshootTicks: 60, actions: ['pass'], counterfactual: true })],
  }));
}

test('the paired difference has the right sign on a scripted case: passing a gap loser and exiting one early saved blows', () => {
  const days = scripted();
  const stream = modelStreamOf(days.map(d => d.day), (_d, k) => days[k].trades);
  stream.days.forEach((d, k) => { d.passed = days[k].passed.map(p => ({ ...p, day: d.day })); });
  const run = { runId: 'r', from: '2022-01-03', to: '2022-07-01', learning: true, role: 'practice-train' };
  const r = scoreRiskActions(stream, { pass: checkModelWindow({ run }), account: ACCOUNT, contracts: 'micro', paths: 300, reps: 300, seed: 2, rulebook: { sizing: { cushion_frac: 0.45 } } });
  for (const k of ['pass', 'early-exit']) {
    const row = r.actions[k].byState.all;
    assert.ok(row.savedBlows > row.causedBlows, `${k}: saved ${row.savedBlows}, caused ${row.causedBlows}`);
    assert.strictEqual(row.effect.blow, 'lowered', `${k}: the model's action lowered the blow rate (${JSON.stringify(row.diff.blowRate)})`);
    assert.ok(row.diff.blowRate.hi < 0);
  }
  // Kinds the run has none of change nothing: exactly no difference.
  assert.deepStrictEqual([r.actions['size-down'].byState.all.applied, r.actions['size-down'].byState.all.diff.passRate.diff], [0, 0]);
  const rec = riskActionRecord(r, { minN: 5 });
  assert.ok(Buffer.byteLength(rec.text) <= 4096 && rec.counterfactual);
  assert.match(rec.text, /^Risk actions \(counterfactual/);
  assert.match(rec.text, /in any state, standing down \(a pass on a valid setup\): n \d+ paths, saved \d+ blows, caused \d+, cost \d+ passes, gained \d+/);
  assert.ok(Buffer.byteLength(riskActionRecord(r, { minN: 1, maxBytes: 200 }).text) <= 200);
});
