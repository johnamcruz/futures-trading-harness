'use strict';

/**
 * A probe edit (Propose-Probe-Compose, docs/TRAINING.md): one small skill edit the proposer writes for one finding of
 * a stage-1 run's skill-usage report, tagged with what it is: { skill, finding, kind }. The proposer writes it on one
 * PROPOSAL line, the proposal's own fields (proposal.js) plus `tag`. Code checks it before anything runs it:
 *
 * - the tag: the skill the edit changes, a finding id the round listed (a finding that names a skill: that skill), and
 *   one of KINDS (rewording, example, rule, removal);
 * - the edits: every one in that skill's SKILL.md (proposal.js validateProposal runs as well);
 * - the owner's style: no number the found text did not already hold; each new line short (at most MAX_LINE
 *   characters, the condition -> action list the prompt asks for); a removal shrinks the text it replaces; the skill's
 *   body stays within its byte cap (SKILL_BYTES, the basics skills' cap; a skill already over it may not grow).
 *
 *   KINDS, SKILL_BYTES, MAX_LINE
 *   splitTagged(raw)                         { tag, proposal }: a PROPOSAL object split into its tag and the proposal
 *   tagErrors(tag, proposal, { findings })   [error]
 *   styleErrors(proposal, { root, kind })    [error]
 *   bodyBytes(text)                          the bytes of a skill's body (after its frontmatter)
 */

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../frontmatter');

const KINDS = Object.freeze(['rewording', 'example', 'rule', 'removal']);
const SKILL_BYTES = 3400;
const MAX_LINE = 240;
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

const numbers = s => new Set(String(s).match(/\d+(?:[.,]\d+)?/g) || []);

function bodyBytes(text) {
  let body = text;
  try { body = parseFrontmatter(text).body; } catch (_err) { /* no frontmatter: the whole text */ }
  return Buffer.byteLength(body);
}

/** The owner's style, in code: no new numbers, short lines, a removal removes, the skill within its byte cap. */
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
    if (text.after.includes(e.find)) text.after = text.after.replace(e.find, () => e.replace);
  });
  for (const [file, t] of texts) {
    const before = bodyBytes(t.before);
    const after = bodyBytes(t.after);
    const cap = Math.max(SKILL_BYTES, before);
    if (after > cap) errors.push(`${file}: the skill's body would be ${after} bytes, over its cap (${before > SKILL_BYTES ? `already over ${SKILL_BYTES}: it may not grow past ${before}` : SKILL_BYTES})`);
  }
  return errors;
}

module.exports = { KINDS, SKILL_BYTES, MAX_LINE, splitTagged, tagErrors, styleErrors, bodyBytes };
