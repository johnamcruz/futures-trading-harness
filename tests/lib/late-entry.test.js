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

test('lateEntry in R, symmetric: long and short at 0.3, 0.5 and 0.9 of the risk toward the stop, at a share of 0.5 and the shipped one; the trade\'s way is no refusal', () => {
  // The live smoke's long: entry 13853.00, stop 13838.75 (14.25 points of risk); its mirror short above.
  const L = { side: 'long', entry: 13853, stop: 13838.75 };
  const S = { side: 'short', entry: 13853, stop: 13867.25 };
  const risk = 14.25;
  const at = (plan, r) => plan.entry - (plan.side === 'long' ? 1 : -1) * r * risk; // r of the risk toward the stop
  for (const plan of [L, S]) {
    // A share of 0.5: 0.3 and 0.5 stand (at the share is not over it), 0.9 is missed, its R stated.
    assert.strictEqual(LE.lateEntry({ ...plan, price: at(plan, 0.3), share: 0.5 }), null, `${plan.side} 0.3`);
    assert.strictEqual(LE.lateEntry({ ...plan, price: at(plan, 0.5), share: 0.5 }), null, `${plan.side} 0.5`);
    const r9 = LE.lateEntry({ ...plan, price: at(plan, 0.9), share: 0.5 });
    assert.deepStrictEqual([r9.kind, r9.movedR], ['missed-entry', 0.9], plan.side);
    assert.match(r9.message, new RegExp(`against the ${plan.side}: 90% of the 14.25-point risk toward the stop, over 0.5R`));
    // The shipped share (0.25R): every one of them is missed.
    for (const r of [0.3, 0.5, 0.9]) assert.strictEqual(LE.lateEntry({ ...plan, price: at(plan, r), share: SHARE }).kind, 'missed-entry', `${plan.side} ${r} at ${SHARE}`);
    // The trade's way past the entry (a long's price above it, a short's below): no refusal (the limit rests, never chased).
    assert.strictEqual(LE.lateEntry({ ...plan, price: at(plan, -0.9), share: SHARE }), null, `${plan.side} the trade's way`);
  }
  // The live smoke's fill: 13840.75 on the long, 12.25 of 14.25 points toward the stop: 86%.
  assert.strictEqual(LE.lateEntry({ ...L, price: 13840.75, share: SHARE }).movedR, 0.86);
});

test('lateEntryCheck: the skip as logged (the plan, the price, its R); no current price fails closed with the reason', () => {
  const home = tmpDir();
  LE.recordPrice(home, 'MNQ', { price: 13840.75, closedAt: '2021-08-18T17:37:00Z', minutes: 1, source: 'gateway' }, { now: NOW });
  const r = LE.lateEntryCheck({ home, root: 'MNQ', side: 'long', entry: 13853, stop: 13838.75, target: 13895.5, now: NOW, share: SHARE, maxAgeMin: AGE });
  assert.match(r.message, /missed the plan's entry 13853 \(price 13840\.75 is 12\.25 points past it against the long: 86% of the 14\.25-point risk toward the stop/);
  assert.deepStrictEqual(r.late, { side: 'long', entry: 13853, stop: 13838.75, target: 13895.5, share: SHARE, kind: 'missed-entry', price: 13840.75, closedAt: '2021-08-18T17:37:00.000Z', source: 'gateway', movedR: 0.86 });
  const none = LE.lateEntryCheck({ home: tmpDir(), root: 'MNQ', side: 'long', entry: 13853, stop: 13838.75, now: NOW, share: SHARE, maxAgeMin: AGE });
  assert.match(none.message, /no current price for MNQ from local bars \(no local bar\).*no entry \(fails closed\)/);
  assert.deepStrictEqual([none.late.kind, none.late.price], ['no-price', null]);
  assert.strictEqual(LE.lateEntryRefusal({ home, root: 'MNQ', side: 'long', entry: 13853, stop: 13838.75, now: NOW, share: SHARE, maxAgeMin: AGE }), r.message, 'the refusal is the check\'s message');
});

test('lateEntry: drift against the entry over the share refuses (missed the entry); at or under it the plan stands', () => {
  // Short: 7-point stop, 0.25 of it = 1.75 points (7 ticks) above the 14979.5 limit.
  assert.strictEqual(LE.lateEntry({ ...SHORT, price: 14981.25, share: SHARE }), null, 'exactly 7 ticks: stands');
  const over = LE.lateEntry({ ...SHORT, price: 14981.5, share: SHARE });
  assert.strictEqual(over.kind, 'missed-entry');
  assert.match(over.message, /^missed the plan's entry 14979\.5 \(price 14981\.5 is 2 points past it against the short: 29% of the 7-point risk toward the stop, over 0\.25R; the setup's premise is in question\).*no late entry$/);
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

test('lateEntry, a MARKET entry: price the trade\'s way past the entry by more than the share of the risk is a chase (refused); at or under it, and any limit, is not', () => {
  // LONG: 10-point risk, so 0.25 is 2.5 points: 21502.5 is at the share, 21502.75 over it.
  assert.strictEqual(LE.lateEntry({ ...LONG, price: 21502.5, share: SHARE, market: true }), null, 'at the share');
  const chased = LE.lateEntry({ ...LONG, price: 21502.75, share: SHARE, market: true });
  assert.strictEqual(chased.kind, 'chased-entry');
  assert.match(chased.message, /chased entry: .*entry 21500 \(price 21502\.75 is 2\.75 points past it with the long: 28% of the 10-point risk, over 0\.25R\).*stop 21490/);
  // SHORT: 7-point risk, 1.75 points: 14978 at the share (14979.5 - 1.75 = 14977.75), 14977.5 over it.
  assert.strictEqual(LE.lateEntry({ ...SHORT, price: 14977.75, share: SHARE, market: true }), null);
  assert.strictEqual(LE.lateEntry({ ...SHORT, price: 14977.5, share: SHARE, market: true }).kind, 'chased-entry');
  // A limit never chases; adverse drift and the stop are judged for a market order as for a limit.
  assert.strictEqual(LE.lateEntry({ ...LONG, price: 21540, share: SHARE }), null);
  assert.strictEqual(LE.lateEntry({ ...LONG, price: 21540, share: SHARE, market: false }), null);
  assert.strictEqual(LE.lateEntry({ ...LONG, price: 21497, share: SHARE, market: true }).kind, 'missed-entry');
  assert.strictEqual(LE.lateEntry({ ...LONG, price: 21489, share: SHARE, market: true }).kind, 'beyond-stop');
  assert.strictEqual(LE.lateEntry({ ...LONG, price: 21530, share: SHARE, market: 'yes' }), null, 'only true is a market flag');
});

test('lateEntryCheck, a MARKET entry: the chase is logged as chased-entry; no current price still fails closed', () => {
  const home = tmpDir('late-entry-market-');
  LE.recordPrice(home, 'MNQ', { price: 21510, closedAt: '2026-10-07T14:00:00Z', minutes: 1, source: 'runner-entry' });
  const now = new Date('2026-10-07T14:01:00Z');
  const args = { home, root: 'MNQ', ...LONG, now, share: SHARE, maxAgeMin: AGE };
  assert.strictEqual(LE.lateEntryCheck(args), null, 'a limit rests');
  const r = LE.lateEntryCheck({ ...args, market: true });
  assert.strictEqual(r.late.kind, 'chased-entry');
  assert.strictEqual(r.late.price, 21510);
  assert.match(r.message, /chased entry/);
  const stale = LE.lateEntryCheck({ ...args, market: true, now: new Date('2026-10-07T14:30:00Z') });
  assert.strictEqual(stale.late.kind, 'no-price');
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
