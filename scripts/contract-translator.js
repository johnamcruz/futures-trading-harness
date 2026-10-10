#!/usr/bin/env node
/**
 * The contract translator in front of the selected broker MCP server: a stdio
 * proxy, so everything above it (the order gateway, agents, the runner) uses
 * standard contract names (MNQ, NQ, NQ:2026-03) and only the broker's server
 * sees its own ids. scripts/lib/broker/translator.js does the translating,
 * with lookups to the same server (search_contracts, get_contract).
 *
 *   node scripts/contract-translator.js --broker <name> -- <server command> [args...]
 *
 * The gateway and the broker adapter start it for the configured broker
 * (broker/config.js serverCommand). stdout carries only protocol messages.
 */

'use strict';

const { spawn } = require('child_process');
const { childCaller, lineSplitter } = require('./lib/trading/mcp-gateway');
const { createTranslator } = require('./lib/broker/translator');
const { contractsCacheFile } = require('./lib/broker/config');

const TOOL = name => String(name || '').replace(/^.*__/, '');
const errorResult = (id, text) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });

function main(argv) {
  const sep = argv.indexOf('--');
  const command = sep === -1 ? [] : argv.slice(sep + 1);
  const b = argv.indexOf('--broker');
  const broker = b !== -1 && b < (sep === -1 ? argv.length : sep) ? argv[b + 1] : process.env.FTH_BROKER || 'default';
  if (!command.length) {
    process.stderr.write('[contract-translator] usage: contract-translator.js --broker <name> -- <server command> [args...]\n');
    process.exit(2);
  }
  const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  child.stdin.on('error', err => process.stderr.write(`[contract-translator] server stdin: ${err.message}\n`));
  const toChild = line => { if (child.stdin.writable) child.stdin.write(`${line}\n`); };
  const write = msg => process.stdout.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);
  const caller = childCaller(toChild, { prefix: 'fth-tr-' });
  const translator = createTranslator({ call: (name, args) => caller.call(name, args), cacheFile: contractsCacheFile(broker, process.env) });
  const toolOf = new Map(); // request id -> tool name, for the answer

  // Server -> client: our own lookups are consumed at once (a translation may be waiting on one); the rest in order.
  let outQueue = Promise.resolve();
  const fromServer = lineSplitter(line => {
    if (caller.consume(line)) return;
    outQueue = outQueue.then(async () => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_err) {
        write(line);
        return;
      }
      const one = async m => {
        const tool = m && m.id !== undefined && m.method === undefined ? toolOf.get(m.id) : undefined;
        if (tool === undefined) return m;
        toolOf.delete(m.id);
        const r = m.result;
        if (!tool || !r || r.isError || !Array.isArray(r.content) || !r.content[0] || typeof r.content[0].text !== 'string') return m;
        let data;
        try {
          data = JSON.parse(r.content[0].text);
        } catch (_err) {
          return m;
        }
        const text = JSON.stringify(await translator.translateResult(tool, data), null, 2);
        return { ...m, result: { ...r, content: [{ ...r.content[0], text }, ...r.content.slice(1)] } };
      };
      try {
        write(Array.isArray(msg) ? await Promise.all(msg.map(one)) : await one(msg));
      } catch (err) {
        process.stderr.write(`[contract-translator] ${err.message}\n`);
        write(line);
      }
    });
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', c => fromServer.push(c));

  // Client -> server, in order: a contract name in the arguments becomes the broker's id.
  let inQueue = Promise.resolve();
  const fromClient = lineSplitter(line => {
    inQueue = inQueue.then(async () => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_err) {
        toChild(line);
        return;
      }
      const replies = [];
      const one = async m => {
        if (!m || m.method === undefined || m.id === undefined) return m;
        const tool = m.method === 'tools/call' && m.params ? TOOL(m.params.name) : null;
        toolOf.set(m.id, tool);
        if (!tool) return m;
        try {
          return { ...m, params: { ...m.params, arguments: await translator.translateArgs(tool, m.params.arguments || {}) } };
        } catch (err) {
          toolOf.delete(m.id);
          replies.push(errorResult(m.id, `contract: ${err.message}`));
          return null;
        }
      };
      const out = Array.isArray(msg) ? (await Promise.all(msg.map(one))).filter(Boolean) : await one(msg);
      for (const r of replies) write(r);
      if (out && (!Array.isArray(out) || out.length)) toChild(JSON.stringify(out));
    }).catch(err => process.stderr.write(`[contract-translator] ${err.message}\n`));
  });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => fromClient.push(c));
  process.stdin.on('end', () => {
    fromClient.flush();
    inQueue = inQueue.then(() => child.stdin.end());
  });
  child.on('error', err => {
    process.stderr.write(`[contract-translator] could not start the MCP server: ${err.message}\n`);
    process.exit(1);
  });
  child.on('close', (code, signal) => {
    fromServer.flush();
    caller.rejectAll('server exited');
    outQueue.then(() => process.stdout.write('', () => process.exit(code === null ? (signal ? 1 : 0) : code)));
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}

main(process.argv.slice(2));
