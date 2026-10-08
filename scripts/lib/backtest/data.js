'use strict';

/**
 * Historical bars for the backtester, from the file formats bar data usually
 * comes in, and aggregation into larger bars:
 *   - Parquet (.parquet, .pq): pandas/pyarrow, polars, DuckDB, fastparquet
 *   - Excel (.xlsx, .xlsm): the first sheet, or `sheet`
 *   - CSV (.csv, .txt) and JSON ({t,o,h,l,c,v} bars or { bars: [...] })
 * Tables need a header naming the time column (time, timestamp, datetime,
 * date, ts, t) and open, high, low, close, optionally volume (any case).
 * Times are ISO 8601 (UTC unless an offset is given), epoch s/ms/us/ns, a
 * Parquet timestamp, or an Excel date. Bars are keyed by their open time,
 * oldest first, deduplicated, and must sit on minute boundaries.
 */

const fs = require('fs');
const path = require('path');
const { normalizeBars, sessionKey } = require('../trading/indicators');
const { readParquet } = require('./parquet');
const { readXlsx, excelSerialToMs } = require('./xlsx');

const MINUTE = 60000;
const GLOBEX_OPEN_MIN = 18 * 60;
const TIME_NAMES = ['t', 'time', 'timestamp', 'datetime', 'date', 'ts', 'date_time', '__index_level_0__'];
const FIELD_NAMES = {
  o: ['o', 'open'], h: ['h', 'high'], l: ['l', 'low'], c: ['c', 'close', 'last'], v: ['v', 'volume', 'vol'],
  // Order flow (optional): aggressive buy and sell volume, or their difference.
  bv: ['bv', 'buy_volume', 'buyvolume', 'buy_vol', 'ask_volume', 'askvolume'],
  sv: ['sv', 'sell_volume', 'sellvolume', 'sell_vol', 'bid_volume', 'bidvolume'],
  delta: ['delta', 'volume_delta'],
};

/** Epoch ms from a number whose unit is guessed by magnitude (s, ms, us, ns). */
function epochMs(n) {
  const a = Math.abs(n);
  if (a >= 1e17) return Math.round(n / 1e6);
  if (a >= 1e14) return Math.round(n / 1e3);
  if (a >= 1e11) return Math.round(n);
  return Math.round(n * 1000);
}

function parseTime(raw, { excel = false, date1904 = false } = {}) {
  if (raw === null || raw === undefined || raw === '') return NaN;
  // Excel serial dates are day counts (under 1e6); bigger numbers are epoch times.
  const fromNumber = n => (excel && Math.abs(n) < 1e6 ? excelSerialToMs(n, date1904) : epochMs(n));
  const inRange = ms => (Math.abs(ms) <= 8.64e15 ? ms : NaN);
  if (typeof raw === 'number') return inRange(fromNumber(raw));
  const s = String(raw).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return inRange(fromNumber(Number(s)));
  // "2025-03-10 14:30:00" has no zone: treat it as UTC, like ProjectX.
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s.replace(' ', 'T');
  return Date.parse(iso);
}

/** Rows (arrays) with a header row, or objects keyed by column name, to raw bars. */
function tableToBars(header, rows, { excel = false, date1904 = false } = {}) {
  const names = header.map(h => String(h === null || h === undefined ? '' : h).trim().toLowerCase());
  const find = list => names.findIndex(n => list.includes(n));
  const idx = { t: find(TIME_NAMES) };
  for (const [k, list] of Object.entries(FIELD_NAMES)) idx[k] = find(list);
  for (const k of ['t', 'o', 'h', 'l', 'c']) {
    if (idx[k] === -1) throw new Error(`the data needs time, open, high, low, close columns (got: ${names.join(', ')})`);
  }
  return rows.map((r, i) => {
    const get = k => (Array.isArray(r) ? r[idx[k]] : r[header[idx[k]]]);
    const t = parseTime(get('t'), { excel, date1904 });
    if (!Number.isFinite(t)) throw new Error(`row ${i + 2}: unreadable time "${get('t')}"`);
    // An empty cell is missing, not zero: the row is dropped (a missing volume reads as 0).
    const num = x => (x === null || x === undefined || (typeof x === 'string' && x.trim() === '') ? NaN : Number(x));
    const v = idx.v === -1 ? 0 : num(get('v'));
    const bar = { t: new Date(t).toISOString(), o: num(get('o')), h: num(get('h')), l: num(get('l')), c: num(get('c')), v: Number.isFinite(v) ? v : 0 };
    const bv = idx.bv === -1 ? NaN : num(get('bv'));
    const sv = idx.sv === -1 ? NaN : num(get('sv'));
    const d = idx.delta === -1 ? NaN : num(get('delta'));
    if (Number.isFinite(bv) && Number.isFinite(sv)) Object.assign(bar, { bv, sv });
    else if (Number.isFinite(d) && bar.v > 0) Object.assign(bar, { bv: (bar.v + d) / 2, sv: (bar.v - d) / 2 });
    return bar;
  });
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length === 0) return [];
  return tableToBars(lines[0].split(','), lines.slice(1).map(l => l.split(',')));
}

/** Raw bars from any supported file. */
function readTable(file, { sheet = null } = {}) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.parquet' || ext === '.pq') {
    const { columns, rows } = readParquet(file);
    return tableToBars(columns, rows);
  }
  if (ext === '.xlsx' || ext === '.xlsm') {
    const { rows, date1904 } = readXlsx(file, { sheet });
    const start = rows.findIndex(r => r.some(x => x !== null));
    if (start === -1) return [];
    return tableToBars(rows[start], rows.slice(start + 1).filter(r => r.some(x => x !== null)), { excel: true, date1904 });
  }
  if (ext === '.xls') throw new Error(`${file}: legacy .xls is not supported; save it as .xlsx`);
  const text = fs.readFileSync(file, 'utf8');
  const trimmed = text.trimStart();
  return trimmed.startsWith('[') || trimmed.startsWith('{') ? normalizeBars(JSON.parse(text)) : parseCsv(text);
}

/** Load and clean bars from a Parquet, Excel, CSV, or JSON file. */
function loadBars(file, opts = {}) {
  const bars = normalizeBars(readTable(file, opts)).map(b => ({ ...b, ms: Date.parse(b.t) }));
  const out = [];
  for (const b of bars) {
    if (b.ms % MINUTE !== 0) throw new Error(`${file}: bar ${b.t} is not on a minute boundary`);
    if (out.length && out[out.length - 1].ms === b.ms) out[out.length - 1] = b; // keep the last duplicate
    else out.push(b);
  }
  return out.map(b => ({ t: new Date(b.ms).toISOString(), ms: b.ms, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, ...flowOf(b) }));
}

/**
 * Bars named on a command line: '-' is JSON on stdin (a get_bars reply or an
 * array); anything else is a file loadBars reads (JSON, CSV, Parquet, Excel).
 */
function readBarsArg(file) {
  if (file === '-') return normalizeBars(JSON.parse(fs.readFileSync(0, 'utf8')));
  return loadBars(path.resolve(file));
}

/**
 * A data audit before trusting a backtest: bars missing inside market hours
 * (the same trading day, not across the daily break or a weekend), opens that
 * jump more than `jumpAtr` x ATR(20) from the previous close (an unadjusted
 * contract roll, a bad tick, or a feed gap), and malformed bars (high below
 * low, or a close outside the range). Returns { bars, missing, gaps (largest
 * first), jumps, invalid, warnings }.
 */
function auditBars(bars, timeframe, { jumpAtr = 8, top = 5 } = {}) {
  const { inMarketHours, tradingDayKey } = require('../trading/clock');
  const { atr } = require('../trading/indicators');
  const step = timeframe * MINUTE;
  const a = atr(bars, 20);
  const gaps = [];
  const jumps = [];
  let missing = 0;
  let invalid = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    if (!(b.h >= b.l) || b.c > b.h || b.c < b.l || b.o > b.h || b.o < b.l) invalid += 1;
    if (i === 0) continue;
    const p = bars[i - 1];
    const ms = Date.parse(b.t);
    const pms = Date.parse(p.t);
    if (ms - pms > step && tradingDayKey(new Date(ms)) === tradingDayKey(new Date(pms))) {
      // Count only the absent bars that would have been in market hours (not the 16:00-18:00 ET break).
      let n = 0;
      for (let t = pms + step; t < ms; t += step) if (inMarketHours(new Date(t))) n += 1;
      if (n > 0) { missing += n; gaps.push({ after: p.t, before: b.t, bars: n }); }
    }
    const atrPrev = a[i - 1];
    if (Number.isFinite(atrPrev) && atrPrev > 0 && Math.abs(b.o - p.c) > jumpAtr * atrPrev) {
      jumps.push({ t: b.t, from: p.c, to: b.o, atr: Math.round(atrPrev * 100) / 100, x: Math.round((Math.abs(b.o - p.c) / atrPrev) * 10) / 10 });
    }
  }
  gaps.sort((x, y) => y.bars - x.bars);
  jumps.sort((x, y) => y.x - x.x);
  const warnings = [];
  if (missing) warnings.push(`${missing} bar(s) missing inside market hours in ${gaps.length} gap(s); largest ${gaps[0].bars} after ${gaps[0].after}`);
  if (jumps.length) warnings.push(`${jumps.length} open(s) jump more than ${jumpAtr} x ATR from the previous close (an unadjusted roll or a bad tick?); largest ${jumps[0].x} x ATR at ${jumps[0].t}`);
  if (invalid) warnings.push(`${invalid} malformed bar(s) (high below low, or open/close outside the range)`);
  // Real order flow (buy/sell volume) is recorded live only; the rest is the bar-shape estimate.
  const flowBars = bars.filter(b => Number.isFinite(b.bv) && Number.isFinite(b.sv)).length;
  return { bars: bars.length, missing, gaps: gaps.slice(0, top), jumps: jumps.slice(0, top), invalid, flowCoverage: bars.length ? Math.round((flowBars / bars.length) * 1000) / 1000 : 0, warnings };
}

/** { bv, sv } when the bar carries real order flow, else nothing. */
function flowOf(b) {
  return Number.isFinite(b.bv) && Number.isFinite(b.sv) ? { bv: b.bv, sv: b.sv } : {};
}

/** The bar size of a series in minutes (the most common spacing). */
function barMinutes(bars) {
  const counts = new Map();
  for (let i = 1; i < Math.min(bars.length, 5000); i += 1) {
    const d = (bars[i].ms - bars[i - 1].ms) / MINUTE;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best = null;
  for (const [d, n] of counts) if (best === null || n > counts.get(best) || (n === counts.get(best) && d < best)) best = d;
  return best;
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
      cur = { start, t: new Date(start).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, bv: b.bv, sv: b.sv };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
      // Flow for the bar only when every minute has it (else NaN: none).
      cur.bv += b.bv;
      cur.sv += b.sv;
    }
  }
  const last = out[out.length - 1];
  if (last && !includePartial) {
    const ended = unit === 4
      ? bucketStart(nowMs - (nowMs % MINUTE), 4, 1) > last.start
      : last.start + bucketLength(unit, unitNumber) <= nowMs;
    if (!ended) out.pop();
  }
  return out.map(({ t, o, h, l, c, v, bv, sv }) => ({ t, o, h, l, c, v, ...flowOf({ bv, sv }) }));
}

module.exports = { MINUTE, parseTime, parseCsv, tableToBars, readTable, loadBars, readBarsArg, auditBars, barMinutes, aggregate, bucketStart, epochMs };
