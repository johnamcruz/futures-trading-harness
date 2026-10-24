'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { composedOrder, attemptPolicy } = require('../../scripts/lib/trading/lifecycle-order');
const { latestVerdict, readVerdicts } = require('../../scripts/lib/trading/prop-state');
const { trendHome } = require('../helpers');
const LC = require('../fixtures/lifecycle');
const P = require('../fixtures/lifecycle-prop');

const SPEC = r => (/^(M?NQ)$/.test(r) ? { tickSize: 0.25, tickValue: r === 'NQ' ? 5 : 0.5 } : null);
const order = (home, o = {}) => composedOrder({ home, root: 'MNQ', side: 'long', now: P.NOW, cycleBars: { MNQ: LC.BAR }, strategy: o.strategy || P.SHIPPED, strategies: o.strategies || [P.SHIPPED], accounts: [P.MINI], specOf: SPEC, accountId: 7, selected: ['MNQ'], ...o });

test('order_plan, composed: the record\'s limit, brackets and stated size; the dollar cap is the ceiling outside an attempt', () => {
  const home = trendHome();
  LC.writeScenario(home);
  const r = order(home);
  assert.deepStrictEqual(r.args, {
    accountId: 7, contractId: 'MNQ', side: 'buy', type: 'limit', size: 1, limitPrice: 21540.25, stopLossBracket: { ticks: 111, type: 'stop' }, takeProfitBracket: { ticks: 231, type: 'limit' },
    rationale: `setup:trade_lifecycle long limit 21540.25 (the record's entry price), stop 21512.50 (111 ticks, one beyond 21512.75), target 21598.00 (231 ticks, 2.08R), 1 MNQ risks $55.50, record ${r.plan.record}`,
  });
  assert.strictEqual(r.policy, null);
  assert.match(r.line, /size 1: yours, at or under the ceiling 5 \(trade_lifecycle's risk.max_risk_usd \$300.00 at \$55.50 a contract\)/);
  // The model stated 5 ($277.50): goes; 6 ($333.00) is over the $300 cap: refused, never cut.
  const five = trendHome();
  LC.writeScenario(five, { size: 5 });
  assert.strictEqual(order(five).args.size, 5);
  const six = trendHome();
  LC.writeScenario(six, { size: 6 });
  assert.throws(() => order(six), /\[composed-reads\] .*size 6 risks \$333, over the strategy's risk.max_risk_usd \$300 \(at most 5 at this stop\)/);
});

test('order_plan, composed: a cut (`size`, the runner\'s entry: phase 2 approved fewer) orders exactly it at the record\'s brackets, the risk for it; over the record\'s, or not a whole size, refused', () => {
  const home = trendHome();
  LC.writeScenario(home, { size: 5 });
  const r = order(home, { size: 2 });
  assert.deepStrictEqual([r.args.size, r.args.stopLossBracket.ticks, r.args.takeProfitBracket.ticks, r.args.limitPrice, r.plan.size, r.plan.recordSize, r.plan.riskUsd], [2, 111, 231, 21540.25, 2, 5, 111]);
  assert.match(r.args.rationale, /, 2 MNQ risks \$111\.00, record /);
  assert.match(r.line, /size 2: phase 2 cut the record's 5 \(yours 5, at or under the ceiling 5:/);
  // The record's own size, or none given: no cut.
  for (const size of [5, undefined, null]) assert.deepStrictEqual([order(home, { size }).args.size, 'recordSize' in order(home, { size }).plan], [5, false], String(size));
  for (const size of [6, 0, -1, 1.5, '2']) assert.throws(() => order(home, { size }), /a cut is a whole size from 1 to the record's 5; no order/, String(size));
});

test('order_plan, composed: refused without a cycle bar, a record for the side, or reads that stand now', () => {
  const home = trendHome();
  LC.writeScenario(home);
  assert.throws(() => order(home, { cycleBars: {} }), /no cycle bar for MNQ/);
  assert.throws(() => order(home, { side: 'short' }), /no compose record for the MNQ short/);
  const bad = trendHome();
  LC.writeScenario(bad, { reads: LC.READS.map(x => (x.step === 'bias' ? { ...x, read: '1h down' } : x)) });
  assert.throws(() => order(bad), /the order gate would refuse it: \[composed-reads\] .*false by the briefing: "1h down"/);
  const none = trendHome();
  LC.writeScenario(none, { size: 0 });
  assert.throws(() => order(none), /states no size/);
});

test('order_plan, composed, in an attempt: the policy sizes the record once (its verdict, record id); the order is the translated size, under the policy\'s tag', () => {
  const { home, rec } = P.propHome({ size: 5 });
  const strategies = P.registry();
  const r = order(home, { strategy: P.LC_DOC, strategies });
  assert.strictEqual(r.policy.name, 'prop_portfolio');
  assert.deepStrictEqual([r.verdict.action, r.verdict.maxSize, r.verdict.stopTicks, r.verdict.record, r.verdict.component, r.verdict.bar], ['full', 7, 111, rec.id, 'trade_lifecycle', LC.BAR]);
  assert.match(r.args.rationale, /^setup:prop_portfolio long trade_lifecycle limit 21540.25/);
  assert.strictEqual(r.args.size, 5);
  // Planned again: the same verdict, not a second one.
  order(home, { strategy: P.LC_DOC, strategies });
  assert.strictEqual(readVerdicts(home).length, 1);
  // The size is the translation's (prop/size-translate.js): the lower of the $300 cap (5) and the verdict and the budget:
  // a $1,000 cushion's $200 budget sizes 3 ($56.74 each). The record's 4 is a suggestion: the order is 3.
  const over = P.propHome({ size: 4, account: P.THIN });
  const three = order(over.home, { strategy: P.LC_DOC, strategies, accounts: [P.THIN] });
  assert.deepStrictEqual([three.args.size, three.plan.suggestedSize, three.plan.translatedSize], [3, 4, 3]);
  assert.match(three.line, /size 3: the rulebook's size at this stop: 3 MNQ \(the verdict's 3, the size budget's 3\); the record suggested 4/);
  assert.strictEqual(latestVerdict(over.home, 'prop_portfolio', 'MNQ').record, over.rec.id);
  assert.strictEqual(order(P.propHome({ size: 3, account: P.THIN }).home, { strategy: P.LC_DOC, strategies, accounts: [P.THIN] }).args.size, 3);
  // A suggestion over the cap (6, $333.00; 20) is never refused in an attempt: it translates to the cap's 5.
  for (const size of [6, 20]) assert.deepStrictEqual([order(P.propHome({ size }).home, { strategy: P.LC_DOC, strategies }).args.size], [5], String(size));
  // Outside an attempt the record's 6 over the cap is refused, as before.
  const free = trendHome();
  LC.writeScenario(free, { size: 6 });
  assert.throws(() => order(free), /size 6 risks \$333, over the strategy's risk.max_risk_usd \$300/);
  // A verdict on another contract than the record's: refused.
  const nq = P.propHome({ size: 1 });
  require('../../scripts/lib/trading/prop-state').appendVerdict(nq.home, { ...order(nq.home, { strategy: P.LC_DOC, strategies }).verdict, contract: 'NQ' });
  assert.throws(() => order(nq.home, { strategy: P.LC_DOC, strategies }), /verdict trades NQ, not MNQ: a size is a number of its own contract; no order/);
  // An attempt runs but no policy that trades it lists the composed strategy: no entry.
  assert.throws(() => order(home, { strategy: P.LC_DOC, strategies: [P.policy({ strategies: [] }), P.LC_DOC] }), /no policy strategy that trades it lists trade_lifecycle/);
  assert.strictEqual(attemptPolicy(trendHome(), P.LC_DOC, strategies, 'MNQ'), null, 'no attempt: none');
});

test('order_plan, composed, in an attempt: the suggestion is translated (1 -> the rulebook\'s size); phase 2\'s cut under the floor (min_contracts) is no trade; a budget under it is the verdict\'s skip', () => {
  const { testSizing } = require('../helpers');
  const strategies = P.registry({ sizing: testSizing({ min_contracts: 3 }) });
  const at = (o, home) => order(home, { strategy: P.LC_DOC, strategies, ...o });
  // The translated 5 (the $300 cap at $55.50) goes whatever the record suggests: 1, 2 or 5; phase 2's cut to 3 goes
  // (as `approved` or `size`); a cut to 2 is no trade, never sized back up.
  for (const size of [1, 2, 5]) {
    const r = at({}, P.propHome({ size }).home);
    assert.deepStrictEqual([r.args.size, r.plan.suggestedSize, r.plan.translatedSize], [5, size, 5], String(size));
  }
  assert.strictEqual(at({ size: 3 }, P.propHome({ size: 5 }).home).args.size, 3);
  assert.deepStrictEqual([at({ approved: 3 }, P.propHome({ size: 1 }).home).args.size, at({ approved: 9 }, P.propHome({ size: 1 }).home).args.size], [3, 5]);
  assert.throws(() => at({ approved: 2 }, P.propHome({ size: 5 }).home), /^Error: \[min-contracts\] setup:prop_portfolio: size 2 MNQ is under the floor of 3 contracts .* \(phase 2 cut the translated 5 to 2: no trade\)$/);
  for (const approved of [0, 1.5, '3']) assert.throws(() => at({ approved }, P.propHome({ size: 5 }).home), /phase 2's approved size is a whole number of 1 or more/, String(approved));
  // A $600 cushion: 0.2 x = $120, 2 micros at $56.74 ($113.48); 3 would risk $170.22: the verdict is a skip that says so.
  const tight = { ...P.MINI, max_loss: 600 };
  const thin = P.propHome({ size: 3, account: tight });
  assert.throws(() => order(thin.home, { strategy: P.LC_DOC, strategies, accounts: [tight] }), /prop_portfolio skipped the setup \(3 MNQ at this stop risk \$170\.22, over the \$120\.00 budget .*2 MNQ would fit\): skip; never a tighter stop\); no order \(the record suggested 3\)/);
});

test('the order_plan tool routes trade_lifecycle (and a policy listing it) to the compose record; the bars are not read', () => {
  const { plan } = require('../../scripts/lib/harness-tools/order-plan');
  const { FAKE_BROKERS } = require('../helpers');
  const home = trendHome();
  LC.writeScenario(home);
  const env = { FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FTH_CYCLE_BARS: JSON.stringify({ MNQ: LC.BAR }), FTH_SYMBOLS: 'MNQ' };
  const r = plan({ file: '/nonexistent/bars.json', symbol: 'MNQ', strategy: 'trade_lifecycle', side: 'long', accountId: 7 }, { env, now: () => P.NOW, replayAt: () => null });
  assert.match(r.text, /place_order arguments: \{"accountId":7,"contractId":"MNQ","side":"buy","type":"limit","size":1,"limitPrice":21540.25/);
  // prop_portfolio with no running attempt: plan trade_lifecycle itself.
  assert.throws(() => plan({ file: 'x', symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long' }, { env, now: () => P.NOW, replayAt: () => null }), /prop_portfolio has no running attempt: plan trade_lifecycle itself/);
});
