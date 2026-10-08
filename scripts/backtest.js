#!/usr/bin/env node
/**
 * Backtest the autonomous harness on historical bars. The agents, skills,
 * strategies, order gate, MCP gateway, projectx-mcp, and runner are the live
 * ones; the broker is a simulated ProjectX API on loopback and the clock is
 * simulated, so the harness can't tell a replay from the market. See
 * docs/BACKTESTING.md.
 *
 *   node scripts/backtest.js --config backtest.json
 *   node scripts/backtest.js fetch --contract CON.F.US.MNQ.H25 --from 2025-03-03 --to 2025-03-15 --out data/MNQ-1m.json
 *
 * `fetch` downloads 1-minute bars from the real ProjectX API
 * (PROJECTX_USERNAME / PROJECTX_API_KEY); the backtest itself never touches
 * the real API.
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
    throw new Error('usage: backtest.js fetch --contract <id> --from <ISO> --to <ISO> --out <file.json>');
  }
  const bars = await createClient().history(contractId, { start: from, end: to });
  writeJsonAtomic(path.resolve(out), { contractId, barSize: '1 minute', count: bars.length, bars });
  process.stdout.write(`[backtest] wrote ${bars.length} 1-minute bars for ${contractId} to ${out}\n`);
  return 0;
}

async function main(argv) {
  if (argv[0] === 'fetch') return fetchBars(argv.slice(1));
  const configPath = arg(argv, '--config');
  if (!configPath) throw new Error('usage: backtest.js --config <backtest.json> | backtest.js fetch ...');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const log = msg => process.stdout.write(`[backtest] ${msg}\n`);
  const { report, runDir } = await runBacktest(raw, {
    root: ROOT,
    baseDir: path.dirname(path.resolve(configPath)),
    defaultOutRoot: path.join(harnessHome(), 'backtests'),
    log,
  });
  const s = report.summary;
  log(`done: ${s.trades} trades, net ${s.netPnL}, win rate ${s.winRate === null ? '-' : `${Math.round(s.winRate * 100)}%`}, PF ${s.profitFactor ?? '-'}, max DD ${s.maxDrawdown}${report.meta.stopped ? ` (stopped: ${report.meta.stopped})` : ''}`);
  log(`report: ${path.join(runDir, 'report.md')}`);
  return 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[backtest] ${err.message}\n`);
  process.exitCode = 1;
});
