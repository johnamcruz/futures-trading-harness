'use strict';

/**
 * Journaled lessons are advice with their record, never rules (rules/trading/journaling.md defines it).
 *
 * Scope: a lesson counts only in its own run: written at or before `now` (a replay's clock: never a later run's or the
 * live account's lesson in the same journal). It persists across a continuous combine's attempts (the lesson from a
 * blow is the one to learn from). Fail safe: an undated lesson, or a `now` that isn't a time, is never shown.
 *
 * Its record, so it can't seal itself: since its date and up to `now`, the trades taken on its setup (the journal's
 * graded reviews, on its side when the lesson names one) and the composed plans walked forward model-free
 * (lesson-shadow.js), taken or not, on its side and its symbol: every such plan, not only those its condition names
 * (the shadow lines carry no bar facts), and labelled so. Its verdict: under config/runner.json prompt.lessonMinPlans
 * plans, provisional; past it, only a lesson with a side and a direction and NO condition (its claim is the population
 * counted) is judged: the plans' summed R supports or contradicts it ("contradicted by n=... since <date>"). A
 * conditional lesson shows the numbers labelled "condition unchecked", no verdict; so does one of no clear direction.
 * Direction reads only explicit words (against: skip, avoid, stand aside, pass on, don't take, no longs/shorts, never
 * long/short; for: favour, prefer, take); "stop", "failed", "lost" are facts, not directions. A lesson that names no
 * condition the bars can check (a timeframe with a briefing fact: "15m EMA20", "3m trend up"; a session time window:
 * "before 09:45 ET", "first 15 minutes") is flagged broad.
 *
 *   lessonDay(entry)                          the calendar date (YYYY-MM-DD, ET) it was written on, or null (undated)
 *   scopedLessons(entries, { now })           the lessons in scope, oldest first
 *   sidesIn(text)                             the sides ('long'/'short') a text names, in order of first mention
 *   lessonSide(entry)                         'long' | 'short' | null (both or neither named)
 *   isBroad(entry)                            true when it names no condition the bars can check
 *   lessonDirection(entry)                    'against' | 'for' | null
 *   lessonRecord(entry, { reviews, shadow, now })  { taken: { n, wins, losses, R }, shadow: { n, ... }, status }
 *   adviceText(entry, record)                 'lesson from <day> (<record>; <status>[; broad]): advice, weigh it: <text>'
 */

const { zonedParts, MARKET_TZ } = require('./clock');
const { entryTime, reviewResult } = require('./journal');
const { specFor } = require('./contracts');

const MIN_PLANS = require('../tunables').runner().prompt.lessonMinPlans; // config/runner.json

const isLesson = e => Boolean(e) && e.kind === 'lesson';
const timeOf = x => (x instanceof Date ? x.getTime() : Number.isFinite(x) ? x : NaN);
const text = e => String((e && e.text) || '').replace(/\s+/g, ' ').trim();
const tagValue = (e, prefix) => {
  const t = (Array.isArray(e && e.tags) ? e.tags : []).find(x => String(x).toLowerCase().startsWith(`${prefix}:`));
  return t ? String(t).slice(prefix.length + 1) : null;
};
const round = x => Math.round(x * 100) / 100;

// The calendar date in ET when it was written (not the trading day, which turns in the evening).
function lessonDay(entry) {
  const t = entryTime(entry);
  if (!Number.isFinite(t)) return null;
  const p = zonedParts(new Date(t), MARKET_TZ);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function scopedLessons(entries, { now = null } = {}) {
  const at = timeOf(now);
  if (!Array.isArray(entries) || !Number.isFinite(at)) return [];
  return entries.filter(e => isLesson(e) && Number.isFinite(entryTime(e)) && entryTime(e) <= at);
}

/** The sides a text names, in order of first mention (the one side regex: recentTrades reads the first, a lesson both). */
const sidesIn = s => [...new Set([...String(s || '').matchAll(/\b(long|short)s?\b/gi)].map(m => m[1].toLowerCase()))];
function sideIn(s) {
  const sides = sidesIn(s);
  return sides.length === 1 ? sides[0] : null;
}
const lessonSide = entry => sideIn(text(entry));

// A condition the bars can check: a timeframe with a briefing fact about it, at most four words apart ("15m EMA20",
// "3m trend up", "15m not in a fresh CHoCH down", "15m close below"); a timeframe or a word alone is no condition.
const GAP = '(?:the|its|a|not|fresh|in|is|was|below|above|at)';
const CONDITION = new RegExp(`\\b(?:\\d{1,2}m|[14]h)\\b[\\s:,-]+(?:${GAP}\\s+){0,4}(?:trend|choch|bos|ema\\d+|vwap|supertrend|fvg|swing|structure|close\\s+(?:above|below))\\b`, 'i');
// A session time window is a condition too: "before 09:45 ET", "after 14:00", "the first 15 minutes".
const TIME_WINDOW = /\b(?:before|after|until|from)\s+\d{1,2}:\d{2}\b|\b\d{1,2}:\d{2}\s*(?:-|to)\s*\d{1,2}:\d{2}\b|\bfirst\s+\d+\s*(?:min(?:ute)?s?)\b/i;
const isBroad = entry => !CONDITION.test(text(entry)) && !TIME_WINDOW.test(text(entry));
// Any further clause narrows the claim past "all composed plans on its side": its verdict can't be read from them.
const CLAUSE = /\b(?:when|while|with|without|after|before|if|unless|during|above|below|under|until|into|once|only|except|on the|at the|in a)\b/i;
const isUnconditional = entry => isBroad(entry) && !CLAUSE.test(text(entry));

// Against a setup, by explicit words only: "skip", "avoid", "stand aside", "pass on", "don't take", "no longs", "never
// long"; for one: "favour", "prefer", "take" (not after a negation). "stop", "failed", "lost" are facts about trades,
// not directions: anything else gives no direction. A negated avoid-word ("don't skip") gives none either.
const NEG = "(?:don'?t|do not|never|no|rarely)";
const AVOID = '(?:skip|avoid|stand aside|pass on)';
const AGAINST = new RegExp(`\\b(?:${AVOID}|${NEG}(?:\\s+\\w+)?\\s+(?:tak(?:e|es|ing)|favou?r|prefer)\\w*|${NEG}\\s+(?:longs?|shorts?)|never\\s+(?:go\\s+)?(?:long|short))\\b`, 'i');
const NEGATED = new RegExp(`\\b${NEG}\\s+(?:\\w+\\s+)?${AVOID}\\b`, 'i');
const FOR = new RegExp(`(?<!${NEG}\\s(?:\\w+\\s)?)\\b(?:favou?r\\w*|prefer\\w*|tak(?:e|es|ing))\\b`, 'i');
function lessonDirection(entry) {
  if (NEGATED.test(text(entry))) return null;
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
    if (roots.length && !roots.includes(String(x.root || ''))) continue;
    if (busy[x.side] && t < busy[x.side]) continue;
    busy[x.side] = Date.parse(x.exitTime);
    out.push(x.R);
  }
  return out;
}

function lessonRecord(entry, { reviews = [], shadow = [], now = null } = {}) {
  const since = entryTime(entry);
  const until = Number.isFinite(timeOf(now)) ? timeOf(now) : -Infinity; // no clock: nothing counts
  const side = lessonSide(entry);
  const setup = tagValue(entry, 'setup');
  // Its symbol tags (as the journaling rule tags it: "MNQ"): only a tag that names a contract root (contracts.js) or a
  // symbol the plans are of, so a tag like "ORB" or "RTH" never filters every plan out.
  const known = new Set((shadow || []).map(x => String(x.root || '')));
  const roots = (Array.isArray(entry && entry.tags) ? entry.tags : []).map(String).filter(t => known.has(t) || (t === t.toUpperCase() && specFor(t)));
  const rOf = r => { const v = Number(tagValue(r, 'r')); return Number.isFinite(v) ? v : reviewResult(r) === 'win' ? 1 : reviewResult(r) === 'loss' ? -1 : 0; };
  const inScope = r => entryTime(r) >= since && entryTime(r) <= until;
  const taken = (reviews || []).filter(r => inScope(r) && (!setup || tagValue(r, 'setup') === setup) && (!side || sideIn(text(r)) === side)).map(rOf);
  const plans = tally(plansSince((shadow || []).filter(x => Date.parse(x.exitTime) <= until), since, side, roots));
  // A verdict only where the counted population is the lesson's claim: a side, a direction, and no condition.
  const dir = side && isUnconditional(entry) ? lessonDirection(entry) : null;
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
  return `lesson from ${lessonDay(entry) || 'an unknown day'} (${recText('taken since', rec.taken)}; ${recText(plans, rec.shadow)}${isUnconditional(entry) ? '' : ', condition unchecked'}; ${rec.status}${broad}): advice, weigh it: ${text(entry)}`;
}

module.exports = { lessonDay, scopedLessons, sidesIn, lessonSide, lessonDirection, isBroad, lessonRecord, adviceText };
