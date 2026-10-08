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
 *   lesson    a lesson the reviewer wrote, weighted by the trades it cites
 *
 * Confidence runs 0.3 (first signs) to 0.9 (strong evidence), as ECC's
 * instincts do; anything under 0.3 isn't shown. The digest is computed from
 * the journal each time (no state to drift), shown in the session-start
 * briefing and every autonomous cycle prompt, and printed by
 * scripts/lessons.js. Instincts are notes from the model's own past, not
 * rules: the gate and the strategies still decide.
 */

const { hasTag, reviewResult, entryTime } = require('./journal');

const MIN_SETUP_TRADES = 3;
const RECENT_REVIEWS = 30;

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

const confidenceFor = n => Math.min(0.9, 0.3 + 0.05 * Math.max(0, n - 1));
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** The instincts in `entries` (the journal, oldest first): [{ kind, key, text, confidence, evidence }], strongest first. */
function instincts(entries) {
  const reviews = entries.filter(e => e.kind === 'review' && reviewResult(e) !== null && !hasTag(e, 'paper'));
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

  // The reviewer's lessons, weighted by the trades they cite ("over 6 trades").
  for (const l of entries.filter(e => e.kind === 'lesson').slice(-20)) {
    const n = Number((/(\d+)\s+(?:trades?|reviews?)/i.exec(String(l.text || '')) || [])[1] || 1);
    out.push({
      kind: 'lesson', key: (l.tags || []).join(' ') || 'lesson',
      text: String(l.text || '').replace(/\s+/g, ' ').slice(0, 200),
      confidence: round(confidenceFor(n)), evidence: n, at: new Date(entryTime(l)).toISOString(),
    });
  }

  return out.filter(x => x.confidence >= 0.3).sort((a, b) => b.confidence - a.confidence || b.evidence - a.evidence);
}

/** The top `n` instincts as lines for a prompt or briefing. */
function digest(entries, n = 6) {
  return instincts(entries).slice(0, n).map(x => `(${x.confidence.toFixed(1)}) ${x.text}`);
}

module.exports = { instincts, digest, reviewR, confidenceFor };
