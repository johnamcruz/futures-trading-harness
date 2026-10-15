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
