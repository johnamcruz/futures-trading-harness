'use strict';

/**
 * Minimal ProjectX Gateway REST client for the autonomous runner: the bar
 * clock and account reads, plus the runner's risk-reducing housekeeping:
 * cancelling leftover orders on a flat contract, tightening a trailing
 * strategy's stop, and closing a trade the trail says is over (the agents
 * themselves trade through projectx-mcp). Uses the same
 * environment as projectx-mcp: PROJECTX_USERNAME, PROJECTX_API_KEY, and
 * optionally PROJECTX_API_URL. Never logs credentials or tokens.
 */

const { idSymbol } = require('./trading/contracts');
const DEFAULT_API_URL = 'https://api.topstepx.com';
const TOKEN_TTL_MS = 20 * 60 * 60 * 1000;
const BAR_UNIT_MINUTE = 2;
const REQUEST_TIMEOUT_MS = 15000; // a hung API must not hold up the loop (end of day included)

class ProjectXRestError extends Error {}

function createClient({ env = process.env, fetchFn = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const apiUrl = String(env.PROJECTX_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
  const userName = String(env.PROJECTX_USERNAME || '');
  const apiKey = String(env.PROJECTX_API_KEY || '');
  if (!userName || !apiKey) throw new ProjectXRestError('PROJECTX_USERNAME and PROJECTX_API_KEY must be set for the bar clock');
  if (typeof fetchFn !== 'function') throw new ProjectXRestError('global fetch is unavailable (Node 22+ required)');

  let token = null;
  let tokenAt = 0;

  async function raw(path, body, bearer) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let res;
    try {
      res = await fetchFn(apiUrl + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      const e = new ProjectXRestError(`${path}: ${err.name === 'TimeoutError' ? `no answer in ${REQUEST_TIMEOUT_MS / 1000} s` : err.message}`, { cause: err });
      throw e;
    }
    if (!res.ok) {
      const err = new ProjectXRestError(`HTTP ${res.status} from ${path}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function getToken() {
    if (token && Date.now() - tokenAt < TOKEN_TTL_MS) return token;
    const res = await raw('/api/Auth/loginKey', { userName, apiKey });
    if (!res.success || !res.token) throw new ProjectXRestError(`ProjectX login failed (errorCode ${res.errorCode})`);
    token = res.token;
    tokenAt = Date.now();
    return token;
  }

  async function post(path, body) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await raw(path, body, await getToken());
        if (res && res.success === false) throw new ProjectXRestError(`${path} failed (errorCode ${res.errorCode})`);
        return res;
      } catch (err) {
        if (attempt > 0 || !(err instanceof ProjectXRestError)) throw err;
        if (err.status === 401) {
          token = null;
          continue;
        }
        if (err.status === 429) {
          await sleep(path === '/api/History/retrieveBars' ? 5000 : 2000);
          continue;
        }
        throw err;
      }
    }
  }

  return {
    /** Bearer token for the realtime hubs (never logged). */
    getToken,
    /** Active contract id for a root symbol such as MNQ. */
    async activeContract(symbol) {
      const res = await post('/api/Contract/search', { searchText: symbol, live: false });
      const contracts = (res.contracts || []).filter(c => c.activeContract);
      // Match the id's symbol exactly (NQ trades as ENQ; a search for YM also finds MYM).
      // Else the one whose ticker is the root plus a month code and year digit (CLZ5 for CL, whatever its id says).
      const exact = contracts.find(c => String(c.id || '').split('.').slice(-2, -1)[0] === idSymbol(symbol))
        || contracts.find(c => new RegExp(`^${symbol}[FGHJKMNQUVXZ]\\d{1,2}$`).test(String(c.name || '')));
      if (!exact) throw new ProjectXRestError(`no active contract found for ${symbol}`);
      return { id: exact.id, name: exact.name, tickSize: Number(exact.tickSize), tickValue: Number(exact.tickValue) };
    },

    /** Closed minute bars, oldest first, in projectx-mcp's {t,o,h,l,c,v} shape. */
    async closedBars(contractId, { minutes, limit, now = new Date() }) {
      const span = minutes * 60000 * limit * 2 + 4 * 864e5; // covers weekends and the daily break
      const res = await post('/api/History/retrieveBars', {
        contractId,
        live: false,
        startTime: new Date(now.getTime() - span).toISOString(),
        endTime: now.toISOString(),
        unit: BAR_UNIT_MINUTE,
        unitNumber: minutes,
        limit,
        includePartialBar: false,
      });
      return (res.bars || []).slice().sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    },

    /**
     * Historical 1-minute bars between two times, oldest first, fetched in
     * chunks the API accepts (for `backtest.js fetch`).
     */
    async history(contractId, { start, end, live = false }) {
      const chunkMs = 10000 * 60000;
      const out = new Map();
      for (let from = start.getTime(); from < end.getTime(); from += chunkMs) {
        const to = Math.min(end.getTime(), from + chunkMs);
        const res = await post('/api/History/retrieveBars', {
          contractId, live, startTime: new Date(from).toISOString(), endTime: new Date(to).toISOString(),
          unit: BAR_UNIT_MINUTE, unitNumber: 1, limit: 20000, includePartialBar: false,
        });
        for (const bar of res.bars || []) out.set(Date.parse(bar.t), bar);
      }
      return [...out.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    },

    /** Number of working orders in a contract. */
    async workingOrders(accountId, contractId) {
      const res = await post('/api/Order/searchOpen', { accountId: Number(accountId) });
      return (res.orders || []).filter(o => o.contractId === contractId).length;
    },

    /** Open positions and working orders of an account (raw API objects). */
    async accountState(accountId) {
      const [p, o] = await Promise.all([
        post('/api/Position/searchOpen', { accountId: Number(accountId) }),
        post('/api/Order/searchOpen', { accountId: Number(accountId) }),
      ]);
      if (!Array.isArray(p.positions) || !Array.isArray(o.orders)) throw new ProjectXRestError('account state is not a list');
      return { positions: p.positions, orders: o.orders };
    },

    /** The account's balance (realized, as the firm's max-loss floor is checked at end of day). */
    async accountBalance(accountId) {
      const res = await post('/api/Account/search', { onlyActiveAccounts: false });
      const a = (res.accounts || []).find(x => Number(x.id) === Number(accountId));
      if (!a) throw new ProjectXRestError(`account ${accountId} not found`);
      const balance = Number(a.balance);
      if (!Number.isFinite(balance)) throw new ProjectXRestError(`account ${accountId} has no balance`);
      return balance;
    },

    /** Cancel a working order. */
    async cancelOrder(accountId, orderId) {
      return post('/api/Order/cancel', { accountId: Number(accountId), orderId: Number(orderId) });
    },

    /** Move a working stop order's price. */
    async modifyStop(accountId, orderId, stopPrice) {
      return post('/api/Order/modify', { accountId: Number(accountId), orderId: Number(orderId), size: null, limitPrice: null, stopPrice, trailPrice: null });
    },

    /** Close the whole position in a contract at market. */
    async closePosition(accountId, contractId) {
      return post('/api/Position/closeContract', { accountId: Number(accountId), contractId });
    },

    /** Net position in a contract (positive long, negative short). */
    async netPosition(accountId, contractId) {
      const res = await post('/api/Position/searchOpen', { accountId: Number(accountId) });
      return (res.positions || [])
        .filter(p => p.contractId === contractId)
        .reduce((n, p) => n + (p.type === 1 ? 1 : p.type === 2 ? -1 : 0) * Number(p.size || 0), 0);
    },
  };
}

module.exports = { createClient, ProjectXRestError, DEFAULT_API_URL };
