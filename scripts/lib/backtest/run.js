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
 */

const fs = require('fs');
const path = require('path');
const { loadStrategies } = require('../trading/strategies');
const { loadBars, barMinutes, aggregate } = require('./data');
const { runEngine, DEFAULTS } = require('./engine');
const { buildReport, toMarkdown, toCsv } = require('./report');
const { writeJsonAtomic } = require('../harness-run');
const { loadConfig } = require('../trading/config');
const { parseWindows } = require('../trading/clock');
const { marketHoursErrors } = require('../autotrader');

const WARMUP_BARS = 2000;

/** Tick specs for common CME futures (overridable per symbol). */
const CONTRACT_SPECS = {
  MNQ: { tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 },
  MES: { tickSize: 0.25, tickValue: 1.25, feesPerSide: 0.37 },
  MYM: { tickSize: 1, tickValue: 0.5, feesPerSide: 0.37 },
  M2K: { tickSize: 0.1, tickValue: 0.5, feesPerSide: 0.37 },
  MGC: { tickSize: 0.1, tickValue: 1, feesPerSide: 0.37 },
  NQ: { tickSize: 0.25, tickValue: 5, feesPerSide: 1.4 },
  ES: { tickSize: 0.25, tickValue: 12.5, feesPerSide: 1.4 },
  YM: { tickSize: 1, tickValue: 5, feesPerSide: 1.4 },
  RTY: { tickSize: 0.1, tickValue: 5, feesPerSide: 1.4 },
  GC: { tickSize: 0.1, tickValue: 10, feesPerSide: 1.4 },
};

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

/** Validate a backtest config. Returns the normalized settings. */
function validateBacktestConfig(raw, baseDir) {
  const cfg = { ...DEFAULTS, timeframe: 3, symbols: ['MNQ'], strategies: null, outDir: null, ...(raw || {}) };
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
  if (!(cfg.slippageTicks >= 0)) errors.push('slippageTicks: 0 or more');
  if (!(cfg.maxDailyLoss >= 0)) errors.push('maxDailyLoss: dollars, 0 for off');
  if (cfg.feesPerSide !== null && !(cfg.feesPerSide >= 0)) errors.push('feesPerSide: dollars per contract per side');
  if (!(Number.isInteger(cfg.window) && cfg.window >= 160)) errors.push('window: bars of history per evaluation, at least 160');
  if (cfg.outDir !== null && typeof cfg.outDir !== 'string') errors.push('outDir: a directory');
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

/** Run a backtest. Returns { report, runDir }. */
function runBacktest(raw, { root, baseDir = process.cwd(), outRoot, env = process.env, runId = null, log = () => {} }) {
  const cfg = validateBacktestConfig(raw, baseDir);
  const strategies = pickStrategies(loadStrategies(root, env).strategies, cfg);
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
  const { trades, skipped } = runEngine(markets, strategies, { ...cfg, gateConfig: loadConfig(env) });
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
    slippageTicks: cfg.slippageTicks, skipped,
  });
  const runDir = cfg.outDir ? path.resolve(baseDir, cfg.outDir) : path.join(outRoot, id);
  fs.mkdirSync(runDir, { recursive: true });
  writeJsonAtomic(path.join(runDir, 'report.json'), report);
  fs.writeFileSync(path.join(runDir, 'report.md'), toMarkdown(report));
  fs.writeFileSync(path.join(runDir, 'trades.csv'), toCsv(report.trades));
  return { report, runDir };
}

module.exports = { CONTRACT_SPECS, validateBacktestConfig, barsAt, pickStrategies, runBacktest };
