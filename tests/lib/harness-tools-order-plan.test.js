'use strict';

// The order_plan operation (scripts/lib/harness-tools/order-plan.js): the order for the strategy and
// side the caller chose, from the scan at the harness clock; refusals when it isn't a candidate now.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { plan } = require('../../scripts/lib/harness-tools/order-plan');
const strategiesOps = require('../../scripts/lib/harness-tools/strategies');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const prop = require('../../scripts/lib/trading/prop-state');
const { accountNamed } = require('../../scripts/lib/trading/accounts');
const { tmpDir, recordBrokerSpecs } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
// The parity bar where bos (and ema_cross) fired long (tests/e2e/mock-trading-e2e.test.js), and just after it closed.
const FIRED_BAR = '2026-04-28T04:09:00.000Z';
const NOW = new Date(Date.parse(FIRED_BAR) + 180000 + 20000);

function setup({ specs = true } = {}) {
  const home = tmpDir();
  // The broker's tick specs, as the translator records them (the default broker's, and the mock's of the policy test).
  if (specs) for (const broker of ['topstepx', 'mock']) recordBrokerSpecs(home, { broker });
  const bars = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'))
    .filter(b => Date.parse(b.t) <= Date.parse(FIRED_BAR)).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  const file = path.join(home, 'MNQ-3m.json');
  fs.writeFileSync(file, JSON.stringify(bars));
  return { home, file, ctx: { root: ROOT, env: { FTH_HOME: home }, now: () => NOW, tool: true } };
}

test('order_plan: a rules candidate on the side it fired - the working shown, the place_order arguments as JSON', () => {
  const { file, ctx } = setup();
  const r = plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long', accountId: 7 }, ctx);
  const [line, json, ...rest] = r.text.split('\n');
  assert.deepStrictEqual(rest, ['']);
  // bos: stop atr:0.5 = 4.4283 pts = 17.71 ticks -> 18 (never fewer); trailing exit: no target.
  assert.strictEqual(line, 'bos long: 1 MNQ at market (entry ref 27427.50) | stop 27423.00, below the entry: 4.4283 pts = 18 ticks ($9.00/MNQ contract), stopLossBracket.ticks 18'
    + ' | no target order: trail from 2R giving back 0.5R | risk $9.00 = 1 x 18 ticks x $0.50/tick (before fees)'
    + ' | size 1: the minimum; no account budget sizes a rules strategy (position-sizing: size 1 until the setup has 30+ reviewed trades)');
  const args = JSON.parse(json.replace(/^place_order arguments: /, ''));
  assert.deepStrictEqual(args, {
    accountId: 7, contractId: 'MNQ', side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 18, type: 'stop' },
    rationale: 'setup:bos long at market from 27427.50 (the signal bar\'s close), stop 27423.00 (18 ticks), 1 MNQ risks $9.00',
  });
  assert.deepStrictEqual(r.args, args);
  // The same candidate as the scan reports, in the same units.
  const summary = strategiesOps.scan({ file, symbol: 'MNQ', view: 'summary' }, ctx).text;
  assert.match(summary, /\n {2}bos long \| .*entryRef 27427\.5, stop 4\.4283 pts = 18 ticks \(\$9\.00\/MNQ contract\)/);
  // Without accountId: the arguments say to add it.
  assert.match(plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, ctx).text, /\nplace_order arguments \(add "accountId": the account's id\): \{"contractId":"MNQ"/);
});

test('order_plan: the tick specs are the broker\'s; none recorded for the contract is a refusal saying to fetch it', () => {
  const { file, home, ctx } = setup({ specs: false });
  const none = /no tick specs from the broker for MNQ yet: call get_contract or search_contracts for MNQ first .*; no order/;
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, ctx), none);
  // Another root's spec doesn't do; a malformed one (a zero tick value) records nothing usable.
  recordBrokerSpecs(home, { roots: ['MES'] });
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, ctx), none);
  recordBrokerSpecs(home, { roots: ['MNQ'], specs: { MNQ: { tickValue: 0 } } });
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, ctx), none);
  // A broker spec unlike the static table (MNQ at $5 a tick): neither can be trusted, so no plan.
  recordBrokerSpecs(home, { roots: ['MNQ'], specs: { MNQ: { tickValue: 5 } } });
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, ctx), /MNQ: the broker's tick spec \(0\.25 = \$5\.00\) differs from the static table .*; no entries on it until they agree; no order/);
  // Recorded and agreeing: planned at the broker's numbers.
  recordBrokerSpecs(home, { roots: ['MNQ'] });
  const r = plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, ctx);
  assert.match(r.text, /4\.4283 pts = 18 ticks \(\$9\.00\/MNQ contract\)/);
});

test('order_plan: units follow the instrument (MES $1.25 a tick on the same distance)', () => {
  const { file, ctx } = setup();
  const r = plan({ file, symbol: 'MES', strategy: 'bos', side: 'long' }, ctx);
  assert.match(r.text, /4\.4283 pts = 18 ticks \(\$22\.50\/MES contract\)/);
  assert.strictEqual(r.args.contractId, 'MES');
  assert.strictEqual(r.plan.riskUsd, 22.5);
});

test('order_plan: the caller chooses; it refuses, with the reason, rather than pick', () => {
  const { file, ctx } = setup();
  const refuse = (args, why) => assert.throws(() => plan({ file, symbol: 'MNQ', ...args }, ctx), why);
  refuse({ strategy: 'bos' }, /side: long or short, the side you chose \(got none\)/);
  refuse({ strategy: 'bos', side: 'up' }, /side: long or short/);
  refuse({ strategy: 'bos', side: 'short' }, /bos fired long on the last closed bar, not short: the other side is not its setup; no order/);
  refuse({ strategy: 'orb', side: 'long' }, /orb is not a candidate on the last closed bar \(no rule set fired .*\); no order/);
  refuse({ strategy: 'nope', side: 'long' }, /unknown strategy "nope"/);
  refuse({ strategy: 'bos', side: 'long', accountId: 1.5 }, /accountId: the broker account's id/);
  assert.throws(() => plan({ file, symbol: 'ES', strategy: 'bos', side: 'long' }, ctx), /bos does not trade ES/);
  assert.throws(() => plan({ file, symbol: 'mnq\n', strategy: 'bos', side: 'long' }, ctx), /symbol: a contract root/);
  assert.throws(() => plan({ symbol: 'MNQ', strategy: 'bos', side: 'long' }, ctx), /needs a bars file/);
  // A manual strategy's trigger and stop are the model's, from STRATEGY.md: nothing to calculate.
  const { home } = setup();
  const root = path.join(home, 'plugin');
  fs.mkdirSync(path.join(root, 'strategies', 'anytime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'strategies', 'anytime', 'STRATEGY.md'), [
    '---', 'name: anytime', 'description: Test strategy that is valid at any time of day for MNQ only.',
    'status: active', 'instruments: [MNQ]', 'timeframe: 3m', 'signal: manual', 'risk:', '  stop: manual', '  min_rr: 1', '---',
    '## When to Use', '## How It Works', '## Examples', '',
  ].join('\n'));
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'anytime', side: 'long' }, { ...ctx, root }), /anytime is a manual strategy: order_plan plans a rules strategy's candidate or a policy strategy's verdict/);
});

test('order_plan: only the strategy\'s own, current bars - another timeframe, a bar not closed, or stale bars are refused', () => {
  const { file, home, ctx } = setup();
  const bars = JSON.parse(fs.readFileSync(file, 'utf8'));
  // The same bars relabelled one minute apart: bos trades 3m bars.
  const end = Date.parse(bars.at(-1).t);
  const oneMin = path.join(home, 'MNQ-1m.json');
  fs.writeFileSync(oneMin, JSON.stringify(bars.map((b, i) => ({ ...b, t: new Date(end - (bars.length - 1 - i) * 60000).toISOString() }))));
  assert.throws(() => plan({ file: oneMin, symbol: 'MNQ', strategy: 'bos', side: 'long' }, { ...ctx, now: () => new Date(end + 70000) }), /the bars are 1-minute; the strategy trades 3m bars/);
  // The last bar's close after the harness clock: within the gate's 1 minute (a broker clock a little ahead,
  // signal-state.js FUTURE_TOLERANCE_MIN) it is planned, as the gate accepts it; beyond it, refused.
  assert.strictEqual(plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, { ...ctx, now: () => new Date(end + 180000 - 30000) }).args.size, 1, '30 s ahead: planned');
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, { ...ctx, now: () => new Date(end + 180000 - 120000) }), /more than 1 min after the harness clock .*it hasn't closed/);
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, { ...ctx, now: () => new Date(end + 180000 - 61000) }), /hasn't closed/, 'just over the minute');
  assert.strictEqual(plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, { ...ctx, now: () => new Date(end + 180000 - 60000) }).args.size, 1, 'exactly the minute: planned, as the gate accepts it');
  // Older than the gate's signal age (10 min by default; FTH_SIGNAL_MAX_AGE_MIN).
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, { ...ctx, now: () => new Date(end + 180000 + 11 * 60000) }), /more than 10 min before the harness clock .*fetch current bars/);
  assert.strictEqual(plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, { ...ctx, now: () => new Date(end + 180000 + 9 * 60000) }).args.size, 1, 'within the age');
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, { ...ctx, env: { ...ctx.env, FTH_SIGNAL_MAX_AGE_MIN: '5' }, now: () => new Date(end + 180000 + 6 * 60000) }), /more than 5 min/);
});

test('order_plan: a stop over the strategy\'s risk.max_risk_usd is refused, never shrunk', () => {
  const { file, home } = setup();
  const root = path.join(home, 'plugin');
  fs.mkdirSync(path.join(root, 'strategies', 'bos'), { recursive: true });
  const doc = fs.readFileSync(path.join(ROOT, 'strategies', 'bos', 'STRATEGY.md'), 'utf8').replace('  min_rr: 1.5\n', '  min_rr: 1.5\n  max_risk_usd: 8\n');
  assert.match(doc, /max_risk_usd: 8/);
  fs.writeFileSync(path.join(root, 'strategies', 'bos', 'STRATEGY.md'), doc);
  const ctx = { root, env: { FTH_HOME: home }, now: () => NOW };
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, ctx), /one MNQ at a 18-tick stop risks \$9\.00, over bos's risk\.max_risk_usd \$8: no size fits/);
  fs.writeFileSync(path.join(root, 'strategies', 'bos', 'STRATEGY.md'), doc.replace('max_risk_usd: 8', 'max_risk_usd: 9'));
  assert.strictEqual(plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, ctx).plan.size, 1, 'at the cap: planned');
});

test('order_plan: a paper rules strategy is planned with the note that the gate refuses its live entry', () => {
  const { file, home } = setup();
  const root = path.join(home, 'plugin');
  fs.mkdirSync(path.join(root, 'strategies', 'bos'), { recursive: true });
  const doc = fs.readFileSync(path.join(ROOT, 'strategies', 'bos', 'STRATEGY.md'), 'utf8').replace(/^status: active$/m, 'status: paper');
  assert.match(doc, /^status: paper$/m);
  fs.writeFileSync(path.join(root, 'strategies', 'bos', 'STRATEGY.md'), doc);
  const r = plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, { root, env: { FTH_HOME: home }, now: () => NOW });
  assert.match(r.text.split('\n')[0], / \| status paper: plan only, the gate refuses a live entry$/);
  // The active strategy has no such note.
  const { file: f2, ctx } = setup();
  assert.doesNotMatch(plan({ file: f2, symbol: 'MNQ', strategy: 'bos', side: 'long' }, ctx).text, /status /);
});

test('order_plan: a policy strategy - its verdict\'s contract, side and stop ticks, at most its size and the budget now', () => {
  const { file, home, ctx } = setup();
  // The journal the gate reads (the broker's): this home's own.
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'mock', brokers: { mock: { command: [process.execPath, '/nonexistent'], journal: path.join(home, 'journal.jsonl') } } }));
  // A rules strategy while an attempt runs: refused (only the policy strategy may enter).
  const account = accountNamed(ROOT, 'topstep_100k', {});
  prop.startAttempt(home, account, NOW);
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'bos', side: 'long' }, ctx), /a topstep_100k attempt is running: only the policy strategy that trades it may enter/);
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long' }, ctx), /prop_portfolio has no verdict for MNQ/);
  prop.snapshot(home, account, 100000, NOW);
  const verdict = over => prop.appendVerdict(home, {
    at: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 180000).toISOString(), strategy: 'prop_portfolio', component: 'bos', symbol: 'MNQ',
    bar: FIRED_BAR, direction: 'long', stopTicks: 18, account: 'topstep_100k', policy: null, action: 'full', contract: 'NQ', maxSize: 12, ...over,
  });
  verdict();
  const r = plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long', accountId: 7 }, ctx);
  // $100K, $3,000 cushion: 30% = $900 at 18 ticks ($90 + fees per NQ) -> 9 NQ; the verdict said 12.
  assert.deepStrictEqual([r.args.contractId, r.args.side, r.args.size, r.args.stopLossBracket.ticks, r.args.takeProfitBracket], ['NQ', 'buy', 9, 18, undefined]);
  assert.match(r.args.rationale, /^setup:prop_portfolio long at market from 27427\.50 .*stop 27423\.00 \(18 ticks\), 9 NQ risks \$810\.00$/);
  assert.match(r.text, /size 9: the verdict's full size 12, cut to the size budget now \(9\), for bos's setup; the stop is the verdict's 18 ticks \| status paper: plan only/);
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'short' }, ctx), /verdict is for a long entry, not short/);
  verdict({ contract: 'MNQ', maxSize: 50 });
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long' }, ctx), /the size budget now allows 9 NQ at a 18-tick stop, not MNQ/);
  verdict({ action: 'skip', maxSize: 0, contract: null, reason: 'the policy' });
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long' }, ctx), /prop_portfolio skipped the setup \(the policy\)/);
  verdict({ expiresAt: new Date(NOW.getTime() - 1).toISOString() });
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long' }, ctx), /expired at/);
  verdict({ component: 'orb' });
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long' }, ctx), /orb is not a candidate on the last closed bar/);
  // A verdict from another policy than the strategy's (here: a bundle, where it trades on the sizing alone).
  verdict({ policy: 'other_bundle' });
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long' }, ctx), /^Error: prop_portfolio's latest verdict came from other_bundle, not the sizing alone; no order$/);
  // The verdict's stop was sized on its own bar: a verdict from the bar before (still unexpired), with bos
  // firing again on the last bar, is never paired with this bar's entry.
  verdict({ bar: new Date(Date.parse(FIRED_BAR) - 180000).toISOString() });
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long' }, ctx), /prop_portfolio's verdict is for the bar opened 2026-04-28T04:06:00\.000Z, not the last closed bar of these bars \(opened 2026-04-28T04:09:00\.000Z\)/);
  verdict({ bar: undefined });
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long' }, ctx), /verdict is for the bar opened undefined/, 'no bar: refused');
  // The attempt's own block (here: a position open on the account), with order_plan's reason, not only the gate's.
  verdict();
  prop.snapshot(home, account, 100000, NOW, { open: 1, openIds: [42] });
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long' }, ctx), /^Error: topstep_100k: a position is open on the account \(42\)/);
  prop.snapshot(home, account, 100000, NOW);
  // The gate's own prop checks on the exact arguments: an entry already journaled since the snapshot (and the
  // verdict it used) makes the plan one the gate would refuse, so order_plan refuses it with the gate's reasons.
  verdict();
  assert.strictEqual(plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long' }, ctx).args.size, 9);
  fs.writeFileSync(path.join(home, 'journal.jsonl'), `${JSON.stringify({ ts: new Date(NOW.getTime() + 1000).toISOString(), kind: 'order_placed', contractId: 'NQ', text: 'setup:prop_portfolio long', data: { result: { success: true } } })}\n`);
  const later = { ...ctx, now: () => new Date(NOW.getTime() + 5000) };
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long' }, later), /the order gate would refuse this entry: \[combine\] .*since the snapshot|the order gate would refuse this entry: .*\[policy\] .*already used/);
});

test('order_plan: a policy strategy is sized with the broker\'s tick values, and refused while either contract of the family has none', () => {
  const { file, home, ctx } = setup({ specs: false });
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'mock', brokers: { mock: { command: [process.execPath, '/nonexistent'], journal: path.join(home, 'journal.jsonl') } } }));
  const account = accountNamed(ROOT, 'topstep_100k', {});
  prop.startAttempt(home, account, NOW);
  prop.snapshot(home, account, 100000, NOW);
  prop.appendVerdict(home, {
    at: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 180000).toISOString(), strategy: 'prop_portfolio', component: 'bos', symbol: 'MNQ',
    bar: FIRED_BAR, direction: 'long', stopTicks: 18, account: 'topstep_100k', policy: null, action: 'full', contract: 'NQ', maxSize: 12,
  });
  const go = () => plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long', accountId: 7 }, ctx);
  recordBrokerSpecs(home, { broker: 'mock', roots: ['MNQ'] });
  assert.throws(go, /topstep_100k: no tick specs from the broker for NQ yet: call get_contract or search_contracts for NQ first/);
  // NQ at the broker's $5 a tick: $900 budget / ($90 + $2.80) = 9 NQ.
  recordBrokerSpecs(home, { broker: 'mock', roots: ['NQ'] });
  assert.strictEqual(go().args.size, 9);
  // NQ recorded at $0.50 (a units mix-up): unlike the table, so refused, never sized at 10x.
  recordBrokerSpecs(home, { broker: 'mock', roots: ['NQ'], specs: { NQ: { tickValue: 0.5 } } });
  assert.throws(go, /topstep_100k: NQ: the broker's tick spec \(0\.25 = \$0\.50\) differs from the static table .*no entries on it until they agree/);
});

test('order_plan: the CLI (strategies.js plan) takes the same arguments', () => {
  assert.deepStrictEqual(strategiesOps.parseArgv(['plan', '/b.json', '--symbol', 'MNQ', '--strategy', 'bos', '--side', 'long', '--account-id', '7']),
    { op: 'plan', args: { file: '/b.json', symbol: 'MNQ', strategy: 'bos', side: 'long', accountId: 7 } });
  assert.strictEqual(strategiesOps.parseArgv(['plan', '/b.json', '--symbol', 'MNQ', '--strategy', 'bos', '--side', 'long']).args.accountId, undefined);
  assert.strictEqual(strategiesOps.OPS.plan, plan);
});
