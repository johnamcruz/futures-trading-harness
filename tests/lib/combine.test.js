'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const c = require('../../scripts/lib/trading/combine');
const { loadAccounts, accountNamed, validateAccount } = require('../../scripts/lib/trading/accounts');
const { tmpDir, shippedPolicy, TEST_SIZING, testSizing } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const acct = (extra = {}) => ({
  name: 't', starting_balance: 100000, profit_target: 6000, max_loss: 3000, max_loss_mode: 'trailing_eod',
  daily_loss_limit: 2000, daily_loss_soft: 1000, consistency_pct: 50, sessions: 5, max_contracts: { MNQ: 100 }, ...extra,
});

test('bundled account profiles are valid; unknown or invalid ones are refused', () => {
  const { accounts, problems } = loadAccounts(ROOT, {});
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(accounts.map(a => a.name), ['topstep_100k', 'topstep_150k', 'topstep_50k']);
  for (const a of accounts) assert.deepStrictEqual(a.errors, [], a.name);
  assert.strictEqual(accountNamed(ROOT, 'topstep_100k', {}).profit_target, 6000);
  assert.throws(() => accountNamed(ROOT, 'nope', {}), /unknown account/);
  const body = '## When to Use\n## How It Works\n## Examples';
  const bad = validateAccount({ ...acct(), name: 'x', description: 'a valid description here', max_loss_mode: 'weekly', daily_loss_soft: 2500 }, body, 'x');
  assert.ok(bad.some(e => /max_loss_mode/.test(e)) && bad.some(e => /daily_loss_soft/.test(e)));
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'mine'));
  fs.copyFileSync(path.join(ROOT, 'accounts', 'topstep_50k', 'ACCOUNT.md'), path.join(dir, 'mine', 'ACCOUNT.md'));
  assert.ok(loadAccounts(ROOT, { FTH_ACCOUNTS_DIRS: dir }).accounts.some(a => a.name === 'mine' && !a.valid), 'a folder name must match');
});

test('the floor trails the end-of-day high by max loss and locks at the starting balance', () => {
  let s = c.start(acct());
  assert.strictEqual(s.floor, 97000);
  s = c.endDay(c.applyClose(s, 1500)); // eod 101500
  assert.strictEqual(s.floor, 98500);
  s = c.endDay(c.applyClose(s, -800)); // eod 100700: the high stays 101500
  assert.strictEqual(s.floor, 98500, 'the floor never falls');
  s = c.endDay(c.applyClose(s, 2600)); // eod 103300
  assert.strictEqual(s.floor, 100000, 'locked at the starting balance');
  s = c.endDay(c.applyClose(s, 1000)); // eod 104300
  assert.strictEqual(s.floor, 100000);
});

test('blow: realized or open equity at the floor', () => {
  let s = c.start(acct());
  assert.strictEqual(c.applyClose(s, -3000).status, 'blown');
  s = c.applyClose(s, -1000);
  assert.strictEqual(c.touches(s, -1999), false);
  assert.strictEqual(c.touches(s, -2000), true);
  assert.strictEqual(c.blow(s).status, 'blown');
});

test('pass at end of day: target and consistency; timeout after the sessions', () => {
  let s = c.start(acct());
  s = c.endDay(c.applyClose(s, 4000));
  s = c.endDay(c.applyClose(s, 2100)); // profit 6100, best day 4000 > 50%
  assert.strictEqual(s.status, 'active', 'consistency not met yet');
  assert.strictEqual(c.entryBlock(s), null, 'over the target but short of consistency: keep trading, or the attempt can only time out');
  s = c.endDay(c.applyClose(s, 2000)); // profit 8100, best 4000 <= 4050
  assert.strictEqual(s.status, 'passed');
  assert.match(c.entryBlock(s), /passed/);
  let t = c.start(acct({ sessions: 2 }));
  t = c.endDay(c.endDay(t));
  assert.strictEqual(t.status, 'timeout');
});

test('at the profit target, entries stop only once today\'s close would pass', () => {
  // One big day: $6,100 today is all the profit, over 50%. More today can't help
  // (today is the best day), so entries stop for the day, and resume next session.
  const big = c.applyClose(c.start(acct()), 6100);
  assert.match(c.entryBlock(big), /today the best day \(\$6100\).*entries resume next session/);
  const next = c.endDay(big);
  assert.strictEqual(next.status, 'active', 'consistency not met');
  assert.strictEqual(c.entryBlock(next), null, 'the next session trades on');
  assert.ok(c.budget(next, TEST_SIZING) > 0, 'with a size budget');
  // Past the target, a day smaller than the best one helps: it trades on.
  let lop = c.endDay(c.applyClose(c.endDay(c.applyClose(c.start(acct()), 1000)), 4500)); // $5,500
  lop = c.applyClose(lop, 1000); // $6,500, best $4,500 > $3,250; today $1,000
  assert.strictEqual(c.entryBlock(lop), null);
  // The record day past the target, after smaller days: +$1,000, +$1,000, then +$4,500 today.
  let rec = c.endDay(c.applyClose(c.endDay(c.applyClose(c.start(acct()), 1000)), 1000));
  rec = c.applyClose(rec, 4500);
  assert.match(c.entryBlock(rec), /today the best day/);
  assert.strictEqual(c.budget(rec, TEST_SIZING), 0);
  // Every day stays tradable until a pass: no state blocks the attempt for good.
  let s2 = next;
  for (let d = 0; d < 3 && s2.status === 'active'; d += 1) {
    assert.strictEqual(c.entryBlock(s2), null, `session ${d + 2} opens for entries`);
    s2 = c.endDay(c.applyClose(s2, 2100));
  }
  assert.strictEqual(s2.status, 'passed', '$6,100 + 3 x $2,100 = $12,400; best $6,100 <= $6,200');
  // Spread out: $2,000, $2,000, then $2,100 today; best day $2,100 <= 50% of $6,100.
  let s = c.start(acct());
  s = c.endDay(c.applyClose(s, 2000));
  s = c.endDay(c.applyClose(s, 2000));
  s = c.applyClose(s, 2100);
  assert.match(c.entryBlock(s), /profit target/);
  assert.strictEqual(c.budget(s, TEST_SIZING), 0);
  assert.strictEqual(c.endDay(s).status, 'passed');
  // Without a consistency rule the target alone stops entries.
  assert.match(c.entryBlock(c.applyClose(c.start(acct({ consistency_pct: 0 })), 6100)), /profit target/);
});

test('daily limits: the soft one stops entries, the firm one stops the day; both reset at end of day', () => {
  let s = c.start(acct());
  s = c.applyClose(s, -1000);
  assert.match(c.entryBlock(s), /soft daily limit/);
  s = c.applyClose(s, -1000);
  assert.strictEqual(s.dayStopped, true);
  assert.match(c.entryBlock(s), /daily loss limit/);
  assert.strictEqual(s.status, 'active', 'not a blow');
  s = c.endDay(s);
  assert.strictEqual(c.entryBlock(s), null);
  assert.strictEqual(c.dailyBreached(c.applyClose(s, -500), -1500), true);
});

test('loss streak stop: that many losses in a row stop entries for the session; a win ends the streak, a scratch neither; off stops nothing', () => {
  assert.deepStrictEqual([c.streakAfter(0, -1), c.streakAfter(2, -0.01), c.streakAfter(2, 5), c.streakAfter(2, 0), c.streakAfter(undefined, 0)], [1, 3, 0, 2, 0]);
  const two = acct({ loss_streak_stop: 2, daily_loss_soft: 0 });
  let s = c.start(two);
  assert.deepStrictEqual([s.lossStreakStop, s.lossStreak], [2, 0]);
  // The streak counts the P&L before fees (as the gate counts the broker's): a scratch that lost its fees is no loss.
  s = c.applyClose(s, -50, -49.26);
  assert.strictEqual(c.entryBlock(s), null);
  s = c.applyClose(s, -0.74, 0);
  assert.strictEqual(s.lossStreak, 1, 'a scratch neither ends nor extends it');
  s = c.applyClose(s, -50.74, -50);
  assert.match(c.entryBlock(s), /^2 losing trades in a row this session, at the loss streak stop \(loss_streak_stop 2\): no new entries until the next session$/);
  assert.strictEqual(c.budget(s, testSizing({ cushion_frac: 0.2 })), 0, 'no budget while blocked');
  assert.strictEqual(c.applyClose(c.applyClose(c.start(two), -10), 10).lossStreak, 0, 'a win ends it');
  // Without gross, the net decides (the engine and the simulator pass the gross).
  assert.strictEqual(c.applyClose(c.start(two), -0.74).lossStreak, 1);
  // A new session starts at 0.
  s = c.endDay(s);
  assert.deepStrictEqual([s.lossStreak, c.entryBlock(s)], [0, null]);
  // Off (0, the rulebook's `off`, or no value at all): no stop, however long the streak.
  for (const off of [{ loss_streak_stop: 0 }, {}]) {
    const x = [-1, -1, -1, -1].reduce(t => c.applyClose(t, -10), c.start(acct({ daily_loss_soft: 0, ...off })));
    assert.deepStrictEqual([x.lossStreak, c.entryBlock(x)], [4, null], JSON.stringify(off));
  }
});

test('size budget: a share of the cushion, capped, clock-limited, never past the daily limit', () => {
  const s = c.start(acct());
  assert.strictEqual(c.budget(s, TEST_SIZING), 600, '0.2 x 3000');
  assert.strictEqual(c.budget(s, testSizing({ cap_usd: 400 })), 400);
  // clock: need 6000 over 5 sessions at 0.3R/session, k 0.1 -> 0.1 x 6000 / 1.5 = 400
  assert.strictEqual(c.budget(s, testSizing({ clock_k: 0.1 })), 400);
  // Past the target but short of consistency, the clock still sizes for what a pass needs:
  // days $4,000, $2,100 -> profit $6,100, needs $8,000 (best $4,000 at 50%): $1,900 over 3 sessions.
  const past = c.endDay(c.applyClose(c.endDay(c.applyClose(s, 4000)), 2100));
  assert.strictEqual(c.profitNeeded(past), 8000);
  assert.strictEqual(c.budget(past, testSizing({ clock_k: 0.1 })), 211.11, '0.1 x 1900 / (3 x 0.3)');
  assert.strictEqual(c.profitNeeded(c.start(acct())), 6000);
  const down = c.applyClose(s, -1900); // firm limit 2000: 100 left today (also the soft limit is hit)
  assert.strictEqual(c.budget(down, TEST_SIZING), 0, 'soft limit reached');
  assert.strictEqual(c.budget(c.applyClose(s, -900), testSizing({ cushion_frac: 1 })), 1100, 'room to the daily limit');
  assert.strictEqual(c.contracts(600, 50, 100), 12);
  assert.strictEqual(c.contracts(600, 800, 100, 1.5), 1, 'one contract within 1.5x the budget');
  assert.strictEqual(c.contracts(600, 800, 100), 0, 'no guard given: none over the budget (stricter, never a default guard)');
  assert.strictEqual(c.contracts(600, 1000, 100), 0, 'too big: skip');
  assert.strictEqual(c.contracts(6000, 50, 100), 100, 'capped at max contracts');
});

// MNQ: 0.25 a tick = $0.50, $0.37 a side; NQ: $5 a tick, $1.40 a side.
const MNQ_LEGS = { micro: { root: 'MNQ', tickValue: 0.5, fee: 0.37, max: 50 }, mini: { root: 'NQ', tickValue: 5, fee: 1.4, max: 5 } };

test('contractPlan: a contract\'s risk counts the stop\'s expected slippage (a tick by default), fees both ways', () => {
  const plan = extra => c.contractPlan({ dollars: 400, stopTicks: 40, legs: MNQ_LEGS, mode: 'micro', ...extra });
  // 40 ticks + 1 of slippage = 41 x $0.50 = $20.50 + $0.74 = $21.24 a micro: $400 buys 18 ($382.32); 19 would be $403.56.
  assert.deepStrictEqual(plan(), { root: 'MNQ', size: 18, riskPerContract: 21.24 });
  // A mini: 41 x $5 = $205 + $2.80 = $207.80. $1,000 is 47 micros ($998.28), so 4 NQ ($831.20).
  assert.deepStrictEqual(c.contractPlan({ dollars: 1000, stopTicks: 40, legs: MNQ_LEGS, mode: 'auto' }), { root: 'NQ', size: 4, riskPerContract: 207.8 });
  // More expected slippage sizes down: 43 x $0.50 + $0.74 = $22.24, 17 micros ($378.08).
  assert.deepStrictEqual(plan({ slipTicks: 3 }), { root: 'MNQ', size: 17, riskPerContract: 22.24 });
  // Never less than the default: 0, a fraction, or junk size as 1 tick does (stricter only).
  for (const slipTicks of [0, 0.5, -2, undefined, null, 'x']) assert.deepStrictEqual(plan({ slipTicks }), plan(), String(slipTicks));
  // The backtester fills (and the replay counterfactual) slip by the same default number of ticks.
  assert.strictEqual(c.MIN_STOP_SLIPPAGE_TICKS, 1);
  assert.strictEqual(require('../../scripts/lib/backtest/engine').DEFAULTS.slippageTicks, c.MIN_STOP_SLIPPAGE_TICKS);
  assert.strictEqual(require('../../scripts/lib/replay/counterfactual').SLIPPAGE_TICKS, c.MIN_STOP_SLIPPAGE_TICKS);
});

test('contractPlan: a fraction (the verdict\'s multiplier) rounds the size down, 0 fits nothing, and junk sizes nothing', () => {
  const plan = fraction => c.contractPlan({ dollars: 400, stopTicks: 40, legs: MNQ_LEGS, mode: 'micro', fraction });
  // 18 micros at full (above).
  assert.strictEqual(plan(1).size, 18);
  assert.strictEqual(plan(0.5).size, 9);
  assert.strictEqual(plan(0.1).size, 1, 'floor(1.8)');
  // Under one contract: no plan, never rounded up to 1 (as the priority order's halving: 0 means no trade).
  for (const fraction of [0.05, 0]) assert.strictEqual(plan(fraction), null, String(fraction));
  // Never above the whole budget; not a number fails closed.
  assert.strictEqual(plan(2).size, 18);
  for (const fraction of [NaN, 'x', null, -1, undefined]) assert.ok(fraction === undefined ? plan(fraction).size === 18 : plan(fraction) === null, String(fraction));
});

test('contractPlan: when the room to the floor sets the size, a stop a tick past its price never reaches the floor', () => {
  // $50,000 start, $2,000 max loss, no daily limit: down $1,917, so $83 of cushion ($48,083 over a $48,000 floor).
  const s = c.applyClose(c.start(acct({ starting_balance: 50000, max_loss: 2000, daily_loss_limit: 0, daily_loss_soft: 0, consistency_pct: 0 })), -1917);
  assert.deepStrictEqual([s.status, c.room(s)], ['active', 83]);
  const z = testSizing({ cushion_frac: 1 }); // the whole cushion as the budget: the room is what limits
  const cp = c.contractPlan({ dollars: c.budget(s, z), room: c.room(s), stopTicks: 40, legs: MNQ_LEGS, mode: 'micro' });
  // Without the slippage term: $20.74 a micro, floor($82.99 / $20.74) = 4 ($82.96), and 4 stopped a tick past the
  // stop lose 4 x $21.24 = $84.96: $47,998.04, under the floor. With it: floor($82.99 / $21.24) = 3.
  assert.deepStrictEqual(cp, { root: 'MNQ', size: 3, riskPerContract: 21.24 });
  assert.strictEqual(c.applyClose(s, -4 * 21.24).status, 'blown', 'the old size, stopped a tick past its stop');
  const after = c.applyClose(s, -cp.size * cp.riskPerContract); // -$63.72
  assert.deepStrictEqual([after.status, after.balance], ['active', 48019.28]);
});

test('contractPlan: when the daily-limit headroom sets the size, a stop a tick past its price never reaches the daily limit', () => {
  // A $1,000 firm daily limit (soft limit off), down $917 today: $83 of headroom; the cushion ($2,083) is larger.
  const s = c.applyClose(c.start(acct({ max_loss: 3000, daily_loss_limit: 1000, daily_loss_soft: 0 })), -917);
  assert.deepStrictEqual([c.room(s), c.budget(s, TEST_SIZING)], [83, 83], 'the budget is held to the daily headroom too');
  const cp = c.contractPlan({ dollars: c.budget(s, TEST_SIZING), room: c.room(s), stopTicks: 40, legs: MNQ_LEGS, mode: 'micro' });
  assert.deepStrictEqual(cp, { root: 'MNQ', size: 3, riskPerContract: 21.24 });
  assert.ok(c.dailyBreached(s, -4 * 21.24), 'the old size (4), stopped a tick past its stop: -$1,001.96 today');
  assert.ok(!c.dailyBreached(s, -cp.size * cp.riskPerContract), '3 stopped a tick past: -$980.72 today');
  // A mini sized by the room: $250 of headroom is 11 micros ($233.64), so 1 NQ ($207.80; two would be $415.60).
  const wide = c.applyClose(c.start(acct({ max_loss: 3000, daily_loss_limit: 1000, daily_loss_soft: 0 })), -750);
  assert.deepStrictEqual(c.contractPlan({ dollars: 1000, room: c.room(wide), stopTicks: 40, legs: MNQ_LEGS, mode: 'auto' }), { root: 'NQ', size: 1, riskPerContract: 207.8 });
});

test('sizing in a drawdown: the budget halves while the balance is far enough below its peak', () => {
  const combine = require('../../scripts/lib/trading/combine');
  const acct = { name: 'a', starting_balance: 100000, profit_target: 6000, max_loss: 3000, max_loss_mode: 'trailing_eod', daily_loss_limit: 0, sessions: 30 };
  const z = testSizing({ cushion_frac: 0.3, cap_usd: 1000, drawdown_halve_usd: 1500 });
  let s = combine.applyClose(combine.start(acct), 2000); // peak $102,000
  assert.strictEqual(s.peak, 102000);
  s = combine.endDay(s); // floor trails to $99,000
  assert.strictEqual(combine.budget(s, z), 900); // 0.3 x $3,000
  s = combine.applyClose(s, -1000); // $1,000 below the peak: full budget, 0.3 x $2,000
  assert.strictEqual(combine.budget(s, z), 600);
  s = combine.applyClose(s, -500); // $1,500 below the peak: half of 0.3 x $1,500
  assert.strictEqual(combine.budget(s, z), 225);
  assert.strictEqual(s.peak, 102000);
});

test('live: the attempt keeps the peak balance across snapshots and closes, as the engine does', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { tmpDir } = require('../helpers');
  const home = tmpDir();
  const acct = { name: 'a', starting_balance: 100000, profit_target: 6000, max_loss: 3000, max_loss_mode: 'trailing_eod', daily_loss_limit: 0, sessions: 30 };
  prop.startAttempt(home, acct, new Date('2026-10-05T14:00:00Z'));
  prop.snapshot(home, acct, 101800, new Date('2026-10-05T15:00:00Z'));
  prop.recordEndOfDay(home, acct, 101200, '2026-10-05');
  const cs = prop.snapshot(home, acct, 100100, new Date('2026-10-06T15:00:00Z'));
  assert.strictEqual(cs.peak, 101800);
  // $1,700 below the peak: half of 0.3 x ($100,100 - $98,200 floor).
  assert.strictEqual(require('../../scripts/lib/trading/combine').budget(cs, testSizing({ cushion_frac: 0.3, drawdown_halve_usd: 1500 })), 285);
});

test('closeBefore: a past day\'s close is today\'s balance less what later fills made (P&L and fees); an unreadable fill throws', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const end = prop.dayEndMs('2026-10-07');
  assert.strictEqual(new Date(end).toISOString(), '2026-10-07T22:00:00.000Z', '18:00 ET (EDT) the evening it ends');
  assert.strictEqual(new Date(prop.dayEndMs('2026-11-25')).toISOString(), '2026-11-25T23:00:00.000Z', '18:00 ET (EST)');
  const fills = [
    { creationTimestamp: '2026-10-07T14:00:00Z', profitAndLoss: null, fees: 0.37 }, // the missed day's own: already in its close
    { creationTimestamp: '2026-10-08T12:00:30Z', profitAndLoss: -16, fees: 0.37 }, // the catch-up's close the next morning
    { creationTimestamp: '2026-10-08T12:05:00Z', profitAndLoss: 5, fees: 0.37, voided: true },
  ];
  assert.strictEqual(prop.closeBefore(99983.26, fills, end), 99999.63);
  assert.strictEqual(prop.closeBefore(100000, [], end), 100000);
  assert.throws(() => prop.closeBefore(100000, [{ profitAndLoss: -1, fees: 0 }], end), /without a time/);
  assert.throws(() => prop.closeBefore(100000, [{ creationTimestamp: '2026-10-08T12:00:00Z', profitAndLoss: 'x', fees: 0 }], end), /no readable P&L/);
  assert.throws(() => prop.closeBefore(NaN, [], end), /no balance/);
  assert.throws(() => prop.closeBefore(100000, null, end), /not a list/);
});

test('balanceCheck: the day\'s anchor plus every fill since (P&L less fees and commissions); voided and earlier fills don\'t count', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const anchor = { at: '2026-06-01T13:30:02.000Z', day: '2026-06-01', balance: 100000 };
  // Run B's trade: short 1 MNQ at 30,599.75, stopped at 30,620: 20.25 points x $2 = -$40.50, $0.37 a side.
  const fills = [
    { creationTimestamp: '2026-06-01T13:00:00Z', profitAndLoss: -500, fees: 1 }, // before the anchor: in its balance
    { creationTimestamp: '2026-06-01T14:00:02Z', profitAndLoss: null, fees: 0.37 },
    { creationTimestamp: '2026-06-01T14:02:00Z', profitAndLoss: -40.5, fees: 0.37 },
    { creationTimestamp: '2026-06-01T14:05:00Z', profitAndLoss: 99, fees: 1, voided: true },
  ];
  assert.deepStrictEqual(prop.balanceCheck(anchor, 99958.76, fills), { expected: 99958.76, balance: 99958.76, diff: 0, since: anchor.at });
  assert.strictEqual(prop.balanceCheck(anchor, 100000, fills).diff, 41.24, 'the broker never booked the loss');
  // A fill at the anchor's own time came after the anchor was read (the cycle runs after the bar's snapshot).
  assert.strictEqual(prop.balanceCheck(anchor, 99999.63, [{ creationTimestamp: anchor.at, profitAndLoss: null, fees: 0.37 }]).diff, 0);
  // Commissions reported apart from fees are a cost too (a broker can report them so).
  assert.strictEqual(prop.balanceCheck(anchor, 99958.26, [{ creationTimestamp: '2026-06-01T14:02:00Z', profitAndLoss: -40.5, fees: 0.74, commissions: 0.5 }]).diff, 0);
  assert.strictEqual(prop.closeBefore(99958.26, [{ creationTimestamp: '2026-06-01T23:00:00Z', profitAndLoss: -40.5, fees: 0.74, commissions: 0.5 }], prop.dayEndMs('2026-06-01')), 100000);
  assert.throws(() => prop.balanceCheck(anchor, 1, [{ profitAndLoss: 1 }]), /without a time/);
  assert.throws(() => prop.balanceCheck(anchor, 1, [{ creationTimestamp: '2026-06-01T14:00:00Z', fees: 'x' }]), /no readable/);
  assert.throws(() => prop.balanceCheck(null, 1, []), /no anchor/);
  assert.throws(() => prop.balanceCheck(anchor, NaN, []), /no balance/);
  assert.throws(() => prop.balanceCheck(anchor, 1, null), /not a list/);
});

test('snapshot: the day\'s first snapshot anchors the balance; a flat snapshot that doesn\'t reconcile refuses entries until one does; a new day re-anchors', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const home = tmpDir();
  const acct = accountNamed(ROOT, 'topstep_100k', {});
  prop.startAttempt(home, acct, new Date('2026-06-01T12:00:00Z'));
  const at = t => new Date(`2026-06-01T${t}Z`);
  const loss = [{ creationTimestamp: '2026-06-01T14:00:02Z', profitAndLoss: null, fees: 0.37 }, { creationTimestamp: '2026-06-01T14:02:00Z', profitAndLoss: -40.5, fees: 0.37 }];
  // The first snapshot of the day anchors it, whatever the fills say.
  prop.snapshot(home, acct, 100000, at('13:30:02'), { fills: loss });
  assert.deepStrictEqual(prop.readAttempt(home, acct.name).anchor, { at: '2026-06-01T13:30:02.000Z', day: '2026-06-01', balance: 100000 });
  assert.strictEqual(prop.readAttempt(home, acct.name).snapshot.balanceCheck, null);
  // With a position open the realized balance isn't checked (the position block refuses entries anyway).
  prop.snapshot(home, acct, 99999.63, at('14:01:02'), { open: 1, openIds: ['MNQ'], fills: loss.slice(0, 1) });
  assert.strictEqual(prop.readAttempt(home, acct.name).snapshot.balanceCheck, null);
  // Flat and booked as the fills say: entries allowed.
  prop.snapshot(home, acct, 99958.76, at('14:03:02'), { fills: loss });
  assert.strictEqual(prop.readAttempt(home, acct.name).snapshot.balanceCheck.diff, 0);
  assert.strictEqual(prop.combineBlock(home, acct.name, at('14:03:30')), null);
  // The broker's balance and its fills disagree: no entry until they agree again.
  prop.snapshot(home, acct, 100000, at('14:06:02'), { fills: loss });
  assert.match(prop.combineBlock(home, acct.name, at('14:06:30')), /balance doesn't reconcile: the broker reports \$100000, but .* gives \$99958\.76 \(off by \$41\.24\); entries wait .*exits still go/);
  prop.snapshot(home, acct, 99958.76, at('14:09:02'), { fills: loss });
  assert.strictEqual(prop.combineBlock(home, acct.name, at('14:09:30')), null, 'a broker that caught up clears it');
  // Fills that couldn't be read refuse entries too (never skip the check).
  prop.snapshot(home, acct, 99958.76, at('14:12:02'), { fillsError: 'search_trades timed out' });
  assert.match(prop.combineBlock(home, acct.name, at('14:12:30')), /couldn't be checked against the broker's fills \(search_trades timed out\)/);
  prop.snapshot(home, acct, 99958.76, at('14:15:02'), { fills: [{ creationTimestamp: '2026-06-01T14:15:00Z', profitAndLoss: 'x' }] });
  assert.match(prop.combineBlock(home, acct.name, at('14:15:30')), /couldn't be checked .*no readable P&L/);
  // A new trading day re-anchors from the broker's balance.
  prop.recordEndOfDay(home, acct, 99958.76, '2026-06-01');
  prop.snapshot(home, acct, 100000, new Date('2026-06-02T13:30:02Z'), { fills: loss });
  assert.deepStrictEqual([prop.readAttempt(home, acct.name).anchor.day, prop.readAttempt(home, acct.name).snapshot.balanceCheck], ['2026-06-02', null]);
});

test('snapshot: unchanged carries a check that passed on the same balance, anything else is unchecked; an attempt over says so first', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const home = tmpDir();
  const acct = accountNamed(ROOT, 'topstep_100k', {});
  prop.startAttempt(home, acct, new Date('2026-06-01T12:00:00Z'));
  const at = t => new Date(`2026-06-01T${t}Z`);
  prop.snapshot(home, acct, 100000, at('13:30:02'));
  // Nothing checked yet: unchanged can't carry anything.
  prop.snapshot(home, acct, 100000, at('13:33:02'), { unchanged: true });
  assert.match(prop.combineBlock(home, acct.name, at('13:33:30')), /couldn't be checked .*nothing checked to carry forward/);
  prop.snapshot(home, acct, 100000, at('13:36:02'), { fills: [] });
  prop.snapshot(home, acct, 100000, at('13:39:02'), { unchanged: true });
  assert.strictEqual(prop.combineBlock(home, acct.name, at('13:39:30')), null);
  assert.strictEqual(prop.reconciled(prop.readAttempt(home, acct.name).snapshot.balanceCheck), true);
  // Another balance can't carry a check made on the old one.
  prop.snapshot(home, acct, 99000, at('13:42:02'), { unchanged: true });
  assert.match(prop.combineBlock(home, acct.name, at('13:42:30')), /nothing checked to carry forward/);
  // An attempt that is over is the first thing the agent hears (stand aside), whatever the balance check says.
  prop.snapshot(home, acct, 96000, at('13:45:02'), { fills: [] });
  assert.match(prop.combineBlock(home, acct.name, at('13:45:30')), /^the attempt is over.*stand aside/);
});

test('tradesFromFills: closing fills between opening fills are one trade (its gross P&L before fees); voided fills drop; an unreadable fill throws', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const f = (min, pnl, extra = {}) => ({ creationTimestamp: `2026-06-01T14:${String(min).padStart(2, '0')}:00Z`, profitAndLoss: pnl, fees: 0.37, ...extra });
  assert.deepStrictEqual(prop.tradesFromFills([]), []);
  const trades = prop.tradesFromFills([f(9, -5), f(1, null), f(2, -10), f(3, -10), f(4, null), f(5, 0), f(6, null), f(7, 12, { voided: true }), f(8, null)]);
  assert.deepStrictEqual(trades, [
    { gross: -20, at: '2026-06-01T14:03:00.000Z' }, // a stop filled in two parts: one losing trade
    { gross: 0, at: '2026-06-01T14:05:00.000Z' }, // a scratch
    { gross: -5, at: '2026-06-01T14:09:00.000Z' }, // in time order, whatever the list's order
  ]);
  assert.throws(() => prop.tradesFromFills([f(1, 'x')]), /no readable P&L/);
  assert.throws(() => prop.tradesFromFills([{ profitAndLoss: -1 }]), /without a time/);
  assert.throws(() => prop.tradesFromFills(null), /not a list/);
});

test('snapshot: the session\'s loss streak from the broker\'s closing fills since the anchor; kept when no fills are read; a new day starts at 0', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const home = tmpDir();
  const acct = accountNamed(ROOT, shippedPolicy().account, {});
  const stop = acct.loss_streak_stop;
  assert.ok(stop >= 2, 'the shipped rulebook stops after at least two');
  prop.startAttempt(home, acct, new Date('2026-06-01T12:00:00Z'));
  const at = t => new Date(`2026-06-01T${t}Z`);
  const trip = (min, gross) => [
    { creationTimestamp: `2026-06-01T14:${String(min).padStart(2, '0')}:00Z`, profitAndLoss: null, fees: 0.37 },
    { creationTimestamp: `2026-06-01T14:${String(min + 1).padStart(2, '0')}:00Z`, profitAndLoss: gross, fees: 0.37 },
  ];
  const losses = k => Array.from({ length: k }, (_, i) => trip(2 * i + 1, -20)).flat();
  const balance = fills => Math.round((100000 + fills.reduce((a, x) => a + (x.profitAndLoss || 0) - x.fees, 0)) * 100) / 100;
  prop.snapshot(home, acct, 100000, at('13:30:02'), { fills: losses(stop) }); // the anchor: its fills are not read
  assert.deepStrictEqual(prop.sessionLossStreak(home, acct, at('13:31:00')), { count: 0, stop, day: '2026-06-01', at: null });
  let fills = losses(stop - 1);
  prop.snapshot(home, acct, balance(fills), at('14:30:02'), { fills });
  assert.strictEqual(prop.combineBlock(home, acct.name, at('14:30:30')), null);
  assert.strictEqual(prop.sessionLossStreak(home, acct, at('14:30:30')).count, stop - 1);
  fills = losses(stop);
  prop.snapshot(home, acct, balance(fills), at('14:40:02'), { fills });
  assert.match(prop.combineBlock(home, acct.name, at('14:40:30')), new RegExp(`^${stop} losing trades in a row this session, at the loss streak stop`));
  assert.deepStrictEqual(prop.sessionLossStreak(home, acct, at('14:40:30')), { count: stop, stop, day: '2026-06-01', at: `2026-06-01T14:${String(2 * stop).padStart(2, '0')}:00.000Z` });
  // The verdict sizes from the same state: the streak skips the setup.
  const r = prop.readAttempt(home, acct.name);
  assert.match(String(require('../../scripts/lib/trading/combine').entryBlock(prop.stateFrom(acct, r, r.snapshot.balance))), /loss streak stop/);
  // No fills read (unchanged, a position open, fills that failed): the count stays; a failure refuses entries anyway.
  prop.snapshot(home, acct, balance(fills), at('14:43:02'), { unchanged: true });
  assert.strictEqual(prop.sessionLossStreak(home, acct, at('14:43:30')).count, stop);
  prop.snapshot(home, acct, balance(fills), at('14:46:02'), { open: 1, openIds: ['MNQ'] });
  assert.strictEqual(prop.sessionLossStreak(home, acct, at('14:46:30')).count, stop);
  prop.snapshot(home, acct, balance(fills), at('14:49:02'), { fillsError: 'search_trades timed out' });
  assert.strictEqual(prop.sessionLossStreak(home, acct, at('14:49:30')).count, stop);
  assert.match(prop.combineBlock(home, acct.name, at('14:49:30')), /couldn't be checked/);
  prop.snapshot(home, acct, balance(fills), at('14:52:02'), { fills: [...fills, { creationTimestamp: '2026-06-01T14:51:00Z', profitAndLoss: 'x' }] });
  assert.strictEqual(prop.sessionLossStreak(home, acct, at('14:52:30')).count, stop, 'an unreadable fill keeps the last count');
  // A win ends it.
  fills = [...losses(stop), ...trip(30, 50)];
  prop.snapshot(home, acct, balance(fills), at('14:55:02'), { fills });
  assert.strictEqual(prop.combineBlock(home, acct.name, at('14:55:30')), null);
  // A new trading day starts at 0; none for a day without a snapshot.
  prop.snapshot(home, acct, balance(losses(stop)), at('14:58:02'), { fills: losses(stop) });
  prop.recordEndOfDay(home, acct, balance(losses(stop)), '2026-06-01');
  assert.strictEqual(prop.sessionLossStreak(home, acct, new Date('2026-06-02T13:30:00Z')), null);
  prop.snapshot(home, acct, balance(losses(stop)), new Date('2026-06-02T13:30:02Z'));
  assert.strictEqual(prop.sessionLossStreak(home, acct, new Date('2026-06-02T13:31:00Z')).count, 0);
  assert.strictEqual(prop.combineBlock(home, acct.name, new Date('2026-06-02T13:31:00Z')), null);
});

test('orderSince: any order of ours that went through at or after the time (exits and stops too); an unreadable time counts', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const ok = (ts, text = 'setup:x long') => ({ ts, kind: 'order_placed', text, data: { result: { success: true } } });
  assert.strictEqual(prop.orderSince([ok('2026-06-01T14:00:00Z')], '2026-06-01T13:57:02Z'), true);
  assert.strictEqual(prop.orderSince([ok('2026-06-01T14:00:00Z', '[exit] flatten')], '2026-06-01T13:57:02Z'), true, 'exits count');
  assert.strictEqual(prop.orderSince([ok('2026-06-01T13:50:00Z')], '2026-06-01T13:57:02Z'), false, 'before the snapshot');
  assert.strictEqual(prop.orderSince([{ ...ok('2026-06-01T14:00:00Z'), data: { result: { success: false } } }], '2026-06-01T13:57:02Z'), false, 'refused');
  assert.strictEqual(prop.orderSince([{ kind: 'plan', ts: '2026-06-01T14:00:00Z' }], '2026-06-01T13:57:02Z'), false);
  assert.strictEqual(prop.orderSince([ok('not a time')], '2026-06-01T13:57:02Z'), true, 'unreadable time');
  assert.strictEqual(prop.orderSince([], 'never'), true, 'no snapshot time');
});
