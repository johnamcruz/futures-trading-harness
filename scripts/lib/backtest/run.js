'use strict';

/**
 * Backtest driver: replays historical bars through the real autonomous loop.
 *
 *   simulated broker (broker.js) behind a loopback ProjectX API (api.js)
 *     <- the runner's REST client      (bar clock, contracts, positions)
 *     <- projectx-mcp via mcp-gateway  (the agents' tools)
 *   simulated clock file               (hooks, gateway, projectx-mcp, CLIs)
 *
 * The runner (runner.js), prompts, harness command, gate, gateway and
 * projectx-mcp are the live ones; only the broker and the clock are
 * simulated. Between cycles the clock jumps straight to the next event.
 * During a harness run it advances with real elapsed time (latency "real"),
 * so the market moves while the agents think, as it would live; latency
 * "none" freezes it instead.
 *
 * All state (journal, gate log, kill switch, bar files, runner state) lives
 * in the run directory (FTH_HOME), never in the live ~/.futures-trading-harness.
 */

const fs = require('fs');
const path = require('path');
const { validateConfig, buildCommand, childEnv, cycleResult, resolveDataDir } = require('../autotrader');
const { createRunner } = require('../runner');
const { createClient } = require('../projectx-rest');
const { loadStrategies, scan } = require('../trading/strategies');
const { readJournal } = require('../trading/journal');
const { writeJsonAtomic, runHarness, entryOrderIds } = require('../harness-run');
const { SimBroker } = require('./broker');
const { createSimServer } = require('./api');
const { loadBars, MINUTE } = require('./data');
const { buildReport, toMarkdown } = require('./report');

/** Tick specs for common CME index futures (overridable per instrument). */
const CONTRACT_SPECS = {
  MNQ: { tickSize: 0.25, tickValue: 0.5, feesPerSide: 0.37 },
  MES: { tickSize: 0.25, tickValue: 1.25, feesPerSide: 0.37 },
  MYM: { tickSize: 1, tickValue: 0.5, feesPerSide: 0.37 },
  M2K: { tickSize: 0.1, tickValue: 0.5, feesPerSide: 0.37 },
  NQ: { tickSize: 0.25, tickValue: 5, feesPerSide: 1.4 },
  ES: { tickSize: 0.25, tickValue: 12.5, feesPerSide: 1.4 },
  YM: { tickSize: 1, tickValue: 5, feesPerSide: 1.4 },
  RTY: { tickSize: 0.1, tickValue: 5, feesPerSide: 1.4 },
};

const BT_DEFAULTS = {
  startingBalance: 50000,
  slippageTicks: 1,
  dailyLossLimit: null,
  maxLossLimit: null,
  latency: 'real',
  outDir: null,
};

function parseIso(value, name) {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) throw new Error(`backtest.${name}: an ISO date or time, e.g. "2025-03-10" or "2025-03-10T13:30:00Z"`);
  return ms;
}

/** Validate the `backtest` block and load data. Returns { bt, instruments }. */
function loadBacktestConfig(raw, cfg, baseDir) {
  const bt = { ...BT_DEFAULTS, ...(raw || {}) };
  const errors = [];
  let startMs;
  let endMs;
  try { startMs = parseIso(bt.start, 'start'); } catch (err) { errors.push(err.message); }
  try { endMs = parseIso(bt.end, 'end'); } catch (err) { errors.push(err.message); }
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs <= startMs) errors.push('backtest.end must be after backtest.start');
  if (!['real', 'none'].includes(bt.latency)) errors.push('backtest.latency: "real" or "none"');
  if (!(bt.startingBalance > 0)) errors.push('backtest.startingBalance: a positive number');
  if (!(bt.slippageTicks >= 0)) errors.push('backtest.slippageTicks: 0 or more');
  for (const k of ['dailyLossLimit', 'maxLossLimit']) if (bt[k] !== null && !(bt[k] > 0)) errors.push(`backtest.${k}: a positive number or null`);
  if (bt.outDir !== null && !path.isAbsolute(String(bt.outDir))) errors.push('backtest.outDir: an absolute path');
  const specs = bt.instruments && typeof bt.instruments === 'object' ? bt.instruments : {};
  const instruments = [];
  for (const symbol of cfg.symbols) {
    const s = { ...(CONTRACT_SPECS[symbol] || {}), ...(specs[symbol] || {}) };
    if (!s.data) { errors.push(`backtest.instruments.${symbol}.data: a 1-minute bar file (JSON or CSV)`); continue; }
    if (!(s.tickSize > 0 && s.tickValue > 0)) { errors.push(`backtest.instruments.${symbol}: tickSize and tickValue (not a known contract)`); continue; }
    const contractId = s.contractId || `CON.F.US.${symbol}.BT`;
    if (String(contractId).split('.')[3] !== symbol) errors.push(`backtest.instruments.${symbol}.contractId: must look like CON.F.US.${symbol}.<month>`);
    instruments.push({ symbol, contractId, tickSize: s.tickSize, tickValue: s.tickValue, feesPerSide: s.feesPerSide ?? 0.37, file: path.resolve(baseDir, s.data) });
  }
  if (errors.length) throw new Error(`invalid backtest config:\n- ${errors.join('\n- ')}`);
  for (const ins of instruments) {
    ins.bars = loadBars(ins.file);
    const inRange = ins.bars.filter(b => b.ms >= startMs && b.ms < endMs).length;
    if (inRange === 0) throw new Error(`${ins.file}: no 1-minute bars between ${bt.start} and ${bt.end}`);
  }
  return { bt: { ...bt, startMs, endMs }, instruments };
}

/** Environment for every process in the replay: simulated broker, clock, and isolated state. */
function backtestEnv(base, { url, home, clockFile }) {
  const env = { ...base };
  for (const k of Object.keys(env)) if (/^PROJECTX_/.test(k) && !/^PROJECTX_(MAX_|ALLOWED_SYMBOLS|MCP_ENTRY)/.test(k)) delete env[k];
  return {
    ...env,
    FTH_HOME: home,
    FTH_BACKTEST: '1',
    FTH_SIM_API_URL: url,
    FTH_SIM_CLOCK_FILE: clockFile,
    PROJECTX_API_URL: url,
    PROJECTX_MARKET_HUB_URL: `${url}/hubs/market`,
    PROJECTX_USERNAME: 'backtest',
    PROJECTX_API_KEY: 'backtest',
    PROJECTX_TRADING_ENABLED: 'true',
    PROJECTX_JOURNAL_PATH: path.join(home, 'journal.jsonl'),
  };
}

/**
 * Run one backtest. `rawConfig` is an autotrader config plus a `backtest`
 * block. Returns { report, runDir }.
 */
async function runBacktest(rawConfig, { root, baseDir = process.cwd(), log = () => {}, runId = null, defaultOutRoot }) {
  const { backtest: rawBt, ...rest } = rawConfig || {};
  const cfg = validateConfig({ ...rest, paper: false, dataDir: null });
  const { bt, instruments } = loadBacktestConfig(rawBt, cfg, baseDir);
  const id = runId || new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = bt.outDir || path.join(defaultOutRoot, id);
  const home = path.join(runDir, 'home');
  const clockFile = path.join(runDir, 'clock');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  const broker = new SimBroker({
    instruments, startMs: bt.startMs, startingBalance: bt.startingBalance, slippageTicks: bt.slippageTicks,
    dailyLossLimit: bt.dailyLossLimit, maxLossLimit: bt.maxLossLimit,
  });
  const writeClock = () => fs.writeFileSync(clockFile, `${new Date(broker.now).toISOString()}\n`);
  const advance = ms => {
    broker.advanceTo(Math.min(bt.endMs, Math.max(broker.now, ms)));
    writeClock();
  };
  writeClock();

  const server = createSimServer(broker);
  const url = await server.listen();
  const env = backtestEnv(process.env, { url, home, clockFile });
  cfg.account = String(broker.account.id);
  const dataDir = resolveDataDir(cfg, undefined, env);
  const killSwitchFile = path.join(home, 'STOP');
  const cycles = { trade: 0, premarket: 0, eod: 0, manage: 0, failed: 0 };
  const logFile = path.join(runDir, 'cycles.log');

  const runCycle = async (action, prompt) => {
    const startedSim = broker.now;
    const startedReal = Date.now();
    const argv = buildCommand(cfg, prompt, root, env);
    const ticker = bt.latency === 'real' ? setInterval(() => advance(startedSim + (Date.now() - startedReal)), 200) : null;
    let res;
    try {
      res = await runHarness(argv, { cwd: path.resolve(root, cfg.workdir), env: childEnv(cfg, root, env), timeoutMs: cfg.cycleTimeoutMinutes * 60000 });
    } finally {
      if (ticker) clearInterval(ticker);
    }
    if (bt.latency === 'real') advance(startedSim + (Date.now() - startedReal));
    cycles[action] = (cycles[action] || 0) + 1;
    if (!res.ok) cycles.failed += 1;
    const result = cycleResult(res.output) || (res.ok ? 'CYCLE RESULT: (none reported)' : `CYCLE RESULT: error - ${res.timedOut ? 'timed out' : `exit ${res.code}`}`);
    fs.appendFileSync(logFile, `\n===== ${new Date(startedSim).toISOString()} ${action} (${Math.round((Date.now() - startedReal) / 1000)}s)\n${res.output}\n`);
    log(`${new Date(startedSim).toISOString()} ${action}: ${result}`);
    return { ok: res.ok, timedOut: res.timedOut };
  };

  const strategies = loadStrategies(root, env).strategies.filter(s => s.timeframe === `${cfg.timeframe}m`);
  let state = null;
  const runner = createRunner({
    cfg,
    root,
    client: createClient({ env }),
    clock: { now: () => new Date(broker.now) },
    runCycle,
    isKillSwitchOn: () => fs.existsSync(killSwitchFile),
    createKillSwitch: reason => fs.writeFileSync(killSwitchFile, `${reason}\n`),
    loadState: () => state,
    saveState: s => { state = s; writeJsonAtomic(path.join(home, 'autotrader-state.json'), s); },
    writeBars: (sym, bars) => {
      const file = path.join(dataDir, `${sym.symbol}-${cfg.timeframe}m.json`);
      writeJsonAtomic(file, { contractId: sym.contractId, barSize: `${cfg.timeframe} minute`, count: bars.length, bars });
      return file;
    },
    scanFor: (symbol, bars) => scan(strategies, { bars }, { symbol, now: new Date(broker.now) }),
    log: msg => log(`${new Date(broker.now).toISOString()} ${msg}`),
    entryOrderIds: () => entryOrderIds(home),
  });

  let stopped = null;
  try {
    while (broker.now < bt.endMs) {
      if (fs.existsSync(killSwitchFile)) {
        stopped = `kill switch: ${fs.readFileSync(killSwitchFile, 'utf8').trim()}`;
        break;
      }
      const ms = await runner.step();
      advance(broker.now + Math.max(ms, 1000));
    }
  } finally {
    await server.close();
  }
  broker.flattenAll('end of backtest');

  const journal = readJournal(path.join(home, 'journal.jsonl'));
  const report = buildReport({
    broker,
    journal,
    cycles,
    meta: {
      runId: id, harness: cfg.harness, symbols: cfg.symbols, timeframe: cfg.timeframe, trigger: cfg.trigger,
      start: new Date(bt.startMs).toISOString(), end: new Date(bt.endMs).toISOString(), latency: bt.latency,
      slippageTicks: bt.slippageTicks, stopped,
    },
  });
  writeJsonAtomic(path.join(runDir, 'report.json'), report);
  fs.writeFileSync(path.join(runDir, 'report.md'), toMarkdown(report));
  return { report, runDir };
}

module.exports = { CONTRACT_SPECS, loadBacktestConfig, backtestEnv, runBacktest, MINUTE };
