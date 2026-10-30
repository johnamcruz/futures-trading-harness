'use strict';

/**
 * A probe round's exit findings (Propose-Probe-Compose, docs/TRAINING.md): the champion's exits on the trend set's probe
 * half that cut a trend or came late, read from each run's trend-capture report (`exits`: replay/exit-scorecard.js),
 * grouped by class and ranked by the R they cost, for the proposer to write edits to the read that decides them.
 *
 * Kind `exit-decision`, on the flow's target step (where a trade's profit is taken), owned by the skills that decide its
 * class (OWNERS, `skills`, any one an edit may change; `skill` the first): a cut trend by the open trade's read
 * (pullback-vs-reversal) and the action on it (manage-position); a late exit by those and the profit-taking
 * (take-profit). manage-position owns an exit finding only: it has no read, so it never owns a read finding (findings.js
 * NOT_PROBED). Only what the MODEL decided is a finding (MODEL_DECIDED): its market exit (model-exit), the stop it tightened
 * that took the trade out (model-stop), or its hold to the initial stop with the runner's trail never armed (initial-stop:
 * the runner had not moved the stop, so the hold was the model's alone). The runner's own trail and close, and the target,
 * are the report's rows only, never findings: the runner's trail giving back is the rulebook's design (its lock_giveback_r,
 * which the late threshold never goes below: exit-scorecard.js lateThreshold), not a lesson to exit before it. Codes:
 *   cut-trend        the model exited (or its tightened stop took the trade out) and price then went cutR further the
 *                    trade's way before rightR against; cost: the R it then went (leftR)
 *   cut-trend-flip   the same, decided with the HTF bias flipped against the trade (tagged apart: a flip alone is a
 *                    weakening sign, not a reversal)
 *   late-exit        a model-decided exit after giving back more than the late threshold of open profit; cost: the
 *                    profit given back past it (lateR)
 * An initial stop that then ran the trade's way is the stop's placement (the report's stop-placement row), never a
 * finding here. Each finding: count, cost, of (the model-decided scored exits), the exits' split by who exited (detail),
 * and up to `examples`
 * (config/training.json exitFindings) of the costliest, as the facts code read at the decision (exit-scorecard.js
 * factsText: no date, time or price), each with its entry's base timing when known (trend-facts.js entryTimings:
 * entered before the turn, at the turn, or with). The exits that were right are counted in `of`, never findings.
 *
 *   KIND, OWNER, OWNERS, MODEL_DECIDED
 *   exitFindings(captures, { exists, max })   [{ kind, step, skill, skills, code, count, cost, of, detail, examples }], by cost
 *   exitTally(captures)                       the summed exit-scorecard totals of the captures (the round's report)
 */

const ES = require('../replay/exit-scorecard');

const KIND = 'exit-decision';
const OWNER = 'pullback-vs-reversal';
// The skills an exit finding's edit may change, by its code: the read first, then the action, then the profit-taking.
const OWNERS = Object.freeze({
  'cut-trend': Object.freeze([OWNER, 'manage-position']),
  'cut-trend-flip': Object.freeze([OWNER, 'manage-position']),
  'late-exit': Object.freeze([OWNER, 'manage-position', 'take-profit']),
});
const STEP = 'target';
const EX = require('../tunables').training().exitFindings; // examples per finding and their length (config/training.json)
const MODEL = new Set(['model-exit', 'model-stop']);
// The exits the model decided: its own, or its hold to the initial stop before the runner's trail armed.
const MODEL_DECIDED = new Set([...MODEL, 'initial-stop']);
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const r2 = x => Math.round(x * 100) / 100;

const decisionsOf = captures => (Array.isArray(captures) ? captures : [])
  .flatMap(doc => (isObj(doc) && isObj(doc.exits) && Array.isArray(doc.exits.decisions) ? doc.exits.decisions : []));

/** The code of a scored exit, or null (not a finding). */
function codeOf(d) {
  if (MODEL.has(d.exitBy) && d.cls === 'cut') return d.flip === true ? 'cut-trend-flip' : 'cut-trend';
  if (MODEL_DECIDED.has(d.exitBy) && d.late) return 'late-exit';
  return null;
}
const costOf = (d, code) => (code === 'late-exit' ? num(d.lateR) : num(d.leftR));

function exitFindings(captures, { exists = () => true, max } = {}) {
  const all = decisionsOf(captures).filter(d => isObj(d) && MODEL_DECIDED.has(d.exitBy));
  const groups = new Map();
  for (const d of all) {
    const code = isObj(d) ? codeOf(d) : null;
    if (!code) continue;
    const g = groups.get(code) || { code, members: [], cost: 0, by: new Map() };
    g.members.push(d);
    g.cost += costOf(d, code);
    g.by.set(d.exitBy, (g.by.get(d.exitBy) || 0) + 1);
    groups.set(code, g);
  }
  return [...groups.values()].sort((a, b) => b.cost - a.cost || b.members.length - a.members.length || a.code.localeCompare(b.code)).slice(0, max).map(g => {
    const examples = [...g.members].sort((a, b) => costOf(b, g.code) - costOf(a, g.code))
      .map(d => `${d.exitBy}${typeof d.entryTiming === 'string' ? ` (entered ${d.entryTiming})` : ''}: ${d.facts ? ES.factsText(d.facts) : 'no facts at the decision'}`).slice(0, EX.examples)
      .map(x => (x.length > EX.exampleChars ? `${x.slice(0, EX.exampleChars - 3)}...` : x));
    const skills = OWNERS[g.code].filter(s => exists(s));
    return {
      kind: KIND, step: STEP, skill: skills[0] || null, skills, code: g.code, count: g.members.length, cost: r2(g.cost), of: all.length,
      detail: [...g.by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} (${n})`).join('; '), examples,
    };
  });
}

function exitTally(captures) {
  return ES.summarize({
    decisions: decisionsOf(captures),
    tightens: (Array.isArray(captures) ? captures : []).flatMap(doc => (isObj(doc) && isObj(doc.exits) && Array.isArray(doc.exits.tightens) ? doc.exits.tightens : [])),
  });
}

module.exports = { KIND, OWNER, OWNERS, MODEL_DECIDED, exitFindings, exitTally };
