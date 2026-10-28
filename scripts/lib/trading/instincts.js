'use strict';

/**
 * Learning from mistakes, the way ECC's continuous learning does it: observe
 * what happened, turn repeated patterns into small "instincts" with a
 * confidence that grows with evidence, and put the strongest in front of the
 * model before it decides. Here the evidence is the journal's reviews (their
 * result, setup, regime, mistake, and R tags) and lessons:
 *
 *   setup     a setup in a regime with enough trades: its expectancy and win
 *             rate, favour or avoid ("orb in trend-up: 9 trades, E +0.41R")
 *   mistake   a mistake:* tag that keeps coming back in recent reviews
 *   lesson    a lesson the reviewer wrote, weighted by the trades it cites: only the run's own (written by `now`,
 *             since `from`: lesson-advice.js), shown as advice with its date and its record since (the trades taken,
 *             the composed plans walked forward: `shadow`, lesson-shadow.js); without a `now`, none
 *
 * Confidence runs 0.3 (first signs) to 0.9 (strong evidence), as ECC's
 * instincts do; anything under 0.3 isn't shown. The digest is computed from
 * the journal each time (no state to drift), shown in the session-start
 * briefing and every autonomous cycle prompt, and printed by
 * scripts/lessons.js. Instincts are notes from the model's own past, not
 * rules: the gate and the strategies still decide.
 */

const { hasTag, reviewResult, entryTime, onePerOrder, orderKey } = require('./journal');
const { scopedLessons, lessonRecord, adviceText } = require('./lesson-advice');

const MIN_SETUP_TRADES = require('../tunables').runner().prompt.instinctsMinSetupTrades; // config/runner.json
const RECENT_REVIEWS = require('../tunables').runner().prompt.instinctsRecentReviews;

const tagValue = (e, prefix) => {
  const t = (Array.isArray(e.tags) ? e.tags : []).find(x => String(x).toLowerCase().startsWith(`${prefix}:`));
  return t ? String(t).slice(prefix.length + 1) : null;
};

/** A review's R: the r:<value> tag, else "R = -1.11" / "R -1.11" in its text. */
function reviewR(e) {
  const tag = tagValue(e, 'r');
  if (tag !== null && Number.isFinite(Number(tag))) return Number(tag);
  const m = /\bR\s*[=:]?\s*([+-]?\d+(?:\.\d+)?)\b/.exec(String(e.text || ''));
  return m ? Number(m[1]) : null;
}

/**
 * The live reviews with a result (not paper), one per order (journal.js onePerOrder: the worst), each with the tags of the grade reviews that name its order
 * (a review with an orderId and no result: the trade-reviewer's grade of a trade the runner reviewed, runner-reviews.js)
 * added: their mistake:, regime: and other tags count with the trade (never a second result: or r:).
 */
function graded(entries) {
  const id = orderKey; // its order, on its trading day
  const grades = new Map();
  const live = entries.filter(e => e.kind === 'review' && !hasTag(e, 'paper'));
  const kept = new Set(onePerOrder(live));
  // A grade review, or another result review of the same order (its tags join the one that counts, the worst; its
  // result and r: count nothing).
  for (const g of live.filter(e => id(e) !== null && (reviewResult(e) === null || !kept.has(e)))) {
    grades.set(id(g), [...(grades.get(id(g)) || []), ...(Array.isArray(g.tags) ? g.tags : []).filter(t => !/^(result|r|by):/i.test(String(t)))]);
  }
  return live.filter(e => reviewResult(e) !== null && kept.has(e)).map(r => {
    const more = id(r) !== null ? grades.get(id(r)) : null;
    return more && more.length ? { ...r, tags: [...new Set([...(Array.isArray(r.tags) ? r.tags : []), ...more])] } : r;
  });
}

const confidenceFor = n => Math.min(0.9, 0.3 + 0.05 * Math.max(0, n - 1));
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * The instincts in `entries` (the journal, oldest first): [{ kind, key, text, confidence, evidence }], strongest first.
 * `now`, `from`, `shadow`: the lessons in scope and their record (lesson-advice.js); without a `now`, no lesson.
 */
function instincts(entries, { now = null, from = null, shadow = [] } = {}) {
  const reviews = graded(entries);
  const out = [];

  // Setups by regime (and overall).
  const groups = new Map();
  for (const r of reviews) {
    const setup = tagValue(r, 'setup');
    if (!setup) continue;
    for (const key of [`${setup}|${tagValue(r, 'regime') || 'any'}`, `${setup}|all`]) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
  }
  for (const [key, list] of groups) {
    const [setup, regime] = key.split('|');
    const rs = list.map(reviewR).filter(Number.isFinite);
    if (list.length < MIN_SETUP_TRADES || regime === 'any') continue;
    const wins = list.filter(r => reviewResult(r) === 'win').length;
    const e = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
    const verdict = e === null ? (wins / list.length >= 0.5 ? 'favour' : 'be careful') : e > 0.1 ? 'favour' : e < -0.1 ? 'avoid' : 'no edge yet';
    out.push({
      kind: 'setup', key: `setup:${setup}${regime === 'all' ? '' : ` regime:${regime}`}`,
      text: `${setup}${regime === 'all' ? '' : ` in ${regime}`}: ${list.length} trades, win ${Math.round((wins / list.length) * 100)}%${e === null ? '' : `, E ${e >= 0 ? '+' : ''}${round(e)}R`} -> ${verdict}`,
      confidence: round(confidenceFor(list.length) * (regime === 'all' ? 0.9 : 1)), evidence: list.length,
    });
  }

  // Mistakes that keep coming back in recent reviews.
  const recent = reviews.slice(-RECENT_REVIEWS);
  const mistakes = new Map();
  for (const r of recent) {
    for (const t of (r.tags || []).filter(x => String(x).toLowerCase().startsWith('mistake:'))) {
      if (!mistakes.has(t)) mistakes.set(t, []);
      mistakes.get(t).push(r);
    }
  }
  for (const [tag, list] of mistakes) {
    const last = list[list.length - 1];
    out.push({
      kind: 'mistake', key: tag,
      text: `${tag} in ${list.length} of the last ${recent.length} reviewed trades; last: ${String(last.text || '').replace(/\s+/g, ' ').slice(0, 140)}`,
      confidence: round(confidenceFor(list.length + 1)), evidence: list.length,
    });
  }

  // The run's own lessons with their record (lesson-advice.js), weighted by the trades they cite ("over 6 trades").
  for (const l of scopedLessons(entries, { now, from }).slice(-20)) {
    const n = Number((/(\d+)\s+(?:trades?|reviews?)/i.exec(String(l.text || '')) || [])[1] || 1);
    out.push({
      kind: 'lesson', key: (l.tags || []).join(' ') || 'lesson',
      text: adviceText({ ...l, text: String(l.text || '').replace(/\s+/g, ' ').slice(0, 200) }, lessonRecord(l, { reviews, shadow })),
      confidence: round(confidenceFor(n)), evidence: n, at: new Date(entryTime(l)).toISOString(),
    });
  }

  return out.filter(x => x.confidence >= 0.3).sort((a, b) => b.confidence - a.confidence || b.evidence - a.evidence);
}

/**
 * The last `n` reviewed trades, oldest first, one line each: what was traded,
 * how it ended, and what went wrong ("orb long loss -1.11R [mistake:chased]").
 */
function recentTrades(entries, n = 10) {
  return graded(entries).slice(-n).map(r => {
    const dir = (/\b(long|short)\b/i.exec(String(r.text || '')) || [])[1];
    const rr = reviewR(r);
    const mistakes = (r.tags || []).filter(t => String(t).toLowerCase().startsWith('mistake:'));
    return `${tagValue(r, 'setup') || '?'}${dir ? ` ${dir.toLowerCase()}` : ''} ${reviewResult(r)}${rr === null ? '' : ` ${rr >= 0 ? '+' : ''}${rr}R`}${tagValue(r, 'regime') ? ` in ${tagValue(r, 'regime')}` : ''}${mistakes.length ? ` [${mistakes.join(', ')}]` : ''}`;
  });
}

/** The form of the last `n` reviewed trades: record, expectancy, and the mistakes that repeat. */
function recentForm(entries, n = 10) {
  const list = graded(entries).slice(-n);
  if (!list.length) return null;
  const wins = list.filter(r => reviewResult(r) === 'win').length;
  const losses = list.filter(r => reviewResult(r) === 'loss').length;
  const rs = list.map(reviewR).filter(Number.isFinite);
  const counts = {};
  for (const r of list) for (const t of (r.tags || []).filter(x => String(x).toLowerCase().startsWith('mistake:'))) counts[t] = (counts[t] || 0) + 1;
  const repeats = Object.entries(counts).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t} x${c}`);
  return `last ${list.length} trades: ${wins}W/${losses}L${rs.length ? `, E ${(rs.reduce((a, b) => a + b, 0) / rs.length) >= 0 ? '+' : ''}${round(rs.reduce((a, b) => a + b, 0) / rs.length)}R` : ''}${repeats.length ? `; repeating: ${repeats.join(', ')}` : '; no repeated mistake'}`;
}

/** The top `n` instincts as lines for a prompt or briefing, the recent form first. */
/**
 * The top `n` instincts as lines, the recent form first. Options for the cycle
 * prompt, which shows each fact once: `kinds` keeps only those kinds (the
 * prompt: mistakes and lessons; a strategy's live results are in its track
 * record), `form: false` leaves out the form line (the prompt's reviewed-trades
 * line carries it).
 */
function digest(entries, n = 6, { kinds = null, form = true, now = null, from = null, shadow = [] } = {}) {
  const f = form ? recentForm(entries) : null;
  const list = instincts(entries, { now, from, shadow }).filter(x => !kinds || kinds.includes(x.kind));
  return [...(f ? [`(form) ${f}`] : []), ...list.slice(0, n).map(x => `(${x.confidence.toFixed(1)}) ${x.text}`)];
}

/** The record of the last `n` reviewed trades: "4W/6L, E -0.12R", or null. */
function formSummary(entries, n = 10) {
  const list = graded(entries).slice(-n);
  if (!list.length) return null;
  const rs = list.map(reviewR).filter(Number.isFinite);
  const e = rs.length ? round(rs.reduce((a, b) => a + b, 0) / rs.length) : null;
  return `${list.filter(r => reviewResult(r) === 'win').length}W/${list.filter(r => reviewResult(r) === 'loss').length}L${e === null ? '' : `, E ${e >= 0 ? '+' : ''}${e}R`}`;
}

module.exports = { instincts, digest, formSummary, recentTrades, recentForm, reviewR, confidenceFor, graded };
