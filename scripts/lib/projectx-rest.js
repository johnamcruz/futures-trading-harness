'use strict';

/**
 * Minimal read-only ProjectX Gateway REST client for the autonomous runner's
 * bar clock (the agents themselves trade through projectx-mcp). Uses the same
 * environment as projectx-mcp: PROJECTX_USERNAME, PROJECTX_API_KEY, and
 * optionally PROJECTX_API_URL. Never logs credentials or tokens.
 */

const DEFAULT_API_URL = 'https://api.topstepx.com';
const TOKEN_TTL_MS = 20 * 60 * 60 * 1000;
const BAR_UNIT_MINUTE = 2;

class ProjectXRestError extends Error {}

function createClient({ env = process.env, fetchFn = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const apiUrl = String(env.PROJECTX_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
  const userName = String(env.PROJECTX_USERNAME || '');
  const apiKey = String(env.PROJECTX_API_KEY || '');
  if (!userName || !apiKey) throw new ProjectXRestError('PROJECTX_USERNAME and PROJECTX_API_KEY must be set for the bar clock');
  if (typeof fetchFn !== 'function') throw new ProjectXRestError('global fetch is unavailable (Node 18+ required)');

  let token = null;
  let tokenAt = 0;

  async function raw(path, body, bearer) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetchFn(apiUrl + path, { method: 'POST', headers, body: JSON.stringify(body) });
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
    /** Active contract id for a root symbol such as MNQ. */
    async activeContract(symbol) {
      const res = await post('/api/Contract/search', { searchText: symbol, live: false });
      const contracts = (res.contracts || []).filter(c => c.activeContract);
      const exact = contracts.find(c => String(c.id || '').split('.').slice(-2, -1)[0] === symbol) || contracts[0];
      if (!exact) throw new ProjectXRestError(`no active contract found for ${symbol}`);
      return { id: exact.id, name: exact.name, tickSize: exact.tickSize, tickValue: exact.tickValue };
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

    /** Number of working orders in a contract. */
    async workingOrders(accountId, contractId) {
      const res = await post('/api/Order/searchOpen', { accountId: Number(accountId) });
      return (res.orders || []).filter(o => o.contractId === contractId).length;
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
