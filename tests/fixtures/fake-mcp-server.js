'use strict';

// Minimal stand-in for projectx-mcp: answers every request with the method and
// tool name it received, so tests can see what the gateway forwarded.
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    const msgs = [].concat(JSON.parse(line));
    for (const msg of msgs) {
      if (msg.id === undefined) continue;
      const name = msg.params && msg.params.name ? `:${msg.params.name}` : '';
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `forwarded:${msg.method}${name}` }] } })}\n`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
