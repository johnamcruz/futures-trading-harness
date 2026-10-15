'use strict';

/**
 * The evaluator run behind scripts/evaluate.js: a policy strategy on bar files over one window of the
 * schedule, through both layers (prop/trade-stream.js, prop/evaluator.js). The window is checked (and a
 * held-out look logged to the ledger file) before any bar is read.
 *
 * Config: { prop (a policy strategy), symbols, data ({ SYMBOL: file }, at the policy's timeframe; bars a broker
 * fetch kept its fields on), from, to (session dates, to exclusive), seed, paths, meanBlock, reps, every,
 * cuts, entryDelayMs, faults: { stopFault, outage, measured }, facts (default true), look: { candidate,
 * purpose } and ledger (the look ledger file, prop/ledger-file.js, appended to) for a window outside train, and any backtest option
 * (gate, sessions, eodAt, slippageTicks, fill, window, ...) }.
 */

const fs = require('fs');
const path = require('path');
const { validateBacktestConfig, barsAt, policyStrategy, WARMUP_BARS } = require('../backtest/run');
const { auditBars } = require('../backtest/data');
const { fieldPaths } = require('../backtest/bar-fields');
const { tradesRoot } = require('../trading/strategies');
const { accountNamed } = require('../trading/accounts');
const { loadConfig } = require('../trading/config');
const { tradeStream } = require('./trade-stream');
const { checkWindow, scoreStream, sessionStart } = require('./evaluator');
const { readLedger, appendLook, withLedgerLock } = require('./ledger-file');

/** Run the evaluator. Returns the result (prop/evaluator.js scoreStream) with the run's provenance. */
function runEvaluation(raw, { root, baseDir = process.cwd(), env = process.env, log = () => {} }) {
  const r = { ...(raw || {}) };
  if (!r.prop) throw new Error('prop: the policy strategy to evaluate (signal: policy)');
  const ledgerFile = r.ledger ? path.resolve(baseDir, r.ledger) : null;
  // The ledger is read only for a look (train needs none, so a ledger named in a config never blocks it).
  if (ledgerFile && r.look && r.newLedger === true) fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const check = () => checkWindow({
    from: r.from, to: r.to, look: r.look || null,
    ledger: ledgerFile && r.look ? readLedger(ledgerFile, { create: r.newLedger === true }) : null,
    logLook: ledgerFile ? entry => appendLook(ledgerFile, entry) : null,
  });
  const pass = ledgerFile && r.look ? withLedgerLock(ledgerFile, check) : check();
  if (pass.look) log(`look logged to ${ledgerFile}: ${pass.look.candidate} (${pass.look.purpose}) ${r.from}..${r.to}`);
  const p = policyStrategy(root, r.prop, env);
  const timeframe = Number.parseInt(p.strategy.timeframe, 10);
  const { prop: _p, from: _f, to: _t, seed, paths, meanBlock, reps, every, cuts, entryDelayMs = 0, faults, facts = true, look: _l, ledger: _g, newLedger: _n, ...bt } = r;
  const account = accountNamed(root, p.strategy.account, env);
  // Priced with the account's fees; its limits are its own (the backtest's maxDailyLoss and maxContracts are refused).
  const cfg = validateBacktestConfig({ ...bt, timeframe, start: r.from, end: r.to }, baseDir, { account });
  const traded = p.components.map(c => c.name);
  const startMs = sessionStart(r.from);
  const endMs = sessionStart(r.to);
  const markets = cfg.markets.map(m => {
    const readers = p.components.filter(s => fieldPaths(s).length && tradesRoot(s, m.symbol, [m.symbol])).map(s => s.name);
    let bars = barsAt(m.file, timeframe, m.sheet, { readers, log });
    const first = bars.findIndex(b => Date.parse(b.t) >= startMs);
    const last = bars.findIndex(b => Date.parse(b.t) >= endMs);
    if (first === -1 || first === last) throw new Error(`${m.file}: no ${timeframe}m bar in the window ${r.from}..${r.to}`);
    bars = bars.slice(Math.max(0, (first === -1 ? bars.length : first) - cfg.window - WARMUP_BARS), last === -1 ? bars.length : last);
    for (const w of auditBars(bars, timeframe).warnings) log(`warning: ${m.symbol} data: ${w}`);
    if (bars.length < cfg.window) throw new Error(`${m.file}: only ${bars.length} bars up to the window's end; need at least ${cfg.window}`);
    return { ...m, bars };
  });
  for (const x of p.leftOut) log(`${r.prop}: leaves out ${x.name}: ${x.why}`);
  log(`layer 1: ${traded.join(', ')} on ${markets.map(m => `${m.symbol} (${m.bars.length} ${timeframe}m bars)`).join(', ')}, ${r.from}..${r.to}`);
  const stream = tradeStream({
    markets, strategies: p.counted, prop: { strategy: p.strategy, components: traded, contracts: p.strategy.contracts || 'auto' },
    engine: { ...cfg, account: null, prop: null, gateConfig: loadConfig(env) }, from: startMs, to: endMs, facts, entryDelayMs,
  });
  log(`layer 1: ${stream.trades.length} trades over ${stream.days.length} trading days in ${stream.runtimeMs} ms`);
  const result = scoreStream(stream, {
    pass, account, rulebook: { sizing: p.strategy.sizing || null }, contracts: p.strategy.contracts || 'auto',
    ...(seed !== undefined ? { seed } : {}), ...(paths !== undefined ? { paths } : {}), ...(meanBlock !== undefined ? { meanBlock } : {}),
    ...(reps !== undefined ? { reps } : {}), ...(every !== undefined ? { every } : {}), ...(cuts !== undefined ? { cuts } : {}),
    ...(faults ? { faults } : {}),
  });
  log(`layer 2: ${result.real.attempts} real attempts, ${result.resampled.paths} resampled paths in ${result.runtimeMs.layer2} ms`);
  return {
    prop: r.prop, account: account.name, symbols: cfg.symbols, timeframe, strategies: traded, trades: stream.trades.length,
    factsErrors: stream.trades.filter(t => t.facts && t.facts.error).length, ...result,
  };
}

module.exports = { readLedger, appendLook, withLedgerLock, runEvaluation };
