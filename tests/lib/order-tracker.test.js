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
  // Its own target (the takeProfitBracket), for a trail past it (exit mode target_then_trail); none without one.
  recordEntryOrder(env, 42, { ...ENTRY, takeProfitBracket: { ticks: 231, type: 'limit' } }, sentAt);
  const again = JSON.parse(fs.readFileSync(path.join(env.FTH_HOME, 'entry-orders.json'), 'utf8'));
  assert.deepStrictEqual(again.map(e => e.targetTicks), [undefined, 231]);
});

test('beforeSend: tags and records the order; with no account an entry is refused and an exit goes untracked', () => {
  const env = { FTH_HOME: tmpDir() };
  const t = tracker(env);
  const sent = t.beforeSend({ id: 1, args: ENTRY, risk: false, observed: { observedNet: 0, observedRootNet: 0 }, now: NOW });
  assert.strictEqual(sent.args.customTag, 'orb-1');
  assert.deepStrictEqual(markers.readMarkers(env).map(m => m.tag), ['orb-1']);
  const reused = t.beforeSend({ id: 2, args: { ...ENTRY, customTag: 'orb-1' }, risk: false, now: NOW }).refuse;
  assert.deepStrictEqual([reused.check, /in use/.test(reused.message)], ['order-pending', true], 'its own call still carries the tag');
  assert.strictEqual(t.beforeSend({ id: 3, args: { ...ENTRY, accountId: undefined }, risk: false, now: NOW }).refuse.check, 'account-required');
  const exit = { ...ENTRY, accountId: undefined, side: 'sell', rationale: '[exit] flatten', customTag: undefined };
  assert.deepStrictEqual(t.beforeSend({ id: 4, args: exit, risk: true, now: NOW }), { args: exit });
  assert.strictEqual(markers.readMarkers(env).length, 1, 'no record for an order no account can settle');
});

test('tagRequest: only a place_order tools/call is tagged; anything else passes as it is', () => {
  const env = { FTH_HOME: tmpDir() };
  const t = tracker(env);
  const call = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  for (const msg of [call('cancel_order', { accountId: 7, orderId: 9 }), { jsonrpc: '2.0', id: 1, method: 'tools/list' }, [call('place_order', ENTRY)], null]) {
    assert.strictEqual(t.tagRequest(msg, { now: NOW }).msg, msg);
  }
  const out = t.tagRequest(call('mcp__broker__place_order', { ...ENTRY, customTag: undefined }), { now: NOW }).msg;
  assert.match(out.params.arguments.customTag, /^fth-/);
  assert.strictEqual(markers.readMarkers(env).length, 1);
  assert.strictEqual(t.tagRequest(call('place_order', { ...ENTRY, accountId: '' }, 2), { now: NOW }).refuse.check, 'account-required');
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

test('tracker: its records carry the contract by the gate\'s name (canon), whatever the call named it', () => {
  const env = { FTH_HOME: tmpDir() };
  const t = tracker(env, { canon: a => ({ ...a, contractId: a.contractId === 'MNQ:2026-12' ? 'MNQ' : a.contractId }) });
  const msg = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'place_order', arguments: { accountId: 7, contractId: 'MNQ:2026-12', side: 'sell', type: 'stop', size: 1, stopPrice: 21490, rationale: '[protect] stop' } } };
  const out = t.tagRequest(msg, { now: new Date('2026-10-07T14:00:00Z') });
  assert.strictEqual(out.msg.params.arguments.contractId, 'MNQ:2026-12', 'sent as the client named it');
  assert.deepStrictEqual(markers.readMarkers(env).map(x => x.contractId), ['MNQ']);
});

test('a record written under a bare root (no front month recorded yet) is named by its month once the order has gone out: on an error reply and when the reply is overdue', () => {
  const { canonicalArgs } = require('../../scripts/lib/trading/mcp-gateway');
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'x.js'] } } }));
  const file = path.join(home, 'contracts-sim.json');
  const ids = { 'sim-Z6': { root: 'MNQ', month: '2026-12' }, 'sim-H7': { root: 'MNQ', month: '2027-03' } };
  const env = { FTH_HOME: home, NODE_ENV: 'test', FTH_TEST_NOW: '2026-10-07T14:30:00Z' };
  const now = new Date('2026-10-07T14:30:00Z');
  const tracker = createOrderTracker({ env, graceMs: 120000, searchOrders: async () => [], canon: a => canonicalArgs(a, env) });
  const place = (id, rationale) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'place_order', arguments: { accountId: 1, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale } } });
  const kept = () => markers.readMarkers(env).map(m => m.contractId).sort();
  for (const [id, settle] of [[1, () => tracker.onReply(1, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'HTTP 504' }], isError: true } })], [2, () => tracker.onOverdue(2)]]) {
    fs.writeFileSync(file, JSON.stringify({ ids, front: { MNQ: { id: 'sim-Z6', month: '2026-12', day: '2026-10-06' } } })); // yesterday's
    assert.ok(!tracker.tagRequest(place(id, '[exit] flatten'), { now }).refuse);
    assert.ok(kept().includes('MNQ'), 'written before the translator looked today\'s front month up');
    fs.writeFileSync(file, JSON.stringify({ ids, front: { MNQ: { id: 'sim-H7', month: '2027-03', day: '2026-10-07' } } })); // looked up to send it
    settle();
    assert.ok(!kept().includes('MNQ'), `request ${id}: renamed`);
  }
  assert.deepStrictEqual(kept(), ['MNQ:2027-03', 'MNQ:2027-03']);
});

test('a record written under a bare root before 18:00 ET is never named after 18:00 by the next trading day\'s front month: the naming is the one the record was written with', () => {
  const { canonicalArgs } = require('../../scripts/lib/trading/mcp-gateway');
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'x.js'] } } }));
  const file = path.join(home, 'contracts-sim.json');
  const ids = { 'sim-Z6': { root: 'MNQ', month: '2026-12' }, 'sim-H7': { root: 'MNQ', month: '2027-03' } };
  // 17:59:50 ET: no front month recorded for 2026-10-07 (yesterday's only), so the record keeps the root.
  fs.writeFileSync(file, JSON.stringify({ ids, front: { MNQ: { id: 'sim-Z6', month: '2026-12', day: '2026-10-06' } } }));
  const env = { FTH_HOME: home, NODE_ENV: 'test', FTH_TEST_NOW: '2026-10-07T21:59:50Z' };
  const tracker = createOrderTracker({ env, graceMs: 120000, searchOrders: async () => [], canon: a => canonicalArgs(a, env) });
  const place = { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'place_order', arguments: { accountId: 1, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: '[exit] flatten' } } };
  assert.ok(!tracker.tagRequest(place, { now: new Date('2026-10-07T21:59:50Z') }).refuse);
  assert.deepStrictEqual(markers.readMarkers(env).map(m => m.contractId), ['MNQ']);
  // 18:00:21 ET: March recorded for 2026-10-08. The reply is overdue: the record stays as written, never March.
  env.FTH_TEST_NOW = '2026-10-07T22:00:21Z';
  fs.writeFileSync(file, JSON.stringify({ ids, front: { MNQ: { id: 'sim-H7', month: '2027-03', day: '2026-10-08' } } }));
  tracker.onOverdue(5);
  assert.deepStrictEqual(markers.readMarkers(env).map(m => m.contractId), ['MNQ']);
});

test('a composed entry\'s stamp: written before it goes, keyed by account and tag; cleared by a settled reply, used once by settle, and cleared on any other entry sent under that tag', async () => {
  const LR = require('../../scripts/lib/trading/lifecycle-runner');
  const stamp = { record: 'r1', expiresAt: '2026-10-07T14:33:00.000Z', entry: 21540.25, side: 'long' };
  const TL = { ...ENTRY, type: 'limit', rationale: 'setup:trade_lifecycle long ...', customTag: 'tl-1' };
  const key = LR.pendingKey(7, 'tl-1');
  // A settled reply: the gateway stamps from its own check, so the pending stamp goes.
  let env = { FTH_HOME: tmpDir() };
  let t = tracker(env);
  t.beforeSend({ id: 1, args: TL, risk: false, observed: { composed: stamp }, now: NOW });
  assert.deepStrictEqual(LR.pendingStamp(env, key), stamp);
  assert.strictEqual(LR.pendingStamp(env, LR.pendingKey(8, 'tl-1')), null, 'another account');
  t.onReply(1, reply('{"orderId":5,"success":true}'));
  assert.strictEqual(LR.pendingStamp(env, key), null);
  // An error reply keeps it; settle finds the order placed, stamps it once and deletes it.
  env = { FTH_HOME: tmpDir() };
  t = tracker(env, { searchOrders: async () => [{ id: 41, customTag: 'tl-1', status: 1 }] });
  t.beforeSend({ id: 2, args: TL, risk: false, observed: { composed: stamp }, now: NOW });
  t.onReply(2, reply('HTTP 502 Bad Gateway', true));
  assert.deepStrictEqual(LR.pendingStamp(env, key), stamp);
  await t.settle(7, new Date(NOW.getTime() + 40000));
  const list = JSON.parse(fs.readFileSync(path.join(env.FTH_HOME, 'entry-orders.json'), 'utf8'));
  assert.deepStrictEqual(list.map(e => [e.orderId, e.composed]), [[41, stamp]]);
  assert.strictEqual(LR.pendingStamp(env, key), null, 'used: deleted');
  // An entry with no composed check sent under a tag with a stamp left on it: the stamp goes before it is sent.
  env = { FTH_HOME: tmpDir() };
  LR.writePendingStamp(env, key, stamp);
  tracker(env).beforeSend({ id: 3, args: { ...ENTRY, customTag: 'tl-1' }, risk: false, observed: { observedNet: 0 }, now: NOW });
  assert.strictEqual(LR.pendingStamp(env, key), null);
});
