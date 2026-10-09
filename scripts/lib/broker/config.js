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
 * env, paperEnv }. `env` lists the variables its server reads (credentials,
 * guardrails), which harnesses must forward to it; `paperEnv` is what a paper
 * run sets so the server refuses every order.
 * `command` is the server's argv; else `entry` (a .js file run with node), or
 * the path in the variable `entryEnv`. The journal is the file the server
 * writes (the variable `journalEnv` wins over `journal`).
 *
 * loadBrokers(env)            { broker, brokers } merged
 * activeBroker(env)           the chosen broker, resolved: { name, ..., command, journalPath }
 * serverCommand(broker)       [command, ...args], or throws when no server is set
 * SERVER_NAME                 the name every harness registers the server under
 */

const fs = require('fs');
const path = require('path');
const { expandHome, harnessHome } = require('../paths');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULTS_FILE = path.join(ROOT, 'mcp-configs', 'brokers.json');
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const SERVER_NAME = 'broker';

class BrokerConfigError extends Error {}

function readConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new BrokerConfigError(`${file}: ${err.message}`);
  }
}

function loadBrokers(env = process.env) {
  const defaults = readConfig(DEFAULTS_FILE) || { brokers: {} };
  const userFile = String(env.FTH_BROKERS_FILE || '').trim() ? expandHome(String(env.FTH_BROKERS_FILE).trim()) : path.join(harnessHome(env), 'brokers.json');
  const user = readConfig(userFile) || {};
  const brokers = { ...defaults.brokers };
  for (const [name, b] of Object.entries(user.brokers || {})) brokers[name] = { ...(brokers[name] || {}), ...b };
  return { broker: user.broker || defaults.broker, brokers, file: userFile };
}

function activeBroker(env = process.env) {
  const cfg = loadBrokers(env);
  const name = String(env.FTH_BROKER || '').trim() || cfg.broker;
  if (!NAME.test(String(name || ''))) throw new BrokerConfigError(`broker name "${name}" is not valid`);
  const b = cfg.brokers[name];
  if (!b) throw new BrokerConfigError(`unknown broker "${name}": add it to ${cfg.file} (known: ${Object.keys(cfg.brokers).join(', ') || 'none'})`);
  const fromEnv = key => (key && String(env[key] || '').trim()) || '';
  const entry = String(b.entry || '').trim() || fromEnv(b.entryEnv);
  const command = Array.isArray(b.command) && b.command.length ? b.command.map(String) : entry ? [process.execPath, expandHome(entry)] : null;
  const journal = fromEnv(b.journalEnv) || String(b.journal || '').trim();
  const vars = Array.isArray(b.env) ? b.env.map(String) : [];
  return { ...b, name, command, env: vars, paperEnv: b.paperEnv && typeof b.paperEnv === 'object' ? b.paperEnv : {}, journalPath: journal ? path.resolve(expandHome(journal)) : path.join(harnessHome(env), 'journal.jsonl') };
}

function serverCommand(broker) {
  if (broker.command) return broker.command;
  const where = broker.entryEnv ? `set ${broker.entryEnv} or "entry"` : 'set "entry" or "command"';
  throw new BrokerConfigError(`broker ${broker.name}: no MCP server configured (${where} in brokers.json; the server is ${broker.repo || 'its own repo'})`);
}

module.exports = { SERVER_NAME, DEFAULTS_FILE, loadBrokers, activeBroker, serverCommand, BrokerConfigError };
