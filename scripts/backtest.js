#!/usr/bin/env node
/**
 * Backtest STRATEGY.md strategies on historical bars (Parquet, Excel, CSV, or
 * JSON), the way algoTraderBot backtests: after every closed bar, settle the
 * open trade, trail its stop, and check every strategy for an entry, with the
 * same rules evaluation the live scan uses. See docs/BACKTESTING.md.
 *
 *   node scripts/backtest.js --config backtest.json
 *   node scripts/backtest.js --data data/NQ_3min.parquet --symbol MNQ [--timeframe 3]
 *       [--start 2025-01-01] [--end 2025-04-01] [--strategy orb,supertrend]
 *       [--no-gate] [--size 1 | --risk 200] [--slippage 1] [--out dir]
 *       [--prop <policy strategy> [--bundle <name>] [--every 5]]   prop challenge attempts
 *   node scripts/backtest.js fetch --contract CON.F.US.MNQ.H25 --from 2025-03-03 --to 2025-03-15 --out data/MNQ-1m.csv
 *
 * `fetch` downloads 1-minute bars from ProjectX (PROJECTX_USERNAME /
 * PROJECTX_API_KEY) to CSV or JSON; backtests themselves only read files.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { runBacktest } = require('./lib/backtest/run');
const { createClient } = require('./lib/projectx-rest');
const { harnessHome } = require('./lib/paths');
const { writeJsonAtomic } = require('./lib/harness-run');

const ROOT = path.resolve(__dirname, '..');

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

async function fetchBars(argv) {
  const contractId = arg(argv, '--contract');
  const from = new Date(arg(argv, '--from') || '');
  const to = new Date(arg(argv, '--to') || '');
  const out = arg(argv, '--out');
  if (!contractId || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || !out) {
    throw new Error('usage: backtest.js fetch --contract <id> --from <ISO> --to <ISO> --out <file.csv|file.json>');
  }
  const bars = await createClient().history(contractId, { start: from, end: to });
  const file = path.resolve(out);
  if (file.endsWith('.csv')) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `time,open,high,low,close,volume\n${bars.map(b => [b.t, b.o, b.h, b.l, b.c, b.v].join(',')).join('\n')}\n`);
  } else {
    writeJsonAtomic(file, { contractId, barSize: '1 minute', count: bars.length, bars });
  }
  process.stdout.write(`[backtest] wrote ${bars.length} 1-minute bars for ${contractId} to ${out}\n`);
  return 0;
}

/** Build a config from command-line flags (or merge them over --config). */
function configFrom(argv) {
  const file = arg(argv, '--config');
  const cfg = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const symbol = arg(argv, '--symbol');
  const data = arg(argv, '--data');
  if (symbol) cfg.symbols = [symbol];
  if (data) cfg.data = { ...(cfg.data || {}), [(cfg.symbols || ['MNQ'])[0]]: path.resolve(data) }; // relative to where you run it
  const num = name => (arg(argv, name) === undefined ? undefined : Number(arg(argv, name)));
  if (num('--timeframe') !== undefined) cfg.timeframe = num('--timeframe');
  if (arg(argv, '--start')) cfg.start = arg(argv, '--start');
  if (arg(argv, '--end')) cfg.end = arg(argv, '--end');
  if (arg(argv, '--strategy')) cfg.strategies = arg(argv, '--strategy').split(',').map(s => s.trim()).filter(Boolean);
  if (argv.includes('--no-gate')) cfg.gate = false;
  if (num('--size') !== undefined && num('--risk') !== undefined) throw new Error('use either --size or --risk, not both');
  if (num('--size') !== undefined) { cfg.size = num('--size'); cfg.riskPerTrade = null; }
  if (num('--risk') !== undefined) { cfg.riskPerTrade = num('--risk'); delete cfg.size; }
  if (num('--slippage') !== undefined) cfg.slippageTicks = num('--slippage');
  if (arg(argv, '--out')) cfg.outDir = path.resolve(arg(argv, '--out'));
  if (arg(argv, '--prop')) cfg.prop = arg(argv, '--prop');
  if (arg(argv, '--bundle')) cfg.bundle = arg(argv, '--bundle');
  if (num('--every') !== undefined) cfg.every = num('--every');
  return { cfg, baseDir: file ? path.dirname(path.resolve(file)) : process.cwd() };
}

// Every flag the backtest takes: a misspelt one (--strategies) must not run everything silently.
const VALUE_FLAGS = ['--config', '--symbol', '--data', '--timeframe', '--start', '--end', '--strategy', '--size', '--risk', '--slippage', '--out', '--prop', '--bundle', '--every'];
const BOOL_FLAGS = ['--no-gate'];

function unknownFlags(argv) {
  const bad = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (VALUE_FLAGS.includes(argv[i])) i += 1;
    else if (!BOOL_FLAGS.includes(argv[i])) bad.push(argv[i]);
  }
  return bad;
}

async function main(argv) {
  if (argv[0] === 'fetch') return fetchBars(argv.slice(1));
  const bad = unknownFlags(argv);
  if (bad.length) throw new Error(`unknown argument${bad.length > 1 ? 's' : ''}: ${bad.join(' ')} (flags: ${[...VALUE_FLAGS, ...BOOL_FLAGS].join(' ')})`);
  if (!arg(argv, '--config') && !arg(argv, '--data')) {
    throw new Error('usage: backtest.js --config <backtest.json> | --data <bars file> --symbol MNQ [options] | fetch ...');
  }
  const { cfg, baseDir } = configFrom(argv);
  const log = msg => process.stdout.write(`[backtest] ${msg}\n`);
  const started = Date.now();
  const { report, runDir } = runBacktest(cfg, { root: ROOT, baseDir, outRoot: path.join(harnessHome(), 'backtests'), log });
  if (report.baseline) {
    const pct = x => (x === null ? '-' : `${Math.round(x * 100)}%`);
    const line = (label, x) => log(`${label}: ${x.attempts} attempts | pass ${pct(x.passRate)} | win rate ${pct(x.winRate)} | blow ${pct(x.blowRate)} | timeout ${x.timeout} | median days to pass ${x.medianDaysToPass ?? '-'} | avg profit $${x.avgProfit}`);
    line(`${report.prop} on ${report.account}, rules only`, report.baseline);
    if (report.withPolicy) line(`${report.account} policy ${report.policy}`, report.withPolicy);
    log(`report: ${path.join(runDir, 'combine.md')}`);
    return 0;
  }
  const s = report.summary;
  const pct = x => (x === null ? '-' : `${Math.round(x * 100)}%`);
  log(`${s.trades} trades | win ${pct(s.winRate)} | mean ${s.meanR ?? '-'}R | sum ${s.sumR ?? '-'}R | PF ${s.profitFactorR ?? '-'} | net $${s.netPnL ?? 0} | max DD $${s.maxDrawdown} | ${((Date.now() - started) / 1000).toFixed(1)} s`);
  for (const [name, x] of Object.entries(report.byStrategy)) {
    log(`  ${name.padEnd(12)} n=${String(x.trades).padEnd(4)} win=${pct(x.winRate).padEnd(4)} meanR=${x.meanR} sumR=${x.sumR}`);
  }
  log(`report: ${path.join(runDir, 'report.md')}`);
  return 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[backtest] ${err.message}\n`);
  process.exitCode = 1;
});
