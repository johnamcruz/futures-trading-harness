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
 * It goes only to a .json file under the harness home's own bars scratch
 * directory, <FTH_HOME>/bars-scratch (scratchDir): never a directory shared by
 * every run on the machine (a replay's run home is its own FTH_HOME, so a
 * replay and the live runner never read or replace each other's bars). An
 * agent names the file, so the path must not reach the journal, the rest of
 * the harness state, or a harness's settings. Symlinks are refused (the file,
 * the scratch directory itself, or a directory between them), the real path
 * must stay inside, the path is checked again
 * just before the write, and the bars are written to a fresh temp file
 * (created with 'wx', never an existing one) renamed into place.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeBars } = require('./trading/indicators');
const { harnessHome } = require('./paths');

const MAX_COUNT = 20000; // the most get_bars returns at once (broker MCP interface)

/** Problems with the request: [message]. */
function requestErrors({ symbol, timeframe, daily, count, name = null }) {
  const errors = [];
  if (!/^[A-Z0-9]+$/.test(String(symbol || ''))) errors.push('--symbol: a contract root, e.g. MNQ'); // cli-only: the tool's schema refuses this first
  if (!daily && !(Number.isInteger(timeframe) && timeframe >= 1 && timeframe <= 60)) errors.push('--timeframe: minutes per bar, 1 to 60 (or --daily)'); // cli-only: the tool's schema refuses this first
  if (!(Number.isInteger(count) && count >= 3 && count <= MAX_COUNT)) errors.push(`--count: 3 to ${MAX_COUNT} bars`); // cli-only: the tool's schema refuses this first
  if (name !== null && name !== undefined && !NAME.test(String(name))) errors.push('name: a suffix like trend (lowercase letters, digits, -)'); // cli-only: the tool's schema refuses this first
  return errors;
}

const NAME = /^[a-z][a-z0-9-]{0,23}$/;

/** The harness home's own directory for fetched bars: <FTH_HOME>/bars-scratch (a replay's is inside its run home). */
const scratchDir = (env = process.env) => path.join(harnessHome(env), 'bars-scratch');

/** The default file in dir: <SYMBOL>-<tf>m.json or -1d.json; with name, <SYMBOL>-<tf>m-<name>.json. */
const defaultOut = (symbol, timeframe, daily, dir, name = null) => path.join(dir, `${symbol}-${daily ? '1d' : `${timeframe}m`}${name ? `-${name}` : ''}.json`);

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
function outError(out, outDir, { tool = false } = {}) {
  const dir = path.resolve(outDir);
  // The directory resolved through its parent only (a home under /tmp on macOS is under /private/tmp): a path
  // given under that real form is the same place, and is checked as the path under the directory below.
  const realDir = path.join(realish(path.dirname(dir)), path.basename(dir));
  const given = path.resolve(String(out));
  const file = realDir !== dir && inside(given, realDir) ? path.join(dir, path.relative(realDir, given)) : given;
  // The script names its flag; a harness tool, which has no output argument, names the file.
  const refused = why => `${tool ? 'the bars file' : '--out'}: a .json file under ${outDir}/ (${why}: ${given})`;
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
    // A directory someone else made, or others can write to, could be switched under us (and the bars tools would refuse the file: paths.js).
    if (i === -1 && typeof process.getuid === 'function' && st.uid !== process.getuid()) return refused(`${dir} belongs to another user`);
    if (i < parts.length - 1 && process.platform !== 'win32' && (st.mode & 0o022)) return refused(`${cur} is writable by other users`);
  }
  // And by real path, the file inside the real directory (defense in depth: the walk above already refuses links).
  if (!inside(realish(file), realDir)) return refused('its real path is outside');
  return null;
}

/**
 * { file, contractId, count, first, last, closedAt } after writing the bars.
 * `client`: the broker adapter (activeContract, closedBars).
 */
async function fetchBarsToFile({ client, symbol, timeframe = 3, daily = false, count = null, out = null, name = null, now = new Date(), env = process.env, outDir = scratchDir(env), tool = false }) {
  // By default as many bars as the runner keeps (the multi-timeframe read's whole window).
  if (count === null) count = daily ? 60 : require('./autotrader').historyBars(timeframe);
  const errors = requestErrors({ symbol, timeframe, daily, count, name });
  if (errors.length) throw new Error(errors.join('; '));
  // Refused before the broker is asked.
  const file = path.resolve(out || defaultOut(symbol, timeframe, daily, outDir, name));
  const refused = outError(file, outDir, { tool });
  if (refused) throw new Error(refused);
  const contract = await client.activeContract(symbol);
  const raw = await client.closedBars(contract.id, { minutes: timeframe, limit: count, now, daily });
  const bars = normalizeBars(raw);
  if (bars.length < 3) throw new Error(`only ${bars.length} closed bars for ${contract.id}; the market may be closed or the contract new`);
  // Checked again after the broker call (seconds), before mkdir can follow a link planted meanwhile,
  // and once more just before the write; the temp file is new, never followed.
  const again = outError(file, outDir, { tool });
  if (again) throw new Error(again);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); // the directories it creates are private (an existing one must be the user's: outError)
  const late = outError(file, outDir, { tool });
  if (late) throw new Error(late);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ contractId: contract.id, barSize: daily ? '1 day' : `${timeframe} minute`, count: bars.length, bars }), { flag: 'wx' });
  fs.renameSync(tmp, file);
  const last = bars[bars.length - 1];
  const step = daily ? 864e5 : timeframe * 60000;
  return { file, contractId: contract.id, tickSize: contract.tickSize, tickValue: contract.tickValue, count: bars.length, first: bars[0].t, last: last.t, closedAt: new Date(Date.parse(last.t) + step).toISOString(), bars };
}

module.exports = { MAX_COUNT, requestErrors, scratchDir, defaultOut, outError, fetchBarsToFile, lstat, realish, inside };
