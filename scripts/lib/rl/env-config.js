'use strict';

/**
 * A training config (rl/configs/...) to a challenge env. The config names a
 * policy strategy (`strategy`: strategies/<name>/STRATEGY.md, signal: policy),
 * and that document is the source of truth: the strategies whose setups the
 * policy trades, the account, sizing, contract mode (micro | mini | auto),
 * and exit. A config may override `sizing` and `contracts` (a sweep searches
 * them); the bundle records what it was trained with, and live trading uses
 * it only when the strategy's document says the same.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateBacktestConfig, barsAt } = require('../backtest/run');
const { loadStrategies } = require('../trading/strategies');
const { accountNamed } = require('../trading/accounts');
const { loadConfig } = require('../trading/config');
const { familyOf } = require('../trading/contracts');
const { CONTRACT_MODES } = require('../trading/combine');
const { createEnv } = require('./challenge-env');
const { observationFields } = require('./observation');
const { optionsFromParams } = require('../trading/volume-profile');

const NAME = /^[a-z0-9][a-z0-9_.-]*$/;
const ENGINE_KEYS = ['sessions', 'eodAt', 'slippageTicks', 'earlyCloseDates', 'closedDates', 'earlyCloseEodAt', 'window'];

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The policy strategy `name`, checked, with its component strategies (in its order). */
function policyStrategy(root, name, env = process.env) {
  const all = loadStrategies(root, env).strategies;
  const s = all.find(x => x.name === name);
  if (!s) throw new Error(`strategy: ${name} is not a strategy (strategies/${name}/STRATEGY.md)`);
  if (s.signal !== 'policy') throw new Error(`strategy: ${name} is signal: ${s.signal}; training needs a policy strategy (signal: policy)`);
  if (!s.valid) throw new Error(`strategy: ${name} is invalid (${s.errors[0]})`);
  return { strategy: s, components: s.strategies.map(n => all.find(x => x.name === n)) };
}

/**
 * @param cfg the parsed training config
 * @param baseDir where relative data paths resolve from (the config's folder)
 * @returns { env, meta } meta: what the bundle records about the env
 */
function envFromConfig(cfg, { root, baseDir, env = process.env, log = () => {}, hashData = true }) {
  if (!NAME.test(String(cfg.name || ''))) throw new Error('name: lowercase letters, digits, _ . -');
  if (!/^[A-Z0-9]+$/.test(String(cfg.symbol || ''))) throw new Error('symbol: the data\'s contract root, e.g. "MNQ" (micros and minis share its bars)');
  if (typeof cfg.strategy !== 'string') throw new Error('strategy: the policy strategy to train (signal: policy), e.g. "prop_portfolio_3m"');
  for (const k of ['account', 'strategies', 'gate']) {
    if (cfg[k] !== undefined) throw new Error(`${k}: comes from the policy strategy's STRATEGY.md (training always runs the harness rules)`);
  }
  const { strategy, components } = policyStrategy(root, cfg.strategy, env);
  const fam = familyOf(cfg.symbol);
  if (!strategy.instruments.includes(cfg.symbol) && !(fam && (strategy.instruments.includes(fam.micro) || strategy.instruments.includes(fam.mini)))) {
    throw new Error(`symbol: ${strategy.name} trades ${strategy.instruments.join(', ')}, not ${cfg.symbol}`);
  }
  const contracts = cfg.contracts ?? strategy.contracts ?? 'auto';
  if (!CONTRACT_MODES.includes(contracts)) throw new Error(`contracts: ${CONTRACT_MODES.join(' | ')}`);
  const sizing = cfg.sizing ?? strategy.sizing ?? null;
  const raw = {
    symbols: [cfg.symbol], timeframe: Number.parseInt(strategy.timeframe, 10), data: cfg.data, strategies: components.map(c => c.name), gate: true, slippageTicks: 0,
  };
  for (const k of ENGINE_KEYS) if (cfg[k] !== undefined) raw[k] = cfg[k];
  if (cfg.timeframe !== undefined && cfg.timeframe !== raw.timeframe) throw new Error(`timeframe: ${strategy.name} trades ${strategy.timeframe} bars`);
  const bt = validateBacktestConfig(raw, baseDir);
  const account = accountNamed(root, strategy.account, env);
  const markets = bt.markets.map(m => {
    log(`loading ${m.symbol} from ${m.file}`);
    return { ...m, bars: barsAt(m.file, bt.timeframe, m.sheet) };
  });
  const names = components.map(c => c.name);
  const e = createEnv({
    markets, strategies: components, account, sizing, reward: cfg.reward || {},
    prop: { strategy, components: names, contracts },
    engine: { ...bt, gateConfig: loadConfig(env) },
  });
  const meta = {
    strategy: strategy.name, components: names, strategies: names, account: account.name, symbol: cfg.symbol, timeframe: bt.timeframe,
    sizing, contracts, exit: strategy.exit, obsFields: observationFields(names),
    // The volume profile its observation reads (value_area, poc_dist), from the policy strategy's params.
    profile: optionsFromParams(strategy.params || {}),
    // The simulator it was trained and validated in.
    engine: { gate: true, sessions: bt.sessions, eodAt: bt.eodAt, slippageTicks: bt.slippageTicks, earlyCloseDates: bt.earlyCloseDates, closedDates: bt.closedDates },
    data: markets.map(m => ({ symbol: m.symbol, file: path.basename(m.file), sha256: hashData ? fileHash(m.file) : null })),
  };
  return { env: e, meta };
}

module.exports = { envFromConfig, policyStrategy, fileHash };
