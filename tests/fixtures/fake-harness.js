'use strict';

// Stand-in for a harness CLI: echoes the prompt and a cycle result, or fails on demand.
// With FAKE_HARNESS_ORDERS=1 it also acts through the harness's order gateway, as an
// agent's broker tools do: an entry (which the gate refuses: no plan) and a close of MNQ.
const path = require('path');

const prompt = process.argv.slice(2).join(' ');
process.stdout.write(`cwd=${process.cwd()} FTH_ROOT=${process.env.FTH_ROOT}\nprompt=${prompt}\n`);
if (prompt.includes('FAIL')) process.exit(3);

async function orders() {
  const root = process.env.FTH_ROOT;
  const { createMcpClient } = require(path.join(root, 'scripts', 'lib', 'broker', 'mcp-client'));
  const gw = createMcpClient({ command: process.execPath, args: [path.join(root, 'scripts', 'mcp-gateway.js')], env: process.env, cwd: root, timeoutMs: 20000 });
  const tryCall = async (tool, args) => {
    try {
      return `ok ${JSON.stringify(await gw.call(tool, args)).slice(0, 120)}`;
    } catch (err) {
      return `refused ${err.message.slice(0, 200)}`;
    }
  };
  try {
    const entry = await tryCall('place_order', { accountId: 7, contractId: 'MNQ', side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 20, type: 'stop' }, rationale: 'setup:orb long, stop 21495' });
    const close = await tryCall('close_position', { accountId: 7, contractId: 'MNQ', reason: '[exit] fake harness' });
    process.stdout.write(`entry: ${entry}\nclose: ${close}\n`);
  } finally {
    gw.close();
  }
}

(process.env.FAKE_HARNESS_ORDERS === '1' ? orders() : Promise.resolve()).then(() => {
  process.stdout.write('CYCLE RESULT: no-trade - fake harness\n');
}, err => {
  process.stdout.write(`fake harness: ${err.message}\n`);
  process.exit(4);
});
