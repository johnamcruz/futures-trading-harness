'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { et, etStamp, premarketPlan, newsLine, PLAN_CHARS } = require('../../scripts/lib/trading/session-context');
const { describeOvernight } = require('../../scripts/lib/trading/day-context');
const { readBarsArg } = require('../../scripts/lib/backtest/data');

const NOW = new Date('2026-10-08T14:33:20Z'); // 10:33:20 ET

test('times read as New York time', () => {
  assert.strictEqual(et(NOW), '10:33 ET');
  assert.strictEqual(etStamp(NOW), '2026-10-08 10:33:20 ET');
  assert.strictEqual(et('2026-01-15T15:00:00Z'), '10:00 ET', 'EST in winter');
});

test('premarket plan: today\'s latest note tagged premarket and the symbol, else said to be missing', () => {
  const note = (ts, tags, text) => ({ ts, kind: 'note', tags, text });
  const entries = [
    note('2026-10-07T13:00:00Z', ['premarket', 'MNQ'], 'yesterday\'s plan'),
    note('2026-10-08T12:50:00Z', ['premarket', 'MNQ'], 'first draft'),
    note('2026-10-08T13:05:00Z', ['premarket', 'MNQ'], 'Bias long above 21480 (prior VAH);  CPI at 08:30 done.'),
    note('2026-10-08T13:06:00Z', ['premarket', 'MES'], 'MES plan'),
    note('2026-10-08T15:00:00Z', ['premarket', 'MNQ'], 'written after now: not seen yet'),
    { ts: '2026-10-08T13:07:00Z', kind: 'plan', tags: ['premarket', 'MNQ'], text: 'a trade plan, not the game plan' },
  ];
  assert.strictEqual(premarketPlan(entries, 'MNQ', NOW), 'MNQ premarket plan (09:05 ET): Bias long above 21480 (prior VAH); CPI at 08:30 done.');
  assert.strictEqual(premarketPlan(entries, 'MES', NOW), 'MES premarket plan (09:06 ET): MES plan');
  assert.strictEqual(premarketPlan(entries.slice(0, 1), 'MNQ', NOW), 'MNQ: no premarket plan in the journal for today.', 'yesterday\'s is not today\'s');
  const long = premarketPlan([note('2026-10-08T13:05:00Z', ['premarket', 'mnq'], 'x'.repeat(1000))], 'MNQ', NOW);
  assert.ok(long.length < PLAN_CHARS + 40 && long.endsWith('…'));
  // An evening note (after 18:00 ET) belongs to the next trading day.
  assert.match(premarketPlan([note('2026-10-07T23:00:00Z', ['premarket', 'MNQ'], 'Asia plan')], 'MNQ', NOW), /Asia plan/);
});

test('news line: in force now, else the next today, else none; an unreadable file is said', () => {
  const b = (start, end, reason) => ({ start, end, reason });
  assert.strictEqual(newsLine({ items: [b('2026-10-08T14:30:00Z', '2026-10-08T14:45:00Z', 'ISM')] }, NOW), 'News blackout in force: ISM until 10:45 ET (no entries; manage open trades).');
  assert.strictEqual(newsLine({ items: [b('2026-10-08T18:00:00Z', '2026-10-08T18:15:00Z', 'FOMC'), b('2026-10-08T16:00:00Z', '2026-10-08T16:10:00Z', 'EIA')] }, NOW), 'Next news blackout: EIA 12:00-12:10 ET, in 87 min (no entries in it; a trade open then rides through it).');
  assert.strictEqual(newsLine({ items: [b('2026-10-09T12:30:00Z', '2026-10-09T12:45:00Z', 'CPI')] }, NOW), 'No news blackout recorded for the rest of today.', 'tomorrow is not today');
  assert.strictEqual(newsLine({ items: [b('2026-10-08T12:30:00Z', '2026-10-08T12:45:00Z', 'CPI')] }, NOW), 'No news blackout recorded for the rest of today.', 'already over');
  assert.match(newsLine({ items: [], error: 'invalid JSON' }, NOW), /unreadable \(invalid JSON\); the order gate refuses every entry/);
  assert.strictEqual(newsLine({ items: [b('2026-10-08T18:00:00Z', '2026-10-08T18:15:00Z')] }, NOW), 'Next news blackout: 14:00-14:15 ET, in 207 min (no entries in it; a trade open then rides through it).');
});

test('overnight line: outside RTH, the session so far against the prior day; nothing in RTH', () => {
  const nq = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
  const at = t => nq.findIndex(b => b.t === t);
  // 2026-04-27 23:00 ET is 03:00Z the next day: Globex since 18:00 ET.
  const line = describeOvernight(nq.slice(0, at('2026-04-27T03:00:00.000Z') + 1), { symbol: 'MNQ' });
  assert.match(line, /^MNQ overnight \(Globex since 18:00 ET\): range [0-9.]+-[0-9.]+ so far, last [0-9.]+; prior RTH day 27130\.25-27462\.5, close 27434, value area 27246\.54-27455\.86 \(POC 27414\.32\): price (above|inside|below) the prior value area; RTH opens in 10 h 30 min\.$/);
  assert.strictEqual(describeOvernight(nq.slice(0, at('2026-04-27T17:15:00.000Z') + 1)), null, 'in RTH the day line applies');
  assert.strictEqual(describeOvernight(nq.slice(0, 20)), null, 'no whole prior RTH day in the data');
  assert.strictEqual(describeOvernight([]), null);
});
