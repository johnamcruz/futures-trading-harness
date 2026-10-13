'use strict';

/**
 * Which broker MCP server the harness uses: config, not code. Every server
 * lives in its own repo and implements the broker MCP interface
 * (docs/BROKER-MCP-INTERFACE.md); the harness knows only these settings.
 *
 *   mcp-configs/brokers.json        the defaults
 *   <FTH_HOME>/brokers.json         yours: adds brokers or overrides fields
 *   FTH_BROKERS_FILE                another file instead of yours
 *   FTH_BROKER                      the broker to use (else the file's "broker")
 *
 * A broker: { description, repo, entry | entryEnv | command, journal, journalEnv,
 * env, paperEnv, replay, fingerprintEnv }. `replay: true` marks a simulated broker that replays
 * history: only then may FTH_REPLAY_NOW set the harness's clock
 * (trading/harness-now.js). A broker the defaults define without it stays live
 * whatever an override says, and keeps its shipped `paperEnv`,
 * `allowedAccountsEnv` (the order gate trusts them) and `fingerprintEnv`. `env` lists the variables its server reads (credentials,
 * guardrails), which harnesses must forward to it; `paperEnv` is what a paper
 * run sets so the server refuses every order.
 * `fingerprintEnv` is the allowlist of its settings that shape the bars it
 * serves (R35): only they go into a session's fingerprint and hash (each value
 * as an HMAC keyed on the home's salt, never the value itself); a name that
 * looks like a credential, or isn't one of its `env`, is refused (never read),
 * and any variable not on the list is never recorded.
 * `command` is the server's argv; else `entry` (a .js file run with node), or
 * the path in the variable `entryEnv`. The journal is the file the server
 * writes (the variable `journalEnv` wins over `journal`).
 *
 * loadBrokers(env)            { broker, brokers } merged
 * activeBroker(env)           the chosen broker, resolved: { name, ..., command, journalPath }
 * serverCommand(broker)       [command, ...args], or throws when no server is set
 * translatedCommand(broker)   the server behind the contract translator (scripts/contract-translator.js):
 *                             how the harness always starts it, so it only ever sees standard contract names
 * contractsCacheFile(name, env)  the translator's lookups for a broker (contracts-<name>.json)
 * fingerprintNames(broker)    { names, refused }: its fingerprintEnv, the credential-like names refused
 * fingerprintSettings(broker, env)   { name, settings: { VAR: digest | null }, refused }: the allowlisted settings,
 *                             each value as an HMAC keyed on the home's salt (valueDigest), never the value
 * fingerprintSalt(env)        the home's random salt (<FTH_HOME>/fingerprint.salt, made once, mode 0600)
 * SERVER_NAME                 the name every harness registers the server under
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { expandHome, harnessHome } = require('../paths');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULTS_FILE = path.join(ROOT, 'mcp-configs', 'brokers.json');
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const SERVER_NAME = 'broker';
// Settings of a shipped broker an override can't change (the gate's paper and allow-list checks read them).
// The fingerprint allowlist too: an override can't add a variable (a credential) to what a session records.
const LOCKED = ['paperEnv', 'allowedAccountsEnv', 'fingerprintEnv'];
// A variable name that looks like a credential: never on a fingerprint, whatever a config lists.
const CREDENTIAL = /KEY|SECRET|PASS|PWD|PIN|TOKEN|JWT|DSN|URL|URI|SESSION|BEARER|LOGIN|USER|AUTH|COOKIE|CERT|CREDENTIAL|PRIVATE/i;
const SALT_FILE = 'fingerprint.salt';
const SALT_RETRIES = 10;
const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

class BrokerConfigError extends Error {}

function readConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new BrokerConfigError(`${file}: ${err.message}`);
  }
}

/** A broker's paths resolved against its config file's folder (`~` expanded), so every process agrees. */
function resolvePaths(b, dir) {
  const abs = p => path.resolve(dir, expandHome(String(p)));
  const out = { ...b };
  if (out.entry) out.entry = abs(out.entry);
  if (out.journal) out.journal = abs(out.journal);
  if (Array.isArray(out.command) && out.command.length) out.command = [expandHome(String(out.command[0])), ...out.command.slice(1).map(String)];
  return out;
}

function loadBrokers(env = process.env) {
  const defaults = readConfig(DEFAULTS_FILE) || { brokers: {} };
  const explicit = String(env.FTH_BROKERS_FILE || '').trim();
  const userFile = explicit ? path.resolve(expandHome(explicit)) : path.join(harnessHome(env), 'brokers.json');
  const user = readConfig(userFile);
  if (!user && explicit) throw new BrokerConfigError(`FTH_BROKERS_FILE: ${userFile} does not exist`);
  const brokers = {};
  for (const [name, b] of Object.entries(defaults.brokers || {})) brokers[name] = resolvePaths(b, path.dirname(DEFAULTS_FILE));
  for (const [name, b] of Object.entries((user && user.brokers) || {})) {
    brokers[name] = { ...(brokers[name] || {}), ...resolvePaths(b, path.dirname(userFile)) };
    // A broker the defaults ship as live can't be made a replay broker by an override (harness-now.js).
    if (b && typeof b === 'object' && 'replay' in b && defaults.brokers && defaults.brokers[name] && defaults.brokers[name].replay !== true) brokers[name].replay = false;
    // Nor can it change what makes a run paper or which variable holds the allow-list: the order gate trusts them.
    const shipped = defaults.brokers && defaults.brokers[name];
    if (shipped) for (const k of LOCKED) { if (k in shipped) brokers[name][k] = shipped[k]; else delete brokers[name][k]; }
  }
  return { broker: (user && user.broker) || defaults.broker, brokers, file: userFile };
}

function activeBroker(env = process.env) {
  const cfg = loadBrokers(env);
  const name = String(env.FTH_BROKER || '').trim() || cfg.broker;
  if (!NAME.test(String(name || ''))) throw new BrokerConfigError(`broker name "${name}" is not valid`);
  const b = cfg.brokers[name];
  if (!b) throw new BrokerConfigError(`unknown broker "${name}": add it to ${cfg.file} (known: ${Object.keys(cfg.brokers).join(', ') || 'none'})`);
  const fromEnv = key => (key && String(env[key] || '').trim()) || '';
  const entry = String(b.entry || '').trim() || fromEnv(b.entryEnv);
  const command = Array.isArray(b.command) && b.command.length ? b.command.map(String) : entry ? [process.execPath, path.resolve(expandHome(entry))] : null;
  const journal = fromEnv(b.journalEnv) || String(b.journal || '').trim();
  const vars = Array.isArray(b.env) ? b.env.map(String) : [];
  return { ...b, name, command, env: vars, paperEnv: b.paperEnv && typeof b.paperEnv === 'object' ? b.paperEnv : {}, journalPath: journal ? path.resolve(expandHome(journal)) : path.join(harnessHome(env), 'journal.jsonl') };
}

function serverCommand(broker) {
  if (broker.command) return broker.command;
  const where = broker.entryEnv ? `set ${broker.entryEnv} or "entry"` : 'set "entry" or "command"';
  throw new BrokerConfigError(`broker ${broker.name}: no MCP server configured (${where} in brokers.json; the server is ${broker.repo || 'its own repo'})`);
}

function translatedCommand(broker) {
  return [process.execPath, path.join(ROOT, 'scripts', 'contract-translator.js'), '--broker', broker.name, '--', ...serverCommand(broker)];
}

function contractsCacheFile(name, env = process.env) {
  return path.join(harnessHome(env), `contracts-${String(name || 'default').replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

/**
 * A broker's fingerprint allowlist: the names it may record (each one of the variables its server reads, `env`,
 * and none that looks like a credential), and those refused (credential-like, malformed, or not in `env`).
 */
function fingerprintNames(broker) {
  const list = Array.isArray(broker && broker.fingerprintEnv) ? broker.fingerprintEnv.map(String) : [];
  const reads = new Set(Array.isArray(broker && broker.env) ? broker.env.map(String) : []);
  const names = [...new Set(list.filter(n => VAR.test(n) && !CREDENTIAL.test(n) && reads.has(n)))].sort();
  return { names, refused: [...new Set(list.filter(n => !names.includes(n)))].sort() };
}

/**
 * The home's fingerprint salt: random, made once (mode 0600) at <FTH_HOME>/fingerprint.salt and kept. Digests
 * keyed on it compare within the home; a record shared without it gives nothing to guess a value from.
 */
function fingerprintSalt(env = process.env, { retries = SALT_RETRIES } = {}) {
  const file = path.join(harnessHome(env), SALT_FILE);
  const read = () => {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  };
  let salt = read();
  if (salt === null) {
    // Made whole aside (synced), then linked into place: a reader never sees it half written, and of two
    // processes making it at once one link wins (the other's fails with EEXIST and reads the winner's).
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.writeSync(fd, crypto.randomBytes(32).toString('hex'));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try { fs.linkSync(tmp, file); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    salt = read();
  }
  // An empty or short salt (a salt written another way, still being written): read again, briefly.
  for (let i = 0; i < retries && !(salt && salt.length >= 32); i += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    salt = read();
  }
  if (!salt || salt.length < 32) throw new BrokerConfigError(`${file}: not a fingerprint salt (remove it to make a new one)`);
  return salt;
}

/** A setting's value as a fingerprint holds it: an HMAC-SHA256 keyed on the home's salt, truncated; unset or empty: null. */
const valueDigest = (v, salt) => (v === undefined || v === null || String(v) === '' ? null : `hmac-sha256:${crypto.createHmac('sha256', String(salt)).update(String(v)).digest('hex').slice(0, 16)}`);

/**
 * A broker's allowlisted settings, each by name with a keyed digest of its value (valueDigest, the home's salt:
 * two sessions of a home compare equal when the values are; no value is ever stored), and the names refused;
 * never another variable.
 */
function fingerprintSettings(broker, env = process.env, { salt = null } = {}) {
  const { names, refused } = fingerprintNames(broker);
  const key = names.length ? salt || fingerprintSalt(env) : null;
  return { name: (broker && broker.name) || null, settings: Object.fromEntries(names.map(k => [k, valueDigest(env[k], key)])), refused };
}

module.exports = { fingerprintNames, fingerprintSettings, fingerprintSalt, valueDigest, CREDENTIAL, translatedCommand, contractsCacheFile, SERVER_NAME, DEFAULTS_FILE, loadBrokers, activeBroker, serverCommand, BrokerConfigError };
