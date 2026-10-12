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
  // No daily limit here, so only the floor can act (with one, the nearer level acts first: next test).
  const noDaily = { ...ACCOUNT, daily_loss_limit: 0 };
  const trades = [['2026-03-02', 2500], ['2026-03-03', -100, { mae: -3100 }]];
  const v = evaluate(run(trades), noDaily).months[0];
  assert.deepStrictEqual([v.verdict, v.fail.day], ['FAIL', '2026-03-03']);
  assert.match(v.fail.how, /equity reached \$99398\.52 \(from the trade's MAE\), floor \$99499\.26/);
  assert.strictEqual(v.maxLossUsed, 3000);
  // Static: the floor stays at $97000; the same MAE doesn't reach it.
  const flat = evaluate(run(trades), { ...noDaily, max_loss_mode: 'static' }).months[0];
  assert.strictEqual(flat.verdict, 'NOT YET');
  // The floor stops at the starting balance: after a $3500 day it is $100000, not $100499.26.
  const locked = evaluate(run([['2026-03-02', 3500], ['2026-03-03', -3600]]), noDaily).months[0];
  assert.strictEqual(locked.days[0].floor, 100000);
  assert.strictEqual(locked.verdict, 'FAIL');
});

test('verdict: of the daily limit and the floor, the nearer one acts first as the open loss grows', () => {
  // After a +$2500 day the cushion is $2999.63 and the daily room $2000: the daily limit is reached
  // first, so a $3100 MAE is flattened at -$2000 and the month goes on.
  const v = evaluate(run([['2026-03-02', 2500], ['2026-03-03', -100, { mae: -3100 }]]), ACCOUNT).months[0];
  assert.strictEqual(v.verdict, 'NOT YET');
  assert.deepStrictEqual(v.days.map(d => d.pnl), [net(2500), -2000].map(x => Math.round(x * 100) / 100));
  assert.strictEqual(v.events.length, 1);
  // With the cushion smaller than the daily room, the floor comes first: FAIL, not a daily stop.
  const f = evaluate(run([['2026-03-02', -1500], ['2026-03-03', -1600]]), ACCOUNT).months[0];
  assert.deepStrictEqual([f.verdict, f.fail.day, f.events.length], ['FAIL', '2026-03-03', 0]);
  assert.strictEqual(f.fail.how, 'equity closed at $96898.52, floor $97000');
});

test('verdict: the daily limit flattens the whole position; max loss used counts only what the cap let through', () => {
  // Two contracts, closed one at a time, each -$2500: the first close takes the day to the limit, the
  // rest of the position is flattened with it (static floor $10000 away, so only the daily limit acts).
  const t = ms => new Date(Date.parse('2026-03-02T15:00:00Z') + ms * 60000).toISOString();
  const days = { '2026-03-02': [{ t: t(5), day: '2026-03-02', kind: 'trade', trades: [
    { id: 1, contractId: 'MNQ', creationTimestamp: t(0), profitAndLoss: null, fees: FEE, side: 0, size: 2 },
    { id: 2, contractId: 'MNQ', creationTimestamp: t(1), profitAndLoss: -2500, fees: FEE, side: 1, size: 1 },
    { id: 3, contractId: 'MNQ', creationTimestamp: t(2), profitAndLoss: -2500, fees: FEE, side: 1, size: 1 },
  ] }] };
  const v = evaluate(days, { ...ACCOUNT, max_loss_mode: 'static', max_loss: 10000 }).months[0];
  assert.deepStrictEqual(v.days.map(d => d.pnl), [-2000]);
  assert.deepStrictEqual(v.excluded.map(x => [x.contract, x.why]), [['MNQ', 'flattened at the daily loss limit']]);
  assert.strictEqual(v.maxLossUsed, 2000);
  // A trade closing at -$2900 on topstep_100k: the day is capped at -$2000, and so is the max loss used.
  const one = evaluate(run([['2026-03-02', -2900]]), ACCOUNT).months[0];
  assert.deepStrictEqual([one.verdict, one.maxLossUsed], ['NOT YET', 2000]);
});

test('verdict: fills with an unreadable side or size are counted, not tracked; fills filed under another day still count', () => {
  const days = run([['2026-03-02', 300], ['2026-03-03', 200, { recordDay: '2026-03-04' }], ['2026-03-04', 100]]);
  days['2026-03-02'][0].trades.push({ id: 50, contractId: 'MES', creationTimestamp: '2026-03-02T15:30:00Z', profitAndLoss: null, fees: FEE, side: 'buy', size: 1 });
  const m = evaluate(days, ACCOUNT).months[0];
  assert.strictEqual(m.unreadable, 1);
  assert.deepStrictEqual(m.days.map(d => [d.day, d.pnl]), [['2026-03-02', net(300)], ['2026-03-03', net(200)], ['2026-03-04', net(100)]].map(([d, x]) => [d, Math.round(x * 100) / 100]));
});

test('verdict: a month with more days than the account\'s training length says training would have stopped', () => {
  const v = evaluate(run([['2026-03-02', 100], ['2026-03-03', 100], ['2026-03-04', 100]]), { ...ACCOUNT, sessions: 2 });
  assert.strictEqual(v.months[0].verdict, 'NOT YET');
  assert.match(verdictText(v), /more days than the account's training length \(2 sessions\)/);
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
  assert.match(verdictText(v), /Summary: 1 passed, 1 failed, 1 not yet, of 3 month\(s\)\./);
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

test('verdict: an unreadable fill leaves its position unknown; the next month assumes it flat and says so', () => {
  const days = run([['2026-03-02', 100, { openOnly: true }]]);
  days['2026-03-02'][0].trades.push({ id: 90, contractId: 'MNQ', creationTimestamp: '2026-03-02T15:30:00Z', profitAndLoss: 100, fees: FEE, side: null, size: 1 });
  Object.assign(days, run([['2026-04-01', 3000], ['2026-04-02', 3000], ['2026-04-03', 1000]].map(([d, p]) => [d, p, {}])));
  // run() numbers ids from 1 again: give April's fills their own.
  for (const d of ['2026-04-01', '2026-04-02', '2026-04-03']) for (const f of days[d][0].trades) f.id = `${d}-${f.id}`;
  const v = evaluate(days, ACCOUNT);
  const [mar, apr] = v.months;
  assert.strictEqual(mar.unreadable, 1);
  assert.deepStrictEqual([apr.verdict, apr.passDay, apr.excluded.length], ['PASS', '2026-04-03', 0]);
  assert.match(apr.notes[0], /MNQ: position unknown after an unreadable fill on 2026-03-02; assumed flat/);
  assert.match(verdictText(v), /assumed flat from the start of the month/);
});

test('verdict: an opening fee that reaches the daily limit flattens the account too', () => {
  const t = ms => new Date(Date.parse('2026-03-02T15:00:00Z') + ms * 60000).toISOString();
  const days = run([['2026-03-02', -1999, { at: t(0) }]]);
  days['2026-03-02'].push({ t: t(5), day: '2026-03-02', kind: 'trade', trades: [
    { id: 10, contractId: 'MNQ', creationTimestamp: t(2), profitAndLoss: null, fees: 1, side: 0, size: 1 },
    { id: 11, contractId: 'MNQ', creationTimestamp: t(3), profitAndLoss: -500, fees: FEE, side: 1, size: 1 },
  ] });
  const m = evaluate(days, { ...ACCOUNT, max_loss_mode: 'static', max_loss: 5000 }).months[0];
  assert.deepStrictEqual(m.days.map(d => d.pnl), [-2000.74]);
  assert.deepStrictEqual(m.excluded.map(x => x.why), ['flattened at the daily loss limit']);
  assert.match(m.events[0].text, /hit by an opening fill's fee/);
});

test('verdict: a day known only from a fill, before the last day done, gets its end of day', () => {
  // 03-03's trade is filed under 03-04 (no 03-03 file); the run has finished 03-04.
  const days = run([['2026-03-03', 200, { recordDay: '2026-03-04' }], ['2026-03-04', 100]]);
  const m = evaluate(days, ACCOUNT, { daysDone: ['2026-03-04'] }).months[0];
  assert.deepStrictEqual(m.days.map(d => d.day), ['2026-03-03', '2026-03-04']);
  assert.strictEqual(m.openDay, null);
});

test('verdict: a round trip\'s MAE counts from the balance when the position opened, not after profitable partial exits', () => {
  // Long 2 MNQ (no fees): 1 closed at +$2000, then the other at -$50; the round trip's MAE was -$3100.
  const t = ms => new Date(Date.parse('2026-03-02T15:00:00Z') + ms * 60000).toISOString();
  const partial = (first, mae) => ({ '2026-03-02': [{ t: t(5), day: '2026-03-02', kind: 'trade', trades: [
    { id: 1, contractId: 'MNQ', creationTimestamp: t(0), profitAndLoss: null, fees: 0, side: 0, size: 2 },
    { id: 2, contractId: 'MNQ', creationTimestamp: t(1), profitAndLoss: first, fees: 0, side: 1, size: 1 },
    { id: 3, contractId: 'MNQ', creationTimestamp: t(2), profitAndLoss: -50, fees: 0, side: 1, size: 1, roundTrip: { maeDollars: mae } },
  ] }] });
  // Without a daily limit the floor acts: equity at the MAE was $96900, under the $97000 floor.
  const noDaily = evaluate(partial(2000, -3100), { ...ACCOUNT, daily_loss_limit: 0 }).months[0];
  assert.strictEqual(noDaily.verdict, 'FAIL');
  assert.strictEqual(noDaily.fail.how, 'equity reached $96900 (from the trade\'s MAE), floor $97000');
  // With topstep_100k's $2000 daily limit, nearer than the floor from the open, the day is flattened at -$2000.
  const daily = evaluate(partial(2000, -3100), ACCOUNT).months[0];
  assert.deepStrictEqual([daily.verdict, daily.days.map(d => d.pnl)], ['NOT YET', [-2000]]);
  const smaller = evaluate(partial(1500, -2100), ACCOUNT).months[0];
  assert.deepStrictEqual([smaller.verdict, smaller.days.map(d => d.pnl), smaller.events.length], ['NOT YET', [-2000], 1]);
});

test('verdict: a left-out contract whose position an unreadable fill made unknown counts again next month', () => {
  // A position opened after the daily limit (left out), then an unreadable close: April's trades on it count.
  const days = run([['2026-03-02', -2500, { at: '2026-03-02T15:00:00Z' }], ['2026-03-02', 0, { at: '2026-03-02T16:00:00Z', openOnly: true }]]);
  days['2026-03-02'][1].trades.push({ id: 'x', contractId: 'MNQ', creationTimestamp: '2026-03-02T16:30:00Z', profitAndLoss: 10, fees: FEE, side: 7, size: 1 });
  Object.assign(days, run([['2026-04-01', 300]]));
  for (const f of days['2026-04-01'][0].trades) f.id = `apr-${f.id}`;
  const [mar, apr] = evaluate(days, ACCOUNT).months;
  assert.deepStrictEqual(mar.excluded.map(x => x.why), ['opened after the daily loss limit was hit']);
  assert.deepStrictEqual([apr.excluded.length, apr.profit], [0, net(300)]);
});

// Fills at minutes past 15:00 UTC on a day: [minute, contract, side, size, P&L (null: opening), MAE or undefined,
// the minute of the MAE or undefined, the round trip's entry time (ISO) or undefined]. MAE as backtester-mcp
// reports it: the round trip's worst P&L from its open, partial exits included, on the fill that ends it, with
// the round trip's entryTime (here: the contract's last opening fill in the rows, unless given).
function fillsOn(day, rows, idPrefix = day) {
  const t = n => new Date(Date.parse(`${day}T15:00:00Z`) + n * 60000).toISOString();
  const entryOf = (c, k) => { const o = rows.slice(0, k).filter(r => r[1] === c && r[4] === null).pop(); return o ? t(o[0]) : undefined; };
  return [{ t: t(59), day, kind: 'trade', trades: rows.map(([n, c, side, size, pnl, mae, maeAt, entry], k) => ({
    id: `${idPrefix}-${k}`, contractId: c, creationTimestamp: t(n), profitAndLoss: pnl, fees: 0, side, size,
    ...(mae !== undefined ? { roundTrip: { maeDollars: mae, entryTime: entry || entryOf(c, k), ...(maeAt !== undefined ? { maeTime: t(maeAt) } : {}) } } : {}),
  })) }];
}

test('verdict: a position held overnight - the close past the daily limit is still capped (no MAE needed)', () => {
  const days = {
    '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 2, null], [1, 'MNQ', 1, 1, 1500]]),
    '2026-03-03': fillsOn('2026-03-03', [[0, 'MES', 0, 1, null], [1, 'MNQ', 1, 1, -2100], [2, 'MES', 1, 1, -500]]),
  };
  const m = evaluate(days, ACCOUNT).months[0];
  assert.deepStrictEqual(m.days.map(d => d.pnl), [1500, -2000]);
  assert.deepStrictEqual(m.excluded.map(x => [x.contract, x.why]), [['MES', 'flattened at the daily loss limit']]);
});

test('verdict: a position held overnight - its MAE is judged on each day\'s own floor, and from the start of the closing day', () => {
  // 03-02: long 2, 1 closed at +$1500 (end of day: balance $101500, floor $98500). 03-03: the other closed at -$50.
  const held = mae => ({
    '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 2, null], [1, 'MNQ', 1, 1, 1500]]),
    '2026-03-03': fillsOn('2026-03-03', [[1, 'MNQ', 1, 1, -50, mae]]),
  });
  // The MAE counts from the open with the +$1500 banked, so on 03-03 equity was $100000 + MAE against 03-03's floor
  // ($98500); on 03-02, $100000 + MAE against $97000.
  const noDaily = { ...ACCOUNT, daily_loss_limit: 0 };
  assert.strictEqual(evaluate(held(-1400), noDaily).months[0].verdict, 'NOT YET');
  const f = evaluate(held(-2000), noDaily).months[0];
  assert.deepStrictEqual([f.verdict, f.fail.day, f.fail.how], ['FAIL', '2026-03-03', 'equity reached $98000 (from the trade\'s MAE), floor $98500']);
  // Its time says it was on 03-02 (minute 0, before the partial exit): only 03-02's floor counts.
  const at = held(-2000);
  Object.assign(at['2026-03-03'][0].trades[0].roundTrip, { maeTime: '2026-03-02T15:00:30.000Z', entryTime: '2026-03-02T15:00:00.000Z' });
  assert.strictEqual(evaluate(at, noDaily).months[0].verdict, 'NOT YET');
  // Banked today, drawn down first: 03-03 closes 1 at +$1500, then the other at -$50 after an MAE of -$2100.
  const days = {
    '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 2, null]]),
    '2026-03-03': fillsOn('2026-03-03', [[1, 'MNQ', 1, 1, 1500], [2, 'MNQ', 1, 1, -50, -2100]]),
  };
  const b = evaluate(days, ACCOUNT).months[0];
  assert.deepStrictEqual([b.days.map(d => d.pnl), b.events.length], [[0, -2000], 1]);
});

test('verdict: a reversal starts a new position\'s base; a loss on another contract in between counts at the close', () => {
  const noDaily = { ...ACCOUNT, daily_loss_limit: 0 };
  // Long 1, then sell 2 at +$1500 (closes the long, opens a short at $101500), short closed at -$50 after an MAE of -$3200.
  const rev = { '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 1, null], [1, 'MNQ', 1, 2, 1500], [2, 'MNQ', 0, 1, -50, -3200]]) };
  assert.strictEqual(evaluate(rev, noDaily).months[0].verdict, 'NOT YET', 'from $101500 the floor ($97000) is $4500 away');
  // Long MNQ; an MES trade loses $1000; MNQ closes at +$100 after an MAE of -$2500: $99000 - $2500 is under $97000.
  const other = { '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 1, null], [1, 'MES', 0, 1, null], [2, 'MES', 1, 1, -1000], [3, 'MNQ', 1, 1, 100, -2500]]) };
  const o = evaluate(other, noDaily).months[0];
  assert.deepStrictEqual([o.verdict, o.fail.how], ['FAIL', 'equity reached $96500 (from the trade\'s MAE), floor $97000']);
});

test('verdict: losing partial exits are not counted twice (the MAE already includes them)', () => {
  const noDaily = { ...ACCOUNT, daily_loss_limit: 0 };
  // Long 2: 1 closed at -$1500, the other at -$500 after an MAE of -$2000 (from the open): worst equity $98000.
  const a = { '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 2, null], [1, 'MNQ', 1, 1, -1500], [2, 'MNQ', 1, 1, -500, -2000]]) };
  assert.strictEqual(evaluate(a, noDaily).months[0].verdict, 'NOT YET');
  // The day's worst was -$1800: no daily stop; the day is -$1800.
  const b = { '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 2, null], [1, 'MNQ', 1, 1, -1500], [2, 'MNQ', 1, 1, -300, -1800]]) };
  const mb = evaluate(b, ACCOUNT).months[0];
  assert.deepStrictEqual([mb.days.map(d => d.pnl), mb.events.length], [[-1800], 0]);
  // Overnight: the partial on 03-02, the last close on 03-03; worst equity $98200 against $97000.
  const c = {
    '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 2, null], [1, 'MNQ', 1, 1, -1500]]),
    '2026-03-03': fillsOn('2026-03-03', [[1, 'MNQ', 1, 1, -300, -1800]]),
  };
  assert.strictEqual(evaluate(c, noDaily).months[0].verdict, 'NOT YET');
});

test('verdict: the MAE is judged at every state while the position was held (another contract\'s loss and recovery, other days)', () => {
  const noDaily = { ...ACCOUNT, daily_loss_limit: 0 };
  // Long MNQ; MES loses $2000 and wins it back; MNQ closes at -$50 after an MAE of -$1500: possibly $96500.
  const rows = [[0, 'MNQ', 0, 1, null], [1, 'MES', 0, 1, null], [2, 'MES', 1, 1, -2000], [3, 'MES', 0, 1, null], [4, 'MES', 1, 1, 2000]];
  const d = { '2026-03-02': fillsOn('2026-03-02', [...rows, [5, 'MNQ', 1, 1, -50, -1500]]) };
  const md = evaluate(d, noDaily).months[0];
  assert.deepStrictEqual([md.verdict, md.fail.how], ['FAIL', 'equity reached $96500 (from the trade\'s MAE), floor $97000']);
  // Its time says it was after MES won back (minute 4.5): equity $98500, no fail.
  const timed = { '2026-03-02': fillsOn('2026-03-02', [...rows, [5, 'MNQ', 1, 1, -50, -1500, 4.5]]) };
  assert.strictEqual(evaluate(timed, noDaily).months[0].verdict, 'NOT YET');
  // The same with the daily limit: MES -$1500 and back, MNQ's MAE -$600: the day may have reached -$2100.
  const e = { '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 1, null], [1, 'MES', 0, 1, null], [2, 'MES', 1, 1, -1500], [3, 'MES', 0, 1, null], [4, 'MES', 1, 1, 1500], [5, 'MNQ', 1, 1, -50, -600]]) };
  assert.deepStrictEqual(evaluate(e, ACCOUNT).months[0].days.map(x => x.pnl), [-2000]);
  // Held over days: the floor locks at $100000 on 03-02; MNQ opens 03-03 at $103000, MES loses $2500 that day,
  // wins $2000 on 03-04; MNQ closes 03-05 at -$50 after an MAE of -$1000: after the MES loss, $100500 - $1000.
  const f = {
    '2026-03-02': fillsOn('2026-03-02', [[0, 'MES', 0, 1, null], [1, 'MES', 1, 1, 3000]]),
    '2026-03-03': fillsOn('2026-03-03', [[0, 'MNQ', 0, 1, null], [1, 'MES', 0, 1, null], [2, 'MES', 1, 1, -2500]]),
    '2026-03-04': fillsOn('2026-03-04', [[0, 'MES', 0, 1, null], [1, 'MES', 1, 1, 2000]]),
    '2026-03-05': fillsOn('2026-03-05', [[0, 'MNQ', 1, 1, -50, -1000]]),
  };
  const mf = evaluate(f, noDaily).months[0];
  assert.deepStrictEqual([mf.verdict, mf.fail.day], ['FAIL', '2026-03-03']);
});

test('verdict: an earlier day\'s state is judged against its floor only; the levels\' exact edges', () => {
  // 03-02: MES -$1500, then MNQ opens (that day's room $500); MNQ closes 03-03 at -$50 after an MAE of -$1000:
  // 03-02's limit is not this day's; on 03-03 the room is $2000. No daily stop.
  const days = {
    '2026-03-02': fillsOn('2026-03-02', [[0, 'MES', 0, 1, null], [1, 'MES', 1, 1, -1500], [2, 'MNQ', 0, 1, null]]),
    '2026-03-03': fillsOn('2026-03-03', [[0, 'MNQ', 1, 1, -50, -1000]]),
  };
  const m = evaluate(days, ACCOUNT).months[0];
  assert.deepStrictEqual([m.verdict, m.events.length, m.days.map(d => d.pnl)], ['NOT YET', 0, [-1500, -50]]);
  const noDaily = { ...ACCOUNT, daily_loss_limit: 0 };
  // A loss of exactly the cushion reaches the floor.
  const exact = { '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 1, null], [1, 'MNQ', 1, 1, -3000]]) };
  assert.strictEqual(evaluate(exact, noDaily).months[0].verdict, 'FAIL');
  // A loss of exactly the daily room (nearer than the floor) stops the day.
  const room = { '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 1, null], [1, 'MNQ', 1, 1, 50, -2000]]) };
  assert.deepStrictEqual(evaluate(room, ACCOUNT).months[0].days.map(d => d.pnl), [-2000]);
  // Room equal to the cushion ($2000 each after a -$1000 day): the floor is reached (flattening at the limit would land on it too).
  const tie = {
    '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 1, null], [1, 'MNQ', 1, 1, -1000]]),
    '2026-03-03': fillsOn('2026-03-03', [[0, 'MNQ', 0, 1, null], [1, 'MNQ', 1, 1, 50, -2000]]),
  };
  assert.strictEqual(evaluate(tie, ACCOUNT).months[0].verdict, 'FAIL');
});

test('verdict: an MAE at its time, on its own day: partials banked on earlier days, a day stopped before the close day, a pass undone', () => {
  const wide = { ...ACCOUNT, max_loss_mode: 'static', max_loss: 10000 }; // the floor out of the way
  // 03-02: long 2, 1 closed at +$1500; 03-03: the other at -$50 after an MAE of -$1000 (from the open): it was at -$2500 on 03-03.
  const banked = (first, mae, maeAt) => ({
    '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 2, null], [1, 'MNQ', 1, 1, first]]),
    '2026-03-03': fillsOn('2026-03-03', [[60, 'MNQ', 1, 1, -50, mae, maeAt, '2026-03-02T15:00:00.000Z']]),
  });
  for (const at of [30, undefined]) {
    const a = evaluate(banked(1500, -1000, at), wide).months[0];
    assert.deepStrictEqual(a.days.map(d => d.pnl), [1500, -2000], `stopped on 03-03 (maeTime ${at})`);
    // Banked -$1500 the day before; an MAE of -$2000 means only -$500 on 03-03: no stop.
    const b = evaluate(banked(-1500, -2000, at), wide).months[0];
    assert.deepStrictEqual([b.days.map(d => d.pnl), b.events.length], [[-1500, -50], 0], `no stop (maeTime ${at})`);
  }
  // Opened 03-02, at -$2500 at 15:30 that day, closed 03-03 at +$3000: 03-02 is stopped at -$2000, the close left out.
  const early = {
    '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 1, null]]),
    '2026-03-03': fillsOn('2026-03-03', [[0, 'MNQ', 1, 1, 3000, -2500]]),
  };
  Object.assign(early['2026-03-03'][0].trades[0].roundTrip, { maeTime: '2026-03-02T15:30:00.000Z', entryTime: '2026-03-02T15:00:00.000Z' });
  const e = evaluate(early, ACCOUNT).months[0];
  assert.deepStrictEqual([e.days.map(d => d.pnl), e.events[0].day, e.excluded.length], [[-2000, 0], '2026-03-02', 1]);
  // MES +$3400 on 03-02; 03-03: MNQ opens, MES opens and closes +$3400 (a pass at the day's end) - but MNQ was at
  // -$2100 at 15:05, before the MES win: the day stops at -$2000 there and there is no pass.
  const pass = {
    '2026-03-02': fillsOn('2026-03-02', [[0, 'MES', 0, 1, null], [1, 'MES', 1, 1, 3400]]),
    '2026-03-03': fillsOn('2026-03-03', [[0, 'MNQ', 0, 1, null], [1, 'MES', 0, 1, null], [10, 'MES', 1, 1, 3400]]),
    '2026-03-04': fillsOn('2026-03-04', [[0, 'MNQ', 1, 1, 100, -2100]]),
  };
  Object.assign(pass['2026-03-04'][0].trades[0].roundTrip, { maeTime: '2026-03-03T15:05:00.000Z', entryTime: '2026-03-03T15:00:00.000Z' });
  const p = evaluate(pass, ACCOUNT).months[0];
  assert.deepStrictEqual([p.verdict, p.days.map(d => d.pnl)], ['NOT YET', [3400, -2000, 0]]);
  // Without its time, the pass stands, and says a position was open.
  delete pass['2026-03-04'][0].trades[0].roundTrip.maeTime;
  const q = evaluate(pass, ACCOUNT).months[0];
  assert.deepStrictEqual([q.verdict, q.passDay], ['PASS', '2026-03-03']);
  assert.match(q.notes[0], /passed on 2026-03-03 with MNQ still open/);
  // A position open at the month's end says so.
  const end = { '2026-03-31': fillsOn('2026-03-31', [[0, 'MNQ', 0, 1, null]]), '2026-04-01': fillsOn('2026-04-01', [[0, 'MNQ', 1, 1, 100]]) };
  assert.match(evaluate(end, ACCOUNT).months[0].notes[0], /MNQ still open at the end of the month/);
});

test('verdict: fees paid on partial exits count against the MAE (it is before fees)', () => {
  // Long 2; 1 closed flat paying a $100 fee ($99900); the other closed flat after an MAE of -$2950: $96950 < $97000.
  const days = fillsOn('2026-03-02', [[0, 'MNQ', 0, 2, null], [1, 'MNQ', 1, 1, 0], [2, 'MNQ', 1, 1, 0, -2950]]);
  days[0].trades[1].fees = 100;
  const m = evaluate({ '2026-03-02': days }, { ...ACCOUNT, daily_loss_limit: 0 }).months[0];
  assert.deepStrictEqual([m.verdict, m.fail.how], ['FAIL', 'equity reached $96950 (from the trade\'s MAE), floor $97000']);
});

test('verdict: an MAE event belongs to its round trip, and comes after the fills at its time (a fill at a bar\'s open, then its range)', () => {
  const wide = { ...ACCOUNT, max_loss_mode: 'static', max_loss: 10000 };
  const T5 = '2026-03-02T15:05:00.000Z';
  // Re-entry on the same bar: A closes at -$1500 at bar 5, B opens at bar 5 and its MAE (-$1000) is at bar 5.
  const reentry = { '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 1, null], [5, 'MNQ', 1, 1, -1500], [5, 'MNQ', 0, 1, null], [9, 'MNQ', 1, 1, -50, -1000, 5]]) };
  assert.deepStrictEqual(evaluate(reentry, wide).months[0].days.map(d => d.pnl), [-2000]);
  // The same as one reversing fill (sell 2 at bar 5).
  const rev = { '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 1, null], [5, 'MNQ', 1, 2, -1500], [9, 'MNQ', 0, 1, -50, -1000, 5, T5]]) };
  assert.deepStrictEqual(evaluate(rev, wide).months[0].days.map(d => d.pnl), [-2000]);
  // Another contract closes at -$1500 at the MAE's bar: after it, the day's room is $500.
  const other = { '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 1, null], [1, 'MES', 0, 1, null], [5, 'MES', 1, 1, -1500], [9, 'MNQ', 1, 1, -50, -1000, 5]]) };
  const o = evaluate(other, wide).months[0];
  assert.deepStrictEqual([o.days.map(d => d.pnl), o.events.length], [[-2000], 1]);
  assert.match(o.events[0].text, /MNQ was at \$-1000 \(its MAE, at 2026-03-02T15:05:00\.000Z\), counted as \$-500/);
  // Another contract wins $1500 at the MAE's bar: the win came first, so the room was $3500 and -$2100 doesn't stop.
  const win = { '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 1, null], [1, 'MES', 0, 1, null], [5, 'MES', 1, 1, 1500], [9, 'MNQ', 1, 1, -50, -2100, 5]]) };
  assert.deepStrictEqual(evaluate(win, wide).months[0].days.map(d => d.pnl), [1450]);
  // The floor too (static $2000 max loss, no daily limit): MNQ realizes -$1500 at 15:00, MES's MAE -$800 at 15:00.
  const floor = { '2026-03-02': fillsOn('2026-03-02', [[-5, 'MNQ', 0, 1, null], [-1, 'MES', 0, 1, null], [0, 'MNQ', 1, 1, -1500], [30, 'MES', 1, 1, -100, -800, 0]]) };
  const fl = evaluate(floor, { ...ACCOUNT, max_loss_mode: 'static', max_loss: 2000, daily_loss_limit: 0 }).months[0];
  assert.deepStrictEqual([fl.verdict, fl.fail.how], ['FAIL', 'equity reached $97700 (from the trade\'s MAE), floor $98000']);
  // A new position after one flattened at the limit: its own MAE (-$2500 at its entry bar) stops its day.
  const stale = {
    '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 2, null], [1, 'MNQ', 1, 1, -1000], [2, 'MES', 0, 1, null], [3, 'MES', 1, 1, -1500], [4, 'MNQ', 1, 1, 0]]),
    '2026-03-03': fillsOn('2026-03-03', [[0, 'MNQ', 0, 1, null], [5, 'MNQ', 1, 1, 100, -2500, 0]]),
  };
  assert.deepStrictEqual(evaluate(stale, wide).months[0].days.map(d => d.pnl), [-2000, -2000]);
});

test('verdict: an MAE event after a pass changes nothing; the closing fee counts in it', () => {
  const passed = {
    '2026-03-02': fillsOn('2026-03-02', [[0, 'MES', 0, 1, null], [1, 'MES', 1, 1, 3000]]),
    '2026-03-03': fillsOn('2026-03-03', [[0, 'MES', 0, 1, null], [1, 'MES', 1, 1, 3000]]),
    '2026-03-04': fillsOn('2026-03-04', [[0, 'MNQ', 0, 1, null], [5, 'MNQ', 1, 1, -50, -5000, 1]]),
  };
  const p = evaluate(passed, ACCOUNT).months[0];
  assert.deepStrictEqual([p.verdict, p.passDay], ['PASS', '2026-03-03']);
  // MAE -$2950 at bar 1 and a $100 closing fee: -$3050 against a $3000 cushion.
  const fee = { '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 1, null], [5, 'MNQ', 1, 1, 0, -2950, 1]]) };
  fee['2026-03-02'][0].trades[1].fees = 100;
  const f = evaluate(fee, { ...ACCOUNT, daily_loss_limit: 0 }).months[0];
  assert.deepStrictEqual([f.verdict, f.fail.how], ['FAIL', 'equity reached $96950 (from the trade\'s MAE), floor $97000']);
  // A position left out (opened after the daily limit) still open at the month's end gets no note.
  const leftOut = { '2026-03-31': fillsOn('2026-03-31', [[0, 'MES', 0, 1, null], [1, 'MES', 1, 1, -2500], [2, 'MNQ', 0, 1, null]]), '2026-04-01': fillsOn('2026-04-01', [[0, 'MNQ', 1, 1, 0]]) };
  assert.deepStrictEqual(evaluate(leftOut, ACCOUNT).months[0].notes, []);
});

test('verdict: an MAE event is used only for its own round trip, inside it; a position open at a pass isn\'t judged after it', () => {
  const noDaily = { ...ACCOUNT, daily_loss_limit: 0 };
  // MNQ held while MES loses $2000 and wins it back; MNQ's MAE (-$1500) is timed after the recovery, but its round
  // trip's entry (15:03) is no position the run opened: the event is not used, every state is judged, and one fails.
  const rows = [[0, 'MNQ', 0, 1, null], [1, 'MES', 0, 1, null], [2, 'MES', 1, 1, -2000], [3, 'MES', 0, 1, null], [4, 'MES', 1, 1, 2000]];
  const odd = { '2026-03-02': fillsOn('2026-03-02', [...rows, [9, 'MNQ', 1, 1, -50, -1500, 8, '2026-03-02T15:03:00.000Z']]) };
  assert.strictEqual(evaluate(odd, noDaily).months[0].verdict, 'FAIL');
  // An MAE timed after its own close is not used either (and adds no day).
  const late = { '2026-03-02': fillsOn('2026-03-02', [[0, 'MNQ', 0, 1, null], [5, 'MNQ', 1, 1, 100, -100]]) };
  late['2026-03-02'][0].trades[1].roundTrip.maeTime = '2026-03-04T15:00:00.000Z';
  assert.deepStrictEqual(evaluate(late, ACCOUNT).months[0].days.map(d => d.day), ['2026-03-02']);
  // MNQ opens 03-03, MES +$3000 twice passes the month on 03-03; MNQ's MAE (-$7000) is on 03-04, after the pass.
  const after = {
    '2026-03-02': fillsOn('2026-03-02', [[0, 'MES', 0, 1, null], [1, 'MES', 1, 1, 3000]]),
    '2026-03-03': fillsOn('2026-03-03', [[0, 'MNQ', 0, 1, null], [1, 'MES', 0, 1, null], [2, 'MES', 1, 1, 3000]]),
    '2026-03-04': fillsOn('2026-03-04', [[5, 'MNQ', 1, 1, -50, -7000, 1, '2026-03-03T15:00:00.000Z']]),
  };
  const a = evaluate(after, noDaily).months[0];
  assert.deepStrictEqual([a.verdict, a.passDay], ['PASS', '2026-03-03']);
});

test('verdict account: --account, else a runner config naming an account, else the prop strategies\' account, else the default', () => {
  const accounts = [{ name: 'topstep_50k' }, { name: 'topstep_100k' }];
  const strategies = [{ name: 'p1', signal: 'policy', account: 'topstep_50k' }, { name: 'orb', signal: 'rules' }];
  assert.deepStrictEqual(resolveAccount({ override: 'x', runnerAccount: 'topstep_100k', strategies, accounts }), { name: 'x', why: '--account' });
  assert.strictEqual(resolveAccount({ runnerAccount: 'topstep_100k', strategies, accounts }).name, 'topstep_100k');
  assert.deepStrictEqual(resolveAccount({ runnerAccount: '1', strategies, accounts }), { name: 'topstep_50k', why: 'the policy strategies\' account (p1)' });
  const two = resolveAccount({ strategies: [...strategies, { name: 'p2', signal: 'policy', account: 'topstep_100k' }], accounts });
  assert.strictEqual(two.name, DEFAULT_ACCOUNT);
  assert.match(two.why, /several accounts \(topstep_50k, topstep_100k\); pass --account/);
  assert.strictEqual(resolveAccount({ accounts }).name, DEFAULT_ACCOUNT);
});

test('verdict on the opencode-e2e-2 replay (one day, two trades): NOT YET, far from the target', () => {
  const dir = tmpDir();
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'fixtures', 'replay-e2e-2'))) fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'replay-e2e-2', f), path.join(dir, f));
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'replay.js'), 'report', dir], { env: { PATH: process.env.PATH, HOME: dir, FTH_HOME: dir }, encoding: 'utf8' });
  assert.match(out, /Combine verdict: topstep_100k \(the policy strategies' account/);
  assert.match(out, /2026-06 {2}NOT YET: profit \$0\.02 of \$6000\.00 \(\$5999\.98 to go\), 1 of 1 day\(s\) traded/);
  assert.match(out, /max loss used \$15\.74 of \$3000\.00 \(closest to the floor on 2026-06-02\); intraday from MAE on 2 of 2/);
  assert.match(out, /Summary: 0 passed, 0 failed, 1 not yet, of 1 month\(s\)\./);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /## Combine verdict[\s\S]*\| 2026-06 \| NOT YET/);
  const named = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'replay.js'), 'report', dir, '--account', 'topstep_50k'], { env: { PATH: process.env.PATH, HOME: dir, FTH_HOME: dir }, encoding: 'utf8' });
  assert.match(named, /Combine verdict: topstep_50k \(--account\)/);
});
