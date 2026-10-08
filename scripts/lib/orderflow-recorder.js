'use strict';

/**
 * Records real order flow from the TopstepX (ProjectX) market hub: subscribes
 * to quotes and trade prints for each followed contract, classifies every
 * print as buyer- or seller-initiated (trading/flow.js), and appends each
 * finished, fully covered minute to <FTH_HOME>/flow/<contractId>.csv
 * (time,buy_volume,sell_volume). The runner annotates its bars with that
 * flow (bv/sv), so ofi(n) and delta(n) use real aggressor volume; the files
 * feed backtests (scripts/orderflow.js export).
 *
 * The market hub has no history: flow exists from the moment recording
 * starts. Uses PROJECTX_MARKET_HUB_URL (default the TopstepX hub).
 */

const fs = require('fs');
const path = require('path');
const { createHub } = require('./signalr');
const { createFlowBook, withFlow, flowCsv, parseFlowCsv, MINUTE } = require('./trading/flow');

const DEFAULT_MARKET_HUB_URL = 'https://rtc.topstepx.com/hubs/market';
const KEEP_MINUTES = 5 * 24 * 60;

function flowDir(home) {
  return path.join(home, 'flow');
}

function flowFile(home, contractId) {
  return path.join(flowDir(home), `${String(contractId).replace(/[^A-Za-z0-9._-]/g, '_')}.csv`);
}

/** Recorded minutes for a contract between from and to (ms), from its file. */
function readFlow(home, contractId, { from = -Infinity, to = Infinity } = {}) {
  let text;
  try {
    text = fs.readFileSync(flowFile(home, contractId), 'utf8');
  } catch (_err) {
    return [];
  }
  return parseFlowCsv(text).filter(r => r.t >= from && r.t < to);
}

function createRecorder({ home, getToken, env = process.env, log = () => {}, now = () => Date.now(), WebSocketImpl = globalThis.WebSocket, hubFactory = createHub }) {
  const book = createFlowBook({ keepMinutes: KEEP_MINUTES });
  const followed = new Set();
  const written = new Map(); // contractId -> last minute (ms) on disk
  let hub = null;

  async function subscribe(h, id) {
    await h.invoke('SubscribeContractQuotes', id);
    await h.invoke('SubscribeContractTrades', id);
    // Only from here on is every print of this contract seen.
    book.connected(id, now());
  }

  function start() {
    if (hub) return;
    hub = hubFactory({
      url: env.PROJECTX_MARKET_HUB_URL || DEFAULT_MARKET_HUB_URL,
      getToken,
      log: msg => log(`order flow: ${msg}`),
      WebSocketImpl,
      now,
      onConnected: async h => {
        for (const id of followed) {
          try { await subscribe(h, id); } catch (err) { log(`order flow: subscribe ${id} failed (${err.message})`, 'error'); }
        }
        log(`order flow: market hub connected (${[...followed].join(', ') || 'no contracts yet'})`);
      },
      onDisconnected: at => {
        book.disconnected(at);
        log('order flow: market hub disconnected; minutes without full coverage get no flow', 'error');
      },
    });
    hub.on('GatewayQuote', (id, data) => book.quote(id, data));
    hub.on('GatewayTrade', (id, data) => book.trades(id, data, now()));
    hub.start();
  }

  /** Record this contract (idempotent; on a roll, follow the new month). */
  function follow(contractId) {
    if (!contractId || followed.has(contractId)) return;
    followed.add(contractId);
    const earlier = readFlow(home, contractId, { from: now() - KEEP_MINUTES * MINUTE });
    book.load(contractId, earlier);
    if (earlier.length) written.set(contractId, earlier[earlier.length - 1].t);
    // A new hub subscribes every followed contract once it connects.
    if (!hub) { start(); return; }
    if (hub.connected) subscribe(hub, contractId).catch(err => log(`order flow: subscribe ${contractId} failed (${err.message})`, 'error'));
  }

  /** Append finished minutes not yet on disk. */
  function flush() {
    for (const id of followed) {
      const since = (written.get(id) ?? -Infinity) + MINUTE;
      const rows = book.finished(id, { since, now: now() });
      if (!rows.length) continue;
      try {
        fs.mkdirSync(flowDir(home), { recursive: true });
        fs.appendFileSync(flowFile(home, id), flowCsv(rows));
        written.set(id, rows[rows.length - 1].t);
      } catch (err) {
        log(`order flow: could not write ${flowFile(home, id)} (${err.message})`, 'error');
      }
    }
  }

  /** Bars of `minutes` minutes with real flow (bv, sv) where every minute is known. */
  function annotate(contractId, bars, minutes) {
    follow(contractId);
    flush();
    return withFlow(bars, book.minuteMap(contractId, now()), minutes);
  }

  function close() {
    flush();
    if (hub) hub.close();
    hub = null;
  }

  return { follow, flush, annotate, close, book };
}

module.exports = { DEFAULT_MARKET_HUB_URL, createRecorder, readFlow, flowFile, flowDir };
