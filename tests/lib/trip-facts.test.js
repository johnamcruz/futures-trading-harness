'use strict';

// A closed trade's trip facts (trading/trip-facts.js): the runner's review writes them, the trade feedback reads them.
// A leaf module, so the fail-closed review hook never loads the feedback's information-only code.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../../scripts/lib/trading/trip-facts');

const OPEN = '2021-06-04T14:42:00.000Z';
const CLOSE = '2021-06-04T14:57:30.000Z';
const t = { contractId: 'MNQ', fill: 13660, openedAt: OPEN, closedAt: CLOSE };
const entry = { orderId: 501, contractId: 'MNQ', side: 0, size: 3, price: 13660, creationTimestamp: OPEN };
const fill = (orderId, o = {}) => ({ orderId, contractId: 'MNQ', side: 1, size: 3, price: 13651, creationTimestamp: CLOSE, ...o });
const why = (fills, history, o = {}) => T.exitReasonOf({ t, side: 'long', orderId: '501', fills: [entry, ...fills], history, stopTicks: 40, tick: 0.25, ...o });

test('closing fills: the opposite side\'s, on its contract, from its open to its close; a same-side fill is an add, never a close', () => {
  const stop = { id: 9, type: 4, bracket: { role: 'stop' }, stopPrice: 13650 };
  const target = { id: 10, type: 1, bracket: { role: 'target' } };
  assert.strictEqual(why([fill(9)], [stop, target]), 'stop');
  // A same-side fill (a scale-in by another order) inside the trade: not a close, so the exit stays the stop's.
  assert.strictEqual(why([fill(10, { side: 0, creationTimestamp: '2021-06-04T14:50:00.000Z' }), fill(9)], [stop, target]), 'stop');
  // A closing-side fill before the open or after the close is another trade's.
  assert.strictEqual(why([fill(10, { creationTimestamp: '2021-06-04T14:41:59.000Z' }), fill(9)], [stop, target]), 'stop');
  assert.strictEqual(why([fill(10, { creationTimestamp: '2021-06-04T14:57:31.000Z' }), fill(9)], [stop, target]), 'stop');
  // At the edges it counts.
  assert.strictEqual(why([fill(10, { creationTimestamp: OPEN }), fill(9)], [stop, target]), 'mixed');
  // Another contract's fill: not this trade's.
  assert.strictEqual(why([fill(10, { contractId: 'MES' }), fill(9)], [stop, target]), 'stop');
  // A short closes with buys.
  const short = T.exitReasonOf({ t: { ...t, fill: 13660 }, side: 'short', orderId: '501', fills: [{ ...entry, side: 1 }, fill(9, { side: 0 }), fill(10, { side: 1 })], history: [{ id: 9, type: 4, bracket: { role: 'stop' }, stopPrice: 13670 }, target], stopTicks: 40, tick: 0.25 });
  assert.strictEqual(short, 'stop');
  // No closing fill at all: unknown.
  assert.strictEqual(why([fill(9, { side: 0 })], [stop]), null);
});

test('stop vs trail: within half a tick of the planned stop is the stop; a tick away is a moved stop', () => {
  const at = price => why([fill(9)], [{ id: 9, type: 4, bracket: { role: 'stop' }, stopPrice: price }]);
  assert.strictEqual(at(13650), 'stop');
  assert.strictEqual(at(13650.125), 'stop', 'half a tick: the stop');
  assert.strictEqual(at(13650.25), 'trail', 'one tick: moved');
  assert.strictEqual(at(13649.75), 'trail', 'one tick lower: moved');
});

test('the trip tags read back; gross R is the price R the MFE is measured in', () => {
  const tags = T.tripTags({ side: 'long', size: 3, fill: 13660, exit: 13670, openedAt: OPEN, closedAt: CLOSE, risk: 10, exitReason: 'target' });
  const trip = T.tripOf({ tags });
  assert.strictEqual(T.grossR(trip), 1);
  assert.strictEqual(T.grossR({ ...trip, side: 'short' }), -1);
  assert.strictEqual(T.grossR({ ...trip, risk: null }), null);
  assert.strictEqual(T.grossR({ ...trip, exit: null }), null);
  assert.strictEqual(T.tripOf({ tags: ['result:win'] }), null);
});

test('a leaf: trip-facts requires only the broker interface (the review hook\'s load graph stays small)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'lib', 'trading', 'trip-facts.js'), 'utf8');
  assert.deepStrictEqual([...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]), ['../broker/interface']);
});
