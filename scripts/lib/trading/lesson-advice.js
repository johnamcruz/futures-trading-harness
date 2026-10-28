'use strict';

/**
 * Journaled lessons are advice with their evidence, never rules (rules/trading/journaling.md): only the order gate and
 * the account's rulebook (code) block an entry. A lesson becomes teaching only through the training loop's keep rule
 * (a skill edit), and a rule only by the owner's rulebook edit; never on its own.
 *
 * Scope: a lesson counts only in its own run: written at or before `now` (a replay's clock: never a later run's or the
 * live account's lesson in the same journal) and at or after `from` (a fresh combine attempt's start, prop/attempt-
 * scope.js historyFrom). Fail safe: an undated lesson, or a `now` that isn't a time, is never shown.
 *
 * Its record, so it can't seal itself: since its date, the trades taken on its setup (the journal's graded reviews,
 * on its side when the lesson names one) and the composed plans walked forward model-free (lesson-shadow.js), taken or
 * not, on its side. Under config/runner.json prompt.trackRecordMinSlice composed plans: provisional; past it, a positive
 * mean R contradicts it ("contradicted by n=... since <date>"), else it is supported. A lesson that names no condition
 * the bars can check (a timeframe and a fact: "15m below EMA20", "3m CHoCH down") is flagged broad.
 *
 *   lessonDay(entry)                          the trading day (YYYY-MM-DD) it was written on, or null (undated)
 *   scopedLessons(entries, { now, from })     the lessons in scope, oldest first
 *   lessonSide(entry)                         'long' | 'short' | null (both or neither named)
 *   isBroad(entry)                            true when it names no condition the bars can check
 *   lessonRecord(entry, { reviews, shadow })  { taken: { n, wins, losses, R }, shadow: { n, wins, losses, R }, status }
 *   adviceText(entry, record)                 'lesson from <day> (<record>; <status>[; broad]): advice, weigh it: <text>'
 */

const { tradingDayKey } = require('./clock');
const { entryTime, reviewResult } = require('./journal');

const MIN_PLANS = require('../tunables').runner().prompt.trackRecordMinSlice; // config/runner.json

const isLesson = e => Boolean(e) && e.kind === 'lesson';
const timeOf = x => (x instanceof Date ? x.getTime() : Number.isFinite(x) ? x : NaN);
const text = e => String((e && e.text) || '').replace(/\s+/g, ' ').trim();
const tagValue = (e, prefix) => {
  const t = (Array.isArray(e && e.tags) ? e.tags : []).find(x => String(x).toLowerCase().startsWith(`${prefix}:`));
  return t ? String(t).slice(prefix.length + 1) : null;
};
const round = x => Math.round(x * 100) / 100;

function lessonDay(entry) {
  const t = entryTime(entry);
  return Number.isFinite(t) ? tradingDayKey(new Date(t)) : null;
}

function scopedLessons(entries, { now = null, from = null } = {}) {
  const at = timeOf(now);
  if (!Array.isArray(entries) || !Number.isFinite(at)) return [];
  const start = Number.isFinite(timeOf(from)) ? timeOf(from) : -Infinity;
  return entries.filter(e => isLesson(e) && Number.isFinite(entryTime(e)) && entryTime(e) <= at && entryTime(e) >= start);
}

function sideIn(s) {
  const long = /\blongs?\b/i.test(s);
  const short = /\bshorts?\b/i.test(s);
  return long === short ? null : long ? 'long' : 'short';
}
const lessonSide = entry => sideIn(text(entry));

// A condition the bars can check: a timeframe and a fact about it, the briefing's vocabulary.
const FRAME = /\b(?:\d{1,2}m|[14]h)\b/i;
const FACT = /\b(?:trend|choch|bos|ema\d*|vwap|supertrend|fvg|vah|val|poc|value|above|below|up|down|range|swing|high|low|close)\b/i;
const isBroad = entry => !(FRAME.test(text(entry)) && FACT.test(text(entry)));

const tally = rs => ({ n: rs.length, wins: rs.filter(r => r > 0).length, losses: rs.filter(r => r < 0).length, R: round(rs.reduce((a, b) => a + b, 0)) });

/** The composed plans after `since` on `side` (any side when null), one open at a time per side (a repeat isn't a new one). */
function plansSince(shadow, since, side) {
  const busy = {};
  const out = [];
  for (const x of [...(shadow || [])].sort((a, b) => Date.parse(a.entryTime || a.at) - Date.parse(b.entryTime || b.at))) {
    const t = Date.parse(x.entryTime || '');
    if (!Number.isFinite(x.R) || !Number.isFinite(t) || Date.parse(x.at) < since || (side && x.side !== side)) continue;
    if (busy[x.side] && t < busy[x.side]) continue;
    busy[x.side] = Date.parse(x.exitTime);
    out.push(x.R);
  }
  return out;
}

function lessonRecord(entry, { reviews = [], shadow = [] } = {}) {
  const since = entryTime(entry);
  const side = lessonSide(entry);
  const setup = tagValue(entry, 'setup');
  const rOf = r => { const v = Number(tagValue(r, 'r')); return Number.isFinite(v) ? v : reviewResult(r) === 'win' ? 1 : reviewResult(r) === 'loss' ? -1 : 0; };
  const taken = (reviews || []).filter(r => entryTime(r) >= since && (!setup || tagValue(r, 'setup') === setup) && (!side || sideIn(text(r)) === side)).map(rOf);
  const plans = tally(plansSince(shadow, since, side));
  const status = plans.n < MIN_PLANS ? 'provisional'
    : plans.R > 0 ? `contradicted by n=${plans.n} since ${lessonDay(entry)}` : `supported by n=${plans.n}`;
  return { taken: tally(taken), shadow: plans, status };
}

const recText = (label, t) => `${label} n=${t.n}${t.n ? `, ${t.wins}W/${t.losses}L, ${t.R >= 0 ? '+' : ''}${t.R}R` : ''}`;

function adviceText(entry, record = null) {
  const rec = record || lessonRecord(entry);
  const broad = isBroad(entry) ? '; broad: names no condition the bars can check' : '';
  return `lesson from ${lessonDay(entry) || 'an unknown day'} (${recText('taken since', rec.taken)}; ${recText('composed plans since', rec.shadow)}; ${rec.status}${broad}): advice, weigh it: ${text(entry)}`;
}

module.exports = { lessonDay, scopedLessons, lessonSide, isBroad, lessonRecord, adviceText };
