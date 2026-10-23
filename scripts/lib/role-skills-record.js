'use strict';

/**
 * Which skills a role the runner ran on its own (cycle-run.js runRole) had, for the cycle log's desk and entry records:
 * detection only, on every harness and model, the roleSkillsInPrompt key on or off. Nothing refuses a report for it.
 *
 *   expected   the role's role-skills (agents/<role>.md)
 *   embedded   the skills its prompt holds whole: Claude Code's role prompt file (roleSkillsInPrompt, role-prompt.js),
 *              opencode's role prompt in its opencode.json; [] otherwise
 *   loaded     the skills its own run loaded (a Skill call, or a skill_lookup whose reply is the skill; in the tool-call
 *              log, a completed one): in its own stream
 *              (`output`, that one run's process: never the head trader's, never another role's), and in the tool-call
 *              log of that run's own session (logs/toolcall/<session>.jsonl, the session from its stream's init event)
 *   had        embedded and loaded;   missing   expected but not had
 *
 *   roleSkills({ root, role, output, home, embedded })   { expected, embedded, loaded, had, missing }
 *   loadedInRun(output, home)                           the skills the run loaded, sorted
 *   skillsMissing(runs)                                 { role: [skills] } of runs ([{ role, skills }]) missing any, or null
 *   withSkillsMissing(runs)                             { skillsMissing } when any, else {}
 *   missingLine(map, what)                              the runner log's line for it ('<what>: roles ran without their skills: ...')
 */

const fs = require('fs');
const path = require('path');
const { skillsInTranscript, claudeLookupsInTranscript, skillName } = require('./trading/skills-loaded');

const SESSION = /^[A-Za-z0-9_-]{1,128}$/;

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

/** The skills a session's tool-call log (scripts/hooks/toolcall.js) shows loaded: a Skill or skill_lookup call completed (its post event). */
function toolcallLoads(home, session) {
  const out = new Set();
  if (!home || !session) return out;
  let text;
  try { text = fs.readFileSync(path.join(home, 'logs', 'toolcall', `${session}.jsonl`), 'utf8'); } catch (_err) { return out; }
  for (const line of text.split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { continue; }
    const call = ev && ev.event === 'post' && ev.call && typeof ev.call === 'object' ? ev.call : null;
    if (!call || call.session !== session || !call.args || typeof call.args !== 'object') continue;
    const name = String(call.name || '');
    const skill = typeof call.args.skill === 'string' ? skillName(call.args.skill) : null;
    if (!skill) continue;
    // A post event is a completed call (PostToolUse); the log keeps a long reply only as its digest, so a lookup's
    // reply can't be read here (the stream's check reads it: claudeLookupsInTranscript).
    if (name === 'Skill' || /(^|__)skill_lookup$/.test(name)) out.add(skill);
  }
  return out;
}

function loadedInRun(output, home) {
  const all = new Set([...skillsInTranscript(output), ...claudeLookupsInTranscript(output), ...toolcallLoads(home, sessionOf(output))]);
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
  return { expected: [...expected], embedded: emb, loaded, had, missing: expected.filter(s => !had.includes(s)) };
}

function skillsMissing(runs) {
  const out = {};
  for (const r of runs || []) {
    const miss = r && r.skills && Array.isArray(r.skills.missing) ? r.skills.missing : [];
    if (r && typeof r.role === 'string' && miss.length) out[r.role] = [...new Set([...(out[r.role] || []), ...miss])];
  }
  return Object.keys(out).length ? out : null;
}

/** { skillsMissing } for a record of these runs when any lacks a skill, else {} (the record as before). */
const withSkillsMissing = runs => { const m = skillsMissing(runs); return m ? { skillsMissing: m } : {}; };

const missingLine =(map, what = 'desk') => (map ? `${what}: roles ran without their skills: ${Object.entries(map).map(([role, s]) => `${role} [${s.join(', ')}]`).join('; ')}` : null);

module.exports = { sessionOf, toolcallLoads, loadedInRun, roleSkills, skillsMissing, withSkillsMissing, missingLine };
