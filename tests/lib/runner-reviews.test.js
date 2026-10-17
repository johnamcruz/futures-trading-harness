'use strict';

// The runner's factual reviews (scripts/lib/trading/runner-reviews.js): an entry seen to end unfilled or flat gets its
// review from the broker's own orders and fills, counted as the order gate counts, never twice, retried on a failure.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const RR = require('../../scripts/lib/trading/runner-reviews');
const { evaluateOrder } = require('../../scripts/lib/trading/order-gate');
const { tmpDir, FAKE_BROKERS } = require('../helpers');

const NOW = new Date('2026-10-07T15:00:00Z');
const at = min => new Date(NOW.getTime() - min * 60000).toISOString();
const placed = (id, min, o = {}) => ({ ts: at(min), kind: 'order_placed', contractId: o.contractId || 'MNQ', orderId: id, text: o.text || 'setup:orb long, stop 21495', data: { request: { side: o.side || 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 20, type: 'stop' } }, result: { success: true, orderId: id } } });
const fill = (orderId, min, price, side, pnl = null) => ({ id: Math.random(), orderId, contractId: 'MNQ', creationTimestamp: at(min), price, side, size: 1, profitAndLoss: pnl, fees: 0.37, voided: false });
const ctx = (o = {}) => ({ orders: [], positions: [], fills: [], record: null, cancelled: new Set(), nowMs: NOW.getTime(), tick: 0.25, ...o });
const one = (entries, o) => RR.reviewFor(RR.coverage(entries)[0], ctx(o));

test('nofill: an entry the runner cancelled, or one gone from the working orders past the grace, with no fill', () => {
  const e = [placed(101, 1)];
  assert.deepStrictEqual(one(e, { orders: [{ id: 101 }] }), { wait: 'still working' });
  assert.deepStrictEqual(one(e, {}), { wait: 'too new to tell from the broker\'s orders' }, 'a minute old: the broker may not list it yet');
  const r = one(e, { cancelled: new Set(['101']) }).review;
  assert.deepStrictEqual([r.kind, r.contractId, r.orderId, r.tags], ['review', 'MNQ', 101, ['by:runner', 'result:nofill', 'setup:orb', 'MNQ']]);
  assert.match(r.text, /^runner: orb long entry order 101 on MNQ ended unfilled \(cancelled by the runner/);
  assert.deepStrictEqual(one([placed(101, 3)], {}).review.tags, ['by:runner', 'result:nofill', 'setup:orb', 'MNQ'], 'three minutes on, not working, no fill');
  // The broker's own orders say how it ended, at once: cancelled, expired or rejected with nothing filled.
  for (const [status, word] of [[3, 'cancelled'], [4, 'expired'], [5, 'rejected']]) {
    const x = one(e, { history: [{ id: 101, status, fillVolume: 0 }] }).review;
    assert.match(x.text, new RegExp(`ended unfilled \\(${word} at the broker; no fill\\)`));
    assert.strictEqual(x.tags[1], 'result:nofill');
  }
  assert.deepStrictEqual(one(e, { history: [{ id: 101, status: 2, fillVolume: 1 }] }), { wait: 'filled at the broker, its fills not listed yet' });
  assert.deepStrictEqual(one(e, { history: [{ id: 101, status: 3, fillVolume: 1 }] }), { wait: 'too new to tell from the broker\'s orders' }, 'part filled: its fills tell it, once listed');
});

test('win, loss, scratch: the broker\'s fills of its own order, R over the planned stop (20 ticks x 0.25 = 5 points)', () => {
  const e = [placed(101, 30)];
  const closed = exit => [fill(101, 29, 21500, 0), fill(null, 10, exit, 1, 1)];
  const win = one(e, { fills: closed(21510) }).review;
  assert.deepStrictEqual(win.tags, ['by:runner', 'result:win', 'setup:orb', 'MNQ', 'r:2']);
  assert.match(win.text, /filled 21500, out 21510 .*: win, \+2R gross of fees on the planned 20-tick stop/);
  assert.deepStrictEqual(one(e, { fills: closed(21495) }).review.tags, ['by:runner', 'result:loss', 'setup:orb', 'MNQ', 'r:-1']);
  assert.deepStrictEqual(one(e, { fills: closed(21500.75) }).review.tags, ['by:runner', 'result:scratch', 'setup:orb', 'MNQ', 'r:0.15'], '+0.15R is inside 0.2R');
  assert.deepStrictEqual(one(e, { fills: closed(21501) }).review.tags.slice(1, 2), ['result:win'], '+0.2R is not');
  // A short: down is the win.
  const s = [placed(102, 30, { side: 'sell', text: 'setup:orb short' })];
  assert.deepStrictEqual(one(s, { fills: [fill(102, 29, 21500, 1), fill(null, 10, 21490, 0, 1)] }).review.tags, ['by:runner', 'result:win', 'setup:orb', 'MNQ', 'r:2']);
  // The gateway's recorded stop wins over the bracket; no stop known at all: the price move's sign, no r:.
  assert.deepStrictEqual(one(e, { fills: closed(21510), record: { stopTicks: 40 } }).review.tags.at(-1), 'r:1');
  const bare = [{ ...placed(103, 30), data: { request: { side: 'buy' }, result: { success: true, orderId: 103 } } }];
  const noStop = one(bare, { fills: [fill(103, 29, 21500, 0), fill(null, 10, 21490, 1, -5)] }).review;
  assert.deepStrictEqual(noStop.tags, ['by:runner', 'result:loss', 'setup:orb', 'MNQ']);
  assert.match(noStop.text, /R unknown \(no planned stop recorded\)/);
});

test('no review while it may be open or its fills can\'t tell it', () => {
  const e = [placed(101, 30)];
  assert.deepStrictEqual(one(e, { fills: [fill(101, 29, 21500, 0)], positions: [{ contractId: 'MNQ', type: 1, size: 1 }] }), { wait: 'its position may be open' });
  assert.deepStrictEqual(one(e, { fills: [fill(101, 29, 21500, 0)] }), { wait: 'its outcome can\'t be told from the fills' }, 'flat but no closing fill yet');
  // Its own closing fills add up to it: closed, whatever is open on the family now (another entry's position).
  assert.strictEqual(one(e, { fills: [fill(101, 29, 21500, 0), fill(null, 10, 21510, 1, 20)], positions: [{ contractId: 'MNQ', type: 1, size: 1 }] }).review.tags[1], 'result:win');
  assert.deepStrictEqual(one(e, { fills: [fill(101, 29, 21500, 0), fill(999, 28, 21500, 0), fill(null, 10, 21510, 1, 1)] }), { wait: 'its outcome can\'t be told from the fills' }, 'another order\'s fill in it');
  assert.deepStrictEqual(one([{ ...placed(101, 30), orderId: undefined, data: { result: { success: true } } }], {}), { wait: 'no order id to name' });
});

test('coverage, as the gate counts: a review naming the order covers it; one naming none covers the oldest left; nothing is reviewed twice', () => {
  const runnerReview = id => ({ ts: at(5), kind: 'review', contractId: 'MNQ', orderId: id, tags: ['by:runner', 'result:loss'] });
  const modelReview = { ts: at(5), kind: 'review', contractId: 'MNQ', tags: ['result:win', 'setup:orb'] };
  const ids = es => RR.coverage(es).map(c => c.orderId);
  assert.deepStrictEqual(ids([placed(101, 30), placed(102, 20)]), ['101', '102']);
  assert.deepStrictEqual(ids([placed(101, 30), placed(102, 20), runnerReview(102)]), ['101']);
  assert.deepStrictEqual(ids([placed(101, 30), placed(102, 20), modelReview]), ['102'], 'the model reviewed the older one');
  assert.deepStrictEqual(ids([placed(101, 30), placed(102, 20), runnerReview(101), runnerReview(101)]), [], 'a second review of one covers the next: never more reviews than entries');
  assert.deepStrictEqual(ids([placed(101, 30), { ...modelReview, tags: ['setup:orb', 'grade:B'], orderId: 101 }]), ['101'], 'a grade review (no result) covers nothing');
  assert.deepStrictEqual(ids([placed(101, 30), { ...modelReview, tags: ['result:win', 'paper'] }]), ['101'], 'a paper review counts for nothing');
  // An NQ entry and an MNQ review: each root counts its own.
  assert.deepStrictEqual(ids([placed(101, 30, { contractId: 'NQ' }), modelReview]), ['101']);
  // The count is the gate's.
  const day = [placed(101, 30), placed(102, 20), runnerReview(101)];
  assert.strictEqual(RR.unreviewedOn(day, 'MNQ'), 1);
  assert.strictEqual(RR.unreviewedOn(day, 'MES'), 0);
  assert.strictEqual(RR.unreviewedOn([...day, runnerReview(102)], 'MNQ'), 0);
  const gate = es => evaluateOrder({ input: { contractId: 'MNQ', side: 'buy', type: 'market', size: 1, rationale: 'setup:orb long' }, entries: es, now: NOW, config: { skipChecks: new Set(), maxEntriesPerDay: 0, maxConsecutiveLosses: 9, maxDailyLosses: 9, planMaxAgeMin: 60, home: tmpDir(), contractsFile: null } }).violations.some(v => v.check === 'review-before-next-entry');
  assert.deepStrictEqual([gate(day), gate([...day, runnerReview(102)])], [true, false], 'the runner\'s review clears the gate\'s check');
});

/** A client over a journal in memory: journal_add appends (or fails while `fail` > 0). */
function fakeClient(journal, { orders = [], positions = [], fills = [], fail = 0, bad = 0 } = {}) {
  const calls = [];
  return {
    calls,
    accountState: async () => { calls.push('accountState'); return { orders, positions }; },
    fillsSince: async () => { calls.push('fillsSince'); return fills; },
    journalAdd: async e => {
      calls.push('journalAdd');
      if (fail > 0) { fail -= 1; throw new Error('HTTP 503'); }
      if (bad > 0) { bad -= 1; return null; }
      const out = { ts: NOW.toISOString(), ...e };
      journal.push(out);
      return out;
    },
  };
}

test('writeReviews: each due review once; a failed or empty journal_add is logged and written on the next pass; nothing read when nothing is uncovered', async () => {
  const journal = [placed(101, 30), placed(102, 20)];
  const fills = [fill(102, 19, 21500, 0), fill(null, 10, 21495, 1, -2.5)];
  const logs = [];
  const events = [];
  const c = fakeClient(journal, { fills, fail: 1, bad: 1 });
  const args = { client: c, accountId: 7, entries: () => journal, now: NOW, cancelled: new Set(['101']), tickOf: () => 0.25, log: (m, l) => logs.push(`${l || 'info'} ${m}`), emit: (k, d) => events.push({ k, ...d }) };
  let ids = await RR.writeReviews({ ...args, written: [] });
  assert.deepStrictEqual(ids, [], 'both writes failed');
  assert.ok(logs.filter(l => /^error MNQ: could not write the review of entry 10[12] \(.*\); the next bar tries again$/.test(l)).length === 2, logs.join('\n'));
  assert.deepStrictEqual(events.map(e => e.k), ['review_failed', 'review_failed']);
  ids = await RR.writeReviews({ ...args, written: ids });
  assert.deepStrictEqual(ids, ['101', '102']);
  assert.deepStrictEqual(journal.filter(e => e.kind === 'review').map(e => [e.orderId, e.tags[1]]), [[101, 'result:nofill'], [102, 'result:loss']]);
  // Again: the journal covers both (and so do the ids): no account read, no write.
  const before = c.calls.length;
  assert.deepStrictEqual(await RR.writeReviews({ ...args, written: [] }), [], 'covered by the journal alone (a restart that lost its state)');
  assert.deepStrictEqual(await RR.writeReviews({ ...args, written: ids }), ids);
  assert.strictEqual(c.calls.length, before, 'nothing read or written');
  // A client without journal_add (a paper or older client): nothing.
  assert.deepStrictEqual(await RR.writeReviews({ ...args, client: { accountState: async () => ({}) }, written: [] }), []);
});

test('writeReviews: no fills read while every uncovered entry still works; an id already written is never written again', async () => {
  const journal = [placed(101, 30)];
  const c = fakeClient(journal, { orders: [{ id: 101 }] });
  await RR.writeReviews({ client: c, accountId: 7, entries: journal, now: NOW, written: [] });
  assert.deepStrictEqual(c.calls, ['accountState']);
  const d = fakeClient(journal, {});
  assert.deepStrictEqual(await RR.writeReviews({ client: d, accountId: 7, entries: journal, now: NOW, cancelled: new Set(['101']), written: ['101'] }), ['101']);
  assert.deepStrictEqual(d.calls, []);
  // The broker's orders tell a cancel at once; unreadable, the fallbacks (here too new: no review yet), logged.
  const fresh = [placed(101, 1)];
  const listed = fakeClient(fresh, {});
  listed.ordersSince = async () => [{ id: 101, status: 3, fillVolume: 0 }];
  assert.deepStrictEqual(await RR.writeReviews({ client: listed, accountId: 7, entries: fresh, now: NOW, written: [] }), ['101']);
  assert.match(fresh.at(-1).text, /cancelled at the broker/);
  const logs = [];
  const broken = fakeClient([placed(101, 1)], {});
  broken.ordersSince = async () => { throw new Error('HTTP 500'); };
  assert.deepStrictEqual(await RR.writeReviews({ client: broken, accountId: 7, entries: [placed(101, 1)], now: NOW, written: [], log: (m, l) => logs.push(`${l} ${m}`) }), []);
  assert.deepStrictEqual(logs, ['error the broker\'s orders could not be read for the reviews (HTTP 500)']);
});

test('unreviewedFor: the gate\'s count from the local journal at the harness clock', () => {
  const home = tmpDir();
  const file = path.join(home, 'journal.jsonl');
  const now = new Date();
  const ts = new Date(now.getTime() - 60000).toISOString();
  fs.writeFileSync(file, `${JSON.stringify({ ...placed(101, 0), ts })}\n`);
  const env = { FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_JOURNAL: file };
  assert.strictEqual(RR.unreviewedFor(env, 'MNQ'), 1);
  assert.strictEqual(RR.unreviewedFor(env, 'MES'), 0);
  fs.appendFileSync(file, `${JSON.stringify({ ts, kind: 'review', contractId: 'MNQ', orderId: 101, tags: ['by:runner', 'result:nofill'] })}\n`);
  assert.strictEqual(RR.unreviewedFor(env, 'MNQ'), 0);
  assert.strictEqual(RR.unreviewedFor({ ...env, FAKE_BROKER_JOURNAL: path.join(home, 'none.jsonl') }, 'MNQ'), 0, 'no journal yet');
});
