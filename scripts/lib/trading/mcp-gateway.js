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

const ORDER_TOOL = /(?:^|__)(place_order|modify_order|cancel_order)$/;
// Calls that change orders or positions: the gateway waits for the server's
// answer to each before reading the next client message, so a check never
// runs while an earlier order is still in flight.
const LANE_TOOL = /(?:^|__)(place_order|modify_order|cancel_order|close_position|partial_close_position)$/;
const INTERNAL_ID = /^fth-gw-/;

/** The gated tool name ('place_order' | 'modify_order') for a tools/call message, else null. */
function orderTool(msg) {
  if (!(msg && typeof msg === 'object' && msg.method === 'tools/call' && msg.params)) return null;
  const m = ORDER_TOOL.exec(String(msg.params.name || ''));
  return m ? m[1] : null;
}

function isOrderCall(msg) {
  return orderTool(msg) !== null;
}

/** True for a tools/call that changes orders or positions. */
function isLaneCall(msg) {
  return Boolean(msg && typeof msg === 'object' && msg.method === 'tools/call' && msg.params
    && LANE_TOOL.test(String(msg.params.name || '')));
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
 * Resolves to { forward: string|null, respond: object[] }.
 * `check(args, tool)` returns (or resolves to) { allowed, message, violations }
 * and may throw or reject; either blocks the order (fail closed).
 */
async function handleClientLine(line, check, log = () => {}) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_err) {
    return { forward: line, respond: [] }; // not ours to judge; the server will reject it
  }

  const decide = async item => {
    // Ids starting with fth-gw- belong to the gateway's own calls to the server.
    if (item && typeof item === 'object' && typeof item.id === 'string' && INTERNAL_ID.test(item.id)) {
      return { blocked: { jsonrpc: '2.0', id: item.id, error: { code: -32600, message: 'request ids starting with fth-gw- are reserved by the gateway' } } };
    }
    const tool = orderTool(item);
    if (!tool) return { item };
    const args = item.params.arguments || {};
    let result;
    try {
      result = await check(args, tool, item.id);
    } catch (err) {
      result = { allowed: false, message: `Blocked by trading harness gateway: the order gate could not run (${err.message}). The order was not sent.`, violations: [{ check: 'gateway-error', message: err.message }] };
    }
    log({ source: 'gateway', tool, decision: result.allowed ? 'allowed' : 'blocked', violations: result.violations || [], contractId: args.contractId, rationale: args.rationale });
    if (result.allowed) return { item };
    // A notification (no id) can't receive a response; drop it.
    return { blocked: item.id === undefined ? null : blockedResponse(item.id, result.message) };
  };

  if (Array.isArray(msg)) {
    const decisions = [];
    for (const item of msg) decisions.push(await decide(item));
    const passed = decisions.filter(d => d.item).map(d => d.item);
    return {
      forward: passed.length ? JSON.stringify(passed) : null,
      respond: decisions.filter(d => d.blocked).map(d => d.blocked),
    };
  }
  const d = await decide(msg);
  if (d.item) return { forward: line, respond: [] };
  return { forward: null, respond: d.blocked ? [d.blocked] : [] };
}

/**
 * Calls tools on the wrapped server on the gateway's own behalf. Requests use
 * ids prefixed "fth-gw-" and their responses are consumed here, never shown to
 * the client.
 */
function childCaller(writeToChild, { timeoutMs = 15000, nonce = require('crypto').randomBytes(6).toString('hex') } = {}) {
  let seq = 0;
  const pending = new Map();
  return {
    call(name, args) {
      seq += 1;
      const id = `fth-gw-${nonce}-${seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${name} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, name });
        writeToChild(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
      });
    },
    /** Returns true when the server line was a response to one of our calls. */
    consume(line) {
      if (!line.includes('"fth-gw-')) return false;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_err) {
        return false;
      }
      const p = msg && typeof msg.id === 'string' ? pending.get(msg.id) : null;
      if (!p) return false;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.name}: ${msg.error.message || 'error'}`));
      else p.resolve(msg.result);
      return true;
    },
    rejectAll(reason) {
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
        pending.delete(id);
      }
    },
  };
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

module.exports = { orderTool, isOrderCall, isLaneCall, blockedResponse, handleClientLine, childCaller, lineSplitter };
