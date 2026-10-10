'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const m = require('../../scripts/lib/trading/order-markers');
const { pendingState } = require('../../scripts/lib/trading/account-gate');
const { tmpDir } = require('../helpers');

const NOW = new Date('2026-10-07T14:30:00Z');
const marker = (extra = {}) => ({ tag: 'fth-0001', accountId: 7, contractId: 'MNQ', side: 'sell', size: 1, risk: true, observedNet: 1, observedRootNet: 1, sentAt: new Date(NOW.getTime() - 10000).toISOString(), ...extra });

test('tags: the client\'s own customTag is kept (any string up to 100 chars), else a fresh one', () => {
  assert.strictEqual(m.tagFor({ customTag: 'exit-1' }), 'exit-1');
  assert.strictEqual(m.tagFor({ customTag: 'orb #2 / long' }), 'orb #2 / long');
  assert.match(m.tagFor({}), /^fth-[0-9a-f]{16}$/);
  assert.match(m.tagFor({ customTag: '' }), /^fth-/);
  assert.match(m.tagFor({ customTag: 'x'.repeat(101) }), /^fth-/);
  assert.notStrictEqual(m.newTag(), m.newTag());
});

test('markers: written, read and removed per file; an unreadable one is kept as unknown for every account', () => {
  const env = { FTH_HOME: tmpDir() };
  assert.deepStrictEqual(m.readMarkers(env), []);
  m.writeMarker(env, marker());
  m.writeMarker(env, marker({ tag: 'other', accountId: 8 }));
  // The same tag on two accounts (unique per account only) and tags differing in case are separate records.
  m.writeMarker(env, marker({ accountId: 8 }));
  m.writeMarker(env, marker({ tag: 'FTH-0001' }));
  assert.deepStrictEqual(m.readMarkers(env).map(x => `${x.accountId}:${x.tag}`).sort(), ['7:FTH-0001', '7:fth-0001', '8:fth-0001', '8:other']);
  assert.deepStrictEqual(m.markersFor(m.readMarkers(env), 7).map(x => x.tag).sort(), ['FTH-0001', 'fth-0001']);
  assert.ok(m.markerExists(env, 8, 'other') && !m.markerExists(env, 7, 'other'));
  m.removeMarker(env, { accountId: 8, tag: 'other' });
  m.removeMarker(env, { accountId: 8, tag: 'other' }); // already gone: fine
  assert.ok(m.markerExists(env, 8, 'fth-0001'), 'removing one account\'s record leaves the other\'s');
  fs.writeFileSync(path.join(m.markerDir(env), 'broken.json'), '{not json');
  const read = m.readMarkers(env);
  assert.ok(read.some(x => x.unreadable && x.file.endsWith('broken.json')));
  assert.deepStrictEqual(m.markersFor(read, 99).map(x => x.unreadable), [true], 'an unreadable marker may be any account\'s');
  m.removeMarker(env, read.find(x => x.unreadable));
  assert.ok(!m.readMarkers(env).some(x => x.unreadable));
});

test('resolve: placed (filled or resting) or refused by the listed order\'s status, gone after the grace period, else unknown', () => {
  const fresh = marker({ tag: 'a' });
  const old = marker({ tag: 'b', sentAt: new Date(NOW.getTime() - m.GRACE_MS).toISOString() });
  const orders = [{ id: 5, customTag: 'c', status: 2 }, { id: 6, customTag: 'd', status: 1 }, { id: 7, customTag: 'e', status: 5 }, { id: 8, customTag: 'f' }, { id: 9, customTag: 'g', status: 3 }];
  const ms = [fresh, old, marker({ tag: 'c' }), marker({ tag: 'd', type: 'limit' }), marker({ tag: 'e' }), marker({ tag: 'f' }), marker({ tag: 'g' }), { file: 'x', unreadable: true }];
  const r = m.resolveMarkers(ms, orders, NOW);
  assert.deepStrictEqual(r.placed.map(p => [p.marker.tag, p.order.id]), [['c', 5], ['d', 6], ['f', 8]]);
  assert.deepStrictEqual(r.gone.map(g => g.tag), ['b', 'e', 'g'], 'rejected and cancelled orders were never working');
  assert.deepStrictEqual(r.unknown.map(u => u.tag || u.file), ['a', 'x']);
  // No order list (the lookup failed): nothing is settled.
  assert.deepStrictEqual(m.resolveMarkers([fresh, old], null, NOW).unknown.map(u => u.tag), ['a', 'b']);
});

test('ledger: an unknown market exit counts as if it filled; limits and stops count as resting orders', () => {
  const unknown = [marker(), { file: 'x', unreadable: true }, marker({ tag: 'n', observedNet: null }), marker({ tag: 'l', type: 'limit' }), marker({ tag: 's', type: 'stop', side: 'buy', size: 2 })];
  const ledger = m.markerLedger(unknown, NOW);
  assert.strictEqual(ledger.length, 1);
  assert.deepStrictEqual(pendingState(ledger, 'MNQ', 1, NOW, undefined, { exact: true }), { projected: 0, pending: true });
  assert.deepStrictEqual(m.markerOrders(unknown, NOW), [
    { id: 'pending:l', contractId: 'MNQ', type: 1, side: 1, size: 1 },
    { id: 'pending:s', contractId: 'MNQ', type: 4, side: 0, size: 2 },
  ]);
  // After the grace period the broker's account is the truth: nothing is projected.
  const later = new Date(NOW.getTime() + m.GRACE_MS);
  assert.deepStrictEqual([m.markerLedger(unknown, later), m.markerOrders(unknown, later)], [[], []]);
});

test('resolve: a live order with the tag wins over a dead one; a dead one older than the send never settles the marker', () => {
  const fresh = marker({ tag: 'r' });
  const at = d => new Date(NOW.getTime() + d).toISOString();
  const sent = Date.parse(fresh.sentAt);
  const oldDead = { id: 1, customTag: 'r', status: 3, creationTimestamp: new Date(sent - 30000).toISOString() };
  const newLive = { id: 2, customTag: 'r', status: 1, creationTimestamp: at(0) };
  assert.deepStrictEqual(m.resolveMarkers([fresh], [newLive, oldDead], NOW).placed.map(p => p.order.id), [2]);
  assert.deepStrictEqual(m.resolveMarkers([fresh], [oldDead, newLive], NOW).placed.map(p => p.order.id), [2], 'whatever the list order');
  assert.deepStrictEqual(m.resolveMarkers([fresh], [oldDead], NOW).unknown.map(u => u.tag), ['r'], 'an older cancelled order with the tag is not this one');
  const newDead = { id: 3, customTag: 'r', status: 5, creationTimestamp: at(0) };
  assert.deepStrictEqual(m.resolveMarkers([fresh], [oldDead, newDead], NOW).gone.map(g => g.tag), ['r']);
});

test('resolve: an order still awaited is never gone; an older order reusing the tag doesn\'t settle it', () => {
  const old = marker({ tag: 'a', sentAt: new Date(NOW.getTime() - m.GRACE_MS).toISOString() });
  assert.deepStrictEqual(m.resolveMarkers([old], [], NOW, m.GRACE_MS, { inFlight: x => x.tag === 'a' }).unknown.map(u => u.tag), ['a']);
  const fresh = marker({ tag: 'r' });
  const before = { id: 1, customTag: 'r', status: 2, creationTimestamp: new Date(NOW.getTime() - 3600000).toISOString() };
  assert.deepStrictEqual(m.resolveMarkers([fresh], [before], NOW).unknown.map(u => u.tag), ['r']);
  const after = { ...before, id: 2, creationTimestamp: NOW.toISOString() };
  assert.deepStrictEqual(m.resolveMarkers([fresh], [before, after], NOW).placed.map(p => p.order.id), [2]);
});

test('refusals: only a guardrail, the translator, or the broker\'s own refusal settles an order as not placed', () => {
  assert.ok(m.definitelyRefused('Blocked by risk guardrail: trading disabled'));
  assert.ok(m.definitelyRefused('contract-translator: not sent: no ES contract found at this broker'));
  assert.ok(!m.definitelyRefused('contract-translator: could not name the contracts in this result (x)'), 'that call reached the server');
  assert.ok(!m.definitelyRefused('contract: something the broker server said'));
  assert.ok(m.definitelyRefused('{"orderId":null,"success":false,"errorCode":2,"errorName":"OrderRejected"}'));
  for (const t of ['{"success":false,"errorCode":6}', '{"success":false,"errorCode":7}', '{"success":false,"errorMessage":"Request timed out"}',
    'HTTP 500 Internal Server Error', 'Service Unavailable', 'EPIPE', 'The operation was aborted', '']) {
    assert.ok(!m.definitelyRefused(t), t);
  }
});

test('ledger: for cancel-protection every unknown entry counts as filled, a limit too; a settled order counts from its send time', () => {
  const limitEntry = marker({ tag: 'le', side: 'buy', type: 'limit', observedNet: 0, observedRootNet: 0 });
  assert.deepStrictEqual(m.markerLedger([limitEntry], NOW), []);
  const [e] = m.markerLedger([limitEntry], NOW, m.GRACE_MS, { anyType: true });
  assert.deepStrictEqual([e.sign, e.size, e.netBefore, e.sentAt], [1, 1, 0, Date.parse(limitEntry.sentAt)]);
  const placed = m.placedLedger([{ marker: limitEntry, order: { id: 41 } }, { marker: marker({ sentAt: new Date(NOW.getTime() - m.GRACE_MS).toISOString() }), order: { id: 42 } }], NOW);
  assert.deepStrictEqual(placed.map(x => x.orderId), ['41'], 'one sent before the grace period already shows on the account');
});

test('settleMarkers: looks the account\'s records up once, removes the settled ones, keeps everything on a failed lookup', async () => {
  const env = { FTH_HOME: tmpDir() };
  m.writeMarker(env, marker({ tag: 'p' }));
  m.writeMarker(env, marker({ tag: 'g', sentAt: new Date(NOW.getTime() - m.GRACE_MS).toISOString() }));
  m.writeMarker(env, marker({ tag: 'u' }));
  m.writeMarker(env, marker({ tag: 'other', accountId: 8 }));
  const failed = await m.settleMarkers({ env, accountId: 7, now: NOW, searchOrders: async () => { throw new Error('down'); }, onError: () => {} });
  assert.deepStrictEqual([failed.lookupFailed, failed.unknown.length], [true, 3]);
  const calls = [];
  const r = await m.settleMarkers({ env, accountId: '7', now: NOW, searchOrders: async a => { calls.push(a); return [{ id: 5, customTag: 'p', status: 1 }]; } });
  assert.deepStrictEqual(calls, [{ accountId: 7, startTimestamp: new Date(NOW.getTime() - m.GRACE_MS - 60000).toISOString() }]);
  assert.deepStrictEqual([r.placed.map(p => p.marker.tag), r.gone.map(g => g.tag), r.unknown.map(u => u.tag)], [['p'], ['g'], ['u']]);
  assert.deepStrictEqual(m.readMarkers(env).map(x => x.tag).sort(), ['other', 'u']);
  assert.deepStrictEqual(await m.settleMarkers({ env: { FTH_HOME: tmpDir() }, accountId: 7, now: NOW, searchOrders: async () => assert.fail('no lookup without records') }), { placed: [], gone: [], unknown: [], lookupFailed: false });
});

test('prepareSend: writes the record and tags the order; a tag in use is refused for an entry and replaced for an exit', () => {
  const env = { FTH_HOME: tmpDir() };
  const args = { accountId: 7, contractId: 'MNQ', side: 'buy', size: 1, type: 'market', rationale: 'setup:orb long', customTag: 'orb-1' };
  const first = m.prepareSend({ env, args, risk: false, observed: { observedNet: 0, observedRootNet: 0 }, now: NOW });
  assert.deepStrictEqual([first.tag, first.args, first.refuse], ['orb-1', args, undefined]);
  assert.deepStrictEqual(m.readMarkers(env).map(x => [x.tag, x.observedNet, x.risk]), [['orb-1', 0, false]]);
  assert.match(m.prepareSend({ env, args, risk: false, now: NOW }).refuse, /customTag "orb-1" is in use/);
  const exit = m.prepareSend({ env, args: { ...args, side: 'sell', rationale: '[exit] flatten' }, risk: true, now: NOW });
  assert.match(exit.tag, /^fth-/);
  assert.strictEqual(exit.args.customTag, exit.tag);
  assert.match(m.prepareSend({ env, args: { ...args, customTag: 'busy' }, risk: false, inUse: t => t === 'busy', now: NOW }).refuse, /in use/);
  // A record that can't be written: an entry is refused, an exit still goes.
  const blocked = { FTH_HOME: path.join(tmpDir(), 'file') };
  fs.writeFileSync(blocked.FTH_HOME, '');
  assert.match(m.prepareSend({ env: blocked, args: { ...args, customTag: undefined }, risk: false, now: NOW }).refuse, /could not record the order/);
  assert.ok(m.prepareSend({ env: blocked, args: { ...args, customTag: undefined }, risk: true, now: NOW }).error);
});

test('message: names each unknown order, what settles it, and what still goes through', () => {
  const text = m.pendingMessage([marker(), { file: '/h/pending-orders/x.json', unreadable: true }], NOW);
  assert.match(text, /outcome of 2 orders is unknown: sell 1 MNQ sent 10 s ago \(customTag fth-0001\); an unreadable record \/h\/pending-orders\/x\.json/);
  assert.match(text, /until the order shows in the broker's orders, or 2 min pass without it\. Exits, stop moves and cancels are still checked as usual.*close_position always goes/);
  assert.match(m.pendingMessage([marker()], NOW, m.GRACE_MS, { lookupFailed: true }), /until the broker's orders \(search_orders\) can be read again/);
});
