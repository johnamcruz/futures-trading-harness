'use strict';

/**
 * How a role's skills reach its embedded prompt (opencode's role prompts, scripts/lib/opencode.js). A role names
 * two lists in its frontmatter; together they equal its body's "Load the skills ..." sentence, which every adapter
 * that reads the body (Claude Code, Codex, Qwen Code) follows as before:
 *
 *   role-skills   its core: the skills it uses every call
 *   role-index    the skills it reads only when a cycle needs one (index mode)
 *
 * The switch FTH_ROLE_SKILLS picks the mode (sync-harness generates for it; the runner and the order gate read it):
 *
 *   index   (the default) the core embedded in full; the index as one line per skill (its name and description),
 *           read whole with the harness tool skill_lookup only when the cycle needs it; the load sentence becomes two
 *           (the core below; "Look up as needed: ..." for the index)
 *   full    (on request, FTH_ROLE_SKILLS=full) every skill of both lists embedded in full
 *
 * In index mode the situational skills (trading/skills-loaded.js SITUATIONAL) a role's index lists are required
 * when the cycle's bar briefing triggers them: the role's report counts for an entry only once it looked the
 * skill up in the call that reported (trading/skill-lookups.js). Other adapters (Claude Code, Codex, Qwen Code)
 * load the skills themselves, as the body says.
 *
 *   DEFAULT_MODE                         'index' (FTH_ROLE_SKILLS unset or blank)
 *   modeOf(env)                          'index' | 'full' (throws on another value)
 *   skillPlan(agent, docs, mode)         { mode, docs, indexed, required } for the role's prompt
 *   loadRoles(root)                      agents/*.md as { name, skills, index, tools, body }
 *   requiredByRole(root, mode)           Map role -> [{ skill, when: [trigger] }] (index mode only; else empty)
 *   planErrors(agents, skillNames)       problems with the two lists, [] when sound
 */

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./frontmatter');
const { SITUATIONAL, parseTrigger } = require('./trading/skills-loaded');

const SWITCH = 'FTH_ROLE_SKILLS';
const MODES = ['full', 'index'];
const DEFAULT_MODE = 'index';

function modeOf(env = process.env) {
  const v = String(env[SWITCH] || '').trim();
  if (!v) return DEFAULT_MODE;
  if (!MODES.includes(v)) throw new Error(`${SWITCH}: one of ${MODES.join(', ')} (got "${v}")`);
  return v;
}

const asList = v => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

/** The situational lookups of an index: [{ skill, when: [trigger] }]. */
const requiredOf = (index, table = SITUATIONAL) => index
  // An entry taught in a skill (`taughtIn`) or marked `headOnly` is the head trader's alone (skills-loaded.js): no role's.
  .map(skill => ({ skill, when: table.filter(e => e.skill === skill && !e.taughtIn && !e.headOnly).map(e => parseTrigger(e.when)) }))
  .filter(r => r.when.length);

/**
 * What a role's prompt embeds. `docs`: its skills, core and index, as { name, body, description }. Full: every one
 * embedded. Index: the core embedded, the index listed ({ name, description }), with its required lookups.
 */
function skillPlan(agent, docs, mode) {
  const index = agent.index || [];
  if (mode !== 'index' || !index.length) return { mode, docs: docs.map(d => ({ name: d.name, body: d.body })), indexed: [], required: [] };
  return {
    mode,
    docs: docs.filter(d => !index.includes(d.name)).map(d => ({ name: d.name, body: d.body })),
    indexed: docs.filter(d => index.includes(d.name)).map(d => ({ name: d.name, description: d.description })),
    required: requiredOf(index),
  };
}

/** agents/*.md as { name, file, skills (role-skills), index (role-index), tools, body }. */
function loadRoles(root) {
  const dir = path.join(root, 'agents');
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => {
    const { data, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { name: data.name, file: f, skills: asList(data['role-skills']), index: asList(data['role-index']), tools: String(data.tools || '').split(',').map(t => t.trim()).filter(Boolean), body: body.trim() };
  });
}

/** The skills each role must look up in index mode when their triggers fire: Map role -> [{ skill, when }]. */
function requiredByRole(root, mode) {
  const out = new Map();
  if (mode !== 'index') return out;
  for (const a of loadRoles(root)) {
    const req = requiredOf(a.index);
    if (req.length) out.set(a.name, req);
  }
  return out;
}

/**
 * Problems with the agents' role-index (a skill that doesn't exist, one in both lists, no skill_lookup tool) and the
 * SITUATIONAL table (a skill that doesn't exist; with `strategyNames`, a candidate.name trigger naming no strategy).
 */
function planErrors(agents, skillNames, strategyNames = null) {
  const errors = [];
  for (const a of agents) {
    const index = a.index || [];
    for (const s of index) {
      if (!skillNames.includes(s)) errors.push(`agents/${a.file}: role-index skill "${s}" has no skills/${s}/SKILL.md`);
      if (a.skills.includes(s)) errors.push(`agents/${a.file}: "${s}" is in both role-skills and role-index`);
    }
    if (index.length && !a.tools.includes('mcp__harness__skill_lookup')) errors.push(`agents/${a.file}: a role-index needs the tool mcp__harness__skill_lookup`);
  }
  for (const e of SITUATIONAL) {
    if (!skillNames.includes(e.skill)) errors.push(`skills-loaded SITUATIONAL: no skill "${e.skill}"`);
    const t = parseTrigger(e.when);
    if (strategyNames && t.key === 'candidate.name' && !strategyNames.includes(t.value)) errors.push(`skills-loaded SITUATIONAL: "${e.when}" names no strategy (strategies/${t.value}/STRATEGY.md)`);
  }
  return errors;
}

module.exports = { SWITCH, MODES, DEFAULT_MODE, SITUATIONAL, modeOf, requiredOf, skillPlan, loadRoles, requiredByRole, planErrors };
