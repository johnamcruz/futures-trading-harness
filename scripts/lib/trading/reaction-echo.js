'use strict';

/**
 * compose_check's reaction echo (the owner, 2026-10-31: "Loaded and used as context especially the candle reading").
 * Next to each composed rejected, broke or swept read, the record's reply states the briefing's verified reaction for
 * that candle at that level (candle-reaction.js, on m3.candles.<tf>.relations): its label, its side (the candle's,
 * never the bias's) and who took control, or for conflicting, stall and plain what candle-reading says it means. It
 * puts the reaction in the head's context at the moment it decides. Informational only: it changes no OK or NOT OK and
 * refuses nothing (a read, never a filter). When the head's own words (`why`) name another reaction than the briefing's,
 * a MISMATCH line says so, informational too.
 *
 *   MEANING                     each reaction's text, after a high (the mirror after a low: `low`)
 *   echoOf(read, briefing)      { text, reaction } for one read, or null (not a rejected, broke or swept read; no candle)
 *   echoLines(reads, briefing)  the reply's lines ([] when none applies)
 */

const { REACTIONS } = require('./candle-reaction');

// What each reaction means, as candle-reading says it: [after a high, after a low] for the side-bearing ones.
const MEANING = Object.freeze({
  'confirmed rejection': ['sellers took over, confirmed', 'buyers took over, confirmed'],
  breakout: ['buyers in control: a breakout attempt, not a sweep', 'sellers in control: a breakout attempt, not a sweep'],
  'engulfing rejection': ['sellers took control', 'buyers took control'],
  'long-wick rejection': ['sellers rejected higher prices', 'buyers rejected lower prices'],
  conflicting: 'mixed: needs other confirmation (the count, or the next candle)',
  stall: 'stalled: the next candle decides',
  plain: 'not a rejection: no one took control, weak context only; needs other confirmation',
  unknown: 'unknown: the briefing can\'t say; never read it by eye',
});

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const m3Of = b => (isObj(b) && isObj(b.sections) && isObj(b.sections.m3) && isObj(b.sections.m3.data) ? b.sections.m3.data : null);

/**
 * The side of a reaction at a level the candle met: a rejection's is the way it closed back (`dir`: down, a rejection of
 * a high, the short side); a break's, its close beyond (up: long). After a high or a low: which way the attempt went.
 */
function sideOf(rel, dir, reaction) {
  if (!dir) return { side: null, high: null };
  // A rejection closed back down (or a break down): the attempt was through a level from below for a rejection.
  const short = dir === 'down';
  // A breakout's control is the breaking side; a rejection's the other side of the attempt: after a high for a
  // rejection closing back down, after a low for one closing back up. A break up came from below (a high's breakout).
  const high = rel === 'rejected' ? short : !short;
  return { side: short ? 'short' : 'long', high: reaction === 'breakout' ? !short : high };
}

/** The briefing's relation entries for this level on this frame, the matching one first. */
function relationAt(m3, tf, level, rel) {
  const { levelName } = require('./composed-reads');
  const c = isObj(m3) && isObj(m3.candles) ? m3.candles[tf] : null;
  const list = isObj(c) && Array.isArray(c.relations) ? c.relations.filter(x => isObj(x) && levelName(x.name) === level) : [];
  return list.find(x => !rel || x.rel === rel) || list[0] || null;
}

/** For a sweep read: the candle (setup frame first) that met the swept level as a rejection, with its frame. */
function sweepRelation(m3, level) {
  for (const tf of ['15m', '1h', '4h', '5m', '3m']) {
    const r = relationAt(m3, tf, level, 'rejected');
    if (r) return { tf, r };
  }
  return null;
}

function text(reaction, side, high) {
  const m = MEANING[reaction] || MEANING.unknown;
  const meaning = Array.isArray(m) ? m[high ? 0 : 1] : m;
  return `${reaction}${side && Array.isArray(m) ? ` (${side} side: ${meaning})` : ` (${meaning})`}`;
}

/** One read's echo: { text, reaction, said } or null. `said`: a reaction the read's own words name. */
function echoOf(read, briefing) {
  const { parseRead } = require('./composed-reads');
  const r = isObj(read) ? read : { read };
  let p;
  try { p = parseRead(String(r.read || '')); } catch (_err) { return null; }
  const m3 = m3Of(briefing);
  if (!m3 || !p) return null;
  let tf;
  let rel;
  if (p.kind === 'relation' && (p.rel === 'rejected' || p.rel === 'broke')) { tf = p.tf; rel = relationAt(m3, p.tf, p.level, p.rel); } else if (p.kind === 'swept') {
    const s = sweepRelation(m3, p.level);
    if (s) { tf = s.tf; rel = s.r; }
  } else return null;
  const reaction = rel && REACTIONS.includes(rel.reaction) ? rel.reaction : 'unknown';
  const { side, high } = rel ? sideOf(rel.rel, rel.dir, reaction) : { side: null, high: null };
  const said = REACTIONS.filter(x => x !== 'unknown').find(x => new RegExp(`\\b${x.replace('-', '[- ]')}\\b`, 'i').test(String(r.why || ''))) || null;
  const where = rel ? `${tf} ${rel.rel}${rel.dir ? ` ${rel.dir}` : ''} ${rel.name}` : `${p.form}`;
  return { reaction, said, text: `- REACTION ${where}: ${text(reaction, side, high)}` };
}

/** The reply's lines for these reads: each echo, and a MISMATCH line where the read's words name another reaction. */
function echoLines(reads, briefing) {
  const out = [];
  for (const read of Array.isArray(reads) ? reads : []) {
    const e = echoOf(read, briefing);
    if (!e) continue;
    out.push(e.text);
    if (e.said && e.said !== e.reaction) out.push(`- MISMATCH: your read says ${e.said}; the briefing's reaction is ${e.reaction} (a read, never a veto: read it with candle-reading)`);
  }
  return out;
}

module.exports = { MEANING, sideOf, echoOf, echoLines };
