'use strict';

/**
 * The multi-timeframe read operation (scripts/mtf.js; trading/mtf.js): the
 * trend on each higher timeframe and whether a long or a short is aligned, a
 * pullback, or counter.
 *
 *   mtf { file, tf, daily, json, record, symbol }
 *     file    the trigger bars (closed, oldest first): a bars file or '-'
 *     tf      higher timeframes in minutes (default [15, 60, 240])
 *     daily   a daily bars file, the top timeframe (optional)
 *     json    the full read as JSON instead of one line per timeframe
 *     record  also record the read for the order gate (needs symbol; ignored in
 *             autonomous runs, where the runner records it: the read comes back with a note)
 */

const { mtfRead } = require('../trading/mtf');
const { buildRecord, writeRecord } = require('../trading/mtf-state');
const { harnessHome } = require('../paths');
const { readBarsArg } = require('../backtest/data');
const { context, say, ignoredRecord, withText } = require('./cli');
const { liveRunner } = require('../runner-lock');

const USAGE = 'usage: mtf.js <bars.json | bars.csv | -> [--tf=15,60,240] [--daily=<daily bars>] [--json] [--record --symbol=MNQ]';

function mtf({ file = null, tf = [15, 60, 240], daily = null, json = false, record = false, symbol = null } = {}, ctx) {
  const c = context(ctx);
  if (!file) throw new Error(USAGE);
  const bars = readBarsArg(file);
  const read = mtfRead(bars, { timeframes: tf, daily: daily ? readBarsArg(daily) : null });
  const text = json ? `${JSON.stringify(read, null, 2)}\n` : `${read.lines.join('\n')}\n`;
  if (!record) return { text };
  // In autonomous runs the runner records the read from the bars it hands the cycle.
  const ignored = ignoredRecord(c, 'mtf', 'the autonomous runner records the read itself');
  if (ignored) return { text, stderr: ignored };
  return withText(text, () => {
    const record = say(c, '--record', 'record');
    const pid = liveRunner(c.env);
    if (pid) throw new Error(`${record}: an autonomous runner is running (pid ${pid}): it records the reads and signals of the symbols it trades, and record is refused while it runs`);
    if (!symbol || !/^[A-Z0-9]+$/i.test(symbol)) throw new Error(say(c, '--record needs --symbol=<ROOT> (e.g. MNQ)', 'record needs symbol (a contract root, e.g. MNQ)'));
    const out = writeRecord(harnessHome(c.env), buildRecord(bars, { symbol, source: file === '-' ? 'stdin' : file, now: c.now() }));
    return { text, stderr: `[mtf] recorded for the order gate: ${out}\n` };
  });
}

/** argv to the operation's arguments; --symbol MNQ and --symbol=MNQ both work. */
function parseArgv(argv) {
  const opts = { tf: [15, 60, 240], daily: null, json: false, file: null, record: false, symbol: null };
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
  if (!opts.file) throw new Error(USAGE);
  return opts;
}

const OPS = { mtf };

module.exports = { OPS, USAGE, mtf, parseArgv };
