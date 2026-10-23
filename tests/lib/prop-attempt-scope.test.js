'use strict';

// A fresh combine attempt's in-prompt history (scripts/lib/prop/attempt-scope.js): only an attempt record with
// `historyFrom` scopes the reads; the reviewed trades (the journal, by `ts`) and the last cycles (the decision history,
// by `at`) from its start on; everything else shows whole, as before.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const A = require('../../scripts/lib/prop/attempt-scope');
const prop = require('../../scripts/lib/trading/prop-state');
const { recentTrades, formSummary } = require('../../scripts/lib/trading/instincts');
const { tmpDir } = require('../helpers');

const ACCOUNT = { name: 'acct', starting_balance: 50000 };
const START = '2022-04-28T13:30:02.000Z';
const ms = Date.parse(START);

test('historyFrom: the running attempt\'s historyFrom, or null (no attempt, a live or seeded attempt without one)', () => {
  const home = tmpDir();
  assert.strictEqual(A.historyFrom(home), null);
  prop.startAttempt(home, ACCOUNT, new Date('2022-04-21T13:30:02Z'));
  assert.strictEqual(A.historyFrom(home), null, 'a live attempt (scripts/combine.js start) keeps its whole history');
  assert.strictEqual(prop.readAttempt(home, 'acct').historyFrom, undefined);
  prop.startAttempt(home, ACCOUNT, new Date(START), { historyFrom: new Date(START) });
  assert.strictEqual(prop.readAttempt(home, 'acct').historyFrom, START);
  assert.strictEqual(A.historyFrom(home), ms);
  // Ended (renamed): no running attempt, nothing scoped.
  prop.endAttempt(home, 'acct');
  assert.strictEqual(A.historyFrom(home), null);
  assert.strictEqual(A.historyFrom(path.join(home, 'none')), null);
});

const review = (ts, result, r) => ({ ts, kind: 'review', orderId: Date.parse(ts) % 100000, contractId: 'MNQ', tags: [`result:${result}`, 'setup:prop_portfolio', `r:${r}`], text: 'long out' });

test('journalSince: the reviewed trades and their record count only the attempt\'s own; null scopes nothing', () => {
  const entries = [review('2022-04-21T16:27:30.000Z', 'loss', -1), { ts: 'not a time', kind: 'review', tags: ['result:win'] }, review('2022-04-28T14:00:00.000Z', 'win', 2)];
  assert.strictEqual(A.journalSince(entries, null), entries);
  assert.deepStrictEqual(A.journalSince(entries, ms).map(e => e.ts), ['2022-04-28T14:00:00.000Z']);
  assert.strictEqual(recentTrades(A.journalSince(entries, ms)).length, 1);
  assert.strictEqual(formSummary(A.journalSince(entries, ms)), '1W/0L, E +2R');
  assert.deepStrictEqual(A.journalSince(entries, Date.parse('2022-04-29T00:00:00Z')), [], 'just started: nothing');
  assert.deepStrictEqual(A.journalSince(entries, ms - 1).length, 1);
  assert.deepStrictEqual(A.journalSince(undefined, ms), []);
});

test('historySince: the last cycles count only the attempt\'s own decisions (at its start included)', () => {
  const history = [{ at: '2022-04-21T16:30:02.000Z', result: 'a' }, { at: START, result: 'b' }, { at: '2022-04-28T13:33:02.000Z', result: 'c' }, { result: 'no time' }];
  assert.deepStrictEqual(A.historySince(history, ms).map(h => h.result), ['b', 'c']);
  assert.strictEqual(A.historySince(history, null), history);
  assert.deepStrictEqual(A.since([1, 2, 3], 2, x => x), [2, 3]);
});

test('wiring: the runner reads its reviewed trades and the attempt\'s start through the scope', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'lib', 'runner-wiring.js'), 'utf8');
  assert.match(src, /recentTrades: \(\{ entries \} = \{\}\) => recentTrades\(journalSince\(entries \|\| journal\(\), historyFrom\(home\)\), 10\)/);
  assert.match(src, /tradesSummary: \(\{ entries \} = \{\}\) => formSummary\(journalSince\(entries \|\| journal\(\), historyFrom\(home\)\), 10\)/);
  assert.match(src, /historyFrom: \(\) => historyFrom\(home\)/);
  const runner = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'lib', 'runner.js'), 'utf8');
  assert.match(runner, /const ownHistory = historySince\(\(state && state\.history\) \|\| \[\], attempt\('the attempt\\'s start', \(\) => historyFrom\(\), null\)\);/);
});
