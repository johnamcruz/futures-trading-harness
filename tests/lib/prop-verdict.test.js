'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const combine = require('../../scripts/lib/trading/combine');
const { accountNamed } = require('../../scripts/lib/trading/accounts');
const { decideSetup, setupPlan } = require('../../scripts/lib/prop/verdict');

const ROOT = path.resolve(__dirname, '..', '..');
const { TEST_ACCOUNTS, TEST_SIZING, testSizing } = require('../helpers');
const account = accountNamed(ROOT, 'test_50k', { FTH_ACCOUNTS_DIRS: TEST_ACCOUNTS }); // a fixture: the same rules as a 50K combine
const strategy = { name: 'prop_x', timeframe: '3m', contracts: 'micro', strategies: ['trendy'], sizing: TEST_SIZING };
const spec = { tickSize: 0.25, tickValue: 0.5 };
const now = new Date('2026-10-07T15:30:00Z');
const bars = Array.from({ length: 50 }, (_, k) => ({ t: new Date(Date.parse('2026-10-07T13:00:00Z') + k * 180000).toISOString(), o: 21500, h: 21502, l: 21498, c: 21500, v: 100 }));
const args = (extra = {}) => ({ account, cs: combine.start(account), strategy, component: 'trendy', symbol: 'MNQ', contractId: 'MNQ', rawBars: bars, spec, scan: { direction: 'long', stopDistance: 10 }, now, ...extra });

test('the sizing verdict: full at the largest size the budget allows at the setup\'s stop, on the last closed bar', () => {
  const v = decideSetup(args());
  // $50,000 start, $48,000 floor: cushion $2,000, budget 0.2 x = $400. A 10-point stop is 40 ticks:
  // plus a tick of expected slippage, 41 x $0.50 = $20.50 + $0.74 fees = $21.24 a micro, so 18 MNQ ($382.32).
  assert.deepStrictEqual([v.action, v.contract, v.maxSize, v.riskPerContract, v.stopTicks], ['full', 'MNQ', 18, 21.24, 40]);
  assert.deepStrictEqual([v.strategy, v.component, v.direction, v.account], ['prop_x', 'trendy', 'long', 'test_50k']);
  assert.strictEqual(v.bar, bars[bars.length - 1].t, 'the last closed bar');
  assert.strictEqual(v.expiresAt, '2026-10-07T15:33:00.000Z', 'one bar after the bar\'s close');
  assert.strictEqual(v.policy, undefined, 'no record of a trained policy');
  assert.strictEqual(v.combine.cushion, 2000);
});

test('the sizing verdict counts the policy strategy\'s own stop_slippage_ticks', () => {
  // As above with sizing.stop_slippage_ticks 3: 43 x $0.50 = $21.50 + $0.74 = $22.24 a micro, so 17 MNQ ($378.08).
  const v = decideSetup(args({ strategy: { ...strategy, sizing: testSizing({ stop_slippage_ticks: 3 }) } }));
  assert.deepStrictEqual([v.action, v.contract, v.maxSize, v.riskPerContract], ['full', 'MNQ', 17, 22.24]);
});

test('the sizing verdict says only full or skip; a stop too wide for the budget is a skip with the reason', () => {
  const wide = decideSetup(args({ scan: { direction: 'short', stopDistance: 1000 } }));
  assert.deepStrictEqual([wide.action, wide.maxSize, wide.contract], ['skip', 0, null]);
  assert.match(wide.reason, /size budget \(\$400\) is below one contract at this stop; with a cushion of \$2000/);
  // An attempt that can't enter (blown) says why.
  const blown = decideSetup(args({ cs: combine.blow(combine.start(account)) }));
  assert.strictEqual(blown.action, 'skip');
  for (const stop of [1, 2.5, 10, 40, 400, 4000]) assert.ok(['full', 'skip'].includes(decideSetup(args({ scan: { direction: 'long', stopDistance: stop } })).action));
});

test('the sizing verdict under the rulebook\'s floor (min_contracts): fewer than the floor fit at the stop is a skip that says so, never sized up; the guard never lets one through', () => {
  const floored = { ...strategy, sizing: testSizing({ min_contracts: 3 }) };
  // A 40-tick stop: 18 MNQ, over the floor: full as before.
  assert.deepStrictEqual([decideSetup(args({ strategy: floored })).action, decideSetup(args({ strategy: floored })).maxSize], ['full', 18]);
  // A 300-tick stop (75 points): 301 x $0.50 + $0.74 = $151.24 a micro, 2 within the $400 budget; 3 would be $453.72.
  const wide = decideSetup(args({ strategy: floored, scan: { direction: 'long', stopDistance: 75 } }));
  assert.deepStrictEqual([wide.action, wide.maxSize, wide.multiplier, wide.contract], ['skip', 0, 0, null]);
  assert.strictEqual(wide.reason, '3 MNQ at this stop risk $453.72, over the $400.00 budget (the rulebook\'s min_contracts 3; 2 MNQ would fit): skip; never a tighter stop');
  // At a floor of 1 the same stop is full at 2.
  assert.deepStrictEqual([decideSetup(args({ scan: { direction: 'long', stopDistance: 75 } })).action, decideSetup(args({ scan: { direction: 'long', stopDistance: 75 } })).maxSize], ['full', 2]);
  // One micro over the budget but within min_size_guard (1.5x): taken at a floor of 1, a skip at 3.
  // A 220-point stop: 881 x $0.50 + $0.74 = $441.24 a micro, over $400, under $600.
  const guarded = { direction: 'long', stopDistance: 220 };
  assert.deepStrictEqual([decideSetup(args({ scan: guarded })).action, decideSetup(args({ scan: guarded })).maxSize], ['full', 1]);
  const g = decideSetup(args({ strategy: floored, scan: guarded }));
  assert.strictEqual(g.action, 'skip');
  assert.match(g.reason, /^3 MNQ at this stop risk \$1323\.72, over the \$400\.00 budget .*1 MNQ would fit\): skip; never a tighter stop$/);
  // No whole floor in the sizing (no rulebook value): no size (fails closed).
  const none = decideSetup(args({ strategy: { ...strategy, sizing: testSizing({ min_contracts: undefined }) } }));
  assert.strictEqual(none.action, 'skip');
  assert.match(none.reason, /sizing.min_contracts: missing; the policy's rulebook states it \(no code default\)/);
  for (const min of [0, 2.5]) {
    const bad = decideSetup(args({ strategy: { ...strategy, sizing: testSizing({ min_contracts: min }) } }));
    assert.match(bad.reason, new RegExp(`sizing.min_contracts: ${min}; a whole number of contracts, 1 or more`), String(min));
  }
});

test('setupPlan: the stop in ticks (half to even, as the engine) and a plan per size fraction', () => {
  const p = setupPlan(args({ scan: { direction: 'long', stopDistance: 10.125 } }));
  assert.strictEqual(p.stopTicks, 40, '40.5 ticks rounds to even');
  assert.strictEqual(p.cp.size, p.plan(1).size);
  assert.ok(p.plan(0.5).size <= Math.ceil(p.cp.size / 2));
  assert.strictEqual(p.i, bars.length - 1);
  assert.deepStrictEqual(p.sizing, TEST_SIZING, 'the policy sizing, never a code default');
});

test('the verdict\'s multiplier (R4): 1 for a full verdict and 0 for a skip while the rulebook has no multiplier items', () => {
  assert.strictEqual(decideSetup(args()).multiplier, 1);
  assert.strictEqual(decideSetup(args({ strategy: { ...strategy, multipliers: [] } })).multiplier, 1);
  const wide = decideSetup(args({ scan: { direction: 'short', stopDistance: 1000 } }));
  assert.deepStrictEqual([wide.action, wide.multiplier], ['skip', 0]);
});

test('the verdict folds the rulebook\'s enforced multiplier items into its ceiling; a missing or stale fact skips the setup', () => {
  const mtf = [{ item: 'mtf_read', fact: 'mtf', values: { aligned: 1, mixed: 0.5, counter: 0 }, max_age_min: 10 }];
  const s = { ...strategy, multipliers: mtf };
  const fresh = value => ({ mtf: { value, at: new Date(now.getTime() - 60000).toISOString() } });
  const pick = v => [v.action, v.multiplier, v.maxSize];
  // 18 MNQ at full (above); at 0.5: floor(18 x 0.5) = 9.
  assert.deepStrictEqual(pick(decideSetup(args({ strategy: s, facts: fresh('aligned') }))), ['full', 1, 18]);
  assert.deepStrictEqual(pick(decideSetup(args({ strategy: s, facts: fresh('mixed') }))), ['full', 0.5, 9]);
  const stale = { mtf: { value: 'aligned', at: new Date(now.getTime() - 11 * 60000).toISOString() } };
  for (const [label, facts] of [['no fact', {}], ['stale', stale], ['no time', { mtf: { value: 'aligned' } }], ['a value it does not map', fresh('pullback')], ['a value of 0', fresh('counter')]]) {
    const v = decideSetup(args({ strategy: s, facts }));
    assert.deepStrictEqual([v.action, v.multiplier, v.maxSize, v.contract], ['skip', 0, 0, null], label);
    assert.match(v.reason, /the rulebook's enforced items allow no size \(mtf_read: /, label);
  }
  // No facts passed at all (as the runner today): any item zeroes, never a full size (fails closed).
  assert.strictEqual(decideSetup(args({ strategy: s })).action, 'skip');
  // A share too small for one contract: a skip, never rounded up to 1.
  const v = decideSetup(args({ strategy: { ...strategy, multipliers: [{ item: 'mtf_read', fact: 'mtf', values: { aligned: 0.01 } }] }, facts: fresh('aligned') }));
  assert.deepStrictEqual([v.action, v.multiplier], ['skip', 0]);
  assert.match(v.reason, /at the rulebook's multiplier \(0\.01\) no contract fits/);
});
