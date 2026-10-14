'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, TEST_ACCOUNTS } = require('../helpers');
const E = require('../../scripts/lib/train/evaluator');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { tradingDayKey } = require('../../scripts/lib/trading/clock');

const ROOT = path.resolve(__dirname, '..', '..');

// A result as scoreStream shapes it (the parts the loop reads).
const result = ({ attempts = 30, passed = 15, blown = 0, lb = 0.35, months = { '2022-03': { blown: 0 }, '2022-04': { blown: 0 } }, seed = 7 } = {}) => ({
  attempts, passed, blown, passRate: passed / attempts, months, objective: { lowerBound: lb }, medianDaysToPass: 12, inputs: { seed }, look: null,
});

test('resolveEvaluator: none is null; prop and data required; the loop owns the window and the ledger; files resolved', () => {
  assert.strictEqual(E.resolveEvaluator(undefined), null);
  assert.throws(() => E.resolveEvaluator({ data: { MNQ: 'a.csv' } }), /evaluator\.prop/);
  assert.throws(() => E.resolveEvaluator({ prop: 'p', data: {} }), /evaluator\.data/);
  assert.throws(() => E.resolveEvaluator({ prop: 'p', data: { MNQ: 'a' }, from: '2022-01-03' }), /evaluator\.from: set by the loop/);
  assert.throws(() => E.resolveEvaluator({ prop: 'p', data: { MNQ: 'a' }, ledger: 'x' }), /evaluator\.ledger: set by the loop/);
  assert.throws(() => E.resolveEvaluator({ prop: 'p', data: { MNQ: 'a' }, seed: 1.5 }), /seed/);
  assert.deepStrictEqual(E.resolveEvaluator({ prop: 'p', data: { MNQ: 'bars/a.csv' }, paths: 300 }, '/x').data, { MNQ: path.resolve('/x', 'bars/a.csv') });
});

test('compare: a blow, a new gate failure or a lower pass-rate bound fails the candidate; the champion\'s own failures don\'t', () => {
  const s = r => E.summarize(r);
  assert.deepStrictEqual(E.compare(s(result()), s(result())), []);
  assert.match(E.compare(s(result()), s(result({ blown: 1 }))).join(), /1 blow\(s\)/);
  assert.match(E.compare(s(result()), s(result({ passed: 6 }))).join(), /a gate failure the champion doesn't have: pass rate 0\.2/);
  assert.match(E.compare(s(result()), s(result({ lb: 0.3 }))).join(), /lower bound fell from 0\.35 to 0\.3/);
  // Both under the pass-rate floor (a tuning window need not pass the gate): not new; a better bound is fine.
  assert.deepStrictEqual(E.compare(s(result({ passed: 3, lb: 0.05 })), s(result({ passed: 5, lb: 0.1 }))), []);
  assert.deepStrictEqual(s(result()).gate, []);
});

test('evaluate: both trees on every window with one seed; held-out scores the candidate alone with the look; unavailable without a config', async () => {
  assert.deepStrictEqual(await E.evaluate({ cfg: null, windows: [], candidate: 'c' }), { available: false, why: E.UNAVAILABLE });
  const calls = [];
  const coversOf = () => ['strategies/p/STRATEGY.md', 'strategies/orb/STRATEGY.md'];
  const run = (raw, opts) => { calls.push({ raw, root: opts.root }); return opts.root === 'cand' ? result({ lb: 0.3, seed: raw.seed }) : result({ seed: raw.seed }); };
  const cfg = E.resolveEvaluator({ prop: 'p', data: { MNQ: '/b.csv' }, paths: 10 });
  const windows = [{ from: '2022-03-07', to: '2022-03-12' }, { from: '2022-10-03', to: '2022-10-08' }];
  const v = await E.evaluate({ cfg, windows, champion: 'champ', candidate: 'cand', seed: 5, run, coversOf, look: { candidate: 'l/iter-1/x', purpose: 'tuning' }, ledger: '/ledger' });
  assert.deepStrictEqual(v.covers, ['strategies/orb/STRATEGY.md', 'strategies/p/STRATEGY.md']);
  assert.deepStrictEqual(calls.map(c => [c.root, c.raw.from, c.raw.seed, c.raw.paths, c.raw.look.purpose]), [['champ', '2022-03-07', 5, 10, 'tuning'], ['cand', '2022-03-07', 5, 10, 'tuning'], ['champ', '2022-10-03', 5, 10, 'tuning'], ['cand', '2022-10-03', 5, 10, 'tuning']]);
  assert.strictEqual(v.failures.length, 2);
  assert.match(v.failures[0], /^2022-03-07\.\.2022-03-12: the pass-rate lower bound fell/);
  // The config's own seed wins over the loop's.
  calls.length = 0;
  await E.evaluate({ cfg: { ...cfg, seed: 11 }, windows: windows.slice(0, 1), champion: 'champ', candidate: 'cand', seed: 5, run, coversOf });
  assert.deepStrictEqual(calls.map(c => c.raw.seed), [11, 11]);
  // Held-out: the candidate alone, its gate failures absolute.
  calls.length = 0;
  // The ledger as it was before the caller's own look, copied fresh for each scoring: one judging, one look.
  const dir = tmpDir();
  const before = path.join(dir, 'before.jsonl');
  fs.writeFileSync(before, '{"candidate":"x","purpose":"tuning","ranges":[{"from":"2022-03-07","to":"2022-03-12"}]}\n');
  const scratch = path.join(dir, 'scratch.jsonl');
  fs.writeFileSync(`${scratch}.lock`, ''); // a crashed scoring's lock on the loop's own scratch file
  const h = await E.evaluate({
    cfg, windows: windows.slice(0, 1), candidate: 'cand', seed: 5, coversOf, look: { candidate: 'l/x', purpose: 'judging' }, ledger: before, scratchLedger: { file: scratch },
    run: (raw, o) => { calls.push({ raw, root: o.root, held: fs.readFileSync(raw.ledger, 'utf8') }); fs.appendFileSync(raw.ledger, 'logged\n'); return result({ attempts: 8 }); },
  });
  assert.deepStrictEqual(calls.map(c => [c.root, c.raw.look.purpose, c.raw.ledger, c.held]), [['cand', 'judging', scratch, fs.readFileSync(before, 'utf8')]]);
  assert.doesNotMatch(fs.readFileSync(before, 'utf8'), /logged/, 'the ledger snapshot is never written');
  assert.ok(!fs.existsSync(`${scratch}.lock`), 'a stale scratch lock is cleared');
  assert.match(h.failures.join(), /too small an out-of-sample test/);
  assert.strictEqual(h.windows[0].champion, null);
});

test('compare: with no two bounds, the passes over the attempts and the attempts scored decide', () => {
  const s = r => E.summarize(r);
  const nob = o => ({ ...result(o), objective: { lowerBound: null } });
  assert.match(E.compare(s(nob({ passed: 10 })), s(nob({ passed: 4 }))).join(), /the pass rate fell from 0\.3333 to 0\.1333/);
  assert.match(E.compare(s(nob({ attempts: 30 })), s(nob({ attempts: 0, passed: 0 }))).join(), /the attempts scored changed \(30 to 0\)/);
  assert.match(E.compare(s(result()), s(nob())).join(), /no pass-rate bound to compare \(champion 0\.35, candidate null\)/);
  assert.deepStrictEqual(E.compare(s(nob()), s(nob())), []);
});

test('evaluate: the real two-layer evaluator on the CSV fixture; the same tree and seed give the same scores', async () => {
  const home = tmpDir();
  const SHIFT = 260 * 7 * 86400000;
  const bars = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'));
  const data = path.join(home, 'NQ-3m-train.csv');
  fs.writeFileSync(data, `${['datetime,open,high,low,close,volume', ...bars.map(b => `${new Date(Date.parse(b.t) - SHIFT).toISOString()},${b.o},${b.h},${b.l},${b.c},${b.v}`)].join('\n')}\n`);
  const strat = path.join(home, 'strategies', 'eval_fixture');
  fs.mkdirSync(strat, { recursive: true });
  fs.writeFileSync(path.join(strat, 'STRATEGY.md'), fs.readFileSync(path.join(ROOT, 'strategies', 'prop_portfolio', 'STRATEGY.md'), 'utf8')
    .replace(/^name: prop_portfolio$/m, 'name: eval_fixture').replace(/^instruments: .*$/m, 'instruments: [MNQ, NQ]')
    .replace(/^strategies: .*$/m, 'strategies: [ema_cross, supertrend, keltner, bos, orb]').replace(/^account: .*$/m, 'account: eval_acct').replace(/^contracts: .*$/m, 'contracts: micro'));
  const acct = path.join(home, 'accounts', 'eval_acct');
  fs.mkdirSync(acct, { recursive: true });
  fs.writeFileSync(path.join(acct, 'ACCOUNT.md'), fs.readFileSync(path.join(TEST_ACCOUNTS, 'test_50k', 'ACCOUNT.md'), 'utf8')
    .replace(/^name: test_50k$/m, 'name: eval_acct').replace(/^sessions: 30\b/m, 'sessions: 2').replace(/^profit_target: 3000\b/m, 'profit_target: 300'));
  const env = { PATH: process.env.PATH, HOME: home, FTH_HOME: home, FTH_STRATEGIES_DIRS: path.join(home, 'strategies'), FTH_ACCOUNTS_DIRS: path.join(home, 'accounts') };
  const sessions = [...new Set(bars.map(b => tradingDayKey(new Date(Date.parse(b.t) - SHIFT))))];
  const to = new Date(Date.parse(`${sessions[sessions.length - 1]}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const cfg = E.resolveEvaluator({ prop: 'eval_fixture', data: { MNQ: data }, paths: 100, reps: 100 });
  const v = await E.evaluate({ cfg, windows: [{ from: sessions[0], to }], champion: ROOT, candidate: ROOT, seed: 3, env });
  assert.strictEqual(v.available, true);
  const [w] = v.windows;
  assert.deepStrictEqual(w.candidate, w.champion, 'the same tree, bars and seed: the same scores');
  assert.strictEqual(w.candidate.seed, 3);
  // Covered: only strategies loaded from the tree (the fixture policy comes from a folder outside it).
  assert.ok(v.covers.includes('strategies/orb/STRATEGY.md') && !v.covers.some(f => f.includes('eval_fixture')), v.covers.join());
  assert.ok(w.candidate.attempts > 0);
  assert.deepStrictEqual(v.failures.filter(f => !/blow/.test(f)), [], 'no failure the champion lacks');
});
