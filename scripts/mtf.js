#!/usr/bin/env node
'use strict';

/**
 * Multi-timeframe read (scripts/lib/trading/mtf.js): the trend on each higher
 * timeframe and whether a long or a short is aligned, a pullback, or counter.
 *
 *   node scripts/mtf.js <bars> [--tf=15,60,240] [--daily=<daily bars>] [--json] [--record --symbol=MNQ]
 *
 * <bars>: the trigger bars, closed, oldest first: projectx-mcp get_bars JSON
 * ({ bars: [...] }), a bare JSON array, or a CSV / Parquet / Excel file (the
 * runner's bars file for the current symbol works as is). The higher
 * timeframes are built from them, aligned to the 18:00 ET open; give enough
 * history (2000 3-minute bars cover about 4 sessions: enough for 15m and 1h,
 * thin for 4h). --daily adds daily bars (get_bars unit "day") as the top
 * timeframe. Prints one line per timeframe and the alignment; --json prints
 * the full read.
 */

const { mtfRead } = require('./lib/trading/mtf');
const { buildRecord, writeRecord } = require('./lib/trading/mtf-state');
const { harnessHome } = require('./lib/paths');
const { readBarsArg: readBars } = require('./lib/backtest/data');

function main(argv) {
  const opts = { tf: [15, 60, 240], daily: null, json: false, file: null, record: false, symbol: null };
  // --symbol MNQ and --symbol=MNQ both work (strategies.js scan takes the first form).
  const args = argv.flatMap((a, i) => (a === '--symbol' ? [] : argv[i - 1] === '--symbol' ? [`--symbol=${a}`] : [a]));
  for (const a of args) {
    let m;
    if ((m = /^--tf=(.+)$/.exec(a))) opts.tf = m[1].split(',').map(x => Number(x.trim()));
    else if ((m = /^--daily=(.+)$/.exec(a))) opts.daily = m[1];
    else if (a === '--json') opts.json = true;
    else if (a === '--record') opts.record = true;
    else if ((m = /^--symbol=(.+)$/.exec(a))) opts.symbol = m[1];
    else if (!a.startsWith('--') && opts.file === null) opts.file = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.file) throw new Error('usage: mtf.js <bars.json | bars.csv | -> [--tf=15,60,240] [--daily=<daily bars>] [--json] [--record --symbol=MNQ]');
  const bars = readBars(opts.file);
  const read = mtfRead(bars, { timeframes: opts.tf, daily: opts.daily ? readBars(opts.daily) : null });
  process.stdout.write(opts.json ? `${JSON.stringify(read, null, 2)}\n` : `${read.lines.join('\n')}\n`);
  if (opts.record) {
    // In autonomous runs the runner records the read from the bars it hands the cycle.
    if (process.env.FTH_AUTONOMOUS === '1') throw new Error('--record: the autonomous runner records the read itself');
    if (!opts.symbol || !/^[A-Z0-9]+$/i.test(opts.symbol)) throw new Error('--record needs --symbol=<ROOT> (e.g. MNQ)');
    const file = writeRecord(harnessHome(), buildRecord(bars, { symbol: opts.symbol, source: opts.file === '-' ? 'stdin' : opts.file }));
    process.stderr.write(`[mtf] recorded for the order gate: ${file}\n`);
  }
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`[mtf] ${err.message}\n`);
  process.exitCode = 1;
}
