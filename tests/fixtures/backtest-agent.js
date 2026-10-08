'use strict';

// Stand-in harness for backtest tests: talks to the simulated broker through
// PROJECTX_API_URL like projectx-mcp would. On a trade cycle while flat it
// buys 1 at market with a bracket; it records the simulated time it saw.
require('../../scripts/lib/sim-clock').installSimClock(process.env);
const fs = require('fs');
const path = require('path');

const prompt = process.argv[2] || '';
const url = process.env.PROJECTX_API_URL;
const post = async (p, body) => {
  const res = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: JSON.stringify(body) });
  return res.json();
};

(async () => {
  fs.appendFileSync(path.join(process.env.FTH_HOME, 'agent-seen.log'), `${new Date().toISOString()} ${prompt.includes('trade-session') ? 'trade' : prompt.includes('end-of-day') ? 'eod' : 'other'}\n`);
  const contract = (await post('/api/Contract/search', { searchText: 'MNQ' })).contracts[0];
  if (prompt.includes('end-of-day')) {
    const pos = (await post('/api/Position/searchOpen', { accountId: 1 })).positions;
    for (const p of pos) await post('/api/Position/closeContract', { accountId: 1, contractId: p.contractId });
    for (const o of (await post('/api/Order/searchOpen', { accountId: 1 })).orders) await post('/api/Order/cancel', { accountId: 1, orderId: o.id });
  } else if (prompt.includes('trade-session')) {
    const pos = (await post('/api/Position/searchOpen', { accountId: 1 })).positions;
    const open = (await post('/api/Order/searchOpen', { accountId: 1 })).orders;
    if (pos.length === 0 && open.length === 0) {
      const r = await post('/api/Order/place', { accountId: 1, contractId: contract.id, type: 2, side: 0, size: 1, stopLossBracket: { ticks: 8, type: 4 }, takeProfitBracket: { ticks: 8, type: 1 } });
      fs.appendFileSync(process.env.PROJECTX_JOURNAL_PATH, `${JSON.stringify({ ts: new Date().toISOString(), kind: 'order_placed', text: 'setup:fake long', orderId: r.orderId })}\n`);
    }
  }
  process.stdout.write('CYCLE RESULT: ok\n');
})().catch(err => { process.stderr.write(String(err.stack)); process.exit(1); });
