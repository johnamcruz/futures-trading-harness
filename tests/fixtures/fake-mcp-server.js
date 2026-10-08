'use strict';

// Minimal stand-in for projectx-mcp. Account tools answer with JSON from
// FAKE_POSITIONS / FAKE_ORDERS / FAKE_TRADES (default []); every other request
// is answered with the method and tool name it received, so tests can see what
// the gateway forwarded.
const ACCOUNT = { list_open_positions: 'FAKE_POSITIONS', list_open_orders: 'FAKE_ORDERS', search_trades: 'FAKE_TRADES' };
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
      const text = ACCOUNT[name] ? (process.env[ACCOUNT[name]] || '[]') : `forwarded:${msg.method}${name ? `:${name}` : ''}`;
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } })}\n`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
