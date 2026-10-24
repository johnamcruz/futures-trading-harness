'use strict';

// Phase 2's cut floors at min_contracts, never a veto under it (the owner, 2026-10-23: "Default is 3 minimum floor";
// "Skip if 3 is expensive"): the risk manager's teaching, the request the runner sends it, and the floored approval read
// by the code as the size it states. Code is as strict as before: an approval under the floor is still no trade
// ([min-contracts], tests/lib/runner-entry.test.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { verdictOf, approvedSize, decisiveLine } = require('../../scripts/lib/trading/roles-ran');
const { REQUESTS } = require('../../scripts/lib/orchestrate/requests');

const ROOT = path.resolve(__dirname, '..', '..');
const flat = s => s.replace(/\s+/g, ' ');

test('phase 2 floor: the risk manager cut floors at min_contracts, never a veto under it (an untradable translation is code\'s skip)', () => {
  const rm = flat(fs.readFileSync(path.join(ROOT, 'agents', 'risk-manager.md'), 'utf8'));
  assert.ok(rm.includes('In a prop attempt, full is the translated size your request names, half its cut, floored at min_contracts.'));
  assert.ok(rm.includes('the translated size your request names (never the record\'s)'));
  assert.ok(!/under min_contracts: VETO/.test(rm), 'no veto under the floor');
});

test('phase 2 floor: the request names the floor as where a cut stops, never a veto, and asks for the final size alone', () => {
  const req = REQUESTS.review('risk-manager', { symbol: 'MNQ', at: '2026-10-07T14:27:00.000Z', timeframe: 3, strategy: 'prop_portfolio', side: 'long', entrySize: { size: 5, contract: 'MNQ', suggested: 1, reason: 'the rulebook\'s size at this stop', floor: 3 } });
  assert.match(req, /Approve that size \(your VERDICT line's size 5\), or cut it, never under 3 MNQ \(a cut below it is 3, never a veto\); the record's size is a suggestion/);
  assert.match(req, /State only the final size \(already floored\) on your VERDICT and Size lines; never write the number before the floor or the cut arithmetic: every size on them binds\./);
  assert.ok(!/veto instead/.test(req));
});

test('phase 2 floor: the risk manager\'s shipped examples, and a report written as the request asks, read as their final size', () => {
  const rm = fs.readFileSync(path.join(ROOT, 'agents', 'risk-manager.md'), 'utf8');
  assert.ok(flat(rm).includes('- Write only the final size: every size and "cut to" binds.'));
  // The fenced example, as shipped.
  const example = /For example:\n\n```text\n([\s\S]*?)```/.exec(rm)[1];
  assert.deepStrictEqual([verdictOf(example), approvedSize(example)], ['APPROVE', { size: 5 }]);
  assert.match(decisiveLine(example), /^VERDICT: APPROVE - size 5,/);
  // The Size line's example with its approval: its final size, 1.
  const sizeEx = /e\.g\. `(Size: [^`]+)`/.exec(flat(rm))[1];
  const cut = `${sizeEx}\nVERDICT: APPROVE - size 1, risk $55.50, trade_lifecycle long\nFACTS: window opening drive; trend long allowed`;
  assert.deepStrictEqual([verdictOf(cut), approvedSize(cut)], ['APPROVE', { size: 1 }]);
  // A floored approval written as taught (the final size only): 3.
  const floored = 'Size: 3 (half, floored at min_contracts)\nVERDICT: APPROVE - size 3, risk $166.50, trade_lifecycle long, a serious against\nFACTS: window opening drive; trend long allowed';
  assert.deepStrictEqual([verdictOf(floored), approvedSize(floored)], ['APPROVE', { size: 3 }]);
  // What the text forbids, and why: the parser stays strict, the cut arithmetic's 2 binds (the review's lost trade).
  const narrated = 'VERDICT: APPROVE - size 3 (the translated 5 cut to 2 on serious against, floored at min_contracts 3), risk $166.50\nFACTS: window opening drive; trend long allowed';
  assert.deepStrictEqual(approvedSize(narrated), { size: 2 });
});

test('phase 2 floor: stated in the order\'s own contracts (a mini counts as its family\'s ratio): 3 micro-equivalents is 1 NQ', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const policy = min => ({ name: 'prop_portfolio', sizing: { min_contracts: min } });
  assert.deepStrictEqual(['MNQ', 'NQ'].map(root => prop.minContractsIn(policy(3), null, root)), [3, 1]);
  assert.deepStrictEqual(['MNQ', 'NQ'].map(root => prop.minContractsIn(policy(12), null, root)), [12, 2]);
  // Consistent with the gate's floor: the stated size clears it, one under doesn't.
  assert.strictEqual(prop.minContractsRefusal(policy(12), null, 'NQ', 2), null);
  assert.match(prop.minContractsRefusal(policy(12), null, 'NQ', 1), /under the floor of 12 contracts \(a NQ counts as 10\)/);
  for (const min of [undefined, 0, 2.5]) assert.strictEqual(prop.minContractsIn(policy(min), null, 'NQ'), null, String(min));
  const req = REQUESTS.review('risk-manager', { symbol: 'NQ', at: '2026-10-07T14:27:00.000Z', timeframe: 3, strategy: 'prop_portfolio', side: 'long', entrySize: { size: 2, contract: 'NQ', suggested: 1, reason: 'the rulebook\'s size at this stop', floor: prop.minContractsIn(policy(3), null, 'NQ') } });
  assert.match(req, /or cut it, never under 1 NQ \(a cut below it is 1, never a veto\)/);
});

test('phase 2 floor: order_plan\'s composed NQ entry names the floor phase 2 is told in NQ (1, not the rulebook\'s 3 micros)', () => {
  // The lifecycle-prop world on NQ: an account that trades it, a $1,000 cap (1 NQ at 111 ticks, $562.80 all in), the
  // record composed for NQ; the rulebook's floor of 3 micro-equivalents.
  const P = require('../fixtures/lifecycle-prop');
  const LC = require('../fixtures/lifecycle');
  const { composedOrder } = require('../../scripts/lib/trading/lifecycle-order');
  const { buildRecord, appendRecord, planOf } = require('../../scripts/lib/trading/trade-lifecycle');
  const { checkReads } = require('../../scripts/lib/trading/composed-reads');
  const { testSizing, lifecycleStopRule } = require('../helpers');
  const acct = { ...P.MINI, max_loss: 6000, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 } };
  const lc = { ...P.LC_DOC, risk: { ...P.LC_DOC.risk, max_risk_usd: 1000 } };
  const strategies = [P.policy({ sizing: testSizing({ min_contracts: 3 }), contracts: 'mini' }), lc];
  const { home } = P.propHome({ size: 1, account: acct });
  const b = LC.briefing();
  const checked = checkReads({ reads: LC.READS, side: 'long', briefing: b, tick: 0.25 });
  const planned = planOf({ checked, briefing: b, side: 'long', size: 1, tick: 0.25, tickValue: 5, minRR: 2, maxRiskUsd: 1000, stopRule: lifecycleStopRule() });
  appendRecord(home, buildRecord({ at: '2026-10-07T13:59:50.000Z', root: 'NQ', symbol: 'NQ', side: 'long', briefing: b, checked, planned, validBars: 2 }));
  const specOf = r => (r === 'NQ' ? { tickSize: 0.25, tickValue: 5 } : { tickSize: 0.25, tickValue: 0.5 });
  const o = composedOrder({ home, root: 'NQ', side: 'long', now: P.NOW, cycleBars: { MNQ: LC.BAR }, strategy: lc, strategies, accounts: [acct], specOf, accountId: 7, selected: ['NQ'] });
  assert.deepStrictEqual([o.plan.contract, o.plan.translatedSize, o.plan.minContracts], ['NQ', 1, 1]);
  // The runner hands phase 2 exactly these (runner-entry.js entrySize): the request's floor is the order's own.
  const req = REQUESTS.review('risk-manager', { symbol: 'NQ', at: LC.BAR, timeframe: 3, strategy: 'prop_portfolio', side: 'long', entrySize: { size: o.plan.translatedSize, contract: o.plan.contract, suggested: o.plan.suggestedSize, reason: o.plan.translation, floor: o.plan.minContracts } });
  assert.match(req, /The entry's size is 1 NQ: .*or cut it, never under 1 NQ \(a cut below it is 1, never a veto\)/);
});

test('phase 2 floor: a halving floored at 3 reads as an approval of 3 (the report format\'s own readers)', () => {
  const text = 'Size: 3 (the translated 5 halved to 2 on serious against, floored at min_contracts 3)\nVERDICT: APPROVE - size 3, risk $166.50, trade_lifecycle long, serious against halved, floored\nFACTS: window opening drive; trend long allowed';
  assert.strictEqual(verdictOf(text), 'APPROVE');
  assert.deepStrictEqual(approvedSize(text), { size: 3 });
  assert.match(decisiveLine(text), /^VERDICT: APPROVE - size 3/);
});
