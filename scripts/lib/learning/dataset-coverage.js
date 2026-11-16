'use strict';

/**
 * What the verified-decision dataset teaches, counted (decision-dataset.js `coverage`; `show` prints it): examples per
 * skill, per read type (the compose step a verified read is on), per decision kind and per role, and the GAPS: each
 * skill the head trader reads with (the trade-lifecycle crosswalk's skills, curated-moments.js READ_SKILL, and the
 * shape skill) that has fewer than the spec's `coverage.minExamplesPerSkill` examples, so the moments to collect next
 * are known. A report only: nothing is refused for a gap.
 *
 * An example counts for a skill once when its decision's compose record holds a read of that skill the checker verified
 * (check true): the crosswalk's skill for the read's form (curated-moments.js skillOfRead), else the skill it named. A
 * pass or a risk action with no verified read counts for no skill (its kind and role still count). The size and
 * management skills have no read (skill-usage.js NO_READ_SKILLS): listed as not measured, never a gap.
 *
 *   TAUGHT_SKILLS                              the head trader's read skills, sorted
 *   skillsOf(decision)                         the skills of its verified reads (sorted, once each)
 *   coverageOf(examples, { minExamplesPerSkill })   { n, kind, role, readType, skill, gaps, notMeasured }
 */

const { READ_SKILL, SHAPE_SKILL, skillOfRead } = require('./curated-moments');
const { NO_READ_SKILLS } = require('./skill-usage');

const TAUGHT_SKILLS = Object.freeze([...new Set([...Object.values(READ_SKILL).flatMap(k => Object.values(k)), SHAPE_SKILL])].sort());
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const verified = r => isObj(r) && (r.check === true || r.check === 'true');
const readsOf = d => (isObj(d) && isObj(d.record) && Array.isArray(d.record.reads) ? d.record.reads.filter(verified) : []);
const skillOf = r => (typeof r.read === 'string' && skillOfRead(r.step, r.read)) || (typeof r.skill === 'string' && r.skill ? r.skill : null);

const skillsOf = d => [...new Set(readsOf(d).map(skillOf).filter(Boolean))].sort();

function bump(m, k) { m[k] = (m[k] || 0) + 1; }
const sortedObj = m => Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));

/** `examples`: [{ role, decision }] (decision-dataset.js's examples). */
function coverageOf(examples, { minExamplesPerSkill = null } = {}) {
  const kind = {};
  const role = {};
  const readType = {};
  const skill = Object.fromEntries(TAUGHT_SKILLS.map(s => [s, 0]));
  for (const x of examples) {
    const d = x.decision || {};
    bump(kind, d.kind || 'none');
    bump(role, x.role || 'none');
    for (const step of new Set(readsOf(d).map(r => r.step || 'none'))) bump(readType, step);
    for (const s of skillsOf(d)) bump(skill, s);
  }
  const gaps = Number.isInteger(minExamplesPerSkill) ? TAUGHT_SKILLS.filter(s => skill[s] < minExamplesPerSkill).map(s => ({ skill: s, n: skill[s] })) : [];
  return { n: examples.length, kind: sortedObj(kind), role: sortedObj(role), readType: sortedObj(readType), skill: sortedObj(skill), minExamplesPerSkill, gaps, notMeasured: Object.values(NO_READ_SKILLS).flat() };
}

module.exports = { TAUGHT_SKILLS, skillsOf, coverageOf };
