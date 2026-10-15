'use strict';

// The attempt line's further facts (combine.attemptFacts), the day's counts prop-state records for them (dayCounts,
// attemptCounts, the close's lossStreak), and the line the prompt shows (autotrader accountText).

const test = require('node:test');
const assert = require('node:assert');
const c = require('../../scripts/lib/trading/combine');
const prop = require('../../scripts/lib/trading/prop-state');
const { accountText } = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');

const acct = (extra = {}) => ({
  name: 't', starting_balance: 100000, profit_target: 6000, max_loss: 3000, max_loss_mode: 'trailing_eod',
  daily_loss_limit: 2000, daily_loss_soft: 1000, consistency_pct: 50, sessions: 30, max_contracts: { MNQ: 100 }, ...extra,
});

test('prop-state: the day\'s trade counts and the losing streak are recorded with the snapshot and carried across days', () => {
  const home = tmpDir();
  const a = acct();
  prop.startAttempt(home, a, new Date('2026-06-01T12:00:00Z'));
  const at = (d, t) => new Date(`2026-06-0${d}T${t}Z`);
  const fill = (d, t, pnl) => ({ creationTimestamp: `2026-06-0${d}T${t}Z`, profitAndLoss: pnl, fees: 0.37 });
  const counts = now => prop.attemptCounts(prop.readAttempt(home, a.name), now);
  // The day's first snapshot (flat, its anchor): nothing yet today.
  prop.snapshot(home, a, 100000, at(1, '13:30:00'));
  assert.deepStrictEqual(counts(at(1, '13:31:00')), { tradesToday: 0, lossesToday: 0, lossStreak: 0 });
  // A win then two losses: 3 trades, 2 losses, a streak of 2 (an opening fill is no trade).
  const day1 = [fill(1, '14:00:00', 50), fill(1, '14:10:00', -30), fill(1, '14:20:00', -20), fill(1, '14:05:00', null)];
  prop.snapshot(home, a, 99998.89, at(1, '14:30:00'), { fills: day1 });
  assert.deepStrictEqual(counts(at(1, '14:31:00')), { tradesToday: 3, lossesToday: 2, lossStreak: 2 });
  // An unchanged snapshot carries the counts; another day's counts are not today's.
  prop.snapshot(home, a, 99998.89, at(1, '14:40:00'), { unchanged: true });
  assert.strictEqual(prop.readAttempt(home, a.name).snapshot.counts.streak, 2);
  assert.deepStrictEqual(counts(at(2, '14:31:00')), { tradesToday: null, lossesToday: null, lossStreak: null });
  prop.recordEndOfDay(home, a, 99998.89, '2026-06-01');
  assert.strictEqual(prop.readAttempt(home, a.name).days[0].lossStreak, 2, 'the close keeps the day\'s streak');
  // Next day: one more loss runs the streak on to 3; a win resets it.
  prop.snapshot(home, a, 99998.89, at(2, '13:30:00'));
  prop.snapshot(home, a, 99978.52, at(2, '14:30:00'), { fills: [fill(2, '14:00:00', -20)] });
  assert.deepStrictEqual(counts(at(2, '14:31:00')), { tradesToday: 1, lossesToday: 1, lossStreak: 3 });
  prop.snapshot(home, a, 100018.15, at(2, '15:30:00'), { fills: [fill(2, '14:00:00', -20), fill(2, '15:00:00', 40)] });
  assert.strictEqual(counts(at(2, '15:31:00')).lossStreak, 0);
  // Fills that couldn't be read, or a position open (no fills read): unknown, never the last counts shown as current.
  prop.snapshot(home, a, 100018.15, at(2, '15:40:00'), { fillsError: 'down' });
  assert.deepStrictEqual(counts(at(2, '15:41:00')), { tradesToday: null, lossesToday: null, lossStreak: null });
  prop.snapshot(home, a, 100018.15, at(2, '15:42:00'), { fills: [fill(2, '14:00:00', -20), fill(2, '15:00:00', 40)] });
  prop.snapshot(home, a, 100010, at(2, '15:45:00'), { open: 1, openIds: ['MNQ'] });
  assert.strictEqual(counts(at(2, '15:46:00')).tradesToday, null, 'a position open: unknown');
  // A close that moved after the last counts (the end-of-day flatten's loss): the close keeps no streak.
  prop.recordEndOfDay(home, a, 99990, '2026-06-02');
  assert.strictEqual(prop.readAttempt(home, a.name).days[1].lossStreak, undefined);
  // An older record without the last close's streak: the streak is unknown until a win today.
  const old = prop.dayCounts({ days: [{ day: '2026-06-01', balance: 1, pnl: 0 }], snapshot: null }, '2026-06-02', [fill(2, '14:00:00', -5)], false, 0);
  assert.deepStrictEqual([old.trades, old.losses, old.streak], [1, 1, null]);
  // Not the day's anchor and no fills read: unknown.
  assert.strictEqual(prop.dayCounts({ days: [], snapshot: null }, '2026-06-02', undefined, false, 0), null);
});

test('combine.attemptFacts: the room to the limits, the day, consistency headroom, profit needed; counts passed in', () => {
  let s = c.start(acct());
  s = c.endDay(c.applyClose(s, 600));
  s = c.applyClose(s, -200);
  assert.deepStrictEqual(c.attemptFacts(s, { tradesToday: 2, lossesToday: 1, lossStreak: 3 }), {
    dailyRoom: 1800, softStop: 1000, softRoom: 800, tradesToday: 2, lossesToday: 1, lossStreak: 3, day: 2, sessions: 30, sessionsLeft: 29, consistencyCap: 600, needed: 5600,
  });
  const none = c.attemptFacts(c.start(acct({ daily_loss_soft: 0, consistency_pct: 0, daily_loss_limit: 0 })));
  assert.deepStrictEqual([none.dailyRoom, none.softStop, none.softRoom, none.consistencyCap, none.tradesToday, none.day, none.needed], [null, null, null, null, null, 1, 6000]);
  // At the soft stop the room is 0, never negative; the facts never block (entryBlock does).
  const down = c.applyClose(c.start(acct()), -1200);
  assert.deepStrictEqual([c.attemptFacts(down).softRoom, c.attemptFacts(down).dailyRoom], [0, 800]);
});

test('the attempt line: the facts rendered compactly; a fact not known is left out', () => {
  const s = c.applyClose(c.endDay(c.applyClose(c.start(acct()), 600)), -200);
  const base = { account: 't', status: 'active', asOf: '2026-06-02T14:00:00Z', ...c.summary(s), budgets: [] };
  const line = f => accountText({ id: 1, at: '2026-06-02T14:00:00Z', balance: s.balance, positions: [], workingOrders: 0, attempts: [{ ...base, ...(f ? { facts: f } : {}) }] });
  assert.match(line(c.attemptFacts(s, { tradesToday: 2, lossesToday: 1, lossStreak: 1 })), /29 sessions left; day 2, needs \$5,600, daily room \$1,800, soft stop \$1,000 \(room \$800\), today 2 trades, 1 loss, losing streak 1, consistency cap today \$600\./);
  assert.doesNotMatch(line(c.attemptFacts(s)), /today \d+ trade|losing streak/);
  assert.doesNotMatch(line(null), /needs \$/, 'no facts, the line as before');
});
