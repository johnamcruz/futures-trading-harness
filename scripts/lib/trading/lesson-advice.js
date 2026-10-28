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
 * Its record, so it can't seal itself: since its date and up to `now` (inside its scope), the trades taken on its
 * setup (the journal's graded reviews, on its side when the lesson names one) and the composed plans walked forward
 * model-free (lesson-shadow.js), taken or not, on its side and its symbol: every such plan, not only those its
 * condition names (the shadow lines carry no bar facts), and labelled so. Its verdict: under config/runner.json
 * prompt.lessonMinPlans plans, provisional; past it, by the lesson's direction (against a setup: "skip", "avoid",
 * "no"; for one: "favour", "take", "prefer"), the plans' summed R supports or contradicts it ("contradicted by n=...
 * since <date>"); a lesson of no clear direction, or a broad one, gets no verdict, only its numbers. A lesson that
 * names no condition the bars can check (a timeframe with a briefing fact: "15m EMA20", "3m trend up", "15m ... CHoCH
 * down") is flagged broad.
 *
 *   lessonDay(entry)                          the trading day (YYYY-MM-DD) it was written on, or null (undated)
 *   scopedLessons(entries, { now, from })     the lessons in scope, oldest first
 *   lessonSide(entry)                         'long' | 'short' | null (both or neither named)
 *   isBroad(entry)                            true when it names no condition the bars can check
 *   lessonDirection(entry)                    'against' | 'for' | null
 *   lessonRecord(entry, { reviews, shadow, now, from })  { taken: { n, wins, losses, R }, shadow: { n, ... }, status }
 *   adviceText(entry, record)                 'lesson from <day> (<record>; <status>[; broad]): advice, weigh it: <text>'
 */

const { tradingDayKey } = require('./clock');
const { entryTime, reviewResult } = require('./journal');

const MIN_PLANS = require('../tunables').runner().prompt.lessonMinPlans; // config/runner.json

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

// A condition the bars can check: a timeframe with a briefing fact about it, at most four words apart ("15m EMA20",
// "3m trend up", "15m not in a fresh CHoCH down", "15m close below"); a timeframe or a word alone is no condition.
const CONDITION = /\b(?:\d{1,2}m|[14]h)\b(?:\s+[\w-]+){0,4}?\s+(?:trend|choch|bos|ema\d+|vwap|supertrend|fvg|swing|structure|close\s+(?:above|below))\b/i;
const isBroad = entry => !CONDITION.test(text(entry));

const AGAINST = /\b(?:skip|avoid|don'?t|do not|never|no|stop|stand aside|pass on|weak|restrict\w*)\b/i;
const FOR = /\b(?:favou?r|take|prefer|strong|works?)\b/i;
function lessonDirection(entry) {
  const a = AGAINST.test(text(entry));
  const f = FOR.test(text(entry));
  return a === f ? null : a ? 'against' : 'for';
}

const tally = rs => ({ n: rs.length, wins: rs.filter(r => r > 0).length, losses: rs.filter(r => r < 0).length, R: round(rs.reduce((a, b) => a + b, 0)) });

/** The composed plans after `since` on `side` (any when null) and `roots` (any when empty), one open at a time per side. */
function plansSince(shadow, since, side, roots = []) {
  const busy = {};
  const out = [];
  for (const x of [...(shadow || [])].sort((a, b) => Date.parse(a.entryTime || a.at) - Date.parse(b.entryTime || b.at))) {
    const t = Date.parse(x.entryTime || '');
    if (!Number.isFinite(x.R) || !Number.isFinite(t) || Date.parse(x.at) < since || (side && x.side !== side)) continue;
    if (roots.length && !roots.includes(String(x.root || '').toUpperCase())) continue;
    if (busy[x.side] && t < busy[x.side]) continue;
    busy[x.side] = Date.parse(x.exitTime);
    out.push(x.R);
  }
  return out;
}

function lessonRecord(entry, { reviews = [], shadow = [], now = null, from = null } = {}) {
  const since = Math.max(entryTime(entry), Number.isFinite(timeOf(from)) ? timeOf(from) : -Infinity);
  const until = Number.isFinite(timeOf(now)) ? timeOf(now) : -Infinity; // no clock: nothing counts
  const side = lessonSide(entry);
  const setup = tagValue(entry, 'setup');
  // Its symbol tags (a contract root, as the journaling rule tags it: "MNQ"), never a kind:value tag or a word.
  const roots = (Array.isArray(entry && entry.tags) ? entry.tags : []).map(String).filter(t => /^[A-Z][A-Z0-9]{0,7}$/.test(t));
  const rOf = r => { const v = Number(tagValue(r, 'r')); return Number.isFinite(v) ? v : reviewResult(r) === 'win' ? 1 : reviewResult(r) === 'loss' ? -1 : 0; };
  const inScope = r => entryTime(r) >= since && entryTime(r) <= until;
  const taken = (reviews || []).filter(r => inScope(r) && (!setup || tagValue(r, 'setup') === setup) && (!side || sideIn(text(r)) === side)).map(rOf);
  const plans = tally(plansSince((shadow || []).filter(x => Date.parse(x.exitTime) <= until), since, side, roots));
  const dir = isBroad(entry) ? null : lessonDirection(entry);
  const backed = dir === 'against' ? plans.R <= 0 : plans.R > 0;
  const status = plans.n < MIN_PLANS ? 'provisional'
    : !dir ? 'no verdict' : backed ? `supported by n=${plans.n}` : `contradicted by n=${plans.n} since ${lessonDay(entry)}`;
  return { taken: tally(taken), shadow: plans, side, status };
}

const recText = (label, t) => `${label} n=${t.n}${t.n ? `, ${t.wins}W/${t.losses}L, ${t.R >= 0 ? '+' : ''}${t.R}R` : ''}`;

function adviceText(entry, record = null) {
  const rec = record || lessonRecord(entry);
  const broad = isBroad(entry) ? '; broad: names no condition the bars can check' : '';
  const plans = `all composed ${rec.side ? `${rec.side}s` : 'plans'} since`;
  return `lesson from ${lessonDay(entry) || 'an unknown day'} (${recText('taken since', rec.taken)}; ${recText(plans, rec.shadow)}; ${rec.status}${broad}): advice, weigh it: ${text(entry)}`;
}

module.exports = { lessonDay, scopedLessons, lessonSide, lessonDirection, isBroad, lessonRecord, adviceText };
