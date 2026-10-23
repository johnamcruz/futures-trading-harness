'use strict';

/**
 * A Claude Code role's skills as a system-prompt addition (the runner config's roleSkillsInPrompt, this machine's
 * opt-in: autotrader.js claudeRolesOn). Each role the runner runs on its own (cycle-run.js runRole: the desk's analysts,
 * risk-manager phase 1 and 2, the trade-executor) is given the file with --append-system-prompt-file, so its skills sit in
 * its fixed, cached prefix and never cost a Skill call: what opencode's role prompts get in index mode (role-skills.js,
 * FTH_ROLE_SKILLS index), from the same selection (role-skills.js skillPlan on the role's two lists), so the two can't
 * drift. Its `role-skills` embedded in full, as the same <skill name="..."> text a load returns (head-prompt.js block);
 * its `role-index` one line each, read whole with the harness tool skill_lookup (a role with an index holds it:
 * role-skills.js planErrors, and here). The file holds no cycle data: the same text every cycle, so the prefix stays
 * cacheable. No gate check credits a desk role's skills (the executor's entry checks read the head trader's loads:
 * runner-entry.js appendHeadSkills), so nothing is attested. Without the key nothing of this runs.
 *
 *   ROLE_DIR                         'role-prompt' (in the harness home: the state dir trading sessions can't write)
 *   rolePlan(root, role)             { agent, plan } (skillPlan in index mode), or throws (no such role, an index without skill_lookup)
 *   claudeRoleText(root, role)       the role's prompt addition
 *   claudeRoleFile(home, role, text) <home>/role-prompt/claude-<role>-<sha256>.md
 *   writeClaudeRole(home, root, role)   { file, text }, written (atomically) when missing or different; the role's older ones pruned (the newest kept)
 *   indexedIn(text)                  the skills a prompt addition indexes (its "- <name>: " lines under Your skill index)
 */

const path = require('path');
const HP = require('./head-prompt');
const roleSkills = require('./role-skills');
const { describeTrigger } = require('./trading/skills-loaded');

const ROLE_DIR = 'role-prompt';
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LOOKUP_TOOL = () => `mcp__${require('./harness-tools/registry').SERVER_NAME}__skill_lookup`;
const fileOf = role => new RegExp(`^claude-${role}-[0-9a-f]{64}\\.md$`);
const INDEX_HEAD = '## Your skill index';

function rolePlan(root, role) {
  if (!NAME.test(String(role || ''))) throw new Error(`role-prompt: no role "${role}"`);
  const agent = roleSkills.loadRoles(root).find(a => a.name === role);
  if (!agent) throw new Error(`role-prompt: no role "${role}" (agents/${role}.md)`);
  if (agent.index.length && !agent.tools.includes(LOOKUP_TOOL())) throw new Error(`role-prompt: agents/${agent.file} has a role-index but not the tool ${LOOKUP_TOOL()}`);
  const docs = require('./harness-sync').agentSkills(root, agent);
  return { agent, plan: roleSkills.skillPlan(agent, docs, 'index') };
}

function claudeRoleText(root, role) {
  const { agent, plan } = rolePlan(root, role);
  const call = `\`${LOOKUP_TOOL()} {"skill": "<name>", "role": "${agent.name}"}\``;
  const names = plan.docs.map(d => d.name);
  const lookup = agent.tools.includes(LOOKUP_TOOL());
  const out = [
    `This part of your instructions holds your skills, as the ${agent.name} role (index mode): your role's instructions and the request still apply.`,
    '',
    // The one sentence a role needs: its skills are already loaded, so it never loads them again.
    `${names.length ? `Your skills ${HP.andList(names)} are below, already loaded (Your skills): read them here; don't load them again with the Skill tool, though your instructions say to load them.` : ''}${plan.indexed.length ? ` Look up as needed: ${HP.andList(plan.indexed.map(d => d.name))}, listed in Your skill index below; read one whole with ${call} only when this call needs it.` : lookup ? ` Another skill they name: read it whole with ${call}.` : ''}`.trim(),
    '',
  ];
  if (plan.required.length) {
    out.push('When this bar\'s briefing shows it, look the skill up in this call, before your report:', '',
      ...plan.required.map(r => `- ${r.when.map(describeTrigger).join(', or ')}: \`${r.skill}\``), '');
  }
  if (plan.docs.length) {
    out.push('## Your skills (already loaded)', '',
      `The skills this role uses every call (${names.join(', ')}) are below in full: they are loaded.`, '',
      ...plan.docs.flatMap(d => [HP.block(d.name, d.body), '']));
  }
  if (plan.indexed.length) {
    out.push(INDEX_HEAD, '',
      `Your other skills, not loaded. Read one only when this call's situation needs it: ${call} returns the whole skill. Don't look up what the call doesn't need.`, '',
      ...plan.indexed.map(d => `- ${d.name}: ${d.description}`), '');
  }
  return out.join('\n');
}

const claudeRoleFile = (home, role, text) => path.join(home, ROLE_DIR, `claude-${role}-${HP.sha256(text)}.md`);

function writeClaudeRole(home, root, role) {
  const text = claudeRoleText(root, role);
  const file = claudeRoleFile(home, role, text);
  if (HP.writeAtomic(file, text)) HP.pruneOlder(path.dirname(file), file, fileOf(role));
  return { file, text };
}

/** The skills a prompt addition indexes: its "- <name>: " lines after Your skill index. */
function indexedIn(text) {
  const at = String(text || '').indexOf(`\n${INDEX_HEAD}\n`);
  if (at < 0) return [];
  return [...String(text).slice(at).matchAll(/^- ([a-z0-9][a-z0-9-]{0,63}): /gm)].map(m => m[1]);
}

module.exports = { ROLE_DIR, rolePlan, claudeRoleText, claudeRoleFile, writeClaudeRole, indexedIn };
