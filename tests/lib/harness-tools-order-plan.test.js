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
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
// The parity bar where bos (and ema_cross) fired long (tests/e2e/mock-trading-e2e.test.js), and just after it closed.
const FIRED_BAR = '2026-04-28T04:09:00.000Z';
const NOW = new Date(Date.parse(FIRED_BAR) + 180000 + 20000);

function setup() {
  const home = tmpDir();
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
  // The gate's own prop checks on the exact arguments: an entry already journaled since the snapshot (and the
  // verdict it used) makes the plan one the gate would refuse, so order_plan refuses it with the gate's reasons.
  verdict();
  assert.strictEqual(plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long' }, ctx).args.size, 9);
  fs.writeFileSync(path.join(home, 'journal.jsonl'), `${JSON.stringify({ ts: new Date(NOW.getTime() + 1000).toISOString(), kind: 'order_placed', contractId: 'NQ', text: 'setup:prop_portfolio long', data: { result: { success: true } } })}\n`);
  const later = { ...ctx, now: () => new Date(NOW.getTime() + 5000) };
  assert.throws(() => plan({ file, symbol: 'MNQ', strategy: 'prop_portfolio', side: 'long' }, later), /the order gate would refuse this entry: \[combine\] .*since the snapshot|the order gate would refuse this entry: .*\[policy\] .*already used/);
});

test('order_plan: the CLI (strategies.js plan) takes the same arguments', () => {
  assert.deepStrictEqual(strategiesOps.parseArgv(['plan', '/b.json', '--symbol', 'MNQ', '--strategy', 'bos', '--side', 'long', '--account-id', '7']),
    { op: 'plan', args: { file: '/b.json', symbol: 'MNQ', strategy: 'bos', side: 'long', accountId: 7 } });
  assert.strictEqual(strategiesOps.parseArgv(['plan', '/b.json', '--symbol', 'MNQ', '--strategy', 'bos', '--side', 'long']).args.accountId, undefined);
  assert.strictEqual(strategiesOps.OPS.plan, plan);
});
