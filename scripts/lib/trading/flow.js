'use strict';

/**
 * Real order flow from the TopstepX (ProjectX) market hub: every trade print
 * is classified as buyer- or seller-initiated and summed into 1-minute buy
 * and sell volume, which the rules' ofi(n) and delta(n) use instead of the
 * bar-shape estimate.
 *
 * Classification (Lee-Ready, against the quote stream): a print at or above
 * the best ask is a buy, at or below the best bid a sell, otherwise the side
 * of the mid it is on, and at the mid the tick rule (up from the last print
 * = buy). The hub's own trade `type` is used only when no quote is known
 * and only once it has agreed with the quote rule on at least 50 prints at
 * a 90% rate, in either polarity (the published enum has been documented
 * both ways).
 *
 * A minute counts only when the hub was connected for all of it; a minute
 * with a gap has no flow (the rules then fall back to the estimate for that
 * bar), so a reconnect never shows up as a burst of one-sided volume.
 *
 * Pure: no network or files. The runner feeds it hub events and persists
 * finished minutes (flowCsv / parseFlowCsv).
 */

const MINUTE = 60000;
const CALIBRATE_MIN = 50;
const CALIBRATE_RATE = 0.9;

function createFlowBook({ keepMinutes = 5 * 24 * 60 } = {}) {
  const books = new Map(); // contractId -> state

  const book = id => {
    if (!books.has(id)) {
      // runs: connected intervals [start, end] (end null while connected);
      // loaded: minutes recorded earlier, trusted as complete.
      books.set(id, { quote: {}, last: null, minutes: new Map(), runs: [], loaded: new Set(), agree: { zeroIsBuy: 0, zeroIsSell: 0 } });
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
    const { bestBid: bid, bestAsk: ask } = b.quote;
    let side = 0;
    if (bid > 0 && ask > 0 && ask >= bid) {
      if (price >= ask) side = 1;
      else if (price <= bid) side = -1;
      else if (price > (bid + ask) / 2) side = 1;
      else if (price < (bid + ask) / 2) side = -1;
    }
    const t = Number(type);
    if (side !== 0 && (t === 0 || t === 1)) {
      // Learn which polarity the hub's type field uses.
      if ((t === 0) === (side === 1)) b.agree.zeroIsBuy += 1;
      else b.agree.zeroIsSell += 1;
    }
    if (side === 0 && (t === 0 || t === 1)) {
      const n = b.agree.zeroIsBuy + b.agree.zeroIsSell;
      if (n >= CALIBRATE_MIN) {
        if (b.agree.zeroIsBuy / n >= CALIBRATE_RATE) side = t === 0 ? 1 : -1;
        else if (b.agree.zeroIsSell / n >= CALIBRATE_RATE) side = t === 0 ? -1 : 1;
      }
    }
    if (side === 0 && b.last !== null && price !== b.last) side = price > b.last ? 1 : -1;
    return side;
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
  function finished(id, { since = -Infinity, now = Date.now() } = {}) {
    return [...minuteMap(id, now).entries()]
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
    // A covered minute with no prints traded nothing: zero flow, not unknown.
    for (const [s, e] of b.runs) {
      const last = Math.min(e === null ? now : e, now) - MINUTE;
      const first = Math.max(Math.ceil(s / MINUTE) * MINUTE, Math.floor((now - keepMinutes * MINUTE) / MINUTE) * MINUTE);
      for (let m = first; m <= last; m += MINUTE) {
        if (!map.has(m)) map.set(m, { bv: 0, sv: 0 });
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

module.exports = { createFlowBook, withFlow, flowCsv, parseFlowCsv, MINUTE };
