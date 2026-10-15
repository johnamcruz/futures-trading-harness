'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { compileRules } = require('../../scripts/lib/trading/rules');
const { loadConfig } = require('../../scripts/lib/trading/config');
const { runEngine, prepare } = require('../../scripts/lib/backtest/engine');
const { hasSession, RECORDED_LOOKS } = require('../../scripts/lib/prop/splits');
const { gateFailures } = require('../../scripts/lib/prop/promotion');
const { checkWindow, scoreStream, sessionStart } = require('../../scripts/lib/prop/evaluator');
const { tradeStream, tradingDays, delayFromCycles, dayRegimes } = require('../../scripts/lib/prop/trade-stream');
const { readLedger, appendLook, withLedgerLock, runEvaluation } = require('../../scripts/lib/prop/evaluate-run');
const at = require('../../scripts/lib/prop/attempts');
const combine = require('../../scripts/lib/trading/combine');
const { rng, wilson } = require('../../scripts/lib/prop/stats');
const { tmpDir } = require('../helpers');

// ---- Synthetic streams (layer 2 and the statistics) ----

const account = (extra = {}) => ({
  name: 'unit', starting_balance: 50000, profit_target: 1000, max_loss: 1000, max_loss_mode: 'trailing_eod', daily_loss_limit: 600,
  daily_loss_soft: 0, consistency_pct: 0, sessions: 5, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 }, ...extra,
});
const trade = (move, extra = {}) => ({
  symbol: 'MNQ', tickValue: 0.5, tickSize: 0.25, stopTicks: 20, moveTicks: move,
  troughTicks: move < 0 ? [move] : [], overshootTicks: null, noStop: null, facts: {}, ...extra,
});
const ten = () => ({ root: 'MNQ', size: 10, riskPerContract: 11.24 });

/** The first n session dates from `from` (weekdays the exchange is open). */
function sessionDays(from, n) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); out.length < n; t += 86400000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    if (hasSession(iso)) out.push(iso);
  }
  return out;
}
function streamOf(dayList, tradesFor, fieldBranch = []) {
  const days = dayList.map((d, k) => ({ day: d, regime: k % 10 < 5 ? 'low' : 'high', trades: tradesFor(d, k).map((t, i) => ({ ...t, day: d, seq: i })) }));
  return { days, trades: days.flatMap(d => d.trades), fieldBranch, entryDelayMs: 0, runtimeMs: 1 };
}
const nextDay = iso => new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const opts = (pass, extra = {}) => ({ pass, account: account(), size: ten, contracts: 'micro', paths: 200, reps: 300, seed: 4, ...extra });
const strip = r => JSON.parse(JSON.stringify({ ...r, runtimeMs: null, look: r.look ? { ...r.look, at: null } : null }));

test('evaluator: train runs freely; the result has pass, blow and timeout rates with intervals and the effective sample size', () => {
  const list = sessionDays('2022-03-01', 60);
  // Every day +60 ticks ($292.60 at 10 micros): every attempt passes on its 4th day.
  const s = streamOf(list, () => [trade(60)]);
  let logged = 0;
  const pass = checkWindow({ from: list[0], to: nextDay(list[59]), logLook: () => { logged += 1; } });
  assert.strictEqual(pass.unit.role, 'train');
  assert.strictEqual(pass.look, null);
  assert.strictEqual(logged, 0, 'train is never a look');
  const r = scoreStream(s, opts(pass));
  assert.deepStrictEqual([r.attempts, r.passed, r.blown, r.timeout], [55, 55, 0, 0]);
  assert.deepStrictEqual([r.passRate, r.blowRate, r.timeoutRate, r.medianDaysToPass], [1, 0, 0, 4]);
  assert.strictEqual(r.ess, 11);
  for (const k of ['pass', 'blow', 'timeout']) assert.ok(r.intervals[k].lo <= r.intervals[k].rate && r.intervals[k].rate <= r.intervals[k].hi);
  assert.strictEqual(r.intervals.pass.block, 5);
  assert.strictEqual(r.intervals.passAtEss.n, 11);
  assert.deepStrictEqual([r.resampled.paths, r.resampled.passed, r.resampled.blown], [200, 200, 0]);
  assert.deepStrictEqual(Object.keys(r.cuts), ['0.25', '0.5']);
  assert.ok(r.cuts['0.5'].real.attempts === 55);
  assert.ok(r.objective.zeroBlows);
  assert.deepStrictEqual(Object.keys(r.months), ['2022-03', '2022-04', '2022-05']);
  assert.strictEqual(r.window.role, 'train');
});

test('evaluator: known blows and timeouts; blows on resampled paths and cuts count at the top, so the gate sees them', () => {
  const list = sessionDays('2022-03-01', 40);
  // Day 10 holds a trade that reaches the floor; the rest scratch (+1 tick): attempts over day 10 blow, the others time out.
  const s = streamOf(list, (d, k) => [k === 10 ? trade(-250, { troughTicks: [-250] }) : trade(1)]);
  const r = scoreStream(s, opts(checkWindow({ from: list[0], to: nextDay(list[39]) }), { account: account({ daily_loss_limit: 0 }) }));
  // Starts 0..34; those at 6..10 include day 10 within 5 sessions.
  assert.deepStrictEqual([r.real.attempts, r.real.blown, r.real.timeout, r.real.passed], [35, 5, 30, 0]);
  assert.ok(r.blows.resampled > 0, 'some resampled paths draw day 10');
  assert.strictEqual(r.blown, r.blows.real + r.blows.resampled + Object.values(r.blows.cuts).reduce((a, x) => a + x.real + x.resampled, 0));
  assert.strictEqual(r.blowRate, Math.round((5 / 35) * 10000) / 10000);
  assert.ok(gateFailures(r).some(f => /blows out of sample/.test(f)));
  assert.ok(gateFailures(r).some(f => /pass rate 0/.test(f)));
  assert.deepStrictEqual(r.objective.zeroBlows, false);
  assert.match(r.objective.rejected[0], /a single blow rejects/);
});

test('evaluator: the expectancy cuts lower a stream that passes into one that does not', () => {
  const list = sessionDays('2022-03-01', 40);
  // +25 ticks a day ($117.60): exactly $1,000 needs... a timeout at 5 sessions; with +60 a pass. Mixed: E = 1.5 R.
  const s = streamOf(list, () => [trade(30)]);
  const r = scoreStream(s, opts(checkWindow({ from: list[0], to: nextDay(list[39]) }), { account: account({ profit_target: 700 }) }));
  // +30 ticks: $142.60 a day: 5 days $713 >= $700, a pass on day 5. Cut 25% (E 1.5 R x 0.25 x 20 = 7.5 ticks): $105.10 a day, a timeout.
  assert.deepStrictEqual([r.passRate, r.cuts['0.25'].real.passRate, r.cuts['0.5'].real.passRate], [1, 0, 0]);
  assert.strictEqual(r.inputs.expectancyR, 1.5);
});

test('evaluator: the Wilson interval at the ESS uses the exact effective count, never a rounded one', () => {
  const list = sessionDays('2022-03-01', 47);
  // +60 ticks three days in seven ($292.60 each at 10 micros): an attempt with three of them reaches $700.
  const s = streamOf(list, (_, k) => [trade(k % 7 < 3 ? 60 : 0)]);
  const r = scoreStream(s, opts(checkWindow({ from: list[0], to: nextDay(list[46]) }), { account: account({ profit_target: 700 }), cuts: [] }));
  assert.deepStrictEqual([r.attempts, r.passed, r.ess], [42, 18, 9]);
  // 18/42 x 9 = 3.857 effective passes: rounded to 4 the interval would claim a 0.444 rate, above the 0.4286 measured.
  assert.deepStrictEqual(r.intervals.passAtEss, wilson((18 / 42) * 9, 9, 0.9));
  assert.strictEqual(r.intervals.passAtEss.rate, r.passRate);
});

test('evaluator: hundreds of overlapping attempts with few independent ones fail the promotion gate as too small', () => {
  const list = sessionDays('2023-07-03', 240).filter(d => d < '2024-07-01');
  const s = streamOf(list, () => [trade(60)]);
  const pass = checkWindow({ from: '2023-07-01', to: '2024-07-01', look: { candidate: 'overlap', purpose: 'judging' }, ledger: [], logLook: () => {} });
  const r = scoreStream(s, opts(pass, { account: account({ sessions: 21 }), cuts: [], paths: 50 }));
  assert.ok(r.attempts >= 200 && r.passed === r.attempts, `${r.passed}/${r.attempts}`);
  assert.ok(r.ess < 20, `ESS ${r.ess}`);
  assert.ok(gateFailures(r).some(f => /too small an out-of-sample test \(\d+ independent of \d+ attempts/.test(f)), gateFailures(r).join());
  assert.strictEqual(r.promotion.passes, false);
});

test('evaluator: determinism under a seed; another seed moves only the random parts', () => {
  const list = sessionDays('2022-03-01', 60);
  const r = rng(12);
  const moves = list.map(() => Math.round((r() - 0.45) * 160));
  const s = streamOf(list, (d, k) => [trade(moves[k], { troughTicks: moves[k] < 0 ? [moves[k]] : [], overshootTicks: moves[k] < -20 ? 1 : null })]);
  const run = seed => scoreStream(s, opts(checkWindow({ from: list[0], to: nextDay(list[59]) }), { seed, faults: { stopFault: 0.05, outage: 0.02 } }));
  const a = run(9);
  assert.deepStrictEqual(strip(run(9)), strip(a));
  const b = run(10);
  assert.deepStrictEqual(b.real, a.real, 'the real paths have no randomness');
  assert.notDeepStrictEqual(b.resampled, a.resampled);
  assert.deepStrictEqual(a.inputs.faults, { stopFault: 0.05, outage: 0.02, measured: false });
});

test('evaluator: held-out months are refused without a look, and a look is checked against the ledger and logged first', () => {
  const sel = { from: '2023-08-01', to: '2023-11-01' };
  assert.throws(() => checkWindow(sel), /in select, not train: it needs a look/);
  assert.throws(() => checkWindow({ ...sel, look: { candidate: 'c1', purpose: 'judging' }, ledger: [] }), /logLook is required/);
  assert.throws(() => checkWindow({ ...sel, look: { candidate: 'c1', purpose: 'reasoning-fix' }, ledger: [], logLook: () => {} }), /purpose is tuning or judging/);
  assert.throws(() => checkWindow({ ...sel, look: { candidate: 'c1', purpose: 'tuning' }, ledger: [], logLook: () => {} }), /allows judging looks only/);
  assert.throws(() => checkWindow({ ...sel, look: { candidate: '', purpose: 'judging' }, ledger: [], logLook: () => {} }), /names its candidate/);
  assert.throws(() => checkWindow({ ...sel, look: { candidate: 'c1', purpose: 'judging' }, ledger: null, logLook: () => {} }), /ledger/);
  const log = [];
  const pass = checkWindow({ ...sel, look: { candidate: 'c1', purpose: 'judging' }, ledger: [], logLook: e => log.push(e) });
  assert.strictEqual(log.length, 1);
  assert.deepStrictEqual({ ...log[0], at: null }, { candidate: 'c1', purpose: 'judging', ranges: [sel], at: null, what: 'mechanical evaluation (prop/evaluator.js)' });
  assert.strictEqual(pass.look, log[0]);
  // Out of sample: the recorded parity look plus two more spend its 3 looks.
  const oos = { from: '2024-09-01', to: '2024-12-01' };
  assert.strictEqual(RECORDED_LOOKS.filter(l => l.block === 'oos').length, 1);
  const spent = [1, 2].map(k => ({ candidate: `c${k}`, purpose: 'judging', ranges: [oos] }));
  assert.ok(checkWindow({ ...oos, look: { candidate: 'c3', purpose: 'judging' }, ledger: spent.slice(1), logLook: () => {} }));
  assert.throws(() => checkWindow({ ...oos, look: { candidate: 'c3', purpose: 'judging' }, ledger: spent, logLook: () => {} }), /used its 3 looks and is retired/);
  // Recent and the reserve: no mechanical look at all.
  assert.throws(() => checkWindow({ from: '2025-08-01', to: '2025-10-01', look: { candidate: 'c1', purpose: 'judging' }, ledger: [], logLook: () => {} }), /reserved for a later out-of-sample window/);
  assert.throws(() => checkWindow({ from: '2027-02-01', to: '2027-03-01', look: { candidate: 'c1', purpose: 'judging' }, ledger: [], logLook: () => {} }), /reserved/);
  // A window across two units, or before the schedule, or malformed.
  assert.throws(() => checkWindow({ from: '2023-05-01', to: '2023-08-01' }), /crosses a unit/);
  assert.throws(() => checkWindow({ from: '2020-05-01', to: '2020-08-01' }), /before the schedule/);
  assert.throws(() => checkWindow({ from: '2023-05', to: '2023-08-01' }), /session dates/);
  assert.throws(() => checkWindow({ from: '2023-05-02', to: '2023-05-01' }), /from before to/);
});

test('evaluator: a stream is scored only with a fresh pass for its window', () => {
  const list = sessionDays('2022-03-01', 20);
  const s = streamOf(list, () => [trade(60)]);
  assert.throws(() => scoreStream(s, opts(null)), /needs the pass checkWindow returned/);
  assert.throws(() => scoreStream(s, opts({ unit: { role: 'train' }, from: list[0], to: '2022-12-01', look: null })), /needs the pass/);
  const pass = checkWindow({ from: list[0], to: nextDay(list[19]) });
  scoreStream(s, opts(pass));
  assert.throws(() => scoreStream(s, opts(pass)), /needs the pass/, 'single use: every scoring of a held-out window is its own look');
  assert.throws(() => scoreStream(s, opts(checkWindow({ from: list[5], to: nextDay(list[19]) }))), /days outside the window/);
  assert.throws(() => scoreStream(s, opts(checkWindow({ from: list[0], to: nextDay(list[19]) }), { meanBlock: 3 })), /meanBlock: 5 to 10/);
  assert.throws(() => scoreStream(s, opts(checkWindow({ from: list[0], to: nextDay(list[19]) }), { faults: { stopFault: 2 } })), /a rate from 0 to 1/);
});

test('evaluator: a pass can\'t be edited into another window', () => {
  const list = sessionDays('2022-03-01', 20);
  const pass = checkWindow({ from: list[0], to: nextDay(list[19]) });
  assert.throws(() => { 'use strict'; pass.from = '2024-08-01'; }, TypeError);
  const forged = { ...pass, from: '2024-08-01', to: '2024-12-01' };
  assert.throws(() => scoreStream(streamOf(sessionDays('2024-08-01', 20), () => [trade(60)]), opts(forged)), /needs the pass/);
  const s = streamOf(list, () => [trade(60)]);
  s.days[3].trades[0].day = list[4];
  assert.throws(() => scoreStream(s, opts(pass)), /holds a trade of another day/);
});

test('evaluator: a judged held-out window that passes reads as a pass to the promotion gate', () => {
  const list = sessionDays('2023-07-03', 240).filter(d => d < '2024-07-01');
  const s = streamOf(list, () => [trade(60)]);
  const pass = checkWindow({ from: '2023-07-01', to: '2024-07-01', look: { candidate: 'all-pass', purpose: 'judging' }, ledger: [], logLook: () => {} });
  const r = scoreStream(s, opts(pass));
  assert.deepStrictEqual(gateFailures(r), []);
  assert.strictEqual(r.promotion.passes, true);
  assert.strictEqual(r.look.candidate, 'all-pass');
  assert.strictEqual(r.window.role, 'select');
});

test('evaluator: a policy with a field branch: covered attempts give the pass rate, attempts and months; every attempt counts blows', () => {
  // Train 2021-03..2021-09; coverage starts 2021-05: attempts whose first session is before May are not covered.
  const list = sessionDays('2021-03-01', 120).filter(d => d < '2021-09-01');
  const blowDay = 2; // a blow on 2021-03-03: only uncovered attempts reach it
  const s = streamOf(list, (d, k) => [k === blowDay ? trade(-250, { troughTicks: [-250] }) : trade(60)], ['reads_fields']);
  const r = scoreStream(s, opts(checkWindow({ from: '2021-03-01', to: '2021-09-01' }), { account: account({ daily_loss_limit: 0 }), paths: 0 }));
  const covered = r.real.list.filter(o => o.covered);
  assert.ok(covered.length && covered.every(o => o.start >= '2021-05-01'));
  assert.ok(r.real.list.filter(o => !o.covered).every(o => o.flowOff === true && o.start < '2021-05-01'));
  assert.deepStrictEqual([r.attempts, r.passed], [covered.length, covered.filter(o => o.status === 'passed').length]);
  assert.strictEqual(r.real.blown, 3, 'starts on days 0-2 reach the blow');
  assert.strictEqual(r.blows.real, 3, 'blows count on every attempt, covered or not');
  assert.ok(r.blown >= 3);
  assert.ok(Object.keys(r.months).every(m => m >= '2021-05'), 'months only with covered attempts');
  assert.deepStrictEqual(r.coverage.flowOffMonths, ['2021-03', '2021-04']);
  assert.ok(gateFailures(r).some(f => /blows/.test(f)), 'an uncovered blow still fails the gate');
  // The same stream without the branch: every attempt counts.
  const plain = scoreStream({ ...s, fieldBranch: [] }, opts(checkWindow({ from: '2021-03-01', to: '2021-09-01' }), { account: account({ daily_loss_limit: 0 }), paths: 0 }));
  assert.strictEqual(plain.attempts, r.real.attempts);
  // No covered attempt: never promoted.
  const early = sessionDays('2021-01-04', 50).filter(d => d < '2021-04-01');
  const e = scoreStream(streamOf(early, () => [trade(60)], ['reads_fields']), opts(checkWindow({ from: '2021-01-04', to: '2021-04-01' }), { paths: 0 }));
  assert.strictEqual(e.attempts, 0);
  assert.ok(e.promotion.failures.some(f => /no covered attempt/.test(f)));
  assert.strictEqual(e.promotion.passes, false);
});

test('evaluator: session dates start at the trading day\'s open, the evening before', () => {
  assert.strictEqual(new Date(sessionStart('2022-03-02')).toISOString(), '2022-03-01T23:00:00.000Z');
  assert.throws(() => sessionStart('2022-3-2'), /session date/);
});

test('evaluate-run: the ledger is JSON lines, appended and read back; a bad line fails closed', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'looks', 'ledger.jsonl');
  assert.throws(() => readLedger(file), /no ledger at .*start a new one only on purpose/);
  assert.deepStrictEqual(readLedger(file, { create: true }), []);
  appendLook(file, { candidate: 'a', purpose: 'judging', ranges: [{ from: '2023-08-01', to: '2023-09-01' }] });
  appendLook(file, { candidate: 'b', purpose: 'judging', ranges: [{ from: '2023-08-01', to: '2023-09-01' }] });
  assert.deepStrictEqual(readLedger(file).map(l => l.candidate), ['a', 'b']);
  fs.appendFileSync(file, '{not json\n');
  assert.throws(() => readLedger(file), /ledger\.jsonl:3: not a JSON look/);
  // One run at a time holds the ledger: a second is refused while the first checks and logs.
  assert.strictEqual(withLedgerLock(file, () => {
    assert.throws(() => withLedgerLock(file, () => 1), /locked by another run/);
    return 7;
  }), 7);
  assert.strictEqual(withLedgerLock(file, () => 8), 8, 'the lock is released');
  // The run takes the lock around its check: a held lock refuses a look before anything is read or logged.
  const ROOT = path.resolve(__dirname, '..', '..');
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(`${file}.lock`, '');
  const look = { prop: 'prop_portfolio', from: '2023-08-01', to: '2023-09-01', look: { candidate: 'x', purpose: 'judging' }, ledger: file, data: { MNQ: 'none.jsonl' } };
  assert.throws(() => runEvaluation(look, { root: ROOT, env: {} }), /locked by another run/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  fs.rmSync(`${file}.lock`);
  // A train window never reads the ledger: a missing one named in a config doesn't block it (it fails later, on its data).
  assert.throws(() => runEvaluation({ ...look, from: '2022-03-01', to: '2022-04-01', look: null, ledger: path.join(dir, 'nope.jsonl') }, { root: ROOT, env: {} }), err => !/ledger/.test(err.message));
  // A missing folder is refused without creating it.
  assert.throws(() => runEvaluation({ ...look, ledger: path.join(dir, 'a', 'b', 'x.jsonl') }, { root: ROOT, env: {} }), /no ledger at/);
  assert.ok(!fs.existsSync(path.join(dir, 'a')));
});

test('evaluator: the expectancy cut and the overshoot pools come from the window\'s trades only', () => {
  const list = sessionDays('2022-03-01', 30);
  const s = streamOf(list, () => [trade(30)]);
  const outside = { ...trade(-2000), day: '2021-01-04', overshootTicks: 500 };
  const r = scoreStream({ ...s, trades: [...s.trades, outside] }, opts(checkWindow({ from: list[0], to: nextDay(list[29]) })));
  assert.strictEqual(r.inputs.expectancyR, 1.5);
});

// ---- Layer 1 on synthetic bars ----

/** mulberry32-driven 3-minute bars from Sunday 2022-01-02 18:00 ET. */
function series(days, seed = 5, gap = 0) {
  const r = rng(seed);
  const out = [];
  let px = 20000;
  const t0 = Date.parse('2022-01-02T23:00:00Z');
  for (let k = 0; k < (days * 1440) / 3; k += 1) {
    const drift = Math.sin(k / 90) * 0.6;
    // Every 97th bar opens `gap` points away (a fast market): stops fill past themselves, floors and daily limits trip.
    const jump = gap && k % 97 === 0 ? (r() < 0.5 ? -1 : 1) * gap : 0;
    const o = Math.round((px + jump) * 4) / 4;
    const c = Math.round((px + jump + drift + (r() - 0.5) * 6) * 4) / 4;
    out.push({ t: new Date(t0 + k * 180000).toISOString(), o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 100 });
    px = c;
  }
  return out;
}
const rules = { long: ['close crosses_above ema(20)'], short: ['close crosses_below ema(20)'] };
const strategy = (extra = {}) => ({
  name: 'trendy', valid: true, status: 'active', instruments: ['MNQ'], timeframe: '3m', signal: 'rules', rules,
  compiledRules: compileRules(rules).compiled, risk: { stop: 'atr:1', min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 }, ...extra,
});
const market = bars => ({ symbol: 'MNQ', bars, tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 });
// The shipped round-number steps, never the developer's home.
const engine = { timeframe: 3, gate: true, gateConfig: { ...loadConfig({}), roundSteps: require('../../scripts/lib/trading/round-numbers').defaultRoundSteps() }, window: 160, maxDailyLoss: 500 };
const BARS = series(40);
const GAPPY = series(40, 5, 60);

for (const [label, bars] of [['plain bars', BARS], ['gapped bars: blows and daily limits', GAPPY]]) test(`trade stream: layer 2 on the stream reproduces the engine's own attempts, start by start (${label})`, () => {
  const acct = account({ profit_target: 250, max_loss: 500, daily_loss_limit: 300, daily_loss_soft: 250, consistency_pct: 50, sessions: 6, max_contracts: { MNQ: 20 } });
  const prop = { strategy: strategy(), components: ['trendy'], contracts: 'micro' };
  const sizing = { cushion_frac: 0.9 };
  // The reference: the engine's own account mode, one attempt from each start (as the retired prop/challenge.js ran it).
  const prepared = prepare([market(bars)], [strategy()], { ...engine, prop });
  const starts = tradingDays(prepared.books).filter(d => d >= Date.parse('2022-01-10T00:00:00Z'));
  const span = (acct.sessions * 1.6 + 7) * 86400000;
  const runAttempt = start => {
    const res = runEngine([market(bars)], [strategy()], { ...engine, prepared, account: acct, sizing, prop, start, end: start + span });
    return { status: res.combine.status, sessions: res.combine.days.length, profit: res.combine.balance - res.combine.start, trades: res.trades };
  };
  const s = tradeStream({ markets: [market(bars)], strategies: [strategy()], prop, engine, from: starts[0], to: null, facts: false });
  assert.ok(s.trades.length > 50);
  assert.ok(s.trades.every(t => t.troughTicks.every((x, k) => x < 0 && (k === 0 || x < t.troughTicks[k - 1]))), 'each trough deeper than the last');
  // Without a stop the bars' extremes bound the path; a stop fill may sit a tick of slippage below them.
  assert.ok(s.trades.every(t => t.noStop && t.noStop.worstTicks <= Math.min(0, ...t.troughTicks) + 1));
  assert.ok(s.trades.every(t => t.facts.error));
  assert.deepStrictEqual(s.fieldBranch, []);
  const ctx = { account: acct, sizing: { ...combine.DEFAULT_SIZING, ...sizing }, mode: 'micro', maxDailyLoss: 500, legsOf: t => at.legsFor(acct, t.symbol, { tickValue: 0.5 }) };
  let n = 0;
  const statuses = new Set();
  const reasons = new Set();
  for (let i = 0; i < s.days.length - acct.sessions; i += 1) {
    const direct = runAttempt(starts[i]);
    const replayed = at.runAttempt(s.days.slice(i), ctx);
    const cents = x => Math.round(x * 100) / 100;
    assert.deepStrictEqual([replayed.status, replayed.sessions, cents(replayed.profit)], [direct.status, direct.sessions, cents(direct.profit)], `start ${s.days[i].day}`);
    statuses.add(direct.status);
    for (const t of direct.trades) reasons.add(t.reason);
    n += 1;
  }
  assert.ok(n > 15 && statuses.size >= 2, `${n} starts, ${[...statuses]}`);
  if (bars === GAPPY) assert.ok(reasons.has('blow') && reasons.has('daily_limit') && statuses.has('blown'), `forced exits replayed: ${[...reasons]}`);
});

test('trade stream: entries fill after the cycle delay; the delay from measured cycles is a conservative percentile', () => {
  const prop = { strategy: strategy(), components: ['trendy'], contracts: 'micro' };
  const from = Date.parse('2022-01-10T23:00:00Z');
  const to = Date.parse('2022-01-14T23:00:00Z');
  const now = tradeStream({ markets: [market(BARS)], strategies: [strategy()], prop, engine, from, to, facts: false });
  const late = tradeStream({ markets: [market(BARS)], strategies: [strategy()], prop, engine, from, to, facts: false, entryDelayMs: 200000 });
  const fillAfter = (s, bars) => s.trades.map(t => Date.parse(t.entryTime) - bars);
  // Next-open: the fill bar opens at the signal bar's close C; with a 200 s delay the first bar opening at or after
  // C + 200 s opens at C + 360 s (3-minute bars): two bars later.
  const signalClose = t => Date.parse(t.entryTime);
  assert.ok(now.trades.length && late.trades.length);
  const firstLate = late.trades[0];
  const matching = now.trades.find(t => t.strategy === firstLate.strategy && Math.abs(signalClose(t) - signalClose(firstLate)) <= 360000);
  assert.ok(matching, 'the same setup');
  assert.strictEqual(signalClose(firstLate) - signalClose(matching), 360000, 'two bars later');
  assert.ok(fillAfter(now, 0).length);
  assert.throws(() => tradeStream({ markets: [market(BARS)], strategies: [strategy()], prop, engine: { ...engine, fill: 'close' }, from, to, facts: false, entryDelayMs: 1000 }), /next-open/);
  assert.strictEqual(delayFromCycles([1000, 5000, 2000, 9000, 3000, 4000, 8000, 6000, 7000, 10000]), 9000);
  assert.strictEqual(delayFromCycles([1000, 3000], 0.5), 1000);
  assert.strictEqual(delayFromCycles([]), 0);
});

test('trade stream: the facts\' room uses the evaluation\'s round-number config (the engine\'s gateConfig, or roundSteps given)', () => {
  const { resolveRoundSteps } = require('../../scripts/lib/trading/round-numbers');
  const prop = { strategy: strategy(), components: ['trendy'], contracts: 'micro' };
  const from = Date.parse('2022-01-11T23:00:00Z');
  const to = Date.parse('2022-01-12T23:00:00Z');
  // A one-tick step: a round number one tick from price, so it is the first level in the way.
  const tick = resolveRoundSteps(null, { steps: { MNQ: 0.25 } });
  const inTheWay = opts => tradeStream({ markets: [market(BARS)], strategies: [strategy()], prop, from, to, ...opts }).trades[0].facts.inTheWay;
  assert.match(String(inTheWay({ engine: { ...engine, gateConfig: { ...(engine.gateConfig || {}), roundSteps: tick } } })), /round number/, 'from the engine\'s gateConfig');
  assert.match(String(inTheWay({ engine, roundSteps: tick })), /round number/, 'given');
  assert.doesNotMatch(String(inTheWay({ engine, roundSteps: resolveRoundSteps(null, null) })), /round number/, 'control: no steps, no round number');
});

test('trade stream: the facts come from the live scan and briefing; a strategy that reads broker fields makes a branch', () => {
  const prop = { strategy: strategy(), components: ['trendy'], contracts: 'micro' };
  const from = Date.parse('2022-01-11T23:00:00Z');
  const to = Date.parse('2022-01-12T23:00:00Z');
  const s = tradeStream({ markets: [market(BARS)], strategies: [strategy()], prop, engine, from, to });
  assert.ok(s.trades.length >= 1);
  const f = s.trades[0].facts;
  assert.ok(!f.error, f.error);
  assert.ok(['allows', 'against', 'reversal', null].includes(f.trendRule));
  assert.ok(typeof f.needR === 'number');
  assert.ok('roomR' in f && 'alignment' in f && f.confluence && 'with' in f.confluence);
  const reads = strategy({ name: 'reader', rules: { long: ['field("ext.a") > 0'], short: ['field("ext.a") < 0'] }, compiledRules: compileRules({ long: ['field("ext.a") > 0'], short: ['field("ext.a") < 0'] }).compiled });
  const b = tradeStream({ markets: [market(BARS)], strategies: [strategy(), reads], prop: { ...prop, components: ['trendy', 'reader'] }, engine, from, to, facts: false });
  assert.deepStrictEqual(b.fieldBranch, ['reader']);
  assert.throws(() => tradeStream({ markets: [market(BARS)], strategies: [strategy()], prop: { strategy: strategy(), components: [] }, engine }), /prop/);
});

test('trade stream: day regimes compare a day\'s range with the days before it only', () => {
  const day = (d, range) => [{ ms: Date.parse(`2022-01-${d}T15:00:00Z`), h: 100 + range, l: 100 }];
  const bars = [...day('03', 10), ...day('04', 10), ...day('05', 20), ...day('06', 5), ...day('07', 11)];
  const r = dayRegimes(bars, 180000, 2);
  assert.deepStrictEqual([...r.values()], ['normal', 'normal', 'high', 'low', 'normal']);
});

test('trade stream: one position at a time across the markets, as an attempt trades (the engine alone would overlap them)', () => {
  const other = { symbol: 'MES', bars: series(40, 9), tickSize: 0.25, tickValue: 1.25, feesPerSide: 0.37 };
  const both = strategy({ instruments: ['MNQ', 'MES'] });
  const prop = { strategy: both, components: ['trendy'], contracts: 'micro' };
  const from = Date.parse('2022-01-10T23:00:00Z');
  const to = Date.parse('2022-01-20T23:00:00Z');
  const s = tradeStream({ markets: [market(BARS), other], strategies: [both], prop, engine, from, to, facts: false });
  assert.ok(new Set(s.trades.map(t => t.symbol)).size === 2, 'both markets trade');
  const spans = s.trades.map(t => [Date.parse(t.entryTime), Date.parse(t.exitTime)]).sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < spans.length; k += 1) assert.ok(spans[k][0] >= spans[k - 1][1], `trade ${k} opens before the last one closed`);
  const free = runEngine([market(BARS), other], [both], { ...engine, prop, start: from, end: to }).trades
    .map(t => [Date.parse(t.entryTime), Date.parse(t.exitTime)]).sort((a, b) => a[0] - b[0]);
  assert.ok(free.some((x, k) => k > 0 && x[0] < free[k - 1][1]), 'without it the markets overlap');
});
