'use strict';

/**
 * The runner's start check of the harness-tools server (scripts/autotrader.js,
 * live and --once): start the server the harness runs will start, with their
 * environment, and compare its tools/list with the registry (registry.js). A
 * server that doesn't start, or offers other tools or schemas (a stale or
 * foreign `harness` server), refuses the run before any cycle: the skills
 * name these tools, and a cycle without them can't read its bars or strategies.
 *
 *   compareTools(got, want)                     -> [problem]
 *   checkToolsServer({ root, env, timeoutMs })  resolves, or rejects with what is wrong
 */

const path = require('path');
const { createMcpClient } = require('../broker/mcp-client');
const { listTools } = require('./registry');

/** What differs between a server's tools/list and the registry's tools: [problem], empty when they match. */
function compareTools(got, want = listTools()) {
  const problems = [];
  const byName = new Map((Array.isArray(got) ? got : []).map(t => [t && t.name, t]));
  for (const t of want) {
    const g = byName.get(t.name);
    if (!g) problems.push(`missing ${t.name}`);
    else if (JSON.stringify(g.inputSchema) !== JSON.stringify(t.inputSchema)) problems.push(`${t.name}: a different argument schema`);
    else if (g.description !== t.description) problems.push(`${t.name}: a different description`);
  }
  const known = new Set(want.map(t => t.name));
  for (const name of byName.keys()) if (!known.has(name)) problems.push(`unexpected tool ${String(name).slice(0, 64)}`);
  return problems;
}

async function checkToolsServer({ root, env = process.env, timeoutMs = 15000, command = process.execPath, args = null } = {}) {
  const script = path.join(root, 'scripts', 'harness-tools-mcp.js');
  const client = createMcpClient({ command, args: args || [script], env, timeoutMs, clientName: 'fth-runner-preflight' });
  let tools;
  try {
    tools = await client.listTools();
  } catch (err) {
    throw new Error(`the harness tools server (${script}) did not answer tools/list: ${err.message}`, { cause: err });
  } finally {
    client.close();
  }
  const problems = compareTools(tools);
  if (problems.length) {
    throw new Error(`the harness tools server (${script}) does not offer the harness's tools (${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}); update the checkout and re-run the installer`);
  }
  return tools.length;
}

module.exports = { compareTools, checkToolsServer };
