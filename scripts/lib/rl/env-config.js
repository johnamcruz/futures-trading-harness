'use strict';

/**
 * A training config (rl/configs/...) to a challenge env. The config names a
 * policy strategy (`strategy`: strategies/<name>/STRATEGY.md, signal: policy),
 * and that document is the source of truth: the strategies whose setups the
 * policy trades, the account, sizing, contract mode (micro | mini | auto),
 * and exit. A config may override `sizing` and `contracts` (a sweep searches
 * them); the bundle records what it was trained with, and live trading uses
 * it only when the strategy's document says the same.
 *
 * Fills are the backtester's live ones (next bar's open, and at least its
 * default slippage per market fill): a policy trained on cheaper fills than
 * live has a pass rate live trading won't see. A config may only add slippage.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateBacktestConfig, barsAt } = require('../backtest/run');
const { DEFAULTS: ENGINE_DEFAULTS } = require('../backtest/engine');
const { loadStrategies, tradesRoot } = require('../trading/strategies');
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
 * The markets a config trains on: `symbols` (several indexes at once, one
 * shared account) or `symbol` (one). Each is a contract root the policy
 * strategy trades (by its micro/mini family), at most one per family (MNQ
 * and NQ share their bars: both would trade the same market twice).
 */
function symbolsOf(cfg, strategy) {
  if (cfg.symbol !== undefined && cfg.symbols !== undefined) throw new Error('symbol, symbols: use one (symbols: ["MNQ", "MES", ...] trains on several markets with one account)');
  const list = cfg.symbols !== undefined ? cfg.symbols : [cfg.symbol];
  const root = /^[A-Z0-9]+$/;
  if (!Array.isArray(list) || !list.length || !list.every(x => root.test(String(x || '')))) {
    throw new Error('symbols: the data\'s contract roots, e.g. ["MNQ", "MES", "MYM", "M2K"] (micros and minis share their bars)');
  }
  const seen = new Map();
  for (const s of list) {
    const fam = familyOf(s);
    const key = fam ? fam.micro : s;
    if (seen.has(key)) throw new Error(`symbols: ${seen.get(key)} and ${s} are the same market (one root per index)`);
    seen.set(key, s);
    if (!strategy.instruments.includes(s) && !(fam && (strategy.instruments.includes(fam.micro) || strategy.instruments.includes(fam.mini)))) {
      throw new Error(`symbols: ${strategy.name} trades ${strategy.instruments.join(', ')}, not ${s}`);
    }
  }
  return list.slice();
}

/**
 * @param cfg the parsed training config
 * @param baseDir where relative data paths resolve from (the config's folder)
 * @returns { env, meta } meta: what the bundle records about the env
 */
function envFromConfig(cfg, { root, baseDir, env = process.env, log = () => {}, hashData = true }) {
  if (!NAME.test(String(cfg.name || ''))) throw new Error('name: lowercase letters, digits, _ . -');
  if (typeof cfg.strategy !== 'string') throw new Error('strategy: the policy strategy to train (signal: policy), e.g. "prop_portfolio"');
  for (const k of ['account', 'strategies', 'gate']) {
    if (cfg[k] !== undefined) throw new Error(`${k}: comes from the policy strategy's STRATEGY.md (training always runs the harness rules)`);
  }
  const { strategy, components } = policyStrategy(root, cfg.strategy, env);
  const symbols = symbolsOf(cfg, strategy);
  // The engine scans a market with the rules strategies that trade its root (either leg of a family they list), as live does.
  for (const sym of symbols) {
    if (!components.some(c => tradesRoot(c, sym, [sym]))) throw new Error(`symbols: none of ${strategy.name}'s strategies scans ${sym} (their instruments list neither it nor the other leg of its family)`);
  }
  const contracts = cfg.contracts ?? strategy.contracts ?? 'auto';
  if (!CONTRACT_MODES.includes(contracts)) throw new Error(`contracts: ${CONTRACT_MODES.join(' | ')}`);
  const sizing = cfg.sizing ?? strategy.sizing ?? null;
  const raw = {
    symbols, timeframe: Number.parseInt(strategy.timeframe, 10), data: cfg.data, strategies: components.map(c => c.name), gate: true,
  };
  for (const k of ENGINE_KEYS) if (cfg[k] !== undefined) raw[k] = cfg[k];
  if (cfg.slippageTicks !== undefined && !(typeof cfg.slippageTicks === 'number' && Number.isFinite(cfg.slippageTicks) && cfg.slippageTicks >= ENGINE_DEFAULTS.slippageTicks)) {
    throw new Error(`slippageTicks: at least ${ENGINE_DEFAULTS.slippageTicks} (live fills); training on cheaper fills overstates the pass rate`);
  }
  if (cfg.fill !== undefined) throw new Error('fill: training always fills as live (the next bar\'s open)');
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
    strategy: strategy.name, components: names, strategies: names, account: account.name, symbols, timeframe: bt.timeframe,
    sizing, contracts, exit: strategy.exit, obsFields: observationFields(names),
    // The volume profile its observation reads (value_area, poc_dist), from the policy strategy's params.
    profile: optionsFromParams(strategy.params || {}),
    // The simulator it was trained and validated in.
    engine: { gate: true, sessions: bt.sessions, eodAt: bt.eodAt, slippageTicks: bt.slippageTicks, fill: bt.fill, earlyCloseDates: bt.earlyCloseDates, closedDates: bt.closedDates },
    data: markets.map(m => ({ symbol: m.symbol, file: path.basename(m.file), sha256: hashData ? fileHash(m.file) : null })),
  };
  return { env: e, meta };
}

module.exports = { envFromConfig, policyStrategy, symbolsOf, fileHash };
