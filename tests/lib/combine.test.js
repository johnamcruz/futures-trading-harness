'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const c = require('../../scripts/lib/trading/combine');
const { loadAccounts, accountNamed, validateAccount } = require('../../scripts/lib/trading/accounts');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const acct = (extra = {}) => ({
  name: 't', starting_balance: 100000, profit_target: 6000, max_loss: 3000, max_loss_mode: 'trailing_eod',
  daily_loss_limit: 2000, daily_loss_soft: 1000, consistency_pct: 50, sessions: 5, max_contracts: { MNQ: 100 }, ...extra,
});

test('bundled account profiles are valid; unknown or invalid ones are refused', () => {
  const { accounts, problems } = loadAccounts(ROOT, {});
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(accounts.map(a => a.name), ['topstep_100k', 'topstep_150k', 'topstep_50k']);
  for (const a of accounts) assert.deepStrictEqual(a.errors, [], a.name);
  assert.strictEqual(accountNamed(ROOT, 'topstep_100k', {}).profit_target, 6000);
  assert.throws(() => accountNamed(ROOT, 'nope', {}), /unknown account/);
  const body = '## When to Use\n## How It Works\n## Examples';
  const bad = validateAccount({ ...acct(), name: 'x', description: 'a valid description here', max_loss_mode: 'weekly', daily_loss_soft: 2500 }, body, 'x');
  assert.ok(bad.some(e => /max_loss_mode/.test(e)) && bad.some(e => /daily_loss_soft/.test(e)));
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'mine'));
  fs.copyFileSync(path.join(ROOT, 'accounts', 'topstep_50k', 'ACCOUNT.md'), path.join(dir, 'mine', 'ACCOUNT.md'));
  assert.ok(loadAccounts(ROOT, { FTH_ACCOUNTS_DIRS: dir }).accounts.some(a => a.name === 'mine' && !a.valid), 'a folder name must match');
});

test('the floor trails the end-of-day high by max loss and locks at the starting balance', () => {
  let s = c.start(acct());
  assert.strictEqual(s.floor, 97000);
  s = c.endDay(c.applyClose(s, 1500)); // eod 101500
  assert.strictEqual(s.floor, 98500);
  s = c.endDay(c.applyClose(s, -800)); // eod 100700: the high stays 101500
  assert.strictEqual(s.floor, 98500, 'the floor never falls');
  s = c.endDay(c.applyClose(s, 2600)); // eod 103300
  assert.strictEqual(s.floor, 100000, 'locked at the starting balance');
  s = c.endDay(c.applyClose(s, 1000)); // eod 104300
  assert.strictEqual(s.floor, 100000);
});

test('blow: realized or open equity at the floor', () => {
  let s = c.start(acct());
  assert.strictEqual(c.applyClose(s, -3000).status, 'blown');
  s = c.applyClose(s, -1000);
  assert.strictEqual(c.touches(s, -1999), false);
  assert.strictEqual(c.touches(s, -2000), true);
  assert.strictEqual(c.blow(s).status, 'blown');
});

test('pass at end of day: target and consistency; timeout after the sessions', () => {
  let s = c.start(acct());
  s = c.endDay(c.applyClose(s, 4000));
  s = c.endDay(c.applyClose(s, 2100)); // profit 6100, best day 4000 > 50%
  assert.strictEqual(s.status, 'active', 'consistency not met yet');
  assert.match(c.entryBlock(s), /profit target/);
  s = c.endDay(c.applyClose(s, 2000)); // profit 8100, best 4000 <= 4050
  assert.strictEqual(s.status, 'passed');
  assert.match(c.entryBlock(s), /passed/);
  let t = c.start(acct({ sessions: 2 }));
  t = c.endDay(c.endDay(t));
  assert.strictEqual(t.status, 'timeout');
});

test('daily limits: the soft one stops entries, the firm one stops the day; both reset at end of day', () => {
  let s = c.start(acct());
  s = c.applyClose(s, -1000);
  assert.match(c.entryBlock(s), /soft daily limit/);
  s = c.applyClose(s, -1000);
  assert.strictEqual(s.dayStopped, true);
  assert.match(c.entryBlock(s), /daily loss limit/);
  assert.strictEqual(s.status, 'active', 'not a blow');
  s = c.endDay(s);
  assert.strictEqual(c.entryBlock(s), null);
  assert.strictEqual(c.dailyBreached(c.applyClose(s, -500), -1500), true);
});

test('size budget: a share of the cushion, capped, clock-limited, never past the daily limit', () => {
  const s = c.start(acct());
  assert.strictEqual(c.budget(s), 600, '0.2 x 3000');
  assert.strictEqual(c.budget(s, { cap_usd: 400 }), 400);
  // clock: need 6000 over 5 sessions at 0.3R/session, k 0.1 -> 0.1 x 6000 / 1.5 = 400
  assert.strictEqual(c.budget(s, { clock_k: 0.1 }), 400);
  const down = c.applyClose(s, -1900); // firm limit 2000: 100 left today (also the soft limit is hit)
  assert.strictEqual(c.budget(down), 0, 'soft limit reached');
  assert.strictEqual(c.budget(c.applyClose(s, -900), { cushion_frac: 1 }), 1100, 'room to the daily limit');
  assert.strictEqual(c.contracts(600, 50, 100), 12);
  assert.strictEqual(c.contracts(600, 800, 100), 1, 'one contract within 1.5x the budget');
  assert.strictEqual(c.contracts(600, 1000, 100), 0, 'too big: skip');
  assert.strictEqual(c.contracts(6000, 50, 100), 100, 'capped at max contracts');
});

test('sizing in a drawdown: the budget halves while the balance is far enough below its peak', () => {
  const combine = require('../../scripts/lib/trading/combine');
  const acct = { name: 'a', starting_balance: 100000, profit_target: 6000, max_loss: 3000, max_loss_mode: 'trailing_eod', daily_loss_limit: 0, sessions: 30 };
  const z = { cushion_frac: 0.3, cap_usd: 1000, drawdown_halve_usd: 1500 };
  let s = combine.applyClose(combine.start(acct), 2000); // peak $102,000
  assert.strictEqual(s.peak, 102000);
  s = combine.endDay(s); // floor trails to $99,000
  assert.strictEqual(combine.budget(s, z), 900); // 0.3 x $3,000
  s = combine.applyClose(s, -1000); // $1,000 below the peak: full budget, 0.3 x $2,000
  assert.strictEqual(combine.budget(s, z), 600);
  s = combine.applyClose(s, -500); // $1,500 below the peak: half of 0.3 x $1,500
  assert.strictEqual(combine.budget(s, z), 225);
  assert.strictEqual(s.peak, 102000);
});

test('live: the attempt keeps the peak balance across snapshots and closes, as the engine does', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { tmpDir } = require('../helpers');
  const home = tmpDir();
  const acct = { name: 'a', starting_balance: 100000, profit_target: 6000, max_loss: 3000, max_loss_mode: 'trailing_eod', daily_loss_limit: 0, sessions: 30 };
  prop.startAttempt(home, acct, new Date('2026-10-05T14:00:00Z'));
  prop.snapshot(home, acct, 101800, new Date('2026-10-05T15:00:00Z'));
  prop.recordEndOfDay(home, acct, 101200, '2026-10-05');
  const cs = prop.snapshot(home, acct, 100100, new Date('2026-10-06T15:00:00Z'));
  assert.strictEqual(cs.peak, 101800);
  // $1,700 below the peak: half of 0.3 x ($100,100 - $98,200 floor).
  assert.strictEqual(require('../../scripts/lib/trading/combine').budget(cs, { cushion_frac: 0.3, drawdown_halve_usd: 1500 }), 285);
});
