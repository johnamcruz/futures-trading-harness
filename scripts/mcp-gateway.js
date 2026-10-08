#!/usr/bin/env node
/**
 * MCP order gateway: run projectx-mcp behind the harness order gate so every
 * MCP client gets the same enforcement, with or without hook support.
 *
 *   node scripts/mcp-gateway.js -- node /abs/path/projectx-mcp/dist/index.js
 *   PROJECTX_MCP_ENTRY=/abs/path/projectx-mcp/dist/index.js node scripts/mcp-gateway.js
 *
 * Register THIS command as the MCP server named "projectx" in your harness
 * (see mcp-configs/). Credentials stay in the server's env; the gateway passes
 * its environment to the child unchanged and never reads or logs them.
 * Decisions are appended to ~/.futures-trading-harness/gate-log.jsonl
 * (FTH_GATE_LOG). stdout carries only protocol messages.
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { checkOrder, logDecision } = require('./lib/trading/check-order');
const { handleClientLine, lineSplitter } = require('./lib/trading/mcp-gateway');

const ROOT = path.resolve(__dirname, '..');

function main(argv) {
  const sep = argv.indexOf('--');
  let command = sep === -1 ? argv : argv.slice(sep + 1);
  // Manifests that can't embed a local path (Qwen extension, Codex plugin) set
  // PROJECTX_MCP_ENTRY to projectx-mcp's dist/index.js instead.
  const entry = String(process.env.PROJECTX_MCP_ENTRY || '').trim();
  if (command.length === 0 && entry) command = [process.execPath, entry];
  if (command.length === 0) {
    process.stderr.write('[mcp-gateway] usage: mcp-gateway.js -- <projectx-mcp command> [args...] (or set PROJECTX_MCP_ENTRY)\n');
    process.exit(2);
  }

  const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  const write = line => process.stdout.write(`${line}\n`);
  const check = args => checkOrder(args, { env: process.env, pluginRoot: ROOT, now: new Date() });
  const log = entry => logDecision(entry, process.env);

  // Server → client: forward whole lines so gateway responses never split a message.
  const fromServer = lineSplitter(write);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => fromServer.push(chunk));

  // Client → server: inspect each message.
  const fromClient = lineSplitter(line => {
    const { forward, respond } = handleClientLine(line, check, log);
    for (const r of respond) write(JSON.stringify(r));
    if (forward !== null && child.stdin.writable) child.stdin.write(`${forward}\n`);
  });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => fromClient.push(chunk));
  process.stdin.on('end', () => {
    fromClient.flush();
    child.stdin.end();
  });

  child.on('error', err => {
    process.stderr.write(`[mcp-gateway] could not start the MCP server: ${err.message}\n`);
    process.exit(1);
  });
  // 'close' fires after the child's stdio has drained; exit once our stdout is flushed.
  child.on('close', (code, signal) => {
    fromServer.flush();
    const exitCode = code === null ? (signal ? 1 : 0) : code;
    process.stdout.write('', () => process.exit(exitCode));
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}

main(process.argv.slice(2));
