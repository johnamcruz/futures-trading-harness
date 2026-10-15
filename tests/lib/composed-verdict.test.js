'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { composedVerdict } = require('../../scripts/lib/prop/composed-verdict');
const { readVerdicts } = require('../../scripts/lib/trading/prop-state');
const { trendHome } = require('../helpers');
const LC = require('../fixtures/lifecycle');
const P = require('../fixtures/lifecycle-prop');

const SPEC = { tickSize: 0.25, tickValue: 0.5 };
const args = (home, rec, o = {}) => ({ home, policy: P.policy(), component: 'trade_lifecycle', account: P.MINI, record: rec, plan: rec.plan, briefing: LC.briefing(), root: 'MNQ', spec: SPEC, specOf: () => SPEC, now: P.NOW, ...o });

test('the verdict on a compose record: decideSetup on its side and stop, at its bar, tied to it by id; once per record', () => {
  const { home, rec } = P.propHome();
  const v = composedVerdict(args(home, rec));
  // $400 budget, 112 x $0.50 + $0.74 = $56.74 a micro: 7.
  assert.deepStrictEqual([v.action, v.maxSize, v.contract, v.stopTicks, v.direction, v.bar, v.record, v.strategy, v.component], ['full', 7, 'MNQ', 111, 'long', LC.BAR, rec.id, 'prop_portfolio', 'trade_lifecycle']);
  // It lasts as long as the record it sized (two base bars after the bar's close), not decideSetup's one bar.
  assert.strictEqual(v.expiresAt, LC.EXPIRES);
  assert.deepStrictEqual(composedVerdict(args(home, rec)), v, 'the recorded one again');
  assert.strictEqual(readVerdicts(home).length, 1, 'recorded once');
  // Another record on the bar: its own verdict.
  const other = { ...rec, id: 'second' };
  assert.strictEqual(composedVerdict(args(home, other)).record, 'second');
  assert.strictEqual(readVerdicts(home).length, 2);
});

test('the verdict skips (fails closed) with no attempt, no snapshot or no bar; a budget under one contract skips', () => {
  const home = trendHome();
  const rec = LC.writeScenario(home);
  assert.deepStrictEqual([composedVerdict(args(home, rec)).action, composedVerdict(args(home, rec)).reason], ['skip', 'no mini attempt']);
  const p = P.propHome();
  const noBar = LC.briefing({ m3: { bar: undefined } });
  assert.match(composedVerdict(args(p.home, p.rec, { briefing: noBar })).reason, /no bar/);
  // $50,000 - $1,950: a $50 cushion, a $10 budget: under one micro at this stop.
  const thin = P.propHome({ balance: 48050 });
  const v = composedVerdict(args(thin.home, thin.rec));
  assert.strictEqual(v.action, 'skip');
  // A skip stays expired at once (never stretched to the record's expiry).
  assert.notStrictEqual(v.expiresAt, LC.EXPIRES);
  const p2 = P.propHome();
  assert.strictEqual(composedVerdict(args(p2.home, { ...p2.rec, expiresAt: null })).expiresAt, '2026-10-07T14:03:00.000Z', 'no readable record expiry: decideSetup\'s own');
});

test('pacing on a composed trade: the policy\'s clock_k caps the verdict at k x what the pass still needs per session left; off leaves the budget', () => {
  const { home, rec } = P.propHome();
  const sizing = clock => ({ cushion_frac: 0.2, cap_usd: 0, drawdown_halve_usd: 0, min_size_guard: 1.5, stop_slippage_ticks: 1, r_per_session: 0.3, clock_k: clock });
  assert.strictEqual(composedVerdict(args(home, rec, { policy: P.policy({ sizing: sizing(0) }) })).maxSize, 7, 'off: the $400 budget');
  // $3,000 still needed over 30 sessions at 0.3R: k 0.5 caps the risk at 0.5 x 3000 / 9 = $166.67: 2 micros at $56.74.
  const other = { ...rec, id: 'paced' };
  assert.strictEqual(composedVerdict(args(home, other, { policy: P.policy({ sizing: sizing(0.5) }) })).maxSize, 2);
});

test('the loss streak stop on a composed trade: a session at the account\'s loss_streak_stop skips the record\'s verdict', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const account = { ...P.MINI, loss_streak_stop: 1 };
  const { home, rec } = P.propHome({ account });
  const anchor = Date.parse(prop.readAttempt(home, account.name).snapshot.at);
  const fills = [{ creationTimestamp: new Date(anchor + 5000).toISOString(), profitAndLoss: null, fees: 0.37 }, { creationTimestamp: new Date(anchor + 20000).toISOString(), profitAndLoss: -25, fees: 0.37 }];
  prop.snapshot(home, account, 50000 - 25.74, new Date(anchor + 30000), { fills });
  const v = composedVerdict(args(home, rec, { account }));
  assert.deepStrictEqual([v.action, v.maxSize], ['skip', 0]);
  assert.match(v.reason, /1 losing trade in a row this session, at the loss streak stop/);
});
