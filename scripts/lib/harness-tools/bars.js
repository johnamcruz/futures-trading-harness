'use strict';

/**
 * Fetch closed bars for a symbol into a file (scripts/bars.js;
 * bars-fetch.js), for market-snapshot, mtf and strategies scan, without
 * pasting them through a tool reply:
 *
 *   fetch { symbol, timeframe, daily, count, out, record }
 *     timeframe  minutes per bar, 1 to 60 (default 3), or daily
 *     count      default: what the runner keeps (daily: 60)
 *     out        a .json file under /tmp/fth/ (default /tmp/fth/<SYMBOL>-<tf>m.json)
 *     record     also record the multi-timeframe read for the order gate
 *                (refused for daily bars, and in autonomous runs, where the runner records it)
 *
 * Asks the configured broker through the adapter; bars up to the harness clock.
 * The text is one line (the file, the contract, the bar count, when the last
 * bar closed), and the recorded read with record.
 */

const { fetchBarsToFile } = require('../bars-fetch');
const { withAdapter } = require('../broker/adapter');
const { writeMtfRecord, recordFile } = require('../trading/mtf-state');
const { harnessHome } = require('../paths');
const { context, withTextAsync } = require('./cli');

const USAGE = 'usage: bars.js --symbol MNQ [--timeframe 3 | --daily] [--count N] [--out file] [--record]';

async function fetch(args = {}, ctx) {
  const c = context(ctx);
  // Only these: nothing else (an output directory, a client) reaches fetchBarsToFile from the arguments.
  const pick = (k, d) => (args[k] === undefined ? d : args[k]);
  const o = { symbol: pick('symbol', null), timeframe: pick('timeframe', 3), daily: pick('daily', false), count: pick('count', null), out: pick('out', null), record: pick('record', false) };
  // Bars up to the harness clock: a replay broker's replayed time, else the wall clock.
  const now = c.now();
  if (o.record && o.daily) throw new Error('--record reads trigger bars (minutes), not daily bars');
  if (o.record && c.env.FTH_AUTONOMOUS === '1') throw new Error('--record: the autonomous runner records the read itself');
  const r = await withAdapter({ root: c.root, env: c.env }, broker => fetchBarsToFile({ client: broker, ...o, now }));
  let text = `wrote ${r.count} ${o.daily ? 'daily' : `${o.timeframe}-minute`} bars for ${r.contractId} (tick ${r.tickSize}, $${r.tickValue}/tick) to ${r.file}; last bar ${r.last}, closed ${r.closedAt}\n`;
  if (!o.record) return { text };
  return withTextAsync(text, async () => {
    const home = harnessHome(c.env);
    const rec = writeMtfRecord(home, o.symbol, r.bars, { source: r.file, now });
    text += `${rec.line} (recorded for the order gate: ${recordFile(home, o.symbol)})\n`;
    return { text };
  });
}

/** argv to the operation's arguments. */
function parseArgv(argv) {
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
    else throw new Error(`unknown argument: ${argv[i]} (${USAGE})`);
  }
  return o;
}

const OPS = { fetch };

module.exports = { OPS, USAGE, fetch, parseArgv };
