'use strict';

/**
 * Time-zone math without dependencies. The futures trading day starts at
 * 17:00 America/Chicago (CME Globex reopen; Topstep's daily loss reset).
 */

const TRADING_DAY_TZ = 'America/Chicago';
const TRADING_DAY_START_HOUR = 17;

// Building an Intl.DateTimeFormat is slow; keep one per time zone.
const FORMATTERS = new Map();
function formatter(timeZone) {
  let f = FORMATTERS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    FORMATTERS.set(timeZone, f);
  }
  return f;
}

function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).map(p => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
}

/** Offset (ms) of `timeZone` from UTC at `date`: local wall clock minus UTC. */
function zoneOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (date.getTime() - date.getMilliseconds());
}

/** UTC Date for a wall-clock time in `timeZone`. */
function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let guess = naive - zoneOffsetMs(new Date(naive), timeZone);
  // Re-evaluate once in case the guess crossed a DST boundary.
  guess = naive - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** Start of the current futures trading day (most recent 17:00 CT at or before `now`). */
function tradingDayStart(now = new Date()) {
  const p = zonedParts(now, TRADING_DAY_TZ);
  const anchor = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (p.hour < TRADING_DAY_START_HOUR) anchor.setUTCDate(anchor.getUTCDate() - 1);
  return zonedTimeToUtc({
    year: anchor.getUTCFullYear(),
    month: anchor.getUTCMonth() + 1,
    day: anchor.getUTCDate(),
    hour: TRADING_DAY_START_HOUR,
  }, TRADING_DAY_TZ);
}

/** Minutes since local midnight in `timeZone`. */
function minutesOfDay(now, timeZone) {
  const p = zonedParts(now, timeZone);
  return p.hour * 60 + p.minute;
}

function parseHhMm(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/**
 * Parse "09:30-09:35@America/New_York,15:00-17:00@America/Chicago" (or the
 * named sessions asia, london, ny).
 * Invalid entries are skipped and reported in `errors`.
 */
function parseWindows(spec) {
  const windows = [];
  const errors = [];
  for (const item of String(spec || '').split(',').map(s => s.trim()).filter(Boolean)) {
    // Named sessions (asia, london, ny) stand for their New York windows.
    const raw = SESSION_ALIASES[item.toLowerCase()] || item;
    const m = /^([^-]+)-([^@]+)@(.+)$/.exec(raw);
    const start = m && parseHhMm(m[1]);
    const end = m && parseHhMm(m[2]);
    if (!m || start === null || end === null || start === end) {
      errors.push(raw);
      continue;
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: m[3].trim() });
    } catch (_err) {
      errors.push(raw);
      continue;
    }
    windows.push({ label: raw === item ? raw : `${item} (${raw})`, start, end, timeZone: m[3].trim() });
  }
  return { windows, errors };
}

/** True when `now` falls inside [start, end) local time; handles windows crossing midnight. */
function inWindow(now, window) {
  const t = minutesOfDay(now, window.timeZone);
  if (window.start <= window.end) return t >= window.start && t < window.end;
  return t >= window.start || t < window.end;
}

/**
 * Hard trading hours: the Topstep session of CME futures, 18:00 ET to 16:00
 * ET the next day (22 hours), Sunday evening to Friday afternoon. Closed
 * 16:00-18:00 ET and over the weekend: no entry then, and every position is
 * flat by 16:00 ET. Strategies narrow it with `sessions` (e.g. [ny]).
 */
const MARKET_TZ = 'America/New_York';
const MARKET_OPEN_MIN = 18 * 60; // the session opens the evening before
const MARKET_CLOSE_MIN = 16 * 60;
const MARKET_HOURS_LABEL = '18:00-16:00 ET, Sunday evening to Friday afternoon (the Topstep session; closed 16:00-18:00 ET)';

/**
 * Named sessions inside the trading day, in New York time:
 *   asia   18:00-03:00 (Globex open through Tokyo and Hong Kong)
 *   london 03:00-09:30 (London open to the New York cash open)
 *   ny     09:30-16:00 (New York cash session to the close)
 */
const SESSION_ALIASES = {
  asia: '18:00-03:00@America/New_York',
  london: '03:00-09:30@America/New_York',
  ny: '09:30-16:00@America/New_York',
};

/**
 * The trading day `now` belongs to, named by the New York date it ends on:
 * the session from Sunday 18:00 ET to Monday 16:00 ET is Monday's.
 */
function tradingDayKey(now) {
  const p = zonedParts(new Date(tradingDayStart(now).getTime() + 12 * 3600000), MARKET_TZ);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** CME equity index early close: 13:00 ET (12:00 CT). */
const EARLY_CLOSE_MIN = 13 * 60;

/** Minutes since the start of `now`'s trading day (18:00 ET = 0). */
function sessionMinute(now) {
  return Math.floor((now.getTime() - tradingDayStart(now).getTime()) / 60000);
}

/**
 * Where a clock time ({ minute, timeZone }, e.g. 15:50 New York) falls in
 * `now`'s trading day, in minutes since its start; null if it never does.
 */
function sessionMinuteOf(at, now) {
  const start = tradingDayStart(now).getTime();
  for (const offset of [0, 1]) {
    const p = zonedParts(new Date(start + offset * 86400000), at.timeZone);
    const t = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: Math.floor(at.minute / 60), minute: at.minute % 60 }, at.timeZone).getTime();
    if (t >= start && t < start + 86400000) return Math.floor((t - start) / 60000);
  }
  return null;
}

/** Is `now` inside the market session? `until` (a New York minute) ends the afternoon early. */
function inMarketHours(now, { until = MARKET_CLOSE_MIN } = {}) {
  const p = zonedParts(now, MARKET_TZ);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0 Sunday
  const m = p.hour * 60 + p.minute;
  if (m >= MARKET_OPEN_MIN) return weekday >= 0 && weekday <= 4; // Sunday to Thursday evening
  if (m < Math.min(until, MARKET_CLOSE_MIN)) return weekday >= 1 && weekday <= 5; // Monday to Friday
  return false;
}

module.exports = {
  MARKET_TZ,
  MARKET_OPEN_MIN,
  MARKET_CLOSE_MIN,
  MARKET_HOURS_LABEL,
  SESSION_ALIASES,
  inMarketHours,
  sessionMinute,
  sessionMinuteOf,
  tradingDayKey,
  EARLY_CLOSE_MIN,
  TRADING_DAY_TZ,
  zonedParts,
  zonedTimeToUtc,
  tradingDayStart,
  minutesOfDay,
  parseWindows,
  inWindow,
};
