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
  assert.match(r.line, /size 1: yours, at or under the ceiling 1 \(trade_lifecycle's risk.max_risk_usd \$100.00 at \$55.50 a contract\)/);
  // The model stated 2: $111 over the $100 cap. Refused, never cut.
  const two = trendHome();
  LC.writeScenario(two, { size: 2 });
  assert.throws(() => order(two), /\[composed-reads\] .*size 2 risks \$111, over the strategy's risk.max_risk_usd \$100 \(at most 1 at this stop\)/);
  // With a cap of $200 the record's 2 fits and the plan's ceiling is 3.
  const wide = { ...P.SHIPPED, risk: { ...P.SHIPPED.risk, max_risk_usd: 200 } };
  const w2 = trendHome();
  LC.writeScenario(w2, { size: 4, maxRiskUsd: 200 });
  assert.throws(() => order(w2, { strategy: wide, strategies: [wide] }), /size 4 risks \$222/);
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

test('order_plan, composed, in an attempt: the policy sizes the record once (its verdict, record id), the stated size goes at or under it, under the policy\'s tag', () => {
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
  // Stated over the verdict: refused.
  const over = P.propHome({ size: 8 });
  assert.throws(() => order(over.home, { strategy: P.LC_DOC, strategies }), /your stated size 8 is over the ceiling 7 \(prop_portfolio's verdict \(7 MNQ\) and the size budget now\)/);
  assert.strictEqual(latestVerdict(over.home, 'prop_portfolio', 'MNQ').record, over.rec.id);
  // An attempt runs but no policy that trades it lists the composed strategy: no entry.
  assert.throws(() => order(home, { strategy: P.LC_DOC, strategies: [P.policy({ strategies: [] }), P.LC_DOC] }), /no policy strategy that trades it lists trade_lifecycle/);
  assert.strictEqual(attemptPolicy(trendHome(), P.LC_DOC, strategies, 'MNQ'), null, 'no attempt: none');
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
