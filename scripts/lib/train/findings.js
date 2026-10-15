'use strict';

/**
 * A probe round's findings (Propose-Probe-Compose, docs/TRAINING.md): what the champion's stage-1 practice runs got
 * wrong, skill by skill, for the proposer to write edits against. Read only from what the runs recorded: the
 * skill-usage report (learning/skill-usage.js: a skill's wrong reads and its misses) and the scorecard's decisions (a
 * refusal it graded `wrong stated reason`, credited to the skills whose reads the model composed at that bar).
 *
 * Kinds: `misread` (the skill's claimed reads the checker refused), `missed` (a read of the skill was true and pointed
 * the side's way, and the model claimed none), `wrong-reason refusal` (it passed for a reason the facts refute).
 * The skills with the most of the three together come first; a skill with no SKILL.md in the tree, a size or management
 * skill (no read), and the loop's own skills are left out. A refusal no compose read explains is listed unattributed.
 *
 *   FINDING_KINDS
 *   mergeUsage(reports)                        one report's skill rows from several runs' (counts summed)
 *   refusalsOf(decisions, records)             [{ key, skills, falseReasons }]: the wrong-reason refusals, attributed
 *   findingsFrom({ skills, refusals, exists, max })   [{ id, skill, kind, count, of, detail }], ranked, at most max
 *   findingLine(f)                             one line of the proposer's prompt
 */

const { familyRoot } = require('../trading/contracts');
const { skillOfRead } = require('../learning/curated-moments');
const { NO_READ_SKILLS } = require('../learning/skill-usage');
const { LOOP_SKILLS } = require('./proposal');

const FINDING_KINDS = Object.freeze(['misread', 'missed', 'wrong-reason refusal']);
const NOT_PROBED = new Set([...Object.values(NO_READ_SKILLS).flat(), ...LOOP_SKILLS, 'unknown']);
const ENTRY = new Set(['long', 'short']);

const sumTop = (a = [], b = []) => {
  const m = new Map();
  for (const x of [...a, ...b]) m.set(x.what, (m.get(x.what) || 0) + x.count);
  return [...m].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map(([what, count]) => ({ what, count }));
};

function mergeUsage(reports) {
  const by = new Map();
  for (const r of reports || []) {
    for (const s of (r && r.skills) || []) {
      const x = by.get(s.skill) || { skill: s.skill, reads: 0, correct: 0, wrong: 0, available: 0, used: 0, relevant: 0, missed: 0, topRefusals: [], topMissed: [] };
      for (const k of ['reads', 'correct', 'wrong', 'available', 'used', 'relevant', 'missed']) x[k] += Number(s[k]) || 0;
      x.topRefusals = sumTop(x.topRefusals, s.topRefusals);
      x.topMissed = sumTop(x.topMissed, s.topMissed);
      by.set(s.skill, x);
    }
  }
  return [...by.values()];
}

/** The scorecard's wrong-reason refusals (no entry), each with the skills of the reads the model composed at its bar. */
function refusalsOf(decisions, records) {
  const at = new Map();
  for (const rec of records || []) {
    const t = Date.parse(rec && rec.bar);
    if (!Number.isFinite(t)) continue;
    const k = `${rec.root}|${t}`;
    const skills = at.get(k) || new Set();
    for (const r of Array.isArray(rec.reads) ? rec.reads : []) {
      const s = skillOfRead(r && r.step, r && r.read) || (r && r.skill);
      if (s) skills.add(s);
    }
    at.set(k, skills);
  }
  return (decisions || []).filter(d => d.category === 'wrong stated reason' && !ENTRY.has(d.actual && d.actual.action)).map(d => ({
    key: d.key,
    skills: [...(at.get(`${familyRoot(String(d.symbol || ''))}|${Date.parse(d.barT)}`) || [])].sort(),
    falseReasons: d.falseReasons || [],
  }));
}

function findingsFrom({ skills = [], refusals = [], exists = () => true, max = 8 } = {}) {
  const probed = s => s && !NOT_PROBED.has(s) && exists(s);
  const rows = new Map();
  const row = s => rows.get(s) || rows.set(s, { skill: s, items: [] }).get(s);
  for (const s of skills.filter(x => probed(x.skill))) {
    if (s.wrong > 0) row(s.skill).items.push({ kind: 'misread', count: s.wrong, of: s.reads, detail: s.topRefusals.map(x => `${x.what} (${x.count})`).join('; ') });
    if (s.missed > 0) row(s.skill).items.push({ kind: 'missed', count: s.missed, of: s.relevant, detail: s.topMissed.map(x => `${x.what} (${x.count})`).join('; ') });
  }
  const bySkill = new Map();
  for (const r of refusals) {
    const owners = r.skills.filter(probed);
    for (const s of owners.length ? owners : [null]) bySkill.set(s, [...(bySkill.get(s) || []), r]);
  }
  for (const [s, list] of bySkill) {
    const reasons = [...new Set(list.flatMap(r => r.falseReasons))].slice(0, 2).join('; ');
    row(s).items.push({ kind: 'wrong-reason refusal', count: list.length, of: null, detail: reasons });
  }
  const total = r => r.items.reduce((n, x) => n + x.count, 0);
  const ranked = [...rows.values()].sort((a, b) => total(b) - total(a) || String(a.skill).localeCompare(String(b.skill)));
  const out = [];
  for (const r of ranked) {
    for (const x of r.items.sort((a, b) => b.count - a.count || FINDING_KINDS.indexOf(a.kind) - FINDING_KINDS.indexOf(b.kind))) out.push({ skill: r.skill, ...x });
  }
  return out.slice(0, max).map((f, i) => ({ id: `F${i + 1}`, ...f, detail: String(f.detail || '').slice(0, 240) }));
}

function findingLine(f) {
  const what = f.kind === 'misread' ? `${f.count} of ${f.of} claimed reads refused` : f.kind === 'missed' ? `missed ${f.count} of ${f.of} times its read was true for the side` : `${f.count} refusal(s) for a reason the facts refute`;
  return `${f.id}. ${f.skill || '(no skill read at the bar)'}: ${f.kind}: ${what}${f.detail ? `. Most often: ${f.detail}` : ''}`;
}

module.exports = { FINDING_KINDS, mergeUsage, refusalsOf, findingsFrom, findingLine };
