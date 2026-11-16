'use strict';

// The resting stop the runner confirmed (scripts/lib/trading/resting-stop.js): recorded per stop order from the broker's
// own read, and the hook's [modify-stop] tighten-only check against it (local state only; the gateway stays the
// authority on the broker's working order).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const RS = require('../../scripts/lib/trading/resting-stop');
const { tmpDir } = require('../helpers');

const rec = (over = {}) => ({ contractId: 'MNQ', sign: 1, stopOrderId: 9, restingStop: 21500.5, at: '2026-10-07T14:30:00.000Z', ...over });

test('recordStop / readStop: one record per stop order, the newest kept; a bad record is not written; a corrupt file reads as none', () => {
  const home = tmpDir();
  assert.strictEqual(RS.readStop(home, 9), null, 'no file: none');
  RS.recordStop(home, rec());
  RS.recordStop(home, rec({ restingStop: 21505 }));
  RS.recordStop(home, rec({ stopOrderId: 12, sign: -1, restingStop: 21600 }));
  assert.strictEqual(RS.readStop(home, 9).restingStop, 21505, 'the newest for its order');
  assert.strictEqual(RS.readStop(home, '12').sign, -1, 'ids compared as strings');
  for (const bad of [rec({ restingStop: NaN }), rec({ sign: 0 }), rec({ stopOrderId: null }), rec({ restingStop: -1 }), rec({ at: 'never' })]) assert.throws(() => RS.recordStop(home, bad), /resting stop/);
  fs.writeFileSync(path.join(home, RS.FILE), '{ not json');
  assert.strictEqual(RS.readStop(home, 9), null);
  assert.strictEqual(RS.readStop(null, 9), null);
  // Bounded: a new trading day's record drops the earlier days'.
  const h2 = tmpDir();
  for (let i = 0; i < 5; i += 1) RS.recordStop(h2, rec({ stopOrderId: i }));
  RS.recordStop(h2, rec({ stopOrderId: 40, at: '2026-10-08T14:30:00.000Z' }));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(h2, RS.FILE), 'utf8')).length, 1);
  assert.strictEqual(RS.readStop(h2, 0), null);
});

test('modifyStopRefusal: a stop looser than the confirmed resting one is refused; equal (a no-op) and tighter pass; no record passes (the gateway judges)', () => {
  const home = tmpDir();
  RS.recordStop(home, rec());
  RS.recordStop(home, rec({ stopOrderId: 12, sign: -1, restingStop: 21600 }));
  const NOW = new Date('2026-10-07T14:35:00.000Z');
  const why = input => RS.modifyStopRefusal({ home, input, now: NOW });
  assert.match(why({ orderId: 9, stopPrice: 21500.25 }), /looser than the resting stop 21500\.5/);
  assert.strictEqual(why({ orderId: 9, stopPrice: 21500.5 }), null, 'equal: a no-op, allowed');
  assert.strictEqual(why({ orderId: 9, stopPrice: 21510 }), null, 'tighter');
  assert.strictEqual(why({ orderId: 9, stopPrice: '21510' }), null, 'a numeric string');
  assert.match(why({ orderId: 12, stopPrice: 21600.25 }), /looser/, 'a short: up is looser');
  assert.strictEqual(why({ orderId: 12, stopPrice: 21590 }), null);
  assert.match(why({ orderId: 9, trailPrice: 21400 }), /looser/, 'every stop price field');
  assert.match(why({ orderId: 9, stopPrice: 'abc' }), /not a price/, 'a recorded stop asked to move to no price: refused');
  assert.strictEqual(why({ orderId: 77, stopPrice: 1 }), null, 'no record: the gateway judges it');
  assert.strictEqual(why({ orderId: 9 }), null, 'no stop price: nothing to judge');
  assert.strictEqual(why({ orderId: 9, limitPrice: 1 }), null, 'a limit price is not the stop');
  assert.strictEqual(RS.modifyStopRefusal({ home: null, input: { orderId: 9, stopPrice: 1 }, now: NOW }), null);
  // A record of an earlier trading day (an order id a restarted server may reuse) is no record: the gateway judges.
  assert.strictEqual(RS.modifyStopRefusal({ home, input: { orderId: 9, stopPrice: 21400 }, now: new Date('2026-10-08T14:35:00.000Z') }), null);
  assert.match(RS.modifyStopRefusal({ home, input: { orderId: 9, stopPrice: 21400 }, now: new Date('2026-10-07T21:00:00.000Z') }) || '', /looser/, 'the same trading day (after 18:00 ET is the next day)');
});
