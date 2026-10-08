'use strict';

/**
 * Historical 1-minute bars for the simulated broker, and aggregation into the
 * bar sizes ProjectX serves. Input files:
 *   - JSON: an array of bars or { bars: [...] } with t/o/h/l/c/v (projectx-mcp
 *     get_bars output, or a file written by `backtest.js fetch`)
 *   - CSV: a header row naming time (or timestamp/datetime/t), open, high, low,
 *     close, and optionally volume; times are ISO 8601 (UTC unless an offset
 *     is given) or epoch seconds/milliseconds.
 * Bars are 1 minute, keyed by their open time, oldest first, deduplicated.
 */

const fs = require('fs');
const { normalizeBars, sessionKey } = require('../trading/indicators');

const MINUTE = 60000;
const GLOBEX_OPEN_MIN = 18 * 60;

function parseTime(raw) {
  const s = String(raw).trim();
  if (/^\d{9,10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{12,13}$/.test(s)) return Number(s);
  // "2025-03-10 14:30:00" has no zone: treat it as UTC, like ProjectX.
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  return Date.parse(iso);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length === 0) return [];
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const col = names => header.findIndex(h => names.includes(h));
  const idx = {
    t: col(['t', 'time', 'timestamp', 'datetime', 'date']),
    o: col(['o', 'open']), h: col(['h', 'high']), l: col(['l', 'low']), c: col(['c', 'close']), v: col(['v', 'volume', 'vol']),
  };
  for (const k of ['t', 'o', 'h', 'l', 'c']) {
    if (idx[k] === -1) throw new Error(`CSV header needs time, open, high, low, close columns (got: ${header.join(', ')})`);
  }
  return lines.slice(1).map((line, i) => {
    const f = line.split(',');
    const t = parseTime(f[idx.t]);
    if (!Number.isFinite(t)) throw new Error(`CSV line ${i + 2}: unreadable time "${f[idx.t]}"`);
    return { t: new Date(t).toISOString(), o: f[idx.o], h: f[idx.h], l: f[idx.l], c: f[idx.c], v: idx.v === -1 ? 0 : f[idx.v] };
  });
}

/** Load and clean 1-minute bars from a JSON or CSV file. */
function loadBars(file) {
  const text = fs.readFileSync(file, 'utf8');
  const trimmed = text.trimStart();
  const raw = trimmed.startsWith('[') || trimmed.startsWith('{') ? JSON.parse(text) : parseCsv(text);
  const bars = normalizeBars(raw).map(b => ({ ...b, ms: Date.parse(b.t) }));
  const out = [];
  for (const b of bars) {
    if (b.ms % MINUTE !== 0) throw new Error(`${file}: bar ${b.t} is not on a minute boundary; the backtester needs 1-minute bars`);
    if (out.length && out[out.length - 1].ms === b.ms) out[out.length - 1] = b; // keep the last duplicate
    else out.push(b);
  }
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].ms - out[i - 1].ms < MINUTE) throw new Error(`${file}: bars closer than 1 minute at ${out[i].t}; the backtester needs 1-minute bars`);
  }
  return out.map(b => ({ t: new Date(b.ms).toISOString(), ms: b.ms, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}

/** Start (ms) of the bar of `unit`/`unitNumber` containing the 1-minute bar opening at `ms`. */
function bucketStart(ms, unit, unitNumber) {
  if (unit === 2) return Math.floor(ms / (unitNumber * MINUTE)) * unitNumber * MINUTE;
  if (unit === 3) return Math.floor(ms / (unitNumber * 60 * MINUTE)) * unitNumber * 60 * MINUTE;
  if (unit === 4) {
    // Daily bars follow the futures trading day (18:00 ET open), stamped at that date's 00:00 UTC.
    return Date.parse(`${sessionKey(new Date(ms).toISOString(), GLOBEX_OPEN_MIN)}T00:00:00Z`);
  }
  throw new Error(`bar unit ${unit} is not available in a backtest (use minute, hour, or day)`);
}

function bucketLength(unit, unitNumber) {
  if (unit === 2) return unitNumber * MINUTE;
  if (unit === 3) return unitNumber * 60 * MINUTE;
  return 24 * 60 * MINUTE;
}

/**
 * Aggregate 1-minute bars (oldest first) that have closed by `nowMs` into
 * bars of the requested size. A bar is complete once its period has ended
 * (or, for daily bars, once a later trading day has started). With
 * `includePartial`, the forming bar is included too.
 */
function aggregate(minuteBars, { unit, unitNumber, nowMs, includePartial = false }) {
  const out = [];
  let cur = null;
  for (const b of minuteBars) {
    if (b.ms + MINUTE > nowMs) break;
    const start = bucketStart(b.ms, unit, unitNumber);
    if (!cur || cur.start !== start) {
      cur = { start, t: new Date(start).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  const last = out[out.length - 1];
  if (last && !includePartial) {
    const ended = unit === 4
      ? bucketStart(nowMs - (nowMs % MINUTE), 4, 1) > last.start
      : last.start + bucketLength(unit, unitNumber) <= nowMs;
    if (!ended) out.pop();
  }
  return out.map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
}

module.exports = { MINUTE, parseTime, parseCsv, loadBars, aggregate, bucketStart };
