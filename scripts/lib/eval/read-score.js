'use strict';

/**
 * The read scorer: whether a model answer NAMES a market-state read, from small closed regex families (data, counted;
 * never a pass or fail on the decision: the State line is a fact to weigh, not a rule). Context: `labels`, each frame's
 * trend label ('up' | 'down' | 'range') as the moment's briefing shows it (labelsOf(states)), and `line`, the State line
 * the new arm was shown (for echoesState).
 *
 *   namesConflict(text, { labels })   any of:
 *     transition    "transition" said of the market, not of the regime's own label ("Regime: transition", "regime is
 *                   transition"); not negated ("no transition")
 *     disagreement  disagree / contradict / conflicts with / a conflict / at odds, in a sentence naming a label, trend,
 *                   frame, structure, price or a frame (4h, 1h, 15m); not negated ("no conflict", "nothing contradicts");
 *                   the candle reaction "conflicting" is not one
 *     opposing fact per frame labelled up or down, a fact the other way within a few words of the frame: its break
 *                   (CHoCH or BOS that way), its candle (that side's engulfing, a displacement that way, closed above
 *                   its high / below its low). Not when needed, absent or negated: before it "no", "without", "need(s)",
 *                   "would need", "require(s)", "wait for", "until", "absent"; between the frame and the fact "no", "not",
 *                   "without", "need"; after it "absent", "none", "not present", "is not met", "needed", "is missing",
 *                   "does not exist"
 *   calledLabelStale(text)            a label, trend or frame said to lag, be stale or behind price, or not to have
 *                   flipped / turned / caught up yet; not "not stale", "no longer lagging"
 *   echoesState(text, line)           the answer copies a DISAGREE frame's named fact, or the line's fixed phrase
 *                   "label and price disagree", verbatim (a copy is not a read: counted apart)
 *   readOf(text, { labels, line })    -> { namesConflict, calledLabelStale, echoesState, decision }  decision: the
 *                   CYCLE RESULT outcome (moment-probe outcomeOf; executed counts as planned), or null
 *   FRAMES                            the frames read, top-down: 4h, 1h, 15m
 */

const { outcomeOf, enters } = require('./moment-probe');

const FRAMES = ['4h', '1h', '15m'];
const SENTENCE = /[^.\n]+/g;

const NEG_BEFORE = /(?:\bno|\bnot|\bnothing|\bwithout|\bneeds?|\bwould need|\brequires?|\bwait(?:ing)? for|\buntil|\babsent|\bnever)\s+(?:a\s+|an\s+|the\s+|any\s+)?$/i;
const NEG_AFTER = /^[^.;\n]{0,30}\b(?:absent|none|not present|is not met|needed|is missing|does not exist|doesn't exist)\b/i;
const NEG_GAP = /\b(?:no|not|without|needs?|never)\b/i;

/** Matches of `re` in text whose surroundings do not negate them (`gapOf(m)`: the part between frame and fact, if any). */
function unnegated(text, re, gapOf = () => '') {
  for (const m of text.matchAll(re)) {
    const before = text.slice(0, m.index).split(/[.;\n]/).at(-1);
    const after = text.slice(m.index + m[0].length);
    if (NEG_BEFORE.test(before) || NEG_AFTER.test(after) || NEG_GAP.test(gapOf(m))) continue;
    return true;
  }
  return false;
}

/** The facts against a label: each pattern's first group is the frame-to-fact gap. */
function opposing(tf, label) {
  const up = label === 'down'; // the other way
  const way = up ? 'up' : 'down';
  const f = `\\b${tf}\\b([^.\\n;]{0,25}?)`;
  return [
    new RegExp(`${f}\\b(?:choch|bos)\\s+${way}\\b`, 'gi'),
    new RegExp(`${f}\\b${up ? 'bullish' : 'bearish'} engulfing\\b`, 'gi'),
    new RegExp(`${f}\\bdisplacement\\s+${way}\\b`, 'gi'),
    new RegExp(`\\b${tf}\\b([^.\\n;]{0,40}?)\\bclosed ${up ? 'above its high' : 'below its low'}`, 'gi'),
  ];
}

const TRANSITION = /\btransition(?:al)?\b/gi;
const REGIME_BEFORE = /\bregime\b[^.\n]{0,20}$/i;
const DISAGREE = /\b(?:disagree(?:s|ment)?|contradict(?:s|ed|ion|ing)?|conflicts? with|a conflict|at odds)\b/gi;
const STATE_WORD = /\b(?:labels?|trends?|frames?|structure|price|4h|1h|15m)\b/i;

function namesConflict(text, { labels = {} } = {}) {
  const t = String(text || '');
  for (const m of t.matchAll(TRANSITION)) {
    const before = t.slice(0, m.index);
    if (REGIME_BEFORE.test(before) || NEG_BEFORE.test(before.split(/[.;\n]/).at(-1))) continue;
    return true;
  }
  for (const s of t.match(SENTENCE) || []) if (STATE_WORD.test(s) && unnegated(s, DISAGREE)) return true;
  for (const tf of FRAMES) {
    if (labels[tf] !== 'up' && labels[tf] !== 'down') continue;
    if (opposing(tf, labels[tf]).some(re => unnegated(t, re, m => m[1] || ''))) return true;
  }
  return false;
}

const STALE = /\b(?:label|trend|4h|1h|15m)\b[^.\n]{0,40}?\b(lags?|lagging|stale|behind (?:price|the move)|(?:has not|hasn't|not yet|yet to|still to) (?:flip(?:ped)?|turn(?:ed)?|catch up|caught up|change[d]?))\b/gi;
const STALE_NEG = /\b(?:not|isn't|no longer|never)\s+$/i;

function calledLabelStale(text) {
  const t = String(text || '');
  for (const m of t.matchAll(STALE)) {
    const at = m.index + m[0].length - m[1].length;
    if (/^(?:lag|stale|behind)/i.test(m[1]) && STALE_NEG.test(t.slice(m.index, at))) continue;
    return true;
  }
  return false;
}

const PHRASE = 'label and price disagree';

/** The named facts of the line's DISAGREE frames ("DISAGREE - fact; fact -> ..."). */
const factsOf = line => [...String(line || '').matchAll(/DISAGREE - (.+?) -> /g)].flatMap(m => m[1].split('; '));

function echoesState(text, line) {
  const facts = factsOf(line);
  if (!facts.length) return false;
  const t = String(text || '');
  return t.includes(PHRASE) || facts.some(f => t.includes(f));
}

function readOf(text, { labels = {}, line = null } = {}) {
  const o = outcomeOf(text);
  return { namesConflict: namesConflict(text, { labels }), calledLabelStale: calledLabelStale(text), echoesState: echoesState(text, line), decision: o ? (enters(o) ? 'planned' : o) : null };
}

module.exports = { FRAMES, namesConflict, calledLabelStale, echoesState, readOf };
