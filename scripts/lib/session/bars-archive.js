'use strict';

/**
 * The broker bars a session used, archived (R35): each closed bar the runner polls, with every field the
 * broker put on it kept as it came, is appended to the session's record dir, so the labels and training
 * can rebuild what a decision saw. The runner's own bars file is rewritten each bar; this one is appended.
 *
 *   <record dir>/bars-<trading day>.jsonl.gz       gzip JSON lines (one gzip member per append, so an append
 *       never rewrites the file): { symbol, contractId, minutes, bar } per bar, in the order they came
 *   <record dir>/bars-<trading day>.idx.json       { "<symbol>|<contractId>|<minutes>": last bar time archived,
 *       "#bytes": the archive's length after its last whole append }
 * The record dir is the live session's (<FTH_HOME>/sessions/<day>/, session/live.js) or, in a replay step,
 * the run's (FTH_REPLAY_RECORD_DIR, pinned by replay/config.js). Only bars newer than the last archived for
 * the symbol, contract and timeframe go on, the day before's index included, so the first poll of a day
 * never archives again the window the day before archived (the first poll of a session archives its whole
 * window). A crash mid-append can leave a torn tail: the next append cuts it off (appendBars); the reader
 * also skips any member that doesn't decode whole and keeps every member after it.
 *
 * Retention (disk), for live sessions only: when a day's file is created, the live archives in the home
 * (sessions/<day>/) beyond the newest FTH_BARS_ARCHIVE_DAYS trading days (default 90), then beyond
 * FTH_BARS_ARCHIVE_MB in all (default: no size cap), are removed, oldest first; the newest day never is.
 * A replay run's archive is its data and is never pruned.
 *
 *   archiveFile(dir, day), indexFile(dir, day)
 *   appendBars(dir, day, { symbol, contractId, minutes, bars }, { prior })   { added, created }
 *   readArchive(file)                       [{ symbol, contractId, minutes, bar }]: every whole gzip member
 *   readArchiveChecked(file)                { lines, error }: error when unreadable or nothing decodes
 *   archivedBars(dir, { log })              { get(symbol, contractId, minutes, t) -> bar | null, errors } over the
 *                                           dir's day files (contractId null: only when one contract has that bar)
 *   retention(env)                          { days, mb, warning? } (days capped at MAX_DAYS)
 *   pruneArchives(home, { days, mb, keep }) the live files removed, each leaving bars-<day>.pruned.json
 *   prunedFile(dir, day), wasPruned(dir, day)   that marker, and whether the day's archive was pruned
 *   recordDirFor(home, env, day)            where a process archives the day's bars
 *   barsArchiver({ home, env, minutes, now, log })   (symbol, { bars, contractId }) -> { added } | null: never throws
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { tradingDayKey } = require('../trading/clock');

const DEFAULT_DAYS = require('../tunables').runner().session.archiveDays; // config/runner.json
const DAY_FILE = /^bars-(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/;
const IDX_FILE = /^bars-(\d{4}-\d{2}-\d{2})\.idx\.json$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// The index's entry for the archive's committed length (no symbol key has this form).
const BYTES = '#bytes';
// The most trading days a live home keeps (about 14 years); a larger setting is capped, with a warning.
const MAX_DAYS = require('../tunables').runner().session.archiveMaxDays;

const archiveFile = (dir, day) => path.join(dir, `bars-${day}.jsonl.gz`);
const indexFile = (dir, day) => path.join(dir, `bars-${day}.idx.json`);
// Left where retention removed a day's archive, so its decisions say pruned, never a silent missing bar.
const prunedFile = (dir, day) => path.join(dir, `bars-${day}.pruned.json`);
const wasPruned = (dir, day) => fs.existsSync(prunedFile(dir, day));

function readIndex(file) {
  try {
    const x = JSON.parse(fs.readFileSync(file, 'utf8'));
    return x && typeof x === 'object' && !Array.isArray(x) ? x : {};
  } catch (_err) {
    return {};
  }
}

/** Writes a buffer at a file's end (flag 'a') or as a fresh file ('w'), synced to disk before it returns. */
function writeSynced(file, buf, flag) {
  const fd = fs.openSync(file, flag, 0o600);
  try {
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Appends the bars newer than the last archived for the symbol, contract and timeframe (this day's index,
 * else `prior`, the day before's: an index, or a function that reads it); one gzip member per call.
 * Crash-safe: a day's file is created whole (written aside, synced, renamed); before each append the file
 * is cut back to the length the index committed (BYTES), so a torn append is dropped, never glued to the
 * next member; the data is synced before the index moves, so the index never claims bars the file lacks
 * (a crash between the two archives those bars again: a repeat, never a gap).
 */
function appendBars(dir, day, { symbol, contractId = null, minutes = null, bars = [] }, { prior = {} } = {}) {
  const key = `${symbol}|${contractId}|${minutes}`;
  const idxFile = indexFile(dir, day);
  const file = archiveFile(dir, day);
  let idx = readIndex(idxFile);
  let size = null;
  try { size = fs.statSync(file).size; } catch (_err) { /* no file yet */ }
  // The file holds less than the index committed (it shouldn't, synced): forget the index, archive again.
  if (Number.isInteger(idx[BYTES]) && (size === null || size < idx[BYTES])) idx = {};
  const mark = idx[key] || (typeof prior === 'function' ? prior() : prior)[key];
  const last = mark ? Date.parse(mark) : -Infinity;
  const fresh = (bars || []).filter(b => b && Number.isFinite(Date.parse(b.t)) && Date.parse(b.t) > (Number.isFinite(last) ? last : -Infinity));
  if (!fresh.length) return { added: 0, created: false };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const member = zlib.gzipSync(fresh.map(bar => `${JSON.stringify({ symbol, contractId, minutes, bar })}\n`).join(''));
  const created = size === null;
  if (created) {
    const tmpData = `${file}.${process.pid}.tmp`;
    writeSynced(tmpData, member, 'w');
    fs.renameSync(tmpData, file);
  } else {
    // A torn append past the committed length: cut off. No committed length (an index lost): the file as it is.
    if (Number.isInteger(idx[BYTES]) && size > idx[BYTES]) fs.truncateSync(file, idx[BYTES]);
    writeSynced(file, member, 'a');
  }
  idx[key] = fresh.reduce((a, b) => (Date.parse(b.t) > Date.parse(a.t) ? b : a)).t;
  idx[BYTES] = fs.statSync(file).size;
  const tmp = `${idxFile}.${process.pid}.tmp`;
  writeSynced(tmp, Buffer.from(JSON.stringify(idx)), 'w');
  fs.renameSync(tmp, idxFile);
  return { added: fresh.length, created };
}

/** The offsets where a gzip member may start (its magic bytes and deflate method). */
function memberStarts(buf) {
  const out = [];
  for (let i = buf.indexOf(0x1f); i !== -1 && i + 2 < buf.length; i = buf.indexOf(0x1f, i + 1)) {
    if (buf[i + 1] === 0x8b && buf[i + 2] === 0x08) out.push(i);
  }
  return out;
}

/**
 * The archive's gzip members decoded one at a time: a member is the shortest slice from a start that
 * gunzips whole (its CRC and length checked); a start no slice decodes from (a torn append) is skipped,
 * and every member after it is kept.
 */
function decodeMembers(buf) {
  const starts = memberStarts(buf);
  const ends = [...starts.slice(1), buf.length];
  const out = [];
  let i = 0;
  while (i < starts.length) {
    let next = -1;
    for (let j = i; j < ends.length && next === -1; j += 1) {
      try {
        out.push(zlib.gunzipSync(buf.subarray(starts[i], ends[j])).toString('utf8'));
        next = j + 1;
      } catch (_err) { /* not a whole member yet: try a longer slice */ }
    }
    i = next === -1 ? i + 1 : next;
  }
  return out;
}

/**
 * The archive's lines from every whole gzip member, and `error` when the file can't be read (not a missing
 * one) or holds nothing that decodes: { lines, error }.
 */
function readArchiveChecked(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (err) { return { lines: [], error: err.code === 'ENOENT' ? null : `${path.basename(file)}: unreadable (${err.message})` }; }
  let texts;
  try { texts = [zlib.gunzipSync(buf).toString('utf8')]; } catch (_err) { texts = decodeMembers(buf); }
  const lines = [];
  for (const line of texts.join('').split('\n')) {
    if (!line.trim()) continue;
    try {
      const x = JSON.parse(line);
      if (x && typeof x === 'object' && x.bar && typeof x.bar === 'object') lines.push(x);
    } catch (_err) { /* a partial line */ }
  }
  const error = buf.length && !texts.length ? `${path.basename(file)}: nothing in it decodes (${buf.length} bytes)` : null;
  return { lines, error };
}

/** The archive's lines, from every whole gzip member ([] when unreadable: readArchiveChecked says why). */
const readArchive = file => readArchiveChecked(file).lines;

/**
 * Every archived bar of a record dir by symbol, contract, timeframe and time (the first one kept), and
 * `errors`: { day: why } for each day's archive that couldn't be read (each also logged, once).
 */
function archivedBars(dir, { log = () => {} } = {}) {
  const exact = new Map();
  const loose = new Map(); // symbol|minutes|ms -> the first archived bar at that time (the front contract's: see get)
  const errors = {};
  let names;
  try { names = fs.readdirSync(dir).filter(n => DAY_FILE.test(n)).sort(); } catch (_err) { names = []; }
  for (const n of names) {
    const { lines, error } = readArchiveChecked(path.join(dir, n));
    if (error) {
      errors[n.match(DAY_FILE)[1]] = error;
      log(`bars archive ${error}: its decisions get no archived bar (archiveError)`);
    }
    for (const x of lines) {
      const ms = Date.parse(x.bar.t);
      if (!Number.isFinite(ms)) continue;
      const k = `${x.symbol}|${x.contractId}|${x.minutes}|${ms}`;
      if (exact.has(k)) continue;
      exact.set(k, x.bar);
      const lk = `${x.symbol}|${x.minutes}|${ms}`;
      // Two contracts can have a time (the 3 weeks before a roll: the new front's first poll archives its window, shifted
      // from the old front's bars): the first archived is the one that was the front when the bar closed.
      if (!loose.has(lk)) loose.set(lk, x.bar);
    }
  }
  return {
    size: exact.size,
    errors,
    get(symbol, contractId, minutes, t) {
      const ms = Date.parse(t);
      if (contractId !== null && contractId !== undefined) return exact.get(`${symbol}|${contractId}|${minutes}|${ms}`) || null;
      return loose.get(`${symbol}|${minutes}|${ms}`) || null;
    },
  };
}

const positive = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** The archive's caps: FTH_BARS_ARCHIVE_DAYS (trading days, default 90) and FTH_BARS_ARCHIVE_MB (none by default). */
function retention(env = process.env) {
  const days = positive(env.FTH_BARS_ARCHIVE_DAYS);
  const out = { days: days ? Math.min(Math.floor(days), MAX_DAYS) : DEFAULT_DAYS, mb: positive(env.FTH_BARS_ARCHIVE_MB) };
  if (days && days > MAX_DAYS) out.warning = `FTH_BARS_ARCHIVE_DAYS ${env.FTH_BARS_ARCHIVE_DAYS} is above the cap: ${MAX_DAYS} trading days kept`;
  return out;
}

/** The live sessions' archive files of a home (a replay run's are never pruned). */
function archivesIn(home) {
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(path.join(home, 'sessions'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch (_err) { return out; }
  for (const d of dirs) {
    const dir = path.join(home, 'sessions', d);
    let names;
    try { names = fs.readdirSync(dir); } catch (_err) { continue; }
    for (const n of names) {
      const m = n.match(DAY_FILE);
      if (!m) continue;
      let size;
      try { size = fs.statSync(path.join(dir, n)).size; } catch (_err) { continue; }
      out.push({ file: path.join(dir, n), dir, day: m[1], size });
    }
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.file < b.file ? -1 : 1));
}

/** Removes the oldest live archives over the caps (days, then MB); `keep` (a file) and the newest day never. */
function pruneArchives(home, { days = DEFAULT_DAYS, mb = null, keep = null } = {}) {
  const all = archivesIn(home);
  if (!all.length) return [];
  const dayList = [...new Set(all.map(a => a.day))].sort();
  const newest = dayList[dayList.length - 1];
  const kept = new Set(dayList.slice(-Math.max(1, days)));
  const doomed = all.filter(a => !kept.has(a.day));
  if (mb) {
    let total = all.filter(a => kept.has(a.day)).reduce((n, a) => n + a.size, 0);
    for (const a of all.filter(x => kept.has(x.day))) {
      if (total <= mb * 1024 * 1024) break;
      if (a.day === newest || a.file === keep) continue;
      doomed.push(a);
      total -= a.size;
    }
  }
  const removed = [];
  for (const a of doomed) {
    if (a.file === keep) continue;
    try {
      fs.writeFileSync(prunedFile(a.dir, a.day), JSON.stringify({ prunedAt: new Date().toISOString(), bytes: a.size }), { mode: 0o600 });
      fs.rmSync(a.file, { force: true });
      fs.rmSync(indexFile(a.dir, a.day), { force: true });
      removed.push(a.file);
    } catch (_err) { /* the next prune tries again */ }
  }
  return removed;
}

/** A replay step's record dir (pinned by the driver), else the live session's for the trading day. */
const replayDir = env => (env.FTH_REPLAY_NOW && env.FTH_REPLAY_RECORD_DIR ? path.resolve(env.FTH_REPLAY_RECORD_DIR) : null);
function recordDirFor(home, env, day) {
  return replayDir(env) || path.join(home, 'sessions', day);
}

/** The index of the latest day before `day` that archived anything (a replay's in its dir, live in the sessions). */
function priorIndex(home, env, day) {
  const rd = replayDir(env);
  let found;
  try {
    if (rd) found = fs.readdirSync(rd).map(n => n.match(IDX_FILE)).filter(Boolean).map(m => [m[1], indexFile(rd, m[1])]);
    else found = fs.readdirSync(path.join(home, 'sessions')).filter(d => DAY.test(d)).map(d => [d, indexFile(path.join(home, 'sessions', d), d)]);
  } catch (_err) { return {}; }
  const before = found.filter(([d, f]) => d < day && fs.existsSync(f)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return before.length ? readIndex(before[before.length - 1][1]) : {};
}

/** The runner's archiver: each closed bar's window, appended to the day's archive; a failure is logged, never thrown. */
function barsArchiver({ home, env = process.env, minutes, now, log = () => {} }) {
  return (symbol, { bars, contractId = null } = {}) => {
    try {
      const day = tradingDayKey(now());
      const dir = recordDirFor(home, env, day);
      const r = appendBars(dir, day, { symbol, contractId, minutes, bars }, { prior: () => priorIndex(home, env, day) });
      // Live only (pruneArchives never reads a replay run's dir either; this skips its scan in a replay step).
      if (r.created && !replayDir(env)) {
        const caps = retention(env);
        if (caps.warning) log(caps.warning);
        pruneArchives(home, { days: caps.days, mb: caps.mb, keep: archiveFile(dir, day) });
      }
      return { added: r.added };
    } catch (err) {
      log(`${symbol}: could not archive the bars (${err.message})`, 'error');
      return null;
    }
  };
}

module.exports = { archiveFile, indexFile, prunedFile, wasPruned, appendBars, readArchive, readArchiveChecked, archivedBars, retention, pruneArchives, recordDirFor, priorIndex, barsArchiver, DEFAULT_DAYS, MAX_DAYS, BYTES };
