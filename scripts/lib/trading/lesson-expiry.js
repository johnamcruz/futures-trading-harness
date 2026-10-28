'use strict';

/**
 * Journaled lessons are advice, never rules (rules/trading/journaling.md): only the order gate and the account's
 * rulebook (code) block an entry. A lesson is active only on the session day it was written (its trading day,
 * clock.js tradingDayKey: from 17:00 CT to the next day's), and expires at that day's end; no lesson carries a
 * condition the code can check on the current bars, so none outlives its day. Fail safe: a lesson without a readable
 * time, one written after `now`, or a `now` that isn't a time is never active. Every place that shows the model a
 * lesson takes the active ones from here and shows each as advice with its date, never as a standing rule.
 *
 *   lessonDay(entry)               the trading day (YYYY-MM-DD) a lesson was written on, or null (undated)
 *   isActive(entry, now)           a lesson written on now's trading day, at or before now
 *   activeLessons(entries, now)    the journal's active lessons, oldest first
 *   adviceText(entry)              'advice from <day>, not a rule: <text>' (one line)
 */

const { tradingDayKey } = require('./clock');
const { entryTime } = require('./journal');

const isLesson = e => Boolean(e) && e.kind === 'lesson';
const timeOf = now => (now instanceof Date ? now.getTime() : Number.isFinite(now) ? now : NaN);

function lessonDay(entry) {
  const t = entryTime(entry);
  return Number.isFinite(t) ? tradingDayKey(new Date(t)) : null;
}

function isActive(entry, now) {
  if (!isLesson(entry)) return false;
  const t = entryTime(entry);
  const at = timeOf(now);
  if (!Number.isFinite(t) || !Number.isFinite(at) || t > at) return false;
  return lessonDay(entry) === tradingDayKey(new Date(at));
}

const activeLessons = (entries, now) => (Array.isArray(entries) ? entries.filter(e => isActive(e, now)) : []);

const adviceText = entry => `advice from ${lessonDay(entry) || 'an unknown day'}, not a rule: ${String((entry && entry.text) || '').replace(/\s+/g, ' ').trim()}`;

module.exports = { lessonDay, isActive, activeLessons, adviceText };
