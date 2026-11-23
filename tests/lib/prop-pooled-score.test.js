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
  assert.throws(() => checkPooledWindow({ runs: [sealed] }), /test is sealed and judged on every bar, as live: a picked days score is practice's, never test's/);
  // The pooled pass holds each run's own window: a day between the runs (a month the runs never read) is refused.
  const gap = modelStreamOf(['2022-01-10', '2022-02-01', '2022-03-01'], () => []);
  assert.throws(() => scoreStream(gap, { pass: checkPooledWindow({ runs: [a, b] }), account: ACCOUNT, paths: 1, reps: 1, rulebook: { sizing: TEST_SIZING } }), /day 2022-02-01 lies outside every pooled run's own window/);
  assert.deepStrictEqual(checkPooledWindow({ runs: [a, b] }).windows, [{ from: '2022-03-01', to: '2022-03-02' }, { from: '2022-01-10', to: '2022-01-11' }]);
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
  // A run whose stream holds a day outside its own window (as single-run scoring refuses): refused.
  const stray = { ...early, stream: modelStreamOf(['2022-01-10', '2022-01-11'], () => []) };
  assert.throws(() => P.poolStreams([stray]), /run early's stream holds 2022-01-11, outside its own window 2022-01-10\.\.2022-01-11/);
});

test('runRow and groupSummary: each run\'s date, trades, sides, gross R and the report\'s dollars; the group\'s totals', () => {
  const short = { ...modelTrade('s', -20), direction: 'short' };
  const e = { runId: 'r1', stream: modelStreamOf(['2022-01-10'], () => [modelTrade('l', 60), short]), run: runOf('r1', ['2022-01-10']), report: { trades: 2, net: 12.5 } };
  const row = P.runRow(e);
  assert.deepStrictEqual([row.date, row.days, row.trades, row.long, row.short, row.grossR, row.net, row.flags], ['2022-01-10', 1, 2, 1, 1, 1, 12.5, []]);
  // The report's count and the stream's disagree, or an entry was left out: said on the row.
  assert.deepStrictEqual(P.runRow({ ...e, report: { trades: 3, net: 0 } }).flags, ['the report counts 3 trade(s), the stream 2']);
  assert.match(P.runRow({ ...e, stream: { ...e.stream, excluded: [{ why: 'x' }] } }).flags.join(), /1 entr\(y\/ies\) left out/);
  assert.match(P.runRow({ ...e, stream: { ...e.stream, overlaps: [{ a: 'l', b: 's', at: 'x' }] } }).flags.join(), /1 pair\(s\) open at once/);
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
  // Two trades open at once: settled alone, their combined drawdown unseen: refused.
  const both = days.map((d, k) => morning(`o${k}`, d, 60));
  both[3] = { ...both[3], stream: { ...both[3].stream, overlaps: [{ a: 'o3-t', b: 'o3-u', at: `${days[3]}T14:05:00.000Z` }] } };
  assert.match(P.scoreGroup('O', both, { account: acct, policy: POLICY, paths: 10, reps: 10 }).refused, /^1 pair\(s\) of trades open at the same time \(first in o3\): their combined drawdown would go unseen$/);
  // The report and the stream count different trades: the dollars and the pass rate would describe different trades.
  const counted = days.map((d, k) => morning(`c${k}`, d, 60));
  counted[5] = { ...counted[5], report: { trades: 2, net: 60 } };
  assert.match(P.scoreGroup('C', counted, { account: acct, policy: POLICY, paths: 10, reps: 10 }).refused, /^run c5: the report counts 2 trade\(s\), the stream 1: the dollars and the Monte Carlo would describe different trades$/);
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
  // The account: the one the runs name; --account only names one the runs leave unnamed; none: the fallback's, else refused.
  assert.strictEqual(P.agreeAccount([{ name: 'a' }, { name: 'a' }, { name: null }]), 'a');
  assert.throws(() => P.agreeAccount([{ name: 'a' }, { name: 'b' }]), /the runs name different accounts \(a, b\): pool runs of one account/);
  assert.throws(() => P.agreeAccount([{ name: 'a' }, { name: 'b' }], { override: 'a' }), /different accounts/);
  assert.throws(() => P.agreeAccount([{ name: 'a' }], { override: 'b' }), /--account b, but the runs name a: --account only names the account of runs that name none/);
  assert.strictEqual(P.agreeAccount([{ name: 'a' }], { override: 'a' }), 'a');
  assert.strictEqual(P.agreeAccount([{ name: null }], { override: 'b', fallback: { name: 'c' } }), 'b');
  assert.strictEqual(P.agreeAccount([{ name: null }], { fallback: { name: 'c' } }), 'c');
  assert.throws(() => P.agreeAccount([{ name: null }], { fallback: { name: null, why: 'no account: pass --account (no default account)' } }), /no account: pass --account/);
  // A curated run (a pinned list: its moments are outcome-balanced) or one whose days started from drawn account states:
  // the single-run score reweights or refuses them, so a pooled score refuses them, naming the run.
  const fs = require('fs');
  const runDir = path.join(home, 'replay', 'pick1');
  fs.writeFileSync(path.join(runDir, 'account-states.jsonl'), `${JSON.stringify({ kind: 'start', day: '2023-03-06', draw: 1, bucket: 'b', weight: 1 })}\n`);
  assert.throws(() => P.readGroupRun(home, { root }), /run pick1 started its days from drawn account states/);
  fs.unlinkSync(path.join(runDir, 'account-states.jsonl'));
  const C = require('../../scripts/lib/learning/curated-lists');
  const real = C.loadPinnedCurated;
  C.loadPinnedCurated = () => ({ fingerprint: 'f', list: 'mix', windows: [] });
  try { assert.throws(() => P.readGroupRun(home, { root }), /run pick1 is a curated run/); } finally { C.loadPinnedCurated = real; }
  fs.mkdirSync(path.join(home, 'experience'), { recursive: true });
  fs.writeFileSync(path.join(home, 'experience', 'curated-pinned.json'), JSON.stringify({ kind: 'curated-pin', windows: [], hash: 'x' }));
  assert.throws(() => P.readGroupRun(home, { root }), /run pick1 is a curated run .*doesn't match its hash/);
  fs.rmSync(path.join(home, 'experience'), { recursive: true });
  // A continuous-combine run (its combine log: one balance carried across its days) is never pooled.
  fs.writeFileSync(path.join(runDir, 'combine.jsonl'), `${JSON.stringify({ kind: 'start', day: '2023-03-06' })}\n`);
  assert.throws(() => P.readGroupRun(home, { root }), /run pick1 is a continuous-combine run/);
  fs.unlinkSync(path.join(runDir, 'combine.jsonl'));
  // Its own attempt record (a prop run's fresh attempt at its window's first moment) pools; one that carries a close from
  // a day outside the run's own window (a carried balance) is refused.
  fs.mkdirSync(path.join(home, 'combine'), { recursive: true });
  const attempt = days => fs.writeFileSync(path.join(home, 'combine', 'unit_x.json'), JSON.stringify({ account: 'unit_x', startedAt: '2023-03-06T00:00:00.000Z', startDay: '2023-03-06', days, snapshot: null }));
  attempt([{ day: '2023-03-06', balance: 50000, pnl: 0 }]);
  assert.strictEqual(P.readGroupRun(home, { root }).runId, 'pick1');
  attempt([{ day: '2023-03-03', balance: 50200, pnl: 200 }, { day: '2023-03-06', balance: 50200, pnl: 0 }]);
  assert.throws(() => P.readGroupRun(home, { root }), /run pick1's attempt of unit_x carries a close of 2023-03-03, outside its own window 2023-03-06\.\.2023-03-07 \(a carried balance\)/);
  fs.rmSync(path.join(home, 'combine'), { recursive: true });
  // A setup-focused practice run: its own score is `diagnostic (setup-focused)`, never whole days to pool with full-day runs.
  const t1 = '2023-03-13T14:00:00.000Z';
  const focused = multiDayRun({
    runId: 'focus1', gate: { learning: false, role: null, look: null, hideOutcomes: false, practice: { mode: 'setup-focus' } },
    days: [{ day: '2023-03-13', times: [t1], records: [record({ at: t1 })], rows: [[100.5, 100.75, 99.75, 100.25]], fills: [] }],
  });
  assert.throws(() => P.readGroupRun(focused.home, { root }), /run focus1 is a setup-focused practice run/);
  // Each run's own account: an attempt of an account that is no valid profile, or a runner account that names a profile
  // only in another case (or an invalid one), never resolves to "none" (else --account or the fallback would take over).
  const accounts = [{ name: 'unit_a', valid: true }, { name: 'unit_bad', valid: false }];
  assert.strictEqual(P.ownAccount({ runId: 'r', attempts: ['unit_a'], runnerAccount: '1', accounts }).name, 'unit_a');
  assert.strictEqual(P.ownAccount({ runId: 'r', attempts: [], runnerAccount: 'unit_a', accounts }).name, 'unit_a');
  assert.strictEqual(P.ownAccount({ runId: 'r', attempts: [], runnerAccount: '1', accounts }).name, null, 'a broker account id: no profile named');
  assert.throws(() => P.ownAccount({ runId: 'r', attempts: [], runnerAccount: 'UNIT_A', accounts }), /run r's runner config names account "UNIT_A", which does not resolve \(the profile is unit_a\)/);
  assert.throws(() => P.ownAccount({ runId: 'r', attempts: [], runnerAccount: 'unit_bad', accounts }), /run r's runner config names account "unit_bad", which does not resolve \(an invalid profile\)/);
  assert.throws(() => P.ownAccount({ runId: 'r', attempts: ['unit_gone'], runnerAccount: null, accounts }), /run r holds an attempt of account "unit_gone", which does not resolve \(no such profile\)/);
  assert.throws(() => P.ownAccount({ runId: 'r', attempts: ['unit_bad'], runnerAccount: null, accounts }), /run r holds an attempt of account "unit_bad", which does not resolve \(an invalid profile\)/);
});

test('the CLI\'s main: the account the runs name (--account only fills a missing one), one sizing for every run', () => {
  const CLI = require('../../scripts/pooled-score');
  const root = path.resolve(__dirname, '..', '..');
  const env = {};
  // The repository's own accounts and policy, by role, never by name: the one a policy trades, and another.
  const { loadAccounts } = require('../../scripts/lib/trading/accounts');
  const { loadStrategies } = require('../../scripts/lib/trading/strategies');
  const traded = loadStrategies(root, env).strategies.find(s => s.signal === 'policy' && s.account && s.status !== 'disabled').account;
  const other = loadAccounts(root, env).accounts.find(a => a.valid !== false && a.name !== traded).name;
  const mk = (day, k, runner) => {
    const t = `${day}T14:00:00.000Z`;
    return multiDayRun({
      runId: `cli${k}`, gate: { learning: false, role: null, look: null, hideOutcomes: false }, autotrader: { timeframe: 3, ...runner },
      days: [{ day, times: [t], records: [record({ at: t })], rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 104.5, 100, 104.25]],
        fills: [{ id: 1, contractId: 'MNQ:2023-06', creationTimestamp: `${day}T14:01:00Z`, price: 100, size: 1, side: 0, profitAndLoss: null },
          { id: 2, contractId: 'MNQ:2023-06', creationTimestamp: `${day}T14:05:00Z`, price: 104, size: 1, side: 1, profitAndLoss: 8, fees: 0.74 }] }],
    }).home;
  };
  const a = mk('2023-03-06', 1, { symbols: ['MNQ'], account: traded });
  const b = mk('2023-03-07', 2, { symbols: ['MNQ'], account: traded });
  const text = CLI.main([a, b], { env });
  assert.match(text, new RegExp(`account ${traded}, `));
  assert.match(text, /Group all: 2 run\(s\), 2 day\(s\)/);
  // Runs naming different accounts never pool, --account or not.
  const c = mk('2023-03-08', 3, { symbols: ['MNQ'], account: other });
  assert.throws(() => CLI.main([a, c], { env }), new RegExp(`the runs name different accounts \\((${traded}, ${other}|${other}, ${traded})\\): pool runs of one account`));
  assert.throws(() => CLI.main([a, c, '--account', traded], { env }), /different accounts/);
  assert.throws(() => CLI.main([a, b, '--account', other], { env }), new RegExp(`--account ${other}, but the runs name ${traded}`));
  // Runs naming none: --account names it.
  const d = mk('2023-03-09', 4, { symbols: ['MNQ'] });
  assert.match(CLI.main([d, '--account', traded], { env }), new RegExp(`account ${traded}, `));
  // Runs sized differently (one traded the micro, one the mini): refused, the arms aren't sized alike.
  const e = mk('2023-03-10', 5, { symbols: ['NQ'], account: traded });
  assert.throws(() => CLI.main(['--group', `G=${a}`, '--group', `N=${e}`], { env }), /the runs were sized differently/);
  // A run's runner account in another case: refused, naming the run, never filled by --account.
  const f = mk('2023-03-13', 6, { symbols: ['MNQ'], account: traded.toUpperCase() });
  assert.throws(() => CLI.main([a, f, '--account', traded], { env }), new RegExp(`run cli6's runner config names account "${traded.toUpperCase()}", which does not resolve`));
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
