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
const { evaluateOrder, evaluateModify, formatBlock, isRiskReducing, SETUP_TAG } = require('./order-gate');
const { loadStrategies } = require('./strategies');
const { loadAccounts } = require('./accounts');
const { resolveClock, createGatewayClock } = require('./harness-now');
const { activeBroker } = require('../broker/config');
const { liveEntryRefusal } = require('../broker/allow-list');
const { propAccountRefusal, propAccountMessage } = require('./prop-accounts');
const { heldByRunner } = require('../account-lock');
const { loadEnvFiles } = require('../env-file');

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
  // A refused config file (CRITICAL, tunables.js): logged to the gate log on every check, and no new entry. Exits,
  // protective stops, cancels, stop moves and closes still go, judged as usual on the built-in values.
  if (config.configCritical) {
    logDecision({ source: 'gate', decision: 'config-critical', call: tool, message: config.configCritical }, env); // no `tool`: never read as an order
    if (tool === 'place_order' && !isRiskReducing((input || {}).rationale)) {
      const violations = [{ check: 'config-critical', message: `${config.configCritical} Exits, protective stops, cancels and close_position still go.` }];
      return { allowed: false, intent: 'entry', violations, message: formatBlock(violations), now };
    }
  }
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
  const strategies = loadStrategies(pluginRoot, env).strategies;
  const accounts = loadAccounts(pluginRoot, env).accounts;
  const result = evaluateOrder({
    input: input || {},
    entries: journal.entries,
    journalTruncated: journal.truncated,
    now,
    config,
    blackouts: readBlackouts(config.blackoutsFile),
    strategies,
    accounts,
    transcriptPath,
  });
  // A live entry needs the broker's allow-list (broker/allow-list.js) holding its account: never "any account".
  // Paper runs and confirmed replays are exempt; exits, protective stops and closes never reach this. The broker's
  // settings as its server gets them: the environment, then the .env files the gateway loads (env-file.js).
  if (result.intent !== 'risk-reducing') {
    const serverEnv = { ...env };
    loadEnvFiles({ env: serverEnv });
    const why = liveEntryRefusal({ broker: activeBroker(env), env: serverEnv, accountId: (input || {}).accountId, replay: c.replay === true });
    if (why) result.violations.push({ check: 'allowed-accounts', message: `${why}. Exits, protective stops, cancels and close_position still go.` });
    // Outside a runner (no FTH_ACCOUNT_LOCK): no entry on an account a live runner holds (account-lock.js).
    const held = config.accountLock ? null : heldByRunner({ env: serverEnv, broker: activeBroker(env), accountId: (input || {}).accountId });
    if (held) result.violations.push({ check: 'account-lock', message: held });
    // An account the user marks as a prop account (its broker's propAccounts, prop-accounts.js) enters only while its
    // profile's attempt runs, in every mode (a marked practice account is judged as live). Unmarked: nothing changes.
    const setup = SETUP_TAG.exec(String((input || {}).rationale || ''));
    const strategy = setup ? strategies.find(x => x.name === setup[1].toLowerCase()) || null : null;
    const prop = propAccountRefusal({ broker: activeBroker(env), accountId: (input || {}).accountId, home: config.home, accounts, strategy });
    if (prop) result.violations.push({ check: 'prop-account-attempt', message: propAccountMessage(prop) });
  }
  const allowed = result.violations.length === 0;
  return { allowed, intent: result.intent, violations: result.violations, message: allowed ? '' : formatBlock(result.violations), now, ...(result.composed ? { composed: result.composed } : {}) };
}

function gateLogPath(env = process.env) {
  return String(env.FTH_GATE_LOG || '').trim()
    // Under logs/, which autonomous agents may read: a blocked order's reason is part of its review.
    || path.join(harnessHome(env), 'logs', 'gate-log.jsonl');
}

/**
 * The runner's cycle a process runs in, as an id: a hash of its FTH_CYCLE_TRANSCRIPT (a file of that run's own, set
 * only by the runner: autotrader.js childEnv), or null outside one. The gate log stamps it on each decision, so the
 * cycle log takes only its own cycle's orders (cycle-log.js gateOrders). A role the runner runs after the head trader
 * for the same cycle (the entry workflow's trade-executor: runner-entry.js) is its own run with its own transcript: the
 * runner gives it the head trader's id as FTH_CYCLE_ID (16 hex characters; anything else is ignored), so its orders are
 * the cycle's.
 */
const CYCLE_ID = /^[0-9a-f]{16}$/;
function cycleId(env = process.env) {
  const given = String((env && env.FTH_CYCLE_ID) || '').trim();
  if (CYCLE_ID.test(given)) return given;
  const t = String((env && env.FTH_CYCLE_TRANSCRIPT) || '').trim();
  return t ? require('crypto').createHash('sha256').update(t).digest('hex').slice(0, 16) : null;
}

/**
 * The transcript a hook's order check reads: the one the harness passes (`given`, its session's), except in a role the
 * runner runs for its cycle's entry (an autonomous run with the head trader's id, FTH_CYCLE_ID, and its own streamed
 * transcript, FTH_CYCLE_TRANSCRIPT: runner-entry.js on Claude Code): null, so the hook judges the order as the gateway
 * does, on that run's streamed transcript and the cycle's role record (the head trader's loads, the desk, phase 2).
 * That session's own file holds none of the head trader's loads, so the hook would refuse what the gateway allows.
 */
function hookTranscript(given, env = process.env) {
  const e = env || {};
  const entryRole = String(e.FTH_AUTONOMOUS || '') === '1' && CYCLE_ID.test(String(e.FTH_CYCLE_ID || '').trim()) && Boolean(String(e.FTH_CYCLE_TRANSCRIPT || '').trim());
  return entryRole ? null : (given || null);
}

/** Append a decision to the gate log (best effort; never throws), with the runner's cycle id when in one. */
function logDecision(entry, env = process.env) {
  try {
    const file = gateLogPath(env);
    const cycle = cycleId(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry, ...(cycle ? { cycle } : {}) })}\n`);
  } catch (_err) {
    // logging must never change the decision
  }
}

// The gate's clock too (harness-now.js), so the gateway takes its time where it takes its checks.
module.exports = { readBlackouts, checkOrder, gateLogPath, logDecision, cycleId, hookTranscript, createGatewayClock };
