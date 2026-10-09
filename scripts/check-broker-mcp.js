#!/usr/bin/env node
/**
 * Check an MCP server against the broker MCP interface
 * (docs/BROKER-MCP-INTERFACE.md): its tools, then read-only calls. It never
 * places, changes, or cancels an order, or writes the journal.
 *
 *   node scripts/check-broker-mcp.js [--account <id>] [--symbol MNQ] -- <server command> [args...]
 *   node scripts/check-broker-mcp.js -- node /abs/path/projectx-mcp/dist/index.js
 *
 * The server gets this process's environment (its credentials). Exit 0 when
 * it conforms, 1 when it doesn't.
 */

'use strict';

// The server's credentials, as the runner reads them (FTH_ENV_FILE, ~/.futures-trading-harness/.env, ./.env).
if (require.main === module) require('./lib/env-file').loadEnvForCli('check-broker-mcp');

const { createMcpClient } = require('./lib/broker/mcp-client');
const { checkConformance } = require('./lib/broker/conformance');

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(argv, out = s => process.stdout.write(s)) {
  const sep = argv.indexOf('--');
  const command = sep === -1 ? [] : argv.slice(sep + 1);
  if (!command.length) throw new Error('usage: check-broker-mcp.js [--account <id>] [--symbol MNQ] -- <server command> [args...]');
  const opts = argv.slice(0, sep === -1 ? argv.length : sep);
  const mcp = createMcpClient({ command: command[0], args: command.slice(1) });
  try {
    const { ok, results } = await checkConformance(mcp, { accountId: arg(opts, '--account') ?? null, symbol: arg(opts, '--symbol') || 'MNQ' });
    for (const r of results) out(`${!r.ok ? 'FAIL' : r.problems.length ? 'warn' : 'ok  '} ${r.check}${r.problems.length ? `\n       ${r.problems.slice(0, 5).join('\n       ')}` : ''}\n`);
    out(ok ? 'conforms to the broker MCP interface\n' : 'does NOT conform to the broker MCP interface\n');
    return ok ? 0 : 1;
  } finally {
    mcp.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => {
    process.stderr.write(`[check-broker-mcp] ${err.message}\n`);
    process.exit(2);
  });
}

module.exports = { main };
