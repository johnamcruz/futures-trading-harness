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

test('attempts: the account\'s loss_streak_stop skips the rest of the session after that many losses in a row (gross: a scratch neither)', () => {
  const streak = { daily_limit: 0, loss_streak_stop: 2 };
  // Two losses, then a winner the same day: skipped; the next day trades again.
  const o = at.runAttempt(days([trade(-10), trade(-10), trade(60)], [trade(60)]), ctx({ account: { ...streak, sessions: 2 } }));
  assert.deepStrictEqual([o.taken, o.skipped], [3, 1]);
  // A scratch (0 ticks: gross 0, net -$7.40 of fees) neither ends nor extends the streak; a win ends it.
  assert.deepStrictEqual(at.runAttempt(days([trade(-10), trade(0), trade(-10), trade(60)]), ctx({ account: { ...streak, sessions: 1 } })).skipped, 1);
  assert.deepStrictEqual(at.runAttempt(days([trade(-10), trade(5), trade(-10), trade(60)]), ctx({ account: { ...streak, sessions: 1 } })).skipped, 0);
  // Off: nothing skipped.
  assert.deepStrictEqual(at.runAttempt(days([trade(-10), trade(-10), trade(60)]), ctx({ account: { sessions: 1 } })).skipped, 0);
});

test('attempts: pacing (clock_k) is tunable on the default sizing: a k sizes down to what the pass still needs per session left', () => {
  const sizes = sizing => {
    const seen = [];
    const size = a => { const p = at.defaultSize(a); seen.push(p ? p.size : 0); return p; };
    at.runAttempt(days([trade(60)]), ctx({ size, sizing: { ...combine.DEFAULT_SIZING, cushion_frac: 0.5, ...sizing }, account: { sessions: 1 } }));
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
  // Kept as recorded when the exit is malformed.
  for (const bad of [ttt({ trail_by: 'atr' }), ttt({ lock_giveback_r: 0 }), ttt({ trail_by: 'structure', swing_tf: '4h' })]) { const x = pathed(run); assert.strictEqual(at.exitAs(x, bad, 1), x, JSON.stringify(bad)); }
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
