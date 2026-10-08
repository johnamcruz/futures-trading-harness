'use strict';

/**
 * One entry point for the order gate, shared by the PreToolUse hook (Claude
 * Code, Codex, Qwen Code) and the MCP gateway (any MCP client). Reads only
 * local state: config from env, the journal, the blackout and kill-switch
 * files, and the strategy registry. Throws on unreadable state so callers can
 * fail closed.
 */

const fs = require('fs');
const path = require('path');
const { harnessHome } = require('../paths');
const { loadConfig } = require('./config');
const { resolveJournalPath, readJournalWindow } = require('./journal');
const { evaluateOrder, evaluateModify, formatBlock } = require('./order-gate');
const { loadStrategies } = require('./strategies');

function readBlackouts(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { items: [] };
    return { items: [], error: err.code || err.message };
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? { items: parsed } : { items: [], error: 'expected a JSON array' };
  } catch (_err) {
    return { items: [], error: 'invalid JSON' };
  }
}

/**
 * Returns { allowed, intent, violations, message }. `tool` is the projectx tool
 * being called: place_order (default) or modify_order.
 */
function checkOrder(input, { env = process.env, pluginRoot, now = new Date(), tool = 'place_order' } = {}) {
  const config = loadConfig(env);
  // cancel_order needs live account data; only the gateway checks it (account-gate.js).
  if (tool === 'cancel_order') return { allowed: true, intent: 'cancel', violations: [], message: '' };
  if (tool === 'modify_order') {
    const r = evaluateModify({ input: input || {}, config });
    const ok = r.violations.length === 0;
    return { allowed: ok, intent: r.intent, violations: r.violations, message: ok ? '' : formatBlock(r.violations) };
  }
  const journal = readJournalWindow(resolveJournalPath(env));
  const result = evaluateOrder({
    input: input || {},
    entries: journal.entries,
    journalTruncated: journal.truncated,
    now,
    config,
    blackouts: readBlackouts(config.blackoutsFile),
    strategies: loadStrategies(pluginRoot, env).strategies,
  });
  const allowed = result.violations.length === 0;
  return { allowed, intent: result.intent, violations: result.violations, message: allowed ? '' : formatBlock(result.violations) };
}

function gateLogPath(env = process.env) {
  return String(env.FTH_GATE_LOG || '').trim()
    || path.join(harnessHome(env), 'gate-log.jsonl');
}

/** Append a decision to the gate log (best effort; never throws). */
function logDecision(entry, env = process.env) {
  try {
    const file = gateLogPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch (_err) {
    // logging must never change the decision
  }
}

module.exports = { readBlackouts, checkOrder, gateLogPath, logDecision };
