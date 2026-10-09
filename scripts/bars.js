#!/usr/bin/env node
/**
 * Fetch closed bars for a symbol into a file for the harness scripts
 * (market-snapshot, mtf, strategies scan), without pasting them through a
 * tool reply. Credentials come from the user's .env (never printed).
 *
 *   node scripts/bars.js --symbol MNQ [--timeframe 3] [--count N] [--out /tmp/fth/MNQ-3m.json] [--record]
 *   (default count: what the runner keeps, 250 hours of bars, enough for the 4h trend: 5000 3m bars)
 *   node scripts/bars.js --symbol MNQ --daily [--count 60]          daily bars for mtf.js --daily
 *
 * --record also records the multi-timeframe read for the order gate (as
 * mtf.js --record); refused in autonomous runs, where the runner records it.
 * Prints one line: the file, the contract, the bar count, and when the last
 * bar closed.
 */

'use strict';

require('./lib/env-file').loadEnvForCli('bars');

const { fetchBarsToFile } = require('./lib/bars-fetch');
const { createClient } = require('./lib/projectx-rest');
const { writeMtfRecord, recordFile } = require('./lib/trading/mtf-state');
const { harnessHome } = require('./lib/paths');

function parse(argv) {
  const o = { symbol: null, timeframe: 3, daily: false, count: null, out: null, record: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--symbol') o.symbol = String(value() || '').toUpperCase();
    else if (flag === '--timeframe') o.timeframe = Number(value());
    else if (flag === '--count') o.count = Number(value());
    else if (flag === '--out') o.out = value();
    else if (flag === '--daily') o.daily = true;
    else if (flag === '--record') o.record = true;
    else throw new Error(`unknown argument: ${argv[i]} (usage: bars.js --symbol MNQ [--timeframe 3 | --daily] [--count N] [--out file] [--record])`);
  }
  return o;
}

async function main(argv) {
  const o = parse(argv);
  if (o.record && o.daily) throw new Error('--record reads trigger bars (minutes), not daily bars');
  if (o.record && process.env.FTH_AUTONOMOUS === '1') throw new Error('--record: the autonomous runner records the read itself');
  const r = await fetchBarsToFile({ client: createClient(), ...o });
  process.stdout.write(`wrote ${r.count} ${o.daily ? 'daily' : `${o.timeframe}-minute`} bars for ${r.contractId} (tick ${r.tickSize}, $${r.tickValue}/tick) to ${r.file}; last bar ${r.last}, closed ${r.closedAt}\n`);
  if (o.record) {
    const rec = writeMtfRecord(harnessHome(), o.symbol, r.bars, { source: r.file });
    process.stdout.write(`${rec.line} (recorded for the order gate: ${recordFile(harnessHome(), o.symbol)})\n`);
  }
  return 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[bars] ${err.message}\n`);
  process.exitCode = 1;
});
