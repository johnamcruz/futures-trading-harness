'use strict';

// The round report's risk and return diagnostics (scripts/lib/train/risk-stats.js): per trade, on the scorecard's R;
// report only (nothing in the loop's decision paths reads them), wired into iteration-report.js's mastery read.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const RS = require('../../scripts/lib/train/risk-stats');
const IR = require('../../scripts/lib/train/iteration-report');

const ROOT = path.join(__dirname, '..', '..');
const T = r => ({ r });

test('riskStats: a known sequence, every value by hand', () => {
  // 1, -1, 2, -1, -1, 0.5: sum 0.5, mean 1/12; wins 1, 2, 0.5 (3.5); losses three of -1 (3).
  // Cumulative 1, 0, 2, 1, 0, 0.5 under peaks 1, 1, 2, 2, 2, 2: the worst fall 2 (from 2 to 0).
  // Sample variance (8.25 - 6 / 144) / 5 = 1.641667, sd 1.281276: Sharpe 0.083333 / 1.281276 = 0.0650.
  // Downside: sqrt(3 / 6) = 0.707107: Sortino 0.083333 / 0.707107 = 0.1179.
  assert.deepStrictEqual(RS.riskStats([1, -1, 2, -1, -1, 0.5].map(T)), {
    n: 6, unknown: 0, expectancy: 0.0833, winRate: 0.5, avgWin: 1.1667, avgLoss: -1, payoff: 1.1667, profitFactor: 1.1667,
    maxDrawdownR: 2, longestLosingStreak: 2, sortino: 0.1179, sharpe: 0.065,
  });
  // Plain numbers read as R too; the order matters for the drawdown and the streak, not for the means.
  const s = RS.riskStats([-1, -1, -1, 1, 2, 0.5]);
  assert.deepStrictEqual([s.expectancy, s.winRate, s.profitFactor, s.sharpe, s.sortino, s.maxDrawdownR, s.longestLosingStreak], [0.0833, 0.5, 1.1667, 0.065, 0.1179, 3, 3]);
});

test('riskStats: a second sequence with a scratch, different win and loss sizes', () => {
  // 3, -0.5, 0, -1.5, -0.5, 2: sum 2.5, mean 0.416667; wins 3, 2 (avg 2.5); losses -0.5, -1.5, -0.5 (avg -0.833333).
  // Payoff 2.5 / 0.833333 = 3; profit factor 5 / 2.5 = 2. Cumulative 3, 2.5, 2.5, 1, 0.5, 2.5: drawdown 2.5 (3 to 0.5).
  // The scratch (0) ends a losing streak: -0.5 | 0 | -1.5, -0.5: longest 2, not 3.
  // Sample variance: sum R^2 = 9 + 0.25 + 0 + 2.25 + 0.25 + 4 = 15.75; minus 6 x 0.173611 = 1.041667: 14.708333 / 5 =
  // 2.941667, sd 1.715129: Sharpe 0.2429. Downside: sqrt(2.75 / 6) = 0.677003: Sortino 0.6155.
  assert.deepStrictEqual(RS.riskStats([3, -0.5, 0, -1.5, -0.5, 2].map(T)), {
    n: 6, unknown: 0, expectancy: 0.4167, winRate: 0.3333, avgWin: 2.5, avgLoss: -0.8333, payoff: 3, profitFactor: 2,
    maxDrawdownR: 2.5, longestLosingStreak: 2, sortino: 0.6155, sharpe: 0.2429,
  });
  // The drawdown runs from the start (0), not from the first trade: -1, 0.5 falls 1 below the start.
  assert.strictEqual(RS.riskStats([-1, 0.5]).maxDrawdownR, 1);
  assert.strictEqual(RS.riskStats([0.5, -1]).maxDrawdownR, 1);
  assert.strictEqual(RS.riskStats([-1, -0.5]).maxDrawdownR, 1.5);
});

test('riskStats: the edge cases are n/a (null), never Infinity or NaN', () => {
  const none = { n: 0, unknown: 0, expectancy: null, winRate: null, avgWin: null, avgLoss: null, payoff: null, profitFactor: null, maxDrawdownR: null, longestLosingStreak: null, sortino: null, sharpe: null };
  assert.deepStrictEqual(RS.riskStats([]), none);
  assert.strictEqual(RS.riskStats(null), null, 'trades unknown: unknown, never zero trades');
  assert.strictEqual(RS.riskStats(undefined), null);
  // n < 2: no dispersion ratio.
  assert.deepStrictEqual(RS.riskStats([-2]), { n: 1, unknown: 0, expectancy: -2, winRate: 0, avgWin: null, avgLoss: -2, payoff: null, profitFactor: 0, maxDrawdownR: 2, longestLosingStreak: 1, sortino: null, sharpe: null });
  assert.deepStrictEqual([RS.riskStats([2]).sharpe, RS.riskStats([2]).sortino, RS.riskStats([2]).profitFactor], [null, null, null]);
  // Zero downside (no loss): no Sortino, no profit factor; Sharpe still reads (1.5 / 0.707107).
  const up = RS.riskStats([1, 2]);
  assert.deepStrictEqual([up.sortino, up.profitFactor, up.payoff, up.avgLoss, up.sharpe, up.longestLosingStreak, up.maxDrawdownR], [null, null, null, null, 2.1213, 0, 0]);
  // A scratch only: no downside either.
  assert.deepStrictEqual([RS.riskStats([0, 1]).sortino, RS.riskStats([0, 0]).sortino], [null, null]);
  // Zero deviation (every R equal): no Sharpe, even where floating point would leave a residue.
  assert.strictEqual(RS.riskStats([-1, -1]).sharpe, null);
  assert.strictEqual(RS.riskStats([-1, -1]).sortino, -1);
  assert.strictEqual(RS.riskStats([0.1, 0.1, 0.1]).sharpe, null);
  assert.strictEqual(RS.riskStats([0.1 + 0.2, 0.1 + 0.2, 0.1 + 0.2]).sharpe, null);
  // Unknown R (an open trade): counted apart, never a 0.
  const u = RS.riskStats([T(1), T(null), T(-1), { r: NaN }, null]);
  assert.deepStrictEqual([u.n, u.unknown, u.expectancy, u.winRate], [2, 3, 0, 0.5]);
  for (const s of [RS.riskStats([]), RS.riskStats([2]), up, RS.riskStats([-1, -1])]) {
    const text = RS.riskText(s);
    assert.doesNotMatch(text, /Infinity|NaN|null|undefined/, text);
  }
});

test('riskText: one line, labelled per trade, n/a where null', () => {
  assert.strictEqual(RS.riskText(RS.riskStats([1, -1, 2, -1, -1, 0.5])), 'n 6, expectancy 0.0833R a trade, win rate 50%, avg win 1.1667R, avg loss -1R, payoff 1.1667, profit factor 1.1667, max drawdown 2R, longest losing streak 2, Sortino 0.1179, Sharpe 0.065 (per trade, not annualized; R: the broker\'s round-trip R when it sends one, else P&L over the initial risk before fees, on the stop held after the fill (the plan stop the runner moved it to); a win here is R > 0, which can differ from the scorecard\'s net result)');
  assert.strictEqual(RS.riskText(RS.riskStats([])), 'n 0, expectancy n/a a trade, win rate n/a, avg win n/a, avg loss n/a, payoff n/a, profit factor n/a, max drawdown n/a, longest losing streak n/a, Sortino n/a, Sharpe n/a (per trade, not annualized; R: the broker\'s round-trip R when it sends one, else P&L over the initial risk before fees, on the stop held after the fill (the plan stop the runner moved it to); a win here is R > 0, which can differ from the scorecard\'s net result)');
  assert.match(RS.riskText(RS.riskStats([T(1), T(null)])), /^n 1 \(1 without an R\), /);
  assert.strictEqual(RS.riskText(null), 'n/a (trades unknown)');
});

test('tradesOf: the scorecard decisions\' trades, in time order; unknown when a decision predates the field', () => {
  const d = (t, trade) => ({ t, key: `${t}|MNQ`, trade });
  const list = [d('2022-03-08T15:00:00.000Z', { r: -1 }), d('2022-03-07T15:00:00.000Z', { r: 2 }), d('2022-03-07T15:03:00.000Z', null), d('2022-03-07T16:00:00.000Z', { r: null })];
  assert.deepStrictEqual(RS.tradesOf(list), [{ t: '2022-03-07T15:00:00.000Z', r: 2 }, { t: '2022-03-07T16:00:00.000Z', r: null }, { t: '2022-03-08T15:00:00.000Z', r: -1 }]);
  // The same time: the given order.
  assert.deepStrictEqual(RS.tradesOf([d('T', { r: 1 }), d('T', { r: -1 })]).map(x => x.r), [1, -1]);
  assert.deepStrictEqual(RS.tradesOf([]), []);
  assert.strictEqual(RS.tradesOf([...list, { t: 'x' }]), null, 'a decision without the field: unknown');
  assert.strictEqual(RS.tradesOf(null), null, 'no decisions to read: unknown');
  assert.strictEqual(RS.tradesOf([null]), null);
});

// --- the report's wiring ----------------------------------------------------------------------------------------------

const ride = { legs: 4, caught: 1, catchRate: 0.25, rCaught: 2, rAvailable: 10 };
const probeReport = (over = {}) => ({
  iteration: 2, curriculum: 'trend',
  trend: { set: 'f', batch: { index: 1, size: 4, trigger: 'start' }, probe: { days: [], legs: [] }, confirm: { days: [], legs: [] }, champion: { ride, blows: 0, controls: null, trades: [1, -1, 2, -1, -1, 0.5].map(T), ...(over.champion || {}) } },
  composed: { id: 'c1', verdict: 'helped', trend: { ride, blows: 0, controls: null, trades: [3, -0.5, 0, -1.5, -0.5, 2].map(T), ...(over.composed || {}) } },
});
const dec = (t, r) => ({ t, trade: r === undefined ? null : { r } });
const keepRuleRuns = {
  champion: [dec('a', -1), dec('b'), dec('c', -1)],
  byId: { c1: [dec('b', 1), dec('a', 2), dec('c', -1)], other: [dec('a', 5), dec('b', 5)] },
};
const judgedEntry = id => ({ iteration: 2, proposalId: id, verdict: 'kept', composition: {}, model: { windows: [] } });

test('the round report: each side\'s risk on the trend confirm half and, when the keep rule judged it, on its runs', () => {
  const rec = IR.build({ probeReport: probeReport(), entries: [judgedEntry('c1')], keepRuleRuns });
  const r = rec.mastery.risk;
  assert.strictEqual(r.judged, true);
  assert.deepStrictEqual(r.champion.trend, RS.riskStats([1, -1, 2, -1, -1, 0.5]));
  assert.deepStrictEqual(r.composed.trend, RS.riskStats([3, -0.5, 0, -1.5, -0.5, 2]));
  assert.strictEqual(r.composed.id, 'c1');
  // The keep rule's runs: the champion's (its side of the judgment) and c1's own, in time order (2, 1, -1: drawdown 1).
  assert.deepStrictEqual(r.champion.keepRule, RS.riskStats([-1, -1]));
  assert.deepStrictEqual(r.composed.keepRule, RS.riskStats([2, 1, -1]));
  assert.deepStrictEqual([r.composed.keepRule.n, r.composed.keepRule.maxDrawdownR, r.composed.keepRule.expectancy], [3, 1, 0.6667]);
  // The existing fields stay as they were: the risk is a key beside them.
  assert.deepStrictEqual(Object.keys(rec.mastery), ['curriculum', 'champion', 'composed', 'risk', 'loss']);
  assert.strictEqual(rec.mastery.champion.risk, undefined);
  const lines = IR.masteryLines(rec);
  assert.deepStrictEqual(lines.slice(3, 8), [
    '  Risk and return (per trade, R as the scorecard records it; diagnostics only: pass rate with 0 blows decides):',
    `    champion, trend confirm half: ${RS.riskText(r.champion.trend)}`,
    `    champion, keep rule's runs: ${RS.riskText(r.champion.keepRule)}`,
    `    combined c1, trend confirm half: ${RS.riskText(r.composed.trend)}`,
    `    combined c1, keep rule's runs: ${RS.riskText(r.composed.keepRule)}`,
  ]);
  assert.match(lines[4], /Sortino 0\.1179, Sharpe 0\.065 \(per trade, not annualized; R: the broker's round-trip R when it sends one, else P&L over the initial risk before fees, on the stop held after the fill \(the plan stop the runner moved it to\); a win here is R > 0, which can differ from the scorecard's net result\)$/);
});

test('the round report: another proposal\'s verdict, no keep rule, or no trades recorded: n/a, never another side\'s', () => {
  // Another proposal judged: never this change's runs (the mastery read's id match).
  const other = IR.build({ probeReport: probeReport(), entries: [judgedEntry('other')], keepRuleRuns });
  assert.deepStrictEqual([other.mastery.risk.judged, other.mastery.risk.champion.keepRule, other.mastery.risk.composed.keepRule], [false, null, null]);
  assert.deepStrictEqual(other.mastery.risk.champion.trend, RS.riskStats([1, -1, 2, -1, -1, 0.5]), 'the trend half reads as ever');
  assert.match(IR.masteryLines(other).find(l => l.startsWith('    combined c1, keep rule')), /: n\/a \(not judged by the keep rule\)$/);
  // The keep rule did not run.
  const none = IR.build({ probeReport: probeReport() });
  assert.deepStrictEqual([none.mastery.risk.judged, none.mastery.risk.composed.keepRule], [false, null]);
  // Judged, but its runs' trades unknown (a scorecard from before they were recorded): unknown, said so.
  const old = IR.build({ probeReport: probeReport(), entries: [judgedEntry('c1')], keepRuleRuns: { champion: [{ t: 'a' }], byId: {} } });
  assert.deepStrictEqual([old.mastery.risk.judged, old.mastery.risk.champion.keepRule, old.mastery.risk.composed.keepRule], [true, null, null]);
  assert.match(IR.masteryLines(old).find(l => l.startsWith('    combined c1, keep rule')), /: n\/a \(trades unknown\)$/);
  // A probe report from before the trades were recorded: unknown on the trend half.
  const noTrades = IR.build({ probeReport: probeReport({ champion: { trades: undefined }, composed: { trades: null } }) });
  assert.deepStrictEqual([noTrades.mastery.risk.champion.trend, noTrades.mastery.risk.composed.trend], [null, null]);
  // No combined change: the champion's lines alone.
  const solo = IR.build({ probeReport: { ...probeReport(), composed: null } });
  assert.strictEqual(solo.mastery.risk.composed, null);
  assert.strictEqual(IR.masteryLines(solo).filter(l => /^ {4}combined/.test(l)).length, 0);
  assert.strictEqual(IR.masteryLines(solo).filter(l => /^ {4}champion, (trend confirm half|keep rule's runs)/.test(l)).length, 2);
  // A record from before the risk diagnostics: its lines as they were.
  const rec = IR.build({ probeReport: probeReport() });
  const { risk: _risk, loss: _loss, ...before } = rec.mastery;
  assert.deepStrictEqual(IR.masteryLines({ ...rec, mastery: before }), IR.masteryLines(rec).slice(0, 3));
});

// --- nothing decides on them ----------------------------------------------------------------------------------------

test('diagnostics only: no screen, keep rule, promotion, proposer or prompt module imports risk-stats', () => {
  const lib = path.join(ROOT, 'scripts', 'lib');
  const train = path.join(lib, 'train');
  // The modules that judge, screen, propose, find, compose, promote or build a prompt.
  const deciding = ['screen.js', 'model-verifier.js', 'proposer.js', 'findings.js', 'trend-screen.js', 'trend-findings.js', 'exit-findings.js', 'paired.js', 'ab-compare.js', 'compose.js', 'proposal.js', 'lessons.js', 'evaluator.js', 'selection.js', 'first-try.js', 'rulebook-guard.js', 'agent-edit.js', 'probe-edit.js', 'plan.js', 'flow.js', 'trend-facts.js', 'curriculum.js']
    .map(f => path.join(train, f));
  const prop = fs.readdirSync(path.join(lib, 'prop')).map(f => path.join(lib, 'prop', f));
  const importsIt = f => /require\(\s*['"][^'"]*risk-stats['"]\s*\)/.test(fs.readFileSync(f, 'utf8'));
  for (const f of [...deciding, ...prop]) assert.ok(fs.existsSync(f), f);
  assert.deepStrictEqual([...deciding, ...prop].filter(importsIt).map(f => path.relative(ROOT, f)), []);
  // Who does: the report (iteration-report.js) for the read, and the probe round for the trades' R alone (tradesOf).
  const users = fs.readdirSync(train).map(f => path.join(train, f)).filter(importsIt).map(f => path.basename(f)).sort();
  assert.deepStrictEqual(users, ['iteration-report.js', 'probe.js']);
  const probe = fs.readFileSync(path.join(train, 'probe.js'), 'utf8');
  assert.deepStrictEqual([...new Set([...probe.matchAll(/\bRS\.(\w+)/g)].map(m => m[1]))], ['tradesOf'], 'the probe round only records the trades');
  // The importer check would see the module under any of its names.
  assert.ok(importsIt(path.join(train, 'iteration-report.js')));
});
