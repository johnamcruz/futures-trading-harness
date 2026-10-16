'use strict';

// The preflight's broker-limits check (learning/broker-limits.js, preflight.js brokerLimits): the replay broker's
// get_server_config limits against the account's max_contracts and daily_loss_limit.

const test = require('node:test');
const assert = require('node:assert');
const P = require('../../scripts/lib/learning/preflight');
const { compareLimits } = require('../../scripts/lib/learning/broker-limits');
const { accountLimits } = require('../../scripts/lib/trading/accounts');

const ACCOUNT = { name: 'acct', daily_loss_limit: 2000, max_contracts: { MNQ: 100 } };
const DEFAULT_BROKER = { replay: true, maxOrderSize: 1, maxPositionSize: 2, maxDailyLoss: 500 };
const GOOD = { replay: true, maxOrderSize: 100, maxPositionSize: 100, maxDailyLoss: 2000 };

const MAPPED = { name: 'sim', replay: true, limits: { dailyLoss: 'A', maxOrderSize: 'B', maxPositionSize: 'C' } };
// The run's own limits (the replay config's `limits`: accountLimits of the account the run uses). `over` sets run fields.
const ctx = (brokerConfig, account = ACCOUNT, entry = MAPPED, over = {}) => ({
  run: { learning: false, cfg: { symbols: ['MNQ'] }, limits: account ? accountLimits(account, ['MNQ']) : null, ...over },
  read: {
    // The strategy's account is NOT the run's: the check must not read it.
    strategies: () => [{ name: 'prop_portfolio', account: 'other' }],
    accountProfile: () => { throw new Error('the check reads the run\'s limits, not an account'); },
    brokerConfig: () => brokerConfig,
    brokerEntry: () => entry,
  },
});
const limitsOf = (brokerConfig, account, entry, over) => P.brokerLimits(ctx(brokerConfig, account, entry, over));
const LEARNING = { learning: true };

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

test('(not learning) an account with no cap for the run\'s symbols leaves the sizes N/A', () => {
  const none = { ...ACCOUNT, max_contracts: { ES: 5 } };
  const x = compareLimits({ config: GOOD, want: accountLimits(none, ['MNQ']), entry: MAPPED });
  assert.strictEqual(x.status, P.PASS);
  assert.match(x.detail, /the account states no contract cap for MNQ/);
});

test('a non-replay broker is N/A without starting its server; an unreadable replay broker WARNs, off a learning run', () => {
  assert.strictEqual(limitsOf({ ...DEFAULT_BROKER, replay: undefined }, ACCOUNT, { name: 'live', replay: false }).status, P.NA);
  const c = ctx(DEFAULT_BROKER, ACCOUNT, { name: 'live', replay: false });
  c.read.brokerConfig = () => { throw new Error('the live broker\'s server must not be started'); };
  assert.strictEqual(P.brokerLimits(c).status, P.NA);
  const w = limitsOf({ error: 'spawn failed' });
  assert.strictEqual(w.status, P.WARN);
  assert.strictEqual(P.runChecks(ctx({ error: 'x' }), [P.brokerLimits]).ok, true);
});

test('a learning run on a replay broker that can\'t be read FAILs (practice equals live); a live broker stays N/A', () => {
  const x = limitsOf({ error: 'spawn failed' }, ACCOUNT, MAPPED, LEARNING);
  assert.strictEqual(x.status, P.FAIL);
  assert.match(x.detail, /could not be read \(spawn failed\).*learning run/);
  assert.strictEqual(P.runChecks(ctx({ error: 'x' }, ACCOUNT, MAPPED, LEARNING), [P.brokerLimits]).ok, false);
  // The gate's learning flag counts too.
  const g = ctx({ error: 'x' });
  g.gate = { learning: true };
  assert.strictEqual(P.brokerLimits(g).status, P.FAIL);
  assert.strictEqual(limitsOf({ error: 'x' }, ACCOUNT, { name: 'live', replay: false }, LEARNING).status, P.NA);
});

test('the check compares with the account the run uses (run.limits), not the policy strategy\'s', () => {
  // The run's account (--prop X) caps at 100; the policy strategy names account Y (here: "other", never read).
  const X = { name: 'X', daily_loss_limit: 2000, max_contracts: { MNQ: 100 } };
  assert.strictEqual(limitsOf({ ...GOOD, maxOrderSize: 50, maxPositionSize: 50 }, X).status, P.FAIL, 'X caps at 100');
  assert.strictEqual(limitsOf(GOOD, X).status, P.PASS);
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

test('per-symbol caps: the broker is held to the strictest, and the detail says so', () => {
  const two = { ...ACCOUNT, max_contracts: { MNQ: 100, MES: 40 } };
  const want = accountLimits(two, ['MNQ', 'MES']);
  assert.deepStrictEqual([want.maxOrderSize, want.maxPositionSize, want.symbol], [40, 40, 'MES']);
  const c = (config) => compareLimits({ config, want, entry: MAPPED });
  assert.strictEqual(c({ ...GOOD, maxOrderSize: 40, maxPositionSize: 40 }).status, P.PASS);
  const x = c({ ...GOOD, maxOrderSize: 39, maxPositionSize: 100 });
  assert.strictEqual(x.status, P.FAIL);
  assert.match(x.detail, /maxOrderSize 39 is below the account's max_contracts 40 \(MES\) \(the strictest of MNQ 100, MES 40/);
  // One symbol stated, one not: the stated cap rules, the other is listed.
  assert.deepStrictEqual(accountLimits(ACCOUNT, ['MNQ', 'MES']).missing, ['MES']);
});

test('no size stated: a learning run FAILs ("states no contract cap"), any other run leaves the sizes not judged', () => {
  const none = { ...ACCOUNT, max_contracts: { ES: 5 } };
  const l = limitsOf(GOOD, none, MAPPED, LEARNING);
  assert.strictEqual(l.status, P.FAIL);
  assert.match(l.detail, /the account states no contract cap for MNQ/);
  assert.match(l.detail, /maxOrderSize.*maxPositionSize/);
  assert.strictEqual(limitsOf(GOOD, none).status, P.PASS);
  // Even a broker that exposes no size does not let a learning run through on defaults.
  assert.strictEqual(limitsOf({ replay: true, maxDailyLoss: 2000 }, none, MAPPED, LEARNING).status, P.FAIL);
});
