'use strict';

// No late entry (scripts/lib/trading/late-entry.js): the latest local price against a composed plan's entry and stop.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const LE = require('../../scripts/lib/trading/late-entry');
const { tmpDir } = require('../helpers');

const SHARE = require('../../scripts/lib/tunables').runner().gate.lateEntryDriftShare;
const AGE = LE.ageLimitOf({ signalMaxAgeBars: 3, signalMaxAgeCeilingMin: 45 }); // 3 bars: 3 min on 1m, 9 min on 3m
// The replay's bug (2021-08-18, MNQ): a short at the 13:33 3m bar's close, sell limit 14979.5, stop 14986.5 (28 ticks).
const SHORT = { side: 'short', entry: 14979.5, stop: 14986.5 };
const LONG = { side: 'long', entry: 21500, stop: 21490 }; // 40 ticks
const NOW = new Date('2021-08-18T17:37:20Z');

test('lateEntry: beyond the plan\'s stop refuses, short and long (the replay\'s 14997.5 against a 14986.5 stop)', () => {
  assert.strictEqual(SHARE, 0.25);
  const r = LE.lateEntry({ ...SHORT, price: 14997.5, share: SHARE });
  assert.deepStrictEqual([r.kind, r.message], ['beyond-stop', 'the setup was invalidated before the order went (price 14997.5 beyond the plan\'s stop 14986.5): no late entry']);
  assert.strictEqual(LE.lateEntry({ ...SHORT, price: 14986.5, share: SHARE }).kind, 'beyond-stop', 'at the stop is beyond it');
  assert.strictEqual(LE.lateEntry({ ...LONG, price: 21490, share: SHARE }).kind, 'beyond-stop');
  assert.strictEqual(LE.lateEntry({ ...LONG, price: 21485.25, share: SHARE }).kind, 'beyond-stop');
});

test('lateEntry: drift against the entry over the share refuses (missed the entry); at or under it the plan stands', () => {
  // Short: 7-point stop, 0.25 of it = 1.75 points (7 ticks) above the 14979.5 limit.
  assert.strictEqual(LE.lateEntry({ ...SHORT, price: 14981.25, share: SHARE }), null, 'exactly 7 ticks: stands');
  const over = LE.lateEntry({ ...SHORT, price: 14981.5, share: SHARE });
  assert.strictEqual(over.kind, 'missed-entry');
  assert.match(over.message, /^missed the plan's entry 14979\.5 \(price 14981\.5 is 2 points past it against the short, over 0\.25 of the 7-point stop\).*no late entry$/);
  // Long: 10-point stop, 2.5 points below 21500.
  assert.strictEqual(LE.lateEntry({ ...LONG, price: 21497.5, share: SHARE }), null);
  assert.strictEqual(LE.lateEntry({ ...LONG, price: 21497.25, share: SHARE }).kind, 'missed-entry');
  // A share of 0 refuses any adverse tick.
  assert.strictEqual(LE.lateEntry({ ...LONG, price: 21499.75, share: 0 }).kind, 'missed-entry');
});

test('lateEntry: the price past the entry the trade\'s way is no refusal (the limit rests at the plan\'s price, never chased)', () => {
  assert.strictEqual(LE.lateEntry({ ...SHORT, price: 14960, share: SHARE }), null);
  assert.strictEqual(LE.lateEntry({ ...LONG, price: 21540, share: SHARE }), null);
  // An unreadable plan or price is refused, never passed.
  assert.strictEqual(LE.lateEntry({ ...LONG, price: NaN, share: SHARE }).kind, 'unreadable');
  assert.strictEqual(LE.lateEntry({ side: 'long', entry: 21500, stop: 21510, price: 21500, share: SHARE }).kind, 'unreadable', 'a long\'s stop above its entry');
});

test('recordPrice / readPrice: kept per family, never back in time', () => {
  const home = tmpDir();
  assert.strictEqual(LE.readPrice(home, 'MNQ'), null);
  LE.recordPrice(home, 'MNQ', { price: 14997.5, closedAt: '2021-08-18T17:37:00Z', minutes: 1, source: 'runner-entry' });
  assert.deepStrictEqual(LE.readPrice(home, 'NQ'), { price: 14997.5, closedAt: '2021-08-18T17:37:00.000Z', minutes: 1, source: 'runner-entry' }, 'NQ is MNQ\'s family');
  LE.recordPrice(home, 'MNQ', { price: 14980, closedAt: '2021-08-18T17:36:00Z', minutes: 1 });
  assert.strictEqual(LE.readPrice(home, 'MNQ').price, 14997.5, 'an older bar keeps the newer');
  assert.throws(() => LE.recordPrice(home, 'MNQ', { price: 'x', closedAt: '2021-08-18T17:38:00Z' }), /not a price/);
  // A newer kept one wins, said; one dated after now (past the gate's future tolerance) is replaced.
  const said = [];
  LE.recordPrice(home, 'MNQ', { price: 14980, closedAt: '2021-08-18T17:36:00Z', minutes: 1 }, { now: new Date('2021-08-18T17:37:30Z'), log: m => said.push(m) });
  assert.deepStrictEqual(said, ['the latest price kept for MNQ (14997.5 closed 2021-08-18T17:37:00.000Z) is newer than this one (14980 closed 2021-08-18T17:36:00.000Z): kept']);
  LE.recordPrice(home, 'MNQ', { price: 15100, closedAt: '2021-08-18T18:30:00Z', minutes: 1 }); // a clock that jumped ahead
  LE.recordPrice(home, 'MNQ', { price: 14990, closedAt: '2021-08-18T17:38:00Z', minutes: 1 }, { now: new Date('2021-08-18T17:38:30Z'), log: m => said.push(m) });
  assert.strictEqual(LE.readPrice(home, 'MNQ').price, 14990, 'the future-dated record is replaced');
  assert.strictEqual(said.length, 1);
  fs.writeFileSync(path.join(home, LE.FILE), 'torn{');
  assert.strictEqual(LE.readPrice(home, 'MNQ'), null);
});

test('latestPrice: the newer of the recorded 1m price and the briefing\'s close, judged alone within its own age limit; a stale newest fails closed', () => {
  const home = tmpDir();
  const briefing = { price: 14979.5, closedAt: '2021-08-18T17:36:00.000Z', minutes: 3 };
  assert.deepStrictEqual(LE.latestPrice({ home, root: 'MNQ', briefing, now: NOW, maxAgeMin: AGE }), { price: 14979.5, closedAt: briefing.closedAt, source: 'briefing' });
  LE.recordPrice(home, 'MNQ', { price: 14997.5, closedAt: '2021-08-18T17:37:00Z', minutes: 1, source: 'runner-entry' });
  assert.deepStrictEqual(LE.latestPrice({ home, root: 'MNQ', briefing, now: NOW, maxAgeMin: AGE }), { price: 14997.5, closedAt: '2021-08-18T17:37:00.000Z', source: 'runner-entry' });
  // 4 minutes later the newest (the 1m price) is past its 3 min: refused, never the older 3m briefing within its 9 min.
  const later = LE.latestPrice({ home, root: 'MNQ', briefing, now: new Date('2021-08-18T17:41:30Z'), maxAgeMin: AGE });
  assert.deepStrictEqual(later, { price: null, why: 'the newest is not current: runner-entry 14997.5 closed 4.5 min ago (limit 3 min)' });
  const gone = LE.latestPrice({ home, root: 'MNQ', briefing, now: new Date('2021-08-18T17:50:00Z'), maxAgeMin: AGE });
  assert.strictEqual(gone.price, null);
  assert.match(gone.why, /^the newest is not current: runner-entry 14997\.5 closed 13\.0 min ago \(limit 3 min\)$/);
  assert.deepStrictEqual(LE.latestPrice({ home: tmpDir(), root: 'MNQ', briefing: null, now: NOW, maxAgeMin: AGE }), { price: null, why: 'no local bar' });
  // Dated after now (beyond the gate's tolerance): not a price of now.
  assert.strictEqual(LE.latestPrice({ home: tmpDir(), root: 'MNQ', briefing: { ...briefing, closedAt: '2021-08-18T17:45:00Z' }, now: NOW, maxAgeMin: AGE }).price, null);
});

test('lateEntryRefusal: the replay\'s order is refused, the plan at its price goes, no price fails closed', () => {
  const home = tmpDir();
  const briefing = { price: 14979.5, closedAt: '2021-08-18T17:36:00.000Z', minutes: 3 };
  const at = o => LE.lateEntryRefusal({ home, root: 'MNQ', ...SHORT, briefing, now: NOW, share: SHARE, maxAgeMin: AGE, ...o });
  assert.strictEqual(at(), null, 'the market at the plan (the briefing\'s close)');
  LE.recordPrice(home, 'MNQ', { price: 14997.5, closedAt: '2021-08-18T17:37:00Z', minutes: 1, source: 'runner-entry' });
  assert.match(at(), /^the setup was invalidated before the order went \(price 14997\.5 beyond the plan's stop 14986\.5\): no late entry \(the runner-entry price at 2021-08-18T17:37:00\.000Z\)\. Pass; the next bar composes on its own facts$/);
  assert.match(at({ briefing: null, now: new Date('2021-08-18T17:50:00Z') }), /^no current price for MNQ from local bars \(the newest is not current: .*\): the plan's entry and stop can't be checked against the market, so no entry \(fails closed\)$/);
  assert.match(at({ maxAgeMin: () => { throw new Error('boom'); } }), /^the late-entry check failed \(boom\): no entry \(fails closed\)$/);
});
