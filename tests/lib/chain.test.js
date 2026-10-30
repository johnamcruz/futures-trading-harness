'use strict';

// The fractal chain (scripts/lib/trading/chain.js): the ladder, the 2-level rule, both chains it derives, and the
// RULEBOOK value's validation.

const test = require('node:test');
const assert = require('node:assert');
const C = require('../../scripts/lib/trading/chain');

test('the ladder and the tops: 4h and 1h are the only tops the 2-level rule fits on it', () => {
  assert.deepStrictEqual([...C.LADDER], ['1m', '3m', '5m', '15m', '1h', '4h']);
  assert.deepStrictEqual([...C.TOPS], ['1h', '4h']);
  assert.strictEqual(C.SHIPPED, '4h');
  for (const tf of ['1m', '3m', '5m', '15m', '2h', 'daily', '', null]) assert.strictEqual(C.chainOf(tf), null, String(tf));
});

test('the derivation: 4h -> bias 4h + 1h, levels 1h, setup 15m, entry 3m; 1h -> bias 1h + 15m, levels 15m, setup 5m, entry 1m', () => {
  assert.deepStrictEqual({ ...C.chainOf('4h'), bias: [...C.chainOf('4h').bias] }, { top: '4h', name: '4h/15m/3m', bias: ['4h', '1h'], levels: '1h', setup: '15m', entry: '3m' });
  assert.deepStrictEqual({ ...C.chainOf('1h'), bias: [...C.chainOf('1h').bias] }, { top: '1h', name: '1h/5m/1m', bias: ['1h', '15m'], levels: '15m', setup: '5m', entry: '1m' });
  assert.ok(Object.isFrozen(C.chainOf('4h')) && Object.isFrozen(C.chainOf('4h').bias));
});

test('the 2-level rule: every derived chain obeys it; a chain moved one level anywhere breaks it, naming the frame', () => {
  for (const t of C.TOPS) assert.deepStrictEqual(C.twoLevelErrors(C.chainOf(t)), [], t);
  const c = C.chainOf('4h');
  assert.match(C.twoLevelErrors({ ...c, setup: '5m' }).join(), /setup 5m: the 2-level rule puts it at 15m/);
  assert.match(C.twoLevelErrors({ ...c, entry: '1m' }).join(), /entry 1m: the 2-level rule puts it at 3m/);
  assert.match(C.twoLevelErrors({ ...c, entry: '5m' }).join(), /entry 5m: the 2-level rule puts it at 3m/);
  assert.match(C.twoLevelErrors({ ...c, levels: '15m' }).join(), /levels 15m/);
  assert.match(C.twoLevelErrors({ ...c, bias: ['4h', '15m'] }).join(), /bias/);
  assert.deepStrictEqual(C.twoLevelErrors(null), ['not a chain']);
});

test('chainError: a RULEBOOK chain is a top (4h or 1h); anything else is refused, naming the chains', () => {
  assert.strictEqual(C.chainError('4h', 'x'), null);
  assert.strictEqual(C.chainError('1h', 'x'), null);
  for (const v of ['4h/15m/3m', '15m', 'off', 4, undefined]) assert.match(C.chainError(v, 'p.entry.chain'), /p\.entry\.chain: .* is not a chain top \(1h or 4h: 1h\/5m\/1m, 4h\/15m\/3m;/, String(v));
});
