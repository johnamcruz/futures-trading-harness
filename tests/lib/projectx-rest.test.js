'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createClient } = require('../../scripts/lib/projectx-rest');

function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(init.body), auth: init.headers.Authorization });
    const handler = routes[path];
    const out = typeof handler === 'function' ? handler(calls) : handler;
    if (out && out.status) return { ok: false, status: out.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => out };
  };
}

const env = { PROJECTX_USERNAME: 'u', PROJECTX_API_KEY: 'k', PROJECTX_API_URL: 'https://api.example.test/' };

test('requires credentials', () => {
  assert.throws(() => createClient({ env: {} }), /PROJECTX_USERNAME/);
});

test('logs in once, finds the active contract, and fetches closed bars sorted', async () => {
  const calls = [];
  const client = createClient({
    env,
    fetchFn: fakeFetch({
      '/api/Auth/loginKey': { success: true, token: 'tok' },
      '/api/Contract/search': { success: true, contracts: [{ id: 'CON.F.US.MNQ.H26', activeContract: false }, { id: 'CON.F.US.MNQ.Z26', activeContract: true, tickSize: 0.25, tickValue: 0.5 }] },
      '/api/History/retrieveBars': { success: true, bars: [{ t: '2026-10-07T14:03:00Z', c: 2 }, { t: '2026-10-07T14:00:00Z', c: 1 }] },
      '/api/Position/searchOpen': { success: true, positions: [{ contractId: 'CON.F.US.MNQ.Z26', type: 2, size: 1 }] },
    }, calls),
  });
  assert.deepStrictEqual(await client.activeContract('MNQ'), { id: 'CON.F.US.MNQ.Z26', name: undefined, tickSize: 0.25, tickValue: 0.5 });
  const bars = await client.closedBars('CON.F.US.MNQ.Z26', { minutes: 3, limit: 2, now: new Date('2026-10-07T14:07:00Z') });
  assert.deepStrictEqual(bars.map(b => b.c), [1, 2]);
  assert.strictEqual(await client.netPosition(1, 'CON.F.US.MNQ.Z26'), -1);
  assert.strictEqual(calls.filter(c => c.path === '/api/Auth/loginKey').length, 1);
  const barsCall = calls.find(c => c.path === '/api/History/retrieveBars');
  assert.deepStrictEqual([barsCall.body.unit, barsCall.body.unitNumber, barsCall.body.includePartialBar, barsCall.auth], [2, 3, false, 'Bearer tok']);
});

test('re-logs in on 401 and surfaces failed envelopes', async () => {
  let barsCalls = 0;
  const client = createClient({
    env,
    sleep: async () => {},
    fetchFn: fakeFetch({
      '/api/Auth/loginKey': { success: true, token: 'tok' },
      '/api/History/retrieveBars': () => (++barsCalls === 1 ? { status: 401 } : { success: true, bars: [] }),
      '/api/Contract/search': { success: false, errorCode: 1 },
    }),
  });
  assert.deepStrictEqual(await client.closedBars('C', { minutes: 1, limit: 1 }), []);
  await assert.rejects(client.activeContract('MNQ'), /errorCode 1/);
});

test('a request the API never answers fails after the timeout instead of hanging', { timeout: 30000 }, async () => {
  const { createClient } = require('../../scripts/lib/projectx-rest');
  const fetchFn = (url, opts) => new Promise((resolve, reject) => {
    if (url.endsWith('/api/Auth/loginKey')) return resolve({ ok: true, json: async () => ({ success: true, token: 't' }) });
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    return undefined;
  });
  const client = createClient({ env: { PROJECTX_USERNAME: 'u', PROJECTX_API_KEY: 'k' }, fetchFn });
  const t = Date.now();
  const keepAlive = setInterval(() => {}, 1000); // the timeout timer is unref'd; a real socket keeps the loop alive
  await assert.rejects(client.activeContract('MNQ'), /no answer in 15 s/);
  clearInterval(keepAlive);
  assert.ok(Date.now() - t < 20000);
});
