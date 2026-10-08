'use strict';

/**
 * Policy bundles: `models/<name>.json` (and folders in FTH_MODELS_DIRS),
 * trained in Python (rl/fth_rl/train.py). A bundle is refused unless it
 * matches the observation and actions this harness builds today, so a
 * decision never feeds a policy inputs it wasn't trained on.
 *
 * Live trading also requires a validated bundle: out of sample, zero blows
 * in every month (no exceptions) and a pass rate of at least
 * PROMOTION_GATE.minPassRate. The backtester can load an unvalidated
 * candidate for research.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPolicy } = require('./policy-net');
const { observationFields } = require('./observation');
const { familyOf } = require('../trading/contracts');
const { timeframeMs } = require('../trading/evaluator');
const { exitPlan } = require('../trading/strategies');
const { ACTIONS, MASKS } = require('./challenge-env');
const { DEFAULT_SIZING } = require('../trading/combine');

const BUNDLE_FORMAT = 'fth-policy';
const BUNDLE_VERSION = 3;
/** The bar a policy must clear out of sample. Zero blows is not configurable. */
const PROMOTION_GATE = Object.freeze({ minPassRate: 0.4, maxBlows: 0, minAttempts: 20, minMonths: 2 });

const NAME = /^[a-z0-9][a-z0-9_.-]*$/;
const expandHome = p => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

function modelDirs(pluginRoot, env = process.env) {
  const extra = String(env.FTH_MODELS_DIRS || '').split(',').map(s => s.trim()).filter(Boolean).map(expandHome);
  return [path.join(pluginRoot, 'models'), ...extra];
}

/** Path of bundle `name`, or null. */
function bundlePath(pluginRoot, name, env = process.env) {
  if (!NAME.test(String(name || ''))) return null;
  for (const dir of modelDirs(pluginRoot, env)) {
    const file = path.join(dir, `${name}.json`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Why an out-of-sample result fails the promotion gate (empty = passes):
 * any blow in any month, or a pass rate under the gate's minimum.
 */
function gateFailures(oos, minPassRate = PROMOTION_GATE.minPassRate, minWinRate = 0) {
  const G = PROMOTION_GATE;
  const whole = x => Number.isInteger(x) && x >= 0;
  if (!oos || typeof oos !== 'object' || !whole(oos.attempts) || !whole(oos.passed) || !whole(oos.blown) || !oos.months || typeof oos.months !== 'object' || Array.isArray(oos.months)) {
    return ['the out-of-sample result is missing or malformed'];
  }
  const out = [];
  const months = Object.entries(oos.months);
  if (oos.attempts < G.minAttempts || months.length < G.minMonths) {
    out.push(`too small an out-of-sample test (${oos.attempts} attempts over ${months.length} month(s); at least ${G.minAttempts} over ${G.minMonths})`);
  }
  if (months.some(([, m]) => !m || !whole(m.blown))) out.push('a month of the out-of-sample result has no blow count');
  const blownMonths = months.filter(([, m]) => m && m.blown > G.maxBlows).map(([k]) => k);
  if (oos.blown > G.maxBlows || blownMonths.length) out.push(`blows out of sample (${oos.blown}${blownMonths.length ? ` in ${blownMonths.join(', ')}` : ''}); zero blows is the rule`);
  // The exact rate, not the rounded one: 0.3996 is not 0.40.
  const floor = Math.max(G.minPassRate, minPassRate || 0);
  const rate = oos.attempts ? oos.passed / oos.attempts : 0;
  if (!(rate >= floor)) out.push(`pass rate ${Math.floor(rate * 1000) / 1000} (${oos.passed}/${oos.attempts}) is under ${floor}`);
  // An optional win-rate floor (the bundle's own gate may set one; it is never below what it says).
  if (minWinRate > 0) {
    const winRate = whole(oos.trades) && whole(oos.wins) && oos.trades > 0 ? oos.wins / oos.trades : NaN;
    if (!(winRate >= minWinRate)) out.push(`win rate ${Number.isFinite(winRate) ? Math.floor(winRate * 1000) / 1000 : 'unknown'} is under ${minWinRate}`);
  }
  return out;
}

const sizingOf = z => JSON.stringify(Object.fromEntries(Object.entries({ ...DEFAULT_SIZING, ...(z || {}) }).sort()));

/**
 * Why a bundle can't decide for this policy strategy, or null: it was trained
 * and validated for one policy strategy (its strategies, in order), account,
 * index (micro/mini family), timeframe, sizing, and contract mode, and its
 * gate result means nothing for another.
 */
function bundleMismatch(meta, strategy, symbolRoot = null) {
  if (meta.strategy !== strategy.name) return `was trained for ${meta.strategy}, not ${strategy.name}`;
  if (JSON.stringify(meta.components) !== JSON.stringify(strategy.strategies)) return `was trained on ${(meta.components || []).join(', ')}, not ${(strategy.strategies || []).join(', ')}`;
  if (meta.account !== strategy.account) return `was trained for account ${meta.account}, not ${strategy.account}`;
  const fam = r => (familyOf(r) ? familyOf(r).micro : r);
  if (symbolRoot && meta.symbol && fam(meta.symbol) !== fam(symbolRoot)) return `was trained on ${meta.symbol}, not ${symbolRoot}`;
  if (strategy.timeframe && meta.timeframe && timeframeMs(strategy.timeframe) !== meta.timeframe * 60000) return `was trained on ${meta.timeframe}m bars, not ${strategy.timeframe}`;
  if (sizingOf(meta.sizing) !== sizingOf(strategy.sizing)) return `was trained with sizing ${sizingOf(meta.sizing)}, not the strategy's ${sizingOf(strategy.sizing)}`;
  if ((meta.contracts || 'auto') !== (strategy.contracts || 'auto')) return `was trained with contracts: ${meta.contracts || 'auto'}, not ${strategy.contracts || 'auto'}`;
  // The ratchet decides when the policy is asked in a trade: an edited exit is a state it never saw.
  if (JSON.stringify(exitPlan({ exit: meta.exit })) !== JSON.stringify(exitPlan(strategy))) return `was trained with exit ${JSON.stringify(meta.exit || null)}, not the strategy's ${JSON.stringify(strategy.exit || null)}`;
  return null;
}

/** Problems with a parsed bundle (empty = usable). */
function checkBundle(b, { requireValidated = true } = {}) {
  const errors = [];
  if (!b || typeof b !== 'object') return ['not a JSON object'];
  if (b.format !== BUNDLE_FORMAT) errors.push(`format: expected "${BUNDLE_FORMAT}"`);
  if (b.version !== BUNDLE_VERSION) errors.push(`version: expected ${BUNDLE_VERSION}; retrain it`);
  if (typeof b.strategy !== 'string' || !Array.isArray(b.components) || !b.components.length) {
    errors.push('strategy, components: the policy strategy it was trained for and its strategies');
  } else if (JSON.stringify(b.obsFields) !== JSON.stringify(observationFields(b.components))) {
    errors.push('obsFields: the bundle was trained on a different observation than this harness builds; retrain it');
  }
  if (JSON.stringify(b.actions) !== JSON.stringify(ACTIONS)) errors.push('actions: the bundle has different actions; retrain it');
  if (typeof b.account !== 'string') errors.push('account: the account profile it was trained for');
  if (!Array.isArray(b.strategies) || !b.strategies.length) errors.push('strategies: the strategies it was trained on');
  try {
    loadPolicy(b.network || {});
    if (Array.isArray(b.obsFields) && b.network.obsDim !== b.obsFields.length) errors.push(`network: ${b.network.obsDim} inputs for ${b.obsFields.length} observation fields`);
  } catch (err) {
    errors.push(`network: ${err.message}`);
  }
  if (requireValidated) {
    const fails = gateFailures(b.oos, b.gate && b.gate.minPassRate, (b.gate && b.gate.minWinRate) || 0);
    if (b.validated !== true || fails.length) errors.push(`not validated out of sample${fails.length ? `: ${fails.join('; ')}` : ''}`);
  }
  return errors;
}

/**
 * Load and check bundle `name`. Returns { file, meta, policy, decide(kind, obs) };
 * throws with the reason. requireValidated: false only for backtests.
 */
function loadBundle(pluginRoot, name, env = process.env, { requireValidated = true } = {}) {
  const file = bundlePath(pluginRoot, name, env);
  if (!file) throw new Error(`policy bundle "${name}" not found (models/${name}.json)`);
  let b;
  try {
    b = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`policy bundle "${name}" is not valid JSON (${err.message})`, { cause: err });
  }
  const errors = checkBundle(b, { requireValidated });
  if (errors.length) throw new Error(`policy bundle "${name}" is unusable: ${errors.join('; ')}`);
  const policy = loadPolicy(b.network);
  const { network: _network, ...meta } = b;
  return {
    file,
    meta,
    policy,
    decide(kind, obs) {
      if (!MASKS[kind]) throw new Error(`unknown decision kind "${kind}"`);
      return ACTIONS[kind][policy.act(obs, MASKS[kind])];
    },
  };
}

module.exports = { BUNDLE_FORMAT, BUNDLE_VERSION, PROMOTION_GATE, modelDirs, bundlePath, gateFailures, bundleMismatch, checkBundle, loadBundle };
