'use strict';

/**
 * The broker adapter: the harness's one way to its broker. It talks to the
 * configured broker MCP server (broker/config.js) through the broker MCP
 * interface (broker/interface.js) and nothing else, so it works with any
 * server that implements the interface. Reads go straight to the server;
 * order calls go through the harness gateway, so they are gated (exits and
 * protective moves pass) and journaled like any other order.
 *
 *   verify()                               the server lists every interface tool, or throws
 *   activeContract(symbol)                 { id, name, tickSize, tickValue }
 *   closedBars(contractId, { minutes, limit, now, daily })   oldest first
 *   history(contractId, { start, end })    1-minute bars, oldest first
 *   accountState(accountId)                { positions, orders }
 *   accountBalance(accountId)              realized balance
 *   workingOrders(accountId, contractId)   working orders in the contract
 *   netPosition(accountId, contractId)     signed net size
 *   cancelOrder / modifyStop / closePosition
 *   serverConfig()                         get_server_config
 *   close()
 *
 * createAdapter({ mcp, writeMcp })   over MCP clients (mcp-client.js): reads on
 *                                    mcp, order calls on writeMcp
 * openAdapter({ root, env })         for the configured broker
 * withAdapter({ root, env }, fn)     fn(adapter), then close it
 * tradingBlocked(config, accountId)  why the server would refuse orders, or null
 */

const path = require('path');
const { idSymbol } = require('../trading/contracts');
const { createMcpClient } = require('./mcp-client');
const { validateTools } = require('./interface');
const { activeBroker, serverCommand } = require('./config');

class BrokerError extends Error {}

const BAR_LIMIT = 20000; // the most get_bars returns at once (interface)
const HISTORY_CHUNK_MS = 10000 * 60000; // 10,000 one-minute bars per call
const listOf = (data, what) => {
  if (!Array.isArray(data)) throw new BrokerError(`${what} is not a list`);
  return data;
};
const outcome = (res, what) => {
  if (!res || res.success !== true) throw new BrokerError(`${what} failed${res && res.errorCode !== undefined ? ` (errorCode ${res.errorCode}${res.errorName ? ` ${res.errorName}` : ''})` : ''}`);
  return res;
};

/**
 * Why the server would refuse the runner's housekeeping (exits, stop moves,
 * cancels) for this account, from its get_server_config answer, or null when
 * it trades: the server's own guardrails apply to every order tool.
 */
function tradingBlocked(config, accountId) {
  if (!config || config.tradingEnabled !== true) return 'the broker MCP server has trading disabled (projectx-mcp: PROJECTX_TRADING_ENABLED=true enables it), so it would refuse the runner\'s exits, stop moves and cancels; halt entries with the STOP file instead';
  const allowed = Array.isArray(config.allowedAccountIds) ? config.allowedAccountIds.map(Number) : [];
  if (allowed.length && !allowed.includes(Number(accountId))) return `account ${accountId} is not among the server's allowed accounts (${allowed.join(', ')})`;
  return null;
}

function createAdapter({ mcp, writeMcp = mcp }) {
  // Reads may use their own connection (straight to the server: they need no gate), so an order call the
  // gateway is holding never stops the runner reading bars; order tools always go through `writeMcp`.
  const call = (name, args) => mcp.call(name, args);
  const order = (name, args) => writeMcp.call(name, args);
  const positionsOf = async accountId => listOf(await call('list_open_positions', { accountId: Number(accountId) }), 'list_open_positions');
  const ordersOf = async accountId => listOf(await call('list_open_orders', { accountId: Number(accountId) }), 'list_open_orders');
  const bars = async args => {
    const res = await call('get_bars', { includePartialBar: false, ...args });
    return listOf(res && res.bars, 'get_bars bars').slice().sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  };

  return {
    /** Throws unless the server lists every interface tool with the inputs the harness sends. */
    async verify() {
      const problems = validateTools(await mcp.listTools());
      if (problems.length) throw new BrokerError(`the broker MCP server does not implement the interface: ${problems.slice(0, 5).join('; ')}`);
    },

    /** The active (front-month) contract for a root symbol such as MNQ. */
    async activeContract(symbol) {
      const contracts = listOf(await call('search_contracts', { searchText: symbol, live: false }), 'search_contracts').filter(c => c.activeContract);
      // Match the id's symbol exactly (NQ trades as ENQ; a search for YM also finds MYM), else a ticker of the root plus a month code.
      const exact = contracts.find(c => String(c.id || '').split('.').slice(-2, -1)[0] === idSymbol(symbol))
        || contracts.find(c => new RegExp(`^${symbol}[FGHJKMNQUVXZ]\\d{1,2}$`).test(String(c.name || '')));
      if (!exact) throw new BrokerError(`no active contract found for ${symbol}`);
      return { id: exact.id, name: exact.name, tickSize: Number(exact.tickSize), tickValue: Number(exact.tickValue) };
    },

    /** Closed bars, oldest first: minute bars (`minutes`), or daily bars with `daily: true`. */
    closedBars(contractId, { minutes, limit, now = new Date(), daily = false }) {
      // A span that covers weekends and the daily break.
      const span = daily ? (limit * 2 + 10) * 864e5 : minutes * 60000 * limit * 2 + 4 * 864e5;
      return bars({
        contractId, unit: daily ? 'day' : 'minute', unitNumber: daily ? 1 : minutes, limit,
        startTime: new Date(now.getTime() - span).toISOString(), endTime: now.toISOString(),
      });
    },

    /** Historical 1-minute bars between two times, oldest first, in chunks the interface allows. */
    async history(contractId, { start, end }) {
      const out = new Map();
      for (let from = start.getTime(); from < end.getTime(); from += HISTORY_CHUNK_MS) {
        const to = Math.min(end.getTime(), from + HISTORY_CHUNK_MS);
        for (const bar of await bars({ contractId, unit: 'minute', unitNumber: 1, limit: BAR_LIMIT, startTime: new Date(from).toISOString(), endTime: new Date(to).toISOString() })) {
          out.set(Date.parse(bar.t), bar);
        }
      }
      return [...out.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    },

    /** Open positions and working orders of an account. */
    async accountState(accountId) {
      const [positions, orders] = await Promise.all([positionsOf(accountId), ordersOf(accountId)]);
      return { positions, orders };
    },

    /** The account's realized balance. */
    async accountBalance(accountId) {
      const accounts = listOf(await call('list_accounts', { onlyActiveAccounts: false }), 'list_accounts');
      const a = accounts.find(x => Number(x.id) === Number(accountId));
      if (!a) throw new BrokerError(`account ${accountId} not found`);
      const balance = Number(a.balance);
      if (!Number.isFinite(balance)) throw new BrokerError(`account ${accountId} has no balance`);
      return balance;
    },

    /** Number of working orders in a contract. */
    async workingOrders(accountId, contractId) {
      return (await ordersOf(accountId)).filter(o => o.contractId === contractId).length;
    },

    /** Signed net position in a contract (long +, short -). */
    async netPosition(accountId, contractId) {
      return (await positionsOf(accountId)).filter(p => p.contractId === contractId)
        .reduce((n, p) => n + (Number(p.type) === 1 ? 1 : Number(p.type) === 2 ? -1 : 0) * Number(p.size || 0), 0);
    },

    /** Cancel a working order. */
    async cancelOrder(accountId, orderId) {
      return outcome(await order('cancel_order', { accountId: Number(accountId), orderId: Number(orderId) }), `cancel order ${orderId}`);
    },

    /** Move a protective stop (toward the market only: the gateway refuses anything else). */
    async modifyStop(accountId, orderId, stopPrice) {
      // No reason: a price move needs none, and the server would journal it as a note.
      return outcome(await order('modify_order', { accountId: Number(accountId), orderId: Number(orderId), stopPrice }), `modify order ${orderId}`);
    },

    /** Flatten a contract's position at market. */
    async closePosition(accountId, contractId) {
      return outcome(await order('close_position', { accountId: Number(accountId), contractId, reason: '[exit] runner' }), `close ${contractId}`);
    },

    /** The server's own config: whether it trades at all, and its guardrails (get_server_config). */
    serverConfig: () => call('get_server_config', {}),

    close: () => {
      mcp.close();
      if (writeMcp !== mcp) writeMcp.close();
    },
  };
}

/**
 * The adapter for the configured broker: reads straight to its server, order
 * calls through the gateway (which starts the same server). Throws when no
 * server is configured. Close it when done (the servers are child processes).
 */
function openAdapter({ root, env = process.env, timeoutMs } = {}) {
  const broker = activeBroker(env);
  const [command, ...args] = serverCommand(broker);
  const name = 'futures-trading-harness-runner';
  // The gateway (a second copy of the server) starts on the first order call only: read-only CLIs never need it.
  let writes = null;
  const gateway = () => writes || (writes = createMcpClient({ command: process.execPath, args: [path.join(root, 'scripts', 'mcp-gateway.js')], env, cwd: root, timeoutMs, clientName: name }));
  return createAdapter({
    mcp: createMcpClient({ command, args, env, cwd: root, timeoutMs, clientName: `${name}-reads` }),
    writeMcp: { call: (tool, a) => gateway().call(tool, a), close: () => { if (writes) writes.close(); } },
  });
}

/** Run fn(adapter) on the configured broker, closing it afterwards. */
async function withAdapter(opts, fn) {
  const adapter = openAdapter(opts);
  try {
    return await fn(adapter);
  } finally {
    adapter.close();
  }
}

module.exports = { createAdapter, openAdapter, withAdapter, tradingBlocked, BrokerError };
