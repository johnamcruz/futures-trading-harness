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

test('the gateway\'s stamp on a composed entry: the gate\'s own (handed over, or written before sending by its tag); never looked up again; another setup none', () => {
  const home = tmpDir();
  const env = { FTH_HOME: home };
  const args = (o = {}) => ({ contractId: 'MNQ', side: 'buy', rationale: 'setup:trade_lifecycle long ...', ...o });
  const gate = { record: 'r1', expiresAt: LC.EXPIRES, entry: 21540.25, side: 'long' };
  assert.deepStrictEqual(LR.entryStamp(env, args(), gate), gate);
  // Written before sending, keyed by the account and the order's customTag: an order found placed later (no reply)
  // carries it, once; the stamp goes when it is used, and another account's same tag never reads it.
  const key = LR.pendingKey('7', 'tag-1');
  assert.strictEqual(key, '7:tag-1');
  LR.writePendingStamp(env, key, gate);
  assert.deepStrictEqual(LR.pendingStamp(env, key), gate);
  assert.strictEqual(LR.pendingStamp(env, LR.pendingKey('8', 'tag-1')), null, 'another account');
  assert.deepStrictEqual(LR.entryStamp(env, args(), null, key), gate);
  assert.strictEqual(LR.pendingStamp(env, key), null, 'used: deleted');
  assert.deepStrictEqual(LR.entryStamp(env, args(), null, key), { record: null, expiresAt: null }, 'never used twice');
  LR.writePendingStamp(env, key, gate);
  LR.clearPendingStamp(env, key);
  assert.strictEqual(LR.pendingStamp(env, key), null, 'cleared');
  // A composed entry with no stamp (the gate's lost): no record, no expiry, so due at once; a policy's tag too.
  assert.deepStrictEqual(LR.entryStamp(env, args(), null, 'other'), { record: null, expiresAt: null });
  assert.deepStrictEqual(LR.entryStamp(env, args({ rationale: 'setup:prop_portfolio long trade_lifecycle ...' })), { record: null, expiresAt: null });
  // A record on disk is never looked up at this point.
  LC.writeScenario(home);
  assert.deepStrictEqual(LR.entryStamp({ ...env, FTH_CYCLE_BARS: JSON.stringify({ MNQ: LC.BAR }) }, args()), { record: null, expiresAt: null });
  assert.strictEqual(LR.entryStamp(env, args({ rationale: 'setup:fx_break long' })), null, 'another setup: no stamp');
  assert.strictEqual(LR.entryStamp(env, args({ rationale: '[exit] flat' })), null);
  // Kept bounded.
  for (let i = 0; i < 205; i += 1) LR.writePendingStamp(env, `t${i}`, gate);
  assert.strictEqual(LR.pendingStamp(env, 'tag-1'), null);
  assert.deepStrictEqual(LR.pendingStamp(env, 't204'), gate);
  const rec = { id: 'r1' };
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

test('unrecorded working entry limits (a lane of composed strategies only): flat, or adding to the position\'s side; a target, a stop or a recorded entry stays', () => {
  const entries = [{ orderId: 1 }];
  const orders = [
    { id: 1, contractId: 'MNQ:2026-12', type: 1, side: 0 },
    { id: 2, contractId: 'MNQ:2026-12', type: 1, side: 0 },
    { id: 3, contractId: 'MNQ:2026-12', type: 1, side: 1 },
    { id: 4, contractId: 'MNQ:2026-12', type: 4, side: 1 },
    { id: 5, contractId: 'MES:2026-12', type: 1, side: 0 },
  ];
  const ids = positions => LR.unrecordedEntries({ entries, orders, positions, root: 'MNQ' }).map(o => o.id);
  assert.deepStrictEqual(ids([]), [2, 3], 'flat: every unrecorded limit');
  assert.deepStrictEqual(ids([{ contractId: 'MNQ:2026-12', type: 1, size: 1 }]), [2], 'long: a buy limit adds; the sell limit is its target');
  assert.deepStrictEqual(ids([{ contractId: 'MNQ:2026-12', type: 2, size: 1 }]), [3]);
  // A position whose side can't be read (size not a number, size missing, type missing or unknown): it may be open on
  // either side, so nothing is taken for an entry and nothing is cancelled (positions.js isOpen, signedSize).
  assert.deepStrictEqual(ids([{ contractId: 'MNQ:2026-12', type: 1, size: 'x' }]), [], 'size "x"');
  assert.deepStrictEqual(ids([{ contractId: 'MNQ:2026-12', type: 1 }]), [], 'size missing');
  assert.deepStrictEqual(ids([{ contractId: 'MNQ:2026-12', size: 1 }]), [], 'type missing');
  assert.deepStrictEqual(ids([{ contractId: 'MNQ:2026-12', type: 9, size: 1 }]), [], 'type unknown');
  // Another root's unreadable position doesn't matter here; a flat (size 0) one reads as flat.
  assert.deepStrictEqual(ids([{ contractId: 'MES:2026-12', type: 1, size: 'x' }]), [2, 3]);
  assert.deepStrictEqual(ids([{ contractId: 'MNQ:2026-12', type: 1, size: 0 }]), [2, 3]);
});

test('a record as the history and the cycle log keep it; a cycle\'s own compose_check calls by its id', () => {
  const home = tmpDir();
  const rec = { ...LC.writeScenario(home), cycleId: 'abc' };
  appendRecord(home, rec);
  const s = LR.recordSummary(rec);
  assert.deepStrictEqual([s.id, s.side, s.ok, s.size, s.stop, s.target, s.rr, s.reads.length, s.problems], [rec.id, 'long', true, 1, 21512.5, 21598, 2.08, 6, 0]);
  assert.deepStrictEqual([s.symbol, s.entry, s.tick, s.tickValue], ['MNQ', 21540.25, 0.25, 0.5]);
  assert.strictEqual(s.signature, rec.signature);
  // The first level in the way (the scorecard's room for a composed setup).
  assert.deepStrictEqual(LR.recordSummary({ ...rec, plan: { ...rec.plan, inTheWay: { name: 'prior 1h high', price: 21560, R: 0.71 } } }).inTheWay, { name: 'prior 1h high', price: 21560, R: 0.71 });
  assert.strictEqual(LR.recordSummary({ ...rec, plan: { ...rec.plan, inTheWay: null } }).inTheWay, null);
  assert.deepStrictEqual(LR.cycleComposed(home, 'abc', ['MNQ', 'NQ']).map(x => x.id), [rec.id]);
  assert.deepStrictEqual([LR.cycleComposed(home, null, ['MNQ']), LR.cycleComposed(home, 'other', ['MNQ']), LR.recordSummary(null)], [[], [], null]);
});

test('a composed entry that may still be working in a cycle: its expiry not passed at the cycle\'s start, or none stamped and sent since then', () => {
  const since = Date.parse('2026-10-07T14:00:00Z');
  const live = (e, roots = ['MNQ']) => LR.liveComposed({ entries: [{ orderId: 1, contractId: 'MNQ:2026-12', at: '2026-10-07T13:50:00.000Z', ...e }], roots, since });
  assert.strictEqual(live({ composed: { record: 'r', expiresAt: '2026-10-07T14:03:00.000Z' } }), true);
  assert.strictEqual(live({ composed: { record: 'r', expiresAt: '2026-10-07T14:00:00.000Z' } }), true, 'at the start');
  assert.strictEqual(live({ composed: { record: 'r', expiresAt: '2026-10-07T13:57:00.000Z' } }), false, 'expired before the cycle (cancelled then)');
  assert.strictEqual(live({ composed: { record: null, expiresAt: null } }), false, 'no expiry, sent before the cycle (cancelled then)');
  assert.strictEqual(live({ composed: { record: null, expiresAt: null }, at: '2026-10-07T14:00:30.000Z' }), true, 'no expiry, sent in the cycle');
  assert.strictEqual(live({ composed: { record: null, expiresAt: null }, at: 'garbled' }), true, 'no readable time: may be working');
  assert.strictEqual(live({}), false, 'not composed');
  assert.strictEqual(live({ composed: { record: 'r', expiresAt: '2026-10-07T14:03:00.000Z' } }, ['MES']), false, 'another root');
  assert.strictEqual(live({ contractId: 'NQ:2026-12', composed: { record: 'r', expiresAt: '2026-10-07T14:03:00.000Z' } }), true, 'the family');
});

test('entryStamp: the gate\'s stamp keeps the plan\'s entry, stop and target prices', () => {
  const s = LR.entryStamp({}, {}, { record: 'r1', expiresAt: '2021-08-18T17:42:00.000Z', entry: 14979.5, stop: 14986.5, target: 14960, side: 'short' });
  assert.deepStrictEqual(s, { record: 'r1', expiresAt: '2021-08-18T17:42:00.000Z', entry: 14979.5, stop: 14986.5, target: 14960, side: 'short' });
});

test('fillGuard: a composed fill beyond the plan\'s stop is flattened; one away from the limit gets the plan\'s stop (tightened, never widened); one at the limit is left', () => {
  const tick = 0.25;
  // The replay's short: sell limit 14979.5, stop 14986.5 (28 ticks), filled at 14997.5 with its bracket 28 ticks above.
  const entry = { setup: 'trade_lifecycle', side: 'sell', stopPrice: 14986.5, composed: { record: 'r1', entry: 14979.5, stop: 14986.5, target: 14960, side: 'short' } };
  const short = fill => ({ position: { contractId: 'MNQ', type: 2, size: 1, averagePrice: fill }, entry, tick, orders: [{ id: 9, contractId: 'MNQ', type: 4, side: 0, size: 1, stopPrice: fill + 7 }, { id: 10, contractId: 'MNQ', type: 1, side: 0, size: 1, limitPrice: fill - 19.5 }] });
  const bad = LR.fillGuard(short(14997.5));
  assert.deepStrictEqual([bad.action, bad.why], ['flatten', 'filled at 14997.5, beyond the plan\'s stop 14986.5: the setup was invalid before the fill (no late entry)']);
  assert.strictEqual(LR.fillGuard(short(14986.5)).action, 'flatten', 'at the stop');
  // A better fill (2 points above the limit): the stop from 14988.5 to the plan's 14986.5, toward the fill.
  assert.deepStrictEqual(LR.fillGuard(short(14981.5)), { action: 'reanchor', orderId: 9, from: 14988.5, to: 14986.5, why: 'filled at 14981.5, not the plan\'s 14979.5: the stop goes to the plan\'s 14986.5 (the structure level), from 14988.5' });
  // The price now beyond the plan's stop: flattened, not moved.
  assert.strictEqual(LR.fillGuard({ ...short(14981.5), price: 14987 }).action, 'flatten');
  assert.strictEqual(LR.fillGuard(short(14979.5)).action, 'none', 'at the limit: the bracket is the plan\'s');
  // A long, the mirror: limit 21500, stop 21490; a fill at 21498 (better) has its stop at 21488 -> 21490.
  const longE = { side: 'buy', composed: { entry: 21500, stop: 21490, target: 21520 } };
  const long = (fill, stopPrice) => ({ position: { contractId: 'MNQ', type: 1, size: 1, averagePrice: fill }, entry: longE, tick, orders: [{ id: 3, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice }] });
  assert.deepStrictEqual(LR.fillGuard(long(21498, 21488)), { action: 'reanchor', orderId: 3, from: 21488, to: 21490, why: 'filled at 21498, not the plan\'s 21500: the stop goes to the plan\'s 21490 (the structure level), from 21488' });
  assert.strictEqual(LR.fillGuard(long(21489.75, 21479.75)).action, 'flatten');
  // A worse fill (slippage): the plan's stop would widen the risk: the resting stop is kept.
  assert.match(LR.fillGuard(long(21501, 21491)).why, /wider than the resting 21491: kept/);
  assert.strictEqual(LR.fillGuard(long(21498, 21490)).action, 'none', 'already at the plan\'s');
  // Not composed, no single stop, or nothing to check: nothing done.
  assert.strictEqual(LR.fillGuard({ ...long(21498, 21488), entry: { side: 'buy' } }).action, 'none');
  assert.match(LR.fillGuard({ ...long(21498, 21488), orders: [] }).why, /0 working stops/);
  // The stop from the rationale ("stop <price>") when the stamp has none.
  assert.strictEqual(LR.fillGuard({ ...long(21489, 21479), entry: { side: 'buy', stopPrice: 21490, composed: { entry: 21500 } } }).action, 'flatten');
});
