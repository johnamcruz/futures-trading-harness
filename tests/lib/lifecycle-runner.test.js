'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const LR = require('../../scripts/lib/trading/lifecycle-runner');
const { appendRecord } = require('../../scripts/lib/trading/trade-lifecycle');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { startErrors } = require('../../scripts/lib/lanes');
const { tmpDir } = require('../helpers');
const LC = require('../fixtures/lifecycle');

const SHIPPED = loadStrategies(path.resolve(__dirname, '..', '..'), {}).strategies;

test('composed setups: trade_lifecycle and every policy listing it; the instincts are off on its timeframe while it is active', () => {
  assert.deepStrictEqual([...LR.composedSetups(SHIPPED)].sort(), ['prop_portfolio', 'trade_lifecycle']);
  assert.deepStrictEqual([...LR.composedSetups(SHIPPED.map(s => (s.name === 'trade_lifecycle' ? { ...s, valid: false } : s)))], [], 'an invalid one: none');
  assert.strictEqual(LR.runsComposed(SHIPPED, '3m'), true);
  assert.strictEqual(LR.runsComposed(SHIPPED, '1m'), false);
  assert.strictEqual(LR.runsComposed(SHIPPED.map(s => ({ ...s, status: 'paper' })), '3m'), false);
});

test('D11: a lane listing the composed trade on trigger "signal" is refused at start; on trigger "bar" it is not', () => {
  const lanes = trigger => [{ timeframe: 3, trigger, strategies: ['trade_lifecycle'], policies: null }, { timeframe: 1, trigger: 'bar', strategies: null, policies: ['prop_portfolio'] }];
  assert.match(LR.composedLaneErrors(lanes('signal'), SHIPPED).join(), /lane 3m lists trade_lifecycle on trigger "signal".*use trigger "bar"/);
  assert.deepStrictEqual(LR.composedLaneErrors(lanes('bar'), SHIPPED), []);
  assert.match(LR.composedLaneErrors([{ timeframe: 3, trigger: 'signal', strategies: null, policies: ['prop_portfolio'] }], SHIPPED).join(), /lists prop_portfolio/);
  // Through the runner's start check.
  const cfg = { timeframe: 3, trigger: 'signal', account: '7', lanes: lanes('signal') };
  assert.ok(startErrors(cfg, SHIPPED, []).some(e => /trade_lifecycle on trigger "signal"/.test(e)));
});

test('the gateway\'s stamp on a composed entry: its record on the cycle\'s bar and that record\'s expiry; due at it, or at once with none', () => {
  const home = tmpDir();
  const rec = LC.writeScenario(home);
  const env = { FTH_HOME: home, FTH_CYCLE_BARS: JSON.stringify({ MNQ: LC.BAR }) };
  const args = (o = {}) => ({ contractId: 'MNQ', side: 'buy', rationale: 'setup:trade_lifecycle long ...', ...o });
  assert.deepStrictEqual(LR.entryStamp(env, args()), { record: rec.id, expiresAt: LC.EXPIRES, bar: LC.BAR });
  assert.deepStrictEqual(LR.entryStamp(env, args({ rationale: 'setup:prop_portfolio long trade_lifecycle ...' })), { record: rec.id, expiresAt: LC.EXPIRES, bar: LC.BAR }, 'a policy listing it');
  // Several lanes: the briefing's bar over the lane bar that closed.
  assert.strictEqual(LR.entryStamp({ ...env, FTH_CYCLE_BARS: JSON.stringify({ MNQ: '2026-10-07T13:59:00.000Z' }), FTH_CYCLE_BRIEFING_BARS: JSON.stringify({ MNQ: LC.BAR }) }, args()).record, rec.id);
  assert.deepStrictEqual(LR.entryStamp(env, args({ side: 'sell', rationale: 'setup:trade_lifecycle short' })), { record: null, expiresAt: null, bar: LC.BAR });
  assert.deepStrictEqual(LR.entryStamp({ FTH_HOME: home }, args()), { record: null, expiresAt: null, bar: null }, 'no cycle bar');
  assert.strictEqual(LR.entryStamp(env, args({ rationale: 'setup:fx_break long' })), null, 'another setup: no stamp');
  assert.strictEqual(LR.entryStamp(env, args({ rationale: '[exit] flat' })), null);
  // Due: at or after the stamped expiry; at once when there is none (stamped without a record, or not stamped at all,
  // as after a restart); never another setup's order, never one the gateway didn't record.
  const composed = LR.composedSetups(SHIPPED);
  const entries = [
    { orderId: 1, setup: 'trade_lifecycle', composed: { record: rec.id, expiresAt: LC.EXPIRES } },
    { orderId: 2, setup: 'trade_lifecycle', composed: { record: null, expiresAt: null } },
    { orderId: 3, setup: 'trade_lifecycle' },
    { orderId: 4, setup: 'fx_break' },
  ];
  const orders = [1, 2, 3, 4, 5].map(id => ({ id }));
  const due = at => LR.dueComposed({ entries, orders, composed, now: new Date(at) }).map(x => x.order.id);
  assert.deepStrictEqual(due('2026-10-07T14:02:59Z'), [2, 3]);
  assert.deepStrictEqual(due(LC.EXPIRES), [1, 2, 3]);
});

test('a record as the history and the cycle log keep it; a cycle\'s own compose_check calls by its id', () => {
  const home = tmpDir();
  const rec = { ...LC.writeScenario(home), cycleId: 'abc' };
  appendRecord(home, rec);
  const s = LR.recordSummary(rec);
  assert.deepStrictEqual([s.id, s.side, s.ok, s.size, s.stop, s.target, s.rr, s.reads.length, s.problems], [rec.id, 'long', true, 1, 21512.5, 21598, 2.08, 6, 0]);
  assert.deepStrictEqual([s.symbol, s.entry, s.tick, s.tickValue], ['MNQ', 21540.25, 0.25, 0.5]);
  assert.strictEqual(s.signature, rec.signature);
  assert.deepStrictEqual(LR.cycleComposed(home, 'abc', ['MNQ', 'NQ']).map(x => x.id), [rec.id]);
  assert.deepStrictEqual([LR.cycleComposed(home, null, ['MNQ']), LR.cycleComposed(home, 'other', ['MNQ']), LR.recordSummary(null)], [[], [], null]);
});
