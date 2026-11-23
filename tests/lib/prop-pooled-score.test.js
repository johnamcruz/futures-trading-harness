'use strict';

// The pooled combine score of many replay runs (prop/pooled-score.js, scripts/pooled-score.js): each run's trades, sides,
// gross R and dollars; the runs' trades pooled into one stream by date and scored by the one evaluator (prop/evaluator.js
// checkPooledWindow, scoreStream) as `diagnostic (picked days)`, never a promotion score; no pass rate below the score's
// minimum of independent attempts (the promotion gate's minAttempts); two groups side by side.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { TEST_SIZING } = require('../helpers');
const { checkPooledWindow, checkModelWindow, scoreStream } = require('../../scripts/lib/prop/evaluator');
const { PROMOTION_GATE } = require('../../scripts/lib/prop/promotion');
const P = require('../../scripts/lib/prop/pooled-score');
const { ACCOUNT, record, multiDayRun, weekdays, modelTrade, modelStreamOf } = require('../fixtures/prop-model');

const POLICY = { name: 'fx_policy', sizing: TEST_SIZING };
const nextDay = d => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const runOf = (runId, days, extra = {}) => ({ runId, from: days[0], to: nextDay(days[days.length - 1]), learning: false, role: null, look: null, hideOutcomes: false, ...extra });
/** One run per day: a one-morning run's entry (as readGroupRun returns it), `move` ticks on a long, or none. */
const morning = (runId, day, move, net = move === null ? 0 : move) => ({
  runId, stream: modelStreamOf([day], () => (move === null ? [] : [modelTrade(`${runId}-t`, move)])), run: runOf(runId, [day]), report: { trades: move === null ? 0 : 1, net },
});

test('checkPooledWindow: each run checked as picked days; one pass over the pooled span, labelled, never a promotion score', () => {
  const a = runOf('a', ['2022-03-01']);
  const b = runOf('b', ['2022-01-10']);
  const pass = checkPooledWindow({ runs: [a, b] });
  assert.deepStrictEqual([pass.from, pass.to, pass.diagnostic, pass.model, pass.synthetic], ['2022-01-10', '2022-03-02', 'picked days', true, false]);
  const days = ['2022-01-10', '2022-03-01'];
  const s = modelStreamOf(days, (d, k) => [modelTrade(`${d}-0`, k ? 60 : -40)]);
  const r = scoreStream(s, { pass, account: ACCOUNT, contracts: 'micro', paths: 20, reps: 50, seed: 3, rulebook: { sizing: TEST_SIZING } });
  assert.strictEqual(r.score, 'diagnostic (picked days)');
  assert.ok(r.promotion.failures.some(f => /diagnostic score \(diagnostic \(picked days\)\) is never a promotion score/.test(f)), r.promotion.failures.join('; '));
  assert.throws(() => scoreStream(s, { pass, account: ACCOUNT, paths: 1, reps: 1, rulebook: { sizing: TEST_SIZING } }), /needs the pass/, 'single use');
  // Fails closed: no runs; a hidden run; runs of two learning roles; a held-back run (its score would need a logged look:
  // a pooled score never writes into a run's ledger); a sealed run (a diagnostic score is never test's or final's).
  assert.throws(() => checkPooledWindow({ runs: [] }), /at least one run/);
  assert.throws(() => checkPooledWindow({ runs: [a, { ...b, hideOutcomes: true }] }), /reasoning-fix look/);
  assert.throws(() => checkPooledWindow({ runs: [a, runOf('c', ['2024-08-01'])] }), /not a learning run but touches/);
  const train = runOf('t', ['2022-03-01'], { learning: true, role: 'practice-train' });
  assert.ok(checkPooledWindow({ runs: [train] }).from === '2022-03-01');
  assert.throws(() => checkPooledWindow({ runs: [train, a] }), /the runs span practice-train \+ unscheduled/);
  const validate = runOf('v', ['2024-07-15'], { learning: true, role: 'practice-validate', look: { evaluation: 'v1', candidate: 'v1' } });
  assert.throws(() => checkPooledWindow({ runs: [validate] }), /logScore is required/);
  const sealed = runOf('s', ['2025-03-03'], { learning: true, role: 'test', look: { evaluation: 'e1', candidate: 'c1' } });
  assert.throws(() => checkPooledWindow({ runs: [sealed] }), /logScore is required|sealed/);
  // The single-run check takes the label too.
  assert.strictEqual(checkModelWindow({ run: a, diagnostic: 'picked days' }).diagnostic, 'picked days');
});

test('poolStreams: the runs\' days in date order, every trade kept; a day in two runs of one group refused', () => {
  const late = morning('late', '2022-03-01', 60);
  const early = morning('early', '2022-01-10', -40);
  const none = morning('none', '2022-02-01', null);
  const s = P.poolStreams([late, none, early]);
  assert.deepStrictEqual(s.days.map(d => d.day), ['2022-01-10', '2022-02-01', '2022-03-01']);
  assert.deepStrictEqual(s.trades.map(t => t.id), ['early-t', 'late-t']);
  assert.deepStrictEqual([s.source, s.rBasis, s.excluded, s.overlaps], ['model', 'gross', [], []]);
  const bad = { ...morning('x', '2022-01-12', 60), stream: { ...morning('x', '2022-01-12', 60).stream, excluded: [{ id: 'q', why: 'not closed' }] } };
  assert.deepStrictEqual(P.poolStreams([early, bad]).excluded, [{ id: 'q', why: 'not closed', runId: 'x' }]);
  assert.throws(() => P.poolStreams([early, morning('again', '2022-01-10', 60)]), /2022-01-10 is in runs early and again/);
  assert.throws(() => P.poolStreams([]), /no runs/);
});

test('runRow and groupSummary: each run\'s date, trades, sides, gross R and the report\'s dollars; the group\'s totals', () => {
  const short = { ...modelTrade('s', -20), direction: 'short' };
  const e = { runId: 'r1', stream: modelStreamOf(['2022-01-10'], () => [modelTrade('l', 60), short]), run: runOf('r1', ['2022-01-10']), report: { trades: 2, net: 12.5 } };
  const row = P.runRow(e);
  assert.deepStrictEqual([row.date, row.days, row.trades, row.long, row.short, row.grossR, row.net, row.flags], ['2022-01-10', 1, 2, 1, 1, 1, 12.5, []]);
  // The report's count and the stream's disagree, or an entry was left out: said on the row.
  assert.deepStrictEqual(P.runRow({ ...e, report: { trades: 3, net: 0 } }).flags, ['the report counts 3 trade(s), the stream 2']);
  assert.match(P.runRow({ ...e, stream: { ...e.stream, excluded: [{ why: 'x' }] } }).flags.join(), /1 entr\(y\/ies\) left out/);
  const multi = P.runRow({ ...e, stream: modelStreamOf(['2022-01-10', '2022-01-11'], () => []), report: { trades: 0, net: 0 } });
  assert.deepStrictEqual([multi.date, multi.days, multi.trades, multi.grossR], ['2022-01-10..2022-01-11', 2, 0, 0]);
  const sum = P.groupSummary([row, P.runRow(morning('r2', '2022-01-11', -40, -21.48))]);
  assert.deepStrictEqual([sum.runs, sum.days, sum.trades, sum.long, sum.short, sum.grossR, sum.meanR, sum.net], [2, 2, 3, 2, 1, 0, 0, -8.98]);
});

test('scoreGroup: below the score\'s minimum of independent attempts no Monte Carlo and no pass rate, only dollars and R', () => {
  const entries = weekdays('2022-01-03', 20).map((d, k) => morning(`m${k}`, d, k % 2 ? 60 : -40));
  const g = P.scoreGroup('G', entries, { account: ACCOUNT, policy: POLICY, paths: 20, reps: 50 });
  assert.strictEqual(g.result, null);
  assert.deepStrictEqual([g.independent, g.minimum, g.summary.days], [0, PROMOTION_GATE.minAttempts, 20]);
  assert.match(g.refused, /^0 independent attempt\(s\) \(20 day\(s\) \/ 30 sessions\) is below the minimum of 20 the score uses \(the promotion gate's minAttempts\): no pass rate, dollars and R only$/);
  const text = P.pooledText([g], { account: ACCOUNT.name, sizingFrom: 'fx_policy\'s rulebook', sessions: ACCOUNT.sessions });
  assert.match(text, /^Pooled combine score: diagnostic \(picked days\), never a promotion score/);
  assert.doesNotMatch(text, /Pass within|pass rate +\d/);
  assert.match(text, /no pass rate, dollars and R only/);
  assert.match(text, /2022-01-03 +m0 +1 +long +-1 +-40\.00/);
  // Below the minimum every run is still checked before anything of it is printed: a held-back run, runs of two roles.
  const validate = { ...morning('v', '2024-07-15', 60), run: runOf('v', ['2024-07-15'], { learning: true, role: 'practice-validate', look: { evaluation: 'v1', candidate: 'v1' } }) };
  assert.throws(() => P.scoreGroup('G', [entries[0], validate], { account: ACCOUNT, policy: POLICY }), /logScore is required/);
  const train = { ...morning('t', '2022-03-01', 60), run: runOf('t', ['2022-03-01'], { learning: true, role: 'practice-train' }) };
  assert.throws(() => P.scoreGroup('G', [entries[0], train], { account: ACCOUNT, policy: POLICY }), /the runs span/);
  const hidden = { ...entries[1], run: { ...entries[1].run, hideOutcomes: true } };
  assert.throws(() => P.scoreGroup('G', [entries[0], hidden], { account: ACCOUNT, policy: POLICY }), /reasoning-fix look/);
});

test('scoreGroup: at the minimum the pooled stream is scored by the evaluator; two groups side by side', () => {
  // A 2-session account: 40 picked mornings hold 20 independent attempts.
  const acct = { ...ACCOUNT, sessions: 2, profit_target: 100 };
  const days = weekdays('2022-01-03', 40);
  const win = P.scoreGroup('G', days.map((d, k) => morning(`g${k}`, d, k % 3 === 2 ? -40 : 80)), { account: acct, policy: POLICY, contracts: 'micro', paths: 50, reps: 100, seed: 2 });
  const lose = P.scoreGroup('N', days.map((d, k) => morning(`n${k}`, d, -40)), { account: acct, policy: POLICY, contracts: 'micro', paths: 50, reps: 100, seed: 2 });
  for (const g of [win, lose]) {
    assert.strictEqual(g.refused, null);
    assert.deepStrictEqual([g.independent, g.result.score, g.result.runDays, g.result.trades], [20, 'diagnostic (picked days)', 40, 40]);
  }
  assert.ok(win.result.real.attempts > 0 && win.result.passRate > lose.result.passRate, `${win.result.passRate} > ${lose.result.passRate}`);
  const text = P.pooledText([win, lose], { account: acct.name, sizingFrom: 'fx_policy\'s rulebook', sessions: acct.sessions });
  assert.match(text, /Arm vs arm +G +N/);
  assert.match(text, /pass rate +\d+\.\d% \[[^\]]+\] +\d+\.\d% \[[^\]]+\]/);
  for (const want of [/blow rate/, /timeout rate/, /days to pass \(median \/ p90\)/, /2\. Pass within 2 trading days/, /diagnostic \(picked days\), never a promotion score/]) assert.match(text, want);
  // An entry left out of a run (a dropped loss would flatter it) or two trades open at once: refused, as a real score.
  const holed = days.map((d, k) => morning(`h${k}`, d, 60));
  holed[0] = { ...holed[0], stream: { ...holed[0].stream, excluded: [{ root: 'MNQ', bar: 'x', why: 'not closed' }] } };
  assert.match(P.scoreGroup('H', holed, { account: acct, policy: POLICY, paths: 10, reps: 10 }).refused, /1 entr\(y\/ies\) without a settled outcome .*: a pooled score never leaves one out/);
  assert.throws(() => P.scoreGroup('G', [], { account: acct, policy: POLICY }), /group G: no runs/);
});

test('readGroupRun: a finished run home read as the report reads it (its stream and its dollars); the account the runs name', () => {
  const t0 = '2023-03-06T14:00:00.000Z';
  const { home } = multiDayRun({
    runId: 'pick1', gate: { learning: false, role: null, look: null, hideOutcomes: false },
    days: [{ day: '2023-03-06', times: [t0], records: [record({ at: t0 })], rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 104.5, 100, 104.25]],
      fills: [{ id: 1, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-06T14:01:00Z', price: 100, size: 1, side: 0, profitAndLoss: null },
        { id: 2, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-06T14:05:00Z', price: 104, size: 1, side: 1, profitAndLoss: 8, fees: 0.74 }] }],
  });
  const root = path.resolve(__dirname, '..', '..');
  for (const where of [home, path.join(home, 'replay', 'pick1')]) {
    const e = P.readGroupRun(where, { root });
    assert.deepStrictEqual([e.runId, e.stream.trades.length, e.report.trades, e.report.net, e.run.from], ['pick1', 1, 1, 7.26, '2023-03-06']);
  }
  assert.throws(() => P.readGroupRun(path.join(home, 'nowhere'), { root }), /no replay run in/);
  // End to end: run homes read and pooled through the evaluator (a 1-session account, a minimum of 1), with live limits.
  const homes = ['2023-03-07', '2023-03-08'].map((day, k) => {
    const t = `${day}T14:00:00.000Z`;
    return multiDayRun({
      runId: `pick${k + 2}`, gate: { learning: false, role: null, look: null, hideOutcomes: false },
      days: [{ day, times: [t], records: [record({ at: t })], rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 104.5, 100, 104.25]],
        fills: [{ id: 1, contractId: 'MNQ:2023-06', creationTimestamp: `${day}T14:01:00Z`, price: 100, size: 1, side: 0, profitAndLoss: null },
          { id: 2, contractId: 'MNQ:2023-06', creationTimestamp: `${day}T14:05:00Z`, price: 104, size: 1, side: 1, profitAndLoss: 8, fees: 0.74 }] }],
    }).home;
  });
  const one = { ...ACCOUNT, sessions: 1 };
  const g = P.scoreGroup('E', [home, ...homes].map(h => P.readGroupRun(h, { root })), { account: one, policy: POLICY, limits: { capUsd: 300, orderMax: null }, contracts: 'micro', minimum: 1, paths: 20, reps: 50 });
  assert.strictEqual(g.refused, null);
  assert.deepStrictEqual([g.independent, g.result.score, g.result.runDays, g.result.trades, g.summary.net], [3, 'diagnostic (picked days)', 3, 3, 21.78]);
  assert.deepStrictEqual(g.result.sizedWith, { limits: { capUsd: 300, orderMax: null }, contracts: 'micro' });
  // The account: every run must name the same one (or --account); none named: refused, no default.
  assert.deepStrictEqual(P.agreeAccount([{ name: 'a', why: 'x' }, { name: 'a', why: 'y' }]), 'a');
  assert.throws(() => P.agreeAccount([{ name: 'a' }, { name: 'b' }]), /the runs name different accounts \(a, b\): pass --account/);
  assert.throws(() => P.agreeAccount([{ name: null, why: 'no account: pass --account (no default account)' }]), /no account: pass --account/);
});

test('the CLI (scripts/pooled-score.js): groups, homes and flags', () => {
  const CLI = require('../../scripts/pooled-score');
  assert.throws(() => CLI.parse([]), /usage: pooled-score.js/);
  assert.deepStrictEqual(CLI.parse(['a', 'b']).groups, [{ name: 'all', homes: ['a', 'b'] }]);
  const o = CLI.parse(['--group', 'G=a', 'b', '--group', 'N=c', 'd', '--account', 'x', '--bars', 'MNQ=f']);
  assert.deepStrictEqual([o.groups, o.account, o.barsFiles], [[{ name: 'G', homes: ['a', 'b'] }, { name: 'N', homes: ['c', 'd'] }], 'x', { MNQ: 'f' }]);
  assert.throws(() => CLI.parse(['--group', 'G=a', '--group', 'G=b']), /group G given twice/);
  assert.throws(() => CLI.parse(['a', '--group', 'G=b']), /homes before the first --group/);
  assert.throws(() => CLI.parse(['--group', '=a']), /--group NAME=<home>/);
  assert.throws(() => CLI.parse(['--nope']), /unknown argument --nope/);
});
