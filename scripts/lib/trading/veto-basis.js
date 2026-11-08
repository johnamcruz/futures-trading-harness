'use strict';

/**
 * What a risk-manager phase-2 veto rests on, read from its veto line (agents/risk-manager.md: a VETO only on a
 * decisive 1h CHoCH against or a failed hard step; a lesson, a journal note or a phase-1 restriction is advice, never
 * a veto). A measurement, never a gate: the runner records it with the veto (runner-entry.js) and the experience log
 * with the pass it caused (learning/pass-class.js), so a veto resting on a lesson alone shows as one and is never
 * counted as the model's own pass. The veto stands either way.
 *
 *   vetoBasis(text)   'hard-step'  the line names a hard step (the 1h CHoCH, the trend rule, room, R:R, the window or a
 *                                  blackout, the loss streak, a daily limit, the floor or a size that can't fit, the
 *                                  budget or a cap, order_plan's refusal, the policy verdict's skip or size, the
 *                                  account) as failing, or as its failed check (`VETO - room: ...`), whatever else
 *                                  it names; such a word in passing ("the budget is fine") is not one
 *                     'lesson'     it names only a lesson, the journal, a restriction, a lift or a stand-down
 *                     'unstated'   neither
 *                     null         no text
 *   BASES             the three
 */

const BASES = Object.freeze(['hard-step', 'lesson', 'unstated']);

// The hard steps a veto may rest on (the priority order and phase 2's checks), each as a phrase that says the step
// fails, anywhere on the line: never a word that may come up in passing ("the R:R 2.5 is fine", "the daily limit is
// far"), and never one negated ("not counter to the 4h trend", "no unprotected position": NEGATED).
const HARD = new RegExp([
  '\\b1h\\s+choch\\s+(?:(?:up|down)\\s+)?against\\b', '\\bdecisive\\s+(?:1h\\s+)?(?:choch\\s+)?against\\b',
  '\\btrend\\s+rule\\s+(?:blocks|refuses|forbids)\\b', '\\btrend\\s+(?:long|short)\\s+blocked\\b', '\\bcounter\\s+to\\s+the\\s+(?:prevailing|4h|1h)\\b',
  '\\bR:R\\s+(?:[\\d.]+\\s+)?(?:is\\s+)?(?:under|below|short\\s+of)\\b', '\\bunder\\s+(?:the\\s+)?min(?:imum)?\\s+R:R\\b', '\\bno\\s+level\\s+at\\s+2:1\\b',
  '\\bin\\s+(?:a|the)\\s+(?:news\\s+)?blackout\\b', '\\bnews\\s+window\\s+holds\\b', '\\bentries\\s+(?:are\\s+)?not\\s+allowed\\b',
  '\\bat\\s+the\\s+loss[- ]streak\\b', '\\bloss[- ]streak\\s+stop\\s+(?:hit|reached|holds)\\b', '\\bin\\s+(?:a|the)\\s+cooldown\\b', '\\bcooldown\\s+until\\b',
  '\\bdaily\\s+(?:loss\\s+)?limit\\s+(?:hit|reached|breached)\\b', '\\bat\\s+the\\s+daily\\s+(?:loss\\s+)?limit\\b', '\\bsoft\\s+stop\\s+(?:hit|reached)\\b',
  '\\bunder\\s+(?:the\\s+)?(?:prop\\s+|size\\s+|rulebook\'s\\s+)?floor\\b', '\\bsize\\s+floor\\b.*\\bcan(?:not|\'t)\\b',
  '\\bno\\s+(?:legal\\s+|allowed\\s+|compliant\\s+)?size\\s+(?:fits|passes|exists|is\\s+allowed)\\b', '\\bcan(?:not|\'t)\\s+(?:both\\s+)?be\\s+(?:met|sized)\\b',
  '\\bover\\s+(?:the\\s+)?(?:\\$[\\d,.]+\\s+)?(?:budget|(?:risk\\s+)?cap|live\\s+verdict|max_risk|maxOrderSize)', '\\border_plan\\s+refuse',
  '\\bpolicy\\s+skip\\b', '\\bverdict\\s+is\\s+skip\\b', '\\bskipped\\s+(?:this|on\\s+this)\\b', '\\bdoes\\s+not\\s+match\\b',
  '\\bstop\\s+on\\s+the\\s+wrong\\s+side\\b', '\\bnot\\s+tradable\\b', '\\bunprotected\\s+position\\b',
].join('|'), 'gi');
// A negation just before a phrase ("not counter to", "no unprotected position", "isn't in a blackout").
const NEGATED = /\b(?:not|no|never|without|isn't|aren't|wasn't)\s+(?:\S+\s+)?$/i;
const failing = t => [...t.matchAll(HARD)].some(m => !NEGATED.test(t.slice(0, m.index)));
// A hard step named as the VETO line's failed check (`VERDICT: VETO - <check>: ...`, agents/risk-manager.md).
const CHECK = /\bVETO\s*[-:]\s*([^:]{1,40}):/i;
const HARD_CHECK = /\b(?:room|budget|cap|floor|size|sizing|risk[- ]sizing|trend|alignment|window|news|blackout|R:R|min[- ]contracts|loss[- ]streak|cooldown|daily\s+limit|DLL|1h\s+choch)\b/i;
// What a lesson-led veto names instead.
const LESSON = /\blessons?\b|\bjournal(?:ed|led)?\b|\bunjournaled\b|\brestrict(?:s|ed|ion|ions)?\b|\blift(?:s|ed)?\b|\bstand[- ]down\b|\binstinct\b|\b\d+W\/\d+L\b/i;

function vetoBasis(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const check = CHECK.exec(t);
  if (failing(t) || (check && HARD_CHECK.test(check[1]) && !LESSON.test(check[1]))) return 'hard-step';
  return LESSON.test(t) ? 'lesson' : 'unstated';
}

module.exports = { vetoBasis, BASES };
