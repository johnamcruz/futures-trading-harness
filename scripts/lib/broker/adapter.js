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
 *   history(contractId, { start, end, timeframe })   bars of any size (default 1 minute), oldest first, every field kept
 *   barSpec(timeframe)                     { unit, unitNumber, ms }: 3 or "3m" (minutes), "30s", "1h", "1d" (1 s to 1 day)
 *   pageHistory(page, { from, to, chunk }) history()'s paging, whatever a server does at a page's edges
 *   accountState(accountId)                { positions, orders }
 *   accountBalance(accountId)              realized balance
 *   workingOrders(accountId, contractId)   working orders in the contract
 *   netPosition(accountId, contractId)     signed net size
 *   cancelOrder / modifyStop / closePosition
 *   journalAdd(entry)                      journal_add (a plan, a note): the entry the broker wrote
 *   serverConfig()                         get_server_config
 *   close()
 *
 * createAdapter({ mcp, writeMcp })   over MCP clients (mcp-client.js): reads on
 *                                    mcp, order calls on writeMcp
 * openAdapter({ root, env })         for the configured broker
 * withAdapter({ root, env }, fn)     fn(adapter), then close it
 * tradingBlocked(config, accountId, { live })  why the server would refuse orders (live: or would take any account), or null
 * liveRunBlocked({ broker, config, env, accountId })  why a live run may not start on this account (allow-list), or null
 */

const path = require('path');
const { createMcpClient } = require('./mcp-client');
const { validateTools } = require('./interface');
const { activeBroker, translatedCommand } = require('./config');
const { allowListProblem, normId } = require('./allow-list');
const { signedSize } = require('../trading/positions');

class BrokerError extends Error {}

const BAR_LIMIT = 20000; // the most get_bars returns at once (interface)
const HISTORY_CHUNK_BARS = require('../tunables').runner().limits.historyChunkBars; // bars per get_bars call when paging through history (config/runner.json)
const UNITS = { s: ['second', 1000], m: ['minute', 60000], h: ['hour', 3600000], d: ['day', 86400000] };

/**
 * A timeframe as the interface's get_bars unit and unitNumber: a number (or "3") is minutes, as the
 * runner's and the backtester's timeframe; "30s", "3m", "1h", "1d" name the unit. Throws on anything else.
 */
const MAX_BAR_MS = 86400000; // the longest bar history() pages: one day

function barSpec(timeframe = 1) {
  const m = /^(\d+)([smhd]?)$/.exec(String(timeframe).trim().toLowerCase());
  const n = m ? Number(m[1]) : NaN;
  const [unit, unitMs] = UNITS[(m && m[2]) || 'm'];
  if (!m || !(n >= 1) || n * unitMs > MAX_BAR_MS) throw new BrokerError(`timeframe ${JSON.stringify(timeframe)}: minutes (3), or a count and unit (30s, 3m, 1h, 1d), from 1 second to 1 day`);
  return { unit, unitNumber: n, ms: n * unitMs };
}
/**
 * Every bar in [from, to] (both inclusive), oldest first, from `page(a, b)` (the bars one get_bars call returns,
 * as { ms, bar }), whatever the server does at a call's edges: a start or end it treats as exclusive (each call
 * asks 1 ms wider), a startTime it ignores (older bars come back too: only bars in the span are kept), or a cap
 * on how many bars one call returns, from either end. Each planned page of `chunk` ms is asked for; one that came
 * back short of its end is asked again from its last bar (the overlap is deduplicated by time), and one that came
 * back starting after its start is asked again up to its first bar, until a call brings nothing new.
 *
 * Refused: a call that returns bars after the endTime it was asked for (it isn't answering the call: the same
 * page every time, say). A call that returned `limit` bars (the most asked for) and none after its start (the bar
 * a continuation starts from, or the span's start) is either a session break or the end of the data under a
 * server that ignores startTime and keeps the newest bars up to endTime, or a server that ignores startTime, keeps
 * the oldest bars and cut the rest at `limit`. One more call up to just before its newest bar tells them apart:
 * the first kind returns `limit` bars again, the second fewer, and is refused. The safe side: a newest-keeping
 * server that ignores startTime and holds exactly `limit` bars up to the end of its data is refused there too.
 *
 * Not caught: a server that ignores startTime, keeps the oldest bars and caps them below `limit` looks like one
 * that has no more bars, so the bars past its cap are lost. The interface's get_bars `startTime` is the window's
 * start (docs/BROKER-MCP-INTERFACE.md); exact paging relies on the server honouring it.
 */
async function pageHistory(page, { from, to, chunk, limit = Infinity }) {
  const out = new Map();
  for (let start = from; start < to; start += chunk) {
    const spans = [{ a: start, b: Math.min(to, start + chunk) }];
    while (spans.length) {
      const { a, b } = spans.pop();
      const got = await page(a - 1, b + 1);
      if (got.some(x => x.ms > b + 1)) {
        throw new BrokerError(`get_bars returned bars after the endTime it was asked for (${new Date(b + 1).toISOString()}): it can't be paged`);
      }
      if (got.length >= limit && !got.some(x => x.ms > a)) {
        const newest = got.reduce((m, x) => Math.max(m, x.ms), -Infinity);
        const again = await page(newest - chunk, newest - 1);
        if (again.length < limit) {
          throw new BrokerError(`get_bars made no progress: asked from ${new Date(a).toISOString()}, it returned ${got.length} bars (the most asked for), none new, and fewer up to just before its newest: it keeps the oldest bars and cuts the newer ones, so it can't be paged`);
        }
      }
      let first = Infinity;
      let last = -Infinity;
      for (const x of got) {
        if (x.ms < a || x.ms > b) continue;
        out.set(x.ms, x.bar);
        if (x.ms < first) first = x.ms;
        if (x.ms > last) last = x.ms;
      }
      if (last === -Infinity) continue; // nothing there
      // Short of either end: ask again from the bar it ended on, or up to the bar it started with (each span
      // strictly smaller, so this ends; a call that only returns that bar again means nothing more is there).
      if (last < b && last > a) spans.push({ a: last, b });
      if (first > a && first < b) spans.push({ a, b: first });
    }
  }
  return [...out.entries()].sort((x, y) => x[0] - y[0]).map(e => e[1]);
}

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
 * it trades: the server's own guardrails apply to every order tool. `live`
 * (a live run, not paper or a confirmed replay): a server that allows every
 * account (an empty list or "any") is refused too, never read as "this one".
 */
function tradingBlocked(config, accountId, { live = false } = {}) {
  if (!config || config.tradingEnabled !== true) return 'the broker MCP server has trading disabled (get_server_config: tradingEnabled is not true; its own setting enables it), so it would refuse the runner\'s exits, stop moves and cancels; halt entries with the STOP file instead';
  const allowed = Array.isArray(config.allowedAccountIds) ? config.allowedAccountIds.map(normId) : [];
  if (allowed.length && !allowed.includes(normId(accountId))) return `account ${accountId} is not among the server's allowed accounts (${allowed.join(', ')})`;
  if (live && !allowed.length) return `the broker MCP server allows any account (get_server_config: allowedAccountIds ${JSON.stringify(config.allowedAccountIds)}): a live run needs its allowed-accounts setting to list account ${accountId}`;
  return null;
}

/**
 * Why a live run (paper: false) may not start on `accountId`, or null: a
 * confirmed replay (the broker config says replay and so does its server) is
 * exempt; otherwise the run names its account, the broker's allow-list
 * (broker/allow-list.js) holds it, and the server trades it, listing it.
 */
function liveRunBlocked({ broker, config, env = process.env, accountId }) {
  const replay = Boolean(broker && broker.replay === true && config && config.replay === true);
  if (replay) return accountId ? tradingBlocked(config, accountId) : null;
  if (!accountId) return 'a live run (paper: false) names its account ("account" in the runner config), so the allow-list can be checked';
  return allowListProblem(broker, env, accountId) || tradingBlocked(config, accountId, { live: true });
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
      // The translator names the front month by its root (MNQ); later months carry their month (MNQ:2027-03).
      const root = String(symbol).toUpperCase();
      const c = listOf(await call('search_contracts', { searchText: root, live: false }), 'search_contracts').find(x => x.id === root);
      if (!c) throw new BrokerError(`no active contract found for ${symbol}`);
      return { id: c.id, name: c.name, tickSize: Number(c.tickSize), tickValue: Number(c.tickValue) };
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

    /**
     * Historical bars between two times (`start`/`end`, or `from`/`to`), oldest first, at `timeframe`
     * (barSpec; default 1 minute), paged in chunks the interface allows. Each bar is the broker's own
     * object, with every field its server put on it, untouched.
     */
    async history(contractId, { start, end, from = start, to = end, timeframe = 1 }) {
      const spec = barSpec(timeframe);
      const t0 = new Date(from).getTime();
      const t1 = new Date(to).getTime();
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) throw new BrokerError('history: from and to must be times');
      const page = async (a, b) => (await bars({ contractId, unit: spec.unit, unitNumber: spec.unitNumber, limit: BAR_LIMIT, startTime: new Date(a).toISOString(), endTime: new Date(b).toISOString() })).map(bar => {
        const ms = Date.parse(bar && bar.t);
        if (!Number.isFinite(ms)) throw new BrokerError('get_bars returned a bar with no readable time (t)');
        return { ms, bar };
      });
      return pageHistory(page, { from: t0, to: t1, chunk: HISTORY_CHUNK_BARS * spec.ms, limit: BAR_LIMIT });
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

    /** The account's fills since `start` (search_trades), oldest first by the broker's order. */
    async fillsSince(accountId, start) {
      return listOf(await call('search_trades', { accountId: Number(accountId), startTimestamp: start.toISOString() }), 'search_trades');
    },

    /** Number of working orders in a contract. */
    async workingOrders(accountId, contractId) {
      return (await ordersOf(accountId)).filter(o => o.contractId === contractId).length;
    },

    /** Signed net position in a contract (long +, short -). */
    async netPosition(accountId, contractId) {
      // An unknown type or size throws: the caller retries instead of reading a flat account.
      return (await positionsOf(accountId)).filter(p => p.contractId === contractId).reduce((n, p) => n + signedSize({ ...p, type: Number(p.type) }), 0);
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

    /**
     * Add a journal entry (journal_add: { kind, text, contractId?, accountId?, orderId?, tags? }): the broker writes it
     * with its own time, where the order gate reads it (the runner's entry writes its plan this way: runner-entry.js).
     */
    async journalAdd(entry) {
      const r = await call('journal_add', entry);
      if (!r || typeof r !== 'object' || typeof r.ts !== 'string') throw new BrokerError('journal_add returned no entry');
      return r;
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
  // Behind the contract translator, like the gateway's: the runner sees standard contract names only.
  const [command, ...args] = translatedCommand(broker);
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

module.exports = { createAdapter, openAdapter, withAdapter, tradingBlocked, liveRunBlocked, barSpec, pageHistory, BrokerError };
