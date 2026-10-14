'use strict';

/**
 * A whole skill by name (scripts/skill-lookup.js; the harness tool skill_lookup): what a role's prompt lists in
 * its skill index instead of embedding (role-skills.js, FTH_ROLE_SKILLS=index). Read-only over the harness's own
 * skills/ folder: a name that isn't a skill there, a path, or a skill that leads outside it (a symlink) is
 * refused. With `role`, inside an autonomous cycle the lookup is recorded for the order gate
 * (trading/skill-lookups.js): in index mode a role's report counts only with the lookups its bar requires.
 * Without `skill` it lists every skill instead (the catalog): one line each, its name and its description, sorted,
 * only skills a lookup could read (a symlink out of skills/ is left out); `query` keeps those whose name or
 * description contains it (any case). A listing reads no skill, so it is never recorded.
 *
 *   skill_lookup { skill, role }   skill: a skill's folder name; role: the asking role's name (optional)
 *   skill_lookup { query }         every skill (name: description), or those matching query (optional)
 */

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../frontmatter');
const { recordLookup } = require('../trading/skill-lookups');
const { context } = require('./cli');

const USAGE = 'usage: skill-lookup.js --skill <name> [--role <role>] | [--query <text>]';
const MAX_QUERY = 64;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The skill's SKILL.md inside <root>/skills (no symlink out of it), or throws. */
function skillFile(root, skill) {
  if (!NAME.test(String(skill || ''))) throw new Error(`--skill: a skill's name, e.g. liquidity-concepts (${USAGE})`);
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

/** Every skill a lookup could read, as [{ name, description }] sorted by name (description on one line). */
function skillCatalog(root) {
  const dir = fs.realpathSync(path.join(root, 'skills'));
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    let data;
    try {
      ({ data } = parseFrontmatter(fs.readFileSync(skillFile(root, name), 'utf8')));
    } catch (_err) {
      continue; // not a skill a lookup would read (a bad name, no SKILL.md, a symlink out, bad frontmatter): not listed
    }
    out.push({ name, description: String(data.description || '').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/** The catalog as text: a head line, then one line per skill (those matching query, when given). */
function catalogText(root, query) {
  const all = skillCatalog(root);
  const q = query === null ? '' : query.toLowerCase();
  const hits = q ? all.filter(k => k.name.includes(q) || k.description.toLowerCase().includes(q)) : all;
  const head = q ? `Skills matching "${query}" (${hits.length} of ${all.length})` : `Every skill of the harness (${all.length})`;
  if (!hits.length) return { text: `${head}. None: call skill_lookup without query for the whole list.\n` };
  return { text: `${head}; skill_lookup with skill reads one whole:\n${hits.map(k => `- ${k.name}: ${k.description || '(no description)'}`).join('\n')}\n` };
}

function skillLookup({ skill = null, role = null, query = null } = {}, ctx) {
  const c = context(ctx);
  if (role !== null && !NAME.test(String(role))) throw new Error(`--role: a role's name, e.g. risk-manager (${USAGE})`);
  if (query !== null && (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY)) throw new Error(`--query: some text, at most ${MAX_QUERY} characters (${USAGE})`);
  if (skill !== null && query !== null) throw new Error(`--query lists skills; --skill reads one: give one of them (${USAGE})`);
  // No skill: the catalog. It reads no skill, so nothing is recorded for the gate.
  if (skill === null) return catalogText(c.root, query === null ? null : query.trim());
  const { data, body } = parseFrontmatter(fs.readFileSync(skillFile(c.root, skill), 'utf8'));
  // Recorded only once the skill was read: a refused lookup was never read.
  if (role) recordLookup(c.env, { role, skill }, (ctx && typeof ctx.wallNow === 'function' ? ctx.wallNow() : Date.now()));
  return { text: `<skill name="${data.name || skill}">\n${body.trim()}\n</skill>\n` };
}

/** argv to { skill, role, query }. */
function parseArgv(argv) {
  const o = { skill: null, role: null, query: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    // A flag without its value is refused, never read as left out (no --skill would list every skill instead).
    const val = () => {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag}: give its value (${USAGE})`);
      return v;
    };
    if (flag === '--skill') o.skill = val();
    else if (flag === '--role') o.role = val();
    else if (flag === '--query') o.query = val();
    else throw new Error(`unknown argument: ${argv[i]} (${USAGE})`);
  }
  return o;
}

const OPS = { skill_lookup: skillLookup };

module.exports = { OPS, USAGE, skillLookup, skillFile, skillCatalog, parseArgv };
