'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { protectRefusal, restingExitRefusal, LIMIT_REFUSAL, RESTING_REFUSAL } = require('../../scripts/lib/trading/bracket-rule');

test('a [protect] limit is refused whatever the account (a stand-alone target), by name or numeric type', () => {
  for (const type of ['limit', 'Limit', ' join_bid ', 'join_ask', 1, 6, 7, '1']) {
    assert.strictEqual(protectRefusal({ rationale: '[protect] target', type }), LIMIT_REFUSAL, String(type));
    assert.strictEqual(protectRefusal({ rationale: '  [PROTECT] target', type, covered: 0, size: 1 }), LIMIT_REFUSAL, String(type));
  }
  assert.match(LIMIT_REFUSAL, /modify the bracket's stop\/target with modify_order/);
});

test('a [protect] stop is refused only when the working stops cover the whole position', () => {
  const stop = (covered, size, type = 'stop') => protectRefusal({ rationale: '[protect] stop', type, covered, size });
  assert.match(stop(1, 1), /already has working stops for 1.*modify_order/);
  assert.match(stop(2, -2, 'trailing_stop'), /already has working stops for 2/, 'a short (negative net)');
  assert.match(stop(3, 2, 4), /working stops for 3/, 'numeric type, over-covered');
  assert.strictEqual(stop(0, 1), null, 'a lost bracket: risk reduction goes');
  assert.strictEqual(stop(1, 2), null, 'the uncovered part goes');
  assert.strictEqual(stop(null, 1), null, 'unknown (the hook): judged by the gateway');
  assert.strictEqual(stop(1, 0), null, 'no position: the exposure check refuses it');
  assert.strictEqual(stop(1, NaN), null);
});

test('[exit]s, market [protect]s and entries are never this rule\'s', () => {
  for (const type of ['limit', 'stop', 'market', 'join_bid']) {
    assert.strictEqual(protectRefusal({ rationale: '[exit] out', type, covered: 9, size: 1 }), null, type);
    assert.strictEqual(protectRefusal({ rationale: 'setup:orb long, stop 1 [protect]', type, covered: 9, size: 1 }), null, type);
  }
  assert.strictEqual(protectRefusal({ rationale: '[protect] out now', type: 'market', covered: 1, size: 1 }), null);
  assert.strictEqual(protectRefusal({ rationale: '[protect] x', type: undefined, covered: 1, size: 1 }), null);
  assert.strictEqual(protectRefusal(), null);
});

test('a resting [exit] is refused: join orders always; a limit not through the price now; no price, fails closed', () => {
  const r = o => restingExitRefusal({ rationale: '[exit] take profit', ...o });
  for (const type of ['join_bid', 'JOIN_ASK', 6, '7']) assert.strictEqual(r({ type, side: 'sell' }), RESTING_REFUSAL, String(type));
  assert.strictEqual(r({ type: 'limit', side: 'sell', limitPrice: 21540 }), null, 'the hook (no price read): the gateway decides');
  assert.match(r({ type: 'limit', side: 'sell', limitPrice: 21540, price: { ok: true, price: 21500 } }), /Limit 21540 would rest: the price now is 21500/);
  assert.strictEqual(r({ type: 1, side: 'sell', limitPrice: 21500, price: { ok: true, price: 21500 } }), null, 'at the price: fills now');
  assert.strictEqual(r({ type: 'limit', side: 'buy', limitPrice: 21510, price: { ok: true, price: 21500 } }), null, 'a buy through it');
  assert.ok(r({ type: 'limit', side: 'buy', limitPrice: 21490, price: { ok: true, price: 21500 } }), 'a buy under it rests');
  assert.match(r({ type: 'limit', side: 'sell', limitPrice: 21490, price: { ok: false, why: 'timeout' } }), /can't be read \(timeout\).*fails closed/);
  assert.match(r({ type: 'limit', side: 'sell', limitPrice: 21490, price: null }), /can't be read/);
  assert.ok(r({ type: 'limit', side: 'sell', limitPrice: 'x', price: { ok: true, price: 21500 } }), 'no limit price: refused');
  assert.ok(r({ type: 'limit', side: '', limitPrice: 21490, price: { ok: true, price: 21500 } }), 'no side: refused');
  for (const type of ['market', 'stop']) assert.strictEqual(r({ type, side: 'sell', price: null }), null, type);
  assert.strictEqual(restingExitRefusal({ rationale: '[protect] t', type: 'join_ask' }), null, 'a [protect] limit: protectRefusal\'s');
  assert.match(RESTING_REFUSAL, /trailing the bracket stop with modify_order.*market \[exit\]/);
});
