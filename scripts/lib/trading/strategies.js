'use strict';

/**
 * Strategy registry. A strategy is a folder with a STRATEGY.md file: YAML
 * frontmatter the code checks (instruments, sessions, signal, filters, risk,
 * status) plus a Markdown body the LLM follows (thesis, context, trigger,
 * management, skip rules). Adding a strategy means adding a Markdown file.
 *
 * Search path: <plugin>/strategies, then each directory in FTH_STRATEGIES_DIRS
 * (comma-separated, e.g. ~/.futures-trading-harness/strategies). A later
 * directory may not redefine an existing name.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFrontmatter } = require('../frontmatter');
const { parseWindows, inWindow } = require('./clock');
const { PARAMS, snapshot } = require('./market-snapshot');
const { normalizeBars } = require('./indicators');
const { compileRules, evaluateRules } = require('./rules');
const { TAGS: REGIME_TAGS, classifyRegime, regimeFits } = require('./regime');

const STATUSES = ['active', 'paper', 'disabled'];
// Built-in detectors, `rules` (declarative conditions in the frontmatter), or `manual` (the LLM judges the body).
const SIGNALS = ['orb', 'ema_cross', 'keltner', 'supertrend', 'bos', 'rules', 'manual'];
const BUILT_IN_SIGNALS = SIGNALS.filter(s => s !== 'rules' && s !== 'manual');
const FILTERS = {
  adx_min: v => typeof v === 'number' && v >= 0,
  adx_max: v => typeof v === 'number' && v >= 0,
  adx_slope_min: v => typeof v === 'number',
  max_vwap_distance_atr: v => typeof v === 'number' && v > 0,
};
const REQUIRED_SECTIONS = ['## When to Use', '## How It Works', '## Examples'];
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const TIMEFRAME = /^[1-9]\d*(m|h|d)$/;
const STOP = /^(atr:\d+(\.\d+)?|structure|swing|manual)$/;

function expandHome(p) {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function strategyDirs(pluginRoot, env = process.env) {
  const extra = String(env.FTH_STRATEGIES_DIRS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(expandHome);
  return [path.join(pluginRoot, 'strategies'), ...extra];
}

/** Validate parsed frontmatter + body. Returns a list of problems (empty = valid). */
const TOP_KEYS = ['name', 'description', 'version', 'status', 'instruments', 'timeframe', 'sessions', 'regimes', 'regime_gate',
  'signal', 'rules', 'params', 'filters', 'risk', 'source'];
const RISK_KEYS = ['stop', 'min_rr', 'max_risk_usd'];
const MAX_FILE_BYTES = 256 * 1024;
const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

/** Allowed range for each market-snapshot parameter a strategy may override. */
const PARAM_RULES = {
  emaFast: 'int', emaSlow: 'int', adxPeriod: 'int', adxSlopeBars: 'int', stPeriod: 'int', kcLen: 'int', kcAtr: 'int',
  swingK: 'int', orbMinutes: 'int', atrStop: 'int',
  stMult: 'pos', kcMult: 'pos', stopAtrMult: 'pos',
  adxGate: 'nonneg', kcAdx: 'nonneg', orbAdx: 'nonneg', orbCloseMin: 'minute',
};

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

function suggest(key, known) {
  const close = known.find(k => editDistance(key.toLowerCase(), k.toLowerCase()) <= 2);
  return close ? ` (did you mean ${close}?)` : '';
}

function validateStrategy(data, body, folderName) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };
  for (const k of Object.keys(data)) {
    if (!TOP_KEYS.includes(k)) errors.push(`unknown key "${k}"${suggest(k, TOP_KEYS)}`);
  }

  req(typeof data.name === 'string' && NAME.test(data.name), 'name: lowercase letters, digits, _ or - (it is the journal tag setup:<name>)');
  req(data.name === folderName, `name "${data.name}" must match its folder "${folderName}"`);
  req(typeof data.description === 'string' && data.description.length >= 40, 'description: at least 40 characters, saying what the strategy trades and when');
  req(STATUSES.includes(data.status), `status: one of ${STATUSES.join(', ')}`);
  req(Array.isArray(data.instruments) && data.instruments.length > 0
    && data.instruments.every(s => typeof s === 'string' && /^[A-Z0-9]+$/.test(s)), 'instruments: list of contract roots, e.g. [MNQ, MES]');
  req(typeof data.timeframe === 'string' && TIMEFRAME.test(data.timeframe), 'timeframe: e.g. 3m, 15m, 1h');
  req(SIGNALS.includes(data.signal), `signal: one of ${SIGNALS.join(', ')} (rules = conditions in the rules block; manual = the LLM evaluates the trigger from the body)`);
  if (data.signal === 'rules') {
    errors.push(...compileRules(data.rules).errors);
  } else if (data.rules !== undefined) {
    errors.push('rules: only used with signal: rules');
  }

  if (data.sessions !== undefined && data.sessions !== null) {
    const list = Array.isArray(data.sessions) ? data.sessions : [];
    const { errors: bad } = parseWindows(list.join(','));
    req(Array.isArray(data.sessions) && list.length > 0 && bad.length === 0,
      `sessions: list of "HH:MM-HH:MM@Time/Zone" windows${bad.length ? ` (invalid: ${bad.join(', ')})` : ''}`);
  }
  if (data.regimes !== undefined && data.regimes !== null) {
    req(Array.isArray(data.regimes) && data.regimes.length > 0 && data.regimes.every(r => REGIME_TAGS.includes(r)),
      `regimes: a list of ${REGIME_TAGS.join(', ')}`);
  }
  if (data.regime_gate !== undefined) {
    req(typeof data.regime_gate === 'boolean', 'regime_gate: true or false');
    req(data.regime_gate !== true || Array.isArray(data.regimes), 'regime_gate: needs a regimes list');
  }
  if (data.filters !== undefined && data.filters !== null) {
    if (typeof data.filters !== 'object' || Array.isArray(data.filters)) {
      errors.push('filters: a map');
    } else {
      for (const [k, v] of Object.entries(data.filters)) {
        if (!has(FILTERS, k)) errors.push(`filters.${k}: unknown filter (known: ${Object.keys(FILTERS).join(', ')})`);
        else if (!FILTERS[k](v)) errors.push(`filters.${k}: invalid value ${JSON.stringify(v)}`);
      }
    }
  }
  if (data.params !== undefined && data.params !== null) {
    if (typeof data.params !== 'object' || Array.isArray(data.params)) {
      errors.push('params: a map of market-snapshot parameters');
    } else {
      for (const [k, v] of Object.entries(data.params)) {
        const rule = has(PARAM_RULES, k) && has(PARAMS, k) ? PARAM_RULES[k] : null;
        if (!rule) errors.push(`params.${k}: unknown snapshot parameter${suggest(k, Object.keys(PARAM_RULES))}`);
        else if (rule === 'int' && !(Number.isInteger(v) && v >= 1 && v <= 500)) errors.push(`params.${k}: a whole number from 1 to 500`);
        else if (rule === 'pos' && !(typeof v === 'number' && v > 0 && v <= 100)) errors.push(`params.${k}: a number above 0`);
        else if (rule === 'nonneg' && !(typeof v === 'number' && v >= 0 && v <= 100)) errors.push(`params.${k}: a number from 0 to 100`);
        else if (rule === 'minute' && !(Number.isInteger(v) && v >= 0 && v <= 1440)) errors.push(`params.${k}: minutes after midnight, 0 to 1440`);
      }
    }
  }
  const risk = data.risk;
  if (!risk || typeof risk !== 'object' || Array.isArray(risk)) {
    errors.push('risk: a map with stop and min_rr');
  } else {
    for (const k of Object.keys(risk)) if (!RISK_KEYS.includes(k)) errors.push(`risk.${k}: unknown key${suggest(k, RISK_KEYS)}`);
    req(typeof risk.stop === 'string' && STOP.test(risk.stop) && !/^atr:0+(\.0+)?$/.test(risk.stop), 'risk.stop: atr:<multiple above 0> | structure | swing | manual');
    req(typeof risk.min_rr === 'number' && risk.min_rr > 0, 'risk.min_rr: a positive number');
    if (risk.max_risk_usd !== undefined) req(typeof risk.max_risk_usd === 'number' && risk.max_risk_usd > 0, 'risk.max_risk_usd: a positive number');
  }
  for (const h of REQUIRED_SECTIONS) req(body.includes(h), `body: missing section "${h}"`);
  return errors;
}

function loadStrategyFile(file) {
  const folderName = path.basename(path.dirname(file));
  if (fs.statSync(file).size > MAX_FILE_BYTES) {
    return { name: folderName, file, valid: false, errors: [`file is larger than ${MAX_FILE_BYTES / 1024} KB`] };
  }
  const text = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (err) {
    return { name: folderName, file, valid: false, errors: [err.message] };
  }
  const errors = validateStrategy(parsed.data, parsed.body, folderName);
  const compiledRules = parsed.data.signal === 'rules' && errors.length === 0 ? compileRules(parsed.data.rules).compiled : null;
  return { ...parsed.data, name: folderName, file, body: parsed.body, compiledRules, valid: errors.length === 0, errors };
}

/** Load every strategy from the search path. Folders starting with _ (templates) are skipped. */
function loadStrategies(pluginRoot, env = process.env) {
  const byName = new Map();
  const problems = [];
  for (const dir of strategyDirs(pluginRoot, env)) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') problems.push({ dir, error: err.message });
      continue;
    }
    const isDir = e => e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch (_err) { return false; } })());
    for (const d of entries.filter(e => isDir(e) && !e.name.startsWith('_') && !e.name.startsWith('.'))) {
      const file = path.join(dir, d.name, 'STRATEGY.md');
      if (!fs.existsSync(file)) continue;
      const s = loadStrategyFile(file);
      if (byName.has(s.name)) {
        problems.push({ dir, error: `duplicate strategy "${s.name}" ignored (first defined in ${byName.get(s.name).file})` });
        continue;
      }
      byName.set(s.name, s);
    }
  }
  return { strategies: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

function filterFailures(strategy, snap) {
  const f = strategy.filters || {};
  const fails = [];
  const adx = snap.trend.adx;
  if (f.adx_min !== undefined && !(adx !== null && adx >= f.adx_min)) fails.push(`ADX ${adx} < ${f.adx_min}`);
  if (f.adx_max !== undefined && !(adx !== null && adx <= f.adx_max)) fails.push(`ADX ${adx} > ${f.adx_max}`);
  if (f.adx_slope_min !== undefined && !(snap.trend.adxSlope !== null && snap.trend.adxSlope >= f.adx_slope_min)) {
    fails.push(`ADX slope ${snap.trend.adxSlope} < ${f.adx_slope_min}`);
  }
  if (f.max_vwap_distance_atr !== undefined) {
    const vwap = snap.levels.vwapRth ?? snap.levels.vwapSession;
    const atr = snap.volatility.atr14;
    const dist = vwap !== null && atr ? Math.abs(snap.last.c - vwap) / atr : null;
    if (dist === null || dist > f.max_vwap_distance_atr) fails.push(`VWAP distance ${dist === null ? 'unknown' : dist.toFixed(2)} ATR > ${f.max_vwap_distance_atr}`);
  }
  return fails;
}

function inSessions(strategy, now) {
  if (!Array.isArray(strategy.sessions) || strategy.sessions.length === 0) return true;
  return parseWindows(strategy.sessions.join(',')).windows.some(w => inWindow(now, w));
}

/**
 * Evaluate every valid, non-disabled strategy for `symbol` against bars.
 * Mechanical strategies report fired/not fired with filter results; manual
 * strategies are listed for the LLM to evaluate from their Markdown body.
 */
function scan(strategies, bars, { symbol, now = null } = {}) {
  const root = String(symbol || '').toUpperCase();
  const results = [];
  const regime = classifyRegime(normalizeBars(bars));
  const scanOne = s => {
    if (!s.valid || s.status === 'disabled') return;
    if (root && !s.instruments.includes(root)) return;
    const snap = snapshot(bars, s.params || {});
    const at = now || new Date(snap.last.t);
    const session = inSessions(s, at);
    const inRegime = regimeFits(s.regimes, regime);
    const base = {
      name: s.name, status: s.status, timeframe: s.timeframe, inSession: session,
      regime: regime ? regime.primary : null, regimes: s.regimes || null, inRegime,
    };
    if (s.signal === 'manual') {
      results.push({ ...base, signal: 'manual', candidate: session && inRegime, note: 'evaluate the trigger from STRATEGY.md' });
      return;
    }
    let direction;
    let ruleDetail;
    if (s.signal === 'rules') {
      const norm = normalizeBars(bars);
      const r = evaluateRules(s.compiledRules, norm, { ...PARAMS, ...(s.params || {}) });
      direction = r.direction;
      ruleDetail = { long: r.long, short: r.short };
    } else {
      direction = snap.signals[s.signal];
    }
    const fails = filterFailures(s, snap);
    const atrMult = /^atr:(.+)$/.exec(s.risk.stop);
    const atr20 = snap.volatility.atr20;
    const stopDistance = atrMult && atr20 ? Number(atrMult[1]) * atr20 : null;
    results.push({
      ...base,
      signal: s.signal,
      direction: direction || null,
      filtersFailed: fails,
      candidate: Boolean(direction) && session && inRegime && fails.length === 0,
      entryRef: snap.last.c,
      stopDistance: stopDistance === null ? null : Math.round(stopDistance * 1e4) / 1e4,
      minRR: s.risk.min_rr,
      ...(ruleDetail ? { rules: ruleDetail } : {}),
    });
  };
  for (const s of strategies) {
    try {
      scanOne(s);
    } catch (err) {
      // One broken strategy must not stop the others from being scanned.
      results.push({ name: s.name, status: s.status, error: err.message, candidate: false });
    }
  }
  return results;
}

/** Order-gate view: is `name` a tradable strategy for this contract right now? Returns an error message or null. */
function checkStrategyForOrder(strategies, name, contractRoot, now, side = null) {
  const s = strategies.find(x => x.name === name);
  if (!s) return `setup:${name} is not a known strategy. Add strategies/${name}/STRATEGY.md or use an existing setup tag.`;
  if (!s.valid) return `strategies/${name}/STRATEGY.md is invalid (${s.errors[0]}). Fix it before trading it.`;
  if (s.status !== 'active') return `setup:${name} has status "${s.status}"; only active strategies may place live entries.`;
  if (!s.instruments.includes(contractRoot)) return `setup:${name} does not trade ${contractRoot} (instruments: ${s.instruments.join(', ')}).`;
  if (!inSessions(s, now)) return `setup:${name} is outside its sessions (${s.sessions.join(', ')}).`;
  const sideName = String(side === null || side === undefined ? '' : side).toLowerCase();
  if (s.compiledRules && (sideName === 'buy' || sideName === 'sell')) {
    const dir = sideName === 'buy' ? 'long' : 'short';
    if (!s.compiledRules[dir].length) return `setup:${name} has no ${dir} rules, so it can't ${sideName} to enter.`;
  }
  return null;
}

module.exports = {
  STATUSES,
  SIGNALS,
  BUILT_IN_SIGNALS,
  FILTERS,
  strategyDirs,
  validateStrategy,
  loadStrategyFile,
  loadStrategies,
  scan,
  checkStrategyForOrder,
};
