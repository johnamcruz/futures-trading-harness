'use strict';

/**
 * Fetch closed bars for a symbol into a file the harness scripts read
 * (market-snapshot, mtf, strategies scan), so an agent never pastes thousands
 * of bars through a tool reply and never sees the credentials: scripts/bars.js
 * loads them from the user's .env and calls this.
 *
 * The file is get_bars JSON ({ contractId, barSize, count, bars }),
 * the same shape as the autonomous runner's bars file.
 *
 * It goes only to a .json file under /tmp/fth/: an agent names the file, so
 * the path must not reach the journal, the harness state, or a harness's
 * settings. Symlinks are refused (the file, /tmp/fth itself, or a directory
 * between them), the real path must stay inside, the path is checked again
 * just before the write, and the bars are written to a fresh temp file
 * (created with 'wx', never an existing one) renamed into place.
 */

const crypto = require('crypto');
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

const OUT_DIR = '/tmp/fth';

/** The default file: /tmp/fth/<SYMBOL>-<tf>m.json or -1d.json. */
const defaultOut = (symbol, timeframe, daily) => path.join(OUT_DIR, `${symbol}-${daily ? '1d' : `${timeframe}m`}.json`);

const lstat = p => {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
};

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

/** Why a bars file path is refused, or null: a .json file inside outDir, through no symlink. */
function outError(out, outDir = OUT_DIR) {
  const file = path.resolve(String(out));
  const dir = path.resolve(outDir);
  const refused = why => `--out: a .json file under ${outDir}/ (${why}: ${file})`;
  if (!file.endsWith('.json')) return refused('not a .json file');
  if (!inside(file, dir)) return refused('outside it');
  // The directory and everything below it, as they are now: no symlink anywhere, the file a regular one if it exists.
  const parts = path.relative(dir, file).split(path.sep);
  let cur = dir;
  for (let i = -1; i < parts.length; i += 1) {
    if (i >= 0) cur = path.join(cur, parts[i]);
    const st = lstat(cur);
    if (!st) break;
    if (st.isSymbolicLink()) return refused(`${cur} is a symlink`);
    if (i < parts.length - 1 && !st.isDirectory()) return refused(`${cur} is not a directory`);
    if (i === parts.length - 1 && !st.isFile()) return refused('not a regular file');
    // /tmp is shared: a /tmp/fth someone else made could be switched under us.
    if (i === -1 && typeof process.getuid === 'function' && st.uid !== process.getuid()) return refused(`${dir} belongs to another user`);
  }
  // And by real path: the directory resolved through its parent only, the file inside it.
  const realDir = path.join(realish(path.dirname(dir)), path.basename(dir));
  if (!inside(realish(file), realDir)) return refused('its real path is outside');
  return null;
}

/**
 * { file, contractId, count, first, last, closedAt } after writing the bars.
 * `client`: the broker adapter (activeContract, closedBars).
 */
async function fetchBarsToFile({ client, symbol, timeframe = 3, daily = false, count = null, out = null, now = new Date(), outDir = OUT_DIR }) {
  // By default as many bars as the runner keeps (the multi-timeframe read's whole window).
  if (count === null) count = daily ? 60 : require('./autotrader').historyBars(timeframe);
  const errors = requestErrors({ symbol, timeframe, daily, count });
  if (errors.length) throw new Error(errors.join('; '));
  // Refused before the broker is asked.
  const file = path.resolve(out || defaultOut(symbol, timeframe, daily));
  const refused = outError(file, outDir);
  if (refused) throw new Error(refused);
  const contract = await client.activeContract(symbol);
  const raw = await client.closedBars(contract.id, { minutes: timeframe, limit: count, now, daily });
  const bars = normalizeBars(raw);
  if (bars.length < 3) throw new Error(`only ${bars.length} closed bars for ${contract.id}; the market may be closed or the contract new`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Checked again just before the write (the broker took seconds); the temp file is new, never followed.
  const late = outError(file, outDir);
  if (late) throw new Error(late);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ contractId: contract.id, barSize: daily ? '1 day' : `${timeframe} minute`, count: bars.length, bars }), { flag: 'wx' });
  fs.renameSync(tmp, file);
  const last = bars[bars.length - 1];
  const step = daily ? 864e5 : timeframe * 60000;
  return { file, contractId: contract.id, tickSize: contract.tickSize, tickValue: contract.tickValue, count: bars.length, first: bars[0].t, last: last.t, closedAt: new Date(Date.parse(last.t) + step).toISOString(), bars };
}

module.exports = { MAX_COUNT, OUT_DIR, requestErrors, defaultOut, outError, fetchBarsToFile };
