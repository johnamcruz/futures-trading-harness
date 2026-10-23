'use strict';

/**
 * Prop accounts: the broker accounts the user marks as a prop firm's challenge accounts, in their own broker config
 * (<FTH_HOME>/brokers.json, or the file FTH_BROKERS_FILE names: broker/config.js), never in the repo. A broker's
 * `propAccounts` maps each such account id to the account profile it trades under (accounts/<name>/ACCOUNT.md):
 *
 *   { "brokers": { "<broker>": { "propAccounts": { "<account id>": "<profile>" } } } }
 *
 * The harness can't tell a prop account from a simulated one at the broker, so the mark is the user's. An entry on
 * a marked account goes only while that profile's challenge attempt runs (prop-state.js readAttempt: started with
 * node scripts/combine.js start --account <profile>), so no entry trades a prop account without its floor and daily
 * limits tracked. The rule follows the account, not the mode: a marked practice account is judged as a live one.
 * A broker without `propAccounts` (the shipped config; a replay's, whose broker entry is the active one, so only a
 * mark in that entry would mark it) is judged exactly as before. Callers
 * apply it to entries only: exits, protective stops, stop moves, cancels and closes are never refused by it.
 *
 *   propAccountMarks(broker)       { marks: { id: profile }, error }: the marked accounts by normalized id; a
 *                                  malformed marker gives an error (and no marks), which refuses every entry
 *   propAccountRefusal({ broker, accountId, home, accounts, strategy })
 *                                  why an entry on accountId is refused, or null: a malformed marker; with any mark,
 *                                  an order naming no valid account id; on a marked account, a profile that isn't
 *                                  a valid account profile, a strategy sized for another profile, or no attempt
 *                                  running for its profile
 *
 *   propAccountMessage(why)        a refusal as the gate and the runner's start give it (exits still go)
 *   misplacedPropAccounts(env, { file, broker, replay })   where a "propAccounts" key sits that the gate never reads:
 *                                  [{ kind, message, fix }], kind 'top-level' (of the file in force), 'other-broker'
 *                                  (another broker's entry: that broker's, read when it is the active one) or
 *                                  'shadowed' (anywhere in the home's brokers.json while FTH_BROKERS_FILE names another
 *                                  file); `fix` says where to move it, null where moving it doesn't apply (another
 *                                  broker's entry; any key while a replay broker is active: moving it would mark the
 *                                  replay). Local files only; `file` is the brokers file in force, `broker` the active
 *                                  broker's name
 *
 * Attempts are kept per profile (combine/<profile>.json), so a profile marks one account at most: two accounts
 * under one profile would share one attempt's floor, and the marker is refused.
 */

const fs = require('fs');
const path = require('path');
const { normId } = require('../broker/allow-list');
const { harnessHome } = require('../paths');
const { readAttempt } = require('./prop-state');

const PROFILE = /^[a-z0-9][a-z0-9_-]*$/; // an account profile's name (accounts.js, prop-state.js)
const KEY = 'propAccounts';

function propAccountMarks(broker) {
  const name = (broker && broker.name) || 'the broker';
  if (!broker || typeof broker !== 'object' || !(KEY in broker)) return { marks: {}, error: null };
  const raw = broker[KEY];
  const bad = why => ({ marks: {}, error: `broker "${name}": "${KEY}" in brokers.json ${why}; it maps each prop account id to its account profile, e.g. { "12345": "<profile>" }` });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(`is not an object (got ${JSON.stringify(raw)})`);
  const marks = new Map();
  const byProfile = new Map(); // Maps: a profile named like an Object property ("constructor") is just a name
  for (const [key, profile] of Object.entries(raw)) {
    const id = normId(key);
    if (id === null) return bad(`has ${JSON.stringify(key)}, which is not an account id`);
    if (typeof profile !== 'string' || !PROFILE.test(profile)) return bad(`maps account ${id} to ${JSON.stringify(profile)}, which is not an account profile name`);
    if (marks.has(id)) return bad(`lists account ${id} twice`);
    if (byProfile.has(profile)) return bad(`marks accounts ${byProfile.get(profile)} and ${id} under one profile, ${profile} (an attempt is kept per profile, so each profile marks one account)`);
    marks.set(id, profile);
    byProfile.set(profile, id);
  }
  return { marks: Object.fromEntries(marks), error: null };
}

function propAccountRefusal({ broker, accountId, home, accounts = [], strategy = null }) {
  const { marks, error } = propAccountMarks(broker);
  if (error) return `${error}. Every entry is refused until it is fixed (the user's config)`;
  const ids = Object.keys(marks);
  if (!ids.length) return null;
  const id = normId(accountId);
  if (id === null) return `the order names no valid accountId (${JSON.stringify(accountId)}), so whether it is a marked prop account can't be told`;
  if (!ids.includes(id)) return null;
  const profile = marks[id];
  const account = (accounts || []).find(a => a && a.name === profile);
  if (!account || !account.valid) {
    return `account ${id} is marked as a prop account under "${profile}", which is ${account ? `an invalid account profile (${(account.errors || [])[0] || 'invalid'})` : 'not an account profile (accounts/<name>/ACCOUNT.md)'}`;
  }
  if (strategy && strategy.account && strategy.account !== profile) {
    return `setup:${strategy.name} is sized for the ${strategy.account} profile, but account ${id} is marked as a ${profile} prop account`;
  }
  if (!readAttempt(home, profile)) {
    return `account ${id} is a ${profile} prop account and no ${profile} attempt is running, so its floor and daily limits aren't tracked. Starting one is the user's: node scripts/combine.js start --account ${profile}`;
  }
  return null;
}

function propAccountMessage(why) {
  return `${why}. Exits, protective stops, stop moves, cancels and close_position still go.`;
}

/** A brokers file's JSON, or null when it is missing or unreadable (the broker config refuses those itself). */
function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_err) {
    return null;
  }
}

/** Every place in `cfg` (one brokers file) a propAccounts key sits: [{ top, name }], the active broker's entry left out when `active`. */
function keysIn(cfg, { active = null } = {}) {
  const out = [];
  if (!cfg) return out;
  if (KEY in cfg) out.push({ top: true, name: null });
  const brokers = cfg.brokers && typeof cfg.brokers === 'object' && !Array.isArray(cfg.brokers) ? cfg.brokers : {};
  for (const [name, b] of Object.entries(brokers)) {
    if (name !== active && b && typeof b === 'object' && KEY in b) out.push({ top: false, name });
  }
  return out;
}

function misplacedPropAccounts(env = process.env, { file, broker, replay = false }) {
  const active = path.resolve(String(file));
  const home = path.resolve(path.join(harnessHome(env), 'brokers.json'));
  const where = (k, f) => (k.top ? `at the top level of ${f}` : `under broker "${k.name}" in ${f}`);
  const moveTo = `move it under broker "${broker}" in ${active} to mark the account`;
  const out = keysIn(readJson(active), { active: broker }).map(k => (k.top
    ? { kind: 'top-level', message: `"${KEY}" found ${where(k, active)}: only the active broker's entry is read ("${broker}")`, fix: replay ? null : moveTo }
    : { kind: 'other-broker', message: `"${KEY}" found ${where(k, active)}: not read while "${broker}" is the active broker`, fix: null }));
  if (home !== active) {
    for (const k of keysIn(readJson(home))) {
      out.push({ kind: 'shadowed', message: `"${KEY}" found ${where(k, home)}: not read while FTH_BROKERS_FILE names ${active} ("${broker}" is the active broker)`, fix: replay ? null : moveTo });
    }
  }
  return out;
}

module.exports = { propAccountMarks, propAccountRefusal, propAccountMessage, misplacedPropAccounts };
