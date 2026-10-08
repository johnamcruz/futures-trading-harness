'use strict';

/**
 * PreToolUse hook for projectx-mcp place_order. Blocks new entries (exit 2)
 * that break the harness discipline rules in scripts/lib/trading/order-gate.js.
 * Runs fail-closed through run-with-flags.js: a crash blocks the order.
 * Reads only local state (journal file, blackout file, clock); no network.
 */

const fs = require('fs');
const { loadConfig } = require('../lib/trading/config');
const { resolveJournalPath, readJournal } = require('../lib/trading/journal');
const { evaluateOrder, formatBlock } = require('../lib/trading/order-gate');

const PLACE_ORDER = /^mcp__.*projectx.*__place_order$/i;

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

function run(rawInput, _ctx = {}, deps = {}) {
  const payload = JSON.parse(rawInput);
  if (!PLACE_ORDER.test(String(payload.tool_name || ''))) return '';

  const env = deps.env || process.env;
  const config = loadConfig(env);
  const result = evaluateOrder({
    input: payload.tool_input || {},
    entries: readJournal(resolveJournalPath(env)),
    now: deps.now || new Date(),
    config,
    blackouts: readBlackouts(config.blackoutsFile),
  });

  if (result.violations.length === 0) return '';
  return { stderr: formatBlock(result.violations), exitCode: 2 };
}

module.exports = { run, readBlackouts };
