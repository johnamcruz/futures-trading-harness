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

test('[exit]s other than a stop, market [protect]s and entries are never this rule\'s', () => {
  for (const type of ['limit', 'market', 'join_bid']) {
    assert.strictEqual(protectRefusal({ rationale: '[exit] out', type, covered: 9, size: 1 }), null, type);
  }
  for (const type of ['limit', 'stop', 'market', 'join_bid']) {
    assert.strictEqual(protectRefusal({ rationale: 'setup:orb long, stop 1 [protect]', type, covered: 9, size: 1 }), null, type);
  }
  assert.strictEqual(protectRefusal({ rationale: '[protect] out now', type: 'market', covered: 1, size: 1 }), null);
  assert.strictEqual(protectRefusal({ rationale: '[protect] x', type: undefined, covered: 1, size: 1 }), null);
  assert.strictEqual(protectRefusal(), null);
});

test('a limit or join [exit] is refused (it can rest); market and stop exits, and [protect]s, are not this rule\'s', () => {
  for (const type of ['limit', 'Limit', ' join_bid ', 'join_ask', 1, 6, 7, '1']) assert.strictEqual(restingExitRefusal({ rationale: '[exit] take profit', type }), RESTING_REFUSAL, String(type));
  for (const type of ['market', 'stop', 'trailing_stop', 2, 4, undefined]) assert.strictEqual(restingExitRefusal({ rationale: '[exit] out', type }), null, String(type));
  assert.strictEqual(restingExitRefusal({ rationale: '[protect] t', type: 'limit' }), null, 'a [protect] limit: protectRefusal\'s');
  assert.strictEqual(restingExitRefusal({ rationale: 'setup:orb long [exit]', type: 'limit' }), null, 'an entry');
  assert.strictEqual(restingExitRefusal(), null);
  assert.match(RESTING_REFUSAL, /trailing the bracket stop with modify_order.*market \[exit\]/);
});

test('a stop [exit] is a second stop: refused while the working stops cover the position, as a [protect] stop is; uncovered, it goes', () => {
  const r = (covered, size, type = 'stop') => protectRefusal({ rationale: '[exit] stop out', type, covered, size });
  assert.match(r(1, 1), /already has working stops for 1: a second stop \(\[protect\] or \[exit\]\)/);
  assert.match(r(2, -2, 'trailing_stop'), /working stops for 2/);
  assert.strictEqual(r(0, 1), null, 'no working stop: protection');
  assert.strictEqual(r(1, 2), null, 'the uncovered part');
  assert.strictEqual(r(null, 1), null, 'the hook: the gateway judges it');
  for (const type of ['market', 'limit', 'join_ask']) assert.strictEqual(r(1, 1, type), null, `${type}: not this rule's`);
});
