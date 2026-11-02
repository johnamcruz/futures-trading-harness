'use strict';

// Risk-manager phase 1's live facts and their key (scripts/lib/trading/phase1-facts.js): the smart phase-1 cache serves
// a report only while every live fact it states is what it was; any input missing gives no key; the gateway checks a
// served one against its own reads.
const test = require('node:test');
const assert = require('node:assert');
const P1 = require('../../scripts/lib/trading/phase1-facts');

const BAR = '2026-10-07T14:24:00.000Z';
const CLOSE = Date.parse(BAR) + 180000;
const COOLDOWN = { maxConsecutiveLosses: 2, lossCooldownMin: 30 };
const ACCT = {
  id: '7', balance: 50000, workingOrders: 1,
  positions: [{ contractId: 'MNQ:2026-12', type: 1, size: 3, averagePrice: 21000.25 }],
  orders: [{ id: 9, contractId: 'MNQ:2026-12', type: 4, side: 1, size: 3, stopPrice: 20990 }],
  attempts: [{ account: 'acct_a', status: 'active', balance: 50000, floor: 48000, cushion: 2000, profit: 0, dayPnl: 0, entryBlock: null, sessionsDone: 1, sessionsLeft: 29, budgets: [], facts: { lossStreak: 0 } }],
};
const loss = (min, pnl = -100) => ({ profitAndLoss: pnl, creationTimestamp: new Date(CLOSE - min * 60000).toISOString() });
const IN = { account: ACCT, day: '2026-10-07', trades: [], barClose: CLOSE, barMinutes: 3, cooldown: COOLDOWN, windowEntries: 'allowed', lessons: ['wait for the 15m close'], reviewed: [] };
const key = over => P1.factsKey(P1.phase1Facts({ ...IN, ...over }));

test('the key: the same live facts give the same key whatever their order; each fact changed alone gives another', () => {
  const k = key({});
  assert.match(k, /^[0-9a-f]{64}$/);
  const shuffled = { ...ACCT, positions: [...ACCT.positions].reverse(), attempts: ACCT.attempts.map(a => Object.fromEntries(Object.entries(a).reverse())) };
  assert.strictEqual(key({ account: shuffled }), k, 'order of fields and lists');
  assert.strictEqual(key({ account: { ...ACCT, positions: [{ ...ACCT.positions[0], contractId: 'MNQ' }] } }), k, 'a contract named by its root or its month');
  const changes = {
    balance: { account: { ...ACCT, balance: 49950 } },
    'a position\'s size': { account: { ...ACCT, positions: [{ ...ACCT.positions[0], size: 2 }] } },
    'a position\'s price': { account: { ...ACCT, positions: [{ ...ACCT.positions[0], averagePrice: 21000.5 }] } },
    'flat': { account: { ...ACCT, positions: [] } },
    'a stop moved': { account: { ...ACCT, orders: [{ ...ACCT.orders[0], stopPrice: 20995 }] } },
    'an order gone': { account: { ...ACCT, orders: [], workingOrders: 0 } },
    'the attempt\'s day P&L': { account: { ...ACCT, attempts: [{ ...ACCT.attempts[0], dayPnl: -50 }] } },
    'the attempt\'s entry block': { account: { ...ACCT, attempts: [{ ...ACCT.attempts[0], entryBlock: 'soft daily stop' }] } },
    'the attempt\'s streak': { account: { ...ACCT, attempts: [{ ...ACCT.attempts[0], facts: { lossStreak: 1 } }] } },
    'a new attempt': { account: { ...ACCT, attempts: [...ACCT.attempts, { account: 'acct_b', status: 'active' }] } },
    'the trading day': { day: '2026-10-08' },
    'a losing close': { trades: [loss(60)] },
    'the window': { windowEntries: 'refused: the opening print' },
    'a lesson': { lessons: ['wait for the 15m close', 'skip chop'] },
    'a reviewed trade': { reviewed: ['orb long +1R'] },
    'canTrade off': { account: { ...ACCT, canTrade: false } },
    'trading not allowed to the server': { account: { ...ACCT, mcpTradingAllowed: false } },
    'the room before the daily limit': { account: { ...ACCT, remainingBeforeLimit: 1500 } },
    'a round trip at zero P&L (a fill, no loss)': { trades: [loss(10, 0)] },
  };
  for (const [label, over] of Object.entries(changes)) assert.notStrictEqual(key(over), k, label);
});

test('a loss cooldown is in the key by its remaining whole bars from the bar close: one that ends between two bars is another key', () => {
  // Two losses in a row, the last 20 min before the close: 10 min of the 30 left, 4 bars of 3 min.
  const trades = [loss(40), loss(20)];
  assert.deepStrictEqual(P1.cooldownBars({ trades, barClose: CLOSE, barMinutes: 3, cooldown: COOLDOWN }), { bars: 4, streak: 2, losses: 2, fills: 2 });
  // The next bars: 7, then 4, then 1 min left, then over.
  const at = n => P1.cooldownBars({ trades, barClose: CLOSE + n * 180000, barMinutes: 3, cooldown: COOLDOWN });
  assert.deepStrictEqual([0, 1, 2, 3, 4].map(n => at(n).bars), [4, 3, 2, 1, 0]);
  const k = n => key({ trades, barClose: CLOSE + n * 180000 });
  assert.notStrictEqual(k(3), k(4), 'the cooldown ends between these bars: another key');
  assert.strictEqual(k(4), k(5), 'over: the same key after');
  // One loss (no streak), or a win after: none.
  assert.strictEqual(P1.cooldownBars({ trades: [loss(20)], barClose: CLOSE, barMinutes: 3, cooldown: COOLDOWN }).bars, 0);
  assert.strictEqual(P1.cooldownBars({ trades: [...trades, loss(5, 50)], barClose: CLOSE, barMinutes: 3, cooldown: COOLDOWN }).bars, 0);
  // A streak carried into the day by a running attempt counts.
  assert.strictEqual(P1.cooldownBars({ trades: [loss(20)], carried: { streak: 1, losses: 1, lastLossMs: CLOSE - 50 * 60000 }, barClose: CLOSE, barMinutes: 3, cooldown: COOLDOWN }).bars, 4);
});

test('any input missing or unreadable gives no facts and no key (nothing served, nothing recorded)', () => {
  for (const [label, over] of [
    ['no account', { account: null }], ['an account read that failed', { account: { id: '7', error: 'timeout' } }], ['no balance', { account: { ...ACCT, balance: NaN } }],
    ['positions unknown', { account: { ...ACCT, positions: null } }], ['orders unknown', { account: { ...ACCT, orders: null } }],
    ['fills not read', { trades: null }], ['no bar close', { barClose: NaN }], ['no window state', { windowEntries: null }],
    ['the journal not read', { lessons: null }], ['the reviews not read', { reviewed: null }], ['no day', { day: '' }],
    ['the day\'s room read failed', { account: { ...ACCT, todayError: 'timeout' } }],
  ]) {
    assert.strictEqual(P1.phase1Facts({ ...IN, ...over }), null, label);
    assert.strictEqual(key(over), null, label);
  }
});

test('the runner\'s record: whole only with its own facts\' key, for the cycle\'s bar; unreadable or edited: not', () => {
  const facts = P1.phase1Facts(IN);
  const rec = P1.record({ bar: BAR, barMinutes: 3, facts });
  assert.deepStrictEqual(P1.parseRecord(JSON.stringify(rec)), rec);
  assert.ok(P1.recordHolds(rec, { bar: BAR }));
  assert.ok(!P1.recordHolds(rec, { bar: '2026-10-07T14:27:00.000Z' }), 'another bar');
  assert.ok(!P1.recordHolds({ ...rec, facts: { ...facts, account: { ...facts.account, balance: 1 } } }, { bar: BAR }), 'edited facts');
  assert.ok(!P1.recordHolds(null, { bar: BAR }));
  for (const bad of ['', '{', '[]', JSON.stringify({ ...rec, factsKey: 'x' }), JSON.stringify({ ...rec, barMinutes: 0 }), JSON.stringify({ ...rec, facts: null })]) assert.strictEqual(P1.parseRecord(bad), null, bad);
  assert.strictEqual(P1.record({ bar: BAR, barMinutes: 3, facts: null }), null);
});

test('the gateway\'s check of a served phase 1 against its own reads: the same positions, orders, attempts and day hold; any change, or a read that failed, refuses', () => {
  const rec = P1.record({ bar: BAR, barMinutes: 3, facts: P1.phase1Facts(IN) });
  const now = new Date(CLOSE + 30000);
  const ok = { rec, positions: ACCT.positions, orders: ACCT.orders, running: ['acct_a'], now };
  assert.strictEqual(P1.gateRefusal(ok), null);
  assert.strictEqual(P1.gateRefusal({ ...ok, positions: [{ ...ACCT.positions[0], contractId: 'MNQ' }] }), null, 'named by its root');
  for (const [label, over, why] of [
    ['a position changed (a fill)', { positions: [{ ...ACCT.positions[0], size: 1 }] }, /positions changed/],
    ['flat now', { positions: [] }, /positions changed/],
    ['an order changed', { orders: [{ ...ACCT.orders[0], stopPrice: 20995 }] }, /working orders changed/],
    ['an order added', { orders: [...ACCT.orders, { id: 10, contractId: 'MNQ', type: 1, side: 1, size: 3, limitPrice: 21010 }] }, /working orders changed/],
    ['positions not read', { positions: null }, /could not be read/],
    ['orders not read', { orders: undefined }, /could not be read/],
    ['another trading day', { now: new Date('2026-10-08T14:30:00.000Z') }, /trading day/],
    ['an attempt started since', { running: ['acct_a', 'acct_b'] }, /acct_b/],
    ['no record', { rec: null }, /missing/],
  ]) assert.match(P1.gateRefusal({ ...ok, ...over }) || '', why, label);
});

test('gateViolations: the gateway\'s [phase1-cache] for an entry only when phase 1 counts as cached; nothing otherwise', () => {
  const rec = P1.record({ bar: BAR, barMinutes: 3, facts: P1.phase1Facts(IN) });
  const now = new Date(CLOSE + 30000);
  const reads = { positions: ACCT.positions, orders: ACCT.orders, running: ['acct_a'], now };
  const cfg = { cycleCached: ['market-structure-analyst', 'risk-manager'], cyclePhase1: rec };
  assert.deepStrictEqual(P1.gateViolations(cfg, reads), []);
  const stale = P1.gateViolations(cfg, { ...reads, positions: [] });
  assert.deepStrictEqual(stale.map(v => v.check), ['phase1-cache']);
  assert.match(stale[0].message, /positions changed[^]*phase 1 runs again next cycle/);
  assert.deepStrictEqual(P1.gateViolations({ ...cfg, cyclePhase1: null }, reads).map(v => v.check), ['phase1-cache'], 'counted with no record: refused');
  assert.deepStrictEqual(P1.gateViolations({ cycleCached: ['market-structure-analyst'], cyclePhase1: null }, { ...reads, positions: null }), [], 'not cached: nothing to check');
  assert.deepStrictEqual(P1.gateViolations(null, reads), []);
});

test('an absent trading flag or room is a fact of its own: the same key while absent, another once the server gives one', () => {
  const absent = key({ account: { ...ACCT, canTrade: undefined, mcpTradingAllowed: undefined, remainingBeforeLimit: undefined } });
  assert.strictEqual(absent, key({ account: { ...ACCT, canTrade: null, mcpTradingAllowed: null, remainingBeforeLimit: null } }));
  assert.notStrictEqual(absent, key({ account: { ...ACCT, canTrade: true } }));
  assert.notStrictEqual(absent, key({ account: { ...ACCT, remainingBeforeLimit: 2000 } }));
});

test('contracts always count (fail closed): a broker id nothing names never matches a standard name, even with every other field equal; any other field still refuses', () => {
  const rec = P1.record({ bar: BAR, barMinutes: 3, facts: P1.phase1Facts({ ...IN, account: { ...ACCT, positions: [{ contractId: 'MNQ:2026-12', type: 1, size: 3, averagePrice: 21000.25 }], orders: [{ id: 9, contractId: 'MNQ', type: 4, side: 1, size: 3, stopPrice: 20990 }] } }) });
  const now = new Date(CLOSE + 30000);
  const raw = 'BRK-77X'; // a broker's own id the translator's cache doesn't name
  const ok = { rec, positions: [{ contractId: raw, type: 1, size: 3, averagePrice: 21000.25 }], orders: [{ id: 9, contractId: raw, type: 4, side: 1, size: 3, stopPrice: 20990 }], running: ['acct_a'], now };
  assert.match(P1.gateRefusal(ok) || '', /positions changed/, 'a position named two ways is refused (fail closed)');
  const same = { ...ok, positions: [{ ...ok.positions[0], contractId: 'MNQ:2026-12' }], orders: [{ ...ok.orders[0], contractId: 'MNQ' }] };
  assert.strictEqual(P1.gateRefusal(same), null, 'the same position and order, named the same way');
  assert.match(P1.gateRefusal({ ...same, orders: [{ ...same.orders[0], contractId: raw }] }) || '', /working orders changed/);
  assert.match(P1.gateRefusal({ ...same, positions: [{ ...same.positions[0], size: 2 }] }) || '', /positions changed/);
  assert.match(P1.gateRefusal({ ...same, orders: [{ ...same.orders[0], stopPrice: 20995 }] }) || '', /working orders changed/);
  // Both named: the contract counts (a position on another root is another position).
  assert.match(P1.gateRefusal({ ...same, positions: [{ ...same.positions[0], contractId: 'MES' }] }) || '', /positions changed/);
});
