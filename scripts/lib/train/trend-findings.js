'use strict';

/**
 * A probe round's trend findings (Propose-Probe-Compose, docs/TRAINING.md): the legs the champion missed on the trend
 * set's probe half, read from each run's trend-capture report (replay/trend-capture.js: every missed leg's blocker, the
 * cycle that came closest to an entry, by flow step), grouped by what blocked them and ranked by what they cost.
 *
 * Kind `trend-blocker`. One finding per (flow step, owner): the legs it blocked (count), the R they left (cost: the
 * sum of each leg's availableR, its move from the first bar an entry could be on to its end, in its planned stop or the
 * run's; legs with no R counted as none) and its codes with an example message. The owner:
 *   compose_check   the skill of the blocking cycle's first unverified read at the failing step (the read the check
 *                   refused); none when no read names a skill there
 *   phase2          agents/risk-manager.md (a veto, the sizing floor, an unread verdict)
 *   executor        agents/trade-executor.md (an abort, a block)
 *   anything else   none (the gate's late or unfilled entry, the head trader's no-plan or pass): any skill or role may
 *                   be edited for it
 * Never a finding: a leg blocked by a rule (the gate's clock, the account's stops, news: code and the rulebook, the
 * owner's), outside the session, or behind a position already open. A size or management skill (no read), the loop's
 * own skills and a skill the tree doesn't hold own nothing (the finding stays, unowned).
 *
 *   KIND
 *   ownerOf(leg, { exists })                   { skill } | { agent } | {} for a missed leg's blocker
 *   trendFindings(captures, { exists, max })   [{ kind, step, skill?, agent?, code, count, cost, of, detail }], ranked by
 *                                              cost, then count, then step order and owner; at most max (none: all);
 *                                              its detail clipped where the round merges it (findings.js mergeFindings)
 *   findingCost(f)                             its cost, for the merged ranking
 */

const { FLOW_STEPS } = require('./flow');

const KIND = 'trend-blocker';
const NOT_FINDINGS = new Set(['outside-session', 'position-open', 'entered']);
// The skills no finding names (findings.js NOT_PROBED: a size or management skill has no read; the loop's own).
const NOT_OWNED = require('./findings').NOT_PROBED;
// The codes a finding lists, the most frequent first (config/training.json skillUsage.top, the skill-usage report's).
const TOP = require('../tunables').training().skillUsage.top;
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const r2 = x => Math.round(x * 100) / 100;

/** The leg's blocking cycle: the last of its cycles with the blocker's code. */
const blockingCycle = leg => [...(leg.cycles || [])].reverse().find(c => c && c.code === leg.blocker.code) || null;

function ownerOf(leg, { exists = () => true } = {}) {
  const b = leg && leg.blocker;
  if (!isObj(b)) return {};
  if (b.by === 'phase2') return { agent: 'risk-manager' };
  if (b.by === 'executor') return { agent: 'trade-executor' };
  if (b.by !== 'compose_check') return {};
  const c = blockingCycle(leg);
  const read = c ? (c.reads || []).find(r => r && r.step === b.step && r.verified !== true && r.skill) : null;
  return read && !NOT_OWNED.has(read.skill) && exists(read.skill) ? { skill: read.skill } : {};
}

function trendFindings(captures, { exists = () => true, max } = {}) {
  const groups = new Map();
  let legs = 0;
  for (const doc of Array.isArray(captures) ? captures : []) {
    for (const leg of isObj(doc) && Array.isArray(doc.legs) ? doc.legs : []) {
      legs += 1;
      const b = leg.blocker;
      if (leg.captured || !isObj(b) || b.by === 'rule' || NOT_FINDINGS.has(b.code)) continue;
      const owner = ownerOf(leg, { exists });
      const key = `${b.step || ''}|${owner.skill ? `s:${owner.skill}` : owner.agent ? `a:${owner.agent}` : ''}`;
      const g = groups.get(key) || { step: FLOW_STEPS.includes(b.step) ? b.step : null, ...owner, legs: 0, cost: 0, codes: new Map(), example: null };
      g.legs += 1;
      g.cost += num(leg.availableR);
      g.codes.set(b.code, (g.codes.get(b.code) || 0) + 1);
      const c = blockingCycle(leg);
      if (!g.example && c && c.message) g.example = String(c.message);
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
      return {
        kind: KIND, step: g.step, ...(g.skill ? { skill: g.skill } : g.agent ? { agent: g.agent } : { skill: null }), code: codes[0][0], count: g.legs, cost: r2(g.cost), of: legs,
        detail: `${codes.map(([c, n]) => `${c} (${n})`).join('; ')}${g.example ? `; e.g. ${g.example}` : ''}`,
      };
    });
}

const findingCost = f => (f && typeof f.cost === 'number' ? f.cost : 0);

module.exports = { KIND, ownerOf, trendFindings, findingCost };
