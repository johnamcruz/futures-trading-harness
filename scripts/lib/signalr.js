'use strict';

/**
 * Minimal SignalR (JSON protocol) hub client over the built-in WebSocket
 * (Node 22+), for the ProjectX market hub. It does what @microsoft/signalr
 * does with skipNegotiation + WebSockets, without the dependency: connect to
 * `<hub>?access_token=...`, handshake, invoke hub methods, dispatch server
 * events, keep-alive pings, and reconnect with backoff (re-running
 * `onConnected`, where the caller re-subscribes).
 *
 * Never logs the access token.
 */

const RS = '\x1e'; // record separator ending every SignalR message
const PING_MS = 15000;
const SERVER_TIMEOUT_MS = 30000;
const HANDSHAKE_MS = 10000;
const MAX_BACKOFF_MS = 30000;

function hubUrl(url, token) {
  const u = new URL(url);
  u.protocol = u.protocol === 'http:' ? 'ws:' : u.protocol === 'https:' ? 'wss:' : u.protocol;
  u.searchParams.set('access_token', token);
  return u.toString();
}

/**
 * @param url hub URL (https://rtc.topstepx.com/hubs/market)
 * @param getToken async () => bearer token
 * @param onConnected async (hub) => void, after every (re)connect
 * @param onDisconnected (at ms) => void, when the connection drops
 */
function createHub({ url, getToken, onConnected = async () => {}, onDisconnected = () => {}, log = () => {}, WebSocketImpl = globalThis.WebSocket, now = () => Date.now() }) {
  if (typeof WebSocketImpl !== 'function') throw new Error('order flow needs a WebSocket (Node 22 or later)');
  const handlers = new Map();
  const pending = new Map();
  let ws = null;
  let nextId = 1;
  let closed = false;
  let backoff = 1000;
  let timers = [];
  let lastSeen = 0;

  const clearTimers = () => { for (const t of timers) clearInterval(t); timers = []; };
  const send = msg => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg) + RS); };

  function failPending(err) {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  function dispatch(msg) {
    if (msg.type === 1 && handlers.has(msg.target)) {
      for (const fn of handlers.get(msg.target)) {
        try { fn(...(msg.arguments || [])); } catch (err) { log(`hub handler ${msg.target}: ${err.message}`); }
      }
    } else if (msg.type === 3 && pending.has(String(msg.invocationId))) {
      const p = pending.get(String(msg.invocationId));
      pending.delete(String(msg.invocationId));
      if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
    } else if (msg.type === 7) {
      log(`hub closed by server${msg.error ? `: ${msg.error}` : ''}`);
      if (ws) ws.close();
    }
  }

  function connectOnce() {
    return new Promise((resolve, reject) => {
      let handshaken = false;
      let buffer = '';
      (async () => {
        let token;
        try { token = await getToken(); } catch (err) { reject(err); return; }
        const sock = new WebSocketImpl(hubUrl(url, token));
        ws = sock;
        // On a failed handshake ws is cleared before rejecting, so the caller schedules the retry.
        const fail = err => { if (ws === sock) ws = null; reject(err); sock.close(); };
        const hsTimer = setTimeout(() => { if (!handshaken) fail(new Error('hub handshake timed out')); }, HANDSHAKE_MS);
        sock.onopen = () => sock.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
        sock.onmessage = ev => {
          lastSeen = now();
          buffer += typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
          let k;
          while ((k = buffer.indexOf(RS)) !== -1) {
            const text = buffer.slice(0, k);
            buffer = buffer.slice(k + 1);
            let msg;
            try { msg = JSON.parse(text); } catch (_err) { continue; }
            if (!handshaken) {
              handshaken = true;
              clearTimeout(hsTimer);
              if (msg.error) { fail(new Error(`hub handshake: ${msg.error}`)); return; }
              resolve();
              continue;
            }
            dispatch(msg);
          }
        };
        sock.onerror = () => {};
        let closedOnce = false;
        sock.onclose = () => {
          if (closedOnce) return;
          closedOnce = true;
          clearTimeout(hsTimer);
          // A socket already given up on (failed handshake, declared dead)
          // must not touch the connection that replaced it.
          if (ws !== sock) { reject(new Error('hub connection closed')); return; }
          ws = null;
          clearTimers();
          failPending(new Error('hub connection closed'));
          if (!handshaken) { reject(new Error('hub connection closed before the handshake')); return; }
          // Nothing arrived after the last message: coverage ends there, not at detection.
          onDisconnected(Math.min(now(), lastSeen || now()));
          if (!closed) scheduleReconnect();
        };
      })();
    });
  }

  async function connect() {
    await connectOnce();
    backoff = 1000;
    lastSeen = now();
    timers.push(setInterval(() => {
      send({ type: 6 });
      // No message (not even a ping) for a while: the socket is dead.
      // A half-open link never completes the close handshake, so don't wait
      // for onclose: tear down now, then close.
      if (now() - lastSeen > SERVER_TIMEOUT_MS && ws) {
        const dead = ws;
        if (typeof dead.onclose === 'function') dead.onclose();
        dead.close();
      }
    }, PING_MS));
    for (const t of timers) if (t.unref) t.unref();
    await onConnected(api);
  }

  function scheduleReconnect() {
    const wait = backoff;
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
    const t = setTimeout(() => {
      if (closed) return;
      connect().catch(err => { log(`hub reconnect failed: ${err.message}`); if (!closed && !ws) scheduleReconnect(); });
    }, wait);
    if (t.unref) t.unref();
  }

  const api = {
    on(target, fn) {
      if (!handlers.has(target)) handlers.set(target, []);
      handlers.get(target).push(fn);
    },
    invoke(target, ...args) {
      if (!ws || ws.readyState !== 1) return Promise.reject(new Error('hub not connected'));
      const id = String(nextId++);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ type: 1, invocationId: id, target, arguments: args });
      });
    },
    async start() {
      closed = false;
      try {
        await connect();
      } catch (err) {
        log(`hub connect failed: ${err.message}`);
        if (!closed && !ws) scheduleReconnect();
      }
    },
    close() {
      closed = true;
      clearTimers();
      if (ws) ws.close();
    },
    get connected() { return Boolean(ws && ws.readyState === 1); },
  };
  return api;
}

module.exports = { createHub, hubUrl, RS };
