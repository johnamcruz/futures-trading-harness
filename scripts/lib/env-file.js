'use strict';

/**
 * Credentials from a .env file, so they don't have to live in the shell
 * profile, and never in the repository.
 *
 * Looked up in order, first value wins, and a variable already set in the
 * environment always wins over any file:
 *   1. $FTH_ENV_FILE, if set (an explicit file)
 *   2. <FTH_HOME>/.env   (default ~/.futures-trading-harness/.env: outside the repo, the safest place)
 *   3. <repo root>/.env  (ignored by git: .gitignore lists .env and .env.*)
 *
 * Format: KEY=value per line; `export KEY=value`, # comments, blank lines, and
 * single- or double-quoted values are accepted. No variable expansion.
 *
 * A file other users can read (group or world permission bits) is still
 * loaded, with a warning to chmod 600 it. Values are never logged; only the
 * names of the keys loaded and the file they came from.
 */

const fs = require('fs');
const path = require('path');
const { harnessHome } = require('./paths');

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse .env text into { key: value }. Malformed lines are reported in `errors`, never thrown. */
function parseEnv(text) {
  const values = {};
  const errors = [];
  String(text).split(/\r?\n/).forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !KEY.test(m[1])) { errors.push(`line ${n + 1}: expected KEY=value`); return; }
    let v = m[2];
    const q = v[0];
    if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) {
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      // An unquoted value ends at a ` #` comment.
      v = v.replace(/\s+#.*$/, '').trim();
    }
    values[m[1]] = v;
  });
  return { values, errors };
}

/** The .env files to read, in order (existing or not). */
function envFiles(env = process.env, root = path.resolve(__dirname, '..', '..')) {
  const files = [];
  if (env.FTH_ENV_FILE) files.push(path.resolve(env.FTH_ENV_FILE));
  files.push(path.join(harnessHome(env), '.env'));
  files.push(path.join(root, '.env'));
  return [...new Set(files)];
}

/**
 * Load .env files into `env` (process.env by default) without overriding
 * anything already set. Returns { loaded: [{ file, keys }], warnings }.
 */
function loadEnvFiles({ env = process.env, root, files } = {}) {
  const loaded = [];
  const warnings = [];
  for (const file of files || envFiles(env, root)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') warnings.push(`${file}: ${err.code || err.message}`);
      continue;
    }
    try {
      const mode = fs.statSync(file).mode;
      if (process.platform !== 'win32' && (mode & 0o077)) warnings.push(`${file} can be read by other users; chmod 600 it`);
    } catch (_err) {
      // permissions are advice only
    }
    const { values, errors } = parseEnv(text);
    for (const e of errors) warnings.push(`${file} ${e}`);
    const keys = [];
    for (const [k, v] of Object.entries(values)) {
      if (env[k] === undefined || env[k] === '') { env[k] = v; keys.push(k); }
    }
    if (keys.length) loaded.push({ file, keys });
  }
  return { loaded, warnings };
}

/** For CLIs: load, and say where credentials came from (key names only). */
function loadEnvForCli(tag, { env = process.env, out = process.stderr } = {}) {
  const r = loadEnvFiles({ env });
  for (const l of r.loaded) out.write(`[${tag}] loaded ${l.keys.join(', ')} from ${l.file}\n`);
  for (const w of r.warnings) out.write(`[${tag}] warning: ${w}\n`);
  return r;
}

module.exports = { parseEnv, envFiles, loadEnvFiles, loadEnvForCli };
