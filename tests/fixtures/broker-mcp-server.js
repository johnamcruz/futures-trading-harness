'use strict';

/**
 * A fake broker MCP server that implements the broker MCP interface
 * (scripts/lib/brokers/interface.js) over an in-memory account, for tests of
 * the conformance checker and the runner's broker client. MCP over stdio,
 * newline-delimited JSON-RPC. Env: FAKE_DROP (comma-separated tools to leave
 * out), FAKE_JOURNAL (the journal file it writes), FAKE_NEWEST_FIRST (bars newest
 * first, as a non-conforming server would), FAKE_LIVE_BARS (three 1-minute bars,
 * the newest closed seconds ago), FAKE_FLAT (no position or order),
 * FAKE_CALLS (a file it appends each tool call's name to), FAKE_ARGS (a file it
 * appends each call's name and arguments to, as JSON lines), FAKE_TRADING_OFF
 * (get_server_config reports trading disabled).
 */

const fs = require('fs');
const { TOOLS } = require('../../scripts/lib/broker/interface');

const MNQ = 'CON.F.US.MNQ.Z26';
const drop = new Set(String(process.env.FAKE_DROP || '').split(',').filter(Boolean));
const state = {
  accounts: [{ id: 7, name: 'FAKE-50K', balance: 50000, canTrade: true, mcpTradingAllowed: true }],
  contracts: [
    { id: MNQ, name: 'MNQZ6', description: 'Micro E-mini Nasdaq-100', tickSize: 0.25, tickValue: 0.5, activeContract: true },
    { id: 'CON.F.US.MNQ.H27', name: 'MNQH7', tickSize: 0.25, tickValue: 0.5, activeContract: false },
  ],
  positions: process.env.FAKE_FLAT ? [] : [{ id: 1, accountId: 7, contractId: MNQ, creationTimestamp: '2026-10-07T14:01:00Z', type: 1, size: 1, averagePrice: 21500 }],
  orders: process.env.FAKE_FLAT ? [] : [{ id: 9, accountId: 7, contractId: MNQ, status: 1, type: 4, side: 1, size: 1, stopPrice: 21480, limitPrice: null }],
  fills: [{ id: 3, orderId: 8, accountId: 7, contractId: MNQ, creationTimestamp: '2026-10-07T14:01:00Z', price: 21500, profitAndLoss: null, fees: 0.37, side: 0, size: 1, voided: false }],
  calls: [],
};
const bars = n => Array.from({ length: n }, (_, k) => {
  const c = 21500 + k;
  return { t: new Date(Date.parse('2026-10-07T13:00:00Z') + k * 60000).toISOString(), o: c, h: c + 1, l: c - 1, c, v: 10 };
});
const journal = entry => {
  if (process.env.FAKE_JOURNAL) fs.appendFileSync(process.env.FAKE_JOURNAL, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
};
const ok = { success: true, errorCode: 0, errorName: 'Success', errorMessage: null };

const HANDLERS = {
  get_server_config: () => ({ tradingEnabled: !process.env.FAKE_TRADING_OFF, maxOrderSize: 1, maxPositionSize: 2, maxDailyLoss: 500, allowedAccountIds: [7], allowedSymbols: ['MNQ'], journalPath: '/tmp/j.jsonl', tradingDayStartedAt: '2026-10-06T22:00:00Z', serverTime: new Date().toISOString() }),
  list_accounts: () => state.accounts,
  get_account_snapshot: a => ({ account: state.accounts.find(x => x.id === a.accountId) || null, positions: state.positions, openOrders: state.orders, today: { realizedNetPnL: 0 } }),
  search_contracts: a => state.contracts.filter(c => c.name.startsWith(String(a.searchText).toUpperCase())),
  list_available_contracts: () => state.contracts,
  get_contract: a => state.contracts.find(c => c.id === a.contractId) || null,
  get_bars: a => {
    if (process.env.FAKE_LIVE_BARS) {
      // The newest 1-minute bar closed 5 seconds ago.
      const lastOpen = Date.now() - 65000;
      const live = [2, 1, 0].map(k => ({ t: new Date(lastOpen - k * 60000).toISOString(), o: 1, h: 2, l: 0, c: 1 + k, v: 10 }));
      return { contractId: a.contractId, barSize: '1 minute', count: 3, bars: live };
    }
    const all = bars(Math.min(a.limit || 100, 300));
    const end = a.endTime ? Date.parse(a.endTime) : Infinity;
    const list = all.filter(b => Date.parse(b.t) <= end);
    return { contractId: a.contractId, barSize: `${a.unitNumber || 5} ${a.unit || 'minute'}`, count: list.length, bars: process.env.FAKE_NEWEST_FIRST ? list.reverse() : list };
  },
  get_quote: a => ({ contractId: a.contractId, quote: null, note: 'market closed' }),
  list_open_positions: () => state.positions,
  list_open_orders: () => state.orders,
  search_orders: () => state.orders,
  search_trades: () => state.fills,
  get_performance: () => ({ window: { start: '2026-10-06T22:00:00Z', end: 'now' }, overall: { fills: 0 }, byContract: {} }),
  place_order: a => {
    journal({ kind: 'order_placed', text: a.rationale, accountId: a.accountId, contractId: a.contractId, data: { result: { ...ok, orderId: 101 } } });
    return { orderId: 101, ...ok };
  },
  modify_order: a => {
    const o = state.orders.find(x => x.id === a.orderId);
    if (!o) return { ...ok, success: false, errorCode: 2, errorName: 'OrderNotFound' };
    if (a.stopPrice !== undefined) o.stopPrice = a.stopPrice;
    return ok;
  },
  cancel_order: a => {
    state.orders = state.orders.filter(o => o.id !== a.orderId);
    return ok;
  },
  close_position: a => {
    state.positions = state.positions.filter(p => p.contractId !== a.contractId);
    return ok;
  },
  partial_close_position: () => ok,
  journal_add: a => ({ ts: new Date().toISOString(), ...a }),
  journal_read: () => [],
};

const tools = Object.keys(TOOLS).filter(n => !drop.has(n)).map(name => ({
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
    if (msg.method === 'initialize') result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-broker', version: '1' } };
    else if (msg.method === 'tools/list') result = { tools };
    else if (msg.method === 'tools/call') {
      const { name, arguments: args = {} } = msg.params;
      state.calls.push(name);
      if (process.env.FAKE_CALLS) fs.appendFileSync(process.env.FAKE_CALLS, `${name}\n`);
      if (process.env.FAKE_ARGS) fs.appendFileSync(process.env.FAKE_ARGS, `${JSON.stringify({ name, args })}\n`);
      result = HANDLERS[name] && !drop.has(name)
        ? { content: [{ type: 'text', text: JSON.stringify(HANDLERS[name](args)) }] }
        : { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
    } else result = {};
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
  }
});
