'use strict';

/**
 * Message logic for the MCP order gateway: a stdio proxy that sits between any
 * MCP client (Claude Code, Codex, Qwen Code, Cursor, a custom agent loop...)
 * and the broker MCP server. MCP stdio transport is newline-delimited JSON-RPC, so the
 * gateway can inspect each client message without understanding the rest of
 * the protocol. `tools/call` for place_order runs the order gate; a blocked call
 * is answered by the gateway with an isError tool result and never reaches the
 * server. Everything else passes through unchanged.
 */

// Calls the gateway checks; a full close_position never is (flattening always works).
const ORDER_TOOL = /(?:^|__)(place_order|modify_order|cancel_order|partial_close_position)$/;
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
      result = { allowed: false, message: `Blocked by trading harness gateway: the order gate could not run (${err.message}). The order was not sent; close_position still flattens.`, violations: [{ check: 'gateway-error', message: err.message }] };
    }
    log({ source: 'gateway', tool, decision: result.allowed ? 'allowed' : 'blocked', violations: result.violations || [], contractId: args.contractId, side: args.side, size: args.size, type: args.type, rationale: args.rationale });
    if (result.allowed) return { item };
    // A notification (no id) can't receive a response; drop it.
    return { blocked: item.id === undefined ? null : blockedResponse(item.id, result.message) };
  };

  if (Array.isArray(msg)) {
    // Order calls go one at a time, each checked against the account after
    // the one before: a batch would check them all against one snapshot.
    if (msg.some(isLaneCall)) {
      const respond = msg.filter(m => m && m.id !== undefined).map(m => blockedResponse(m.id, 'Blocked by trading harness gateway: order calls (place, modify, cancel, close) are not accepted in a JSON-RPC batch. Send them one at a time.'));
      log({ source: 'gateway', tool: 'batch', decision: 'blocked', violations: [{ check: 'batch', message: 'order call in a batch' }] });
      return { forward: null, respond };
    }
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

/** How long the gateway waits on one of its own calls to the server (an account read) before it fails closed. */
const CALL_TIMEOUT_MS = 15000;
/**
 * How long the contract translator waits on one of its own lookups (search_contracts, get_contract). Seconds longer than
 * the callers that read through the translator wait on a call (the gateway's account reads, CALL_TIMEOUT_MS; the
 * broker adapter's reads client): a hung lookup ends with the caller's timeout (the gate fails closed), not in a tie
 * of two equal timers in two processes, where whichever fired first decided between a refusal and an answer named
 * from the cache. Shorter than the order lane (DEFAULT_LANE_TIMEOUT_MS): an order whose contract lookup hangs is
 * normally answered "not sent" before the lane gives up on it (behind another hung lookup it may not be, and is then
 * an order of unknown outcome, which still blocks new entries).
 */
const LOOKUP_TIMEOUT_MS = CALL_TIMEOUT_MS + 5000;
/** How long the gateway holds the order lane for a server reply by default (FTH_LANE_TIMEOUT_MS overrides). */
const DEFAULT_LANE_TIMEOUT_MS = 30000;

/**
 * Calls tools on the wrapped server on the gateway's own behalf. Requests use
 * ids prefixed "fth-gw-" and their responses are consumed here, never shown to
 * the client.
 */
function childCaller(writeToChild, { timeoutMs = CALL_TIMEOUT_MS, nonce = require('crypto').randomBytes(6).toString('hex'), prefix = 'fth-gw-' } = {}) {
  let seq = 0;
  const pending = new Map();
  return {
    call(name, args) {
      seq += 1;
      const id = `${prefix}${nonce}-${seq}`;
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
      if (!line.includes(`"${prefix}`)) return false;
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

/**
 * The call's arguments with its contract under its one standard name (the
 * translator's cache: MNQ:2026-12 or the broker's own id for today's front
 * month become MNQ), so the gate and its ledger of recent orders compare
 * like with like. Only for checking: the call goes out as the client sent it.
 * The translator may look the front month up while the gateway reads the
 * account (the first call of a trading day, the first after a roll, under a
 * replay clock each replayed day's own cache file: broker/config.js
 * contractsCacheFile), so the call carries RENAME (account-gate.js): after
 * the account reads, the call, the positions, the orders and the gate's
 * ledger are named again from one read of the file, the front month the
 * positions were named with. Only the front month recorded for the trading
 * day of the check names a month by its root, and a check whose trading day
 * changes before that read fails closed (the root may mean another month).
 */
function canonicalArgs(args, env = process.env) {
  if (!args || typeof args !== 'object') return args;
  try {
    const { activeBroker, contractsCacheFile } = require('../broker/config');
    const { readCache, canonicalName, monthName } = require('../broker/translator');
    const { tradingDayKey } = require('./clock');
    const { RENAME } = require('./account-gate');
    const clock = require('./harness-now').resolveClock(env);
    const file = contractsCacheFile(activeBroker(env).name, env);
    const day = tradingDayKey(clock.now());
    // One read of the cache, when called: how every contract is named from it.
    const rename = () => {
      const at = tradingDayKey(clock.now());
      if (at !== day) throw new Error(`the trading day changed while the call was checked (${day} to ${at}); send it again`);
      const cache = readCache(file);
      const names = id => (typeof id === 'string' ? canonicalName(id, cache, day) : id);
      // The month a ledger entry or an order record keeps (account-gate.js ledgerName), from the same read.
      return Object.assign(names, { month: id => monthName(id, cache, day) });
    };
    // A call without a contract (cancel_order, modify_order) still names the positions and orders it is checked
    // against from that one read: a lookup that failed for one list and not the other never splits a contract in two.
    const named = typeof args.contractId === 'string' ? { contractId: canonicalName(args.contractId, readCache(file), day) } : {};
    return { ...args, ...named, [RENAME]: rename };
  } catch (_err) {
    return args; // no broker config: the names are compared as given
  }
}

/**
 * The ledger entry for a close_position / partial_close_position about to be
 * sent, from the account before it ({ contractId, root, sign, size, netBefore,
 * rootNetBefore, at, sentAt }), or null when there is nothing to close. A
 * close is a market order the account may not show yet: the gateway counts it
 * from the moment it is sent (a late or lost reply still closes), and drops it
 * only if the server refuses it. It is `unconfirmed` until the server says
 * success: a close of unknown outcome counts against new exits and stop
 * moves, never to let a stop of the still-open position be cancelled.
 */
function closeLedgerEntry(tool, args, positions, now) {
  if (!Array.isArray(positions)) return null;
  const { contractNet, netPosition, renamed } = require('./account-gate');
  const r = renamed(args, positions); // named again with the positions (canonicalArgs)
  const kept = r.names && r.names.month ? r.names.month(args.contractId) : args.contractId; // by its month (ledgerName)
  ({ args, positions } = r);
  const { contractRoot } = require('./journal');
  const net = contractNet(positions, args.contractId);
  const size = tool === 'partial_close_position' ? Math.min(Number(args.size) || 0, Math.abs(net)) : Math.abs(net);
  if (!(size > 0)) return null;
  const at = now.getTime();
  return { contractId: kept, root: contractRoot(args.contractId), sign: -Math.sign(net), size, netBefore: net, rootNetBefore: netPosition(positions, args.contractId), at, sentAt: at, unconfirmed: true };
}

/** A tool reply's JSON body (content[0].text), or null. */
function resultJson(response) {
  try {
    return JSON.parse(response.result.content[0].text);
  } catch (_err) {
    return null;
  }
}

/**
 * Whether the server surely refused a close: a body saying success: false, a
 * sure refusal in an error reply (a risk guardrail, the contract translator's
 * "not sent": order-markers.definitelyRefused), or a malformed request
 * (JSON-RPC -32600..-32602). Any other error (a timeout, a broken call) is an
 * unknown outcome: the broker may have taken the close, so it still counts.
 */
function closeRefused(response) {
  if (!response) return false;
  if (response.error) return [-32600, -32601, -32602].includes(Number(response.error.code));
  if (!response.result) return false;
  if (response.result.isError) {
    const text = Array.isArray(response.result.content) && response.result.content[0] ? response.result.content[0].text : '';
    return require('./order-markers').definitelyRefused(text);
  }
  const body = resultJson(response);
  return Boolean(body) && body.success === false;
}

module.exports = { CALL_TIMEOUT_MS, LOOKUP_TIMEOUT_MS, DEFAULT_LANE_TIMEOUT_MS, canonicalArgs, closeLedgerEntry, closeRefused, resultJson, orderTool, isOrderCall, isLaneCall, blockedResponse, handleClientLine, childCaller, lineSplitter };
