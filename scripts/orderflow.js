#!/usr/bin/env node
/**
 * Real order flow from TopstepX: record it from the ProjectX market hub, and
 * export it with 1-minute bars for backtests.
 *
 *   node scripts/orderflow.js record --symbols MNQ,MES
 *   node scripts/orderflow.js export --contract CON.F.US.MNQ.Z26 --from 2026-10-01 --to 2026-10-08 --out data/MNQ-1m-flow.csv
 *   node scripts/orderflow.js status
 *
 * `record` runs until stopped (Ctrl-C). The autonomous runner records on its
 * own while it runs (config orderFlow); `record` is for collecting flow
 * outside trading hours or without the runner. The hub has no history, so
 * flow exists only from when recording started. Files:
 * <FTH_HOME>/flow/<contractId>.csv (time,buy_volume,sell_volume per minute).
 * Needs PROJECTX_USERNAME / PROJECTX_API_KEY and Node 22+.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('./lib/projectx-rest');
const { createRecorder, readFlow, flowDir } = require('./lib/orderflow-recorder');
const { harnessHome } = require('./lib/paths');

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const log = (msg, level) => (level === 'error' ? process.stderr : process.stdout).write(`[orderflow] ${new Date().toISOString()} ${msg}\n`);

async function record(argv) {
  const symbols = String(arg(argv, '--symbols') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) throw new Error('usage: orderflow.js record --symbols MNQ[,MES,...]');
  const client = createClient();
  const recorder = createRecorder({ home: harnessHome(), getToken: client.getToken, log });
  const follow = async () => {
    for (const symbol of symbols) {
      try {
        const c = await client.activeContract(symbol);
        recorder.follow(c.id);
      } catch (err) {
        log(`${symbol}: no active contract (${err.message})`, 'error');
      }
    }
  };
  await follow();
  const stop = () => { recorder.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  log(`recording ${symbols.join(', ')} to ${flowDir(harnessHome())}`);
  let lastLookup = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 10000));
    recorder.flush();
    // Follow the roll: look the active contracts up again every hour.
    if (Date.now() - lastLookup > 3600000) { lastLookup = Date.now(); await follow(); }
  }
}

async function exportBars(argv) {
  const contractId = arg(argv, '--contract');
  const from = new Date(arg(argv, '--from') || '');
  const to = new Date(arg(argv, '--to') || '');
  const out = arg(argv, '--out');
  if (!contractId || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || !out) {
    throw new Error('usage: orderflow.js export --contract <id> --from <ISO> --to <ISO> --out <file.csv>');
  }
  const bars = await createClient().history(contractId, { start: from, end: to });
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
  if (argv[0] === 'record') return record(argv.slice(1));
  if (argv[0] === 'export') return exportBars(argv.slice(1));
  if (argv[0] === 'status') return status();
  throw new Error('usage: orderflow.js record --symbols MNQ | export --contract <id> --from <ISO> --to <ISO> --out <file.csv> | status');
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[orderflow] ${err.message}\n`);
  process.exitCode = 1;
});
