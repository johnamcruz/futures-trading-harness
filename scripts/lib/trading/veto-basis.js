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

// The hard steps a veto may rest on (the priority order and phase 2's checks), stated as a failed check anywhere on
// the line: a phrase that says the step fails, never a word that may come up in passing.
const HARD = new RegExp([
  '\\b1h\\s+choch\\b', '\\btrend\\s+rule\\b', '\\bcounter\\s+to\\b', '\\bcounter-trend\\b', '\\bR:R\\b', '\\bmin_rr\\b',
  '\\breward[- ]to[- ]risk\\b', '\\bblackout\\b', '\\bnews\\s+window\\b', '\\bno[- ]entry\\s+window\\b', '\\bopening\\s+print\\b',
  '\\bloss[- ]streak\\b', '\\bcooldown\\b', '\\bdaily\\s+(?:loss\\s+)?limit\\b', '\\bDLL\\b', '\\bsoft\\s+stop\\b',
  '\\bunder\\s+(?:the\\s+)?(?:prop\\s+|size\\s+|rulebook\'s\\s+)?floor\\b', '\\bsize\\s+floor\\b', '\\bmin[_-]contracts\\b',
  '\\bno\\s+(?:legal\\s+|allowed\\s+|compliant\\s+)?size\\s+(?:fits|passes|exists|is\\s+allowed)\\b', '\\bcan(?:not|\'t)\\s+(?:both\\s+)?be\\s+(?:met|sized)\\b',
  '\\bover\\s+(?:the\\s+)?(?:\\$[\\d,.]+\\s+)?(?:budget|(?:risk\\s+)?cap|live\\s+verdict)', '\\bmax_risk', '\\bmaxOrderSize\\b', '\\border_plan\\s+refuse',
  '\\bpolicy\\s+skip\\b', '\\bverdict\\s+is\\s+skip\\b', '\\bskipped\\s+(?:this|on\\s+this)\\b', '\\bverdict\'s\\s+up\\s+to\\b', '\\bdoes\\s+not\\s+match\\b',
  '\\bstop\\s+on\\s+the\\s+wrong\\s+side\\b', '\\bnot\\s+tradable\\b', '\\bunprotected\\s+position\\b',
].join('|'), 'i');
// A hard step named as the VETO line's failed check (`VERDICT: VETO - <check>: ...`, agents/risk-manager.md).
const CHECK = /\bVETO\s*[-:]\s*([^:]{1,40}):/i;
const HARD_CHECK = /\b(?:room|budget|cap|floor|size|sizing|risk[- ]sizing|trend|alignment|window|news|blackout|R:R|min[- ]contracts)\b/i;
// What a lesson-led veto names instead.
const LESSON = /\blessons?\b|\bjournal(?:ed|led)?\b|\bunjournaled\b|\brestrict(?:s|ed|ion|ions)?\b|\blift(?:s|ed)?\b|\bstand[- ]down\b|\binstinct\b|\b\d+W\/\d+L\b/i;

function vetoBasis(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const check = CHECK.exec(t);
  if (HARD.test(t) || (check && HARD_CHECK.test(check[1]) && !LESSON.test(check[1]))) return 'hard-step';
  return LESSON.test(t) ? 'lesson' : 'unstated';
}

module.exports = { vetoBasis, BASES };
