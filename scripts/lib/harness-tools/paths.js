'use strict';

/**
 * Which bars files a harness tool may read (`bars`, `daily`): an agent names
 * the file, so the path must not reach the journal, the harness state, a
 * harness's settings, or credentials.
 *
 * Allowed: an existing regular .json or .csv file of at most
 * 50 MB, by absolute path, inside the bars directory (FTH_BARS_DIR, default
 * <FTH_HOME>/bars: the runner's default bars directory; a runner with another
 * dataDir sets FTH_BARS_DIR to it) or the home's bars scratch directory,
 * <FTH_HOME>/bars-scratch (where bars_fetch writes; never a directory every
 * run on the machine shares, so a replay never reads the live runner's
 * fetches or the other way round). A directory may also be given by its real
 * form (/private/tmp/... for /tmp/... on macOS). Refused: anything outside,
 * a symlink anywhere from the directory down (the directory itself included),
 * a file with more than one hard link (a link to a file elsewhere), a directory
 * on the way (the bars directory included) that another user owns or others can
 * write to (so only the user's own processes could swap a file between this
 * check and the read), and a real path outside the directory. Nothing is read
 * here but metadata, so a refusal never echoes the file's content.
 *
 * barsFile(value, { env, dirs, uid }) -> { file } (the path to read) or { error }; a path refused as outside them (or
 *   not absolute) whose file name is a regular file in one of them names that file (sameName), so a model that
 *   shortened the path ("/workspace/bars-scratch/MNQ-3m.json": 386 retries in the PPC run of 2026-10-16) can copy it
 */

const fs = require('fs');
const path = require('path');
const { scratchDir, lstat, realish, inside } = require('../bars-fetch');
const { harnessHome, expandHome } = require('../paths');

// JSON and CSV only: the Parquet and Excel readers trust their file (the user's own data, through the CLIs).
const EXTENSIONS = ['.json', '.csv'];
const MAX_BYTES = require('../tunables').runner().limits.barsFileBytes; // config/runner.json

/** The directories bars files may come from: the bars directory and the home's bars scratch directory. */
function barsDirs(env = process.env) {
  const configured = String(env.FTH_BARS_DIR || '').trim();
  const dir = configured ? path.resolve(expandHome(configured)) : path.join(harnessHome(env), 'bars');
  return [dir, scratchDir(env)];
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
    if (i < parts.length - 1) {
      // Every directory on the way: the user's, and only the user may change what is in it (so nobody
      // else can swap the file between this check and the read).
      if (uid !== null && st.uid !== uid) return `${cur} belongs to another user`;
      if (process.platform !== 'win32' && (st.mode & 0o022)) return `${cur} is writable by other users`;
    }
    if (i === parts.length - 1) {
      if (!st.isFile()) return 'not a regular file';
      if (st.nlink > 1) return 'a file with more than one hard link';
      if (st.size > MAX_BYTES) return `larger than ${MAX_BYTES / 1024 / 1024} MB`;
    }
  }
  return null;
}

/**
 * The regular file of the same name in one of the bars directories, the one whose own name the given path names first
 * (bars-scratch for ".../bars-scratch/x.json"), else the first; null when none holds it. Metadata only (lstat: no link).
 */
function sameName(value, dirs) {
  const name = path.basename(String(value));
  if (!name || !EXTENSIONS.includes(path.extname(name).toLowerCase())) return null;
  const parts = String(value).split(/[\\/]+/);
  const ordered = [...dirs].sort((a, b) => Number(!parts.includes(path.basename(a))) - Number(!parts.includes(path.basename(b))));
  for (const d of ordered) {
    const candidate = path.join(path.resolve(d), name);
    try {
      if (fs.lstatSync(candidate).isFile()) return candidate;
    } catch (_err) { /* not there */ }
  }
  return null;
}

function barsFile(value, { env = process.env, dirs = barsDirs(env), uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  const shown = String(value).slice(0, 200);
  const refused = (why, hint = null) => ({ error: `a bars file (${EXTENSIONS.join(', ')}, at most ${MAX_BYTES / 1024 / 1024} MB) by absolute path under ${dirs.join(' or ')} (${why}: ${shown})${hint ? `; that file is ${hint}: pass that path` : ''}` });
  if (typeof value !== 'string' || value === '' || value.includes('\0')) return refused('not a path');
  if (!path.isAbsolute(value)) return refused('not an absolute path', sameName(value, dirs));
  if (!EXTENSIONS.includes(path.extname(value).toLowerCase())) return refused('not a bars file type');
  const given = path.resolve(value);
  for (const d of dirs) {
    const dir = path.resolve(d);
    // The directory resolved through its parent only (/tmp/x is /private/tmp/x on macOS): a path given
    // under that real form is the same place, and is checked as the path under the directory.
    const realDir = path.join(realish(path.dirname(dir)), path.basename(dir));
    const file = realDir !== dir && inside(given, realDir) ? path.join(dir, path.relative(realDir, given)) : given;
    if (!inside(file, dir)) continue;
    let why;
    try {
      why = walkError(dir, file, uid);
    } catch (err) {
      why = err.code || 'unreadable'; // ENAMETOOLONG, EACCES: refused like the rest
    }
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
  return refused('outside them', sameName(given, dirs));
}

module.exports = { EXTENSIONS, MAX_BYTES, barsDirs, barsFile };
