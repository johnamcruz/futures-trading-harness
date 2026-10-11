#!/usr/bin/env node
/**
 * The harness-tools MCP server (server name `harness`): the harness's own
 * operations (strategies, bars, market snapshot, multi-timeframe read,
 * blackouts, prop challenge status, lessons, reconcile) as MCP tools, for any
 * MCP client, over stdio (newline-delimited JSON-RPC).
 *
 *   node scripts/harness-tools-mcp.js
 *
 * Every call runs with this process's environment (bars_fetch also with the
 * user's .env, as scripts/bars.js loads it; never printed) and the harness
 * clock. Nothing it offers places, modifies or cancels an order. stdout carries
 * only protocol messages; anything else goes to stderr.
 * The logic lives in scripts/lib/harness-tools/ (protocol.js, registry.js).
 */

'use strict';

const { createServer, boundedLines } = require('./lib/harness-tools/protocol');
const { TOOLS } = require('./lib/harness-tools/registry');
const { OPERATIONS } = require('./lib/harness-tools/index');
const { ROOT } = require('./lib/harness-tools/cli');

function main({ env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) {
    stderr.write(`[harness] Node 22 or later is needed (this is ${process.versions.node})\n`);
    return 1;
  }
  const missing = TOOLS.filter(t => typeof OPERATIONS[t.op] !== 'function').map(t => t.name);
  if (missing.length) {
    stderr.write(`[harness] tools without an operation: ${missing.join(', ')}\n`);
    return 1;
  }
  // Only protocol messages on stdout: anything an operation prints goes to stderr.
  const out = stdout.write.bind(stdout);
  stdout.write = (chunk, ...rest) => stderr.write(chunk, ...rest);
  const write = msg => out(`${JSON.stringify(msg)}\n`);
  // The client went away (EPIPE): nothing more can be answered.
  if (typeof stdout.on === 'function') stdout.on('error', () => process.exit(0));

  const server = createServer({ env, root: ROOT, write });
  const lines = boundedLines(line => { server.handleLine(line); }, () => server.oversize());
  stdin.setEncoding('utf8');
  stdin.on('data', chunk => lines.push(chunk));
  stdin.on('end', () => {
    lines.flush();
    // Finish the calls in flight, then exit.
    server.idle().then(() => { process.exitCode = 0; });
  });
  stderr.write(`[harness] ${TOOLS.length} tools ready on stdio\n`);
  return 0;
}

if (require.main === module) {
  const code = main();
  if (code) process.exitCode = code;
}

module.exports = { main };
