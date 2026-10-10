'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { recordEntryOrder, graceFor, createOrderTracker } = require('../../scripts/lib/trading/order-tracker');
const markers = require('../../scripts/lib/trading/order-markers');
const { tmpDir } = require('../helpers');

const NOW = new Date('2026-10-07T14:30:00Z');
const ENTRY = { accountId: 7, contractId: 'MNQ', side: 'buy', size: 1, type: 'market', rationale: 'setup:orb long, stop 21480', customTag: 'orb-1' };
const reply = (text, isError) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], isError } });
const tracker = (env, extra = {}) => createOrderTracker({ env, graceMs: markers.GRACE_MS, searchOrders: async () => [], ...extra });

test('grace: 2 min, never under a lane wait + 30 s; only a test run may shorten it', () => {
  assert.strictEqual(graceFor({}, 30000), markers.GRACE_MS);
  assert.strictEqual(graceFor({}, 200000), 230000);
  assert.strictEqual(graceFor({ FTH_UNKNOWN_ORDER_GRACE_MS: '1' }, 300), markers.GRACE_MS, 'a live run ignores it');
  assert.strictEqual(graceFor({ FTH_UNKNOWN_ORDER_GRACE_MS: '1', NODE_ENV: 'test' }, 300), 30300);
  assert.strictEqual(graceFor({ FTH_UNKNOWN_ORDER_GRACE_MS: '1', NODE_ENV: 'test', FTH_AUTONOMOUS: '1' }, 300), markers.GRACE_MS, 'an autonomous run ignores it');
});

test('entry records: written once per order, with the time the order was sent and its planned stop', () => {
  const env = { FTH_HOME: tmpDir() };
  const sentAt = Date.parse('2026-10-07T14:20:00Z');
  recordEntryOrder(env, 41, { ...ENTRY, rationale: 'setup:orb long, buy stop 21510 above the high, stop 21490' }, sentAt);
  recordEntryOrder(env, 41, ENTRY, NOW.getTime());
  const list = JSON.parse(fs.readFileSync(path.join(env.FTH_HOME, 'entry-orders.json'), 'utf8'));
  assert.deepStrictEqual(list.map(e => [e.orderId, e.setup, e.stopPrice, e.at]), [[41, 'orb', 21490, '2026-10-07T14:20:00.000Z']]);
});

test('beforeSend: tags and records the order; an entry with no account is refused', () => {
  const env = { FTH_HOME: tmpDir() };
  const t = tracker(env);
  const sent = t.beforeSend({ id: 1, args: ENTRY, risk: false, observed: { observedNet: 0, observedRootNet: 0 }, now: NOW });
  assert.strictEqual(sent.args.customTag, 'orb-1');
  assert.deepStrictEqual(markers.readMarkers(env).map(m => m.tag), ['orb-1']);
  assert.match(t.beforeSend({ id: 2, args: { ...ENTRY, customTag: 'orb-1' }, risk: false, now: NOW }).refuse, /in use/, 'its own call still carries the tag');
  assert.match(t.beforeSend({ id: 3, args: { ...ENTRY, accountId: undefined }, risk: false, now: NOW }).refuse, /needs an accountId/);
});

test('onReply: a result or a sure refusal clears the record; an error that may hide a live order keeps it', () => {
  for (const [msg, kept] of [
    [reply('{"orderId":5,"success":true}'), false],
    [reply('Blocked by risk guardrail: trading disabled', true), false],
    [reply('{"success":false,"errorCode":2}', true), false],
    [reply('HTTP 502 Bad Gateway', true), true],
    [{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'server error' } }, true],
  ]) {
    const env = { FTH_HOME: tmpDir() };
    const t = tracker(env);
    t.beforeSend({ id: 1, args: ENTRY, risk: false, now: NOW });
    t.onReply(1, msg);
    assert.strictEqual(markers.readMarkers(env).length, kept ? 1 : 0, JSON.stringify(msg));
  }
});

test('settle: an own call found placed is handed back (a late reply must not count it again) and recorded for the runner', async () => {
  const env = { FTH_HOME: tmpDir() };
  const t = tracker(env, { searchOrders: async () => [{ id: 41, customTag: 'orb-1', status: 2 }] });
  t.beforeSend({ id: 9, args: ENTRY, risk: false, observed: { observedNet: 0, observedRootNet: 0 }, now: NOW });
  const r = await t.settle(7, new Date(NOW.getTime() + 40000));
  assert.deepStrictEqual([r.settledIds, r.unknown, r.ledger.map(e => e.orderId)], [[9], [], ['41']]);
  const list = JSON.parse(fs.readFileSync(path.join(env.FTH_HOME, 'entry-orders.json'), 'utf8'));
  assert.deepStrictEqual(list.map(e => [e.orderId, e.at]), [[41, NOW.toISOString()]], 'at the time it was sent, so the runner matches it to the fill');
  // Its late reply then changes nothing: the call is no longer tracked.
  t.onReply(9, reply('{"orderId":41,"success":true}'));
  assert.deepStrictEqual(markers.readMarkers(env), []);
});

test('settle: an order this gateway still awaits is never gone', async () => {
  const env = { FTH_HOME: tmpDir() };
  const t = tracker(env);
  t.beforeSend({ id: 9, args: ENTRY, risk: false, now: NOW });
  const later = new Date(NOW.getTime() + 10 * 60000);
  assert.strictEqual((await t.settle(7, later, { isWaiting: id => id === 9 })).unknown.length, 1);
  assert.strictEqual((await t.settle(7, later)).unknown.length, 0, 'no longer awaited: gone after the grace period');
});

test('ledgers and messages: what the gate counts for cancels and exits, and how it says so', () => {
  const t = tracker({ FTH_HOME: tmpDir() });
  const base = { accountId: 7, contractId: 'MNQ', size: 1, observedNet: 1, observedRootNet: 1, sentAt: new Date(NOW.getTime() - 5000).toISOString() };
  const exitMarket = { ...base, tag: 'x', side: 'sell', type: 'market', risk: true };
  const entryLimit = { ...base, tag: 'e', side: 'buy', type: 'limit', risk: false, observedNet: 0, observedRootNet: 0 };
  const targetLimit = { ...base, tag: 't', side: 'sell', type: 'limit', risk: true };
  const unknown = [exitMarket, entryLimit, targetLimit];
  assert.deepStrictEqual(t.cancelLedger(unknown, NOW).map(e => e.sign), [1], 'only entries, of any type');
  assert.deepStrictEqual(t.exitLedger(unknown, NOW).map(e => e.sign), [-1], 'only market orders');
  assert.deepStrictEqual(t.exitOrders(unknown, NOW).map(o => o.id), ['pending:e', 'pending:t']);
  const v = [{ check: 'exposure', message: 'no position.' }, { check: 'other', message: 'm' }];
  t.annotateExposure(v, unknown, NOW);
  assert.match(v[0].message, /counts 3 orders of unknown outcome \(customTag x, e, t\).*close_position flattens now/);
  assert.strictEqual(v[1].message, 'm');
  assert.deepStrictEqual(Object.keys(t.pendingViolation(unknown, NOW, true)), ['check', 'message']);
});
