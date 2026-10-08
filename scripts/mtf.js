#!/usr/bin/env node
'use strict';

/**
 * Multi-timeframe read (scripts/lib/trading/mtf.js): the trend on each higher
 * timeframe and whether a long or a short is aligned, a pullback, or counter.
 *
 *   node scripts/mtf.js <bars> [--tf=15,60,240] [--daily=<daily bars>] [--json]
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

const fs = require('fs');
const path = require('path');
const { mtfRead } = require('./lib/trading/mtf');
const { loadBars } = require('./lib/backtest/data');

function readBars(file) {
  if (/\.json$/i.test(file) || file === '-') {
    const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
    return JSON.parse(text);
  }
  return loadBars(path.resolve(file));
}

function main(argv) {
  const opts = { tf: [15, 60, 240], daily: null, json: false, file: null };
  for (const a of argv) {
    let m;
    if ((m = /^--tf=(.+)$/.exec(a))) opts.tf = m[1].split(',').map(x => Number(x.trim()));
    else if ((m = /^--daily=(.+)$/.exec(a))) opts.daily = m[1];
    else if (a === '--json') opts.json = true;
    else if (!a.startsWith('--') && opts.file === null) opts.file = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.file) throw new Error('usage: mtf.js <bars.json | bars.csv | -> [--tf=15,60,240] [--daily=<daily bars>] [--json]');
  const read = mtfRead(readBars(opts.file), { timeframes: opts.tf, daily: opts.daily ? readBars(opts.daily) : null });
  process.stdout.write(opts.json ? `${JSON.stringify(read, null, 2)}\n` : `${read.lines.join('\n')}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`[mtf] ${err.message}\n`);
  process.exitCode = 1;
}
