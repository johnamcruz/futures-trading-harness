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
const { evaluateOrder, evaluateModify, formatBlock, isRiskReducing } = require('./order-gate');
const { loadStrategies } = require('./strategies');
const { loadAccounts } = require('./accounts');
const { resolveClock, createGatewayClock } = require('./harness-now');

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
 * Returns { allowed, intent, violations, message, now }. `tool` is the broker tool
 * being called: place_order (default), modify_order, cancel_order, or
 * partial_close_position. `clock` is the harness clock (harness-now.js; the
 * gateway passes the one it pinned, else it is resolved here from env); `now`
 * overrides its time. `now` in the result is the time the checks ran at.
 */
function checkOrder(input, { env = process.env, pluginRoot, now = null, clock = null, tool = 'place_order', transcriptPath = null } = {}) {
  const c = clock || resolveClock(env);
  // A refused FTH_REPLAY_NOW (no replay broker, unparseable): no new entry. Risk-reducing actions are judged as
  // usual, at the wall clock (a refused override means a live broker), so a position can always be protected or closed.
  if (c.refused && tool === 'place_order' && !isRiskReducing((input || {}).rationale)) {
    const violations = [{ check: 'replay-clock', message: `${c.refused} Exits, protective stops, stop moves, cancels and close_position still go.` }];
    return { allowed: false, intent: 'entry', violations, message: formatBlock(violations), now: c.now() };
  }
  if (!now) now = c.now();
  const config = loadConfig(env);
  // cancel_order and partial_close_position need live account data; only the gateway checks them (account-gate.js).
  if (tool === 'cancel_order' || tool === 'partial_close_position') return { allowed: true, intent: tool === 'cancel_order' ? 'cancel' : 'risk-reducing', violations: [], message: '', now };
  if (tool === 'modify_order') {
    const r = evaluateModify({ input: input || {}, config });
    const ok = r.violations.length === 0;
    return { allowed: ok, intent: r.intent, violations: r.violations, message: ok ? '' : formatBlock(r.violations), now };
  }
  let journalPath;
  try {
    journalPath = resolveJournalPath(env);
  } catch (err) {
    // A broken broker config: no journal to read, so no order (fails closed), but say how to get flat.
    const violations = [{ check: 'broker-config', message: `${err.message}. Fix the broker config; meanwhile close_position still flattens a position.` }];
    return { allowed: false, intent: 'unknown', violations, message: formatBlock(violations), now };
  }
  const journal = readJournalWindow(journalPath);
  const result = evaluateOrder({
    input: input || {},
    entries: journal.entries,
    journalTruncated: journal.truncated,
    now,
    config,
    blackouts: readBlackouts(config.blackoutsFile),
    strategies: loadStrategies(pluginRoot, env).strategies,
    accounts: loadAccounts(pluginRoot, env).accounts,
    transcriptPath,
  });
  const allowed = result.violations.length === 0;
  return { allowed, intent: result.intent, violations: result.violations, message: allowed ? '' : formatBlock(result.violations), now };
}

function gateLogPath(env = process.env) {
  return String(env.FTH_GATE_LOG || '').trim()
    // Under logs/, which autonomous agents may read: a blocked order's reason is part of its review.
    || path.join(harnessHome(env), 'logs', 'gate-log.jsonl');
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

// The gate's clock too (harness-now.js), so the gateway takes its time where it takes its checks.
module.exports = { readBlackouts, checkOrder, gateLogPath, logDecision, createGatewayClock };
