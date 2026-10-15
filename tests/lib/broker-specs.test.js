'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const specs = require('../../scripts/lib/trading/broker-specs');
const { specFor, familyOf } = require('../../scripts/lib/trading/contracts');
const { FAKE_BROKERS, tmpDir, recordBrokerSpecs, TEST_SIZING } = require('../helpers');

test('validSpec: both numbers sane, else nothing (a zero, a negative, a huge value, a non-number)', () => {
  assert.deepStrictEqual(specs.validSpec({ tickSize: 0.25, tickValue: 0.5 }), { tickSize: 0.25, tickValue: 0.5 });
  assert.deepStrictEqual(specs.validSpec({ tickSize: '0.005', tickValue: '25' }), { tickSize: 0.005, tickValue: 25 }, 'numeric strings are read');
  for (const bad of [null, {}, { tickSize: 0.25 }, { tickValue: 0.5 }, { tickSize: 0, tickValue: 0.5 }, { tickSize: 0.25, tickValue: 0 }, { tickSize: -0.25, tickValue: 0.5 },
    { tickSize: 0.25, tickValue: -5 }, { tickSize: 0.25, tickValue: 1e9 }, { tickSize: 1e9, tickValue: 5 }, { tickSize: 0.25, tickValue: 0.001 }, { tickSize: NaN, tickValue: 5 },
    { tickSize: 0.25, tickValue: Infinity }, { tickSize: '', tickValue: 5 }, { tickSize: 0.25, tickValue: true }, { tickSize: [0.25], tickValue: 5 }]) {
    assert.strictEqual(specs.validSpec(bad), null, JSON.stringify(bad));
  }
});

test('brokerSpecFor: the recorded spec of a root, read locally; an old file, a missing one, or a malformed entry gives none', () => {
  const home = tmpDir();
  const file = path.join(home, 'contracts-fake.json');
  assert.strictEqual(specs.brokerSpecFor(file, 'MNQ'), null, 'no file');
  assert.strictEqual(specs.brokerSpecFor(null, 'MNQ'), null, 'no broker configured');
  // A file from before specs were recorded: ids and front months only.
  fs.writeFileSync(file, JSON.stringify({ ids: { 'b-1': { root: 'MNQ', month: '2026-12' } }, front: {} }));
  assert.strictEqual(specs.brokerSpecFor(file, 'MNQ'), null);
  fs.writeFileSync(file, 'not json');
  assert.strictEqual(specs.brokerSpecFor(file, 'MNQ'), null);
  recordBrokerSpecs(home, { roots: ['MNQ', 'NQ'], specs: { NQ: { tickValue: 0 } } });
  const mnq = specs.brokerSpecFor(file, 'mnq');
  // No fee: a fee is the account's (ACCOUNT.md fees_per_side), never the broker spec's or the table's.
  assert.deepStrictEqual([mnq.tickSize, mnq.tickValue, mnq.feesPerSide, mnq.source, mnq.id, mnq.name], [0.25, 0.5, undefined, 'broker', 'fake:MNQ:Z26', 'MNQZ6']);
  assert.strictEqual(specs.brokerSpecFor(file, 'NQ'), null, 'a malformed record (tick value 0) is none');
  assert.strictEqual(specs.brokerSpecFor(file, 'ES'), null, 'another root');
  // A root the static table lacks still gets the broker's spec (no fee estimate).
  recordBrokerSpecs(home, { roots: [], specs: { ZB: { tickSize: 0.03125, tickValue: 31.25 } } });
  assert.deepStrictEqual([specs.brokerSpecFor(file, 'ZB').tickValue, specs.brokerSpecFor(file, 'ZB').feesPerSide], [31.25, undefined]);
  const source = specs.brokerSpecs(file);
  assert.strictEqual(source('MNQ').tickValue, 0.5);
  assert.strictEqual(source('NQ'), null);
});

test('contractsFileFor / liveSpecs: the selected broker\'s file under the home', () => {
  const home = tmpDir();
  assert.strictEqual(specs.contractsFileFor(home, { FTH_BROKERS_FILE: FAKE_BROKERS }), path.join(home, 'contracts-fake.json'));
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'mock', brokers: { mock: { command: ['x'] } } }));
  assert.strictEqual(specs.contractsFileFor(home, {}), path.join(home, 'contracts-mock.json'));
  assert.strictEqual(specs.contractsFileFor(home, { FTH_BROKER: 'other', FTH_BROKERS_FILE: FAKE_BROKERS }), null, 'FTH_BROKER picks: not in that file');
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'mock', brokers: { mock: { command: ['x'] }, other: { command: ['y'] } } }));
  assert.strictEqual(specs.contractsFileFor(home, { FTH_BROKER: 'other' }), path.join(home, 'contracts-other.json'), 'FTH_BROKER picks');
  assert.strictEqual(specs.contractsFileFor(home, { FTH_BROKER: 'nope' }), null, 'an unknown broker: no file, no specs');
  recordBrokerSpecs(home, { broker: 'mock', roots: ['MES'] });
  assert.strictEqual(specs.liveSpecs({ FTH_HOME: home })('MES').tickValue, 1.25);
  assert.strictEqual(specs.liveSpecs({ FTH_HOME: home })('MNQ'), null);
  // A broken brokers.json: no file, so no specs (entries are refused).
  fs.writeFileSync(path.join(home, 'brokers.json'), '{');
  assert.strictEqual(specs.contractsFileFor(home, {}), null);
  assert.strictEqual(specs.liveSpecs({ FTH_HOME: home })('MES'), null);
});

test('specMismatch: a broker spec that differs from the static table is said (training would not equal live)', () => {
  assert.strictEqual(specs.specMismatch('MNQ', { tickSize: 0.25, tickValue: 0.5 }), null);
  assert.match(specs.specMismatch('MNQ', { tickSize: 0.25, tickValue: 5 }), /^MNQ: the broker's tick spec \(0\.25 = \$5\.00\) differs from the static table .*\(0\.25 = \$0\.50, scripts\/lib\/trading\/contracts\.js\): training does not equal live/);
  assert.match(specs.specMismatch('nq', { tickSize: 0.5, tickValue: 5 }), /^NQ: .*\(0\.5 = \$5\.00\)/);
  assert.strictEqual(specs.specMismatch('ZB', { tickSize: 0.03125, tickValue: 31.25 }), null, 'no table entry: nothing to compare');
  assert.strictEqual(specs.specMismatch('MNQ', { tickSize: 0, tickValue: 5 }), null, 'an unusable spec is not compared');
  assert.match(specs.noSpecsMessage('nq'), /^no tick specs from the broker for NQ yet: call get_contract or search_contracts for NQ first/);
});

test('the static table (offline): silver per CME - SI 5,000 oz and SIL 1,000 oz at $0.005, a micro/mini family of 5', () => {
  assert.deepStrictEqual([specFor('SI').tickSize, specFor('SI').tickValue], [0.005, 25]);
  assert.deepStrictEqual([specFor('SIL').tickSize, specFor('SIL').tickValue], [0.005, 5]);
  // $0.005 x 5,000 oz = $25.00; $0.005 x 1,000 oz = $5.00.
  assert.strictEqual(Math.round(0.005 * 5000 * 100) / 100, specFor('SI').tickValue);
  assert.strictEqual(Math.round(0.005 * 1000 * 100) / 100, specFor('SIL').tickValue);
  assert.deepStrictEqual(familyOf('si'), { micro: 'SIL', mini: 'SI', ratio: 5 });
  assert.strictEqual(familyOf('MNQ').ratio, 10);
});

test('prop sizing legs from a spec source: the broker\'s tick values and the mini:micro ratio they make', () => {
  const { legsFor } = require('../../scripts/lib/trading/prop-state');
  const account = { max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: {} };
  const broker = r => ({ MNQ: { tickSize: 0.25, tickValue: 0.5 }, NQ: { tickSize: 0.25, tickValue: 10 } }[r] || null);
  const live = legsFor(account, 'MNQ', broker);
  assert.deepStrictEqual([live.legs.micro.tickValue, live.legs.mini.tickValue, live.ratio], [0.5, 10, 20]);
  const offline = legsFor(account, 'MNQ');
  assert.deepStrictEqual([offline.legs.mini.tickValue, offline.ratio], [5, 10], 'the static table by default (backtests, training)');
  const partial = legsFor(account, 'MNQ', r => (r === 'MNQ' ? broker(r) : null));
  assert.deepStrictEqual([partial.legs.mini, partial.ratio], [null, 10]);
});

test('brokerSpecs: a recorded spec unlike the static table is no spec (fail closed), and why says so; budgetPlan refuses a family whose tick sizes differ', () => {
  const home = tmpDir();
  const file = recordBrokerSpecs(home, { roots: ['MNQ', 'NQ'], specs: { NQ: { tickValue: 0.5 }, ZZ: { tickSize: 0.1, tickValue: 1 } } });
  const source = specs.brokerSpecs(file);
  assert.strictEqual(source('MNQ').tickValue, 0.5);
  assert.strictEqual(source('NQ'), null, 'NQ at $0.50 a tick (the table: $5): not trusted');
  assert.match(source.why('NQ'), /^NQ: the broker's tick spec \(0\.25 = \$0\.50\) differs from the static table .*; no entries on it until they agree$/);
  assert.match(source.why('ES'), /^no tick specs from the broker for ES yet/);
  assert.strictEqual(source('ZZ').tickSize, 0.1, 'a root the table lacks: the broker\'s spec is the only one');
  assert.match(specs.whyNoSpec(() => null, 'ES'), /^no tick specs from the broker for ES yet/);
  // A family whose contracts report different tick sizes can't share one stop in ticks.
  const prop = require('../../scripts/lib/trading/prop-state');
  const account = { name: 'mini', valid: true, errors: [], starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod', daily_loss_limit: 1000, daily_loss_soft: 500, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 } };
  const now = new Date('2026-10-07T14:00:00Z');
  prop.startAttempt(home, account, new Date(now.getTime() - 86400000));
  prop.snapshot(home, account, 50000, new Date(now.getTime() - 60000));
  const odd = r => ({ MNQ: { tickSize: 0.25, tickValue: 0.5 }, NQ: { tickSize: 0.5, tickValue: 10 } }[r] || null);
  assert.match(prop.budgetPlan(home, account, { sizing: TEST_SIZING, contracts: 'auto' }, 'MNQ', 40, 1, odd).error, /MNQ and NQ have different tick sizes \(0\.25, 0\.5\)/);
  // $400 budget; 40 ticks plus a tick of expected slippage: 41 x $0.50 + $0.74 fees = $21.24 a micro, 18 MNQ.
  assert.strictEqual(prop.budgetPlan(home, account, { sizing: TEST_SIZING, contracts: 'micro' }, 'MNQ', 40, 1, specs.brokerSpecs(recordBrokerSpecs(home, { roots: ['NQ'] }))).size, 18);
});
