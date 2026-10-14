'use strict';

/**
 * A whole skill by name (scripts/skill-lookup.js; the harness tool skill_lookup): what a role's prompt lists in
 * its skill index instead of embedding (role-skills.js, the default, FTH_ROLE_SKILLS not full). Read-only over the harness's own
 * skills/ folder: a name that isn't a skill there, a path, or a skill that leads outside it (a symlink) is
 * refused. With `role`, inside an autonomous cycle the lookup is recorded for the order gate
 * (trading/skill-lookups.js): in index mode a role's report counts only with the lookups its bar requires.
 *
 *   skill_lookup { skill, role }   skill: a skill's folder name; role: the asking role's name (optional)
 */

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../frontmatter');
const { recordLookup } = require('../trading/skill-lookups');
const { context } = require('./cli');

const USAGE = 'usage: skill-lookup.js --skill <name> [--role <role>]';
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The skill's SKILL.md inside <root>/skills (no symlink out of it), or throws. */
function skillFile(root, skill) {
  if (!NAME.test(String(skill || ''))) throw new Error(`--skill: a skill's name, e.g. fair-value-gaps (${USAGE})`);
  const dir = fs.realpathSync(path.join(root, 'skills'));
  const want = path.join(dir, skill, 'SKILL.md');
  let real;
  try {
    real = fs.realpathSync(want);
  } catch (err) {
    throw new Error(`no skill "${skill}" (skills/<name>/SKILL.md)`, { cause: err });
  }
  if (real !== want) throw new Error(`skill "${skill}" is not a file under skills/: refused`);
  return real;
}

function skillLookup({ skill = null, role = null } = {}, ctx) {
  const c = context(ctx);
  if (role !== null && !NAME.test(String(role))) throw new Error(`--role: a role's name, e.g. risk-manager (${USAGE})`);
  const { data, body } = parseFrontmatter(fs.readFileSync(skillFile(c.root, skill), 'utf8'));
  // Recorded only once the skill was read: a refused lookup was never read.
  if (role) recordLookup(c.env, { role, skill }, (ctx && typeof ctx.wallNow === 'function' ? ctx.wallNow() : Date.now()));
  return { text: `<skill name="${data.name || skill}">\n${body.trim()}\n</skill>\n` };
}

/** argv to { skill, role }. */
function parseArgv(argv) {
  const o = { skill: null, role: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const val = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--skill') o.skill = val();
    else if (flag === '--role') o.role = val();
    else throw new Error(`unknown argument: ${argv[i]} (${USAGE})`);
  }
  return o;
}

const OPS = { skill_lookup: skillLookup };

module.exports = { OPS, USAGE, skillLookup, skillFile, parseArgv };
