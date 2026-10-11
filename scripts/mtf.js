#!/usr/bin/env node
'use strict';

/**
 * Multi-timeframe read (scripts/lib/trading/mtf.js): the trend on each higher
 * timeframe and whether a long or a short is aligned, a pullback, or counter.
 *
 *   node scripts/mtf.js <bars> [--tf=15,60,240] [--daily=<daily bars>] [--json] [--record --symbol=MNQ]
 *
 * <bars>: the trigger bars, closed, oldest first: get_bars JSON
 * ({ bars: [...] }), a bare JSON array, or a CSV / Parquet / Excel file (the
 * runner's bars file for the current symbol works as is). The higher
 * timeframes are built from them, aligned to the 18:00 ET open; give enough
 * history (2000 3-minute bars cover about 4 sessions: enough for 15m and 1h,
 * thin for 4h). --daily adds daily bars (get_bars unit "day") as the top
 * timeframe. Prints one line per timeframe and the alignment; --json prints
 * the full read. The operation lives in scripts/lib/harness-tools/mtf.js.
 */

const { mtf, parseArgv } = require('./lib/harness-tools/mtf');
const { runCli } = require('./lib/harness-tools/cli');

/** Run with argv (after the script name): prints and sets the exit code. */
const main = argv => runCli('mtf', () => mtf(parseArgv(argv)));

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
