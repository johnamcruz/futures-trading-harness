'use strict';

/**
 * Real order flow from the TopstepX (ProjectX) market hub: every trade print
 * is classified as buyer- or seller-initiated and summed into 1-minute buy
 * and sell volume, which the rules' ofi(n) and delta(n) use instead of the
 * bar-shape estimate.
 *
 * Classification: the hub's trade `type` is the aggressor side (0 buy-,
 * 1 sell-initiated), as algoTraderAI uses it. A print without a type falls
 * back to the quote (Lee-Ready: at or above the ask a buy, at or below the
 * bid a sell, else the side of the mid), then the tick rule.
 *
 * A minute counts only when the hub was connected for all of it; a minute
 * with a gap has no flow (the rules then fall back to the estimate for that
 * bar), so a reconnect never shows up as a burst of one-sided volume.
 *
 * Pure: no network or files. The runner feeds it hub events and persists
 * finished minutes (flowCsv / parseFlowCsv).
 */

const MINUTE = 60000;
// A connected feed with no prints for this long is treated as stale: quiet
// minutes after it are unknown, not zero (algoTraderAI uses 5 minutes).
const STALE_MINUTES = 5;
// Minutes are written to disk only this long after they end, so late prints
// land in memory and file alike.
const FLUSH_GRACE_MS = 10000;

function createFlowBook({ keepMinutes = 5 * 24 * 60 } = {}) {
  const books = new Map(); // contractId -> state

  const book = id => {
    if (!books.has(id)) {
      // runs: connected intervals [start, end] (end null while connected);
      // loaded: minutes recorded earlier, trusted as complete.
      books.set(id, { quote: {}, last: null, minutes: new Map(), runs: [], loaded: new Set() });
    }
    return books.get(id);
  };

  /** The hub (re)connected and this contract is subscribed from `at` (ms). */
  function connected(id, at) {
    const b = book(id);
    const run = b.runs[b.runs.length - 1];
    if (!run || run[1] !== null) b.runs.push([at, null]);
  }

  /** The connection dropped at `at`: minutes it touched are incomplete. */
  function disconnected(at) {
    for (const b of books.values()) {
      const run = b.runs[b.runs.length - 1];
      if (run && run[1] === null) run[1] = at;
      // Prices from before the gap say nothing about the next print.
      b.last = null;
      b.quote = {};
    }
  }

  function quote(id, q) {
    const b = book(id);
    for (const k of ['bestBid', 'bestAsk', 'lastPrice']) if (Number.isFinite(Number(q && q[k])) && Number(q[k]) > 0) b.quote[k] = Number(q[k]);
  }

  function sideOf(b, price, type) {
    // The hub's GatewayTrade type is the aggressor side: 0 buy, 1 sell (as
    // algoTraderAI trades on it).
    const t = type === null || type === undefined || type === '' ? NaN : Number(type);
    if (t === 0) return 1;
    if (t === 1) return -1;
    const { bestBid: bid, bestAsk: ask } = b.quote;
    if (bid > 0 && ask > 0 && ask >= bid) {
      if (price >= ask) return 1;
      if (price <= bid) return -1;
      if (price > (bid + ask) / 2) return 1;
      if (price < (bid + ask) / 2) return -1;
    }
    if (b.last !== null && price !== b.last) return price > b.last ? 1 : -1;
    return 0;
  }

  /** Trade prints for a contract: { price, volume, type, timestamp }. */
  function trades(id, list, receivedAt = Date.now()) {
    const b = book(id);
    for (const tr of Array.isArray(list) ? list : [list]) {
      const price = Number(tr && tr.price);
      const vol = Number(tr && (tr.volume ?? tr.size));
      if (!(price > 0) || !(vol > 0)) continue;
      const ts = Date.parse(tr.timestamp);
      const at = Number.isFinite(ts) ? ts : receivedAt;
      const side = sideOf(b, price, tr.type);
      b.last = price;
      const m = Math.floor(at / MINUTE) * MINUTE;
      const cell = b.minutes.get(m) || { bv: 0, sv: 0, uv: 0 };
      if (side > 0) cell.bv += vol;
      else if (side < 0) cell.sv += vol;
      else cell.uv += vol; // unclassified (first print, no quote): split evenly
      b.minutes.set(m, cell);
    }
    const cutoff = receivedAt - keepMinutes * MINUTE;
    for (const m of b.minutes.keys()) if (m < cutoff) b.minutes.delete(m);
    b.runs = b.runs.filter(([, end]) => end === null || end >= cutoff);
  }

  /** Was the hub connected for the whole minute starting at m (ms)? */
  function covered(b, m, now) {
    const end = m + MINUTE;
    if (end > now) return false;
    if (b.loaded.has(m)) return true;
    return b.runs.some(([s, e]) => s <= m && (e === null || e >= end));
  }

  /**
   * Finished, fully covered minutes for a contract: [{ t (ms), bv, sv }].
   * Minutes with no prints while connected are real zero-volume minutes.
   */
  function finished(id, { since = -Infinity, now = Date.now(), graceMs = FLUSH_GRACE_MS } = {}) {
    return [...minuteMap(id, now - graceMs).entries()]
      .filter(([m]) => m >= since)
      .sort((x, y) => x[0] - y[0])
      .map(([t, c]) => ({ t, bv: c.bv, sv: c.sv }));
  }

  /** Load minutes recorded earlier (e.g. from flowCsv files), trusted as covered. */
  function load(id, rows) {
    const b = book(id);
    for (const r of rows) {
      if (b.minutes.has(r.t)) continue;
      b.minutes.set(r.t, { bv: r.bv, sv: r.sv, uv: 0 });
      b.loaded.add(r.t);
    }
  }

  /** Flow per minute (ms -> { bv, sv }) usable for bars: recorded or covered. */
  function minuteMap(id, now = Date.now()) {
    const b = books.get(id);
    const map = new Map();
    if (!b) return map;
    for (const [m, c] of b.minutes) {
      if (covered(b, m, now)) map.set(m, { bv: c.bv + c.uv / 2, sv: c.sv + c.uv / 2 });
    }
    // A covered minute with no prints traded nothing (zero flow), but only
    // within STALE_MINUTES of a print: a feed silent longer is unknown.
    for (const [s, e] of b.runs) {
      const last = Math.min(e === null ? now : e, now) - MINUTE;
      const first = Math.max(Math.ceil(s / MINUTE) * MINUTE, Math.floor((now - keepMinutes * MINUTE) / MINUTE) * MINUTE);
      let lastPrinted = null;
      // A minute "printed" when it traded: recorded zero minutes don't count.
      const printed = m => { const c = b.minutes.get(m); return Boolean(c && c.bv + c.sv + c.uv > 0); };
      for (let m = first - STALE_MINUTES * MINUTE; m < first; m += MINUTE) if (printed(m)) lastPrinted = m;
      for (let m = first; m <= last; m += MINUTE) {
        if (b.minutes.has(m)) { if (printed(m)) lastPrinted = m; continue; }
        if (lastPrinted !== null && m - lastPrinted <= STALE_MINUTES * MINUTE) map.set(m, { bv: 0, sv: 0 });
      }
    }
    return map;
  }

  return { connected, disconnected, quote, trades, finished, load, minuteMap, contracts: () => [...books.keys()] };
}

/**
 * Attach buy/sell volume (bv, sv) to bars of `minutes` minutes from per-minute
 * flow. A bar gets flow only when every one of its minutes is known; a bar
 * with no volume needs none.
 */
function withFlow(bars, map, minutes) {
  return bars.map(b => {
    const start = Date.parse(b.t);
    let bv = 0;
    let sv = 0;
    for (let k = 0; k < minutes; k += 1) {
      const c = map.get(start + k * MINUTE);
      if (!c) return b;
      bv += c.bv;
      sv += c.sv;
    }
    return { ...b, bv, sv };
  });
}

/** Recorded flow as CSV (time,buy_volume,sell_volume), one row per minute. */
function flowCsv(rows) {
  return rows.map(r => `${new Date(r.t).toISOString()},${r.bv},${r.sv}\n`).join('');
}

function parseFlowCsv(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const [t, bv, sv] = line.trim().split(',');
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && Number.isFinite(Number(bv)) && Number.isFinite(Number(sv)) && bv !== '' && sv !== '') {
      out.push({ t: ms, bv: Number(bv), sv: Number(sv) });
    }
  }
  return out;
}

module.exports = { createFlowBook, withFlow, flowCsv, parseFlowCsv, MINUTE, STALE_MINUTES, FLUSH_GRACE_MS };
