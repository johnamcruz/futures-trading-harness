'use strict';

// The size translation (scripts/lib/prop/size-translate.js), the one place a prop entry's size is set: the model's
// size is a suggestion; the result is the largest size the account rulebook's sizing allows at the record's stop.

const test = require('node:test');
const assert = require('node:assert');
const prop = require('../../scripts/lib/trading/prop-state');
const { translateSize, translatorFor } = require('../../scripts/lib/prop/size-translate');
const { trendHome, testSizing } = require('../helpers');

const NOW = new Date('2026-10-07T14:00:02Z');
// A $2,000 cushion: 0.2 x = $400 a trade. MNQ $0.50 a tick, $0.37 a side; NQ $5, $1.40.
const MINI = {
  name: 'mini', valid: true, errors: [], starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod',
  daily_loss_limit: 1000, daily_loss_soft: 500, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 },
};
const specOf = r => (r === 'MNQ' || r === 'NQ' ? { tickSize: 0.25, tickValue: r === 'NQ' ? 5 : 0.5 } : null);
const policy = (sizing = {}, extra = {}) => ({ name: 'prop_portfolio', valid: true, signal: 'policy', account: 'mini', contracts: 'micro', sizing: testSizing(sizing), multipliers: [], ...extra });
const verdict = (extra = {}) => ({ strategy: 'prop_portfolio', action: 'full', multiplier: 1, contract: 'MNQ', stopTicks: 40, maxSize: 18, ...extra });

// `balance`: the snapshot's, yesterday's close too (no loss today: no entry block).
function home(balance = 50000, account = MINI) {
  const h = trendHome();
  prop.startAttempt(h, account, new Date(NOW.getTime() - 2 * 86400000));
  if (balance !== 50000) prop.recordEndOfDay(h, account, balance, '2026-10-06');
  prop.snapshot(h, account, balance, new Date(NOW.getTime() - 60000));
  return h;
}
// A 40-tick stop: 41 x $0.50 + $0.74 = $21.24 a micro, so the $400 budget is 18 MNQ; the cap $300 at $20 a contract: 15.
const T = (o = {}) => translateSize({ suggested: 1, home: o.home || home(), root: 'MNQ', policy: o.policy || policy(), account: 'account' in o ? o.account : MINI, verdict: o.verdict || verdict(), capUsd: o.capUsd ?? 1000, perContract: 20, specOf, selected: ['MNQ'], orderMax: o.orderMax ?? null, ...(o.suggested !== undefined ? { suggested: o.suggested } : {}) });

test('translateSize: the suggestion is translated to the rulebook\'s size (the largest the verdict, the budget, the cap and the broker allow); it never changes the result', () => {
  const one = T();
  assert.deepStrictEqual([one.size, one.contract, one.suggested, one.skip], [18, 'MNQ', 1, undefined]);
  assert.strictEqual(one.reason, 'the rulebook\'s size at this stop: 18 MNQ (the verdict\'s 18, the size budget\'s 18)');
  for (const suggested of [null, 3, 18, 50]) assert.strictEqual(T({ suggested }).size, 18, String(suggested));
  assert.strictEqual(T({ suggested: 50 }).suggested, 50, 'kept beside the result');
  // The composed cap binds: $300 at $20 a contract is 15.
  assert.match(T({ capUsd: 300 }).reason, /15 MNQ \(risk.max_risk_usd \$300.00 at \$20.00 a contract\)/);
  // The broker's max order size binds: 5.
  assert.deepStrictEqual([T({ orderMax: 5 }).size, /the broker's max order size 5/.test(T({ orderMax: 5 }).reason)], [5, true]);
  // The verdict's own size binds (a smaller verdict): 7.
  assert.strictEqual(T({ verdict: verdict({ maxSize: 7 }) }).size, 7);
  // The budget now binds (the balance fell since the verdict): a $1,000 cushion, $200: 9.
  assert.strictEqual(T({ home: home(49000) }).size, 9);
});

test('translateSize: the verdict\'s multiplier sizes the budget; a mini verdict sizes minis; the floor counts micro-equivalents', () => {
  // A multiplier of 0.5: the budget at half, floor(18 x 0.5) = 9.
  assert.strictEqual(T({ verdict: verdict({ multiplier: 0.5 }) }).size, 9);
  // A mini verdict (mini mode): $400 at $207.80 an NQ (41 x $5 + $2.80): 1 NQ, a mini clearing a floor of 3.
  const nq = translateSize({ suggested: 1, home: home(), root: 'NQ', policy: policy({ min_contracts: 3 }, { contracts: 'mini' }), account: MINI, verdict: verdict({ contract: 'NQ', maxSize: 1 }), capUsd: 1000, perContract: 200, specOf, selected: ['NQ'] });
  assert.deepStrictEqual([nq.size, nq.contract], [1, 'NQ']);
  // A floor of 12: the one NQ (10) is under it: a skip with the floor's reason.
  const nq12 = translateSize({ suggested: 1, home: home(), root: 'NQ', policy: policy({ min_contracts: 12 }, { contracts: 'mini' }), account: MINI, verdict: verdict({ contract: 'NQ', maxSize: 1 }), capUsd: 1000, perContract: 200, specOf, selected: ['NQ'] });
  assert.ok(nq12.skip && /the size budget now allows nothing|under the floor of 12/.test(nq12.reason), nq12.reason);
  // auto with nothing selected: 18 micros reach a mini, so the budget trades 1 NQ; a verdict on MNQ is not it.
  const auto = translateSize({ suggested: 1, home: home(), root: 'MNQ', policy: policy({}, { contracts: 'auto' }), account: MINI, verdict: verdict(), capUsd: 1000, perContract: 20, specOf, selected: null });
  assert.ok(auto.skip && /the size budget now allows nothing at a 40-tick stop/.test(auto.reason), auto.reason);
});

test('translateSize: under the floor is a skip (never sized up); a skip verdict, no verdict, another contract, no account or no cap skips', () => {
  // The cap at $50: 2 contracts, under a floor of 3: a skip that names the floor and the size the rules give.
  const under = T({ policy: policy({ min_contracts: 3 }), capUsd: 50 });
  assert.deepStrictEqual([under.skip, under.size, under.contract], [true, 0, null]);
  assert.match(under.reason, /^setup:prop_portfolio: size 2 MNQ is under the floor of 3 contracts .*\(the correct size at this stop is 2: risk.max_risk_usd \$50.00 at \$20.00 a contract\)$/);
  assert.strictEqual(T({ policy: policy({ min_contracts: 3 }), capUsd: 60 }).size, 3, 'at the floor it goes');
  // A budget under the floor: the budget sizes nothing (contractPlan's floor), with its reason.
  assert.match(T({ policy: policy({ min_contracts: 3 }), home: home(48250, MINI) }).reason, /the size budget now allows nothing at a 40-tick stop \(3 MNQ at this stop risk \$63\.72, over the \$50\.00 budget/);
  assert.match(T({ verdict: verdict({ action: 'skip', maxSize: 0, multiplier: 0, reason: 'cushion' }) }).reason, /prop_portfolio skipped the setup \(cushion\)/);
  assert.match(translateSize({ suggested: 1, home: home(), root: 'MNQ', policy: policy(), account: MINI, verdict: null, capUsd: 1000, perContract: 20, specOf }).reason, /no verdict on this record/);
  assert.match(T({ verdict: verdict({ contract: 'NQ' }) }).reason, /verdict trades NQ, not MNQ/);
  assert.match(T({ verdict: verdict({ multiplier: 2 }) }).reason, /no size multiplier above 0 and at most 1/);
  assert.match(T({ account: null }).reason, /no valid account to size from/);
  assert.match(T({ capUsd: 0 }).reason, /states no risk.max_risk_usd/);
  // No snapshot (an attempt not sized yet): the budget can't be read, a skip.
  const bare = trendHome();
  prop.startAttempt(bare, MINI, new Date(NOW.getTime() - 86400000));
  assert.match(T({ home: bare }).reason, /no mini snapshot to size from/);
});

test('translatorFor: the plan\'s stop ticks and the contract\'s tick value price a contract; the same result as translateSize', () => {
  const h = home();
  const tr = translatorFor({ home: h, root: 'MNQ', policy: policy(), account: MINI, strategy: { risk: { max_risk_usd: 300 } }, verdict: verdict(), specOf, selected: ['MNQ'] });
  const plan = { stop: { ticks: 40 } };
  assert.deepStrictEqual(tr(plan, specOf('MNQ'), 1), T({ home: h, capUsd: 300 }));
  assert.strictEqual(tr(plan, specOf('MNQ'), 1).size, 15);
  assert.ok(tr(null, specOf('MNQ'), 1).skip, 'no plan: no size');
});
