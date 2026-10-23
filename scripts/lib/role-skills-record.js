'use strict';

/**
 * Which skills a role the runner ran on its own (cycle-run.js runRole) had, for the cycle log's desk and entry records:
 * detection only, on every harness and model, the roleSkillsInPrompt key on or off. Nothing refuses a report for it,
 * and the order gate's own rule (trading/skills-loaded.js) is not this one.
 *
 *   expected   the role's role-skills (agents/<role>.md)
 *   embedded   the skills its prompt holds whole: Claude Code's role prompt file (roleSkillsInPrompt, role-prompt.js),
 *              opencode's role prompt in its opencode.json; [] otherwise
 *   loaded     the skills its own run loaded, from its own stream (`output`, that one run's process: never the head
 *              trader's, never another role's). A Claude Code stream (it has an init event): a Skill call answered
 *              without an error, or a skill_lookup whose reply is the skill, the session's own (a subagent's, with
 *              parent_tool_use_id or a sidechain, is not); and a Skill call its own session's tool-call log
 *              (logs/toolcall/<session>.jsonl) shows completed (a post event). Any other stream (opencode's): its
 *              completed skill and skill_lookup calls (skills-loaded.js skillsInTranscript)
 *   had        embedded and loaded;   missing   expected but not had
 *   reloaded   embedded and loaded too: a role loading a skill its prompt already holds (with roleSkillsInPrompt, a sign
 *              its prompt addition wasn't seen)
 *
 *   roleSkills({ root, role, output, home, embedded })   { expected, embedded, loaded, had, missing, reloaded }
 *   loadedInRun(output, home)                           the skills the run loaded, sorted
 *   skillsMissing(runs) / skillsReloaded(runs)          { role: [skills] } of runs ([{ role, skills }]) with any, or null
 *   withSkillsMissing(runs)                             { skillsMissing, skillsReloaded } as they have any, else {}
 *   perRole(runs)                                       { role: skills record } of the runs that have one, or null
 *   missingLine(map, what) / reloadedLine(map, what)    the runner log's lines for them
 */

const fs = require('fs');
const path = require('path');
const { skillsInTranscript, claudeLookupsInTranscript, skillName } = require('./trading/skills-loaded');

const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const isId = v => typeof v === 'string' && v.length > 0;

/** A Claude Code stream's session id (its first `system` init event), or null. */
function sessionOf(output) {
  for (const line of String(output || '').split('\n')) {
    if (!line.includes('"init"')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { continue; }
    if (ev && ev.type === 'system' && ev.subtype === 'init') return typeof ev.session_id === 'string' && SESSION.test(ev.session_id) ? ev.session_id : null;
  }
  return null;
}

/** A Claude Code stream's Skill loads: each Skill call of the session's own answered by a tool_result that isn't an error. */
function claudeSkillLoads(output) {
  const out = new Set();
  const asked = new Map(); // tool_use id -> skill
  for (const line of String(output || '').split('\n')) {
    if (!line.includes('Skill') && !line.includes('tool_result')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { continue; }
    if (!ev || typeof ev !== 'object' || ev.parent_tool_use_id || ev.isSidechain === true) continue;
    const content = ev.message && typeof ev.message === 'object' && Array.isArray(ev.message.content) ? ev.message.content : [];
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'tool_use' && c.name === 'Skill' && isId(c.id) && c.input) {
        const s = skillName(c.input.skill || c.input.command);
        if (s) asked.set(c.id, s);
      }
      if (c.type === 'tool_result' && isId(c.tool_use_id) && asked.has(c.tool_use_id)) {
        if (c.is_error !== true) out.add(asked.get(c.tool_use_id));
        asked.delete(c.tool_use_id);
      }
    }
  }
  return out;
}

/** The Skill calls a session's tool-call log (scripts/hooks/toolcall.js) shows completed (a post event: PostToolUse). */
function toolcallLoads(home, session) {
  const out = new Set();
  if (!home || !session) return out;
  let text;
  try { text = fs.readFileSync(path.join(home, 'logs', 'toolcall', `${session}.jsonl`), 'utf8'); } catch (_err) { return out; }
  for (const line of text.split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { continue; }
    const call = ev && ev.event === 'post' && ev.call && typeof ev.call === 'object' ? ev.call : null;
    if (!call || call.session !== session || call.name !== 'Skill' || !call.args || typeof call.args !== 'object') continue;
    // A skill_lookup is never credited from the log: it keeps a long reply only as its digest, so a refusal can't be
    // told from the skill (the stream's check reads the reply: claudeLookupsInTranscript).
    const skill = typeof call.args.skill === 'string' ? skillName(call.args.skill) : null;
    if (skill) out.add(skill);
  }
  return out;
}

function loadedInRun(output, home) {
  const session = sessionOf(output);
  const all = session
    ? new Set([...claudeSkillLoads(output), ...claudeLookupsInTranscript(output), ...toolcallLoads(home, session)])
    : new Set(skillsInTranscript(output));
  all.delete(null);
  return [...all].filter(s => typeof s === 'string' && s).sort();
}

function roleSkills({ root, role, output = '', home = null, embedded = [] }) {
  const expected = (() => {
    try { return (require('./role-skills').loadRoles(root).find(a => a.name === role) || { skills: [] }).skills; } catch (_err) { return []; }
  })();
  const emb = [...new Set((embedded || []).filter(s => typeof s === 'string'))].sort();
  const loaded = loadedInRun(output, home);
  const had = [...new Set([...emb, ...loaded])].sort();
  return { expected: [...expected], embedded: emb, loaded, had, missing: expected.filter(s => !had.includes(s)), reloaded: loaded.filter(s => emb.includes(s)) };
}

const byRole = key => runs => {
  const out = {};
  for (const r of runs || []) {
    const list = r && r.skills && Array.isArray(r.skills[key]) ? r.skills[key] : [];
    if (r && typeof r.role === 'string' && list.length) out[r.role] = [...new Set([...(out[r.role] || []), ...list])];
  }
  return Object.keys(out).length ? out : null;
};
const skillsMissing = byRole('missing');
const skillsReloaded = byRole('reloaded');

/** { skillsMissing, skillsReloaded } for a record of these runs, each only when any role has one, else {} (the record as before). */
function withSkillsMissing(runs) {
  const m = skillsMissing(runs);
  const re = skillsReloaded(runs);
  return { ...(m ? { skillsMissing: m } : {}), ...(re ? { skillsReloaded: re } : {}) };
}

/** Each run's skills record by role (the cycle's summary line keeps the entry's this way, beside its `ran`), or null. */
function perRole(runs) {
  const with_ = (runs || []).filter(r => r && typeof r.role === 'string' && r.skills && typeof r.skills === 'object');
  return with_.length ? Object.fromEntries(with_.map(r => [r.role, r.skills])) : null;
}

const listOf = map => Object.entries(map).map(([role, s]) => `${role} [${s.join(', ')}]`).join('; ');
const missingLine = (map, what = 'desk') => (map ? `${what}: roles ran without their skills: ${listOf(map)}` : null);
const reloadedLine = (map, what = 'desk') => (map ? `${what}: roles loaded skills their prompt addition already holds (was it seen?): ${listOf(map)}` : null);

module.exports = { sessionOf, claudeSkillLoads, toolcallLoads, loadedInRun, roleSkills, skillsMissing, skillsReloaded, withSkillsMissing, perRole, missingLine, reloadedLine };
