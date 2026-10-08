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
const { PARAMS, snapshot, levels } = require('./market-snapshot');
const { normalizeBars } = require('./indicators');
const { compileRules, evaluateRules } = require('./rules');

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
const TIMEFRAME = /^\d+(m|h|d)$/;
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
function validateStrategy(data, body, folderName) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };

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
  if (data.filters !== undefined && data.filters !== null) {
    if (typeof data.filters !== 'object' || Array.isArray(data.filters)) {
      errors.push('filters: a map');
    } else {
      for (const [k, v] of Object.entries(data.filters)) {
        if (!FILTERS[k]) errors.push(`filters.${k}: unknown filter (known: ${Object.keys(FILTERS).join(', ')})`);
        else if (!FILTERS[k](v)) errors.push(`filters.${k}: invalid value ${JSON.stringify(v)}`);
      }
    }
  }
  if (data.params !== undefined && data.params !== null) {
    if (typeof data.params !== 'object' || Array.isArray(data.params)) {
      errors.push('params: a map of market-snapshot parameters');
    } else {
      for (const [k, v] of Object.entries(data.params)) {
        if (!(k in PARAMS)) errors.push(`params.${k}: unknown snapshot parameter`);
        else if (typeof v !== 'number') errors.push(`params.${k}: must be a number`);
      }
    }
  }
  const risk = data.risk;
  if (!risk || typeof risk !== 'object' || Array.isArray(risk)) {
    errors.push('risk: a map with stop and min_rr');
  } else {
    req(typeof risk.stop === 'string' && STOP.test(risk.stop), 'risk.stop: atr:<multiple> | structure | swing | manual');
    req(typeof risk.min_rr === 'number' && risk.min_rr > 0, 'risk.min_rr: a positive number');
    if (risk.max_risk_usd !== undefined) req(typeof risk.max_risk_usd === 'number' && risk.max_risk_usd > 0, 'risk.max_risk_usd: a positive number');
  }
  for (const h of REQUIRED_SECTIONS) req(body.includes(h), `body: missing section "${h}"`);
  return errors;
}

function loadStrategyFile(file) {
  const folderName = path.basename(path.dirname(file));
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
    for (const d of entries.filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))) {
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
  for (const s of strategies) {
    if (!s.valid || s.status === 'disabled') continue;
    if (root && !s.instruments.includes(root)) continue;
    const snap = snapshot(bars, s.params || {});
    const at = now || new Date(snap.last.t);
    const session = inSessions(s, at);
    const base = { name: s.name, status: s.status, timeframe: s.timeframe, inSession: session };
    if (s.signal === 'manual') {
      results.push({ ...base, signal: 'manual', candidate: session, note: 'evaluate the trigger from STRATEGY.md' });
      continue;
    }
    let direction;
    let ruleDetail;
    if (s.signal === 'rules') {
      const norm = normalizeBars(bars);
      const r = evaluateRules(s.compiledRules, norm, { ...PARAMS, ...(s.params || {}) }, levels(norm));
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
      candidate: Boolean(direction) && session && fails.length === 0,
      entryRef: snap.last.c,
      stopDistance: stopDistance === null ? null : Math.round(stopDistance * 1e4) / 1e4,
      minRR: s.risk.min_rr,
      ...(ruleDetail ? { rules: ruleDetail } : {}),
    });
  }
  return results;
}

/** Order-gate view: is `name` a tradable strategy for this contract right now? Returns an error message or null. */
function checkStrategyForOrder(strategies, name, contractRoot, now) {
  const s = strategies.find(x => x.name === name);
  if (!s) return `setup:${name} is not a known strategy. Add strategies/${name}/STRATEGY.md or use an existing setup tag.`;
  if (!s.valid) return `strategies/${name}/STRATEGY.md is invalid (${s.errors[0]}). Fix it before trading it.`;
  if (s.status !== 'active') return `setup:${name} has status "${s.status}"; only active strategies may place live entries.`;
  if (!s.instruments.includes(contractRoot)) return `setup:${name} does not trade ${contractRoot} (instruments: ${s.instruments.join(', ')}).`;
  if (!inSessions(s, now)) return `setup:${name} is outside its sessions (${s.sessions.join(', ')}).`;
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
