'use strict';

// The runner's factual reviews (scripts/lib/trading/runner-reviews.js): an entry seen to end unfilled or flat gets its
// review from the broker's own orders and fills, counted as the order gate counts, never twice, retried on a failure.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const RR = require('../../scripts/lib/trading/runner-reviews');
const { evaluateOrder } = require('../../scripts/lib/trading/order-gate');
const { tmpDir, FAKE_BROKERS, brokerId } = require('../helpers');

const NOW = new Date('2026-10-07T15:00:00Z');
const at = min => new Date(NOW.getTime() - min * 60000).toISOString();
const placed = (id, min, o = {}) => ({ ts: at(min), kind: 'order_placed', contractId: o.contractId || 'MNQ', orderId: id, text: o.text || 'setup:orb long, stop 21495', data: { request: { side: o.side || 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 20, type: 'stop' } }, result: { success: true, orderId: id } } });
const fill = (orderId, min, price, side, pnl = null) => ({ id: Math.random(), orderId, contractId: 'MNQ', creationTimestamp: at(min), price, side, size: 1, profitAndLoss: pnl, fees: 0.37, voided: false });
const ctx = (o = {}) => ({ orders: [], positions: [], fills: [], record: null, cancelled: new Set(), nowMs: NOW.getTime(), tick: 0.25, tickValue: 0.5, ...o });
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
  assert.deepStrictEqual(one(e, { history: [{ id: 101, status: 2, fillVolume: 1 }] }), { wait: 'filled (in part) at the broker, its fills not listed yet' });
  // Part filled, then cancelled (the runner's expiry cancel of a part-filled limit), its fills not listed yet: never a
  // nofill, whatever the cancel or the grace says.
  const part = { wait: 'filled (in part) at the broker, its fills not listed yet' };
  assert.deepStrictEqual(one(e, { history: [{ id: 101, status: 3, fillVolume: 1 }], cancelled: new Set(['101']) }), part);
  assert.deepStrictEqual(one([placed(101, 30)], { history: [{ id: 101, status: 3, fillVolume: 1 }] }), part, 'past the grace too');
  // A position open on its family: its fills may lag, so no nofill either.
  const open = [{ contractId: 'MNQ', type: 1, size: 1 }];
  assert.deepStrictEqual(one(e, { cancelled: new Set(['101']), positions: open }), { wait: 'a position is open on its family: its fills may not be listed yet' });
  assert.deepStrictEqual(one([placed(101, 30)], { positions: open }).wait, 'a position is open on its family: its fills may not be listed yet', 'past the grace too');
  // The broker's own word comes first: cancelled with nothing filled is a nofill whatever else is open on the family.
  assert.strictEqual(one(e, { history: [{ id: 101, status: 3, fillVolume: 0 }], positions: open }).review.tags[1], 'result:nofill');
  // The broker's orders unread (history null): the runner's own cancel, or the grace (a broker-side expiry, the
  // model's cancel), with no fill listed and nothing open on the family; under the grace it waits.
  assert.deepStrictEqual(one(e, { history: null }), { wait: 'the broker\'s orders could not be read' });
  assert.match(one([placed(101, 30)], { history: null }).review.text, /ended unfilled \(no longer working; no fill\)/);
  assert.strictEqual(one(e, { history: null, cancelled: new Set(['101']) }).review.tags[1], 'result:nofill');
  assert.deepStrictEqual(one([placed(101, 30)], { history: null, positions: open }).wait, 'a position is open on its family: its fills may not be listed yet');
  assert.deepStrictEqual(one(e, { history: null, cancelled: new Set(['101']), positions: open }).wait, 'a position is open on its family: its fills may not be listed yet');
});

test('win, loss, scratch: the broker\'s fills of its own order, R over the planned stop (20 ticks x 0.25 = 5 points, $10 a contract) net of its fees', () => {
  const e = [placed(101, 30)];
  const closed = exit => [fill(101, 29, 21500, 0), fill(null, 10, exit, 1, 1)];
  // Two fills at $0.37: $0.74 of $10 risk = 0.074R off the price R.
  const win = one(e, { fills: closed(21510) }).review;
  assert.deepStrictEqual(win.tags, ['by:runner', 'result:win', 'setup:orb', 'MNQ', 'r:1.93']);
  assert.match(win.text, /filled 21500, out 21510 .*: win, \+1\.93R net of fees on the planned 20-tick stop/);
  assert.deepStrictEqual(one(e, { fills: closed(21495) }).review.tags, ['by:runner', 'result:loss', 'setup:orb', 'MNQ', 'r:-1.07']);
  assert.deepStrictEqual(one(e, { fills: closed(21501) }).review.tags, ['by:runner', 'result:scratch', 'setup:orb', 'MNQ', 'r:0.13'], '+0.2R before fees is +0.13R net: inside 0.2R');
  assert.deepStrictEqual(one(e, { fills: closed(21501.5) }).review.tags.slice(1, 2), ['result:win'], '+0.23R net is not');
  // A short: down is the win.
  const s = [placed(102, 30, { side: 'sell', text: 'setup:orb short' })];
  assert.deepStrictEqual(one(s, { fills: [fill(102, 29, 21500, 1), fill(null, 10, 21490, 0, 1)] }).review.tags, ['by:runner', 'result:win', 'setup:orb', 'MNQ', 'r:1.93']);
  // The gateway's recorded stop wins over the bracket ($20 of risk); no stop known at all: the price move's sign, no r:.
  assert.deepStrictEqual(one(e, { fills: closed(21510), record: { stopTicks: 40 } }).review.tags.at(-1), 'r:0.96');
  // A fill's fees or the tick value unknown: no r: (never a different measure under the tag), the price R in the text.
  const unknownFees = one(e, { fills: [fill(101, 29, 21500, 0), { ...fill(null, 10, 21510, 1, 1), fees: null }] }).review;
  assert.deepStrictEqual(unknownFees.tags, ['by:runner', 'result:win', 'setup:orb', 'MNQ']);
  assert.match(unknownFees.text, /\+2R before fees on the planned 20-tick stop \(its fees unknown\)/);
  assert.deepStrictEqual(one(e, { fills: closed(21510), tickValue: null }).review.tags, ['by:runner', 'result:win', 'setup:orb', 'MNQ']);
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
  assert.deepStrictEqual(ids([placed(101, 30), placed(102, 20), runnerReview(101), runnerReview(101)]), ['102'], 'a second result review of one order covers no other entry (the gate counts it once)');
  assert.deepStrictEqual(ids([placed(101, 30), placed(102, 20), runnerReview(101), { ...modelReview, orderId: 101, tags: ['result:loss'] }]), ['102'], 'the model\'s second result: of 101 neither');
  assert.deepStrictEqual(ids([placed(101, 30), placed(102, 20), runnerReview(101), { ...modelReview, orderId: 101, tags: ['result:win'] }]), ['102'], 'whichever counts, one of them');
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
  assert.deepStrictEqual(await RR.writeReviews({ client: broken, accountId: 7, entries: [placed(101, 1)], now: NOW, written: [], log: (m, l) => logs.push(l ? `${l} ${m}` : m) }), []);
  assert.deepStrictEqual(logs, ['error the broker\'s orders could not be read for the reviews (HTTP 500)', 'MNQ: no review of entry 101 yet: the broker\'s orders could not be read']);
});

test('tickValueFor: the root\'s own contract, never its family\'s (a mini on a micro\'s run is $5 a tick, not $0.50)', () => {
  const syms = [{ contractId: 'MNQ', tickSize: 0.25, tickValue: 0.5 }];
  assert.strictEqual(RR.tickValueFor('MNQ', syms), 0.5);
  assert.strictEqual(RR.tickValueFor('NQ', syms), 5);
  assert.strictEqual(RR.tickValueFor('ES', []), 12.5);
  assert.strictEqual(RR.tickValueFor('ZZZ', [{ contractId: 'ZZZ', tickValue: 7 }]), 7, 'a root the table lacks: the broker\'s contract of that root');
  assert.strictEqual(RR.tickValueFor('ZZZ', syms), null);
  // The lane's contract under the broker's own id, named by the translator's lookups (contractRoot).
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'contracts-fake.json'), JSON.stringify({ ids: { [brokerId('ZZZ')]: { root: 'ZZZ', month: '2026-12' } }, front: {} }));
  const prev = { home: process.env.FTH_HOME, brokers: process.env.FTH_BROKERS_FILE };
  process.env.FTH_HOME = home;
  process.env.FTH_BROKERS_FILE = FAKE_BROKERS;
  try {
    assert.strictEqual(RR.tickValueFor('ZZZ', [...syms, { contractId: brokerId('ZZZ'), tickSize: 1, tickValue: 7 }]), 7);
    assert.strictEqual(RR.tickValueFor('ZZY', [{ contractId: brokerId('ZZZ'), tickValue: 7 }]), null, 'another root\'s contract is not this one\'s');
  } finally {
    for (const [k, v] of [['FTH_HOME', prev.home], ['FTH_BROKERS_FILE', prev.brokers]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  // An NQ trade's net R: 20 ticks x $5 = $100 of risk; +2R less $0.74 of fees is +1.99R (a micro's $10 would be +1.93R).
  const nq = [placed(101, 30, { contractId: 'NQ' })];
  const nqFill = (orderId, min, price, side, pnl = null) => ({ ...fill(orderId, min, price, side, pnl), contractId: 'NQ' });
  const r = RR.reviewFor(RR.coverage(nq)[0], ctx({ fills: [nqFill(101, 29, 21500, 0), nqFill(null, 10, 21510, 1, 200)], tickValue: RR.tickValueFor('NQ', syms) })).review;
  assert.deepStrictEqual(r.tags, ['by:runner', 'result:win', 'setup:orb', 'NQ', 'r:1.99']);
});

test('writeReviews: why a review waits is logged once per entry, and again only when the reason changes', async () => {
  const journal = [placed(101, 1)];
  const waits = new Map();
  const logs = [];
  const args = { accountId: 7, entries: journal, now: NOW, written: [], waits, log: m => logs.push(m) };
  await RR.writeReviews({ ...args, client: fakeClient(journal, { orders: [{ id: 101 }] }) });
  await RR.writeReviews({ ...args, client: fakeClient(journal, { orders: [{ id: 101 }] }) });
  await RR.writeReviews({ ...args, client: fakeClient(journal, {}) });
  assert.deepStrictEqual(logs, ['MNQ: no review of entry 101 yet: still working', 'MNQ: no review of entry 101 yet: the broker\'s orders could not be read']);
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
