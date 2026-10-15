'use strict';

/**
 * Account profiles: a prop-firm challenge as a Markdown document,
 * `accounts/<name>/ACCOUNT.md` (frontmatter read by code, body by the
 * agents). A policy strategy names one (`account: <name>`) to size by its
 * cushion and to train a policy for it. Extra folders: FTH_ACCOUNTS_DIRS.
 * An account's rulebook (`RULEBOOK.md` beside it, trading/rulebook.js) holds the
 * harness's own numbers for it: `daily_loss_soft` and `loss_streak_stop` come from there and only there
 * (R1, one place); a missing or invalid rulebook makes the account invalid.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFrontmatter } = require('../frontmatter');
const rulebook = require('./rulebook');

const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const KEYS = ['name', 'description', 'firm', 'type', 'starting_balance', 'profit_target', 'max_loss', 'max_loss_mode',
  'daily_loss_limit', 'daily_loss_soft', 'loss_streak_stop', 'consistency_pct', 'max_contracts', 'sessions', 'fees_per_side'];
const MAX_LOSS_MODES = ['trailing_eod', 'static'];
const REQUIRED_SECTIONS = ['## When to Use', '## How It Works', '## Examples'];

const expandHome = p => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

function accountDirs(pluginRoot, env = process.env) {
  const extra = String(env.FTH_ACCOUNTS_DIRS || '').split(',').map(s => s.trim()).filter(Boolean).map(expandHome);
  return [path.join(pluginRoot, 'accounts'), ...extra];
}

const positive = x => typeof x === 'number' && Number.isFinite(x) && x > 0;
const nonneg = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const perSymbol = (x, ok) => x && typeof x === 'object' && !Array.isArray(x)
  && Object.keys(x).length > 0 && Object.entries(x).every(([k, v]) => /^[A-Z0-9]+$/.test(k) && ok(v));

/** Validate parsed frontmatter + body. Returns a list of problems (empty = valid). */
function validateAccount(data, body, folderName) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };
  for (const k of Object.keys(data)) if (!KEYS.includes(k)) errors.push(`unknown key "${k}"`);
  req(typeof data.name === 'string' && NAME.test(data.name), 'name: lowercase letters, digits, _ or -');
  req(data.name === folderName, `name "${data.name}" must match its folder "${folderName}"`);
  req(typeof data.description === 'string' && data.description.length >= 20, 'description: at least 20 characters');
  for (const k of ['starting_balance', 'profit_target', 'max_loss', 'sessions']) req(positive(data[k]), `${k}: a positive number`);
  req(Number.isInteger(data.sessions), 'sessions: a whole number of trading days');
  req(MAX_LOSS_MODES.includes(data.max_loss_mode), `max_loss_mode: one of ${MAX_LOSS_MODES.join(', ')}`);
  for (const k of ['daily_loss_limit', 'daily_loss_soft', 'consistency_pct']) req(data[k] === undefined || nonneg(data[k]), `${k}: 0 or more`);
  req(data.loss_streak_stop === undefined || (Number.isInteger(data.loss_streak_stop) && data.loss_streak_stop >= 0), 'loss_streak_stop: a whole number of losing trades, 0 or more (0: off)');
  req(data.consistency_pct === undefined || data.consistency_pct <= 100, 'consistency_pct: 0 to 100');
  if (positive(data.max_loss) && positive(data.daily_loss_soft)) req(data.daily_loss_soft < data.max_loss, 'daily_loss_soft: below max_loss');
  if (positive(data.daily_loss_limit) && positive(data.daily_loss_soft)) req(data.daily_loss_soft <= data.daily_loss_limit, 'daily_loss_soft: at most daily_loss_limit');
  req(perSymbol(data.max_contracts, v => Number.isInteger(v) && v > 0), 'max_contracts: { SYMBOL: whole number > 0, ... }');
  req(data.fees_per_side === undefined || perSymbol(data.fees_per_side, nonneg), 'fees_per_side: { SYMBOL: dollars, ... }');
  for (const h of REQUIRED_SECTIONS) req(body.includes(h), `body: missing section "${h}"`);
  return errors;
}

function loadAccountFile(file) {
  const folderName = path.basename(path.dirname(file));
  let parsed;
  try {
    parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { name: folderName, file, valid: false, errors: [err.message] };
  }
  const book = rulebook.loadRulebookFile(path.join(path.dirname(file), rulebook.FILE));
  const data = { ...parsed.data };
  const bookErrors = [];
  // One place: the soft stop is never the profile's, and an account without a rulebook (whose enforced values
  // would quietly default to off) is refused.
  for (const k of ['daily_loss_soft', 'loss_streak_stop']) {
    if (parsed.data[k] !== undefined) bookErrors.push(`${k}: it lives in ${rulebook.FILE} beside this file, not here (one place)`);
  }
  const bookFile = path.join(path.dirname(file), rulebook.FILE);
  if (!book) bookErrors.push(`${bookFile}: missing; every account has its rulebook beside its ACCOUNT.md (the soft daily stop and its policies' numbers)`);
  else if (!book.valid) bookErrors.push(...book.errors.map(e => `${bookFile}: ${e}`));
  else Object.assign(data, { daily_loss_soft: rulebook.limit(book.daily_loss_soft), loss_streak_stop: rulebook.limit(book.loss_streak_stop) });
  const errors = [...bookErrors, ...validateAccount(data, parsed.body, folderName)];
  return {
    daily_loss_limit: 0, daily_loss_soft: 0, loss_streak_stop: 0, consistency_pct: 0, fees_per_side: {},
    ...data, name: folderName, file, body: parsed.body, valid: errors.length === 0, errors,
  };
}

function loadAccounts(pluginRoot, env = process.env) {
  const byName = new Map();
  const problems = [];
  for (const dir of accountDirs(pluginRoot, env)) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') problems.push({ dir, error: err.message });
      continue;
    }
    for (const d of entries.filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.') && !e.name.startsWith('_'))) {
      const file = path.join(dir, d.name, 'ACCOUNT.md');
      if (!fs.existsSync(file)) continue;
      const a = loadAccountFile(file);
      if (byName.has(a.name)) {
        problems.push({ dir, error: `duplicate account "${a.name}" ignored (first defined in ${byName.get(a.name).file})` });
        continue;
      }
      byName.set(a.name, a);
    }
  }
  return { accounts: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

/** A valid account by name, or throw with the reason. */
function accountNamed(pluginRoot, name, env = process.env) {
  const a = loadAccounts(pluginRoot, env).accounts.find(x => x.name === name);
  if (!a) throw new Error(`unknown account "${name}" (accounts/<name>/ACCOUNT.md)`);
  if (!a.valid) throw new Error(`account "${name}" is invalid: ${a.errors[0]}`);
  return a;
}

/**
 * The account's fee per contract per side for a contract root (ACCOUNT.md `fees_per_side`, the one home of a fee), or
 * null when the profile states none: a fee is never assumed (no code default, no contract-table fee).
 */
function feePerSide(account, root) {
  const fees = account && account.fees_per_side;
  const k = String(root || '').toUpperCase();
  const v = fees && typeof fees === 'object' && Object.hasOwn(fees, k) ? fees[k] : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** The account's fee for a root, or throws naming the missing key: a run, a size or an order is refused, never priced by a guess. */
function requireFee(account, root) {
  const f = feePerSide(account, root);
  if (f === null) throw new Error(`${(account && account.name) || 'the account'}: no fees_per_side.${String(root || '').toUpperCase()} in its ACCOUNT.md; a fee is never assumed`);
  return f;
}

/**
 * The limits a replay broker is run with, from the account (the one home of a limit): { dailyLoss (the daily_loss_limit,
 * 0 for none), maxOrderSize, maxPositionSize, symbol, caps, missing }. The broker has one size limit for every symbol
 * (docs/BROKER-MCP-INTERFACE.md get_server_config), so with different caps among the run's symbols it is the SMALLEST
 * cap (the strict choice: no symbol is sized past its own); `symbol` is the one that cap is for, `caps` every stated cap
 * ({ symbol: n }), `missing` the run's symbols the account states none for. No cap for any: both sizes null (none is guessed).
 */
function accountLimits(account, symbols) {
  const caps = account && account.max_contracts && typeof account.max_contracts === 'object' ? account.max_contracts : {};
  const names = [...new Set((symbols || []).map(s => String(s).toUpperCase()))];
  const found = names.map(s => [s, caps[s]]).filter(([, n]) => Number.isInteger(n) && n > 0);
  const low = found.reduce((a, b) => (a && a[1] <= b[1] ? a : b), null);
  return {
    dailyLoss: Number(account && account.daily_loss_limit) || 0,
    maxOrderSize: low ? low[1] : null, maxPositionSize: low ? low[1] : null, symbol: low ? low[0] : null,
    caps: Object.fromEntries(found), missing: names.filter(s => !found.some(([n]) => n === s)),
  };
}

module.exports = { KEYS, accountDirs, validateAccount, loadAccountFile, loadAccounts, accountNamed, feePerSide, requireFee, accountLimits };
