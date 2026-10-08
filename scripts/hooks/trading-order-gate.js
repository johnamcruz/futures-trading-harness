'use strict';

/**
 * PreToolUse hook for projectx-mcp place_order (Claude Code, Codex, Qwen Code).
 * Blocks new entries (exit 2) that break the rules in
 * scripts/lib/trading/order-gate.js. Runs fail-closed through run-with-flags.js:
 * a crash blocks the order. Reads only local state; no network.
 * The MCP gateway (scripts/mcp-gateway.js) applies the same check for clients
 * without hooks.
 */

const path = require('path');
const { checkOrder, logDecision } = require('../lib/trading/check-order');

const PLACE_ORDER = /^mcp__.*projectx.*__place_order$/i;

function run(rawInput, ctx = {}, deps = {}) {
  const payload = JSON.parse(rawInput);
  if (!PLACE_ORDER.test(String(payload.tool_name || ''))) return '';

  const env = deps.env || process.env;
  const input = payload.tool_input || {};
  const result = checkOrder(input, {
    env,
    pluginRoot: ctx.pluginRoot || path.resolve(__dirname, '..', '..'),
    now: deps.now || new Date(),
  });
  if (result.allowed) return '';

  logDecision({ source: 'hook', decision: 'blocked', violations: result.violations, contractId: input.contractId, rationale: input.rationale }, env);
  return { stderr: result.message, exitCode: 2 };
}

module.exports = { run };
