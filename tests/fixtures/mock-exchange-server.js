'use strict';

/**
 * The broker MCP server over the mock exchange (mock-exchange.js): MCP over
 * stdio, newline-delimited JSON-RPC, every interface tool. Env: MOCK_STATE
 * (the shared state file), MOCK_JOURNAL (the journal it writes).
 */

const { TOOLS } = require('../../scripts/lib/broker/interface');
const exchange = require('./mock-exchange');

const file = process.env.MOCK_STATE;
const tools = Object.keys(TOOLS).map(name => ({
  name,
  inputSchema: { type: 'object', properties: Object.fromEntries(Object.keys(TOOLS[name].input).map(k => [k, {}])) },
}));

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i = buffer.indexOf('\n');
  while (i !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    i = buffer.indexOf('\n');
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mock-exchange', version: '1' } };
    else if (msg.method === 'tools/list') result = { tools };
    else if (msg.method === 'tools/call') {
      try {
        result = { content: [{ type: 'text', text: JSON.stringify(exchange.handle(file, msg.params.name, msg.params.arguments || {})) }] };
      } catch (err) {
        result = { content: [{ type: 'text', text: err.message }], isError: true };
      }
    } else result = {};
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
  }
});
