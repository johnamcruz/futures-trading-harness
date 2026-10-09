'use strict';

/**
 * PreToolUse hook for the broker MCP server's place_order and modify_order (Claude Code,
 * Codex, Qwen Code). Blocks new entries and order resizes (exit 2) that break the rules in
 * scripts/lib/trading/order-gate.js. Runs fail-closed through run-with-flags.js:
 * a crash blocks the order. Reads only local state; no network.
 * The MCP gateway (scripts/mcp-gateway.js) applies the same check for clients
 * without hooks.
 */

const path = require('path');
const { checkOrder, logDecision } = require('../lib/trading/check-order');
const { gateNow } = require('../lib/trading/config');

// Any MCP server's order tools (the broker server, under whatever name an older install registered it).
const ORDER_TOOL = /^mcp__.+__(place_order|modify_order)$/i;

function run(rawInput, ctx = {}, deps = {}) {
  const payload = JSON.parse(rawInput);
  const match = ORDER_TOOL.exec(String(payload.tool_name || ''));
  if (!match) return '';

  const env = deps.env || process.env;
  const input = payload.tool_input || {};
  const result = checkOrder(input, {
    env,
    pluginRoot: ctx.pluginRoot || path.resolve(__dirname, '..', '..'),
    now: deps.now || gateNow(env),
    tool: match[1].toLowerCase(),
    // Claude Code passes the session transcript: the gate checks the trading skills were loaded.
    transcriptPath: payload.transcript_path || null,
  });
  if (result.allowed) return '';

  logDecision({ source: 'hook', decision: 'blocked', violations: result.violations, contractId: input.contractId, rationale: input.rationale }, env);
  return { stderr: result.message, exitCode: 2 };
}

module.exports = { run };
