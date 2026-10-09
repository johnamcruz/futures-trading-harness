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
const { PARAMS } = require('./market-snapshot');
const { parseWindows } = require('./clock');
const { normalizeBars } = require('./indicators');
const { compileRules, compileExpression } = require('./rules');
const { TAGS: REGIME_TAGS } = require('./regime');
const { createEvaluator, inSessions, exitPlan } = require('./evaluator');

const STATUSES = ['active', 'paper', 'disabled'];
// `rules` (declarative conditions in the frontmatter) or `manual` (the LLM judges the body).
const SIGNALS = ['rules', 'manual', 'policy'];
const FILTERS = {
  adx_min: v => typeof v === 'number' && v >= 0,
  adx_max: v => typeof v === 'number' && v >= 0,
  adx_slope_min: v => typeof v === 'number',
  max_vwap_distance_atr: v => typeof v === 'number' && v > 0,
};
const REQUIRED_SECTIONS = ['## When to Use', '## How It Works', '## Examples'];
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const TIMEFRAME = /^[1-9]\d*(m|h|d)$/;
const STOP = /^(atr:\d+(\.\d+)?|structure|swing|manual|strategy)$/;

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
const TOP_KEYS = ['name', 'description', 'version', 'status', 'instruments', 'timeframe', 'sessions', 'regimes', 'regime_gate', 'mtf',
  'signal', 'rules', 'connectors', 'params', 'filters', 'exit', 'risk', 'strategies', 'account', 'sizing', 'contracts', 'policy', 'source'];
/** Keys only a policy strategy (signal: policy) has: the prop challenge it trades and how. */
const POLICY_STRATEGY_KEYS = ['strategies', 'account', 'sizing', 'contracts', 'policy'];
const MTF_STYLES = require('./mtf').STYLES;
const CONTRACT_MODES = ['micro', 'mini', 'auto'];
const SIZING_KEYS = ['cushion_frac', 'cap_usd', 'clock_k', 'r_per_session', 'min_size_guard', 'drawdown_halve_usd'];
const POLICY_KEYS = ['bundle'];
/**
 * Data connectors a strategy can declare, like a skill declares its tools.
 *   order_flow: aggressor buy/sell volume per bar (series ofi, delta), from
 *               recorded flow files; without them, a bar-shape estimate
 */
const CONNECTORS = { order_flow: /\b(ofi|delta)\(/ };
const RISK_KEYS = ['stop', 'min_rr', 'max_risk_usd'];
const EXIT_KEYS = ['target_r', 'target', 'trail_activate_r', 'trail_giveback_r', 'max_bars'];
const MAX_FILE_BYTES = 256 * 1024;
const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

/** Allowed range for each market-snapshot parameter a strategy may override. */
const PARAM_RULES = {
  emaFast: 'int', emaSlow: 'int', adxPeriod: 'int', adxSlopeBars: 'int', stPeriod: 'int', kcLen: 'int', kcAtr: 'int',
  swingK: 'int', orbMinutes: 'int', atrStop: 'int',
  stMult: 'pos', kcMult: 'pos', stopAtrMult: 'pos',
  crtSweepBars: 'int', crtShiftBars: 'int', crtMaxDepth: 'pos', crtMinRangeAtr: 'nonneg', crtBufferAtr: 'nonneg', crtMinRR: 'pos',
  // Volume profile (prior_*, session_*, vp_*(n) series): rows or a row size in points, value area %, node detection %.
  vpRows: 'int', vpLookback: 'int', adrDays: 'int', vpRowSize: 'nonneg', vpValueArea: 'pos', vpNodePct: 'nonneg', vpTroughPct: 'nonneg', vpThreshold: 'nonneg',
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
  const legacy = ['orb', 'ema_cross', 'keltner', 'supertrend', 'bos', 'cisd_ote'].includes(data.signal);
  req(SIGNALS.includes(data.signal), legacy
    ? `signal: ${data.signal} is no longer a code detector; write the trigger as rules (copy the rules block from strategies/${data.signal}/STRATEGY.md)`
    : `signal: one of ${SIGNALS.join(', ')} (rules = conditions in the rules block; manual = the LLM evaluates the trigger from the body; policy = a trained policy trades other strategies' setups on a prop account)`);
  if (data.signal === 'rules') {
    errors.push(...compileRules(data.rules).errors);
  } else if (data.rules !== undefined) {
    errors.push('rules: only used with signal: rules');
  }
  // A policy strategy: the prop challenge as a strategy. It trades the setups
  // of other (rules) strategies on an account, sized from the cushion, with a
  // trained policy deciding which to take and when to bank a trade.
  if (data.signal === 'policy') {
    const list = data.strategies;
    req(Array.isArray(list) && list.length > 0 && list.every(n => typeof n === 'string' && NAME.test(n)) && new Set(list).size === list.length,
      'strategies: the rules strategies whose setups it trades, in priority order (e.g. [ema_cross, keltner])');
    req(typeof data.account === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(data.account), 'account: the prop account profile it trades (accounts/<name>/ACCOUNT.md), e.g. topstep_100k');
    if (data.sizing !== undefined) {
      const z = data.sizing;
      req(z && typeof z === 'object' && !Array.isArray(z) && Object.entries(z).every(([k, v]) => SIZING_KEYS.includes(k) && typeof v === 'number' && v >= 0),
        `sizing: a map of ${SIZING_KEYS.join(', ')} (numbers, 0 or more)`);
      req(!(z && z.cushion_frac > 1), 'sizing.cushion_frac: at most 1 (a trade never risks more than the whole cushion)');
    }
    req(data.contracts === undefined || CONTRACT_MODES.includes(data.contracts), `contracts: ${CONTRACT_MODES.join(' | ')} (auto: minis once the size reaches one mini)`);
    if (data.policy !== undefined) {
      const p = data.policy;
      req(p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).every(k => POLICY_KEYS.includes(k)) && typeof p.bundle === 'string' && /^[a-z0-9][a-z0-9_.-]*$/.test(p.bundle),
        'policy: { bundle: <name> } (models/<name>.json, shipped by rl/ship.py); without it the setups are taken as sized');
    }
    req(data.risk && data.risk.stop === 'strategy', "risk.stop: strategy (each setup keeps its own strategy's stop)");
    req(data.exit && data.exit.trail_activate_r !== undefined, 'exit: trail_activate_r and trail_giveback_r (past the ratchet the policy may bank the trade)');
    // Its setups come from other strategies' scans, which carry no target distance of its own.
    req(!(data.exit && data.exit.target !== undefined), 'exit.target: not for a policy strategy (its trades exit by its trail; the strategies it lists keep their own targets only when traded on their own)');
    req(data.connectors === undefined, 'connectors: declared by the strategies it trades, not here');
  } else {
    for (const k of POLICY_STRATEGY_KEYS) {
      if (data[k] !== undefined) errors.push(`${k}: only a policy strategy (signal: policy) trades an account; list this strategy in one (see strategies/prop_portfolio_3m)`);
    }
    if (data.risk && data.risk.stop === 'strategy') errors.push('risk.stop: strategy is only for a policy strategy');
  }
  const connectors = data.connectors === undefined ? [] : data.connectors;
  if (!Array.isArray(connectors) || !connectors.every(c => Object.keys(CONNECTORS).includes(c))) {
    errors.push(`connectors: a list of ${Object.keys(CONNECTORS).join(', ')}`);
  } else {
    const text = JSON.stringify([data.rules || {}, (data.risk && data.risk.stop) || '', (data.exit && data.exit.target) || '']);
    for (const [name, uses] of Object.entries(CONNECTORS)) {
      if (uses.test(text) && !connectors.includes(name)) errors.push(`connectors: the rules use ${name} data; declare connectors: [${name}]`);
    }
    // The initial balance and ADR need a bar at 09:30 ET: a timeframe that divides 30 minutes.
    const tf = /^(\d+)(m|h)$/.exec(String(data.timeframe || ''));
    const tfMin = tf ? Number(tf[1]) * (tf[2] === 'h' ? 60 : 1) : null;
    if (/\b(ib_high|ib_low|adr\()/.test(text) && tfMin && 30 % tfMin !== 0) errors.push(`rules: ib_high, ib_low and adr(n) need a timeframe that divides 30 minutes (a bar at 09:30 ET), not ${data.timeframe}`);
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
  // The multi-timeframe trend rule (mtf.js): trend strategies (the default) never enter against
  // the prevailing higher-timeframe trend; a reversal strategy may fade it.
  if (data.mtf !== undefined) {
    req(MTF_STYLES.includes(data.mtf), `mtf: ${MTF_STYLES.join(' | ')} (trend, the default: never against the prevailing 4h/1h/15m trend; reversal: may fade it)`);
    req(data.signal !== 'policy', 'mtf: a policy strategy takes it from each setup\'s own strategy');
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
    if (risk.stop && typeof risk.stop === 'object' && !Array.isArray(risk.stop)) {
      // A distance per side: { long: <expr>, short: <expr> } (a sweep strategy's stop sits beyond the swept extreme).
      const keys = Object.keys(risk.stop);
      if (keys.length !== 2 || !keys.includes('long') || !keys.includes('short')) errors.push('risk.stop: a map has exactly long and short, each a distance expression');
      for (const side of ['long', 'short']) {
        if (typeof risk.stop[side] !== 'string') { if (side in risk.stop) errors.push(`risk.stop.${side}: a distance expression`); continue; }
        try { compileExpression(risk.stop[side]); } catch (err) { errors.push(`risk.stop.${side}: a distance expression (${err.message})`); }
      }
    } else if (typeof risk.stop === 'string' && !STOP.test(risk.stop)) {
      // A stop distance written as a rules expression, e.g. "0.5 * atr(20)".
      try { compileExpression(risk.stop); } catch (err) { errors.push(`risk.stop: atr:<multiple above 0> | structure | swing | manual | a distance expression (${err.message})`); }
    } else {
      req(typeof risk.stop === 'string' && !/^atr:0+(\.0+)?$/.test(risk.stop), 'risk.stop: atr:<multiple above 0> | structure | swing | manual | a distance expression, e.g. 0.5 * atr(20)');
    }
    req(typeof risk.min_rr === 'number' && risk.min_rr > 0, 'risk.min_rr: a positive number');
    if (risk.max_risk_usd !== undefined) req(typeof risk.max_risk_usd === 'number' && risk.max_risk_usd > 0, 'risk.max_risk_usd: a positive number');
  }
  if (data.exit !== undefined) {
    const x = data.exit;
    if (!x || typeof x !== 'object' || Array.isArray(x)) {
      errors.push('exit: a map with target_r and/or trail_activate_r + trail_giveback_r');
    } else {
      for (const k of Object.keys(x)) if (!EXIT_KEYS.includes(k)) errors.push(`exit.${k}: unknown key${suggest(k, EXIT_KEYS)}`);
      for (const k of ['target_r', 'trail_activate_r', 'trail_giveback_r']) {
        if (x[k] !== undefined) req(typeof x[k] === 'number' && x[k] > 0 && x[k] <= 50, `exit.${k}: a number of R above 0`);
      }
      if (x.max_bars !== undefined) req(Number.isInteger(x.max_bars) && x.max_bars > 0, 'exit.max_bars: a whole number of bars');
      req((x.trail_activate_r === undefined) === (x.trail_giveback_r === undefined), 'exit: trail_activate_r and trail_giveback_r go together');
      if (x.target !== undefined) {
        // A target distance from the entry bar's close, written as an expression (e.g. crt_target(60): the far side of the range).
        const sides = x.target && typeof x.target === 'object' && !Array.isArray(x.target) ? x.target : null;
        if (sides && (Object.keys(sides).length !== 2 || typeof sides.long !== 'string' || typeof sides.short !== 'string')) {
          errors.push('exit.target: a distance expression, or a map with exactly long and short expressions');
        } else if (!sides && typeof x.target !== 'string') {
          errors.push('exit.target: a distance expression, e.g. crt_target(60)');
        } else {
          for (const [k, e] of Object.entries(sides || { '': x.target })) {
            try { compileExpression(e); } catch (err) { errors.push(`exit.target${k ? `.${k}` : ''}: ${err.message}`); }
          }
        }
        req(x.target_r === undefined, 'exit: target_r or target, not both');
      }
      req(x.target_r !== undefined || x.target !== undefined || x.trail_activate_r !== undefined, 'exit: needs target_r, target, or trail_activate_r and trail_giveback_r');
      if (x.target_r !== undefined && x.trail_activate_r !== undefined) {
        req(x.trail_activate_r < x.target_r, 'exit: with both, trail_activate_r must be below target_r (the target would fill first)');
      }
    }
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
  const ok = errors.length === 0;
  const compiledRules = parsed.data.signal === 'rules' && ok ? compileRules(parsed.data.rules).compiled : null;
  const stop = ok ? parsed.data.risk.stop : null;
  const perSide = stop && typeof stop === 'object';
  const compiledStop = !ok ? null
    : perSide ? { long: compileExpression(stop.long), short: compileExpression(stop.short) }
      : !STOP.test(stop) ? compileExpression(stop) : null;
  const tgt = ok && parsed.data.exit ? parsed.data.exit.target : undefined;
  const compiledTarget = tgt === undefined ? null
    : typeof tgt === 'string' ? compileExpression(tgt) : { long: compileExpression(tgt.long), short: compileExpression(tgt.short) };
  return { ...parsed.data, mtf: parsed.data.mtf || (parsed.data.signal === 'policy' ? undefined : 'trend'), name: folderName, file, body: parsed.body, compiledRules, compiledStop, compiledTarget, valid: ok, errors };
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
  // A policy strategy is valid only with valid rules strategies on its timeframe.
  for (const s of byName.values()) {
    if (!s.valid || s.signal !== 'policy') continue;
    const errs = [];
    for (const n of s.strategies) {
      const c = byName.get(n);
      if (!c) errs.push(`strategies: ${n} is not a strategy`);
      else if (!c.valid) errs.push(`strategies: ${n} is invalid (${c.errors[0]})`);
      else if (c.signal !== 'rules') errs.push(`strategies: ${n} is signal: ${c.signal}; a policy trades rules strategies only`);
      else if (c.timeframe !== s.timeframe) errs.push(`strategies: ${n} trades ${c.timeframe} bars, not ${s.timeframe}`);
      else if (c.status === 'disabled') errs.push(`strategies: ${n} is disabled; remove it from the list (the policy was trained on the list as it is)`);
    }
    // Every index the policy strategy trades must be scanned by at least one of its strategies (on the micro's bars).
    const { familyRoot } = require('./contracts');
    for (const r of s.instruments) {
      const ok = s.strategies.some(n => byName.get(n) && (byName.get(n).instruments || []).some(x => familyRoot(x) === familyRoot(r)));
      if (!ok) errs.push(`instruments: none of its strategies trades ${r}'s index (list its micro in their instruments)`);
    }
    if (errs.length) Object.assign(s, { valid: false, errors: errs });
  }
  return { strategies: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

/**
 * Evaluate every valid, non-disabled strategy for `symbol` on the last closed
 * bar. Mechanical strategies report fired/not fired with filter results;
 * manual strategies are listed for the LLM to evaluate from their Markdown
 * body. Sessions are checked at `now` (default: the last bar's close).
 */
function scan(strategies, bars, { symbol, now = null } = {}) {
  const root = String(symbol || '').toUpperCase();
  const norm = normalizeBars(bars);
  if (norm.length < 3) throw new Error(`need at least 3 bars, got ${norm.length}`);
  const ev = createEvaluator(norm);
  const results = [];
  for (const s of strategies) {
    if (!s.valid || s.status === 'disabled') continue;
    if (root && !s.instruments.includes(root)) continue;
    if (s.signal === 'policy') {
      results.push({ name: s.name, status: s.status, signal: 'policy', candidate: false, note: `a policy strategy: the runner screens the setups of ${s.strategies.join(', ')}` });
      continue;
    }
    try {
      results.push(ev.at(s, norm.length - 1, { now, describe: true }));
    } catch (err) {
      // One broken strategy must not stop the others from being scanned.
      results.push({ name: s.name, status: s.status, error: err.message, candidate: false });
    }
  }
  return withConfluence(results);
}

/**
 * What fired on each of the last `count` closed bars (oldest first): for skip
 * rules about recent signals ("ofi_absorption fired the other way in the last
 * 5 bars"). Each bar is judged as the live scan judged it at its close
 * (causal: one evaluator, bar i sees bars 0..i).
 */
function recentSignals(strategies, bars, { symbol, count = 5 } = {}) {
  const root = String(symbol || '').toUpperCase();
  const norm = normalizeBars(bars);
  const ev = createEvaluator(norm);
  const usable = strategies.filter(s => s.valid && s.status !== 'disabled' && s.signal === 'rules' && (!root || s.instruments.includes(root)));
  const out = [];
  for (let i = Math.max(0, norm.length - count); i < norm.length; i += 1) {
    const fired = [];
    for (const s of usable) {
      try {
        const r = ev.at(s, i, { describe: false });
        if (r.candidate && r.direction) fired.push(`${s.name} ${r.direction}`);
      } catch (_err) {
        // one broken strategy doesn't hide the others
      }
    }
    out.push({ bar: norm[i].t, fired });
  }
  return out;
}

/**
 * Confluence: for every strategy that fired, the other strategies on its
 * timeframe that fired the same way (`with`) and the other way (`against`)
 * on the same bar.
 */
function withConfluence(results) {
  const fired = results.filter(r => r.candidate && r.direction);
  return results.map(r => (r.candidate && r.direction ? {
    ...r,
    confluence: {
      with: fired.filter(o => o !== r && o.timeframe === r.timeframe && o.direction === r.direction).map(o => o.name),
      against: fired.filter(o => o !== r && o.timeframe === r.timeframe && o.direction !== r.direction).map(o => o.name),
    },
  } : r));
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
  exitPlan,
  STATUSES,
  SIGNALS,
  CONNECTORS,
  FILTERS,
  strategyDirs,
  validateStrategy,
  loadStrategyFile,
  loadStrategies,
  scan,
  checkStrategyForOrder,
 recentSignals };
