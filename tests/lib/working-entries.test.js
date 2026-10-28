'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { workingEntryLines } = require('../../scripts/lib/trading/working-entries');
const { prompts, validateConfig } = require('../../scripts/lib/autotrader');

const order = { id: 10, contractId: 'MNQ', type: 1, side: 1, size: 6, limitPrice: 13559.5 };
const rec = { orderId: 10, side: 'sell', stopTicks: 92, targetTicks: 207, stopPrice: 13582.5, composed: { stop: 13582.5, target: 13508.25 } };

test('a working entry with a runner record shows its bracket as a fact', () => {
  assert.deepStrictEqual(workingEntryLines([order], [rec]),
    ['entry 10: sell limit 6 @ 13559.5, bracket attached on fill: stop 13582.5 / target 13508.25 (runner record)']);
});

test('ticks stand in for prices, and orders with no record or no bracket show nothing', () => {
  const r = { orderId: 10, stopTicks: 92, targetTicks: 207 };
  assert.match(workingEntryLines([order], [r])[0], /stop 92 ticks \/ target 207 ticks/);
  assert.deepStrictEqual(workingEntryLines([order], [{ ...rec, orderId: 11 }]), []);
  assert.deepStrictEqual(workingEntryLines([order], [{ orderId: 10 }]), []);
  assert.deepStrictEqual(workingEntryLines(null, null), []);
});

test('the cycle prompt carries the working entry line', () => {
  const p = prompts(validateConfig({ account: '123' }), new Date('2026-10-07T14:00:00.000Z'));
  const state = { id: '123', at: '2026-10-07T14:00:01.000Z', balance: 50000, positions: [], workingOrders: 1, attempts: [], entryLines: workingEntryLines([order], [rec]) };
  assert.match(p.trade([{ symbol: 'MNQ' }], { state }), /1 working order\. Working entry 10: sell limit 6 @ 13559.5, bracket attached on fill: stop 13582.5 \/ target 13508.25 \(runner record\)\./);
});

const NOW = new Date('2026-10-07T14:00:00.000Z');
const fresh = { ...rec, contractId: 'MNQ', at: '2026-10-07T13:50:00.000Z' };

test('an expired composed entry shows no line; a live one shows its expiry in ET', () => {
  const exp = ms => ({ ...fresh, composed: { ...fresh.composed, expiresAt: new Date(NOW.getTime() + ms).toISOString() } });
  assert.deepStrictEqual(workingEntryLines([order], [exp(0)], NOW), []);
  assert.deepStrictEqual(workingEntryLines([order], [exp(-60000)], NOW), []);
  assert.match(workingEntryLines([order], [exp(300000)], NOW)[0], /\(runner record\), expires 10:05 ET$/);
});

test('a record for another contract, another side, or an earlier trading day is not this order\'s', () => {
  assert.strictEqual(workingEntryLines([order], [fresh], NOW).length, 1);
  assert.deepStrictEqual(workingEntryLines([order], [{ ...fresh, contractId: 'MES' }], NOW), []);
  assert.deepStrictEqual(workingEntryLines([order], [{ ...fresh, side: 'buy' }], NOW), []);
  assert.deepStrictEqual(workingEntryLines([order], [{ ...fresh, at: '2026-10-05T13:50:00.000Z' }], NOW), []);
});
