'use strict';

/**
 * A probe edit (Propose-Probe-Compose, docs/TRAINING.md): one small edit the proposer writes for one finding of a
 * probe round, to one skill or to one desk role's body (agent-edit.js), tagged with what it is: { skill | agent,
 * finding, kind }. The proposer writes it on one PROPOSAL line, the proposal's own fields (proposal.js) plus `tag`.
 * Code checks it before anything runs it:
 *
 * - the tag: exactly one target, the skill or the role the edit changes; a finding id the round listed (a finding that
 *   names a skill or a role: that one; a finding that names neither: any skill or editable role), and one of KINDS
 *   (rewording, example, rule, removal);
 * - the edits: every one in that skill's SKILL.md or that role's agents/<role>.md (proposal.js validateProposal runs as
 *   well, with a role's own guards: agent-edit.js);
 * - the owner's style: no number the found text did not already hold, in digits or in words (NUMBER_WORDS: "two",
 *   "half", "three bars"); each new line short (at most MAX_LINE characters, the condition -> action list the prompt
 *   asks for); a removal shrinks the text it replaces; a skill's body stays within its byte cap (skill-caps.js, the
 *   one source the basics-skills test reads too) plus GROW_BYTES, a role's body within its current size plus
 *   GROW_BYTES (a role has no cap of its own: its prompt is pinned by its tests, so it may only grow by the budget);
 * - the frontmatter is never edited: no find may reach into it, and it reads the same after.
 *
 *   KINDS, MAX_LINE, NUMBER_WORDS, FRACTIONS, GROW_BYTES
 *   splitTagged(raw)                         { tag, proposal }: a PROPOSAL object split into its tag and the proposal
 *   targetOf(tag)                            { kind: 'skill' | 'agent', name, file, label } of a tag, or null
 *   tagErrors(tag, proposal, { findings })   [error]
 *   styleErrors(proposal, { root, kind })    [error]
 *   numbers(text)                            the numbers a text states, digits and number words (lower case)
 *   bodyBytes(text)                          the bytes of a document's body (after its frontmatter)
 *   frontmatterEnd(text)                     where the frontmatter block ends (0: none)
 */

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../frontmatter');
const { skillByteCap } = require('../skill-caps');
const { roleOfFile, EDITABLE_ROLES } = require('./agent-edit');

const KINDS = Object.freeze(['rewording', 'example', 'rule', 'removal']);
const MAX_LINE = require('../tunables').training().probeEdit.maxLine; // config/training.json
// An edit may grow its document by at most this many bytes past its cap (or past its size, when already over it, and
// always past its size for a role): room for the rule or example a misread needs. Only an edit that helps is kept, and
// its PR trims the bytes back (the owner's rule that no role prompt grows, met at merge). config/training.json
// probeEdit.growBytes.
const GROW_BYTES = require('../tunables').training().probeEdit.growBytes;
// A count or a share in words is a number too ("wait three bars", "half the range"). "one" is left out: it is mostly
// a pronoun ("the one that", "no one"), and a lone "one" adds no threshold the text did not have.
const NUMBER_WORDS = Object.freeze(['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'twenty', 'thirty', 'forty', 'fifty', 'hundred', 'thousand', 'half', 'halves', 'quarter', 'quarters', 'third', 'thirds',
  'twice', 'thrice', 'double', 'triple', 'dozen', 'percent', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'fourths', 'fifths', 'single']);
// A count in other scripts: a vulgar fraction (½, ⅓, ...) and a roman numeral of two letters or more (a lone I, V or X
// is mostly a pronoun or a label, as "one" is left out above).
const FRACTIONS = /[\u00BC-\u00BE\u2150-\u215E]/g;
const ROMAN = /\b(?:I{2,3}|IV|VI{1,3}|IX|XI{1,3}|XIV|XV|XX)\b/g;
const WORD = new RegExp(`\\b(?:${NUMBER_WORDS.join('|')})\\b`, 'gi');
const FRONTMATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const SKILL_FILE = /^skills\/([a-z0-9-]+)\/SKILL\.md$/;
const NAME = /^[a-z0-9-]+$/;

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function splitTagged(raw) {
  if (!isObj(raw)) return { tag: null, proposal: raw };
  const { tag = null, ...proposal } = raw;
  return { tag, proposal };
}

/** The document a tag targets: a skill ({ skill }) or a desk role ({ agent }), never both; null when neither is valid. */
function targetOf(tag) {
  if (!isObj(tag)) return null;
  const hasSkill = tag.skill !== undefined;
  const hasAgent = tag.agent !== undefined;
  if (hasSkill === hasAgent) return null;
  if (hasSkill) return typeof tag.skill === 'string' && NAME.test(tag.skill) ? { kind: 'skill', name: tag.skill, file: `skills/${tag.skill}/SKILL.md`, label: tag.skill } : null;
  return typeof tag.agent === 'string' && roleOfFile(`agents/${tag.agent}.md`) ? { kind: 'agent', name: tag.agent, file: `agents/${tag.agent}.md`, label: `agent ${tag.agent}` } : null;
}

function tagErrors(tag, proposal, { findings = [] } = {}) {
  if (!isObj(tag)) return ['tag: { skill or agent, finding, kind }: what the edit changes, the finding it addresses, its kind'];
  const errors = [];
  const extra = Object.keys(tag).filter(k => !['skill', 'agent', 'finding', 'kind'].includes(k));
  if (extra.length) errors.push(`tag: unknown keys: ${extra.join(', ')}`);
  if (!KINDS.includes(tag.kind)) errors.push(`tag.kind: one of ${KINDS.join(', ')}`);
  const finding = findings.find(f => f.id === tag.finding);
  if (!finding) errors.push(`tag.finding: one of the round's findings (${findings.map(f => f.id).join(', ') || 'none'})`);
  const target = targetOf(tag);
  if (!target) {
    errors.push(tag.skill !== undefined && tag.agent !== undefined ? 'tag: one target, the skill or the agent the edit changes, not both'
      : tag.agent !== undefined ? `tag.agent: one of ${EDITABLE_ROLES.join(', ')}` : 'tag.skill: the skill the edit changes (or tag.agent: the desk role)');
  } else if (finding) {
    // A finding that names its owner: only that skill or role. One that names neither: any of them.
    const owner = finding.skill ? { kind: 'skill', name: finding.skill } : finding.agent ? { kind: 'agent', name: finding.agent } : null;
    if (owner && !(owner.kind === target.kind && owner.name === target.name)) errors.push(`tag.${target.kind}: finding ${finding.id} is about ${owner.kind === 'agent' ? `agent ${owner.name}` : owner.name}, not ${target.label}`);
  }
  const edits = isObj(proposal) && Array.isArray(proposal.edits) ? proposal.edits : [];
  const files = [...new Set(edits.map(e => (isObj(e) ? e.file : null)))];
  const want = target ? target.file : null;
  if (want && (files.length !== 1 || files[0] !== want)) errors.push(`edits: one document only, ${want} (this edits ${files.join(', ') || 'nothing'})`);
  return errors;
}

const numbers = s => new Set([...(String(s).match(/\d+(?:[.,]\d+)?/g) || []), ...(String(s).match(WORD) || []).map(w => w.toLowerCase()), ...(String(s).match(FRACTIONS) || []), ...(String(s).match(ROMAN) || [])]);

function frontmatterEnd(text) {
  const m = FRONTMATTER.exec(String(text));
  return m ? m[0].length : 0;
}

function bodyBytes(text) {
  let body = text;
  try { body = parseFrontmatter(text).body; } catch (_err) { /* no frontmatter: the whole text */ }
  return Buffer.byteLength(body);
}

/** The most bytes a document's body may hold after an edit: a skill's cap (or its size, when over), a role's size; plus GROW_BYTES. */
function capOf(file, before) {
  const skill = SKILL_FILE.exec(file);
  return skill ? { max: Math.max(skillByteCap(skill[1]), before) + GROW_BYTES, cap: skillByteCap(skill[1]) } : { max: before + GROW_BYTES, cap: null };
}

/** The owner's style, in code: no new numbers, short lines, a removal removes, the frontmatter untouched, the document within its budget. */
function styleErrors(proposal, { root, kind = null } = {}) {
  const errors = [];
  const edits = isObj(proposal) && Array.isArray(proposal.edits) ? proposal.edits.filter(isObj) : [];
  const texts = new Map();
  edits.forEach((e, i) => {
    const at = `edits[${i}]`;
    if (typeof e.find !== 'string' || typeof e.replace !== 'string') return;
    const had = numbers(e.find);
    const added = [...numbers(e.replace)].filter(x => !had.has(x));
    if (added.length) errors.push(`${at}: no numbers: the edit adds ${added.join(', ')}`);
    const long = e.replace.split('\n').filter(l => l.length > MAX_LINE);
    if (long.length) errors.push(`${at}: short condition -> action lines: ${long.length} line(s) over ${MAX_LINE} characters`);
    if (kind === 'removal' && e.replace.length >= e.find.length) errors.push(`${at}: a removal shrinks the text it replaces`);
    if (!SKILL_FILE.test(String(e.file)) && !roleOfFile(e.file)) return;
    let text = texts.get(e.file);
    if (text === undefined) {
      try { text = fs.readFileSync(path.join(root, e.file), 'utf8'); } catch (_err) { return; }
      texts.set(e.file, { before: text, after: text });
      text = texts.get(e.file);
    }
    const where = text.after.indexOf(e.find);
    if (where < 0) return;
    // The frontmatter (a skill's name and description, a role's tools and skill lists) is never the edit's.
    if (where < frontmatterEnd(text.after)) { errors.push(`${at}: the frontmatter is not edited: the find reaches into it`); return; }
    text.after = text.after.replace(e.find, () => e.replace);
  });
  for (const [file, t] of texts) {
    const fm = s => s.slice(0, frontmatterEnd(s));
    if (fm(t.after) !== fm(t.before)) errors.push(`${file}: the frontmatter is not edited: it would read differently`);
    const before = bodyBytes(t.before);
    const after = bodyBytes(t.after);
    const { max, cap } = capOf(file, before);
    if (after > max) {
      const why = cap === null ? `a role grows at most ${GROW_BYTES} past its ${before}` : before > cap ? `already over ${cap}: it may grow at most ${GROW_BYTES} past ${before}` : `${cap} + ${GROW_BYTES}`;
      errors.push(`${file}: the body would be ${after} bytes, over its cap (${why})`);
    }
  }
  return errors;
}

module.exports = { KINDS, MAX_LINE, GROW_BYTES, NUMBER_WORDS, FRACTIONS, splitTagged, targetOf, tagErrors, styleErrors, numbers, bodyBytes, frontmatterEnd };
