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
 * Parse "09:30-09:35@America/New_York,15:00-17:00@America/Chicago".
 * Invalid entries are skipped and reported in `errors`.
 */
function parseWindows(spec) {
  const windows = [];
  const errors = [];
  for (const raw of String(spec || '').split(',').map(s => s.trim()).filter(Boolean)) {
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
    windows.push({ label: raw, start, end, timeZone: m[3].trim() });
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
 * Hard trading hours: the regular session of US index futures, 09:30-16:00
 * New York time, Monday to Friday. No entry outside them and no position held
 * outside them, whatever the configuration says.
 */
const MARKET_TZ = 'America/New_York';
const MARKET_OPEN_MIN = 9 * 60 + 30;
const MARKET_CLOSE_MIN = 16 * 60;
const MARKET_HOURS_LABEL = '09:30-16:00 ET, Monday to Friday';

/** Is `now` inside market hours (and, with `until`, before that New York minute)? */
function inMarketHours(now, { until = MARKET_CLOSE_MIN } = {}) {
  const p = zonedParts(now, MARKET_TZ);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const m = p.hour * 60 + p.minute;
  return m >= MARKET_OPEN_MIN && m < Math.min(until, MARKET_CLOSE_MIN);
}

module.exports = {
  MARKET_TZ,
  MARKET_OPEN_MIN,
  MARKET_CLOSE_MIN,
  MARKET_HOURS_LABEL,
  inMarketHours,
  TRADING_DAY_TZ,
  zonedParts,
  zonedTimeToUtc,
  tradingDayStart,
  minutesOfDay,
  parseWindows,
  inWindow,
};
