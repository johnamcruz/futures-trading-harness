'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseToolJson, netPosition, pendingNet, pendingState, fillLossState, evaluateAccount: rawEvaluate, evaluateCancel, evaluateModifyAccount, evaluatePartialClose, evaluateAccountChange } = require('../../scripts/lib/trading/account-gate');
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

test('a position whose size can\'t be read is never a flat account: entries, exits, the prop rule and cancels all refuse', () => {
  const odd = [{ contractId: CONTRACT, type: 1, quantity: 1 }];
  assert.throws(() => evaluateAccount({ input: order(), positions: odd, config }), /no valid size/);
  assert.throws(() => evaluateAccount({ input: order({ side: 'sell', rationale: '[exit] flatten' }), positions: odd, config }), /no valid size/);
  assert.throws(() => evaluateAccount({ input: order(), positions: [{ contractId: 'MES', type: 1, size: 1.5 }], config, propAttempt: 'topstep_50k' }), /no valid size/);
  const stop = [{ id: 9, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 21480 }];
  assert.throws(() => evaluateCancel({ input: { orderId: 9 }, positions: odd, orders: stop, config, now: NOW }), /no valid size/);
  // A bad row in another market never keeps an exit or a protective stop from its own position; an entry still refuses.
  const elsewhere = [{ contractId: CONTRACT, type: 1, size: 1 }, { contractId: 'CL', type: 1, size: null }];
  const protect = order({ side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long' });
  assert.deepStrictEqual(evaluateAccount({ input: protect, positions: elsewhere, config }).map(v => v.check), []);
  assert.throws(() => evaluateAccount({ input: order(), positions: elsewhere, config }), /CL has no valid size/);
});

test('modify_order: a stop can\'t be moved once a close sent moments ago leaves it protecting nothing', () => {
  const stop = [{ id: 9, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 21480 }];
  const close = [{ contractId: CONTRACT, sign: -1, size: 1, netBefore: 1, at: NOW.getTime(), sentAt: NOW.getTime() }];
  const run = (input, ledger) => checks(evaluateModifyAccount({ input, positions: long1, orders: stop, config, ledger, now: NOW }));
  assert.deepStrictEqual(run({ orderId: 9, stopPrice: 21600 }, []), [], 'no close sent: toward the market is fine');
  assert.deepStrictEqual(run({ orderId: 9, stopPrice: 21600 }, close), ['modify-entry'], 'after the close: it would open a short');
  // A partial close (2 -> 1) sent but not shown yet: the stop is cut to 1 only once the account shows 1
  // (if the close doesn't fill, a 1-lot stop would leave a contract unprotected), as before.
  const long2 = [{ contractId: CONTRACT, type: 1, size: 2 }];
  const stop2 = [{ ...stop[0], size: 2 }];
  const partial = [{ ...close[0], netBefore: 2 }];
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 9, size: 1, reason: '[protect] cut' }, positions: long2, orders: stop2, config, ledger: partial, now: NOW })), ['modify-size']);
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 9, size: 1, reason: '[protect] cut' }, positions: long1, orders: stop2, config, ledger: partial, now: NOW })), [], 'once it shows');
  // Moving the 2-lot stop after the partial close: on this side it exceeds the projected 1 and could flip it.
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 9, stopPrice: 21500 }, positions: long2, orders: stop2, config, ledger: partial, now: NOW })), ['modify-protection']);
});

test('partial_close_position: needs an open position in that month and a size within it, now and once recent orders fill', () => {
  const run = (input, positions = long1, ledger = []) => checks(evaluatePartialClose({ input: { accountId: 1, contractId: CONTRACT, ...input }, positions, orders: [], config, ledger, now: NOW }));
  assert.deepStrictEqual(run({ size: 1 }), []);
  assert.deepStrictEqual(run({ size: 50 }), ['partial-close'], 'over the position: it would reverse it');
  assert.deepStrictEqual(run({ size: 1 }, []), ['partial-close'], 'no position');
  assert.deepStrictEqual(run({ size: 0 }), ['partial-close']);
  assert.deepStrictEqual(run({ size: 1.5 }), ['partial-close']);
  const close = [{ contractId: CONTRACT, sign: -1, size: 1, netBefore: 1, at: NOW.getTime() }];
  assert.deepStrictEqual(run({ size: 1 }, long1, close), ['partial-close'], 'a close sent moments ago leaves nothing to reduce');
  assert.throws(() => run({ size: 1 }, [{ contractId: CONTRACT, type: 1 }]), /no valid size/);
  assert.deepStrictEqual(checks(evaluateAccountChange('partial_close_position', { input: { contractId: CONTRACT, size: 5 }, positions: long1, orders: [], config, now: NOW })), ['partial-close']);
  assert.throws(() => evaluateAccountChange('close_position', { input: {}, positions: [], orders: [], config, now: NOW }), /no account check/);
});

test('positions in another month of the same root count (no entry on H27 while long Z26)', () => {
  const h27 = order({ contractId: 'MNQ:2027-03' });
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

test('cancel_order: a close the gateway sent and the server confirmed counts before the account shows it', () => {
  const now = new Date('2026-10-07T14:00:00Z');
  const stop = { id: 11, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: 21480 };
  const long1 = [{ contractId: 'MNQ', type: 1, size: 1 }];
  const closed = [{ contractId: 'MNQ', root: 'MNQ', sign: -1, size: 1, netBefore: 1, rootNetBefore: 1, at: now.getTime() - 1000 }];
  assert.deepStrictEqual(evaluateCancel({ input: { orderId: 11 }, positions: long1, orders: [stop], config, ledger: closed, now }), []);
  // A stale entry, or one on another contract, doesn't count.
  const stale = [{ ...closed[0], at: now.getTime() - 60000 }];
  assert.match(evaluateCancel({ input: { orderId: 11 }, positions: long1, orders: [stop], config, ledger: stale, now })[0].message, /protective stop/);
  const other = [{ ...closed[0], contractId: 'MNQ:2027-03' }];
  assert.match(evaluateCancel({ input: { orderId: 11 }, positions: long1, orders: [stop], config, ledger: other, now })[0].message, /protective stop/);
});

test('cancel_order: a resting [exit] target in the ledger hasn\'t changed the position, so the only stop stays', () => {
  const orders = [{ id: 9, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 21480 }, { id: 55, contractId: CONTRACT, side: 1, type: 1, size: 1, limitPrice: 21600 }];
  const ledger = [{ contractId: CONTRACT, sign: -1, size: 1, netBefore: 1, at: NOW.getTime(), orderId: '55' }];
  assert.deepStrictEqual(checks(evaluateCancel({ input: { orderId: 9 }, positions: long1, orders, config, ledger, now: NOW })), ['cancel-protection']);
});

test('cancel_order: an entry still working (perhaps filled in part) keeps its bracket stop protecting it', () => {
  // The gateway sent buy 2 (order 77); it still works with 1 left while positions lag: flat on the account.
  const orders = [{ id: 9, contractId: CONTRACT, side: 1, type: 4, size: 2, stopPrice: 21480 }, { id: 77, contractId: CONTRACT, side: 0, type: 1, size: 1, limitPrice: 21500 }];
  const ledger = [{ contractId: CONTRACT, sign: 1, size: 2, netBefore: 0, at: NOW.getTime(), orderId: '77' }];
  assert.deepStrictEqual(checks(evaluateCancel({ input: { orderId: 9 }, positions: [], orders, config, ledger, now: NOW })), ['cancel-protection']);
});

test('ledger: entries are ordered by when they were sent, so one settled late doesn\'t count on top of a close sent after it', () => {
  const t = NOW.getTime();
  // An entry (buy 1 from flat) sent first but settled late, then a close of the resulting long sent after it.
  const entry = { contractId: CONTRACT, sign: 1, size: 1, netBefore: 0, at: t, sentAt: t - 20000 };
  const close = { contractId: CONTRACT, sign: -1, size: 1, netBefore: 1, at: t - 1000, sentAt: t - 1000 };
  assert.strictEqual(pendingState([close, entry], CONTRACT, 1, NOW, undefined, { exact: true }).projected, 0);
});

test('ledger: exits must hold against the position once every recent order fills', () => {
  const now = new Date();
  const long2 = [{ contractId: CONTRACT, type: 1, size: 2 }];
  const a = { contractId: CONTRACT, sign: -1, size: 1, netBefore: 2, at: now.getTime() - 2000 };
  const b = { contractId: CONTRACT, sign: -1, size: 1, netBefore: 2, at: now.getTime() - 1000 };
  const exit = order({ side: 'sell', rationale: '[exit] x' });
  // A filled (account shows 1), B hasn't: a third exit would flip to short.
  assert.deepStrictEqual(checks(evaluateAccount({ input: exit, positions: long1, ledger: [a, b], now, config })), ['exposure']);
  // Only A sent and filled: the next exit of 1 is fine.
  assert.deepStrictEqual(evaluateAccount({ input: exit, positions: long1, ledger: [a], now, config }), []);
  // Nothing filled yet: the projection still caps the exit.
  assert.deepStrictEqual(checks(evaluateAccount({ input: order({ side: 'sell', size: 2, rationale: '[exit] x' }), positions: long2, ledger: [a], now, config })), ['exposure']);
});

test('entries wait while orders are working in a flat contract', () => {
  const leftover = [{ id: 5, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 21400 }];
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), orders: leftover, config })), ['working-orders']);
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), orders: [{ ...leftover[0], contractId: 'MES' }], config })), []);
});

test('a protective stop may move toward the market only', () => {
  const { evaluateModifyAccount } = require('../../scripts/lib/trading/account-gate');
  const sellStop = { id: 9, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 21480 };
  const run = (input, positions = long1, orders = [sellStop]) => checks(evaluateModifyAccount({ input, positions, orders, config }));
  assert.deepStrictEqual(run({ orderId: 9, stopPrice: 0.25 }), ['modify-protection']);
  assert.deepStrictEqual(run({ orderId: 9, stopPrice: 21490 }), []);
  assert.deepStrictEqual(run({ orderId: 9, stopPrice: 21400 }, []), ['modify-entry'], 'no position: a leftover is re-placed, not repriced');
  const buyStop = { ...sellStop, side: 0, stopPrice: 21520 };
  assert.deepStrictEqual(run({ orderId: 9, stopPrice: 21560 }, [{ contractId: CONTRACT, type: 2, size: 1 }], [buyStop]), ['modify-protection']);
  assert.deepStrictEqual(run({ orderId: 9, trailPrice: 21470 }, long1, [{ ...sellStop, type: 5, stopPrice: null }]), ['modify-protection'], 'unknown level: refuse');
});

test('contract months: an exit must be in the month that is open, and a long and a short in two months are not flat', () => {
  const Z = CONTRACT;
  const H = 'MNQ:2027-03';
  const longZ = [{ contractId: Z, type: 1, size: 1 }];
  const exitH = order({ contractId: H, side: 'sell', rationale: '[exit] before the roll' });
  assert.match(evaluateAccount({ input: exitH, positions: longZ, config })[0].message, /open MNQ position is in MNQ/);
  const hedged = [{ contractId: Z, type: 1, size: 1 }, { contractId: H, type: 2, size: 1 }];
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), positions: hedged, config })), ['position-open']);
  const stopZ = { id: 50, contractId: Z, side: 1, type: 4, size: 1, stopPrice: 21400 };
  assert.match(evaluateCancel({ input: { orderId: 50 }, positions: hedged, orders: [stopZ], config })[0].message, /protective stop/);
});

test('modify_order: sizes may only shrink; every price field must keep a protective stop tightening', () => {
  const { evaluateModifyAccount } = require('../../scripts/lib/trading/account-gate');
  const long2 = [{ contractId: CONTRACT, type: 1, size: 2 }];
  const stop = { id: 9, contractId: CONTRACT, side: 1, type: 4, size: 2, stopPrice: 21480 };
  const run = input => checks(evaluateModifyAccount({ input, positions: long2, orders: [stop], config }));
  assert.deepStrictEqual(run({ orderId: 9, size: 1 }), ['modify-size'], 'long 2: cutting the stop to 1 would leave 1 unprotected');
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 9, size: 1 }, positions: long1, orders: [stop], config })), [], 'after the partial exit, cut the stop to 1');
  const entry = { id: 31, contractId: CONTRACT, side: 0, type: 1, size: 1, limitPrice: 21400 };
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 31, limitPrice: 21600 }, positions: [], orders: [entry], config })), ['modify-entry'], 'an entry is re-placed, not repriced');
  const leftover = { id: 60, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 20900 };
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 60, stopPrice: 21050 }, positions: [], orders: [leftover], config })), ['modify-entry']);
  const target = { id: 12, contractId: CONTRACT, side: 1, type: 1, size: 2, limitPrice: 21600 };
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 12, limitPrice: 21580 }, positions: long2, orders: [stop, target], config })), [], 'a target can move');
  assert.deepStrictEqual(run({ orderId: 9, size: 3 }), ['modify-size']);
  assert.deepStrictEqual(run({ orderId: 99, size: 1 }), ['modify-protection'], 'unknown order: the change cannot be checked');
  const trailing = { ...stop, type: 5 };
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 9, stopPrice: 21490, trailPrice: 21000 }, positions: long2, orders: [trailing], config })), ['modify-protection']);
  // After a scale-out, orders still sized for 2 would flip a 1-lot once moved to the market.
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 12, limitPrice: 21510 }, positions: long1, orders: [stop, target], config })), ['modify-protection'], 'oversized target: cut it first');
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 9, stopPrice: 21495 }, positions: long1, orders: [stop], config })), ['modify-protection'], 'oversized stop: cut it first');
});

test('ledger: entries and exits anchor on the right net (root for entries, contract for exits)', () => {
  const { pendingState } = require('../../scripts/lib/trading/account-gate');
  const now = new Date();
  const ledger = [{ contractId: CONTRACT, sign: -1, size: 1, netBefore: 1, rootNetBefore: 1, at: now.getTime() }];
  assert.strictEqual(pendingState(ledger, CONTRACT, 1, now, 30000, { exact: true }).projected, 0);
  assert.strictEqual(pendingState(ledger, 'MNQ:2027-03', 0, now, 30000, { exact: true }).projected, 0, 'another month has no pending orders');
});

test('ledger: a marketable limit that filled counts until the account shows it; a resting one does not', () => {
  const now = new Date();
  const sent = { contractId: CONTRACT, sign: 1, size: 1, netBefore: 0, rootNetBefore: 0, at: now.getTime(), orderId: '77' };
  const limit = order({ type: 'limit', limitPrice: 21010 });
  // Filled but not shown yet: a second entry would double it.
  assert.deepStrictEqual(checks(evaluateAccount({ input: limit, ledger: [sent], now, config })), ['position-open']);
  // Still resting: working-orders counts it instead.
  const resting = [{ id: 77, contractId: CONTRACT, side: 0, type: 1, size: 1, limitPrice: 21010 }];
  assert.deepStrictEqual(checks(evaluateAccount({ input: limit, orders: resting, ledger: [sent], now, config })), ['working-orders']);
  // An [exit] limit that filled: a second one would flip the long.
  const exitSent = { contractId: CONTRACT, sign: -1, size: 1, netBefore: 1, rootNetBefore: 1, at: now.getTime(), orderId: '78' };
  const exit = order({ side: 'sell', type: 'limit', limitPrice: 20990, rationale: '[exit] flatten' });
  assert.deepStrictEqual(checks(evaluateAccount({ input: exit, positions: long1, ledger: [exitSent], now, config })), ['exposure']);
});

test('[exit]/[protect] orders may not carry bracket legs', () => {
  const exit = order({ side: 'sell', rationale: '[exit] flatten', stopLossBracket: { ticks: 8, type: 'stop' } });
  assert.deepStrictEqual(checks(evaluateAccount({ input: exit, positions: long1, config })), ['exposure']);
  assert.deepStrictEqual(checks(evaluateAccount({ input: { ...exit, stopLossBracket: undefined }, positions: long1, config })), []);
});

test('micros and minis are one root: an MNQ entry waits while an NQ position is open, and a prop attempt holds one position across the account', () => {
  const nq = [{ contractId: 'NQ', type: 1, size: 1 }];
  assert.ok(checks(evaluateAccount({ input: order(), positions: nq, now: NOW, config })).includes('position-open'));
  const mes = [{ contractId: 'MES', type: 1, size: 2 }];
  assert.ok(!checks(evaluateAccount({ input: order(), positions: mes, now: NOW, config })).includes('prop-one-position'));
  const v = evaluateAccount({ input: order(), positions: mes, now: NOW, config: { ...config, skipChecks: new Set(['prop-one-position']) }, propAttempt: 'topstep_100k' });
  assert.match(v.find(x => x.check === 'prop-one-position').message, /topstep_100k attempt trades one position at a time: MES is open/);
  // An order sent moments ago (not on the account yet) counts too.
  const ledger = [{ contractId: 'MES', sign: 1, size: 1, netBefore: 0, at: NOW.getTime() - 5000 }];
  assert.ok(checks(evaluateAccount({ input: order(), now: NOW, config, ledger, propAttempt: 'topstep_100k' })).includes('prop-one-position'));
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), now: NOW, config, propAttempt: 'topstep_100k' })), []);
});

test('correlated exposure: a second same-direction equity-index position is refused; the other side, or a non-index, is not', () => {
  const mesLong = [{ contractId: 'MES', type: 1, size: 1 }];
  const v = evaluateAccount({ input: order(), positions: mesLong, now: NOW, config });
  assert.deepStrictEqual(checks(v), ['correlated-exposure']);
  assert.match(v[0].message, /MES is already long; equity index futures move together/);
  assert.deepStrictEqual(evaluateAccount({ input: order({ side: 'sell', rationale: 'setup:orb short, stop 1' }), positions: mesLong, now: NOW, config }), []);
  // A larger limit allows it; gold is not an equity index.
  assert.deepStrictEqual(evaluateAccount({ input: order(), positions: mesLong, now: NOW, config: { ...config, maxCorrelatedPositions: 2 } }), []);
  assert.deepStrictEqual(evaluateAccount({ input: order(), positions: [{ contractId: 'MGC', type: 1, size: 1 }], now: NOW, config }), []);
  // Exits are never held by it.
  assert.deepStrictEqual(checks(evaluateAccount({ input: order({ side: 'sell', rationale: '[exit] done' }), positions: [...long1, ...mesLong], now: NOW, config })), []);
});
