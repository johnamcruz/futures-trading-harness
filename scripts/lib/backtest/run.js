'use strict';

/**
 * Backtest driver: config -> bar data -> engine -> report files.
 *
 * Config (JSON; an autotrader config works too, its symbols, timeframe,
 * sessions, and eodAt are reused):
 *   symbols      contract roots to trade, e.g. ["MNQ"]
 *   timeframe    minutes per bar (1, 3, ...); finer data is aggregated
 *   data         { "MNQ": "data/NQ_1min.parquet" } or { "MNQ": { file, sheet,
 *                tickSize, tickValue, feesPerSide } }; Parquet, Excel, CSV, JSON
 *   start, end   ISO dates or times (end exclusive); default: all the data
 *   strategies   names in priority order (default: every non-disabled
 *                mechanical strategy on this timeframe)
 *   gate, sessions, eodAt, size, riskPerTrade, maxContracts, slippageTicks,
 *   feesPerSide, maxDailyLoss, window: see engine.js DEFAULTS
 *   outDir       where results go (default <FTH_HOME>/backtests/<run id>)
 *   account      an account profile (accounts/<name>/ACCOUNT.md): run prop
 *                challenge attempts from every `every`-th trading day instead
 *                of one long run (pass / blow / timeout rates by month)
 *   policy       a policy bundle (models/<name>.json) deciding which setups to
 *                take and when to close; needs an account. The rules-only
 *                baseline is always reported next to it.
 *   sizing       combine sizing (combine.js DEFAULT_SIZING keys)
 *   walkForward  { grid: { "<param>": [values] }, trainMonths, testMonths,
 *                minTrades }: walk-forward test of the one strategy named in
 *                `strategies` (walk-forward.js); writes walk-forward.md/json
 *   debug        a strategy name: write its verdict on every bar (fired or
 *                not, the rules that failed, its detectors' state) to
 *                decisions-<name>.jsonl in the run folder
 *
 * Every run writes trades.jsonl next to trades.csv: each trade with the setup
 * behind it (stop and target distances, detector state on the signal bar).
 */

const fs = require('fs');
const path = require('path');
const { loadStrategies } = require('../trading/strategies');
const { loadBars, barMinutes, aggregate, auditBars } = require('./data');
const { runEngine, prepare, DEFAULTS } = require('./engine');
const { summarizeResult } = require('../trading/scan-log');
const { buildReport, toMarkdown, toCsv } = require('./report');
const { writeJsonAtomic } = require('../harness-run');
const { loadConfig } = require('../trading/config');
const { parseWindows } = require('../trading/clock');
const { CONTRACT_SPECS } = require('../trading/contracts');
const { accountNamed } = require('../trading/accounts');
const { DEFAULT_SIZING: combineDefaults } = require('../trading/combine');
const { marketHoursErrors } = require('../autotrader');
const walkForward = require('./walk-forward');

const WARMUP_BARS = 2000;


/** "HH:MM@Zone" with a real time and time zone. */
function validAt(spec) {
  const m = /^(\d{1,2}):(\d{2})@(.+)$/.exec(String(spec).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return false;
  return parseWindows(`00:00-00:01@${m[3]}`).errors.length === 0;
}

function parseTimeArg(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T00:00:00Z` : String(value));
  if (!Number.isFinite(ms)) throw new Error(`${name}: an ISO date or time, e.g. "2025-03-10"`);
  return ms;
}

/**
 * The debug log: strategy `s`'s verdict on every bar from `start` to `end`,
 * one JSON line each (what fired, what failed and why). Returns the line count.
 */
function writeDecisions(file, markets, s, cfg) {
  const lines = [];
  for (const m of markets) {
    const { books } = prepare([m], [s], cfg);
    const b = books[0];
    for (let i = 0; i < b.bars.length; i += 1) {
      const ms = b.bars[i].ms;
      if ((cfg.start !== null && ms < cfg.start) || (cfg.end !== null && ms >= cfg.end)) continue;
      const r = b.ev.at(s, i, { describe: true });
      // The engine trades from bar window-1 on: before it, a setup is history only.
      const warm = i < cfg.window - 1 ? { warmup: `bar ${i}: the backtest trades from bar ${cfg.window - 1} (window)` } : {};
      lines.push(JSON.stringify({ symbol: m.symbol, t: b.bars[i].t, close: b.bars[i].c, ...summarizeResult(r), ...warm }));
    }
  }
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
  return lines.length;
}

/** Validate a backtest config. Returns the normalized settings. */
function validateBacktestConfig(raw, baseDir) {
  for (const k of ['account', 'policy', 'sizing']) {
    if (raw && raw[k] !== undefined && raw[k] !== null) {
      throw new Error(`invalid backtest config:\n- ${k}: comes from a policy strategy now; name it with "prop": "<policy strategy>" (signal: policy)`);
    }
  }
  const cfg = { ...DEFAULTS, timeframe: 3, symbols: ['MNQ'], strategies: null, outDir: null, every: 1, prop: null, bundle: null, debug: null, walkForward: null, ...(raw || {}) };
  const errors = [];
  if (!Number.isInteger(cfg.timeframe) || cfg.timeframe < 1 || cfg.timeframe > 60) errors.push('timeframe: minutes per bar, 1 to 60');
  if (!Array.isArray(cfg.symbols) || !cfg.symbols.length || !cfg.symbols.every(s => /^[A-Z0-9]+$/.test(s))) errors.push('symbols: e.g. ["MNQ"]');
  if (!cfg.data || typeof cfg.data !== 'object') errors.push('data: { "<SYMBOL>": "<file>" } (Parquet, Excel, CSV, or JSON bars)');
  if (cfg.strategies !== null && !(Array.isArray(cfg.strategies) && cfg.strategies.every(s => typeof s === 'string'))) errors.push('strategies: a list of strategy names');
  for (const k of ['size', 'maxContracts']) if (!(Number.isInteger(cfg[k]) && cfg[k] > 0)) errors.push(`${k}: a positive whole number`);
  if (cfg.riskPerTrade !== null && !(cfg.riskPerTrade > 0)) errors.push('riskPerTrade: dollars per trade, or null for a fixed size');
  if (cfg.riskPerTrade !== null && raw && raw.size !== undefined) errors.push('size and riskPerTrade: use one (fixed contracts, or size from the stop and a dollar risk)');
  if (!Array.isArray(cfg.sessions) || parseWindows(cfg.sessions.join(',')).errors.length) errors.push('sessions: ["HH:MM-HH:MM@Zone", ...] (e.g. "18:00-15:50@America/New_York", or asia, london, ny)');
  if (!cfg.eodAt || !validAt(cfg.eodAt)) errors.push('eodAt: "HH:MM@Zone" no later than the 16:00 ET close (e.g. "15:50@America/New_York")');
  else if (!errors.length) errors.push(...marketHoursErrors(cfg));
  if (typeof cfg.gate !== 'boolean') errors.push('gate: true or false');
  for (const k of ['earlyCloseDates', 'closedDates']) {
    if (!Array.isArray(cfg[k]) || !cfg[k].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d))) errors.push(`${k}: ["YYYY-MM-DD", ...] (trading days, by the date they end on)`);
  }
  if (cfg.earlyCloseEodAt && !validAt(cfg.earlyCloseEodAt)) errors.push('earlyCloseEodAt: "HH:MM@Zone", no later than 13:00 ET');
  if (!(cfg.slippageTicks >= 0)) errors.push('slippageTicks: 0 or more');
  if (!(Number.isInteger(cfg.minConfluence) && cfg.minConfluence >= 1)) errors.push('minConfluence: strategies that must fire the same side, 1 or more');
  if (!['priority', 'skip'].includes(cfg.conflict)) errors.push('conflict: "priority" (the first strategy in order trades) or "skip" (no entry when strategies disagree)');
  if (!['next-open', 'close'].includes(cfg.fill)) errors.push('fill: "next-open" (entries fill at the next bar\'s open, as live after the cycle) or "close" (at the signal bar\'s close, as algoTraderBot)');
  if (!(cfg.maxDailyLoss >= 0)) errors.push('maxDailyLoss: dollars, 0 for off');
  if (cfg.feesPerSide !== null && !(cfg.feesPerSide >= 0)) errors.push('feesPerSide: dollars per contract per side');
  if (!(Number.isInteger(cfg.window) && cfg.window >= 160)) errors.push('window: bars of history per evaluation, at least 160');
  if (cfg.outDir !== null && typeof cfg.outDir !== 'string') errors.push('outDir: a directory');
  if (cfg.prop !== null && !(typeof cfg.prop === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(cfg.prop))) errors.push('prop: a policy strategy (signal: policy), e.g. "prop_portfolio_3m"');
  if (cfg.bundle !== null && !(typeof cfg.bundle === 'string' && cfg.prop !== null)) errors.push('bundle: a policy bundle (models/<name>.json) to try in place of the policy strategy\'s own; needs prop');
  if (!(Number.isInteger(cfg.every) && cfg.every >= 1)) errors.push('every: attempts start every N trading days (1 or more)');
  if (cfg.debug !== null && !(typeof cfg.debug === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(cfg.debug))) errors.push('debug: a strategy name, to log its verdict on every bar');
  if (cfg.walkForward !== null) {
    const w = cfg.walkForward;
    if (!w || typeof w !== 'object' || Array.isArray(w)) errors.push('walkForward: { grid, trainMonths, testMonths, minTrades }');
    else if (cfg.prop !== null) errors.push('walkForward: tests one rules strategy; a prop run is validated by rl/ship.py');
    else if (!(Array.isArray(cfg.strategies) && cfg.strategies.length === 1)) errors.push('walkForward: name exactly one strategy in "strategies"');
  }
  let start = null;
  let end = null;
  try { start = parseTimeArg(cfg.start, 'start'); } catch (err) { errors.push(err.message); }
  try { end = parseTimeArg(cfg.end, 'end'); } catch (err) { errors.push(err.message); }
  if (start !== null && end !== null && end <= start) errors.push('end must be after start');
  const markets = [];
  for (const symbol of Array.isArray(cfg.symbols) ? cfg.symbols : []) {
    const d = cfg.data && cfg.data[symbol];
    const spec = { ...(CONTRACT_SPECS[symbol] || {}), ...(typeof d === 'object' && d ? d : {}) };
    const file = typeof d === 'string' ? d : d && d.file;
    if (!file) { errors.push(`data.${symbol}: a bar file`); continue; }
    if (!(spec.tickSize > 0 && spec.tickValue > 0)) { errors.push(`data.${symbol}: tickSize and tickValue (not a known contract)`); continue; }
    markets.push({
      symbol, file: path.resolve(baseDir, file), sheet: spec.sheet || null, tickSize: spec.tickSize, tickValue: spec.tickValue,
      // The symbol's own fee wins over the run-wide one.
      feesPerSide: (typeof d === 'object' && d && d.feesPerSide !== undefined ? d.feesPerSide : null) ?? cfg.feesPerSide ?? spec.feesPerSide ?? 0.37,
    });
  }
  if (errors.length) throw new Error(`invalid backtest config:\n- ${errors.join('\n- ')}`);
  return { ...cfg, start, end, markets };
}

/** Bars at the trading timeframe: as given, or aggregated from finer bars. */
function barsAt(file, timeframe, sheet) {
  const raw = loadBars(file, { sheet });
  if (raw.length < 2) throw new Error(`${file}: not enough bars`);
  const step = barMinutes(raw);
  if (step === timeframe) return raw;
  if (step > timeframe || timeframe % step !== 0) {
    throw new Error(`${file}: ${step}-minute bars can't make ${timeframe}-minute bars (need ${timeframe}-minute data or a divisor of it)`);
  }
  const last = raw[raw.length - 1];
  return aggregate(raw, { unit: 2, unitNumber: timeframe, nowMs: last.ms + step * 60000 });
}

function pickStrategies(all, cfg) {
  const tf = `${cfg.timeframe}m`;
  if (cfg.strategies) {
    return cfg.strategies.map(name => {
      const s = all.find(x => x.name === name);
      if (!s) throw new Error(`unknown strategy "${name}"`);
      if (!s.valid) throw new Error(`strategy "${name}" is invalid: ${s.errors[0]}`);
      if (s.timeframe !== tf) throw new Error(`strategy "${name}" trades ${s.timeframe}; this backtest runs ${tf} bars`);
      return s;
    });
  }
  return all.filter(s => s.valid && s.status !== 'disabled' && s.timeframe === tf && s.signal !== 'manual');
}

/**
 * Where a result came from, so it can be reproduced or questioned later: the
 * harness commit, each strategy file's hash, and each data file's size and
 * hash.
 */
function provenance(root, strategies, markets) {
  const crypto = require('crypto');
  const hash = file => {
    try {
      const h = crypto.createHash('sha256');
      h.update(fs.readFileSync(file));
      return h.digest('hex').slice(0, 16);
    } catch (_err) {
      return null;
    }
  };
  let commit = null;
  try {
    commit = require('child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch (_err) {
    // not a git checkout (a plugin install): the file hashes still pin it
  }
  return {
    commit,
    node: process.version,
    strategies: Object.fromEntries(strategies.map(st => [st.name, st.file ? hash(st.file) : null])),
    data: Object.fromEntries(markets.map(m => [m.symbol, { file: m.file, bytes: (() => { try { return fs.statSync(m.file).size; } catch (_err) { return null; } })(), sha256: hash(m.file) }])),
  };
}

/** A walk-forward test of one strategy (walk-forward.js). Returns { report, runDir }. */
function runWalk(cfg, strategy, markets, { baseDir, outRoot, env, runId, log }) {
  const w = cfg.walkForward;
  const firstTradable = Math.max(...markets.map(m => Date.parse(m.bars[Math.min(cfg.window, m.bars.length - 1)].t)));
  const from = cfg.start !== null ? Math.max(cfg.start, firstTradable) : firstTradable;
  const to = cfg.end !== null ? cfg.end : Math.min(...markets.map(m => Date.parse(m.bars[m.bars.length - 1].t) + 1));
  log(`walk-forward ${strategy.name}: ${walkForward.combinations(w.grid || {}).length} combinations, ${w.trainMonths ?? 6} month(s) in sample, ${w.testMonths ?? 1} out of sample`);
  const report = walkForward.runWalkForward(markets, strategy, {
    ...w, from, to, engine: { ...cfg, account: null, policy: null, gateConfig: loadConfig(env) },
  });
  const id = runId || new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = cfg.outDir ? path.resolve(baseDir, cfg.outDir) : path.join(outRoot, id);
  fs.mkdirSync(runDir, { recursive: true });
  writeJsonAtomic(path.join(runDir, 'walk-forward.json'), report);
  fs.writeFileSync(path.join(runDir, 'walk-forward.md'), walkForward.toMarkdown(report));
  fs.writeFileSync(path.join(runDir, 'trades.csv'), toCsv(report.trades));
  return { report: { walkForward: true, ...report }, runDir };
}

/** Run a backtest. Returns { report, runDir }. */
function runBacktest(raw, { root, baseDir = process.cwd(), outRoot, env = process.env, runId = null, log = () => {} }) {
  const cfg = validateBacktestConfig(raw, baseDir);
  let strategies;
  let prop = null;
  if (cfg.prop) {
    // A policy strategy: its strategies, account, sizing, contracts, and exit come from its STRATEGY.md.
    const { policyStrategy } = require('../rl/env-config');
    const p = policyStrategy(root, cfg.prop, env);
    if (Number.parseInt(p.strategy.timeframe, 10) !== cfg.timeframe) throw new Error(`timeframe: ${cfg.prop} trades ${p.strategy.timeframe} bars, not ${cfg.timeframe}m`);
    prop = p.strategy;
    strategies = p.components;
    const { familyRoot } = require('../trading/contracts');
    for (const sym of cfg.symbols) {
      if (!prop.instruments.some(r => familyRoot(r) === familyRoot(sym))) throw new Error(`symbols: ${cfg.prop} trades ${prop.instruments.join(', ')}, not ${sym}`);
    }
  } else {
    strategies = pickStrategies(loadStrategies(root, env).strategies, cfg);
  }
  if (!strategies.length) throw new Error(`no mechanical strategy trades ${cfg.timeframe}m bars`);
  // Keep the window plus a warm-up before `start`, and nothing after `end`:
  // indicators settle well within that, and a long file stays fast.
  const markets = cfg.markets.map(m => {
    log(`loading ${m.symbol} from ${m.file}`);
    let bars = barsAt(m.file, cfg.timeframe, m.sheet);
    const ms = b => Date.parse(b.t);
    const first = cfg.start === null ? 0 : bars.findIndex(b => ms(b) >= cfg.start);
    const from = cfg.start === null ? 0 : Math.max(0, (first === -1 ? bars.length : first) - cfg.window - WARMUP_BARS);
    const to = cfg.end === null ? bars.length : bars.findIndex(b => ms(b) >= cfg.end);
    bars = bars.slice(from, to === -1 ? bars.length : to);
    const audit = auditBars(bars, cfg.timeframe);
    for (const w of audit.warnings) log(`warning: ${m.symbol} data: ${w}`);
    m.audit = audit;
    if (bars.every(b => !(b.v > 0))) log(`warning: ${m.file} has no volume (no volume column, or all zero); order-flow series (ofi, delta, vol_sma) are missing, so strategies using them never fire`);
    if (bars.length < cfg.window) throw new Error(`${m.file}: only ${bars.length} bars in range; need at least ${cfg.window} (window) before the first trade`);
    return { ...m, bars };
  });
  log(`${strategies.map(s => s.name).join(', ')} on ${markets.map(m => `${m.symbol} (${m.bars.length} ${cfg.timeframe}m bars)`).join(', ')}`);
  for (const m of markets) {
    const flowUsers = strategies.filter(s => (s.connectors || []).includes('order_flow') && s.instruments.includes(m.symbol));
    if (flowUsers.length && !m.bars.some(b => Number.isFinite(b.bv))) {
      log(`warning: ${flowUsers.map(s => s.name).join(', ')} declare the order_flow connector but ${m.file} has no buy/sell volume columns; ofi/delta fall back to the bar-shape estimate (record flow and export it: scripts/orderflow.js)`);
    }
    if (!strategies.some(s => s.instruments.includes(m.symbol))) {
      log(`warning: no selected strategy lists ${m.symbol} in its instruments, so it can't trade (micros: MNQ, MES, MYM, M2K; use the micro symbol with full-size data)`);
    }
  }
  if (cfg.debug && !strategies.some(s => s.name === cfg.debug)) throw new Error(`debug: ${cfg.debug} is not among the strategies this run trades (${strategies.map(s => s.name).join(', ')})`);
  if (prop) return runCombine(cfg, prop, strategies, markets, { root, baseDir, outRoot, env, runId, log });
  if (cfg.walkForward) return runWalk(cfg, strategies[0], markets, { baseDir, outRoot, env, runId, log });
  const { trades, skipped, expired } = runEngine(markets, strategies, { ...cfg, account: null, policy: null, gateConfig: loadConfig(env) });
  for (const m of markets) {
    if (!strategies.some(s => s.instruments.includes(m.symbol))) skipped[m.symbol] = 'no selected strategy trades this symbol';
  }
  const id = runId || new Date().toISOString().replace(/[:.]/g, '-');
  const first = markets.map(m => m.bars[0].t).sort()[0];
  const last = markets.map(m => m.bars[m.bars.length - 1].t).sort().pop();
  const report = buildReport(trades, {
    runId: id, symbols: cfg.symbols, timeframe: cfg.timeframe, strategies: strategies.map(s => s.name), gate: cfg.gate,
    start: cfg.start !== null ? new Date(cfg.start).toISOString() : first,
    end: cfg.end !== null ? new Date(cfg.end).toISOString() : last,
    size: cfg.riskPerTrade ? `risk $${cfg.riskPerTrade} (max ${cfg.maxContracts})` : cfg.size,
    slippageTicks: cfg.slippageTicks, fill: cfg.fill, expired, skipped,
    dataAudit: Object.fromEntries(markets.map(m => [m.symbol, m.audit])),
    provenance: provenance(root, strategies, markets),
  });
  const runDir = cfg.outDir ? path.resolve(baseDir, cfg.outDir) : path.join(outRoot, id);
  fs.mkdirSync(runDir, { recursive: true });
  writeJsonAtomic(path.join(runDir, 'report.json'), report);
  fs.writeFileSync(path.join(runDir, 'report.md'), toMarkdown(report));
  fs.writeFileSync(path.join(runDir, 'trades.csv'), toCsv(report.trades));
  fs.writeFileSync(path.join(runDir, 'trades.jsonl'), report.trades.map(t => JSON.stringify(t)).join('\n') + (report.trades.length ? '\n' : ''));
  if (cfg.debug) {
    const file = path.join(runDir, `decisions-${cfg.debug}.jsonl`);
    const n = writeDecisions(file, markets, strategies.find(s => s.name === cfg.debug), cfg);
    log(`debug: ${cfg.debug}'s verdict on ${n} bars in ${file}`);
  }
  return { report, runDir };
}

/** Prop challenge attempts: the rules-only baseline, and the policy when one is named. */
function runCombine(cfg, prop, strategies, markets, { root, baseDir, outRoot, env, runId, log }) {
  const { createEnv, evaluate } = require('../rl/challenge-env');
  const { loadBundle, bundleMismatch } = require('../rl/policy-bundle');
  const account = accountNamed(root, prop.account, env);
  const contracts = prop.contracts || 'auto';
  const e = createEnv({
    markets, strategies, account, sizing: prop.sizing || null, prop: { strategy: prop, components: prop.strategies, contracts },
    engine: { ...cfg, account: null, policy: null, prop: null, gateConfig: loadConfig(env) },
  });
  const from = cfg.start ?? e.days[0];
  const to = cfg.end ?? Infinity;
  const starts = e.starts(from, to, { every: cfg.every });
  if (!starts.length) throw new Error(`no ${account.sessions}-session attempt fits in the data${cfg.start !== null || cfg.end !== null ? ' between start and end' : ''}`);
  log(`${prop.name}: ${starts.length} ${account.name} attempts (${account.sessions} sessions each), every ${cfg.every} trading day(s); ${strategies.map(s => s.name).join(', ')}; contracts ${contracts}`);
  const baseline = evaluate(e, starts, to, null);
  let policy = null;
  const bundleName = cfg.bundle || (prop.policy && prop.policy.bundle) || null;
  if (bundleName) {
    const bundle = loadBundle(root, bundleName, env, { requireValidated: false });
    if (!bundle.meta.validated) log(`warning: ${bundleName} is not validated (research only; live trading refuses it)`);
    const why = bundleMismatch(bundle.meta, prop, cfg.symbols[0]);
    if (why) throw new Error(`bundle ${bundleName} ${why}`);
    policy = evaluate(e, starts, to, { decide: bundle.decide });
  }
  const id = runId || new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    runId: id, prop: prop.name, account: account.name, symbols: cfg.symbols, timeframe: cfg.timeframe, strategies: strategies.map(s => s.name),
    gate: cfg.gate, sizing: { ...combineDefaults, ...(prop.sizing || {}) }, contracts, every: cfg.every, policy: bundleName, baseline, withPolicy: policy,
  };
  const runDir = cfg.outDir ? path.resolve(baseDir, cfg.outDir) : path.join(outRoot, id);
  fs.mkdirSync(runDir, { recursive: true });
  writeJsonAtomic(path.join(runDir, 'combine.json'), report);
  fs.writeFileSync(path.join(runDir, 'combine.md'), combineMarkdown(report));
  return { report, runDir };
}

function combineMarkdown(r) {
  const pct = x => (x === null || x === undefined ? '-' : `${Math.round(x * 1000) / 10}%`);
  const row = (label, x) => `| ${label} | ${x.attempts} | ${pct(x.passRate)} | ${pct(x.winRate)} | ${pct(x.blowRate)} | ${pct(x.attempts ? x.timeout / x.attempts : null)} | ${x.medianDaysToPass ?? '-'} | ${x.avgProfit} | ${x.tradesPerAttempt} |`;
  const lines = [
    `# Prop challenge backtest ${r.runId}`, '',
    `${r.prop} on account ${r.account}: ${r.strategies.join(', ')} on ${r.symbols.join(', ')} ${r.timeframe}m; harness rules ${r.gate ? 'on' : 'off'}; sizing ${JSON.stringify(r.sizing)}; contracts ${r.contracts}.`, '',
    '| | Attempts | Pass | Win rate | Blow | Timeout | Median days to pass | Avg profit $ | Trades/attempt |', '|---|---|---|---|---|---|---|---|---|',
    row('Rules only', r.baseline), ...(r.withPolicy ? [row(`Policy ${r.policy}`, r.withPolicy)] : []), '',
    '## By month (attempt start)', '', `| Month | Rules-only pass | Rules-only blow |${r.withPolicy ? ' Policy pass | Policy blow |' : ''}`,
    `|---|---|---|${r.withPolicy ? '---|---|' : ''}`,
    ...Object.entries(r.baseline.months).map(([m, x]) => `| ${m} | ${pct(x.passRate)} | ${pct(x.blowRate)} |${r.withPolicy ? ` ${pct(r.withPolicy.months[m].passRate)} | ${pct(r.withPolicy.months[m].blowRate)} |` : ''}`),
  ];
  return `${lines.join('\n')}\n`;
}

module.exports = { CONTRACT_SPECS, validateBacktestConfig, barsAt, pickStrategies, runBacktest };
