'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseToolJson, netPosition, pendingNet, fillLossState, evaluateAccount: rawEvaluate, evaluateCancel } = require('../../scripts/lib/trading/account-gate');
const evaluateAccount = o => rawEvaluate({ positions: [], orders: [], trades: [], ...o });
const { loadConfig } = require('../../scripts/lib/trading/config');
const { CONTRACT, NOW, minutesAgo } = require('../helpers');

const config = loadConfig({});
const long1 = [{ contractId: CONTRACT, type: 1, size: 1 }];
const order = (extra = {}) => ({ accountId: 1, contractId: CONTRACT, side: 'buy', type: 'market', size: 1, rationale: 'setup:orb long, stop 1', ...extra });
const checks = v => v.map(x => x.check);
const fill = (min, pnl, extra = {}) => ({ contractId: CONTRACT, creationTimestamp: minutesAgo(min), profitAndLoss: pnl, ...extra });

test('parseToolJson reads JSON text and throws on errors', () => {
  assert.deepStrictEqual(parseToolJson({ content: [{ type: 'text', text: '[1]' }] }, 't'), [1]);
  assert.throws(() => parseToolJson({ isError: true, content: [{ text: 'boom' }] }, 't'), /t failed: boom/);
  assert.throws(() => parseToolJson({ content: [{ text: 'nope' }] }, 't'), /non-JSON/);
  assert.throws(() => parseToolJson(null, 't'), /failed/);
});

test('netPosition sums long and short positions for the contract only', () => {
  assert.strictEqual(netPosition([...long1, { contractId: CONTRACT, type: 2, size: 3 }, { contractId: 'X', type: 1, size: 9 }], CONTRACT), -2);
  assert.strictEqual(netPosition([], CONTRACT), 0);
});

test('[exit]/[protect] must reduce a real position', () => {
  const exitBuy = order({ rationale: '[exit] take profit' });
  assert.deepStrictEqual(checks(evaluateAccount({ input: exitBuy, positions: [], config })), ['exposure']); // flat
  assert.match(evaluateAccount({ input: exitBuy, positions: long1, config })[0].message, /same side/);
  assert.match(evaluateAccount({ input: order({ side: 'sell', size: 2, rationale: '[exit] x' }), positions: long1, config })[0].message, /exceeds/);
  assert.deepStrictEqual(evaluateAccount({ input: order({ side: 'sell', rationale: '[exit] x' }), positions: long1, config }), []);
});

test('[protect] stops and limits may not stack beyond the position (one of each is fine)', () => {
  const stop = order({ side: 'sell', type: 'stop', stopPrice: 1, rationale: '[protect] stop' });
  const restingStop = [{ contractId: CONTRACT, side: 1, type: 4, size: 1 }];
  assert.deepStrictEqual(evaluateAccount({ input: stop, positions: long1, orders: [], config }), []);
  assert.match(evaluateAccount({ input: stop, positions: long1, orders: restingStop, config })[0].message, /Resting stop/);
  const target = order({ side: 'sell', type: 'limit', limitPrice: 2, rationale: '[protect] target' });
  assert.deepStrictEqual(evaluateAccount({ input: target, positions: long1, orders: restingStop, config }), []);
});

test('entries are refused while a position is open', () => {
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), positions: long1, config })), ['position-open']);
  assert.deepStrictEqual(evaluateAccount({ input: order(), positions: [], config }), []);
});

test('loss streak and daily losses come from real closing fills', () => {
  const opening = fill(100, null);
  const streak = [opening, fill(90, -20), fill(15, -12.5), fill(14, 0)];
  assert.deepStrictEqual(fillLossState(streak).streak, 2);
  const v = evaluateAccount({ input: order(), trades: streak, now: NOW, config });
  assert.deepStrictEqual(checks(v), ['loss-streak']);
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), trades: [fill(200, -1), fill(150, 5), fill(120, -1), fill(110, 3), fill(100, -1)], now: NOW, config })), ['daily-loss-count']);
  assert.deepStrictEqual(evaluateAccount({ input: order(), trades: [fill(20, -5, { voided: true })], now: NOW, config }), []);
});

test('missing account data blocks instead of reading as flat; unknown position types throw', () => {
  assert.throws(() => rawEvaluate({ input: order(), positions: null, orders: [], trades: [], config }), /positions from the server is not a list/);
  assert.throws(() => netPosition([{ contractId: CONTRACT, type: 9, size: 1 }], CONTRACT), /unknown type/);
});

test('positions in another month of the same root count (no entry on H27 while long Z26)', () => {
  const h27 = order({ contractId: 'CON.F.US.MNQ.H27' });
  assert.deepStrictEqual(checks(evaluateAccount({ input: h27, positions: long1, config })), ['position-open']);
});

test('join_bid/join_ask exits count as resting limits', () => {
  const restingJoins = [{ contractId: CONTRACT, side: 1, type: 7, size: 1 }];
  const join = order({ side: 'sell', type: 'join_ask', rationale: '[exit] scale out' });
  assert.match(evaluateAccount({ input: join, positions: long1, orders: restingJoins, config })[0].message, /Resting limit/);
});

test('ledger: an entry sent moments ago blocks a second entry and caps exits until the account reflects it', () => {
  const now = new Date();
  const ledger = [{ contractId: CONTRACT, sign: 1, size: 1, netBefore: 0, at: now.getTime() - 1000 }];
  assert.strictEqual(pendingNet(ledger, CONTRACT, 0, now), 1);
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), positions: [], ledger, now, config })), ['position-open']);
  // Once positions show the fill (net changed), the ledger entry no longer counts.
  assert.strictEqual(pendingNet(ledger, CONTRACT, 1, now), 0);
  // Stale entries expire.
  assert.strictEqual(pendingNet([{ ...ledger[0], at: now.getTime() - 60000 }], CONTRACT, 0, now), 0);
  // Two quick [exit] sells against long 1: the second sees the first as pending and is refused.
  const exitLedger = [{ contractId: CONTRACT, sign: -1, size: 1, netBefore: 1, at: now.getTime() }];
  assert.match(evaluateAccount({ input: order({ side: 'sell', rationale: '[exit] x' }), positions: long1, ledger: exitLedger, now, config })[0].message, /no open/);
});

test('cancel_order may not remove the last protective stop of an open position', () => {
  const stop = { id: 11, contractId: CONTRACT, side: 1, type: 4, size: 1 };
  const target = { id: 12, contractId: CONTRACT, side: 1, type: 1, size: 1 };
  assert.match(evaluateCancel({ input: { orderId: 11 }, positions: long1, orders: [stop, target], config })[0].message, /protective stop/);
  assert.deepStrictEqual(evaluateCancel({ input: { orderId: 12 }, positions: long1, orders: [stop, target], config }), []);
  assert.deepStrictEqual(evaluateCancel({ input: { orderId: 11 }, positions: [], orders: [stop], config }), []);
  assert.deepStrictEqual(evaluateCancel({ input: { orderId: 11 }, positions: long1, orders: [stop, { ...stop, id: 13 }], config }), []);
});
