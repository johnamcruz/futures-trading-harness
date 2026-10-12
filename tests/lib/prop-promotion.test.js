'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PROMOTION_GATE, gateFailures } = require('../../scripts/lib/prop/promotion');

test('the promotion gate\'s numbers may only rise: never lower them', () => {
  // The floor each number has ever had. Raising one is allowed (raise its floor here too); lowering it fails.
  assert.ok(PROMOTION_GATE.minPassRate >= 0.4, 'minPassRate under 0.4');
  assert.ok(PROMOTION_GATE.maxBlows <= 0, 'maxBlows over 0: zero blows is the rule');
  assert.ok(PROMOTION_GATE.minAttempts >= 20, 'minAttempts under 20');
  assert.ok(PROMOTION_GATE.minMonths >= 2, 'minMonths under 2');
  assert.deepStrictEqual(Object.keys(PROMOTION_GATE).sort(), ['maxBlows', 'minAttempts', 'minMonths', 'minPassRate']);
  // Frozen: no caller can change them at run time.
  assert.ok(Object.isFrozen(PROMOTION_GATE));
  assert.throws(() => { 'use strict'; PROMOTION_GATE.minPassRate = 0.1; }, TypeError);
});

test('gateFailures: zero blows in every out-of-sample month and at least a 40% pass rate over enough attempts; malformed results fail closed', () => {
  const months = { '2026-03': { attempts: 10, blown: 0, passRate: 0.5 }, '2026-04': { attempts: 10, blown: 0, passRate: 0.4 } };
  const oos = { attempts: 20, passed: 9, blown: 0, passRate: 0.45, months };
  assert.deepStrictEqual(gateFailures(oos), []);
  const oneBlow = { ...oos, blown: 1, months: { ...months, '2026-04': { ...months['2026-04'], blown: 1 } } };
  assert.match(gateFailures(oneBlow)[0], /2026-04.*zero blows/);
  // A blow in a month the total misses still fails.
  assert.match(gateFailures({ ...oos, months: { ...months, '2026-04': { ...months['2026-04'], blown: 1 } } }).join(), /zero blows/);
  assert.match(gateFailures({ ...oos, passed: 7 }).join(), /under 0.4/);
  // The exact rate decides: 333/833 rounds to 0.400 but is under 40%.
  assert.match(gateFailures({ ...oos, attempts: 833, passed: 333, passRate: 0.4 }).join(), /333\/833\) is under 0.4/);
  assert.match(gateFailures({ ...oos, attempts: 3, passed: 3 }).join(), /too small/);
  assert.match(gateFailures({ ...oos, months: { '2026-03': months['2026-03'] } }).join(), /too small/);
  assert.match(gateFailures({ attempts: 20, passed: 10, passRate: 0.5 }).join(), /malformed/, 'a missing blow count fails closed');
  assert.match(gateFailures(null).join(), /malformed/);
  assert.match(gateFailures({ ...oos, attempts: 20.5 }).join(), /malformed/);
  assert.match(gateFailures({ ...oos, months: [] }).join(), /malformed/);
  assert.match(gateFailures({ ...oos, months: { ...months, '2026-04': { attempts: 10 } } }).join(), /no blow count/);
  // A caller may raise the pass-rate floor, never lower it.
  assert.match(gateFailures(oos, 0.5).join(), /under 0.5/);
  assert.match(gateFailures({ ...oos, passed: 6 }, 0.1).join(), /under 0.4/);
  // An optional win-rate floor.
  assert.deepStrictEqual(gateFailures({ ...oos, trades: 100, wins: 55 }, 0.4, 0.5), []);
  assert.match(gateFailures({ ...oos, trades: 100, wins: 45 }, 0.4, 0.5).join(), /win rate 0.45 is under 0.5/);
  assert.match(gateFailures(oos, 0.4, 0.5).join(), /win rate unknown/);
});
