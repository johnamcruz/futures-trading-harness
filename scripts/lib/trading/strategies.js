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
 *
 * A policy strategy takes its `sizing`, `exit` and `multipliers` from its account's
 * rulebook (accounts/<account>/RULEBOOK.md, `policies.<name>`; trading/rulebook.js) and
 * may not state them itself (R1, one place). One its account's rulebook doesn't list, or
 * whose rulebook is missing or doesn't load, is invalid.
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
const { familyOf, selectedLeg } = require('./contracts');
const rulebook = require('./rulebook');
const { accountDirs } = require('./accounts');

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
// Strategies removed from the repository (strategies/README.md, "Retired strategies"): a name here that no strategy
// folder defines is refused as retired, saying so, wherever an old record, config or document still names it.
const RETIRED = { bos: '2026-10-13', keltner: '2026-10-13', ema_cross: '2026-10-13', supertrend: '2026-10-13' };
/** " (retired on <date>: strategies/README.md, \"Retired strategies\")" for a retired name, else "". */
const retiredNote = name => (Object.hasOwn(RETIRED, name) ? ` (retired on ${RETIRED[name]}: strategies/README.md, "Retired strategies")` : '');

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
  'signal', 'rules', 'params', 'filters', 'exit', 'risk', 'strategies', 'account', 'sizing', 'contracts', 'priority', 'source'];
/** Keys only a policy strategy (signal: policy) has: the prop challenge it trades and how. */
const POLICY_STRATEGY_KEYS = ['strategies', 'account', 'sizing', 'contracts'];
const MTF_STYLES = require('./mtf').STYLES;
const CONTRACT_MODES = ['micro', 'mini', 'auto'];
const SIZING_KEYS = ['cushion_frac', 'cap_usd', 'clock_k', 'r_per_session', 'min_size_guard', 'drawdown_halve_usd', 'stop_slippage_ticks'];
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

/** Problems with an exit block (a strategy's, a rulebook's, or a remembered one: trading/exit-memory.js). */
function exitErrors(x) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };
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
  return errors;
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
  const legacy = ['orb', 'cisd_ote', ...Object.keys(RETIRED)].includes(data.signal);
  req(SIGNALS.includes(data.signal), legacy
    ? `signal: ${data.signal} is no longer a code detector; write the trigger as rules (${Object.hasOwn(RETIRED, data.signal)
      ? `the ${data.signal} strategy was retired on ${RETIRED[data.signal]}: its rules block is in the repository's history, strategies/README.md says why`
      : `copy the rules block from strategies/${data.signal}/STRATEGY.md`})`
    : `signal: one of ${SIGNALS.join(', ')} (rules = conditions in the rules block; manual = the LLM evaluates the trigger from the body; policy = a prop-challenge strategy trades other strategies' setups on a prop account, sized from its budget)`);
  if (data.signal === 'rules') {
    errors.push(...compileRules(data.rules).errors);
  } else if (data.rules !== undefined) {
    errors.push('rules: only used with signal: rules');
  }
  // A policy strategy: the prop challenge as a strategy. It trades the setups
  // of other (rules) strategies on an account, each sized from the cushion (or
  // skipped), and exits every trade by its own trail.
  if (data.signal === 'policy') {
    const list = data.strategies;
    req(Array.isArray(list) && list.length > 0 && list.every(n => typeof n === 'string' && NAME.test(n)) && new Set(list).size === list.length,
      'strategies: the rules strategies whose setups it trades, in priority order (e.g. [orb, cisd_ote])');
    req(typeof data.account === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(data.account), 'account: the prop account profile it trades (accounts/<name>/ACCOUNT.md)');
    if (data.sizing !== undefined) {
      const z = data.sizing;
      req(z && typeof z === 'object' && !Array.isArray(z) && Object.entries(z).every(([k, v]) => SIZING_KEYS.includes(k) && typeof v === 'number' && v >= 0),
        `sizing: a map of ${SIZING_KEYS.join(', ')} (numbers, 0 or more)`);
      req(!(z && z.cushion_frac > 1), 'sizing.cushion_frac: at most 1 (a trade never risks more than the whole cushion)');
      req(!(z && z.stop_slippage_ticks !== undefined && z.stop_slippage_ticks < 1), 'sizing.stop_slippage_ticks: at least 1 (the backtester\'s fill slippage; sizing never counts less)');
    }
    req(data.contracts === undefined || CONTRACT_MODES.includes(data.contracts), `contracts: ${CONTRACT_MODES.join(' | ')} (auto: minis once the size reaches one mini)`);
    req(data.risk && data.risk.stop === 'strategy', "risk.stop: strategy (each setup keeps its own strategy's stop)");
    req(data.exit && data.exit.trail_activate_r !== undefined, 'exit: trail_activate_r and trail_giveback_r (the trail that exits every trade it takes)');
    // Its setups come from other strategies' scans, which carry no target distance of its own.
    req(!(data.exit && data.exit.target !== undefined), 'exit.target: not for a policy strategy (its trades exit by its trail; the strategies it lists keep their own targets only when traded on their own)');
  } else {
    for (const k of POLICY_STRATEGY_KEYS) {
      if (data[k] !== undefined) errors.push(`${k}: only a policy strategy (signal: policy) trades an account; list this strategy in one (see strategies/prop_portfolio)`);
    }
    if (data.risk && data.risk.stop === 'strategy') errors.push('risk.stop: strategy is only for a policy strategy');
    if (data.priority !== undefined) errors.push('priority: only a policy strategy (signal: policy) has one (it orders policies whose setups come in the same cycle)');
  }
  // Which policy goes first when two lanes' policies have a setup in the same cycle: 1 first. Parsed and
  // checked now; the runner uses it once it cycles several lanes.
  if (data.signal === 'policy' && data.priority !== undefined) {
    req(Number.isInteger(data.priority) && data.priority >= 1 && data.priority <= 99, 'priority: a whole number 1 to 99 (1 goes first when policies collide in one cycle)');
  }
  // The initial balance and ADR need a bar at 09:30 ET: a timeframe that divides 30 minutes.
  const ruleText = JSON.stringify([data.rules || {}, (data.risk && data.risk.stop) || '', (data.exit && data.exit.target) || '']);
  const tf = /^(\d+)(m|h)$/.exec(String(data.timeframe || ''));
  const tfMin = tf ? Number(tf[1]) * (tf[2] === 'h' ? 60 : 1) : null;
  if (/\b(ib_high|ib_low|adr\()/.test(ruleText) && tfMin && 30 % tfMin !== 0) errors.push(`rules: ib_high, ib_low and adr(n) need a timeframe that divides 30 minutes (a bar at 09:30 ET), not ${data.timeframe}`);

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
  if (data.exit !== undefined) errors.push(...exitErrors(data.exit));
  for (const h of REQUIRED_SECTIONS) req(body.includes(h), `body: missing section "${h}"`);
  return errors;
}


/**
 * A policy strategy's frontmatter with its rulebook entry merged in: { data, errors, multipliers }.
 * `rulebookOf(account)`: that account's rulebook, or null when it has none.
 */
function withRulebook(data, folderName, rulebookOf) {
  if (data.signal !== 'policy' || typeof data.account !== 'string' || !rulebookOf) return { data, errors: [], multipliers: undefined };
  const book = rulebookOf(data.account);
  const where = book ? book.file : `accounts/${data.account}/${rulebook.FILE}`;
  // Stated here, a value would be a second place: always refused, listed or not.
  const own = ['sizing', 'exit', 'multipliers'].filter(k => data[k] !== undefined)
    .map(k => `${k}: it lives in ${where} (policies.${folderName}.${k}), not here (one place)`);
  if (!book) return { data, errors: [...own, `account: ${data.account} has no rulebook (${where}); no policy on it can be sized`], multipliers: undefined };
  if (!book.valid) return { data, errors: [...own, `account: ${where} is invalid (${book.errors.join('; ')}); no policy on it can be sized`], multipliers: undefined };
  const entry = rulebook.policyEntry(book, folderName);
  if (!entry) return { data, errors: [...own, `account: ${where} doesn't list ${folderName} (policies.${folderName}: its sizing, exit and multipliers); a policy is sized only from its account's rulebook`], multipliers: undefined };
  return { data: { ...data, sizing: entry.sizing, exit: entry.exit }, errors: own, multipliers: entry.multipliers };
}

function loadStrategyFile(file, { rulebookOf = null } = {}) {
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
  const book = withRulebook(parsed.data, folderName, rulebookOf);
  parsed = { ...parsed, data: book.data };
  const errors = [...book.errors, ...validateStrategy(parsed.data, parsed.body, folderName)];
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
  return {
    ...parsed.data, ...(book.multipliers !== undefined ? { multipliers: book.multipliers } : {}), mtf: parsed.data.mtf || (parsed.data.signal === 'policy' ? undefined : 'trend'),
    name: folderName, file, body: parsed.body, compiledRules, compiledStop, compiledTarget, valid: ok, errors,
  };
}

/** account name -> its rulebook (beside the first ACCOUNT.md of that name on the account search path), or null; cached per load. */
function rulebookFinder(pluginRoot, env) {
  const seen = new Map();
  return name => {
    if (!seen.has(name)) {
      const dir = /^[a-z0-9][a-z0-9_-]*$/.test(name) ? accountDirs(pluginRoot, env).find(d => fs.existsSync(path.join(d, name, 'ACCOUNT.md'))) : null;
      seen.set(name, dir ? rulebook.loadRulebookFile(path.join(dir, name, rulebook.FILE)) : null);
    }
    return seen.get(name);
  };
}

/** Load every strategy from the search path. Folders starting with _ (templates) are skipped. */
function loadStrategies(pluginRoot, env = process.env) {
  const byName = new Map();
  const problems = [];
  const rulebookOf = rulebookFinder(pluginRoot, env);
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
      const s = loadStrategyFile(file, { rulebookOf });
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
      if (!c) errs.push(`strategies: ${n} is not a strategy${retiredNote(n)}`);
      else if (!c.valid) errs.push(`strategies: ${n} is invalid (${c.errors[0]})`);
      else if (c.signal !== 'rules') errs.push(`strategies: ${n} is signal: ${c.signal}; a policy trades rules strategies only`);
      // Not re-run on other bars: its periods and stop are in its own bars (a 3m strategy on 1m bars is another strategy).
      else if (c.timeframe !== s.timeframe) errs.push(`strategies: ${n} trades ${c.timeframe} bars, not ${s.timeframe} (a policy strategy lists strategies on its own timeframe; they are not re-run on other bars)`);
      else if (c.status === 'disabled') errs.push(`strategies: ${n} is disabled; remove it from the list`);
    }
    // Every index the policy strategy trades must be scanned by at least one of its strategies (on the micro's bars).
    const { familyRoot } = require('./contracts');
    for (const r of s.instruments) {
      const ok = s.strategies.some(n => byName.get(n) && (byName.get(n).instruments || []).some(x => familyRoot(x) === familyRoot(r)));
      if (!ok) errs.push(`instruments: none of its strategies trades ${r}'s index (list its micro or mini in their instruments)`);
    }
    if (errs.length) Object.assign(s, { valid: false, errors: errs });
  }
  return { strategies: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

/**
 * Why strategy `s` may not trade contract root `root`, or null when it may.
 * `selected`: the contracts the user selected (the runner's symbols, or
 * FTH_SYMBOLS; contracts.js parseSelection), null when unknown.
 *
 * A rules strategy trades one leg of a micro/mini family (contracts.js
 * FAMILIES): the selected one. Listing either leg, it trades the selected leg
 * (listing MNQ covers a selected NQ), and never the other one (selecting MNQ,
 * an NQ entry is refused, and the other way round), so it never alternates
 * between the two. With no leg of the family selected, it trades exactly the
 * roots it lists, and nothing of a family it lists both legs of (fails closed). Manual strategies always trade exactly the roots they list. A
 * policy strategy trades within its list: the selected leg when one of the family is
 * selected (its verdict is sized in that leg), else either leg it lists (its `contracts` picks).
 */
function rootRefusal(s, root, selected = null) {
  const r = String(root || '').toUpperCase();
  const list = (s && Array.isArray(s.instruments)) ? s.instruments : [];
  // A policy strategy picks either leg of a family it lists, unless one is selected: then that one.
  const leg = s && s.signal === 'policy' && familyOf(r) ? selectedLeg(r, selected) : null;
  if (leg && leg !== r) return `trades ${leg} (the selected contract), not ${r}`;
  const fam = s && s.signal === 'rules' ? familyOf(r) : null;
  if (fam && (list.includes(fam.micro) || list.includes(fam.mini))) {
    const pick = selectedLeg(r, selected);
    if (pick) return pick === r ? null : `trades ${pick} (the selected contract), not ${r}`;
    // No leg selected and both listed: which one is the user's to say (fails closed).
    if (list.includes(fam.micro) && list.includes(fam.mini)) {
      return `lists both ${fam.micro} and ${fam.mini}, and neither is selected: it trades one, the selected contract (the runner's symbols, or FTH_SYMBOLS=${r})`;
    }
    if (!list.includes(r)) {
      return `does not trade ${r} (instruments: ${list.join(', ')}); it trades the other leg of a family it lists only when that leg is the selected contract: select ${r} (the runner's symbols, or FTH_SYMBOLS=${r})`;
    }
  }
  return r && list.includes(r) ? null : `does not trade ${r || 'an unnamed contract'} (instruments: ${list.join(', ')})`;
}

/** Does strategy `s` trade contract root `root`, given the selected contracts? (rootRefusal) */
const tradesRoot = (s, root, selected = null) => rootRefusal(s, root, selected) === null;

/**
 * The bars' timeframe in ms: the smallest gap between the last 50 bars (breaks such as the
 * overnight one are longer), or null without two bars a positive gap apart.
 */
function barsStepMs(bars) {
  const norm = normalizeBars(bars);
  const diffs = norm.slice(-50).map((b, i, a) => (i ? Date.parse(b.t) - Date.parse(a[i - 1].t) : Infinity)).filter(d => d > 0 && Number.isFinite(d));
  return diffs.length ? Math.min(...diffs) : null;
}

/**
 * Bars `stepMs` apart as the runner names its timeframe (`${minutes}m`: 3m, 60m), or null when the step is not
 * a whole number of minutes.
 */
function barsTimeframe(stepMs) {
  return stepMs > 0 && stepMs % 60000 === 0 ? `${stepMs / 60000}m` : null;
}

/**
 * The strategies on timeframe `tf` (as the runner names it: `${minutes}m`): only they can be judged from those
 * bars. The text as written, as everywhere a timeframe is compared (backtest, start-up, preflight, a policy's
 * strategies, confluence): a 1h strategy is not on 60m bars. The runner's scan, the strategies_scan tool and its
 * record all filter with this.
 */
const onTimeframe = (strategies, tf) => strategies.filter(s => typeof tf === 'string' && tf !== '' && s.timeframe === tf);

/**
 * Evaluate every valid, non-disabled strategy for `symbol` on the last closed
 * bar. Mechanical strategies report fired/not fired with filter results;
 * manual strategies are listed for the LLM to evaluate from their Markdown
 * body. Sessions are checked at `now` (default: the last bar's close).
 */
function scan(strategies, bars, { symbol, now = null, selected = null } = {}) {
  const root = String(symbol || '').toUpperCase();
  const norm = normalizeBars(bars);
  if (norm.length < 3) throw new Error(`need at least 3 bars, got ${norm.length}`);
  const ev = createEvaluator(norm);
  const results = [];
  for (const s of strategies) {
    if (!s.valid || s.status === 'disabled') continue;
    if (root && !tradesRoot(s, root, selected)) continue;
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
function recentSignals(strategies, bars, { symbol, count = 5, selected = null } = {}) {
  const root = String(symbol || '').toUpperCase();
  const norm = normalizeBars(bars);
  const ev = createEvaluator(norm);
  const usable = strategies.filter(s => s.valid && s.status !== 'disabled' && s.signal === 'rules' && (!root || tradesRoot(s, root, selected)));
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

/**
 * Why policy strategy `policy` may not trade the setup of its strategy `name`, or null when it may.
 * A paper strategy stays paper inside a policy: live, a policy trades only its listed strategies
 * that are valid rules strategies with status active. In a paper run (`paper`: no order goes
 * live) any non-disabled one counts, as a paper run takes any non-disabled policy. `registry`:
 * loadStrategies' list; none (or a name not in it) refuses, so a caller can't fail open.
 * The runner's screen, the order gate (prop-state.js), and the backtester all use it.
 */
function componentRefusal(policy, registry, name, { paper = false } = {}) {
  const owner = policy && policy.name;
  if (!(policy && Array.isArray(policy.strategies) && policy.strategies.includes(name))) return `${name || 'the setup\'s strategy'} is not one of ${owner || 'the policy'}'s strategies`;
  if (!Array.isArray(registry)) return `${name}'s status can't be read (no strategy registry), so ${owner} can't trade it`;
  const c = registry.find(x => x.name === name);
  if (!c) return `${name} is not a known strategy${retiredNote(name)}`;
  if (!c.valid) return `strategies/${name}/STRATEGY.md is invalid (${(c.errors || [])[0]})`;
  if (c.signal !== 'rules') return `${name} is signal: ${c.signal}; a policy trades rules strategies only`;
  if (c.status === 'active' || (paper && c.status !== 'disabled')) return null;
  return `${name} has status "${c.status}": ${owner} trades only its active strategies${paper ? '' : ' live'} (a ${c.status} strategy stays ${c.status} inside a policy)`;
}

/** Order-gate view: is `name` a tradable strategy for this contract right now? Returns an error message or null. */
function checkStrategyForOrder(strategies, name, contractRoot, now, side = null, selection = { symbols: null }) {
  // An unreadable selection: no entries until it names one contract per index (fails closed).
  if (selection && selection.error) return `${selection.error}. No entries until it is fixed.`;
  const s = strategies.find(x => x.name === name);
  if (!s) {
    return Object.hasOwn(RETIRED, name)
      ? `setup:${name} is not a known strategy${retiredNote(name)}: no new entries from it. A position it opened is still exited and protected with [exit] or [protect].`
      : `setup:${name} is not a known strategy. Add strategies/${name}/STRATEGY.md or use an existing setup tag.`;
  }
  if (!s.valid) return `strategies/${name}/STRATEGY.md is invalid (${s.errors[0]}). Fix it before trading it.`;
  if (s.status !== 'active') return `setup:${name} has status "${s.status}"; only active strategies may place live entries.`;
  const notTraded = rootRefusal(s, contractRoot, selection ? selection.symbols : null);
  if (notTraded) return `setup:${name} ${notTraded}.`;
  if (!inSessions(s, now)) return `setup:${name} is outside its sessions (${s.sessions.join(', ')}).`;
  const sideName = String(side === null || side === undefined ? '' : side).toLowerCase();
  if (s.compiledRules && (sideName === 'buy' || sideName === 'sell')) {
    const dir = sideName === 'buy' ? 'long' : 'short';
    if (!s.compiledRules[dir].length) return `setup:${name} has no ${dir} rules, so it can't ${sideName} to enter.`;
  }
  return null;
}

module.exports = {
  RETIRED,
  retiredNote,
  exitPlan,
  exitErrors,
  STATUSES,
  SIGNALS,
  FILTERS,
  strategyDirs,
  validateStrategy,
  loadStrategyFile,
  loadStrategies,
  scan,
  checkStrategyForOrder,
  componentRefusal,
  tradesRoot,
  rootRefusal,
  barsStepMs,
  barsTimeframe,
  onTimeframe,
  recentSignals };
