'use strict';

// Stateful stand-in for projectx-mcp: place_order is acknowledged at once and
// the market fill lands FILL_DELAY_MS later, like a real exchange round trip.
// Starts with net position START_NET in CONTRACT.
const CONTRACT = process.env.CONTRACT || 'CON.F.US.MNQ.Z26';
const DELAY = Number(process.env.FILL_DELAY_MS || 300);
let net = Number(process.env.START_NET || 0);
let orderId = 100;
const out = m => process.stdout.write(`${JSON.stringify(m)}\n`);
const text = (id, value) => out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] } });

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (msg.id === undefined) continue;
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    if (name === 'list_open_positions') text(msg.id, net === 0 ? [] : [{ contractId: CONTRACT, type: net > 0 ? 1 : 2, size: Math.abs(net) }]);
    else if (name === 'list_open_orders' || name === 'search_trades') text(msg.id, []);
    else if (name === 'place_order') {
      orderId += 1;
      const delta = (args.side === 'buy' ? 1 : -1) * Number(args.size);
      setTimeout(() => { net += delta; }, DELAY);
      text(msg.id, { orderId, success: true });
    } else text(msg.id, `forwarded:${msg.method}${name ? `:${name}` : ''} net=${net}`);
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), DELAY + 50));
