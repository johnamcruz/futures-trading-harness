'use strict';

// The order arithmetic for a scan candidate (scripts/lib/trading/order-plan.js): ticks, sides, prices on
// the tick, risk, and place_order arguments the order gate's checks accept.

const test = require('node:test');
const assert = require('node:assert');
const { stopTicks, targetTicks, ticksText, distanceText, targetFor, buildPlan } = require('../../scripts/lib/trading/order-plan');
const { specFor } = require('../../scripts/lib/trading/contracts');
const { checkConsistency, evaluateOrder } = require('../../scripts/lib/trading/order-gate');
const { loadConfig } = require('../../scripts/lib/trading/config');
const { NOW, plan: planEntry, trendHome } = require('../helpers');

const MNQ = specFor('MNQ');
const MES = specFor('MES');
const TRAIL = { targetR: null, target: null, trailActivateR: 2, trailGivebackR: 0.5, maxBars: null };
const TARGET_2R = { targetR: 2, target: null, trailActivateR: null, trailGivebackR: null, maxBars: null };
const base = over => ({ name: 'supertrend', side: 'long', contract: 'MNQ', spec: MNQ, entryRef: 30842.5, stop: 34, stopDistance: 8.4579, exit: TARGET_2R, size: 1, sizeWhy: 'the minimum', ...over });

test('stopTicks: rounded away from the entry (never fewer ticks than the distance), at least 1', () => {
  assert.strictEqual(stopTicks(8.4579, 0.25), 34, '33.83 ticks -> 34, never 33');
  assert.strictEqual(stopTicks(8.25, 0.25), 33, 'an exact distance stays exact');
  assert.strictEqual(stopTicks(0.1 + 0.2, 0.1), 3, 'float noise above a whole tick is not another tick');
  assert.strictEqual(stopTicks(8.2501, 0.25), 34, 'a hair over a tick is the next tick');
  assert.strictEqual(stopTicks(0.01, 0.25), 1, 'at least one tick');
  assert.strictEqual(stopTicks(2.35, 1), 3, 'MYM/YM: whole-point ticks');
  for (const bad of [0, -1, null, undefined, NaN, Infinity]) assert.strictEqual(stopTicks(bad, 0.25), null, String(bad));
  assert.strictEqual(stopTicks(5, 0), null);
  for (let d = 0.01; d < 30; d += 0.37) assert.ok(stopTicks(d, 0.25) * 0.25 >= d - 1e-9, `${d}: the stop is never tighter than the distance`);
});

test('targetTicks: rounded toward the entry; nothing under one tick', () => {
  assert.strictEqual(targetTicks(12.6, 0.25), 50, '50.4 ticks -> 50');
  assert.strictEqual(targetTicks(12.5, 0.25), 50);
  assert.strictEqual(targetTicks(0.3 - 0.1 + 0.1, 0.1), 3, 'float noise below a whole tick is still that tick');
  assert.strictEqual(targetTicks(0.2, 0.25), null);
  assert.strictEqual(targetTicks(-3, 0.25), null);
});

test('distanceText / ticksText: points and ticks with one contract\'s dollars, per instrument', () => {
  assert.strictEqual(distanceText(8.4579, 34, 'MNQ', MNQ), '8.4579 pts = 34 ticks ($17.00/MNQ contract)');
  assert.strictEqual(distanceText(8.4579, 34, 'MES', MES), '8.4579 pts = 34 ticks ($42.50/MES contract)', 'MES: $1.25 a tick');
  assert.strictEqual(ticksText(18, 'NQ', specFor('NQ')), '18 ticks ($90.00/NQ contract)');
  assert.strictEqual(distanceText(8.4579, null, 'XYZ', null), '8.4579 pts', 'no specs: points only, no made-up ticks');
});

test('targetFor: R times the placed stop, a level, or none for a trailing exit', () => {
  assert.deepStrictEqual(targetFor(TARGET_2R, 34, null, 0.25), { ticks: 68, why: '2R' });
  assert.strictEqual(targetFor({ targetR: 1.5 }, 21, null, 0.25).ticks, 31, '31.5 ticks -> 31 (toward the entry)');
  assert.deepStrictEqual(targetFor({ targetR: null, target: 'crt_far' }, 34, 12.6, 0.25), { ticks: 50, why: 'the level 12.6 pts away' });
  assert.throws(() => targetFor({ targetR: null, target: 'crt_far' }, 34, 0.1, 0.25), /no distance of a tick or more/);
  assert.deepStrictEqual(targetFor(TRAIL, 34, null, 0.25), { ticks: null, why: 'no target order: trail from 2R giving back 0.5R' });
  assert.strictEqual(targetFor({}, 34, null, 0.25).ticks, null);
});

test('buildPlan: a long on MNQ - the stop below the entry, the target above, brackets in ticks, risk in dollars', () => {
  const { plan, args, line } = buildPlan(base({ accountId: 7 }));
  assert.deepStrictEqual(plan, { strategy: 'supertrend', side: 'long', contract: 'MNQ', size: 1, entry: 30842.5, stopPrice: 30834, stopTicks: 34, targetPrice: 30859.5, targetTicks: 68, riskUsd: 17 });
  assert.ok(plan.stopPrice < plan.entry && plan.targetPrice > plan.entry);
  assert.deepStrictEqual(args, {
    accountId: 7, contractId: 'MNQ', side: 'buy', type: 'market', size: 1,
    stopLossBracket: { ticks: 34, type: 'stop' }, takeProfitBracket: { ticks: 68, type: 'limit' },
    rationale: 'setup:supertrend long at market from 30842.50 (the signal bar\'s close), stop 30834.00 (34 ticks), target 30859.50 (68 ticks), 1 MNQ risks $17.00',
  });
  assert.match(line, /^supertrend long: 1 MNQ at market \(entry ref 30842\.50\) \| stop 30834\.00, below the entry: 8\.4579 pts = 34 ticks \(\$17\.00\/MNQ contract\), stopLossBracket\.ticks 34 \| target 30859\.50 \(2R\): 68 ticks, takeProfitBracket\.ticks 68 \| risk \$17\.00/);
  assert.strictEqual(line.split('\n').length, 1, 'one line');
});

test('buildPlan: a short on MES - the stop above the entry, the target below, $1.25 a tick', () => {
  const { plan, args } = buildPlan(base({ side: 'short', contract: 'MES', spec: MES, entryRef: 6712.25, stop: 9, stopDistance: 2.1, size: 2 }));
  assert.deepStrictEqual([plan.stopPrice, plan.targetPrice], [6714.5, 6707.75]);
  assert.ok(plan.stopPrice > plan.entry && plan.targetPrice < plan.entry);
  assert.strictEqual(plan.riskUsd, 22.5, '9 ticks x $1.25 x 2');
  assert.strictEqual(args.side, 'sell');
  assert.deepStrictEqual([args.stopLossBracket.ticks, args.takeProfitBracket.ticks], [9, 18]);
  assert.match(args.rationale, /^setup:supertrend short .*stop 6714\.50 .*target 6707\.75 .*2 MES risks \$22\.50$/);
});

test('buildPlan: a trailing exit has no target order; the entry reference goes onto the tick; accountId only when given', () => {
  const { plan, args, line } = buildPlan(base({ exit: TRAIL, entryRef: 30842.6 }));
  assert.strictEqual(plan.entry, 30842.5);
  assert.strictEqual(plan.targetPrice, null);
  assert.ok(!('takeProfitBracket' in args) && !('accountId' in args));
  assert.doesNotMatch(args.rationale, /target/);
  assert.match(line, /\| no target order: trail from 2R giving back 0\.5R \|/);
  // Ticks of 0.1 (M2K) and of 1 (MYM): prices printed with the tick's decimals.
  assert.match(buildPlan(base({ contract: 'M2K', spec: specFor('M2K'), entryRef: 2250.3, stop: 7 })).args.rationale, /from 2250\.3 .*stop 2249\.6 \(7 ticks\), target 2251\.7 \(14 ticks\)/);
  assert.match(buildPlan(base({ contract: 'MYM', spec: specFor('MYM'), entryRef: 46210, stop: 12, side: 'short' })).args.rationale, /from 46210 .*stop 46222 \(12 ticks\), target 46186 \(24 ticks\)/);
});

test('buildPlan: says (does not judge) when the target in whole ticks falls under the strategy\'s min_rr', () => {
  // A level 12.6 pts away is 50 ticks; a 34-tick stop makes it 1.47R, under min_rr 1.5.
  const level = { targetR: null, target: 'level' };
  assert.match(buildPlan(base({ exit: level, targetDistance: 12.6, minRR: 1.5 })).line, /\| the target is 1\.47R in whole ticks, under the strategy's min_rr 1\.5$/);
  assert.doesNotMatch(buildPlan(base({ exit: level, targetDistance: 17, minRR: 2 })).line, /min_rr/, '68 ticks on 34: exactly 2R');
  assert.doesNotMatch(buildPlan(base({ exit: TRAIL, minRR: 2 })).line, /min_rr/, 'no target, nothing to compare');
});

test('buildPlan: refuses what it cannot plan', () => {
  assert.throws(() => buildPlan(base({ side: 'up' })), /side must be long or short/);
  assert.throws(() => buildPlan(base({ spec: null })), /no tick specs for MNQ/);
  assert.throws(() => buildPlan(base({ stop: 0 })), /whole number of ticks/);
  assert.throws(() => buildPlan(base({ stop: 33.8 })), /whole number of ticks/);
  assert.throws(() => buildPlan(base({ size: 0, sizeWhy: 'over the budget' })), /no size: over the budget/);
  assert.throws(() => buildPlan(base({ entryRef: NaN })), /no entry reference/);
});

test('buildPlan: its place_order arguments pass the order gate\'s consistency checks, long and short, on every instrument', () => {
  for (const [contract, entryRef] of [['MNQ', 30842.5], ['MES', 6712.25], ['M2K', 2250.3], ['MYM', 46210], ['NQ', 30842.5]]) {
    for (const side of ['long', 'short']) {
      for (const exit of [TARGET_2R, TRAIL, { targetR: 1.5 }]) {
        const { args } = buildPlan(base({ contract, spec: specFor(contract), entryRef, side, exit, stop: 21 }));
        assert.strictEqual(checkConsistency(args, args.rationale), null, `${contract} ${side} ${JSON.stringify(exit)}`);
        assert.ok(Number.isInteger(args.stopLossBracket.ticks) && args.stopLossBracket.ticks > 0);
        assert.match(args.rationale, new RegExp(`^setup:supertrend ${side} `), 'the setup tag and side the gate reads, first');
      }
    }
  }
});

test('buildPlan: a planned orb entry passes every gate check (tag, trigger, trend, stop, consistency)', () => {
  const config = { ...loadConfig({}), killSwitchFile: '/nonexistent/fth/STOP', mtfMaxAgeMin: 1e9, signalMaxAgeMin: 1e9 };
  const { loadStrategies } = require('../../scripts/lib/trading/strategies');
  const strategies = loadStrategies(require('path').resolve(__dirname, '..', '..'), {}).strategies;
  for (const [side, bias] of [['long', 1], ['short', -1]]) {
    const home = trendHome(undefined, { biases: { 240: bias, 60: bias, 15: bias }, fired: [{ name: 'orb', direction: side }] });
    const { args } = buildPlan(base({ name: 'orb', side, accountId: 7, entryRef: 21503.25, stop: 21, stopDistance: 5.25, exit: { targetR: 1.5 } }));
    const r = evaluateOrder({ input: args, entries: [planEntry()], now: NOW, config: { ...config, home }, strategies });
    assert.deepStrictEqual(r.violations, [], side);
    // The same order on the other side than the one that fired is refused: the plan's side matters.
    const other = buildPlan(base({ name: 'orb', side: side === 'long' ? 'short' : 'long', accountId: 7, entryRef: 21503.25, stop: 21, exit: { targetR: 1.5 } })).args;
    assert.ok(evaluateOrder({ input: other, entries: [planEntry()], now: NOW, config: { ...config, home }, strategies }).violations.length > 0);
  }
});
