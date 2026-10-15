'use strict';

// The preflight's broker-limits check (learning/broker-limits.js, preflight.js brokerLimits): the replay broker's
// get_server_config limits against the account's max_contracts and daily_loss_limit.

const test = require('node:test');
const assert = require('node:assert');
const P = require('../../scripts/lib/learning/preflight');
const { compareLimits } = require('../../scripts/lib/learning/broker-limits');

const ACCOUNT = { name: 'acct', daily_loss_limit: 2000, max_contracts: { MNQ: 100 } };
const DEFAULT_BROKER = { replay: true, maxOrderSize: 1, maxPositionSize: 2, maxDailyLoss: 500 };
const GOOD = { replay: true, maxOrderSize: 100, maxPositionSize: 100, maxDailyLoss: 2000 };

const MAPPED = { name: 'sim', replay: true, limits: { dailyLoss: 'A', maxOrderSize: 'B', maxPositionSize: 'C' } };
const ctx = (brokerConfig, account = ACCOUNT, entry = MAPPED) => ({
  run: { cfg: { symbols: ['MNQ'] } },
  read: {
    strategies: () => [{ name: 'prop_portfolio', account: 'acct' }],
    accountProfile: () => account,
    brokerConfig: () => brokerConfig,
    brokerEntry: () => entry,
  },
});
const limitsOf = (brokerConfig, account, entry) => P.brokerLimits(ctx(brokerConfig, account, entry));

test('a broker on its default limits FAILs, naming each limit and where to change it', () => {
  const x = limitsOf(DEFAULT_BROKER);
  assert.strictEqual(x.status, P.FAIL);
  for (const s of ['maxOrderSize 1', 'maxPositionSize 2', 'maxDailyLoss $500', 'max_contracts 100', 'daily_loss_limit $2000', 'mcp-configs/README.md']) {
    assert.ok(x.detail.includes(s), `${s}: ${x.detail}`);
  }
});

test('matching limits PASS; a larger size is fine, a different daily loss is not', () => {
  assert.strictEqual(limitsOf(GOOD).status, P.PASS);
  assert.strictEqual(limitsOf({ ...GOOD, maxOrderSize: 500, maxPositionSize: 500 }).status, P.PASS);
  const x = limitsOf({ ...GOOD, maxDailyLoss: 'off' });
  assert.deepStrictEqual([x.status, /maxDailyLoss off differs/.test(x.detail)], [P.FAIL, true]);
  assert.strictEqual(limitsOf({ ...GOOD, maxDailyLoss: 1000 }).status, P.FAIL);
});

test('an account with no daily limit matches a broker with it off', () => {
  assert.strictEqual(limitsOf({ ...GOOD, maxDailyLoss: 'off' }, { ...ACCOUNT, daily_loss_limit: 0 }).status, P.PASS);
});

test('a limit the server does not expose is N/A, never guessed', () => {
  const some = limitsOf({ replay: true, maxDailyLoss: 2000 });
  assert.strictEqual(some.status, P.PASS);
  assert.match(some.detail, /not judged: maxOrderSize.*maxPositionSize/);
  assert.strictEqual(limitsOf({ replay: true }).status, P.NA);
  const bad = limitsOf({ replay: true, maxDailyLoss: 500 });
  assert.deepStrictEqual([bad.status, /maxOrderSize \(get_server_config gives none\)/.test(bad.detail)], [P.FAIL, true]);
});

test('an account with no cap for the run\'s symbols leaves the sizes N/A', () => {
  const x = compareLimits({ config: GOOD, account: { ...ACCOUNT, max_contracts: { ES: 5 } }, symbols: ['MNQ'] });
  assert.strictEqual(x.status, P.PASS);
  assert.match(x.detail, /the account states no max_contracts for MNQ/);
});

test('a non-replay broker is N/A and an unreadable one a WARN: neither refuses the run', () => {
  assert.strictEqual(limitsOf({ ...DEFAULT_BROKER, replay: undefined }).status, P.NA);
  const w = limitsOf({ error: 'spawn failed' });
  assert.strictEqual(w.status, P.WARN);
  assert.strictEqual(P.runChecks(ctx({ error: 'x' }), [P.brokerLimits]).ok, true);
});

test('the check is in CHECKS, and removing it (a mutation) is what lets default limits through', () => {
  const c = ctx(DEFAULT_BROKER);
  assert.ok(P.CHECKS.includes(P.brokerLimits));
  assert.strictEqual(P.runChecks(c, [P.brokerLimits]).ok, false);
  assert.strictEqual(P.runChecks(c, [P.brokerLimits].filter(f => f !== P.brokerLimits)).ok, true);
});

test('a replay broker whose brokers.json entry maps no limit variable FAILs clearly, read or not', () => {
  for (const entry of [{ name: 'sim', replay: true }, { name: 'sim', replay: true, limits: { dailyLoss: 'A' } }]) {
    const x = limitsOf(GOOD, ACCOUNT, entry);
    assert.strictEqual(x.status, P.FAIL);
    assert.match(x.detail, /no limits\.(dailyLoss, limits\.)?maxOrderSize.*brokers\.json/);
    assert.strictEqual(limitsOf({ error: 'x' }, ACCOUNT, entry).status, P.FAIL);
  }
  assert.deepStrictEqual(require('../../scripts/lib/learning/broker-limits').missingMapping({ limits: { dailyLoss: 'A' } }), ['maxOrderSize', 'maxPositionSize']);
});

test('a live broker needs no mapping: its limits are its own (N/A)', () => {
  const x = limitsOf({ replay: undefined, maxOrderSize: 1 }, ACCOUNT, { name: 'live', replay: false });
  assert.strictEqual(x.status, P.NA);
});
