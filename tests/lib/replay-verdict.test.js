'use strict';

// The replay report's combine verdict (scripts/lib/replay/verdict.js): each
// month a fresh attempt, judged by combine.js as RL training judges one.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpDir } = require('../helpers');
const { resolveAccount, fillsOf, evaluate, verdictText, verdictMarkdown, DEFAULT_ACCOUNT } = require('../../scripts/lib/replay/verdict');
const { accountNamed } = require('../../scripts/lib/trading/accounts');
const combine = require('../../scripts/lib/trading/combine');

const ROOT = path.resolve(__dirname, '..', '..');
const ACCOUNT = accountNamed(ROOT, 'topstep_100k', {}); // $6000 target, $3000 trailing EOD, $2000 daily, 50% consistency
const FEE = 0.37;

/**
 * A run's day files from trades: [day, gross P&L, { mae, at, contract, fee }]; each trade is an opening fill
 * (its fee) and a closing fill (P&L and fee, with the replay broker's round trip when `mae` is given).
 * `at`: the closing time (UTC, default 15:00 on the day); the opening fill is a minute before.
 */
function run(trades) {
  const days = {};
  let id = 0;
  for (const [day, pnl, o = {}] of trades) {
    const close = new Date(o.at || `${day}T15:00:00Z`);
    const open = new Date(close.getTime() - 60000);
    const fee = o.fee ?? FEE;
    const contract = o.contract || 'MNQ';
    const fills = [];
    if (!o.closeOnly) fills.push({ id: id += 1, contractId: contract, creationTimestamp: open.toISOString(), profitAndLoss: null, fees: fee, side: 0, size: 1 });
    if (!o.openOnly) {
      fills.push({
        id: id += 1, contractId: contract, creationTimestamp: close.toISOString(), profitAndLoss: pnl, fees: fee, side: 1, size: 1,
        ...(o.mae !== undefined ? { roundTrip: { net: pnl - 2 * fee, maeDollars: o.mae, fees: 2 * fee } } : {}),
      });
    }
    const key = o.recordDay || day;
    (days[key] = days[key] || []).push({ t: close.toISOString(), day: key, kind: 'trade', trades: fills });
  }
  return days;
}

const net = pnl => pnl - 2 * FEE;

test('verdict: a passing month passes on the day it meets the target and consistency; later trades are not counted', () => {
  const v = evaluate(run([['2026-03-02', 2500], ['2026-03-03', 2000], ['2026-03-04', 1600], ['2026-03-05', -1500]]), ACCOUNT);
  const [mar] = v.months;
  assert.strictEqual(mar.verdict, 'PASS');
  assert.strictEqual(mar.passDay, '2026-03-04');
  assert.strictEqual(mar.profit, Math.round((net(2500) + net(2000) + net(1600)) * 100) / 100, 'net of every fill\'s fees (6097.78)');
  assert.deepStrictEqual(mar.days.map(d => d.pnl), [net(2500), net(2000), net(1600)].map(x => Math.round(x * 100) / 100), 'the attempt ends at the pass');
  assert.deepStrictEqual(v.summary, { months: 1, passed: 1, failed: 0, notYet: 0 });
  assert.match(verdictText(v), /2026-03 {2}PASS on 2026-03-04: profit \$6097\.78 \(target \$6000\.00\)/);
});

test('verdict: the consistency rule holds a pass back until the best day is at most half the profit', () => {
  const held = evaluate(run([['2026-03-02', 5000], ['2026-03-03', 1100]]), ACCOUNT).months[0];
  assert.strictEqual(held.verdict, 'NOT YET', 'profit $6097.04 but the best day ($4999.26) is over 50%');
  assert.strictEqual(held.needed, Math.round((net(5000) / 0.5) * 100) / 100);
  assert.match(verdictText(evaluate(run([['2026-03-02', 5000], ['2026-03-03', 1100]]), ACCOUNT)), /needs \$9998\.52 for consistency/);
  const passed = evaluate(run([['2026-03-02', 5000], ['2026-03-03', 1100], ['2026-03-04', 4000]]), ACCOUNT).months[0];
  assert.deepStrictEqual([passed.verdict, passed.passDay], ['PASS', '2026-03-04']);
  // An account without the rule passes on the second day.
  const loose = evaluate(run([['2026-03-02', 5000], ['2026-03-03', 1100]]), { ...ACCOUNT, consistency_pct: 0 }).months[0];
  assert.deepStrictEqual([loose.verdict, loose.passDay], ['PASS', '2026-03-03']);
});

test('verdict: the daily loss limit flattens at the limit and stops the day (not the attempt); later entries that day are left out', () => {
  const v = evaluate(run([
    ['2026-03-02', -2500, { at: '2026-03-02T15:00:00Z' }], // closes past the limit: counted as -$2000 for the day
    ['2026-03-02', 900, { at: '2026-03-02T16:00:00Z' }], // opened after the stop: the firm would refuse it
    ['2026-03-03', 300, { mae: -2100 }], // went past the limit intraday: flattened there, though it closed a winner
    ['2026-03-04', 200],
  ]), { ...ACCOUNT, max_loss_mode: 'static', max_loss: 5000 }).months[0];
  assert.strictEqual(v.verdict, 'NOT YET', 'the daily limit is not a fail in combine.js');
  assert.deepStrictEqual(v.days.map(d => d.pnl), [-2000, -2000, net(200)]);
  assert.strictEqual(v.events.length, 2);
  assert.match(v.events[0].text, /daily loss limit \(\$2000\) hit: flattened there \(trade closed at \$-2500\.37/);
  assert.match(v.events[1].text, /went to \$-2100\.37 before closing at \$299\.63, counted as \$-1999\.63/);
  assert.deepStrictEqual(v.excluded.map(x => [x.day, x.why]), [['2026-03-02', 'opened after the daily loss limit was hit'], ['2026-03-02', 'opened after the daily loss limit was hit']]);
});

test('verdict: daily-limit days that reach the trailing floor fail the month on that day', () => {
  const v = evaluate(run([['2026-03-02', -2500], ['2026-03-03', -1200]]), ACCOUNT).months[0];
  assert.strictEqual(v.verdict, 'FAIL');
  assert.deepStrictEqual([v.fail.rule, v.fail.day], ['max-loss', '2026-03-03']);
  assert.match(v.fail.how, /floor \$97000/);
  assert.strictEqual(v.maxLossUsed, 3000);
});

test('verdict: the floor trails the end-of-day high; an intraday MAE to it fails the month (a static floor would not)', () => {
  const trades = [['2026-03-02', 2500], ['2026-03-03', -100, { mae: -3100 }]];
  const v = evaluate(run(trades), ACCOUNT).months[0];
  assert.deepStrictEqual([v.verdict, v.fail.day], ['FAIL', '2026-03-03']);
  assert.match(v.fail.how, /equity reached \$99398\.52 \(from the trade's MAE\), floor \$99499\.26/);
  // Static: the floor stays at $97000; the same MAE only crosses the $2000 daily limit.
  const flat = evaluate(run(trades), { ...ACCOUNT, max_loss_mode: 'static' }).months[0];
  assert.strictEqual(flat.verdict, 'NOT YET');
  assert.strictEqual(flat.events.length, 1);
  // The floor stops at the starting balance: after a $3500 day it is $100000, not $100499.26.
  const locked = evaluate(run([['2026-03-02', 3500], ['2026-03-03', -3600]]), ACCOUNT).months[0];
  assert.strictEqual(locked.days[0].floor, 100000);
  assert.strictEqual(locked.verdict, 'FAIL');
});

test('verdict: a month short of the target is NOT YET, with what is left and the days traded', () => {
  const days = run([['2026-03-02', 400], ['2026-03-04', -150]]);
  days['2026-03-03'] = [{ t: '2026-03-03T15:00:00Z', day: '2026-03-03', kind: 'trade', trades: [] }]; // replayed, no trade
  const v = evaluate(days, ACCOUNT);
  const [m] = v.months;
  assert.strictEqual(m.verdict, 'NOT YET');
  assert.deepStrictEqual([m.daysTraded, m.daysReplayed, m.profit], [2, 3, 248.52]);
  assert.match(verdictText(v), /NOT YET: profit \$248\.52 of \$6000\.00 \(\$5751\.48 to go\), 2 of 3 day\(s\) traded/);
  assert.match(verdictText(v), /days: 03-02 \+\$399\.26, 03-03 \$0\.00, 03-04 -\$150\.74/);
});

test('verdict: months are CME trading days; each is a fresh attempt; a carried position is left out; the year summary', () => {
  const v = evaluate(run([
    ['2026-03-02', 2500], ['2026-03-03', 2000], ['2026-03-04', 1600], // March: passes
    // 17:30 Chicago on March 31 is April 1's trading day (and it is recorded in the March 31 file).
    ['2026-04-01', -2500, { at: '2026-03-31T22:30:00Z', recordDay: '2026-03-31' }],
    ['2026-04-02', -1200], // April: blown
    ['2026-04-30', 0, { openOnly: true, contract: 'MES' }], // open at April's end ...
    ['2026-05-01', 800, { closeOnly: true, contract: 'MES' }], // ... closed in May: not May's attempt
    ['2026-05-04', 300],
  ]), ACCOUNT, { why: 'test' });
  assert.deepStrictEqual(v.months.map(m => [m.key, m.verdict]), [['2026-03', 'PASS'], ['2026-04', 'FAIL'], ['2026-05', 'NOT YET']]);
  assert.strictEqual(v.months[1].fail.day, '2026-04-02');
  const may = v.months[2];
  assert.strictEqual(may.profit, net(300), 'fresh from $100000, without the carried MES close');
  assert.deepStrictEqual(may.excluded.map(x => x.why), ['carried in from the month before']);
  assert.deepStrictEqual(v.summary, { months: 3, passed: 1, failed: 1, notYet: 1 });
  assert.match(verdictText(v), /Year: 1 passed, 1 failed, 1 not yet, of 3 month\(s\)\./);
  const md = verdictMarkdown(v);
  assert.match(md, /## Combine verdict[\s\S]*\| 2026-04 \| FAIL on 2026-04-02: max-loss/);
  assert.match(md, /Fresh each month/);
});

test('verdict: the same day ends as combine.js run directly on the fills (training and replay judge alike)', () => {
  const trades = [['2026-03-02', 1800], ['2026-03-02', -700, { at: '2026-03-02T16:00:00Z' }], ['2026-03-03', -900], ['2026-03-04', 2600], ['2026-03-05', 1500]];
  const v = evaluate(run(trades), ACCOUNT).months[0];
  let s = combine.start(ACCOUNT);
  const ends = [];
  for (const day of ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']) {
    for (const [d, pnl] of trades) if (d === day) s = combine.applyClose(combine.applyClose(s, -FEE), pnl - FEE);
    s = combine.endDay(s);
    ends.push([s.balance, s.floor, s.status]);
    if (s.status !== 'active') break;
  }
  assert.deepStrictEqual(v.days.map(d => [d.balance, d.floor]), ends.map(e => [e[0], e[1]]));
  assert.strictEqual(v.verdict === 'PASS' ? 'passed' : 'active', ends[ends.length - 1][2]);
});

test('verdict: a day still being replayed gets no end of day; unreadable fills are counted', () => {
  const days = run([['2026-03-02', 6500], ['2026-03-03', 100]]);
  days['2026-03-03'][0].trades.push({ id: 99, contractId: 'MNQ', creationTimestamp: '2026-03-03T15:30:00Z', profitAndLoss: 'n/a', fees: FEE, side: 0, size: 1 });
  const v = evaluate(days, { ...ACCOUNT, consistency_pct: 0 }, { daysDone: [] });
  const [m] = v.months;
  assert.strictEqual(m.verdict, 'NOT YET', 'a pass is checked at the end of a day');
  assert.deepStrictEqual(m.openDay, { day: '2026-03-03', pnl: Math.round((net(6500) + net(100)) * 100) / 100 });
  assert.strictEqual(m.unreadable, 1);
  assert.match(verdictText(v), /still being replayed/);
  assert.strictEqual(fillsOf(days).length, 5);
});

test('verdict account: --account, else a runner config naming an account, else the prop strategies\' account, else the default', () => {
  const accounts = [{ name: 'topstep_50k' }, { name: 'topstep_100k' }];
  const strategies = [{ name: 'p1', signal: 'policy', account: 'topstep_50k' }, { name: 'orb', signal: 'rules' }];
  assert.deepStrictEqual(resolveAccount({ override: 'x', runnerAccount: 'topstep_100k', strategies, accounts }), { name: 'x', why: '--account' });
  assert.strictEqual(resolveAccount({ runnerAccount: 'topstep_100k', strategies, accounts }).name, 'topstep_100k');
  assert.deepStrictEqual(resolveAccount({ runnerAccount: '1', strategies, accounts }), { name: 'topstep_50k', why: 'the prop strategy\'s account (p1)' });
  const two = resolveAccount({ strategies: [...strategies, { name: 'p2', signal: 'policy', account: 'topstep_100k' }], accounts });
  assert.strictEqual(two.name, DEFAULT_ACCOUNT);
  assert.match(two.why, /several accounts \(topstep_50k, topstep_100k\); pass --account/);
  assert.strictEqual(resolveAccount({ accounts }).name, DEFAULT_ACCOUNT);
});

test('verdict on the opencode-e2e-2 replay (one day, two trades): NOT YET, far from the target', () => {
  const dir = tmpDir();
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'fixtures', 'replay-e2e-2'))) fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'replay-e2e-2', f), path.join(dir, f));
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'replay.js'), 'report', dir], { env: { PATH: process.env.PATH, HOME: dir, FTH_HOME: dir }, encoding: 'utf8' });
  assert.match(out, /Combine verdict: topstep_100k \(the prop strategy's account/);
  assert.match(out, /2026-06 {2}NOT YET: profit \$0\.02 of \$6000\.00 \(\$5999\.98 to go\), 1 of 1 day\(s\) traded/);
  assert.match(out, /max loss used \$15\.74 of \$3000\.00 \(closest to the floor on 2026-06-02\); intraday from MAE on 2 of 2/);
  assert.match(out, /Year: 0 passed, 0 failed, 1 not yet, of 1 month\(s\)\./);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /## Combine verdict[\s\S]*\| 2026-06 \| NOT YET/);
  const named = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'replay.js'), 'report', dir, '--account', 'topstep_50k'], { env: { PATH: process.env.PATH, HOME: dir, FTH_HOME: dir }, encoding: 'utf8' });
  assert.match(named, /Combine verdict: topstep_50k \(--account\)/);
});
