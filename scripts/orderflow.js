#!/usr/bin/env node
/**
 * Recorded order flow: export it with 1-minute bars (from the broker, through
 * the broker adapter) for backtests, and list what is recorded.
 *
 *   node scripts/orderflow.js export --contract MNQ --from 2026-10-01 --to 2026-10-08 --out data/MNQ-1m-flow.csv
 *   node scripts/orderflow.js status
 *
 * Files: <FTH_HOME>/flow/<contractId>.csv (time,buy_volume,sell_volume per
 * minute). Live order flow is not part of the broker MCP interface, so the
 * harness doesn't record it; bars without recorded flow use the bar-shape
 * estimate in ofi/delta.
 */

'use strict';

// Credentials and settings from a .env file (<FTH_HOME>/.env, or the repo's
// git-ignored .env); a variable already set in the environment wins. Logs key
// names only, to stderr.
require('./lib/env-file').loadEnvForCli('orderflow');

const fs = require('fs');
const path = require('path');
const { withAdapter } = require('./lib/broker/adapter');
const { readFlow, flowDir } = require('./lib/trading/flow');
const { harnessHome } = require('./lib/paths');

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const log = (msg, level) => (level === 'error' ? process.stderr : process.stdout).write(`[orderflow] ${new Date().toISOString()} ${msg}\n`);

async function exportBars(argv) {
  const contractId = arg(argv, '--contract');
  const from = new Date(arg(argv, '--from') || '');
  const to = new Date(arg(argv, '--to') || '');
  const out = arg(argv, '--out');
  if (!contractId || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || !out) {
    throw new Error('usage: orderflow.js export --contract <id> --from <ISO> --to <ISO> --out <file.csv>');
  }
  const bars = await withAdapter({ root: path.resolve(__dirname, '..'), env: process.env }, broker => broker.history(contractId, { start: from, end: to }));
  const flow = new Map(readFlow(harnessHome(), contractId, { from: from.getTime(), to: to.getTime() }).map(r => [r.t, r]));
  let withFlow = 0;
  const rows = bars.map(b => {
    const f = flow.get(Date.parse(b.t));
    if (f) withFlow += 1;
    return [b.t, b.o, b.h, b.l, b.c, b.v, f ? f.bv : '', f ? f.sv : ''].join(',');
  });
  const file = path.resolve(out);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `time,open,high,low,close,volume,buy_volume,sell_volume\n${rows.join('\n')}\n`);
  log(`wrote ${bars.length} 1-minute bars (${withFlow} with recorded order flow) for ${contractId} to ${out}`);
  if (withFlow < bars.length) log('bars without recorded flow fall back to the bar-shape estimate in ofi/delta');
  return 0;
}

function status() {
  const dir = flowDir(harnessHome());
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.csv')); } catch (_err) { /* none yet */ }
  if (!files.length) { log(`no recorded order flow in ${dir}`); return 0; }
  for (const f of files) {
    const rows = readFlow(harnessHome(), f.replace(/\.csv$/, ''));
    if (!rows.length) continue;
    log(`${f.replace(/\.csv$/, '')}: ${rows.length} minutes, ${new Date(rows[0].t).toISOString()} to ${new Date(rows[rows.length - 1].t).toISOString()}`);
  }
  return 0;
}

async function main(argv) {
  if (argv[0] === 'export') return exportBars(argv.slice(1));
  if (argv[0] === 'status') return status();
  throw new Error('usage: orderflow.js export --contract <id> --from <ISO> --to <ISO> --out <file.csv> | status');
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[orderflow] ${err.message}\n`);
  process.exitCode = 1;
});
