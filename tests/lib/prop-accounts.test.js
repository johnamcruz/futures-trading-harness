'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { tmpDir } = require('../helpers');
const prop = require('../../scripts/lib/trading/prop-state');
const { propAccountMarks, propAccountRefusal } = require('../../scripts/lib/trading/prop-accounts');

const NOW = new Date('2026-10-07T14:00:00Z');
const P100 = { name: 'p100', valid: true, starting_balance: 100000, max_loss: 3000, profit_target: 6000 };
const P50 = { name: 'p50', valid: true, starting_balance: 50000, max_loss: 2000, profit_target: 3000 };
const ACCOUNTS = [P100, P50, { name: 'broken', valid: false, errors: ['max_loss: required'] }];
const broker = propAccounts => ({ name: 'sim', ...(propAccounts === undefined ? {} : { propAccounts }) });

test('prop account marks: none without the key; ids normalized; every malformed marker is an error with no marks', () => {
  assert.deepStrictEqual(propAccountMarks(broker()), { marks: {}, error: null });
  assert.deepStrictEqual(propAccountMarks(null), { marks: {}, error: null });
  assert.deepStrictEqual(propAccountMarks(broker({})), { marks: {}, error: null });
  assert.deepStrictEqual(propAccountMarks(broker({ '007': 'p100', 12: 'p50' })), { marks: { 7: 'p100', 12: 'p50' }, error: null });
  for (const [raw, why] of [
    [null, /is not an object \(got null\)/],
    [[], /is not an object/],
    ['12345', /is not an object/],
    [{ abc: 'p100' }, /"abc", which is not an account id/],
    [{ '-1': 'p100' }, /not an account id/],
    [{ 7: '' }, /maps account 7 to "", which is not an account profile name/],
    [{ 7: 'P100' }, /not an account profile name/],
    [{ 7: '../p100' }, /not an account profile name/],
    [{ 7: ['p100'] }, /not an account profile name/],
    [{ 7: 'p100', '007': 'p50' }, /lists account 7 twice/],
    [{ 7: 'p100', 8: 'p100' }, /marks accounts 7 and 8 under one profile, p100/],
    [{ 7: 'constructor', 8: 'constructor' }, /under one profile, constructor/],
  ]) {
    const m = propAccountMarks(broker(raw));
    assert.deepStrictEqual(m.marks, {}, JSON.stringify(raw));
    assert.match(m.error, why, JSON.stringify(raw));
    assert.match(m.error, /^broker "sim": "propAccounts" in brokers\.json/);
  }
  // A profile named like an object property is just a name (no false "one profile" refusal).
  assert.deepStrictEqual(propAccountMarks(broker({ 7: 'constructor' })), { marks: { 7: 'constructor' }, error: null });
});

test('prop account refusal: unmarked accounts and brokers are never refused; a marked account enters only while its profile\'s attempt runs', () => {
  const home = tmpDir();
  const at = (b, accountId, strategy = null) => propAccountRefusal({ broker: broker(b), accountId, home, accounts: ACCOUNTS, strategy });
  // Unmarked: no key, an empty map, or another account.
  assert.strictEqual(at(undefined, 7), null);
  assert.strictEqual(at(undefined, undefined), null, 'no marks: an order without an id is not this check\'s');
  assert.strictEqual(at({}, 7), null);
  assert.strictEqual(at({ 9: 'p100' }, 7), null);
  // Marked, no attempt: refused, saying the start is the user's.
  const none = at({ 7: 'p100' }, '007');
  assert.match(none, /account 7 is a p100 prop account and no p100 attempt is running/);
  assert.match(none, /Starting one is the user's: node scripts\/combine\.js start --account p100/);
  // Another profile's attempt doesn't count.
  prop.startAttempt(home, P50, NOW);
  assert.match(at({ 7: 'p100' }, 7), /no p100 attempt is running/);
  // Its own profile's attempt: this check passes.
  prop.startAttempt(home, P100, NOW);
  assert.strictEqual(at({ 7: 'p100' }, 7), null);
  assert.strictEqual(at({ 7: 'p100' }, 7, { name: 'pol', account: 'p100' }), null);
  // Wrong profile: a strategy sized for another profile, with both attempts running.
  assert.match(at({ 7: 'p100' }, 7, { name: 'pol', account: 'p50' }), /setup:pol is sized for the p50 profile, but account 7 is marked as a p100 prop account/);
  // A strategy that names no account (a composed or rules entry) is judged by the attempt alone.
  assert.strictEqual(at({ 7: 'p100' }, 7, { name: 'trade_lifecycle' }), null);
  // The attempt ended: refused again.
  prop.endAttempt(home, 'p100', NOW);
  assert.match(at({ 7: 'p100' }, 7), /no p100 attempt is running/);
});

test('prop account refusal: fails closed on a malformed marker, a missing or invalid profile, or an order with no account id', () => {
  const home = tmpDir();
  prop.startAttempt(home, P100, NOW);
  const at = (b, accountId) => propAccountRefusal({ broker: broker(b), accountId, home, accounts: ACCOUNTS });
  // Malformed: every entry, on any account.
  for (const id of [7, 9, undefined]) assert.match(at({ 7: 'p100', 8: 'p100' }, id), /under one profile, p100.*Every entry is refused until it is fixed/);
  assert.match(at([], 9), /is not an object/);
  // With any mark, an order naming no valid account can't be told apart.
  for (const id of [undefined, null, '', 'abc', 1.5]) assert.match(at({ 7: 'p100' }, id), /names no valid accountId/, String(id));
  // The marked profile unknown or invalid.
  assert.match(at({ 7: 'p999' }, 7), /under "p999", which is not an account profile/);
  assert.match(at({ 7: 'broken' }, 7), /under "broken", which is an invalid account profile \(max_loss: required\)/);
  assert.match(propAccountRefusal({ broker: broker({ 7: 'p100' }), accountId: 7, home }), /not an account profile/, 'no profiles loaded');
});

test('misplaced prop accounts: a propAccounts key the gate never reads is named with where it sits and what is in force; the active broker\'s own is not', () => {
  const fs = require('fs');
  const path = require('path');
  const { misplacedPropAccounts } = require('../../scripts/lib/trading/prop-accounts');
  const home = tmpDir();
  const own = path.join(home, 'brokers.json');
  const write = (file, cfg) => fs.writeFileSync(file, JSON.stringify(cfg));
  const env = { FTH_HOME: home };
  const at = (file = own) => misplacedPropAccounts(env, { file, broker: 'sim' });
  // None anywhere, a missing file, an unreadable one: nothing.
  assert.deepStrictEqual(at(), []);
  write(own, { broker: 'sim', brokers: { sim: { propAccounts: { 7: 'p100' } } } });
  assert.deepStrictEqual(at(), [], 'under the active broker: read, not misplaced');
  fs.writeFileSync(own, '{ not json');
  assert.deepStrictEqual(at(), []);
  // At the top level.
  write(own, { broker: 'sim', propAccounts: { 7: 'p100' }, brokers: { sim: {} } });
  assert.deepStrictEqual(at(), [`"propAccounts" found at the top level of ${own}: the active broker is "sim" in ${own}, and only its entry's "propAccounts" is read`]);
  // Under another broker's entry.
  write(own, { broker: 'sim', brokers: { sim: {}, other: { propAccounts: { 7: 'p100' } } } });
  assert.deepStrictEqual(at(), [`"propAccounts" found under broker "other" in ${own}: the active broker is "sim" in ${own}, and only its entry's "propAccounts" is read`]);
  // The home's file while FTH_BROKERS_FILE names another: every key in it, the active broker's too.
  const other = path.join(tmpDir(), 'brokers.json');
  write(other, { broker: 'sim', brokers: { sim: {} } });
  write(own, { brokers: { sim: { propAccounts: { 7: 'p100' } } } });
  assert.deepStrictEqual(at(other), [`"propAccounts" found under broker "sim" in ${own} (FTH_BROKERS_FILE names another file, so it isn't read): the active broker is "sim" in ${other}, and only its entry's "propAccounts" is read`]);
  // The file in force with its own misplaced key, and the home's: both named.
  write(other, { broker: 'sim', propAccounts: {}, brokers: { sim: {} } });
  assert.strictEqual(at(other).length, 2);
});
