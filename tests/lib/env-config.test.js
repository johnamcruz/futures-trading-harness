'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { envFromConfig } = require('../../scripts/lib/rl/env-config');
const { DEFAULTS } = require('../../scripts/lib/backtest/engine');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'tests', 'fixtures', 'data');
const base = { name: 'fills', strategy: 'prop_portfolio', symbol: 'MNQ', data: { MNQ: 'bars.csv' } };
const build = cfg => envFromConfig(cfg, { root: ROOT, baseDir: DATA, env: {}, hashData: false });

test('env-config: training fills as live (next bar\'s open, the backtester\'s slippage), and the bundle records it', () => {
  assert.ok(DEFAULTS.slippageTicks >= 1);
  const { meta } = build(base);
  assert.strictEqual(meta.engine.slippageTicks, DEFAULTS.slippageTicks);
  assert.strictEqual(meta.engine.fill, 'next-open');
  assert.strictEqual(build({ ...base, slippageTicks: DEFAULTS.slippageTicks + 1 }).meta.engine.slippageTicks, DEFAULTS.slippageTicks + 1, 'more slippage is allowed');
});

test('env-config: a config can\'t train on cheaper fills than live', () => {
  assert.throws(() => build({ ...base, slippageTicks: 0 }), /slippageTicks: at least 1/);
  for (const s of ['none', '2', true, [1], Infinity]) assert.throws(() => build({ ...base, slippageTicks: s }), /slippageTicks: at least 1/, JSON.stringify(s));
  assert.throws(() => build({ ...base, fill: 'close' }), /fill: training always fills as live/);
});

test('env-config: the account, strategies and gate come from the policy strategy', () => {
  for (const k of ['account', 'strategies', 'gate']) assert.throws(() => build({ ...base, [k]: 'x' }), new RegExp(`${k}: comes from`));
  assert.throws(() => build({ ...base, strategy: 'orb' }), /needs a policy strategy/);
  assert.throws(() => build({ ...base, symbol: 'CL' }), /trades .*, not CL/);
});

test('env-config: the engine\'s live fills are what rl/fth_rl/pipeline.py FILLS_VERSION names (change both together)', () => {
  const fs = require('fs');
  const py = fs.readFileSync(path.join(ROOT, 'rl', 'fth_rl', 'pipeline.py'), 'utf8');
  const version = /FILLS_VERSION = "([^"]+)"/.exec(py)[1];
  // A sweep study is bound to its fills: a change here without a new FILLS_VERSION would resume old studies with mixed trials.
  assert.match(version, new RegExp(`^${DEFAULTS.fill}, at least ${DEFAULTS.slippageTicks} tick`));
});
