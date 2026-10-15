'use strict';

const test = require('node:test');
const assert = require('node:assert');
const combine = require('../../scripts/lib/trading/combine');
const at = require('../../scripts/lib/prop/attempts');
const { rng } = require('../../scripts/lib/prop/stats');

// MNQ: tick 0.25, $0.50 a tick. A fixed size of 10 micros: $5 a tick, $7.40 of fees a round trip.
const account = (extra = {}) => ({
  name: 'unit', starting_balance: 50000, profit_target: 1000, max_loss: 1000, max_loss_mode: 'trailing_eod', daily_loss_limit: 600,
  daily_loss_soft: 0, consistency_pct: 0, sessions: 5, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 }, ...extra,
});
const trade = (move, extra = {}) => ({
  symbol: 'MNQ', tickValue: 0.5, tickSize: 0.25, stopTicks: 20, moveTicks: move,
  troughTicks: move < 0 ? [move] : [], overshootTicks: null, noStop: null, facts: {}, ...extra,
});
const ten = () => ({ root: 'MNQ', size: 10, riskPerContract: 11.24 });
const ctx = (extra = {}) => ({ account: account(extra.account), sizing: combine.DEFAULT_SIZING, size: ten, mode: 'micro', legsOf: t => at.legsFor(account(), t.symbol, { tickValue: t.tickValue }), ...extra, ...(extra.account ? { account: account(extra.account) } : {}) });
const days = (...perDay) => perDay.map((trades, k) => ({ day: `2022-03-${String(k + 1).padStart(2, '0')}`, trades }));

test('attempts: a pass on the day the profit reaches the target (60 ticks x $5 - $7.40 = $292.60 a day: day 4)', () => {
  const o = at.runAttempt(days([trade(60)], [trade(60)], [trade(60)], [trade(60)], [trade(60)]), ctx());
  assert.deepStrictEqual([o.status, o.sessions, o.profit, o.taken], ['passed', 4, 1170.4, 4]);
});

test('attempts: the consistency rule holds a pass back while the best day is over half the profit', () => {
  const big = [trade(210)]; // $1,042.60: the target in one day
  assert.strictEqual(at.runAttempt(days(big, [], [], [], []), ctx()).status, 'passed');
  const o = at.runAttempt(days(big, [], [], [], []), ctx({ account: { consistency_pct: 50 } }));
  assert.deepStrictEqual([o.status, o.sessions], ['timeout', 5]);
});

test('attempts: a trough to the floor blows the account, liquidated at the floor a tick against the trade', () => {
  // -250 ticks: -$1,257.40 at the worst, past the $1,000 cushion. At the floor: floor((-1000 + 7.40) / 5) = -199 ticks.
  const o = at.runAttempt(days([trade(30, { troughTicks: [-250] })], [trade(60)]), ctx({ account: { daily_loss_limit: 0 } }));
  assert.deepStrictEqual([o.status, o.sessions, o.profit, o.taken], ['blown', 0, -1002.4, 1]);
  // A trough past both the floor and the $600 daily limit is a blow: the floor is checked first, as the engine does.
  const both = at.runAttempt(days([trade(30, { troughTicks: [-250] })], [trade(60)]), ctx());
  assert.deepStrictEqual([both.status, both.profit], ['blown', -1002.4]);
});

test('attempts: the firm\'s daily limit flattens the trade and stops the day, not the attempt; the path\'s order decides', () => {
  // -150 ticks first (-$757.40, past the $600 daily limit, inside the $1,000 cushion): flattened at -119 ticks (-$602.40).
  const t = trade(30, { troughTicks: [-150, -250] });
  const o = at.runAttempt(days([t, trade(60)], [trade(60)]), ctx({ account: { sessions: 2 } }));
  assert.deepStrictEqual([o.status, o.sessions, o.profit, o.taken, o.skipped], ['timeout', 2, -309.8, 2, 1]);
});

test('attempts: timeout after `sessions` days; unfinished when the days run out first', () => {
  assert.deepStrictEqual(at.runAttempt(days([trade(5)], [trade(5)], [trade(5)], [trade(5)], [trade(5)], [trade(5)]), ctx()).status, 'timeout');
  assert.strictEqual(at.runAttempt(days([trade(5)], [trade(5)]), ctx()).status, 'unfinished');
});

test('attempts: the rulebook multiplier skips at 0 and passes its fraction to the injected sizing', () => {
  const seen = [];
  const size = a => { seen.push(a.fraction); return ten(); };
  const o = at.runAttempt(days([trade(60, { facts: { roomR: 0.5 } }), trade(60, { facts: { roomR: 3 } })]), ctx({
    size, multiplier: t => (t.facts.roomR >= 2 ? 0.5 : 0), account: { sessions: 1 },
  }));
  assert.deepStrictEqual(seen, [0.5]);
  assert.deepStrictEqual([o.taken, o.skipped], [1, 1]);
  // A multiplier that isn't a number above 0 fails closed: skipped.
  assert.strictEqual(at.runAttempt(days([trade(60)]), ctx({ multiplier: () => NaN, account: { sessions: 1 } })).taken, 0);
});

test('attempts: the default sizing is today\'s contractPlan from the budget and the room (the gate\'s and the engine\'s)', () => {
  const a = account();
  const cs = combine.start(a);
  const { legs, ratio } = at.legsFor(a, 'MNQ', { tickValue: 0.5 });
  const t = trade(10);
  const plan = mode => at.defaultSize({ cs, trade: t, sizing: combine.DEFAULT_SIZING, legs, mode, ratio, fraction: 1 });
  // 0.2 x $1,000 = $200 budget; (20 + 1) x $0.50 + $0.74 = $11.24 a micro: 17 micros, or (auto) 1 NQ.
  assert.deepStrictEqual(plan('auto'), combine.contractPlan({ dollars: 200, room: 600, stopTicks: 20, legs, mode: 'auto', fraction: 1, ratio, slipTicks: 1 }));
  assert.deepStrictEqual([plan('micro').root, plan('micro').size, plan('auto').root, plan('auto').size], ['MNQ', 17, 'NQ', 1]);
  assert.deepStrictEqual(Object.keys(legs), ['micro', 'mini']);
  assert.deepStrictEqual([legs.micro.root, legs.mini.root, legs.mini.fee, legs.mini.max], ['MNQ', 'NQ', 1.4, 5]);
});

test('attempts: entry blocks and the realized daily stop skip trades', () => {
  const o = at.runAttempt(days([trade(-30), trade(-30), trade(60)]), ctx({ account: { daily_loss_soft: 250, sessions: 1 } }));
  // -30 ticks: -$157.40 each; after two (-$314.80) the soft limit ($250) blocks the third.
  assert.deepStrictEqual([o.taken, o.skipped], [2, 1]);
  const m = at.runAttempt(days([trade(-30), trade(-30), trade(60)]), ctx({ maxDailyLoss: 150, account: { sessions: 1 } }));
  assert.deepStrictEqual([m.taken, m.skipped], [1, 2]);
});

test('attempts: the order gate\'s daily loss count (FTH_MAX_DAILY_LOSSES) refuses the day\'s entries after it, as live', () => {
  const gate = { maxDailyLosses: 3, maxConsecutiveLosses: 99, lossCooldownMin: 0 };
  // Losses and wins alternating (no streak): the fourth entry after the third loss is refused.
  const list = [trade(-5), trade(10), trade(-5), trade(10), trade(-5), trade(10)];
  const why = [];
  const o = at.runAttempt(days(list), ctx({ gate, account: { sessions: 1 }, onSkip: x => why.push(x.why) }));
  assert.deepStrictEqual([o.taken, o.skipped, why], [5, 1, ['daily-losses']]);
  // A scratch loses its fees: a loss to the gate's count too (net, as attemptFacts counts it).
  const s = at.runAttempt(days([trade(-5), trade(0), trade(10), trade(-5), trade(10)]), ctx({ gate, account: { sessions: 1 } }));
  assert.deepStrictEqual([s.taken, s.skipped], [4, 1]);
  assert.strictEqual(at.runAttempt(days(list), ctx({ gate: null, account: { sessions: 1 } })).taken, 6, 'null: off (a test isolating another rule)');
  // The next day starts afresh.
  assert.strictEqual(at.runAttempt(days(list, [trade(10)]), ctx({ gate, account: { sessions: 2 } })).taken, 6);
});

test('attempts: the order gate\'s loss-streak cooldown (FTH_MAX_CONSECUTIVE_LOSSES, FTH_LOSS_COOLDOWN_MIN), by the time into the session', () => {
  const gate = { maxDailyLosses: 99, maxConsecutiveLosses: 2, lossCooldownMin: 30 };
  const timed = (move, entry, exit, day = '2022-03-01') => trade(move, { entryTime: `${day}T${entry}:00.000Z`, exitTime: `${day}T${exit}:00.000Z` });
  const why = [];
  const run = list => at.runAttempt(days(list), ctx({ gate, account: { sessions: 1 }, onSkip: x => why.push(x.why) }));
  const two = [timed(-5, '14:00', '14:10'), timed(-5, '14:12', '14:20')];
  assert.deepStrictEqual([run([...two, timed(10, '14:40', '14:45')]).taken, why], [2, ['loss-cooldown']], '20 minutes after the second loss: cooling down');
  assert.strictEqual(run([...two, timed(10, '14:50', '14:55')]).taken, 3, '30 minutes after: allowed');
  assert.strictEqual(run([...two, trade(10)]).taken, 2, 'no time on the entry: can\'t show the cooldown passed, refused (fails closed)');
  assert.strictEqual(run([timed(-5, '14:00', '14:10'), timed(10, '14:12', '14:15'), timed(-5, '14:16', '14:20'), timed(10, '14:22', '14:25')]).taken, 4, 'a win ends the streak');
  // A reweighted day joins trades of different dates: the time into each one's session, never the calendar.
  const mixed = [timed(-5, '14:00', '14:10', '2022-03-01'), timed(-5, '14:12', '14:20', '2022-03-02')];
  assert.strictEqual(run([...mixed, timed(10, '14:40', '14:45', '2022-03-03')]).taken, 2);
  assert.strictEqual(run([...mixed, timed(10, '14:50', '14:55', '2022-02-22')]).taken, 3);
});

test('attempts: the gate\'s limits are the live gate\'s config (trading/config.js loadConfig, the same env), and the default', () => {
  const { loadConfig } = require('../../scripts/lib/trading/config');
  const c = loadConfig({});
  assert.deepStrictEqual(at.gateLimits({}), { maxDailyLosses: c.maxDailyLosses, maxConsecutiveLosses: c.maxConsecutiveLosses, lossCooldownMin: c.lossCooldownMin });
  assert.deepStrictEqual(at.gateLimits({ FTH_MAX_DAILY_LOSSES: '2', FTH_MAX_CONSECUTIVE_LOSSES: '4', FTH_LOSS_COOLDOWN_MIN: '45' }), { maxDailyLosses: 2, maxConsecutiveLosses: 4, lossCooldownMin: 45 });
  // No gate given: the env's (as live), never off.
  const list = Array.from({ length: c.maxDailyLosses + 1 }, () => trade(-5));
  assert.strictEqual(at.runAttempt(days(list), ctx({ account: { sessions: 1, daily_loss_limit: 0 } })).taken, Math.min(c.maxDailyLosses, c.maxConsecutiveLosses));
});

test('attempts: an expectancy cut takes cut x E R off every trade, deeper exits becoming troughs; none when E <= 0', () => {
  const trades = [trade(40), trade(-20)]; // E = (2 - 1) / 2 = 0.5 R
  const eR = at.expectancyR(trades);
  assert.strictEqual(eR, 0.5);
  const c = at.cutTrade(trade(-20), 0.5, eR); // -20 - 0.5 x 0.5 x 20 = -25
  assert.deepStrictEqual([c.moveTicks, c.troughTicks], [-25, [-20, -25]]);
  assert.deepStrictEqual(at.cutTrade(trade(40), 0.25, eR).moveTicks, 37.5);
  assert.deepStrictEqual(at.cutTrade(trade(40), 0.5, -0.1).moveTicks, 40);
});

test('attempts: stop overshoots are redrawn from the market\'s observed ones; a stop fault runs the trade to its day\'s end', () => {
  const stopped = trade(-23, { overshootTicks: 2, troughTicks: [-10, -23] }); // a 20-tick stop, a tick of slippage, 2 past
  const pools = at.overshootPools([stopped, trade(5), { ...stopped, overshootTicks: 40 }]);
  assert.deepStrictEqual(pools.get('MNQ'), [2, 40]);
  const r = rng(3);
  const seen = new Set();
  for (let k = 0; k < 50; k += 1) seen.add(at.redrawOvershoot(stopped, pools.get('MNQ'), r).moveTicks);
  assert.deepStrictEqual([...seen].sort((a, b) => a - b), [-61, -23]);
  const deep = at.redrawOvershoot(stopped, [40], r);
  assert.deepStrictEqual(deep.troughTicks, [-10, -61]);
  assert.strictEqual(at.redrawOvershoot(trade(5), [40], r).moveTicks, 5, 'only stop exits');
  const f = at.stopFault(trade(30, { troughTicks: [-5], noStop: { worstTicks: -300, closeTicks: -120 } }));
  assert.deepStrictEqual([f.moveTicks, f.troughTicks], [-120, [-5, -300]]);
  assert.strictEqual(at.stopFault(trade(30)), null, 'no recorded path: no fault to inject');
});

test('attempts: a runner outage leaves the day\'s first trade unprotected and takes no more that day', () => {
  const t = trade(30, { noStop: { worstTicks: -250, closeTicks: -100 } });
  const o = at.runAttempt(days([t, trade(60)]), ctx({ outageDay: d => d === 0, account: { daily_loss_limit: 0, sessions: 1 } }));
  assert.deepStrictEqual([o.status, o.taken, o.skipped], ['blown', 1, 0]);
  const v = at.runAttempt(days([trade(30), trade(60)]), ctx({ variant: x => ({ ...x, moveTicks: x.moveTicks - 10 }), account: { sessions: 1 } }));
  assert.strictEqual(v.profit, (20 * 5 - 7.4) + (50 * 5 - 7.4));
});
