'use strict';

// Minimal stand-in broker MCP server. Account tools answer with JSON from
// FAKE_POSITIONS / FAKE_ORDERS / FAKE_TRADES / FAKE_SEARCH_ORDERS (default []); every other request
// is answered with the method and tool name it received, so tests can see what
// the gateway forwarded. FAKE_DELAY_MS delays those other replies; FAKE_DROP=<tool>
// never answers that tool (a lost reply); FAKE_ARGS=<file> logs each tools/call as a JSON line.
const fs = require('fs');
const ACCOUNT = { list_open_positions: 'FAKE_POSITIONS', list_open_orders: 'FAKE_ORDERS', search_trades: 'FAKE_TRADES', search_orders: 'FAKE_SEARCH_ORDERS' };
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    for (const msg of [].concat(JSON.parse(line))) {
      if (msg.id === undefined) continue;
      const name = msg.params && msg.params.name;
      if (process.env.FAKE_ARGS && name) fs.appendFileSync(process.env.FAKE_ARGS, `${JSON.stringify({ name, args: msg.params.arguments })}\n`);
      if (name && name === process.env.FAKE_DROP) continue;
      const text = ACCOUNT[name] ? (process.env[ACCOUNT[name]] || '[]') : `forwarded:${msg.method}${name ? `:${name}` : ''}`;
      const reply = () => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } })}\n`);
      const delay = ACCOUNT[name] ? 0 : Number(process.env.FAKE_DELAY_MS || 0);
      if (delay) setTimeout(reply, delay);
      else reply();
    }
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), Number(process.env.FAKE_DELAY_MS || 0) + 50));
