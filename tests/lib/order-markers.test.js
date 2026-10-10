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

test('tags: the client\'s own customTag is kept when usable, else a fresh one', () => {
  assert.strictEqual(m.tagFor({ customTag: 'exit-1' }), 'exit-1');
  assert.match(m.tagFor({}), /^fth-[0-9a-f]{16}$/);
  assert.match(m.tagFor({ customTag: 'has space' }), /^fth-/);
  assert.match(m.tagFor({ customTag: 'x'.repeat(101) }), /^fth-/);
  assert.notStrictEqual(m.newTag(), m.newTag());
});

test('markers: written, read and removed per file; an unreadable one is kept as unknown for every account', () => {
  const env = { FTH_HOME: tmpDir() };
  assert.deepStrictEqual(m.readMarkers(env), []);
  m.writeMarker(env, marker());
  m.writeMarker(env, marker({ tag: 'other', accountId: 8 }));
  assert.deepStrictEqual(m.readMarkers(env).map(x => x.tag).sort(), ['fth-0001', 'other']);
  assert.deepStrictEqual(m.markersFor(m.readMarkers(env), 7).map(x => x.tag), ['fth-0001']);
  m.removeMarker(env, 'other');
  m.removeMarker(env, 'other'); // already gone: fine
  fs.writeFileSync(path.join(m.markerDir(env), 'broken.json'), '{not json');
  const read = m.readMarkers(env);
  assert.ok(read.some(x => x.tag === 'broken' && x.unreadable));
  assert.deepStrictEqual(m.markersFor(read, 99).map(x => x.tag), ['broken'], 'an unreadable marker may be any account\'s');
});

test('resolve: placed when an order carries the tag, gone after the grace period, else unknown', () => {
  const fresh = marker({ tag: 'a' });
  const old = marker({ tag: 'b', sentAt: new Date(NOW.getTime() - m.GRACE_MS).toISOString() });
  const shown = marker({ tag: 'c', sentAt: old.sentAt });
  const r = m.resolveMarkers([fresh, old, shown, { tag: 'x', unreadable: true }], [{ id: 5, customTag: 'c' }, { id: 6 }], NOW);
  assert.deepStrictEqual(r.placed.map(p => [p.marker.tag, p.order.id]), [['c', 5]]);
  assert.deepStrictEqual(r.gone.map(g => g.tag), ['b']);
  assert.deepStrictEqual(r.unknown.map(u => u.tag), ['a', 'x']);
  // No order list (the lookup failed): nothing is settled as placed.
  assert.deepStrictEqual(m.resolveMarkers([fresh], null, NOW).unknown.map(u => u.tag), ['a']);
});

test('ledger: an unknown exit counts as if it filled, so a second exit can\'t flip the position', () => {
  const ledger = m.markerLedger([marker(), { tag: 'x', unreadable: true }, marker({ tag: 'n', observedNet: null })], NOW);
  assert.strictEqual(ledger.length, 1);
  assert.deepStrictEqual(pendingState(ledger, 'MNQ', 1, NOW, undefined, { exact: true }), { projected: 0, pending: true });
});

test('message: names each unknown order and what still goes through', () => {
  const text = m.pendingMessage([marker(), { tag: 'x', file: '/h/pending-orders/x.json', unreadable: true }], NOW);
  assert.match(text, /outcome of 2 orders is unknown: sell 1 MNQ sent 10 s ago \(customTag fth-0001\); an unreadable record \/h\/pending-orders\/x\.json/);
  assert.match(text, /Exits, stop moves and cancels still go through/);
});
