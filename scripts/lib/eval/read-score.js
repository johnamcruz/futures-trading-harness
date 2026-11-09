'use strict';

/**
 * The read scorer: whether a model answer NAMES a market-state read, from small closed regex families (data, counted;
 * never a pass or fail on the decision: the State line is a fact to weigh, not a rule). Context: `labels`, each frame's
 * trend label ('up' | 'down' | 'range') as the moment's briefing shows it, and `line`, the State line this arm was shown
 * (null for the recorded prompt).
 *
 *   opposingFact(text, { labels })  a fact against a frame labelled up or down, the frame named next to it: its break
 *                   (CHoCH or BOS the other way), its candle (that side's engulfing, a displacement that way, closed
 *                   above its high / below its low); "1h ... CHoCH up" (within a few words, no other frame named in
 *                   between) or "CHoCH up on the 1h". Not when negated, needed or absent ("no", "without", "need(s)",
 *                   "would need", "require(s)", "wait / watch / look for", "only after", "until", "absent" before it;
 *                   "no", "not", any n't, "without", "need", "lack(s)", "missing" between; "absent", "none", "not
 *                   present", "is not met", "needed", "(still) required", "is missing", "does not exist" after), nor
 *                   conditional ("would", "could", "might", "should", "if", "whether", "unless" in its clause before it;
 *                   those and "may" between; "would", "could", "might" just after), nor asked ("... CHoCH up? Not
 *                   printed"). The vocabulary is closed: the briefing's fact names only ("engulfed bullishly" is a miss)
 *   conflictWords(text)             "transition" said of the market (not the regime's label, "Regime: transition"; not the
 *                   session's: "morning transition", "transition period", "transition into lunch"; nor "a transition
 *                   regime"), or disagree /
 *                   contradict / conflicts with / a conflict / at odds in a sentence naming a label, trend, frame,
 *                   structure, "label and price" or a frame (4h, 1h, 15m); the same negation, conditional and question
 *                   guards; the candle reaction "conflicting" is not one
 *   namesConflict(text, ctx)        opposingFact or conflictWords (the raw read, either way)
 *   calledLabelStale(text)          a label, trend or frame said to lag, be stale or behind price, not to have flipped
 *                   / turned YET, or not to have caught up; not negated in its clause ("not stale", "would not call
 *                   it stale", "no longer lagging", "far from stale") or denied later in its sentence ("looks lagging
 *                   but I would not call it stale"), not conditional, not "a lagging indicator", nor "has not flipped"
 *                   without "yet" (the trend intact)
 *   echoesState(text, line)         the answer copies a DISAGREE frame's named fact, or the line's fixed phrase
 *                   "label and price disagree", verbatim
 *   readOf(text, { labels, line })  -> { namesConflict, opposingFact, conflictWords, ownConflict, calledLabelStale,
 *                   echoesState, decision }. opposingFact and conflictWords are read with the line's copied text taken
 *                   out; ownConflict is the conflict in the model's own words: an opposingFact, or conflictWords when
 *                   no State line was shown (with one shown, the words alone may be the line's: never own words).
 *                   decision: the CYCLE RESULT outcome (moment-probe outcomeOf; executed counts as planned), or null
 *   FRAMES                          the frames read, top-down: 4h, 1h, 15m
 *
 * Further guards on every match: an absence word earlier in its clause ("nothing", "none", "nor", "neither", "no
 * sign / evidence of"), a frame named right after a fact owns it ("..., a bearish engulfing on the 15m"), and a past fact
 * ("was ... ago / yesterday / last week") is not the state now; a stale question counts only when answered yes.
 *
 * A heuristic, measured (own-words conflict with a State line shown; stale), never perfect: on an independent
 * reviewer's 43 adversarial answers precision 1.00, recall 0.89 (stale 1.00 / 1.00); on 30 fresh answers written after
 * the last fix precision 9/9, recall 9/10 (stale 4/4, 4/4); the fixtures in tests/fixtures/read-score/ pass exactly
 * because they were written with the fixes (optimistic). Known misses: words outside the briefing's vocabulary
 * ("engulfed bullishly"), "transitioning" (only "transition" is read, by design), a fact after a negated verb in the
 * gap ("has not caught up with the BOS up"). Read its counts as a screen, and check a sample of answers by hand.
 */

const { outcomeOf, enters } = require('./moment-probe');

const FRAMES = ['4h', '1h', '15m'];
const SENTENCE = /[^.\n]+/g;

const NEG_BEFORE = /(?:\bno|\bnot|n't|\bnothing|\bwithout|\bneeds?|\bwould need|\brequires?|\bwait(?:ing)? for|\bwatch(?:ing)? for|\blook(?:ing)? for|\bonly after|\buntil|\babsent|\bnever)\s+(?:a\s+|an\s+|the\s+|any\s+)?$/i;
const NEG_AFTER = /^[^.;\n]{0,30}\b(?:absent|none|not present|is not met|needed|(?:still )?required|is missing|does not exist|doesn't exist)\b/i;
const NEG_GAP = /\b(?:no|not|without|needs?|never|would|could|might|may|should|if|lacks?|lacking|missing)\b|n't\b/i;
const COND = /\b(?:would|could|might|should|if|whether|unless)\b/i;
const COND_AFTER = /^[^.;\n,]{0,25}\b(?:would|could|might)\b/i;
const QUESTION = /^[^.;\n!]*\?/;
// An absence word anywhere earlier in the clause ("Nothing on the 1h looks like a CHoCH down", "no sign of a ...").
const CLAUSE_NEG = /\b(?:nothing|none|nor|neither|no (?:sign|evidence|hint) of)\b/i;
// A past fact, not the state now ("the last 1h CHoCH down was three days ago", "was stale yesterday").
const HISTORY = /\bwas\b[^.;\n]*\b(?:ago|yesterday|last (?:week|session|month|night))\b/i;
const clauseOf = (text, start, end) => text.slice(0, start).split(/[.;:\n]/).at(-1) + text.slice(start, end) + text.slice(end).split(/[.;:\n]/)[0];

/** A match at [start, end) stands: not negated, conditional, asked or historical (`gapText`: the frame-to-fact gap). */
function stands(text, start, end, gapText = '') {
  const before = text.slice(0, start).split(/[.;\n]/).at(-1);
  const after = text.slice(end);
  return !(NEG_BEFORE.test(before) || CLAUSE_NEG.test(before.split(':').at(-1)) || COND.test(before.split(',').at(-1)) || NEG_AFTER.test(after) || COND_AFTER.test(after)
    || QUESTION.test(after) || NEG_GAP.test(gapText) || HISTORY.test(clauseOf(text, start, end)));
}

/** True when one match of `re` in text stands (`gapOf(m)`: its frame-to-fact gap). */
const unnegated = (text, re, gapOf = () => '') => [...text.matchAll(re)].some(m => stands(text, m.index, m.index + m[0].length, gapOf(m)));

// A gap that never crosses another frame's name ("1h down, 15m CHoCH up" is the 15m's): a tempered token.
const gap = n => `((?:(?!\\b\\d+[mh]\\b)[^.\\n;?]){0,${n}}?)`;
const NEAR = gap('40');
const AFTER_FACT = gap('15');

/** The facts against a label: each pattern's first group is the frame-to-fact gap. */
function opposing(tf, label) {
  const up = label === 'down'; // the other way
  const facts = [`(?:choch|bos)\\s+${up ? 'up' : 'down'}`, `${up ? 'bullish' : 'bearish'} engulfing`, `displacement\\s+${up ? 'up' : 'down'}`, `closed ${up ? 'above its high' : 'below its low'}`];
  // A frame named right after the fact owns it ("The 1h stays up, a bearish engulfing on the 15m" is the 15m's).
  const owned = '(?![^.\\n;?]{0,15}?\\b(?:on|in|for) (?:the )?\\d+[mh]\\b)';
  return facts.flatMap(f => [new RegExp(`\\b${tf}\\b${NEAR}\\b${f}\\b${owned}`, 'gi'), new RegExp(`\\b${f}\\b${AFTER_FACT}\\b(?:on|in|for) (?:the )?${tf}\\b`, 'gi')]);
}

function opposingFact(text, { labels = {} } = {}) {
  const t = String(text || '');
  return FRAMES.some(tf => (labels[tf] === 'up' || labels[tf] === 'down') && opposing(tf, labels[tf]).some(re => unnegated(t, re, m => m[1] || '')));
}

const TRANSITION = /\btransition\b/gi;
const REGIME_BEFORE = /\bregime\b[^.\n]{0,20}$/i;
const SESSION_BEFORE = /\b(?:session|morning|midday|lunch|opening|open|time|clock|hour|window|day)\s+$/i;
const SESSION_AFTER = /^\s*(?:period|window|hour|time|phase|zone|regime|into|to|at)\b/i;
const DISAGREE = /\b(?:disagree(?:s|ment)?|contradict(?:s|ed|ion|ing)?|conflicts? with|a conflict|at odds)\b/gi;
const STATE_WORD = /\b(?:labels?|trends?|frames?|structure|4h|1h|15m)\b/i;

function conflictWords(text) {
  const t = String(text || '');
  for (const m of t.matchAll(TRANSITION)) {
    const before = t.slice(0, m.index);
    const after = t.slice(m.index + m[0].length);
    if (REGIME_BEFORE.test(before) || SESSION_BEFORE.test(before) || SESSION_AFTER.test(after)) continue;
    if (stands(t, m.index, m.index + m[0].length)) return true;
  }
  return (t.match(SENTENCE) || []).some(s => STATE_WORD.test(s) && unnegated(s, DISAGREE));
}

const namesConflict = (text, ctx = {}) => opposingFact(text, ctx) || conflictWords(text);

const STALE = /\b(?:label|trend|4h|1h|15m)\b[^.\n]{0,40}?\b(lags?|lagging|stale|behind (?:price|the move)|(?:has not|hasn't) (?:flipped|turned) yet|(?:not yet|yet to|still to) (?:flip(?:ped)?|turn(?:ed)?)|(?:has not|hasn't|not yet|yet to) (?:catch up|caught up))\b/gi;
const STALE_NEG = /\b(?:not|never|no longer|far from|nothing|no)\b|n't\b/i;
// Later in the same sentence, the answer's own verdict denies it ("looks lagging but I would not call it stale").
const STALE_DENIED = /^[^.;\n]*?(?:\b(?:not|never)\b|n't\b)[^.;\n]{0,25}\b(?:stale|lagging|lags?)\b/i;

function calledLabelStale(text) {
  const t = String(text || '');
  for (const m of t.matchAll(STALE)) {
    const at = m.index + m[0].length - m[1].length;
    const clause = t.slice(0, at).split(/[.;:\n]/).at(-1);
    const after = t.slice(m.index + m[0].length);
    if (COND.test(clause) || HISTORY.test(clauseOf(t, at, m.index + m[0].length))) continue;
    // Asked: only an answer of yes calls it stale ("Is the 1h label stale? No, it flipped" does not).
    if (QUESTION.test(after) && !/^[^?]*\?\s*yes\b/i.test(after)) continue;
    if (/^(?:lag|stale|behind)/i.test(m[1]) && (STALE_NEG.test(clause) || STALE_DENIED.test(t.slice(m.index + m[0].length)))) continue;
    if (/^lag/i.test(m[1]) && /^\s+indicator/i.test(t.slice(m.index + m[0].length))) continue;
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
  return t.toLowerCase().includes(PHRASE) || facts.some(f => t.includes(f));
}

/** The answer with the line's copied text taken out (the line itself, its facts, its fixed phrase). */
function ownWords(text, line) {
  let t = String(text || '');
  if (!line) return t;
  for (const piece of [line, ...factsOf(line)]) t = t.split(piece).join(' ');
  return t.replace(new RegExp(PHRASE, 'gi'), ' ');
}

function readOf(text, { labels = {}, line = null } = {}) {
  const o = outcomeOf(text);
  const own = ownWords(text, line);
  const fact = opposingFact(own, { labels });
  const words = conflictWords(own);
  return { namesConflict: fact || words, opposingFact: fact, conflictWords: words, ownConflict: fact || (words && !line), calledLabelStale: calledLabelStale(text),
    echoesState: echoesState(text, line), decision: o ? (enters(o) ? 'planned' : o) : null };
}

module.exports = { FRAMES, opposingFact, conflictWords, namesConflict, calledLabelStale, echoesState, readOf };
