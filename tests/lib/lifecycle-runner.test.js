'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const LR = require('../../scripts/lib/trading/lifecycle-runner');
const { appendRecord } = require('../../scripts/lib/trading/trade-lifecycle');
const { recordsAt } = require('../../scripts/lib/trading/lifecycle-gate');
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

test('stamping: each composed entry the cycle placed gets its record\'s expiry; older ids, other setups and a second stamp are left alone', () => {
  const home = tmpDir();
  const rec = LC.writeScenario(home);
  appendRecord(home, { ...rec, id: 'short-one', side: 'short' });
  const entries = [
    { orderId: 1, contractId: 'MNQ', side: 'buy', setup: 'trade_lifecycle' },
    { orderId: 2, contractId: 'MNQ', side: 'buy', setup: 'fx_break' },
    { orderId: 3, contractId: 'MNQ', side: 'buy', setup: 'trade_lifecycle' },
    { orderId: 4, contractId: 'NQ', side: 'buy', setup: 'prop_portfolio' },
    { orderId: 5, contractId: 'MES', side: 'buy', setup: 'trade_lifecycle' },
  ];
  const items = [{ symbol: 'MNQ', bar: LC.BAR }];
  const stamp = known => LR.stampComposed({ known, before: new Set(['3']), entries, items, recordsAt: (root, bar) => recordsAt(home, root, bar), composed: LR.composedSetups(SHIPPED) });
  const k = stamp({});
  assert.deepStrictEqual(k, {
    1: { expiresAt: LC.EXPIRES, record: rec.id, root: 'MNQ' },
    4: { expiresAt: LC.EXPIRES, record: rec.id, root: 'NQ' },
    // No record for MES on the cycle's bar (no MES item): due at once, so it is cancelled (fails safe).
    5: { expiresAt: null, record: null, root: 'MES' },
  });
  assert.deepStrictEqual(stamp({ 1: { expiresAt: 'kept', record: 'x', root: 'MNQ' } })[1], { expiresAt: 'kept', record: 'x', root: 'MNQ' });
  // Due: at or after the expiry, or with none; never an order not stamped.
  const orders = [{ id: 1 }, { id: 4 }, { id: 5 }, { id: 9 }];
  assert.deepStrictEqual(LR.dueComposed({ known: k, orders, now: new Date('2026-10-07T14:02:59Z') }).map(o => o.id), [5]);
  assert.deepStrictEqual(LR.dueComposed({ known: k, orders, now: new Date(LC.EXPIRES) }).map(o => o.id), [1, 4, 5]);
  // Bounded.
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [String(100 + i), { expiresAt: null }]));
  assert.strictEqual(Object.keys(LR.stampComposed({ known: many, entries: [], items, recordsAt: () => [] })).length, LR.KEEP);
});

test('a record as the history and the cycle log keep it; a cycle\'s own compose_check calls by its id', () => {
  const home = tmpDir();
  const rec = { ...LC.writeScenario(home), cycleId: 'abc' };
  appendRecord(home, rec);
  const s = LR.recordSummary(rec);
  assert.deepStrictEqual([s.id, s.side, s.ok, s.size, s.stop, s.target, s.rr, s.reads.length, s.problems], [rec.id, 'long', true, 1, 21512.5, 21598, 2.08, 6, 0]);
  assert.strictEqual(s.signature, rec.signature);
  assert.deepStrictEqual(LR.cycleComposed(home, 'abc', ['MNQ', 'NQ']).map(x => x.id), [rec.id]);
  assert.deepStrictEqual([LR.cycleComposed(home, null, ['MNQ']), LR.cycleComposed(home, 'other', ['MNQ']), LR.recordSummary(null)], [[], [], null]);
});
