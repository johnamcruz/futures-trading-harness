'use strict';

const { TEST_SIZING, testSizing } = require('../helpers');

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
const ctx = (extra = {}) => ({ account: account(extra.account), sizing: TEST_SIZING, size: ten, mode: 'micro', legsOf: t => at.legsFor(account(), t.symbol, { tickValue: t.tickValue }), ...extra, ...(extra.account ? { account: account(extra.account) } : {}) });
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
  const plan = mode => at.defaultSize({ cs, trade: t, sizing: TEST_SIZING, legs, mode, ratio, fraction: 1 });
  // 0.2 x $1,000 = $200 budget; (20 + 1) x $0.50 + $0.74 = $11.24 a micro: 17 micros, or (auto) 1 NQ.
  assert.deepStrictEqual(plan('auto'), combine.contractPlan({ minContracts: 1, dollars: 200, room: 600, stopTicks: 20, legs, mode: 'auto', fraction: 1, ratio, slipTicks: 1 }));
  assert.deepStrictEqual([plan('micro').root, plan('micro').size, plan('auto').root, plan('auto').size], ['MNQ', 17, 'NQ', 1]);
  assert.deepStrictEqual(Object.keys(legs), ['micro', 'mini']);
  assert.deepStrictEqual([legs.micro.root, legs.mini.root, legs.mini.fee, legs.mini.max], ['MNQ', 'NQ', 1.4, 5]);
});

test('attempts: the rulebook\'s floor (min_contracts) skips a trade the budget sizes under it, as the verdict and the gate do', () => {
  // 0.2 x $1,000 = $200 budget; a 160-tick stop: 161 x $0.50 + $0.74 = $81.24 a micro, 2 fit ($162.48), 3 would be $243.72.
  const wide = trade(60, { stopTicks: 160 });
  const run = min => at.runAttempt(days([wide]), ctx({ size: undefined, sizing: testSizing({ min_contracts: min }), account: { sessions: 1 } }));
  assert.deepStrictEqual([run(1).taken, run(1).skipped], [1, 0]);
  assert.deepStrictEqual([run(3).taken, run(3).skipped], [0, 1]);
  // The simulator's default sizing is contractPlan with the floor, as live sizes it (never 3 over the budget).
  const a = account();
  const { legs, ratio } = at.legsFor(a, 'MNQ', { tickValue: 0.5 });
  const plan = min => at.defaultSize({ cs: combine.start(a), trade: wide, sizing: testSizing({ min_contracts: min }), legs, mode: 'micro', ratio, fraction: 1 });
  assert.deepStrictEqual(plan(1), { root: 'MNQ', size: 2, riskPerContract: 81.24 });
  assert.strictEqual(plan(3), null);
  // A sizing without the floor sizes nothing (no code default).
  assert.strictEqual(plan(undefined), null);
});

test('attempts: the live entry\'s limits (ctx.limits: the composed cap, the broker\'s max) size each trade as the live translation does', () => {
  // A 20-tick stop: the $200 budget sizes 17 micros; a $50 cap at the all-in (20 + 1) x $0.50 + $0.74 = $11.24 a contract
  // is floor(50 / 11.24) = 4, the broker's max 3 under it.
  const nets = limits => {
    const out = [];
    at.runAttempt(days([trade(60)]), ctx({ size: undefined, limits, account: { sessions: 1 }, onTrade: x => out.push(x.net) }));
    return out;
  };
  const per = n => Math.round((60 * 0.5 * n - 0.74 * n) * 100) / 100; // 60 ticks x $0.50 a micro, $0.74 fees a round trip
  assert.deepStrictEqual(nets(null), [per(17)]);
  assert.deepStrictEqual(nets({ capUsd: 50, orderMax: null }), [per(4)]);
  assert.deepStrictEqual(nets({ capUsd: 50, orderMax: 3 }), [per(3)]);
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
  // A scratch (gross 0) is no loss to the gate's count: it counts the broker's P&L before fees, as the loss streak does.
  const s = at.runAttempt(days([trade(-5), trade(0), trade(10), trade(-5), trade(10), trade(-5), trade(10)]), ctx({ gate, account: { sessions: 1 } }));
  assert.deepStrictEqual([s.taken, s.skipped], [6, 1]);
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
  assert.deepStrictEqual(at.gateLimits({ FTH_MAX_DAILY_LOSSES: '2', FTH_MAX_CONSECUTIVE_LOSSES: '1', FTH_LOSS_COOLDOWN_MIN: '45' }), { maxDailyLosses: 2, maxConsecutiveLosses: 1, lossCooldownMin: 45 });
  // The streak's env override only tightens: a higher one is held at the config's (pinned) value.
  assert.strictEqual(at.gateLimits({ FTH_MAX_CONSECUTIVE_LOSSES: '4' }).maxConsecutiveLosses, c.maxConsecutiveLosses);
  // No gate given: the env's (as live), never off.
  const list = Array.from({ length: c.maxDailyLosses + 1 }, () => trade(-5));
  assert.strictEqual(at.runAttempt(days(list), ctx({ account: { sessions: 1, daily_loss_limit: 0 } })).taken, Math.min(c.maxDailyLosses, c.maxConsecutiveLosses));
});

test('attempts: the account\'s loss_streak_stop skips the rest of the session after that many losses in a row (gross: a scratch neither)', () => {
  const streak = { daily_limit: 0, loss_streak_stop: 2 };
  // Two losses, then a winner the same day: skipped; the next day trades again.
  const o = at.runAttempt(days([trade(-10), trade(-10), trade(60)], [trade(60)]), ctx({ account: { ...streak, sessions: 2 } }));
  assert.deepStrictEqual([o.taken, o.skipped], [3, 1]);
  // A scratch (0 ticks: gross 0, net -$7.40 of fees) neither ends nor extends the streak; a win ends it.
  assert.deepStrictEqual(at.runAttempt(days([trade(-10), trade(0), trade(-10), trade(60)]), ctx({ account: { ...streak, sessions: 1 } })).skipped, 1);
  assert.deepStrictEqual(at.runAttempt(days([trade(-10), trade(5), trade(-10), trade(60)]), ctx({ account: { ...streak, sessions: 1 } })).skipped, 0);
  // Off: nothing skipped (the gate's own cooldown off too: gate null isolates this rule).
  assert.deepStrictEqual(at.runAttempt(days([trade(-10), trade(-10), trade(60)]), ctx({ gate: null, account: { sessions: 1 } })).skipped, 0);
});

test('attempts: pacing (clock_k) is tunable on the default sizing: a k sizes down to what the pass still needs per session left', () => {
  const sizes = sizing => {
    const seen = [];
    const size = a => { const p = at.defaultSize(a); seen.push(p ? p.size : 0); return p; };
    at.runAttempt(days([trade(60)]), ctx({ size, sizing: testSizing({ cushion_frac: 0.5, ...sizing }), account: { sessions: 1 } }));
    return seen[0];
  };
  const off = sizes({ clock_k: 0 });
  const k = sizes({ clock_k: 0.05, r_per_session: 1 });
  // $1,000 to make in 1 session at 1R: k 0.05 caps the risk at $50, under the cushion's share ($500).
  assert.ok(off > k && k >= 1, `${off} > ${k}`);
  assert.strictEqual(k, Math.floor(50 / (21 * 0.5 + 0.74)));
});

/** A trade's price path (trade-stream.js pricePath): bars of [open, adverse, favourable, close] ticks, the trade's way. */
const pathed = (bars, extra = {}) => trade(0, { stopTicks: 20, path: bars, ownExit: { targetTicks: 60, trailActivateR: null, trailGivebackR: null }, ...extra });

test('exitAs: the trade re-exited under a policy exit mode from its path, as the engine\'s broker exits it', () => {
  const up = [[0, -5, 30, 25], [25, 20, 50, 45], [45, 30, 70, 35], [35, -30, 40, -25]];
  const target = { mode: 'target' };
  const trail = { mode: 'trail', trail_activate_r: 2, trail_giveback_r: 0.5 };
  // Mode target: out at its own target (60 ticks) on the third bar; the trough is the first bar's -5.
  assert.deepStrictEqual(at.exitAs(pathed(up), target, 1), { ...pathed(up), moveTicks: 60, troughTicks: [-5], exitedAs: 'target' });
  // Mode trail: no target; the second bar reaches 2.5R, the stop moves to 2R (40 ticks), and that bar's low (20) is
  // already through it: out at its close (45), as trailStep closes a trade the new stop wasn't resting for.
  const t = at.exitAs(pathed(up), trail, 1);
  assert.deepStrictEqual([t.moveTicks, t.troughTicks], [45, [-5]]);
  // A resting trailed stop: a later bar through it fills at the stop less the slippage.
  const rest = [[0, -5, 30, 25], [41, 41, 50, 45], [44, 30, 45, 35]];
  assert.strictEqual(at.exitAs(pathed(rest), trail, 1).moveTicks, 39);
  // A trail on top of mode target: the target still fills first here.
  assert.strictEqual(at.exitAs(pathed(up), { ...target, trail_activate_r: 3, trail_giveback_r: 0.5 }, 1).moveTicks, 60);
  assert.strictEqual(at.exitAs(pathed(rest), { ...target, ...trail, mode: 'target' }, 1).moveTicks, 39, 'the trail on top of the target exits first when the target is never reached');
  // The stop first, at the stop or a worse open, less the slippage; a deeper fill is the last trough.
  const down = [[0, -10, 5, -5], [-5, -25, 0, -20]];
  assert.deepStrictEqual([at.exitAs(pathed(down), target, 1).moveTicks, at.exitAs(pathed(down), target, 1).troughTicks], [-21, [-10, -21]]);
  // A bar reaching both the stop and the target is a loss: the stop first, as the engine's broker.
  assert.strictEqual(at.exitAs(pathed([[0, -25, 70, 10]]), target, 1).moveTicks, -21);
  const gap = [[-30, -35, -28, -30]];
  assert.strictEqual(at.exitAs(pathed(gap), target, 1).moveTicks, -31);
  // Neither hit: out at the path's last close (the end of the day).
  assert.strictEqual(at.exitAs(pathed([[0, -5, 10, 8], [8, 2, 12, 9]]), target, 1).moveTicks, 9);
  assert.strictEqual(at.exitAs(pathed(up, { ownExit: null }), target, 1).moveTicks, -21, 'no target of its own: the fourth bar takes the stop');
  // Kept as recorded: no path, no stop, no exit, an unknown mode, or mode trail without a trail.
  for (const [x, e] of [[trade(7), target], [pathed(up, { stopTicks: 0 }), target], [pathed(up), null], [pathed(up), { mode: 'own' }], [pathed(up), { mode: 'trail' }]]) {
    assert.strictEqual(at.exitAs(x, e, 1), x, JSON.stringify(e));
  }
});

test('exitAs, target_then_trail: the stop holds to the trade\'s own target, then locks and trails past it; never closed at the target', () => {
  // 1R = 20 ticks, its own target 60 ticks (3R): the lock at 3R - 0.5R = 50 ticks.
  const ttt = (over = {}) => ({ mode: 'target_then_trail', lock_giveback_r: 0.5, trail_by: 'r', trail_r: 1, ...over });
  // Reaches the target on bar 2 (70), runs to 100 (5R), comes back: the R trail (5R - 1R = 80) takes it out at 80 less a tick.
  const run = [[0, -5, 30, 25], [52, 52, 70, 65], [82, 82, 100, 95], [95, 70, 96, 72]];
  const out = at.exitAs(pathed(run), ttt(), 1);
  assert.deepStrictEqual([out.moveTicks, out.exitedAs], [79, 'target_then_trail'], 'past its target, not closed at 60');
  assert.strictEqual(at.exitAs(pathed(run), { mode: 'target' }, 1).moveTicks, 60, 'mode target: out at the target');
  // The lock holds: reaching the target and coming straight back stops out at the lock (50 ticks) less a tick, never lower.
  const back = [[0, -5, 30, 25], [52, 52, 62, 58], [58, 30, 59, 35]];
  assert.strictEqual(at.exitAs(pathed(back), ttt(), 1).moveTicks, 49);
  // Never reaching the target: the original stop, as mode target.
  const miss = [[0, -5, 50, 45], [45, -30, 46, -25]];
  assert.strictEqual(at.exitAs(pathed(miss), ttt(), 1).moveTicks, -21);
  // The structure trail stands a tick behind the recorded swing (15m), never under the lock; none recorded: the R trail.
  const swings = { '5m': run.map(() => null), '15m': [null, null, 78, 78], '1h': run.map(() => null) };
  assert.strictEqual(at.exitAs(pathed(run, { swingPath: swings }), ttt({ trail_by: 'structure', swing_tf: '15m' }), 1).moveTicks, 76, 'a tick behind the 78 swing: out at 77 less a tick (the R trail would be 80)');
  assert.strictEqual(at.exitAs(pathed(run, { swingPath: { ...swings, '15m': [null, null, 30, 30] } }), ttt({ trail_by: 'structure', swing_tf: '15m' }), 1).moveTicks, 72, 'a swing under the lock: the lock (50) holds, out at the close');
  assert.strictEqual(at.exitAs(pathed(run), ttt({ trail_by: 'structure', swing_tf: '15m' }), 1).moveTicks, 79, 'no swings: the R trail');
  // A stale swing above the price (120 over closes of 65 and 95: a long's old low before a gap) is no swing: the R trail,
  // as with none (it used to put the stop at 119, over the market, and close the trade at once at 65).
  assert.strictEqual(at.exitAs(pathed(run, { swingPath: { ...swings, '15m': [null, 120, 120, 120] } }), ttt({ trail_by: 'structure', swing_tf: '15m' }), 1).moveTicks, 79, 'a swing on the wrong side: the R trail');
  // Kept as recorded when the exit is malformed.
  for (const bad of [ttt({ trail_by: 'atr' }), ttt({ lock_giveback_r: 0 }), ttt({ trail_by: 'structure', swing_tf: '4h' })]) { const x = pathed(run); assert.strictEqual(at.exitAs(x, bad, 1), x, JSON.stringify(bad)); }
});

test('exitAs, target_then_trail with the ratchet: on, the lock follows the best R less the giveback; off (or left out), as before; anything else kept as recorded', () => {
  const ttt = (over = {}) => ({ mode: 'target_then_trail', lock_giveback_r: 0.5, trail_by: 'r', trail_r: 1, ...over });
  // 1R = 20 ticks, its target 60 (3R). Bar 2 reaches 70 (3.5R): on, the lock is 3R (60), through the bar's low (52): out at its close, 65.
  const run = [[0, -5, 30, 25], [52, 52, 70, 65], [82, 82, 100, 95], [95, 70, 96, 72]];
  assert.strictEqual(at.exitAs(pathed(run), ttt({ ratchet: 'on' }), 1).moveTicks, 65);
  // Off, stated or left out: the lock at 2.5R (50), the R trail to 80, out at 79.
  for (const off of [ttt(), ttt({ ratchet: 'off' })]) assert.strictEqual(at.exitAs(pathed(run), off, 1).moveTicks, 79, JSON.stringify(off));
  // A loose 3R trail, so past the target only the lock moves the stop. Armed at 62 (3.1R): on, the lock at 2.6R (52);
  // at 100 (5R) it is 4.5R (90), through that bar's low (82): out at its close, 95. Off: the 2.5R lock (50) holds, out
  // at the path's last close, 88.
  const loose = [[0, -5, 30, 25], [62, 62, 62, 62], [82, 82, 100, 95], [95, 85, 96, 88]];
  assert.strictEqual(at.exitAs(pathed(loose), ttt({ trail_r: 3, ratchet: 'on' }), 1).moveTicks, 95);
  assert.strictEqual(at.exitAs(pathed(loose), ttt({ trail_r: 3 }), 1).moveTicks, 88);
  for (const bad of [true, 'yes', 1]) { const x = pathed(run); assert.strictEqual(at.exitAs(x, ttt({ ratchet: bad }), 1), x, String(bad)); }
});

test('exitAs: a re-exited trade\'s exit time is its exit bar\'s close (pathEnds), else null; the gate\'s cooldown reads it', () => {
  const ends = ['14:05', '14:10', '14:15', '14:20'].map(x => Date.parse(`2022-03-01T${x}:00.000Z`));
  const up = [[0, -5, 30, 25], [25, 20, 50, 45], [45, 30, 70, 35], [35, -30, 40, -25]];
  const withTimes = pathed(up, { entryTime: '2022-03-01T14:00:00.000Z', exitTime: '2022-03-01T14:20:00.000Z', pathEnds: ends });
  assert.strictEqual(at.exitAs(withTimes, { mode: 'target' }, 1).exitTime, '2022-03-01T14:15:00.000Z', 'out at the target on the third bar');
  assert.strictEqual(at.exitAs(pathed(up, { exitTime: '2022-03-01T14:20:00.000Z' }), { mode: 'target' }, 1).exitTime, null, 'no bar times: the recorded exit is no longer the exit');
  // Two losses re-exited at the stop on their first bar (14:05), the next entry 25 minutes later: cooling down (30).
  const gate = { maxDailyLosses: 99, maxConsecutiveLosses: 2, lossCooldownMin: 30 };
  const loser = (e, x) => pathed([[0, -25, 0, -25]], { entryTime: `2022-03-01T${e}:00.000Z`, exitTime: '2022-03-01T16:00:00.000Z', pathEnds: [Date.parse(`2022-03-01T${x}:00.000Z`)] });
  const two = [loser('14:00', '14:05'), loser('14:10', '14:15')].map(t => at.exitAs(t, { mode: 'target' }, 1));
  const next = trade(10, { entryTime: '2022-03-01T14:40:00.000Z' });
  const why = [];
  const o = at.runAttempt(days([...two, next]), ctx({ gate, account: { sessions: 1 }, onSkip: x => why.push(x.why) }));
  assert.deepStrictEqual([o.taken, why], [2, ['loss-cooldown']], 'from the re-exit (14:15), not the recorded exit (16:00, which would be fail-open only if earlier)');
  assert.strictEqual(at.runAttempt(days([...two, trade(10, { entryTime: '2022-03-01T14:46:00.000Z' })]), ctx({ gate, account: { sessions: 1 } })).taken, 3);
});

test('attempts: one streak for the loss streak stop and the gate\'s cooldown; checks in order, a skipped trade counted once', () => {
  // loss_streak_stop 2 and the gate's cooldown at 2: the stop (entryBlock) refuses first and ends the session.
  const gate = { maxDailyLosses: 99, maxConsecutiveLosses: 2, lossCooldownMin: 30 };
  const timed = (move, entry, exit) => trade(move, { entryTime: `2022-03-01T${entry}:00.000Z`, exitTime: `2022-03-01T${exit}:00.000Z` });
  const list = [timed(-10, '14:00', '14:05'), timed(-10, '14:06', '14:10'), timed(60, '15:00', '15:05'), timed(60, '15:10', '15:15')];
  const why = [];
  const seen = [];
  const o = at.runAttempt(days(list), ctx({ gate, account: { loss_streak_stop: 2, sessions: 1 }, onSkip: x => why.push(x.why), onTrade: x => seen.push(x.counters.lossStreak) }));
  assert.deepStrictEqual([o.taken, o.skipped, why], [2, 2, ['blocked', 'blocked']], 'the stop holds past the cooldown');
  assert.deepStrictEqual(seen, [0, 1], 'the attempt line\'s streak is combine\'s (the session\'s)');
  // Without the stop the cooldown alone pauses, then lets the 15:00 entry through.
  assert.strictEqual(at.runAttempt(days(list), ctx({ gate, account: { sessions: 1 } })).taken, 4);
  // The streak is the session's: a new day starts at 0 for both.
  const d2 = at.runAttempt(days(list.slice(0, 2), [timed(60, '14:11', '14:15')].map(t => ({ ...t, day: '2022-03-02' }))), ctx({ gate, account: { loss_streak_stop: 2, sessions: 2 } }));
  assert.strictEqual(d2.taken, 3);
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

test('attempts: onePosition decides the slot after sizing: a trade the account skips never holds it, a taken one holds it to its exit', () => {
  const T = (move, entry, exit, extra = {}) => trade(move, { entryTime: `2022-03-01T${entry}:00.000Z`, exitTime: `2022-03-01T${exit}:00.000Z`, ...extra });
  // The 14:00 trade is too wide to size (its own size refuses it); the 14:10 one, inside its span, is then taken.
  const sizeOf = ({ trade: t }) => (t.stopTicks > 100 ? null : ten());
  const wide = T(60, '14:00', '15:00', { stopTicks: 400 });
  const inside = T(60, '14:10', '14:40');
  const after = T(60, '14:20', '14:50');
  const late = T(60, '14:40', '14:45');
  const run = (list, onePosition) => {
    const skips = [];
    const o = at.runAttempt(days(list), ctx({ size: sizeOf, onePosition, account: { sessions: 1 }, onSkip: x => skips.push(x.why) }));
    return [o.taken, skips];
  };
  assert.deepStrictEqual(run([wide, inside, after, late], true), [2, ['no-size', 'position-open']]);
  // Off (the default): every trade the account sizes is taken, as before.
  assert.deepStrictEqual(run([wide, inside, after, late], false), [3, ['no-size']]);
  // An exit time unknown holds the slot for the rest of the day.
  assert.deepStrictEqual(run([T(60, '14:10', '14:20', { exitTime: null }), late], true), [1, ['position-open']]);
});
