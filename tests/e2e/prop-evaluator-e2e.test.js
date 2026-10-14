'use strict';

/**
 * The two-layer evaluator end to end (docs/LEARNED-RULEBOOK.md R6-R9) on the repo's real NQ 3-minute CSV
 * fixture (tests/fixtures/parity/NQ-3m.csv, five sessions of April 2026), moved 260 weeks back so its
 * sessions fall in Train (the weekdays kept): scripts/evaluate.js runs a fixture policy strategy over shipped
 * rules strategies on a fixture account with 2-session attempts, through both layers, and prints a result the
 * promotion gate reads. The same run is deterministic under its seed. A held-out window is refused without a
 * look, and with one the look reaches the ledger before any bar is read.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { gateFailures } = require('../../scripts/lib/prop/promotion');
const { tradingDayKey } = require('../../scripts/lib/trading/clock');
const { tmpDir, TEST_ACCOUNTS, FX_STRATEGIES } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const CSV = path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv');
const SHIFT = 260 * 7 * 86400000;

function setup() {
  const home = tmpDir();
  const bars = readBarsArg(CSV);
  const lines = ['datetime,open,high,low,close,volume', ...bars.map(b => `${new Date(Date.parse(b.t) - SHIFT).toISOString()},${b.o},${b.h},${b.l},${b.c},${b.v}`)];
  const data = path.join(home, 'NQ-3m-train.csv');
  fs.writeFileSync(data, `${lines.join('\n')}\n`);
  // Its components: orb and the fixtures fx_cross and fx_break (tests/fixtures/strategies-fx), which fire on this CSV.
  const strat = path.join(home, 'strategies', 'eval_fixture');
  fs.mkdirSync(strat, { recursive: true });
  const policy = fs.readFileSync(path.join(ROOT, 'strategies', 'prop_portfolio', 'STRATEGY.md'), 'utf8')
    .replace(/^name: prop_portfolio$/m, 'name: eval_fixture')
    .replace(/^instruments: .*$/m, 'instruments: [MNQ, NQ]')
    .replace(/^strategies: .*$/m, 'strategies: [fx_cross, fx_break, orb]')
    .replace(/^account: .*$/m, 'account: eval_acct')
    .replace(/^contracts: .*$/m, 'contracts: micro');
  fs.writeFileSync(path.join(strat, 'STRATEGY.md'), policy);
  const acct = path.join(home, 'accounts', 'eval_acct');
  fs.mkdirSync(acct, { recursive: true });
  fs.writeFileSync(path.join(acct, 'ACCOUNT.md'), fs.readFileSync(path.join(TEST_ACCOUNTS, 'test_50k', 'ACCOUNT.md'), 'utf8')
    .replace(/^name: test_50k$/m, 'name: eval_acct').replace(/^sessions: 30\b/m, 'sessions: 2').replace(/^profit_target: 3000\b/m, 'profit_target: 300'));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || '', FTH_HOME: home, FTH_STRATEGIES_DIRS: `${path.join(home, 'strategies')},${FX_STRATEGIES}`, FTH_ACCOUNTS_DIRS: path.join(home, 'accounts') };
  const sessions = [...new Set(bars.map(b => tradingDayKey(new Date(Date.parse(b.t) - SHIFT))))];
  return { home, data, env, sessions };
}

const run = (args, env) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'evaluate.js'), ...args], { encoding: 'utf8', env, cwd: ROOT });

test('e2e: the evaluator scores a policy on the CSV fixture through both layers; the gate reads its result', () => {
  const { home, data, env, sessions } = setup();
  assert.ok(sessions.length >= 4, `sessions ${sessions}`);
  assert.ok(sessions[0] >= '2021-01-01' && sessions[sessions.length - 1] < '2023-07-01', 'moved into Train');
  const to = new Date(Date.parse(`${sessions[sessions.length - 1]}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const args = ['--prop', 'eval_fixture', '--data', `MNQ=${data}`, '--from', sessions[0], '--to', to, '--seed', '3', '--paths', '300', '--reps', '300'];
  const a = run(args, env);
  assert.strictEqual(a.status, 0, a.stderr);
  const r = JSON.parse(a.stdout);
  assert.strictEqual(r.window.role, 'train');
  assert.strictEqual(r.look, null);
  assert.strictEqual(r.account, 'eval_acct');
  assert.ok(r.trades > 0, `trades ${r.trades}: ${a.stderr}`);
  assert.strictEqual(r.factsErrors, 0, 'every trade has its facts from the live scan and briefing');
  assert.ok(r.real.attempts >= 1 && r.real.attempts === r.attempts);
  assert.strictEqual(r.real.passed + r.real.blown + r.real.timeout + r.real.unfinished, r.real.attempts);
  assert.strictEqual(r.resampled.paths, 300);
  for (const k of ['pass', 'blow', 'timeout']) assert.ok('lo' in r.intervals[k] && 'hi' in r.intervals[k]);
  assert.ok(Number.isInteger(r.ess) && r.ess >= 1);
  assert.ok(r.runtimeMs.layer1 >= 0 && r.runtimeMs.layer2 >= 0);
  assert.ok(Array.isArray(gateFailures(r)) && gateFailures(r).some(f => /too small/.test(f)), 'a handful of attempts is too small for the gate');
  assert.deepStrictEqual(r.promotion.failures, gateFailures(r));
  assert.match(a.stderr, /\[evaluate\] pass .* over \d+ attempts \(ESS \d+\)/);
  // Deterministic under the seed (the runtimes aside).
  const b = run(args, env);
  const same = x => JSON.stringify({ ...JSON.parse(x), runtimeMs: null });
  assert.strictEqual(same(b.stdout), same(a.stdout));
  fs.rmSync(home, { recursive: true, force: true });
});

test('e2e: a held-out window is refused without a look; with one, the look is logged before the bars are read', () => {
  const { home, data, env } = setup();
  const sel = ['--prop', 'eval_fixture', '--data', `MNQ=${data}`, '--from', '2023-08-01', '--to', '2023-09-01'];
  const no = run(sel, env);
  assert.strictEqual(no.status, 1);
  assert.match(no.stderr, /in select, not train: it needs a look/);
  const ledger = path.join(home, 'ledger.jsonl');
  const missing = run([...sel, '--look-candidate', 'fixture', '--look-purpose', 'judging', '--ledger', ledger], env);
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /no ledger at/);
  assert.ok(!fs.existsSync(ledger), 'a mistyped ledger path starts no budget');
  const look = run([...sel, '--look-candidate', 'fixture', '--look-purpose', 'judging', '--ledger', ledger, '--new-ledger'], env);
  // The fixture has no bars in 2023: the run fails after the look is logged (a look counts once taken).
  assert.strictEqual(look.status, 1);
  assert.match(look.stderr, /no 3m bar in the window 2023-08-01\.\.2023-09-01/);
  const logged = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(logged.map(l => [l.candidate, l.purpose, l.ranges[0].from, l.ranges[0].to]), [['fixture', 'judging', '2023-08-01', '2023-09-01']]);
  const tune = run([...sel, '--look-candidate', 'fixture', '--look-purpose', 'tuning', '--ledger', ledger], env);
  assert.strictEqual(tune.status, 1);
  assert.match(tune.stderr, /allows judging looks only, not tuning/);
  assert.strictEqual(fs.readFileSync(ledger, 'utf8').trim().split('\n').length, 1, 'a refused look is not logged');
  assert.match(run(['--ledger', '--no-gate'], env).stderr, /--ledger needs a value/);
  assert.match(run(['--seed', '1', '--seed', '2'], env).stderr, /--seed is given twice/);
  const bad = run(['--bogus'], env);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /unknown argument: --bogus/);
  fs.rmSync(home, { recursive: true, force: true });
});
