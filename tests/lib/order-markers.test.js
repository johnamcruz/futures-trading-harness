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
  assert.deepStrictEqual(r.placed.map(p => [p.marker.tag, p.order.id, p.filled]), [['c', 5, true], ['d', 6, false], ['f', 8, true]]);
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
  assert.deepStrictEqual(m.markerOrders(unknown), [
    { id: 'pending:l', contractId: 'MNQ', type: 1, side: 1, size: 1 },
    { id: 'pending:s', contractId: 'MNQ', type: 4, side: 0, size: 2 },
  ]);
});

test('message: names each unknown order, what settles it, and what still goes through', () => {
  const text = m.pendingMessage([marker(), { file: '/h/pending-orders/x.json', unreadable: true }], NOW);
  assert.match(text, /outcome of 2 orders is unknown: sell 1 MNQ sent 10 s ago \(customTag fth-0001\); an unreadable record \/h\/pending-orders\/x\.json/);
  assert.match(text, /until the order shows in the broker's orders, or 2 min pass without it\. Exits, stop moves and cancels still go through/);
  assert.match(m.pendingMessage([marker()], NOW, m.GRACE_MS, { lookupFailed: true }), /until the broker's orders \(search_orders\) can be read again/);
});
