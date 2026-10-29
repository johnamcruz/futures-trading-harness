'use strict';

// Phase 2's cut of a prop entry's translated size (scripts/lib/prop/phase2-cut.js, owner-approved 2026-10-28): it stands
// while any pacing rule holds on the attempt's facts; only a healthy account's cut is restored, never above the verdict.

const test = require('node:test');
const assert = require('node:assert');
const C = require('../../scripts/lib/prop/phase2-cut');
const prop = require('../../scripts/lib/trading/prop-state');
const combine = require('../../scripts/lib/trading/combine');
const { translateSize } = require('../../scripts/lib/prop/size-translate');
const { trendHome, testSizing } = require('../helpers');

// Healthy: the balance at the start and its peak, no loss today, no streak, $500 to the soft stop, $1,000 to the daily
// limit and $3,000 to the target, all over the translated size's $277.50 risk.
const HEALTHY = Object.freeze({ balance: 50000, start: 50000, peak: 50000, lossesToday: 0, lossStreak: 0, softRoom: 500, dailyRoom: 1000, needed: 3000 });
const RISK = 277.5;
const facts = (o = {}) => ({ ...HEALTHY, ...o });

test('namedRules: the rule on a line-start Size line stating exactly the size; malformed, mid-line, unknown, other sizes or none: none', () => {
  assert.deepStrictEqual(C.RULES, ['after-loss', 'streak', 'drawdown', 'soft-stop', 'target']);
  assert.deepStrictEqual(C.namedRules('Size: 4 (after-loss)\nVERDICT: APPROVE - size 4', 4), ['after-loss']);
  assert.deepStrictEqual(C.namedRules('- **Size:** 4 (soft-stop, $180 of room)', 4), ['soft-stop']);
  assert.deepStrictEqual(C.namedRules('Size: 4 (Streak)\nSize: 4 (drawdown)\nSize: 4 (streak)', 4), ['streak', 'drawdown']);
  for (const t of ['Size: 4 after-loss', 'Size: 4 (half on serious against)', 'Size: 4 (afterloss)', 'The Size: 4 (after-loss)', 'VERDICT: APPROVE - size 4 (after-loss)', 'Size: 5 (after-loss)', 'Size: four (after-loss)', '', null]) {
    assert.deepStrictEqual(C.namedRules(t, 4), [], String(t));
  }
});

test('rulesHolding: each pacing rule holds only when its condition does; a healthy account holds none; unread facts are never healthy', () => {
  assert.deepStrictEqual(C.rulesHolding(HEALTHY, RISK), []);
  assert.deepStrictEqual(C.rulesHolding(facts({ lossesToday: 1 }), RISK), ['after-loss']);
  for (const n of [1, 2, 3]) assert.deepStrictEqual(C.rulesHolding(facts({ lossStreak: n }), RISK), ['streak'], String(n));
  assert.deepStrictEqual(C.rulesHolding(facts({ balance: 49999.75, peak: 50000 }), RISK), ['drawdown'], 'under the start');
  assert.deepStrictEqual(C.rulesHolding(facts({ balance: 50400, peak: 50600 }), RISK), ['drawdown'], 'under the peak');
  assert.deepStrictEqual(C.rulesHolding(facts({ balance: 50600, peak: 50600 }), RISK), [], 'at a new peak');
  assert.deepStrictEqual(C.rulesHolding(facts({ softRoom: 277.5 }), RISK), ['soft-stop']);
  assert.deepStrictEqual(C.rulesHolding(facts({ softRoom: 277.75 }), RISK), []);
  assert.deepStrictEqual(C.rulesHolding(facts({ softRoom: null, dailyRoom: 200 }), RISK), ['soft-stop'], 'the daily limit too');
  assert.deepStrictEqual(C.rulesHolding(facts({ softRoom: null, dailyRoom: null }), RISK), [], 'no limits: none near');
  assert.deepStrictEqual(C.rulesHolding(facts({ needed: 200 }), RISK), ['target']);
  assert.deepStrictEqual(C.rulesHolding(facts({ needed: 277.5 }), RISK), ['target'], 'one loss from the target');
  assert.deepStrictEqual(C.rulesHolding(facts({ needed: 277.75 }), RISK), []);
  assert.deepStrictEqual(C.rulesHolding(facts({ needed: 0 }), RISK), [], 'passed: the target stop blocks entries anyway');
  for (const bad of [null, facts({ lossesToday: null }), facts({ lossStreak: undefined }), facts({ balance: NaN }), facts({ peak: null })]) assert.deepStrictEqual(C.rulesHolding(bad, RISK), ['unknown']);
  assert.deepStrictEqual(C.rulesHolding(HEALTHY, null), ['unknown'], 'no risk to measure: not healthy');
});

test('phase2Cut: a healthy account\'s cut is restored to the verdict, a process note; any rule true keeps the cut, named or not; never above the verdict; a veto is no cut', () => {
  assert.deepStrictEqual(C.phase2Cut({ approved: 4, base: 9, facts: HEALTHY, riskUsd: RISK, named: [] }),
    { size: 9, cut: true, restored: { from: 4, to: 9, named: [], note: 'phase-2 cut 4 -> 9: no pacing rule applies' } });
  // A named rule whose condition is false, on a healthy account: restored too.
  assert.strictEqual(C.phase2Cut({ approved: 4, base: 9, facts: HEALTHY, riskUsd: RISK, named: ['after-loss'] }).size, 9);
  // Any rule true: the cut stands, with or without a rule named (a streak of 1, 2 or 3, a drawdown, a loss today).
  for (const f of [{ lossStreak: 1 }, { lossStreak: 2 }, { lossStreak: 3 }, { balance: 49000 }, { lossesToday: 1 }, { softRoom: 100 }, { needed: 100 }]) {
    for (const named of [[], ['target']]) {
      const c = C.phase2Cut({ approved: 4, base: 9, facts: facts(f), riskUsd: RISK, named });
      assert.deepStrictEqual([c.size, c.cut, c.restored], [4, true, undefined], JSON.stringify(f));
    }
  }
  assert.strictEqual(C.phase2Cut({ approved: 4, base: 9, facts: null, riskUsd: RISK }).size, 4, 'facts unread: the cut stands');
  // Never above the verdict: an approval at or over it is the verdict; a restore is exactly it.
  for (const approved of [1, 3, 8, 9, 10, 50]) {
    const c = C.phase2Cut({ approved, base: 9, facts: HEALTHY, riskUsd: RISK });
    assert.strictEqual(c.size, 9, String(approved));
    assert.strictEqual(c.cut, approved < 9);
  }
  // A veto (no approved size) is never a cut, never a size.
  assert.deepStrictEqual(C.phase2Cut({ approved: null, base: 9, facts: HEALTHY, riskUsd: RISK }), { size: null, cut: false });
});

test('cutFacts: read from the attempt\'s snapshot as combine_status shows it: healthy at the start, a drawdown under it, a loss today and a streak from a drawn state', () => {
  const NOW = new Date('2026-10-07T14:00:02Z');
  const A = { name: 'mini', valid: true, starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod', daily_loss_limit: 1000, daily_loss_soft: 500, loss_streak_stop: 4, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 } };
  const at = (balance, seed = null) => {
    const h = trendHome();
    if (seed) {
      prop.seedAttempt(h, A, { day: '2026-10-07', at: '2026-10-07T13:30:00Z', state: { days: [], peak: 50000, ...seed } });
    } else prop.startAttempt(h, A, new Date(NOW.getTime() - 86400000));
    prop.snapshot(h, A, balance, new Date(NOW.getTime() - 60000));
    return C.cutFacts({ home: h, account: A, now: NOW });
  };
  const ok = at(50000);
  assert.deepStrictEqual([ok.balance, ok.start, ok.peak, ok.lossesToday, ok.lossStreak, ok.softRoom, ok.dailyRoom, ok.needed], [50000, 50000, 50000, 0, 0, 500, 1000, 3000]);
  assert.deepStrictEqual(C.rulesHolding(ok, RISK), []);
  assert.deepStrictEqual(C.rulesHolding(at(49800), RISK), ['drawdown']);
  const lost = at(49900, { balance: 49900, dayPnl: -100, tradesToday: 1, lossesToday: 1, lossStreak: 1 });
  assert.deepStrictEqual([lost.lossesToday, lost.lossStreak], [1, 1]);
  assert.deepStrictEqual(C.rulesHolding(lost, RISK), ['after-loss', 'streak', 'drawdown']);
  // No attempt, or no snapshot: no facts (the cut stands).
  assert.strictEqual(C.cutFacts({ home: trendHome(), account: A, now: NOW }), null);
  const bare = trendHome();
  prop.startAttempt(bare, A, NOW);
  assert.strictEqual(C.cutFacts({ home: bare, account: A, now: NOW }), null);
  assert.strictEqual(C.cutFacts({ home: bare, account: null, now: NOW }), null);
});

test('near the floor the verdict itself is already small (the cushion\'s share), and restoring an unjustified cut never places more than it', () => {
  const NOW = new Date('2026-10-07T14:00:02Z');
  const A = { name: 'mini', valid: true, errors: [], starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod', daily_loss_limit: 1000, daily_loss_soft: 500, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 } };
  const policy = { name: 'prop_portfolio', valid: true, signal: 'policy', account: 'mini', contracts: 'micro', sizing: testSizing({ min_contracts: 1 }), multipliers: [] };
  const specOf = r => (r === 'MNQ' || r === 'NQ' ? { tickSize: 0.25, tickValue: r === 'NQ' ? 5 : 0.5 } : null);
  const sized = balance => {
    const h = trendHome();
    prop.startAttempt(h, A, new Date(NOW.getTime() - 2 * 86400000));
    prop.recordEndOfDay(h, A, balance, '2026-10-06');
    prop.snapshot(h, A, balance, new Date(NOW.getTime() - 60000));
    const cs = prop.stateFrom(A, prop.readAttempt(h, A.name), balance);
    // A verdict as large as the account's max: the size budget now (the cushion's share, prop.budgetPlan) bounds it.
    const verdict = { strategy: 'prop_portfolio', action: 'full', multiplier: 1, contract: 'MNQ', stopTicks: 40, maxSize: 50 };
    const t = translateSize({ suggested: 1, home: h, root: 'MNQ', policy, account: A, verdict, capUsd: 1000, perContract: 21.24, specOf, selected: ['MNQ'] });
    return { t, cushion: combine.cushion(cs), budget: combine.budget(cs, policy.sizing), facts: C.cutFacts({ home: h, account: A, now: NOW }) };
  };
  const full = sized(50000);
  const thin = sized(48200);
  assert.ok(thin.cushion < full.cushion && thin.cushion <= 200, `cushion ${thin.cushion}`);
  assert.ok(thin.budget < full.budget, `budget ${thin.budget} vs ${full.budget}`);
  assert.ok(Number.isInteger(full.t.size) && Number.isInteger(thin.t.size) && thin.t.size < full.t.size, JSON.stringify([thin.t, full.t]));
  // Near the floor the account is in a drawdown: phase 2's cut stands; and any restore is at most the small verdict.
  assert.ok(C.rulesHolding(thin.facts, thin.t.size * 20).includes('drawdown'));
  for (const approved of [1, thin.t.size, thin.t.size + 5]) {
    for (const f of [thin.facts, HEALTHY]) assert.ok(C.phase2Cut({ approved, base: thin.t.size, facts: f, riskUsd: thin.t.size * 20 }).size <= thin.t.size);
  }
});

test('the cycle record and the run report carry a restored cut as a process note (cycle log line, replay store, report)', () => {
  const fs = require('fs');
  const path = require('path');
  const { writeCycleLog } = require('../../scripts/lib/cycle-log');
  const store = require('../../scripts/lib/replay/store');
  const report = require('../../scripts/lib/replay/report');
  const home = trendHome();
  const at = new Date('2026-10-07T14:00:02Z');
  const cutRestored = { from: 4, to: 9, named: [], note: 'phase-2 cut 4 -> 9: no pacing rule applies', process: true };
  writeCycleLog(home, { at, action: 'trade', harness: 'x', prompt: 'p', result: 'CYCLE RESULT: executed - trade_lifecycle long 9 MNQ', ok: true, entry: { outcome: 'executed', ran: [], cutRestored } });
  const logs = fs.readdirSync(path.join(home, 'logs')).filter(f => /^cycles-.*\.jsonl$/.test(f));
  const line = JSON.parse(fs.readFileSync(path.join(home, 'logs', logs[0]), 'utf8').trim().split('\n').pop());
  assert.deepStrictEqual(line.entry.cutRestored, { from: 4, to: 9, note: 'phase-2 cut 4 -> 9: no pacing rule applies' });
  const ran = [store.cycleSummary(line), store.cycleSummary({ ...line, entry: { outcome: 'executed', ran: [] } })];
  assert.ok(!('cutRestored' in ran[1]));
  const sum = report.summarize({ '2026-10-07': [{ kind: 'trade', ran, trades: [] }] });
  const text = 'Process notes: 1 phase-2 cut placed at the translated size, no pacing rule applying (phase-2 cut 4 -> 9: no pacing rule applies).';
  assert.strictEqual(report.cutRestoredLine(sum.total), text);
  assert.ok(report.toMarkdown(sum).includes(text) && report.toText(sum).includes(text));
  // None: no key, no line, the report as before; never counted as a refusal.
  assert.deepStrictEqual(sum.total.refusals, {});
  const none = report.summarize({ '2026-10-07': [{ kind: 'trade', ran: [ran[1]], trades: [] }] });
  assert.ok(!('cutRestored' in none.total));
  assert.strictEqual(report.cutRestoredLine(none.total), null);
  assert.ok(!/Process notes/.test(report.toText(none)));
});
