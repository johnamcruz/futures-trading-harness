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
});
