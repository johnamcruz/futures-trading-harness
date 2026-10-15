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
 *   walkForward  { grid: { "<param>": [values] }, trainMonths, testMonths,
 *                minTrades }: walk-forward test of the one strategy named in
 *                `strategies` (walk-forward.js); writes walk-forward.md/json
 *   debug        a strategy name: write its verdict on every bar (fired or
 *                not, the rules that failed, its detectors' state) to
 *                decisions-<name>.jsonl in the run folder
 *
 * Every run writes trades.jsonl next to trades.csv: each trade with the setup
 * behind it (stop and target distances, detector state on the signal bar).
 *
 * The prop runs (`prop`, `every`: combine attempts of a policy strategy) are retired
 * (docs/BACKTESTING.md, "Prop challenges (retired)"). policyStrategy, barsAt and
 * validateBacktestConfig stay: the two-layer evaluator (prop/evaluate-run.js) uses them.
 */

const fs = require('fs');
const path = require('path');
const { loadStrategies, tradesRoot, componentRefusal, retiredNote } = require('../trading/strategies');
const { loadBars, barMinutes, aggregate, auditBars, extraKeys } = require('./data');
const { runEngine, prepare, DEFAULTS } = require('./engine');
const { summarizeResult } = require('../trading/scan-log');
const { buildReport, toMarkdown, toCsv } = require('./report');
const trackRecord = require('../trading/track-record');
const { harnessHome } = require('../paths');
const { writeJsonAtomic } = require('../harness-run');
const { loadConfig } = require('../trading/config');
const { parseWindows } = require('../trading/clock');
const { CONTRACT_SPECS, parseSelection } = require('../trading/contracts');
const { feePerSide } = require('../trading/accounts');
const { marketHoursErrors } = require('../autotrader');
const walkForward = require('./walk-forward');
const { fieldPaths, fieldCoverage, describeMissing, describeCoverage } = require('./bar-fields');

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

/** Validate a backtest config (`account`: a policy run's account profile, whose fees it prices with). Returns the normalized settings. */
function validateBacktestConfig(raw, baseDir, { account = null } = {}) {
  for (const k of ['account', 'policy', 'sizing']) {
    if (raw && raw[k] !== undefined && raw[k] !== null) {
      throw new Error(`invalid backtest config:\n- ${k}: comes from a policy strategy (signal: policy); the backtester's prop runs are retired`);
    }
  }
  if (raw && raw.bundle !== undefined) throw new Error('invalid backtest config:\n- bundle: trained policy bundles are retired');
  // A policy run's limits are its account's (ACCOUNT.md max_contracts, daily_loss_limit; RULEBOOK.md daily_loss_soft): the
  // plain run's backtest-only maxDailyLoss and maxContracts are never used for it, so stating one is refused.
  for (const k of account ? ['maxDailyLoss', 'maxContracts'] : []) {
    if (raw && raw[k] !== undefined) throw new Error(`invalid backtest config:\n- ${k}: a policy run's limits are its account's (${account.name}: ACCOUNT.md and RULEBOOK.md), not the backtest's`);
  }
  for (const k of ['prop', 'every']) {
    if (raw && raw[k] !== undefined && raw[k] !== null) throw new Error(`invalid backtest config:\n- ${k}: the backtester's prop runs are retired (docs/BACKTESTING.md, "Prop challenges (retired)")`);
  }
  const cfg = { ...DEFAULTS, timeframe: 3, symbols: ['MNQ'], strategies: null, outDir: null, debug: null, walkForward: null, record: false, ...(raw || {}) };
  const errors = [];
  if (!Number.isInteger(cfg.timeframe) || cfg.timeframe < 1 || cfg.timeframe > 60) errors.push('timeframe: minutes per bar, 1 to 60');
  if (!Array.isArray(cfg.symbols) || !cfg.symbols.length || !cfg.symbols.every(s => /^[A-Z0-9]+$/.test(s))) errors.push('symbols: e.g. ["MNQ"]');
  // One contract per index, as the runner selects (micro or mini): each symbol is a selected contract.
  else if (parseSelection(cfg.symbols.join(',')).error) errors.push('symbols: one contract per index (MNQ or NQ, not both), as the runner trades');
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
  if (!['reversal', 'priority', 'skip'].includes(cfg.conflict)) errors.push('conflict: "reversal" (as live: only a reversal strategy enters when strategies disagree), "skip", or "priority" (the first strategy in order trades)');
  if (!['next-open', 'close'].includes(cfg.fill)) errors.push('fill: "next-open" (entries fill at the next bar\'s open, as live after the cycle) or "close" (at the signal bar\'s close, as the original bot)');
  if (!(cfg.maxDailyLoss >= 0)) errors.push('maxDailyLoss: dollars, 0 for off');
  if (cfg.feesPerSide !== null && !(cfg.feesPerSide >= 0)) errors.push('feesPerSide: dollars per contract per side');
  if (!(Number.isInteger(cfg.window) && cfg.window >= 160)) errors.push('window: bars of history per evaluation, at least 160');
  if (cfg.outDir !== null && typeof cfg.outDir !== 'string') errors.push('outDir: a directory');
  if (typeof cfg.record !== 'boolean') errors.push('record: true or false (record each strategy\'s track record for the cycle prompt)');
  if (cfg.record === true && cfg.walkForward) errors.push('record: plain runs only (not with walkForward)');
  if (cfg.debug !== null && !(typeof cfg.debug === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(cfg.debug))) errors.push('debug: a strategy name, to log its verdict on every bar');
  if (cfg.walkForward !== null) {
    const w = cfg.walkForward;
    if (!w || typeof w !== 'object' || Array.isArray(w)) errors.push('walkForward: { grid, trainMonths, testMonths, minTrades }');
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
    // A fee is never assumed. A plain run states it: the symbol's own, else the run-wide one. A policy's run
    // (`account`) takes its account's (ACCOUNT.md fees_per_side) and refuses one stated here (one home).
    const own = typeof d === 'object' && d && d.feesPerSide !== undefined ? d.feesPerSide : null;
    let fee = own ?? cfg.feesPerSide;
    if (account) {
      if (fee !== null && fee !== undefined) { errors.push(`data.${symbol}.feesPerSide and feesPerSide: a policy run's fees are its account's (${account.name} ACCOUNT.md fees_per_side)`); continue; }
      fee = feePerSide(account, symbol);
      if (fee === null) { errors.push(`data.${symbol}: no fees_per_side.${symbol} in the ${account.name} profile (ACCOUNT.md); a fee is never assumed`); continue; }
    } else if (!(typeof fee === 'number' && Number.isFinite(fee) && fee >= 0)) {
      errors.push(`feesPerSide: no fee for ${symbol}; state the fee per contract per side (run-wide feesPerSide, or data.${symbol}.feesPerSide): a fee is never assumed`);
      continue;
    }
    markets.push({ symbol, file: path.resolve(baseDir, file), sheet: spec.sheet || null, tickSize: spec.tickSize, tickValue: spec.tickValue, feesPerSide: fee });
  }
  if (errors.length) throw new Error(`invalid backtest config:\n- ${errors.join('\n- ')}`);
  return { ...cfg, start, end, markets };
}

/**
 * Bars at the trading timeframe: as given, or aggregated from finer bars. The harness can't combine
 * the broker's own fields into a longer bar: finer bars that carry them are refused when a strategy
 * here (`readers`: their names) reads broker fields, and otherwise built with them dropped, said in
 * the log. Fetch bars at the timeframe from the broker to keep them.
 */
function barsAt(file, timeframe, sheet, { readers = [], log = () => {} } = {}) {
  const raw = loadBars(file, { sheet });
  if (raw.length < 2) throw new Error(`${file}: not enough bars`);
  const step = barMinutes(raw);
  if (step === timeframe) return raw;
  if (step > timeframe || timeframe % step !== 0) {
    throw new Error(`${file}: ${step}-minute bars can't make ${timeframe}-minute bars (need ${timeframe}-minute data or a divisor of it)`);
  }
  const extra = extraKeys(raw);
  const fetch = `fetch ${timeframe}-minute bars from the broker instead (backtest.js fetch --contract <symbol> --timeframe ${timeframe} --from <date> --to <date> --out <file>.jsonl)`;
  if (extra.length && readers.length) {
    throw new Error(`${file}: its ${step}-minute bars carry the broker's own fields (${extra.slice(0, 5).join(', ')}), which the harness can't combine into ${timeframe}-minute bars, and ${readers.join(', ')} read${readers.length === 1 ? 's' : ''} broker fields: ${fetch}`);
  }
  if (extra.length) log(`warning: ${file}: building ${timeframe}-minute bars from ${step}-minute ones drops the broker's own fields (${extra.slice(0, 5).join(', ')}): no strategy here reads them; to keep them, ${fetch}`);
  const last = raw[raw.length - 1];
  return aggregate(raw, { unit: 2, unitNumber: timeframe, nowMs: last.ms + step * 60000, extraFields: 'drop' });
}

function pickStrategies(all, cfg) {
  const tf = `${cfg.timeframe}m`;
  if (cfg.strategies) {
    return cfg.strategies.map(name => {
      const s = all.find(x => x.name === name);
      if (!s) throw new Error(`unknown strategy "${name}"${retiredNote(name)}`);
      if (!s.valid) throw new Error(`strategy "${name}" is invalid: ${s.errors[0]}`);
      if (s.timeframe !== tf) throw new Error(`strategy "${name}" trades ${s.timeframe}; this backtest runs ${tf} bars`);
      return s;
    });
  }
  return all.filter(s => s.valid && s.status !== 'disabled' && s.timeframe === tf && s.signal !== 'manual' && s.signal !== 'composed');
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
    ...w, from, to, engine: { ...cfg, account: null, gateConfig: loadConfig(env) },
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
  const strategies = pickStrategies(loadStrategies(root, env).strategies, cfg);
  if (!strategies.length) throw new Error(`no mechanical strategy trades ${cfg.timeframe}m bars`);
  // Keep the window plus a warm-up before `start`, and nothing after `end`:
  // indicators settle well within that, and a long file stays fast.
  const markets = cfg.markets.map(m => {
    log(`loading ${m.symbol} from ${m.file}`);
    const readers = strategies.filter(s => fieldPaths(s).length && tradesRoot(s, m.symbol, [m.symbol])).map(s => s.name);
    let bars = barsAt(m.file, cfg.timeframe, m.sheet, { readers, log });
    const ms = b => Date.parse(b.t);
    const first = cfg.start === null ? 0 : bars.findIndex(b => ms(b) >= cfg.start);
    const from = cfg.start === null ? 0 : Math.max(0, (first === -1 ? bars.length : first) - cfg.window - WARMUP_BARS);
    const to = cfg.end === null ? bars.length : bars.findIndex(b => ms(b) >= cfg.end);
    bars = bars.slice(from, to === -1 ? bars.length : to);
    const audit = auditBars(bars, cfg.timeframe);
    for (const w of audit.warnings) log(`warning: ${m.symbol} data: ${w}`);
    m.audit = audit;
    if (bars.every(b => !(b.v > 0))) log(`warning: ${m.file} has no volume (no volume column, or all zero); vol_sma is missing, so strategies using it never fire`);
    if (bars.length < cfg.window) throw new Error(`${m.file}: only ${bars.length} bars in range; need at least ${cfg.window} (window) before the first trade`);
    return { ...m, bars };
  });
  log(`${strategies.map(s => s.name).join(', ')} on ${markets.map(m => `${m.symbol} (${m.bars.length} ${cfg.timeframe}m bars)`).join(', ')}`);
  for (const m of markets) {
    if (!strategies.some(s => tradesRoot(s, m.symbol, [m.symbol]))) {
      log(`warning: no selected strategy lists ${m.symbol} (or the micro or mini of its family) in its instruments, so it can't trade`);
    }
  }
  // Broker bar fields a traded strategy reads: the share of the bars in range that carry each, and a warning
  // for each one some market carries on under 100% of them; said in the log and the report.
  const fieldsCovered = fieldCoverage(strategies, markets, (s, sym) => tradesRoot(s, sym, [sym]), { from: cfg.start });
  const missingFields = fieldsCovered.filter(x => x.symbols.length);
  for (const x of fieldsCovered) log(`field coverage: ${describeCoverage(x)}`);
  for (const x of missingFields) log(`warning: ${describeMissing(x)}`);
  if (cfg.debug && !strategies.some(s => s.name === cfg.debug)) throw new Error(`debug: ${cfg.debug} is not among the strategies this run trades (${strategies.map(s => s.name).join(', ')})`);
  if (cfg.walkForward) return runWalk(cfg, strategies[0], markets, { baseDir, outRoot, env, runId, log });
  const { trades, skipped, expired } = runEngine(markets, strategies, { ...cfg, account: null, gateConfig: loadConfig(env) });
  for (const m of markets) {
    if (!strategies.some(s => tradesRoot(s, m.symbol, [m.symbol]))) skipped[m.symbol] = 'no selected strategy trades this symbol';
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
  if (fieldsCovered.length) report.fieldCoverage = fieldsCovered;
  if (missingFields.length) report.missingFields = missingFields;
  const runDir = cfg.outDir ? path.resolve(baseDir, cfg.outDir) : path.join(outRoot, id);
  fs.mkdirSync(runDir, { recursive: true });
  writeJsonAtomic(path.join(runDir, 'report.json'), report);
  fs.writeFileSync(path.join(runDir, 'report.md'), toMarkdown(report) + fieldsMarkdown(fieldsCovered, missingFields));
  fs.writeFileSync(path.join(runDir, 'trades.csv'), toCsv(report.trades));
  fs.writeFileSync(path.join(runDir, 'trades.jsonl'), report.trades.map(t => JSON.stringify(t)).join('\n') + (report.trades.length ? '\n' : ''));
  if (cfg.record) {
    // The track record the cycle prompt shows next to each strategy that fires (trading/track-record.js).
    const home = harnessHome(env);
    for (const s of strategies) {
      // Its own record: the strategy alone (in a joint run strategies compete for one position).
      // Alone, confluence can't be required (one strategy never agrees with another).
      const alone = strategies.length === 1 && !(cfg.minConfluence > 1) ? report
        : buildReport(runEngine(markets, [s], { ...cfg, minConfluence: 1, account: null, gateConfig: loadConfig(env) }).trades, report.meta);
      const rec = trackRecord.fromReport(alone, s.name, { file: s.file });
      const file = trackRecord.writeRecord(home, rec);
      log(`track record: ${s.name} ${rec.summary.trades} trades, E ${rec.summary.meanR === null ? '?' : rec.summary.meanR}R (${rec.summary.edge}) -> ${file}`);
    }
  }
  if (cfg.debug) {
    const file = path.join(runDir, `decisions-${cfg.debug}.jsonl`);
    const n = writeDecisions(file, markets, strategies.find(s => s.name === cfg.debug), cfg);
    log(`debug: ${cfg.debug}'s verdict on ${n} bars in ${file}`);
  }
  return { report, runDir };
}

/**
 * The policy strategy `name`, checked, with the strategies it trades (in its order), the ones
 * it leaves out with why, and the ones that count toward confluence and conflict. As live
 * (strategies.js componentRefusal, the runner's screen and the gate): an active policy trades
 * only its active strategies; one that isn't active runs only in a paper run, which takes any
 * non-disabled one. A left-out paper strategy still fires in the scan, so it still counts
 * (`counted`: every listed one a paper run could trade); only the pick skips it.
 */
function policyStrategy(root, name, env = process.env) {
  const all = loadStrategies(root, env).strategies;
  const s = all.find(x => x.name === name);
  if (!s) throw new Error(`prop: ${name} is not a strategy (strategies/${name}/STRATEGY.md)`);
  if (s.signal !== 'policy') throw new Error(`prop: ${name} is signal: ${s.signal}; a prop run needs a policy strategy (signal: policy)`);
  if (!s.valid) throw new Error(`prop: ${name} is invalid (${s.errors[0]})`);
  const paper = s.status !== 'active';
  const left = s.strategies.map(n => ({ name: n, why: componentRefusal(s, all, n, { paper }) })).filter(x => x.why);
  const components = s.strategies.filter(n => !left.some(x => x.name === n)).map(n => all.find(x => x.name === n));
  if (!components.length) throw new Error(`prop: ${name} trades none of its strategies (${left.map(x => x.why).join('; ')})`);
  const counted = s.strategies.filter(n => !componentRefusal(s, all, n, { paper: true })).map(n => all.find(x => x.name === n));
  return { strategy: s, components, counted, leftOut: left };
}

/** The report's sections on the broker bar fields its strategies read: coverage, and the ones not on every bar ('' with none). */
function fieldsMarkdown(covered, missing) {
  if (!covered.length) return '';
  const pct = (x) => `${Math.floor((x.bars ? x.carried / x.bars : 0) * 1000) / 10}%`;
  const rows = covered.flatMap(c => Object.entries(c.coverage).map(([sym, x]) => `| ${c.strategy} | \`${c.path}\` | ${sym} | ${pct(x)} | ${x.carried} / ${x.bars} |`));
  const table = `\n## Bar field coverage\n\nThe share of the bars in range that carry each broker field a traded strategy reads.\n\n| Strategy | Field | Market | Coverage | Bars |\n|---|---|---|---|---|\n${rows.join('\n')}\n`;
  return table + (missing.length ? `\n## Bar fields missing from this data\n\n${missing.map(x => `- ${describeMissing(x)}.`).join('\n')}\n` : '');
}

module.exports = { CONTRACT_SPECS, WARMUP_BARS, validateBacktestConfig, barsAt, pickStrategies, policyStrategy, runBacktest };
