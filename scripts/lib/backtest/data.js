'use strict';

/**
 * Historical bars for the backtester, from the file formats bar data usually
 * comes in, and aggregation into larger bars:
 *   - Parquet (.parquet, .pq): pandas/pyarrow, polars, DuckDB, fastparquet
 *   - Excel (.xlsx, .xlsm): the first sheet, or `sheet`
 *   - CSV (.csv, .txt) and JSON ({t,o,h,l,c,v} bars or { bars: [...] })
 *   - JSON lines (.jsonl, .ndjson): one bar per line, as `backtest.js fetch` writes
 *     the broker's bars (every field kept; no one huge string for years of bars)
 * Tables need a header naming the time column (time, timestamp, datetime,
 * date, ts, t) and open, high, low, close, optionally volume (any case).
 * Times are ISO 8601 (UTC unless an offset is given), epoch s/ms/us/ns, a
 * Parquet timestamp, or an Excel date. Bars are keyed by their open time,
 * oldest first, deduplicated, and must sit on minute boundaries.
 *
 * Errors never echo the file's content (a header name, a cell, the text a JSON
 * parse error quotes): agents run the scripts on paths they name, and an
 * echoed line would show part of any file, a credentials file included.
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
  // "2025-03-10 14:30:00" has no zone: treat it as UTC, like get_bars.
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s.replace(' ', 'T');
  return Date.parse(iso);
}

/** The recognized column names among `names`, and how many others (never their text). */
function columnsSeen(names) {
  const known = new Set([...TIME_NAMES, ...Object.values(FIELD_NAMES).flat()]);
  const found = names.filter(n => known.has(n));
  const others = names.length - found.length;
  return `found: ${found.length ? found.join(', ') : 'none'}${others ? `, and ${others} other column(s)` : ''}`;
}

/** JSON.parse without the cause: V8's message quotes the text. */
/**
 * Shapes no bars file has, refused before parsing (JSON.parse and split hold everything at once, so a
 * crafted 50 MB file could take gigabytes): JSON nested deeper than 32 levels or with a value every few
 * bytes, a CSV with more than 1000 columns or a line every few bytes. Real bars use 4+ bytes a value
 * and 20+ a line, whatever the file's size.
 */
const MAX_DEPTH = 32;
const MAX_COLUMNS = 1000;
function checkJsonShape(text, label) {
  let depth = 0;
  let values = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 92) i += 1; // backslash: skip the escaped character
      else if (ch === 34) inString = false;
    } else if (ch === 34) inString = true;
    else if (ch === 91 || ch === 123) { // [ {
      depth += 1;
      values += 1;
      if (depth > MAX_DEPTH) throw new Error(`${label}: JSON nested deeper than ${MAX_DEPTH} levels (not a bars file)`);
    } else if (ch === 93 || ch === 125) depth -= 1;
    else if (ch === 44) values += 1; // ,
  }
  if (values > text.length / 3 + 16) throw new Error(`${label}: more JSON values than a bars file of its size holds (not a bars file)`);
}

/** A UTF-8 byte order mark (Excel and some exporters write one) is not part of the data. */
const stripBom = text => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * Bars from parsed JSON (get_bars output, or an array of bars as pandas to_json(orient='records') writes):
 * numeric times are epochs (s, ms, us or ns by magnitude, as in CSV). A file whose bars all fail to
 * read is refused, never loaded as no bars.
 */
function jsonBars(parsed, label) {
  const raw = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.bars) ? parsed.bars : null;
  // Records with other column names (timestamp, Date, Open...: a pandas index, yfinance) read as a table, as CSV
  // does, when no record has a t or time key (then the column names come from the first record that has a time column).
  const objects = raw ? raw.filter(b => b && typeof b === 'object' && !Array.isArray(b)) : [];
  if (objects.length && !objects.some(b => 't' in b || 'time' in b)) {
    const named = objects.find(b => Object.keys(b).some(k => TIME_NAMES.includes(String(k).trim().toLowerCase()))) || objects[0];
    let bars;
    try {
      bars = normalizeBars(tableToBars(Object.keys(named), objects));
    } catch (err) {
      throw new Error(`${label}: ${err.message}`, { cause: err });
    }
    if (!bars.length) throw new Error(`${label}: none of its ${objects.length} bars has a readable time, open, high, low and close`);
    return bars;
  }
  const epoch = b => {
    const t = b && typeof b === 'object' ? (b.t ?? b.time) : undefined;
    if (typeof t !== 'number' || !Number.isFinite(t)) return b;
    const ms = epochMs(t);
    // Past what a date can hold: left as is, for the bar to be dropped like any unreadable time.
    return Math.abs(ms) <= 8.64e15 ? { ...b, t: new Date(ms).toISOString(), time: undefined } : b;
  };
  const rows = raw ? raw.map(epoch) : null;
  const bars = normalizeBars(rows ? (Array.isArray(parsed) ? rows : { ...parsed, bars: rows }) : parsed);
  if (rows && rows.length && !bars.length) throw new Error(`${label}: none of its ${rows.length} bars has a readable time, open, high, low and close`);
  return bars;
}

function parseJson(text, label) {
  checkJsonShape(text, label);
  try {
    return JSON.parse(text);
  } catch (_err) {
    throw new Error(`${label}: not valid JSON`); // eslint-disable-line preserve-caught-error
  }
}

/** Rows (arrays) with a header row, or objects keyed by column name, to raw bars. */
function tableToBars(header, rows, { excel = false, date1904 = false } = {}) {
  const names = header.map(h => String(h === null || h === undefined ? '' : h).trim().toLowerCase());
  const find = list => names.findIndex(n => list.includes(n));
  const idx = { t: find(TIME_NAMES) };
  for (const [k, list] of Object.entries(FIELD_NAMES)) idx[k] = find(list);
  for (const k of ['t', 'o', 'h', 'l', 'c']) {
    if (idx[k] === -1) throw new Error(`the data needs time, open, high, low, close columns (${columnsSeen(names)})`);
  }
  return rows.map((r, i) => {
    const get = k => (Array.isArray(r) ? r[idx[k]] : r[header[idx[k]]]);
    const t = parseTime(get('t'), { excel, date1904 });
    if (!Number.isFinite(t)) throw new Error(`row ${i + 2}: unreadable time`);
    // An empty cell is missing, not zero: the row is dropped (a missing volume reads as 0).
    const num = x => (x === null || x === undefined || (typeof x === 'string' && x.trim() === '') ? NaN : Number(x));
    const v = idx.v === -1 ? 0 : num(get('v'));
    return { t: new Date(t).toISOString(), o: num(get('o')), h: num(get('h')), l: num(get('l')), c: num(get('c')), v: Number.isFinite(v) ? v : 0 };
  });
}

function parseCsv(text) {
  let count = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count += 1;
  if (count > text.length / 8 + 16) throw new Error('csv: more lines than a bars file of its size holds (not a bars file)');
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length === 0) return [];
  const header = lines[0].split(',', MAX_COLUMNS + 1);
  if (header.length > MAX_COLUMNS) throw new Error(`csv: more than ${MAX_COLUMNS} columns (not a bars file)`);
  // A row's cells past the header's columns are never read: don't split them out.
  return tableToBars(header, lines.slice(1).map(l => l.split(',', header.length)));
}

/** The objects of a JSON lines file, one a line (blank lines skipped), read line by line from the bytes. */
function readJsonLines(file) {
  const buf = fs.readFileSync(file);
  const out = [];
  let start = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  for (let n = 1; start < buf.length; n += 1) {
    let end = buf.indexOf(10, start);
    if (end === -1) end = buf.length;
    const line = buf.toString('utf8', start, end).trim();
    start = end + 1;
    if (line) out.push(parseJson(line, `${file}: line ${n}`));
  }
  return out;
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
  if (ext === '.jsonl' || ext === '.ndjson') return jsonBars(readJsonLines(file), file);
  if (ext === '.xls') throw new Error(`${file}: legacy .xls is not supported; save it as .xlsx`);
  const text = stripBom(fs.readFileSync(file, 'utf8'));
  const trimmed = text.trimStart();
  return trimmed.startsWith('[') || trimmed.startsWith('{') ? jsonBars(parseJson(text, file), file) : parseCsv(text);
}

/** Load and clean bars from a Parquet, Excel, CSV, or JSON file. */
function loadBars(file, opts = {}) {
  const bars = normalizeBars(readTable(file, opts)).map(b => ({ ...b, ms: Date.parse(b.t) }));
  const out = [];
  for (const b of bars) {
    if (b.ms % MINUTE !== 0) throw new Error(`${file}: a bar at ${new Date(b.ms).toISOString()} is not on a minute boundary`);
    if (out.length && out[out.length - 1].ms === b.ms) out[out.length - 1] = b; // keep the last duplicate
    else out.push(b);
  }
  // Fields a broker put on its bars (a JSON file of get_bars bars) pass through untouched.
  return out.map(b => ({ ...b, t: new Date(b.ms).toISOString() }));
}

/**
 * Bars named on a command line: '-' is JSON on stdin (a get_bars reply or an
 * array); anything else is a file loadBars reads (JSON, CSV, Parquet, Excel).
 */
function readBarsArg(file) {
  if (file === '-') return jsonBars(parseJson(stripBom(fs.readFileSync(0, 'utf8')), 'stdin'), 'stdin');
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
  return { bars: bars.length, missing, gaps: gaps.slice(0, top), jumps: jumps.slice(0, top), invalid, warnings };
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

/** Keys a bar carries beyond its time and prices (the broker's own fields), sorted; [] for none. */
function extraKeys(bars) {
  const keys = new Set();
  for (const b of bars) for (const k of Object.keys(b)) if (!PLAIN_KEYS.has(k)) keys.add(k);
  return [...keys].sort();
}
const PLAIN_KEYS = new Set(['t', 'o', 'h', 'l', 'c', 'v', 'ms']);

/**
 * Aggregate 1-minute bars (oldest first) that have closed by `nowMs` into
 * bars of the requested size. A bar is complete once its period has ended
 * (or, for daily bars, once a later trading day has started). With
 * `includePartial`, the forming bar is included too.
 *
 * A bar built here carries only time, prices and volume: the harness can't combine the broker's own
 * fields (only the broker knows what they mean over a longer bar). So bars that carry any are refused
 * unless the caller says `extraFields: 'drop'` (and says so itself, where it drops them); fetch them
 * from the broker at the timeframe instead.
 */
function aggregate(minuteBars, { unit, unitNumber, nowMs, includePartial = false, extraFields = 'refuse' }) {
  if (extraFields !== 'drop') {
    const extra = extraKeys(minuteBars);
    if (extra.length) {
      throw new Error(`these bars carry the broker's own fields (${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ', ...' : ''}), which the harness can't combine into longer bars: fetch bars at the timeframe you need from the broker instead (backtest.js fetch --timeframe <minutes>)`);
    }
  }
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

module.exports = { MINUTE, parseTime, parseCsv, tableToBars, readTable, readJsonLines, loadBars, readBarsArg, auditBars, barMinutes, aggregate, extraKeys, bucketStart, epochMs };
