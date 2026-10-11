'use strict';

/**
 * Fetch closed bars for a symbol into a file the harness scripts read
 * (market-snapshot, mtf, strategies scan), so an agent never pastes thousands
 * of bars through a tool reply and never sees the credentials: scripts/bars.js
 * loads them from the user's .env and calls this.
 *
 * The file is get_bars JSON ({ contractId, barSize, count, bars }),
 * the same shape as the autonomous runner's bars file.
 */

const fs = require('fs');
const path = require('path');
const { normalizeBars } = require('./trading/indicators');

const MAX_COUNT = 20000; // the most get_bars returns at once (broker MCP interface)

/** Problems with the request: [message]. */
function requestErrors({ symbol, timeframe, daily, count }) {
  const errors = [];
  if (!/^[A-Z0-9]+$/.test(String(symbol || ''))) errors.push('--symbol: a contract root, e.g. MNQ');
  if (!daily && !(Number.isInteger(timeframe) && timeframe >= 1 && timeframe <= 60)) errors.push('--timeframe: minutes per bar, 1 to 60 (or --daily)');
  if (!(Number.isInteger(count) && count >= 3 && count <= MAX_COUNT)) errors.push(`--count: 3 to ${MAX_COUNT} bars`);
  return errors;
}

// The only place bars files go. An agent may run bars.js (it is on the autonomous
// allowlists with any arguments), so --out must not reach the journal, the harness
// state, or a harness's settings.
const OUT_DIR = '/tmp/fth';

/** The default file: /tmp/fth/<SYMBOL>-<tf>m.json or -1d.json. */
const defaultOut = (symbol, timeframe, daily) => path.join(OUT_DIR, `${symbol}-${daily ? '1d' : `${timeframe}m`}.json`);

/** The real path of p, or of its deepest existing ancestor joined with the rest. */
function realish(p) {
  const rest = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch (_err) {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

const inside = (file, dir) => {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Why an --out file is refused, or null: a .json file inside outDir, also after symlinks. */
function outError(out, outDir = OUT_DIR) {
  const file = path.resolve(String(out));
  const dir = path.resolve(outDir);
  const isLink = p => {
    try {
      return fs.lstatSync(p).isSymbolicLink();
    } catch (_err) {
      return false; // not there yet
    }
  };
  // The directory itself is resolved through its parent only: /tmp is world-writable,
  // so /tmp/fth may be someone's link into the harness state.
  const realDir = path.join(realish(path.dirname(dir)), path.basename(dir));
  if (isLink(file) || isLink(dir) || !file.endsWith('.json') || !inside(file, dir) || !inside(realish(file), realDir)) {
    return `--out: a .json file under ${outDir}/ (got ${file})`;
  }
  return null;
}

/**
 * { file, contractId, count, first, last, closedAt } after writing the bars.
 * `client`: the broker adapter (activeContract, closedBars).
 */
async function fetchBarsToFile({ client, symbol, timeframe = 3, daily = false, count = null, out = null, now = new Date(), outDir = OUT_DIR }) {
  const file = path.resolve(out || defaultOut(symbol, timeframe, daily));
  const refused = outError(file, outDir);
  if (refused) throw new Error(refused);
  // By default as many bars as the runner keeps (the multi-timeframe read's whole window).
  if (count === null) count = daily ? 60 : require('./autotrader').historyBars(timeframe);
  const errors = requestErrors({ symbol, timeframe, daily, count });
  if (errors.length) throw new Error(errors.join('; '));
  const contract = await client.activeContract(symbol);
  const raw = await client.closedBars(contract.id, { minutes: timeframe, limit: count, now, daily });
  const bars = normalizeBars(raw);
  if (bars.length < 3) throw new Error(`only ${bars.length} closed bars for ${contract.id}; the market may be closed or the contract new`);
  // Checked again after the broker call (seconds), and the temp file is created new, never followed.
  const late = outError(file, outDir);
  if (late) throw new Error(late);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, JSON.stringify({ contractId: contract.id, barSize: daily ? '1 day' : `${timeframe} minute`, count: bars.length, bars }), { flag: 'wx' });
  fs.renameSync(tmp, file);
  const last = bars[bars.length - 1];
  const step = daily ? 864e5 : timeframe * 60000;
  return { file, contractId: contract.id, tickSize: contract.tickSize, tickValue: contract.tickValue, count: bars.length, first: bars[0].t, last: last.t, closedAt: new Date(Date.parse(last.t) + step).toISOString(), bars };
}

module.exports = { MAX_COUNT, OUT_DIR, requestErrors, defaultOut, outError, fetchBarsToFile };
