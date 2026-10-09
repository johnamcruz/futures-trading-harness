'use strict';

/**
 * A minimal MCP client over stdio (newline-delimited JSON-RPC), for the
 * harness's own calls to a broker's MCP server: the runner's reads and
 * housekeeping (broker/adapter.js) and the conformance checker
 * (scripts/check-broker-mcp.js). No dependencies.
 *
 *   createMcpClient({ command, args, env, timeoutMs, spawnFn })
 *     .listTools()              tools/list -> [{ name, inputSchema, ... }]
 *     .call(name, args)         tools/call -> the result's JSON (content[0].text,
 *                               parsed), or throws with the server's text on
 *                               isError or a JSON-RPC error
 *     .close()
 *
 * The server starts on the first request (initialize, then
 * notifications/initialized) and again on the next request after it exits.
 */

const { spawn } = require('child_process');
const { lineSplitter } = require('../trading/mcp-gateway');

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 15000;

class McpError extends Error {}

function createMcpClient({ command, args = [], env = process.env, cwd = undefined, timeoutMs = DEFAULT_TIMEOUT_MS, spawnFn = spawn, clientName = 'futures-trading-harness' }) {
  if (!command) throw new McpError('no MCP server command');
  let child = null;
  let ready = null;
  let seq = 0;
  const pending = new Map();
  let stderrTail = '';

  // Fail the requests sent to one server process (`owner`), or every request: a replaced server's exit
  // must not fail the requests already sent to its successor.
  const failAll = (reason, owner = null) => {
    for (const [id, p] of pending) {
      if (owner && p.owner !== owner) continue;
      clearTimeout(p.timer);
      p.reject(new McpError(reason));
      pending.delete(id);
    }
  };

  function send(method, params) {
    seq += 1;
    const id = seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new McpError(`${method}${params && params.name ? ` ${params.name}` : ''}: no answer in ${timeoutMs / 1000} s`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method, owner: child });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    });
  }

  function start() {
    child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd });
    const lines = lineSplitter(line => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_err) {
        return; // not protocol (a server must log to stderr, but don't trust it)
      }
      const p = msg && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new McpError(`${p.method}: ${msg.error.message || 'error'}`));
      else p.resolve(msg.result);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', c => lines.push(c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => { stderrTail = (stderrTail + c).slice(-500); });
    child.stdin.on('error', () => {});
    const self = child;
    child.on('error', err => { if (child === self) { child = null; ready = null; } failAll(`MCP server failed to start: ${err.message}`, self); });
    child.on('close', code => {
      if (child === self) {
        child = null;
        ready = null;
      }
      failAll(`MCP server exited (code ${code})${stderrTail ? `: ${stderrTail.trim().split('\n').pop()}` : ''}`, self);
    });
    ready = send('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: clientName, version: '1' } })
      .then(init => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        return init;
      }, err => {
        // No handshake (a slow cold start, a broken server): stop it, so the next request starts it afresh.
        if (child === self) {
          child = null;
          ready = null;
          self.stdin.end();
          self.kill();
        }
        throw err;
      });
    ready.catch(() => {});
    return ready;
  }

  const connected = () => (child && ready ? ready : start());

  return {
    async listTools() {
      await connected();
      const res = await send('tools/list', {});
      return (res && res.tools) || [];
    },
    async call(name, args = {}) {
      await connected();
      const res = await send('tools/call', { name, arguments: args });
      const text = res && Array.isArray(res.content) && res.content[0] && typeof res.content[0].text === 'string' ? res.content[0].text : '';
      if (!res || res.isError) throw new McpError(`${name}: ${text.slice(0, 300) || 'error'}`);
      try {
        return JSON.parse(text);
      } catch (_err) {
        throw new McpError(`${name}: the result is not JSON (${text.slice(0, 120)})`);
      }
    },
    close() {
      if (child) {
        const c = child;
        child = null;
        ready = null;
        c.stdin.end();
        c.kill();
      }
      failAll('MCP client closed');
    },
  };
}

module.exports = { createMcpClient, McpError, PROTOCOL_VERSION };
