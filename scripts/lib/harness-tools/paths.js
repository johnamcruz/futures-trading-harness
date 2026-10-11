'use strict';

/**
 * Which bars files a harness tool may read (`bars`, `daily`): an agent names
 * the file, so the path must not reach the journal, the harness state, a
 * harness's settings, or credentials.
 *
 * Allowed: an existing regular .json, .csv, .parquet or .xlsx file of at most
 * 50 MB, by absolute path, inside the bars directory (FTH_BARS_DIR, default
 * <FTH_HOME>/bars: where the runner writes bars) or /tmp/fth (where bars_fetch
 * writes; on macOS also given as /private/tmp/fth). Refused: anything outside,
 * a symlink anywhere from the directory down (the directory itself included),
 * a file with more than one hard link (a link to a file elsewhere), a directory
 * another user owns or others can write to (so only the user's own processes
 * could swap a file between this check and the read), and a real path outside the directory. Nothing is read
 * here but metadata, so a refusal never echoes the file's content.
 *
 * barsFile(value, { env, dirs, uid }) -> { file } (the path to read) or { error }
 */

const fs = require('fs');
const path = require('path');
const { OUT_DIR, lstat, realish, inside } = require('../bars-fetch');
const { harnessHome, expandHome } = require('../paths');

const EXTENSIONS = ['.json', '.csv', '.parquet', '.xlsx'];
const MAX_BYTES = 50 * 1024 * 1024;

/** The directories bars files may come from: the bars directory and /tmp/fth. */
function barsDirs(env = process.env) {
  const configured = String(env.FTH_BARS_DIR || '').trim();
  const dir = configured ? path.resolve(expandHome(configured)) : path.join(harnessHome(env), 'bars');
  return [dir, OUT_DIR];
}

/** Why `file` (inside `dir` by its path) is refused, or null. */
function walkError(dir, file, uid) {
  const parts = path.relative(dir, file).split(path.sep);
  let cur = dir;
  for (let i = -1; i < parts.length; i += 1) {
    if (i >= 0) cur = path.join(cur, parts[i]);
    const st = lstat(cur);
    if (!st) return i === -1 ? `${dir} does not exist` : 'no such file';
    if (st.isSymbolicLink()) return `${cur} is a symlink`;
    if (i < parts.length - 1 && !st.isDirectory()) return `${cur} is not a directory`;
    if (i === -1 && uid !== null && st.uid !== uid) return `${dir} belongs to another user`;
    // Only its owner may change what is in it (between this check and the read, too).
    if (i === -1 && process.platform !== 'win32' && (st.mode & 0o022)) return `${dir} is writable by other users`;
    if (i === parts.length - 1) {
      if (!st.isFile()) return 'not a regular file';
      if (st.nlink > 1) return 'a file with more than one hard link';
      if (st.size > MAX_BYTES) return `larger than ${MAX_BYTES / 1024 / 1024} MB`;
    }
  }
  return null;
}

function barsFile(value, { env = process.env, dirs = barsDirs(env), uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  const shown = String(value).slice(0, 200);
  const refused = why => ({ error: `a bars file (${EXTENSIONS.join(', ')}, at most ${MAX_BYTES / 1024 / 1024} MB) by absolute path under ${dirs.join(' or ')} (${why}: ${shown})` });
  if (typeof value !== 'string' || value === '' || value.includes('\0')) return refused('not a path');
  if (!path.isAbsolute(value)) return refused('not an absolute path');
  if (!EXTENSIONS.includes(path.extname(value).toLowerCase())) return refused('not a bars file type');
  const given = path.resolve(value);
  for (const d of dirs) {
    const dir = path.resolve(d);
    // The directory resolved through its parent only (/tmp/fth is /private/tmp/fth on macOS): a path given
    // under that real form is the same place, and is checked as the path under the directory.
    const realDir = path.join(realish(path.dirname(dir)), path.basename(dir));
    const file = realDir !== dir && inside(given, realDir) ? path.join(dir, path.relative(realDir, given)) : given;
    if (!inside(file, dir)) continue;
    const why = walkError(dir, file, uid);
    if (why) return refused(why);
    let real;
    try {
      real = fs.realpathSync(file);
    } catch (err) {
      return refused(err.code || 'unreadable');
    }
    // Defense in depth: the walk already refuses links.
    if (!inside(real, realDir)) return refused('its real path is outside');
    return { file };
  }
  return refused('outside them');
}

module.exports = { EXTENSIONS, MAX_BYTES, barsDirs, barsFile };
