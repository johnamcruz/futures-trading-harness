'use strict';

/**
 * A probe edit (Propose-Probe-Compose, docs/TRAINING.md): one small skill edit the proposer writes for one finding of
 * a stage-1 run's skill-usage report, tagged with what it is: { skill, finding, kind }. The proposer writes it on one
 * PROPOSAL line, the proposal's own fields (proposal.js) plus `tag`. Code checks it before anything runs it:
 *
 * - the tag: the skill the edit changes, a finding id the round listed (a finding that names a skill: that skill), and
 *   one of KINDS (rewording, example, rule, removal);
 * - the edits: every one in that skill's SKILL.md (proposal.js validateProposal runs as well);
 * - the owner's style: no number the found text did not already hold, in digits or in words (NUMBER_WORDS: "two",
 *   "half", "three bars"); each new line short (at most MAX_LINE characters, the condition -> action list the prompt
 *   asks for); a removal shrinks the text it replaces; the skill's body stays within its byte cap (skill-caps.js, the
 *   one source the basics-skills test reads too; a skill already over it may not grow);
 * - the frontmatter (name, description) is never edited: no find may reach into it, and it reads the same after.
 *
 *   KINDS, MAX_LINE, NUMBER_WORDS
 *   splitTagged(raw)                         { tag, proposal }: a PROPOSAL object split into its tag and the proposal
 *   tagErrors(tag, proposal, { findings })   [error]
 *   styleErrors(proposal, { root, kind })    [error]
 *   numbers(text)                            the numbers a text states, digits and number words (lower case)
 *   bodyBytes(text)                          the bytes of a skill's body (after its frontmatter)
 *   frontmatterEnd(text)                     where the frontmatter block ends (0: none)
 */

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../frontmatter');
const { skillByteCap } = require('../skill-caps');

const KINDS = Object.freeze(['rewording', 'example', 'rule', 'removal']);
const MAX_LINE = 120;
// A count or a share in words is a number too ("wait three bars", "half the range"). "one" is left out: it is mostly
// a pronoun ("the one that", "no one"), and a lone "one" adds no threshold the text did not have.
const NUMBER_WORDS = Object.freeze(['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'twenty', 'thirty', 'forty', 'fifty', 'hundred', 'thousand', 'half', 'halves', 'quarter', 'quarters', 'third', 'thirds',
  'twice', 'thrice', 'double', 'triple', 'dozen', 'percent']);
const WORD = new RegExp(`\\b(?:${NUMBER_WORDS.join('|')})\\b`, 'gi');
const FRONTMATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const SKILL_FILE = /^skills\/([a-z0-9-]+)\/SKILL\.md$/;

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function splitTagged(raw) {
  if (!isObj(raw)) return { tag: null, proposal: raw };
  const { tag = null, ...proposal } = raw;
  return { tag, proposal };
}

function tagErrors(tag, proposal, { findings = [] } = {}) {
  if (!isObj(tag)) return ['tag: { skill, finding, kind }: what the edit changes, the finding it addresses, its kind'];
  const errors = [];
  const extra = Object.keys(tag).filter(k => !['skill', 'finding', 'kind'].includes(k));
  if (extra.length) errors.push(`tag: unknown keys: ${extra.join(', ')}`);
  if (!KINDS.includes(tag.kind)) errors.push(`tag.kind: one of ${KINDS.join(', ')}`);
  const finding = findings.find(f => f.id === tag.finding);
  if (!finding) errors.push(`tag.finding: one of the round's findings (${findings.map(f => f.id).join(', ') || 'none'})`);
  if (typeof tag.skill !== 'string' || !/^[a-z0-9-]+$/.test(tag.skill)) errors.push('tag.skill: the skill the edit changes');
  else if (finding && finding.skill && finding.skill !== tag.skill) errors.push(`tag.skill: finding ${finding.id} is about ${finding.skill}, not ${tag.skill}`);
  const edits = isObj(proposal) && Array.isArray(proposal.edits) ? proposal.edits : [];
  const files = [...new Set(edits.map(e => (isObj(e) ? e.file : null)))];
  if (files.length !== 1 || files[0] !== `skills/${tag.skill}/SKILL.md`) errors.push(`edits: one skill only, skills/${tag.skill}/SKILL.md (this edits ${files.join(', ') || 'nothing'})`);
  return errors;
}

const numbers = s => new Set([...(String(s).match(/\d+(?:[.,]\d+)?/g) || []), ...(String(s).match(WORD) || []).map(w => w.toLowerCase())]);

function frontmatterEnd(text) {
  const m = FRONTMATTER.exec(String(text));
  return m ? m[0].length : 0;
}

function bodyBytes(text) {
  let body = text;
  try { body = parseFrontmatter(text).body; } catch (_err) { /* no frontmatter: the whole text */ }
  return Buffer.byteLength(body);
}

/** The owner's style, in code: no new numbers, short lines, a removal removes, the frontmatter untouched, the skill within its byte cap. */
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
    if (!SKILL_FILE.test(String(e.file))) return;
    let text = texts.get(e.file);
    if (text === undefined) {
      try { text = fs.readFileSync(path.join(root, e.file), 'utf8'); } catch (_err) { return; }
      texts.set(e.file, { before: text, after: text });
      text = texts.get(e.file);
    }
    const where = text.after.indexOf(e.find);
    if (where < 0) return;
    // The frontmatter (the skill's name and description: what loads it) is never the edit's: uncapped and unchecked.
    if (where < frontmatterEnd(text.after)) { errors.push(`${at}: the frontmatter is not edited: the find reaches into it`); return; }
    text.after = text.after.replace(e.find, () => e.replace);
  });
  for (const [file, t] of texts) {
    const fm = s => s.slice(0, frontmatterEnd(s));
    if (fm(t.after) !== fm(t.before)) errors.push(`${file}: the frontmatter is not edited: it would read differently`);
    const skill = SKILL_FILE.exec(file)[1];
    const max = skillByteCap(skill);
    const before = bodyBytes(t.before);
    const after = bodyBytes(t.after);
    const cap = Math.max(max, before);
    if (after > cap) errors.push(`${file}: the skill's body would be ${after} bytes, over its cap (${before > max ? `already over ${max}: it may not grow past ${before}` : max})`);
  }
  return errors;
}

module.exports = { KINDS, MAX_LINE, NUMBER_WORDS, splitTagged, tagErrors, styleErrors, numbers, bodyBytes, frontmatterEnd };
