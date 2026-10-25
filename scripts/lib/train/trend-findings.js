'use strict';

/**
 * A probe round's trend findings (Propose-Probe-Compose, docs/TRAINING.md): the legs the champion missed on the trend
 * set's probe half, read from each run's trend-capture report (replay/trend-capture.js: every missed leg's blocker, the
 * cycle that came closest to an entry, by flow step), grouped by what blocked them and ranked by what they cost.
 *
 * Kind `trend-blocker`. Only learnable legs (trend-facts.js: a valid with-trend plan existed at one of the leg's
 * entry-able bars, by compose_check's own verdict, the trend rule, R:R and room, and under a prop attempt a size that
 * fits) are findings; a leg with no valid plan at the time was a correct pass, and one whose facts are unknown is
 * neither: both are counted (missedTally), never findings. One finding per (flow step, owner): the legs it blocked
 * (count), the R they left (cost: the sum of each leg's availableR, its move from the first bar an entry could be on to
 * its end, in its planned stop or the run's; legs with no R counted as none), its codes, and up to `examples` legs
 * (config/training.json trendFindings), the costliest first, each as trend-facts.js exampleLine gives it (what the model
 * said, the contradiction, the plan that passed: no date, time or price); a late or unfilled entry's legs (the runner's
 * execution, not a read) give no example. The owner:
 *   compose_check   the skill of the blocking cycle's first unverified read at the failing step (the read the check
 *                   refused); none when no read names a skill there
 *   phase2          agents/risk-manager.md (a veto, an unread verdict)
 *   min-contracts   the floor refused the model's stop (phase 2 or the gate): the head's stop choice, flow step `stop`
 *                   and the skill of its plan's stop read (trend-facts.js owner); the floor itself is the rulebook's
 *   executor        agents/trade-executor.md (an abort, a block)
 *   no-plan         the step where the model's stated reason and the verified reads first disagree (trend-facts.js
 *                   owner) and the skill of that read; none without a disagreement
 *   anything else   none (the gate's late or unfilled entry, the head trader's pass): any skill or role may be edited
 * Never a finding: a leg blocked by a rule (the gate's clock, the account's stops, news: code and the rulebook, the
 * owner's), outside the session, or behind a position already open. A size or management skill (no read), the loop's
 * own skills and a skill the tree doesn't hold own nothing (the finding stays, unowned).
 *
 *   KIND
 *   ownerOf(leg, { exists })                   { skill } | { agent } | {} for a missed leg's blocker
 *   stepOfLeg(leg)                             the flow step a finding files the leg under (the floor's: stop)
 *   trendFindings(captures, { exists, max })   [{ kind, step, skill?, agent?, code, count, cost, of, detail, examples }],
 *                                              ranked by cost, then count, then step order and owner; at most max (none:
 *                                              all); its detail clipped where the round merges it (findings.js mergeFindings)
 *   missedTally(captures)                      { missed, learnable, noValidPlan, unknown }: the legs a finding could be
 *                                              made of, and how many were (the round's report and status)
 *   findingCost(f)                             its cost, for the merged ranking
 */

const { FLOW_STEPS } = require('./flow');

const KIND = 'trend-blocker';
const NOT_FINDINGS = new Set(['outside-session', 'position-open', 'entered']);
// The skills no finding names (findings.js NOT_PROBED: a size or management skill has no read; the loop's own).
const NOT_OWNED = require('./findings').NOT_PROBED;
// The codes a finding lists, the most frequent first (config/training.json skillUsage.top, the skill-usage report's).
const TOP = require('../tunables').training().skillUsage.top;
// The example legs a finding shows and each one's length (config/training.json trendFindings).
const EX = require('../tunables').training().trendFindings;
const { exampleLine } = require('./trend-facts');
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const r2 = x => Math.round(x * 100) / 100;

const FLOOR = 'min-contracts';
// The codes of the runner's own execution (a late or unfilled entry): no reading to show in an example.
const EXECUTION_CODES = new Set(['late-entry', 'unfilled']);

/** The skill trend-facts.js credits a leg to (its owner's), when the tree holds it and it reads; else none. */
function ownSkill(leg, exists) {
  const o = isObj(leg.facts) && isObj(leg.facts.owner) ? leg.facts.owner : null;
  return o && o.skill && !NOT_OWNED.has(o.skill) && exists(o.skill) ? { skill: o.skill } : {};
}

/** The leg's blocking cycle: the last of its cycles with the blocker's code. */
const blockingCycle = leg => [...(leg.cycles || [])].reverse().find(c => c && c.code === leg.blocker.code) || null;

function ownerOf(leg, { exists = () => true } = {}) {
  const b = leg && leg.blocker;
  if (!isObj(b)) return {};
  // A size under the floor at the model's stop is its stop choice (the stop read's skill), never the floor's role.
  if (b.code === FLOOR) return ownSkill(leg, exists);
  if (b.by === 'phase2') return { agent: 'risk-manager' };
  if (b.by === 'executor') return { agent: 'trade-executor' };
  if (b.code === 'no-plan') return ownSkill(leg, exists);
  if (b.by !== 'compose_check') return {};
  const c = blockingCycle(leg);
  const read = c ? (c.reads || []).find(r => r && r.step === b.step && r.verified !== true && r.skill) : null;
  return read && !NOT_OWNED.has(read.skill) && exists(read.skill) ? { skill: read.skill } : {};
}

/** The flow step a leg is filed under: its blocker's; a no-plan leg's, where its reason and the facts disagree. */
function stepOfLeg(leg) {
  const b = leg.blocker;
  if (b.code === FLOOR) return 'stop';
  const o = b.code === 'no-plan' && isObj(leg.facts) && isObj(leg.facts.owner) ? leg.facts.owner.step : null;
  const step = o || b.step;
  return FLOW_STEPS.includes(step) ? step : null;
}

/** A missed leg a finding could be made of: not caught, not a rule's, not outside the session or behind a position. */
const eligible = leg => isObj(leg) && !leg.captured && isObj(leg.blocker) && leg.blocker.by !== 'rule' && !NOT_FINDINGS.has(leg.blocker.code);
const learnable = leg => isObj(leg.facts) && leg.facts.learnable === true;

function missedTally(captures) {
  const legs = (Array.isArray(captures) ? captures : []).flatMap(doc => (isObj(doc) && Array.isArray(doc.legs) ? doc.legs : [])).filter(eligible);
  const n = test => legs.filter(test).length;
  return { missed: legs.length, learnable: n(learnable), noValidPlan: n(l => isObj(l.facts) && l.facts.learnable === false), unknown: n(l => !isObj(l.facts) || (l.facts.learnable !== true && l.facts.learnable !== false)) };
}

function trendFindings(captures, { exists = () => true, max } = {}) {
  const groups = new Map();
  let legs = 0;
  for (const doc of Array.isArray(captures) ? captures : []) {
    for (const leg of isObj(doc) && Array.isArray(doc.legs) ? doc.legs : []) {
      legs += 1;
      if (!eligible(leg) || !learnable(leg)) continue;
      const b = leg.blocker;
      const owner = ownerOf(leg, { exists });
      const step = stepOfLeg(leg);
      const key = `${step || ''}|${owner.skill ? `s:${owner.skill}` : owner.agent ? `a:${owner.agent}` : ''}`;
      const g = groups.get(key) || { step, ...owner, legs: 0, cost: 0, codes: new Map(), members: [] };
      g.legs += 1;
      g.cost += num(leg.availableR);
      g.codes.set(b.code, (g.codes.get(b.code) || 0) + 1);
      g.members.push(leg);
      groups.set(key, g);
    }
  }
  const stepRank = s => (s === null ? FLOW_STEPS.length : FLOW_STEPS.indexOf(s));
  const name = g => g.skill || (g.agent ? `agent ${g.agent}` : '');
  return [...groups.values()]
    .sort((a, b) => b.cost - a.cost || b.legs - a.legs || stepRank(a.step) - stepRank(b.step) || name(a).localeCompare(name(b)))
    .slice(0, max)
    .map(g => {
      const codes = [...g.codes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP);
      // The costliest legs first (the id breaks a tie): what the proposer reads of each, clipped.
      const examples = [...g.members].sort((a, b) => num(b.availableR) - num(a.availableR) || String(a.id).localeCompare(String(b.id)))
        .filter(l => !EXECUTION_CODES.has(l.blocker.code)).map(l => exampleLine(l)).filter(Boolean).slice(0, EX.examples).map(x => (x.length > EX.exampleChars ? `${x.slice(0, EX.exampleChars - 3)}...` : x));
      return {
        kind: KIND, step: g.step, ...(g.skill ? { skill: g.skill } : g.agent ? { agent: g.agent } : { skill: null }), code: codes[0][0], count: g.legs, cost: r2(g.cost), of: legs,
        detail: codes.map(([c, n]) => `${c} (${n})`).join('; '), examples,
      };
    });
}

const findingCost = f => (f && typeof f.cost === 'number' ? f.cost : 0);

module.exports = { KIND, ownerOf, stepOfLeg, trendFindings, missedTally, findingCost };
