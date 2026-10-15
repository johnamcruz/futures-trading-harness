'use strict';

/**
 * When a replay runs the live runner: the decision times a live runner on this
 * config would have acted at, inside a window.
 *
 *   trade      every closed bar of the timeframe inside the runner's sessions
 *              and the market session, before end of day, polled
 *              barDelaySeconds after the close as the live runner polls it
 *              (optionally every Nth bar of each trading day); with several
 *              timeframe lanes (lanes.js), the union of every lane's closes,
 *              one point per close time however many lanes close then (the
 *              live runner coalesces them into one cycle), each point listing
 *              its lanes (`lanes`: [3, 1], in the config's lane order); a data
 *              lane (trigger "data") adds no point: its bars are polled at the
 *              trading lanes' points, up to each point (causal), as live
 *              cycles only on them;
 *   premarket  the config's premarketAt (when premarket runs);
 *   eod        end of day (eodAt, or earlyCloseEodAt on an early close).
 *
 * Exchange holidays and closed days (the harness calendar: the config's
 * closedDates, which validateConfig merges with the built-in CME calendar) and
 * days with no session (weekends) have none. Each point is
 * { t: Date, kind, day } with `day` the trading day (YYYY-MM-DD, the New York
 * date it ends on), sorted by time.
 *
 *   decisionPoints(cfg, { start, end, everyNth, delayMs })
 *   tradingDays(cfg, { start, end })   [{ day, start, skipped }] (skipped: why a day has no points)
 *   holidayDates(start, end)           { closed, early } from cmeHolidays for years the built-in calendar lacks
 *   isTradeTime(cfg, t)                whether t (a bar's close plus barDelaySeconds) is a trade decision time:
 *                                      the rule decisionPoints applies, for the live session record (session/live.js)
 */

const { tradingDayStart, tradingDayKey, inMarketHours, inWindow, parseWindows, sessionMinute, sessionMinuteOf } = require('../trading/clock');
const { endOfDayAt, parseAt } = require('../autotrader');
const { CLOSED, cmeHolidays } = require('../trading/exchange-calendar');
const { tradingLanes } = require('../lanes');

const HOUR = 3600000;

/** Every trading day that starts before `end` and ends after `start`. */
function tradingDays(cfg, { start, end }) {
  const out = [];
  for (let d = tradingDayStart(start); d.getTime() < end.getTime(); d = tradingDayStart(new Date(d.getTime() + 26 * HOUR))) {
    const day = tradingDayKey(new Date(d.getTime() + 12 * HOUR));
    // 09:00 ET of the day: inside the market session on every day that has one.
    const skipped = (cfg.closedDates || []).includes(day) ? 'exchange closed (holiday)'
      : !inMarketHours(new Date(d.getTime() + 15 * HOUR)) ? 'no session (weekend)' : null;
    out.push({ day, start: d, skipped });
  }
  return out;
}

/** Every bar close of the lanes from `from` (exclusive) to `to` (inclusive): [[closeMs, [timeframes]]], by time. */
function laneCloses(lanes, from, to) {
  const closes = new Map();
  for (const { timeframe } of lanes) {
    const step = timeframe * 60000;
    for (let close = Math.floor(from / step) * step + step; close <= to; close += step) {
      if (!closes.has(close)) closes.set(close, []);
      closes.get(close).push(timeframe);
    }
  }
  return [...closes.entries()].sort((a, b) => a[0] - b[0]);
}

function decisionPoints(cfg, { start, end, everyNth = 1, delayMs = (cfg.barDelaySeconds || 0) * 1000 }) {
  const lanes = tradingLanes(cfg);
  const multi = lanes.length > 1;
  const windows = parseWindows(cfg.sessions.join(',')).windows;
  const inside = t => t.getTime() >= start.getTime() && t.getTime() < end.getTime();
  const points = [];
  for (const { day, start: d, skipped } of tradingDays(cfg, { start, end })) {
    if (skipped) continue;
    const eodMin = sessionMinuteOf(endOfDayAt(cfg, new Date(d.getTime() + 12 * HOUR)), d);
    const eodAt = new Date(d.getTime() + eodMin * 60000);
    let n = 0;
    for (const [close, tfs] of laneCloses(lanes, d.getTime(), eodAt.getTime())) {
      const t = new Date(close + delayMs);
      // At or after end of day the runner runs end of day, not a bar's cycle.
      if (sessionMinute(t) >= eodMin || tradingDayStart(t).getTime() !== d.getTime()) break;
      if (!inMarketHours(t) || !windows.some(w => inWindow(t, w))) continue;
      n += 1;
      if ((n - 1) % everyNth !== 0) continue;
      if (inside(t)) points.push(multi ? { t, kind: 'trade', day, lanes: tfs } : { t, kind: 'trade', day });
    }
    const pre = parseAt(cfg.premarketAt);
    const preMin = pre ? sessionMinuteOf(pre, d) : null;
    if (preMin !== null && preMin < eodMin) {
      const t = new Date(d.getTime() + preMin * 60000);
      if (inMarketHours(t) && inside(t)) points.push({ t, kind: 'premarket', day });
    }
    if (inside(eodAt)) points.push({ t: eodAt, kind: 'eod', day });
  }
  // Premarket first at the same time: the live runner's schedule does it before a bar's cycle.
  const order = { premarket: 0, trade: 1, eod: 2 };
  return points.sort((a, b) => a.t - b.t || order[a.kind] - order[b.kind]);
}

/**
 * Whether `t` is a trade decision time by decisionPoints' rule (everyNthBar aside): a trading day that
 * isn't closed, the market session, one of the runner's sessions, and before that day's end of day.
 */
function isTradeTime(cfg, t) {
  const d = tradingDayStart(t);
  if ((cfg.closedDates || []).includes(tradingDayKey(t)) || !inMarketHours(t)) return false;
  const eod = endOfDayAt(cfg, new Date(d.getTime() + 12 * HOUR));
  if (eod && sessionMinute(t) >= sessionMinuteOf(eod, d)) return false;
  return parseWindows(cfg.sessions.join(',')).windows.some(w => inWindow(t, w));
}

/**
 * Holidays and early closes for the window's years that the built-in calendar
 * doesn't list (a replay of an earlier year): the harness's own CME rules
 * (exchange-calendar.js cmeHolidays), so the runner, the gate and the decision
 * times skip them as they skip a listed holiday.
 */
function holidayDates(start, end) {
  const covered = new Set(CLOSED.map(d => d.slice(0, 4)));
  const closed = [];
  const early = [];
  for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y += 1) {
    if (covered.has(String(y))) continue;
    const h = cmeHolidays(y);
    closed.push(...h.closed);
    early.push(...h.early);
  }
  return { closed, early };
}

module.exports = { decisionPoints, laneCloses, tradingDays, holidayDates, isTradeTime };
