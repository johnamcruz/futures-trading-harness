'use strict';

/**
 * Message logic for the MCP order gateway: a stdio proxy that sits between any
 * MCP client (Claude Code, Codex, Qwen Code, Cursor, a custom agent loop...)
 * and projectx-mcp. MCP stdio transport is newline-delimited JSON-RPC, so the
 * gateway can inspect each client message without understanding the rest of
 * the protocol. `tools/call` for place_order runs the order gate; a blocked call
 * is answered by the gateway with an isError tool result and never reaches the
 * server. Everything else passes through unchanged.
 */

const PLACE_ORDER_TOOL = /(^|__)place_order$/;

function isOrderCall(msg) {
  return Boolean(msg && typeof msg === 'object' && msg.method === 'tools/call'
    && msg.params && PLACE_ORDER_TOOL.test(String(msg.params.name || '')));
}

function blockedResponse(id, text) {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }], isError: true },
  };
}

/**
 * Decide what to do with one line from the client.
 * Returns { forward: string|null, respond: object[] }.
 * `check(args)` returns { allowed, message, violations } and may throw; a throw
 * blocks the order (fail closed).
 */
function handleClientLine(line, check, log = () => {}) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_err) {
    return { forward: line, respond: [] }; // not ours to judge; the server will reject it
  }

  const decide = item => {
    if (!isOrderCall(item)) return { item };
    const args = item.params.arguments || {};
    let result;
    try {
      result = check(args);
    } catch (err) {
      result = { allowed: false, message: `Blocked by trading harness gateway: the order gate could not run (${err.message}). The order was not sent.`, violations: [{ check: 'gateway-error', message: err.message }] };
    }
    log({ source: 'gateway', decision: result.allowed ? 'allowed' : 'blocked', violations: result.violations || [], contractId: args.contractId, rationale: args.rationale });
    if (result.allowed) return { item };
    // A notification (no id) can't receive a response; drop it.
    return { blocked: item.id === undefined ? null : blockedResponse(item.id, result.message) };
  };

  if (Array.isArray(msg)) {
    const decisions = msg.map(decide);
    const passed = decisions.filter(d => d.item).map(d => d.item);
    return {
      forward: passed.length ? JSON.stringify(passed) : null,
      respond: decisions.filter(d => d.blocked).map(d => d.blocked),
    };
  }
  const d = decide(msg);
  if (d.item) return { forward: line, respond: [] };
  return { forward: null, respond: d.blocked ? [d.blocked] : [] };
}

/** Split a stream of chunks into complete lines; returns a push(chunk) function. */
function lineSplitter(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let i = buffer.indexOf('\n');
      while (i !== -1) {
        const line = buffer.slice(0, i).replace(/\r$/, '');
        buffer = buffer.slice(i + 1);
        if (line.trim() !== '') onLine(line);
        i = buffer.indexOf('\n');
      }
    },
    flush() {
      if (buffer.trim() !== '') onLine(buffer);
      buffer = '';
    },
  };
}

module.exports = { isOrderCall, blockedResponse, handleClientLine, lineSplitter };
