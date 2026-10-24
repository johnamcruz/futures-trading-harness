'use strict';

/**
 * A training-loop edit to a role's definition (agents/<role>.md; Propose-Probe-Compose, docs/TRAINING.md): the body's
 * prose only, isolated and judged exactly as a skill edit is (its own tree, the same replays, seed, halves, screen,
 * compose and keep rule). Code refuses, before anything runs it, an edit that would change what the role is rather than
 * how it reasons:
 *
 *   1. the frontmatter, byte for byte: name, description, tools (so only trade-executor ever holds order-writing tools),
 *      model, role-skills, role-index and timeframe;
 *   2. the body's "Load the skills ..." sentence (opencode.js LOAD_SENTENCE: the one the role-skills test keeps equal to
 *      the two lists), the same text and the same count; no skill named that the role's two lists don't hold (in code,
 *      as "the <name> skill", a hyphenated name written plainly, or a one-word name after a load verb: mentioned);
 *      and no --- block in the body, a second frontmatter;
 *   3. the report formats: every paragraph naming a report format (REPORT_WORDS: the VERDICT and FACTS lines phase
 *      2's parsers read, roles-ran.js verdictOf, approvedSize, decisiveLine; a line starting Size: or naming it in code or
 *      quotes; EXECUTED, ABORTED; PLAN; CYCLE RESULT; and
 *      a verdict word in code or quotes, CODED_WORDS: `APPROVE`, `VETO`, `BLOCK`), every heading and every fenced
 *      block (the output templates) stays as it is, whole, and none is added. Prose that judges (when to VETO, when to
 *      APPROVE) is the role's reasoning, and may be edited: an over-veto is fixed there;
 *   4. the size: the body at most its current bytes plus the growth budget (config/training.json probeEdit.growBytes,
 *      probe-edit.js GROW_BYTES; the PR trims it back), and no number the role's text did not already hold (in digits
 *      or words, probe-edit.js numbers), checked here for every proposal; a probe edit's short lines too (styleErrors);
 *   5. only the roles in EDITABLE_ROLES (the desk's analysts, the risk manager and the executor): never the reviewer,
 *      the researcher or the calendar analyst, and never the head trader, whose fixed text is code (harness-sync.js).
 * The tree is synced after the edit (tree.js prepareTree runs sync-harness), so every harness's adapter carries it.
 *
 *   EDITABLE_ROLES, REPORT_WORDS, CODED_WORDS, AGENT_FILE
 *   roleOfFile(file)                        the role an agents/<role>.md path names, or null
 *   protectedParts(text)                    { frontmatter, load: [sentence], lines: [block] }: what an edit may not change
 *   agentEditErrors(file, before, after, { skillNames })   [error]: the guards above, on one file's text before and after
 */

// The load sentence's pattern is opencode.js's own (read when a role is checked: opencode.js loads the tool registry).
const loads = () => new RegExp(require('../opencode').LOAD_SENTENCE.source, 'g');
const { parseFrontmatter } = require('../frontmatter');

const EDITABLE_ROLES = Object.freeze(['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager', 'trade-executor']);
const REPORT_WORDS = Object.freeze(['VERDICT', 'FACTS', 'EXECUTED', 'ABORTED', 'PLAN', 'CYCLE RESULT']);
const CODED_WORDS = Object.freeze(['APPROVE', 'VETO', 'BLOCK']);
const AGENT_FILE = /^agents\/([a-z0-9-]+)\.md$/;
const FRONTMATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const wordsRe = words => new RegExp(`\\b(?:${words.map(w => w.replace(' ', '\\s+')).join('|')})\\b`);
const WORD = wordsRe(REPORT_WORDS);
const CODED = wordsRe([...REPORT_WORDS, ...CODED_WORDS]);
// phase 2's Size line (roles-ran.js approvedSize reads a line starting `Size:`), case-sensitive: a line that starts
// with it, or one that names it in code or quotes (the rule for its format).
const SIZE_LINE = /^\s*(?:[-*]\s+)?`?Size:/;
const SIZE_NAMED = /\bSize:/;
/** A line names a report format: a report word anywhere, the Size line, or a verdict word or Size: inside a code span or quotes. */
const namesFormat = line => WORD.test(line) || SIZE_LINE.test(line) || [...line.matchAll(/`([^`]*)`|"([^"]*)"/g)].some(m => CODED.test(m[1] || m[2] || '') || SIZE_NAMED.test(m[1] || m[2] || ''));

function roleOfFile(file) {
  const m = AGENT_FILE.exec(String(file));
  return m && EDITABLE_ROLES.includes(m[1]) ? m[1] : null;
}

/**
 * The parts of an agent's text an edit may never change: its frontmatter, its load sentences, and its format blocks:
 * every heading, every fenced block, and every paragraph (a run of non-blank lines) naming a report format, whole, so
 * the rules that sit beside a format line (phase 2's "anything else reads as a veto" list) stay with it.
 */
function protectedParts(text) {
  const s = String(text);
  const fm = FRONTMATTER.exec(s);
  const frontmatter = fm ? fm[0] : '';
  const body = s.slice(frontmatter.length);
  const lines = [];
  let fence = null;
  let para = [];
  const endPara = () => {
    if (para.some(namesFormat)) lines.push(para.join('\n'));
    para = [];
  };
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (fence !== null) {
      fence.push(line);
      if (t.startsWith('```')) { lines.push(fence.join('\n')); fence = null; }
      continue;
    }
    if (t.startsWith('```')) { endPara(); fence = [line]; continue; }
    if (/^#{1,6}\s/.test(t)) { endPara(); lines.push(line); continue; }
    if (!t) { endPara(); continue; }
    para.push(line);
  }
  endPara();
  if (fence !== null) lines.push(fence.join('\n'));
  return { frontmatter, load: [...body.matchAll(loads())].map(m => m[0]), lines };
}

const listOf = v => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]);

// A load verb before a plain one-word skill name ("Read absorption first"): only then is a one-word name a mention, so
// prose that uses the word ("a rejection candle") never counts as one.
const LOAD_VERB = '(?:read|load|use|see|follow|consult|apply|check|look\\s+up)';
// Skill names are [a-z0-9-] (skill-names test): only the hyphen needs no escape; none of them holds a regex character.
const escape = s => s.replace(/[^a-z0-9-]/g, '');

/**
 * Skill names a text mentions: in backticks, as "the <name> skill", a hyphenated name written plainly (word-bounded:
 * a hyphenated catalog name is never ordinary prose), or a one-word name right after a load verb ("read", "use", ...,
 * with an optional "the"), any case.
 */
function mentioned(text, skillNames) {
  const known = new Set(skillNames);
  const t = String(text);
  const out = new Set();
  for (const m of t.matchAll(/`([a-z0-9-]+)`|\bthe ([a-z0-9-]+) skill\b/g)) {
    const n = m[1] || m[2];
    if (known.has(n)) out.add(n);
  }
  for (const n of known) {
    if (out.has(n)) continue;
    const plain = n.includes('-') ? new RegExp(`(?:^|[^a-z0-9-])${escape(n)}(?:[^a-z0-9-]|$)`, 'i') : new RegExp(`\\b${LOAD_VERB}\\s+(?:the\\s+)?${escape(n)}\\b`, 'i');
    if (plain.test(t)) out.add(n);
  }
  return out;
}

/** The lines of a body that open a frontmatter-like block (a line of only ---). */
const fenceLines = body => String(body).split('\n').filter(l => /^\s*---\s*$/.test(l)).length;

function agentEditErrors(file, before, after, { skillNames = [] } = {}) {
  const role = roleOfFile(file);
  if (!role) return [`${file}: not a role a proposal may edit (${EDITABLE_ROLES.map(r => `agents/${r}.md`).join(', ')})`];
  const errors = [];
  const a = protectedParts(before);
  const b = protectedParts(after);
  if (a.frontmatter !== b.frontmatter) errors.push(`${file}: the frontmatter (name, description, tools, model, role-skills, role-index) is never a proposal's to change`);
  if (JSON.stringify(a.load) !== JSON.stringify(b.load)) errors.push(`${file}: the "Load the skills ..." sentence is never a proposal's to change (it equals the role-skills and role-index lists)`);
  if (JSON.stringify(a.lines) !== JSON.stringify(b.lines)) errors.push(`${file}: report formats stay as they are: no paragraph naming ${REPORT_WORDS.join(', ')} (or ${CODED_WORDS.join(', ')} in code or quotes), no heading and no fenced block is changed, removed or added`);
  let lists = new Set();
  try {
    const d = parseFrontmatter(String(before)).data;
    lists = new Set([...listOf(d['role-skills']), ...listOf(d['role-index'])]);
  } catch (_err) { /* no frontmatter: every named skill is new to the role */ }
  const had = mentioned(before, skillNames);
  const added = [...mentioned(after, skillNames)].filter(n => !had.has(n) && !lists.has(n));
  const PE = require('./probe-edit');
  const grown = PE.bodyBytes(after) - PE.bodyBytes(before);
  if (grown > PE.GROW_BYTES) errors.push(`${file}: the body would grow ${grown} bytes, more than ${PE.GROW_BYTES} (a role's prompt grows only by the budget; the PR trims it back)`);
  const hadNumbers = PE.numbers(before);
  const newNumbers = [...PE.numbers(after)].filter(x => !hadNumbers.has(x));
  if (newNumbers.length) errors.push(`${file}: no new numbers in a role: the edit adds ${newNumbers.join(', ')}`);
  // No second frontmatter-like block in the body: a reader could take its keys for the role's.
  if (fenceLines(String(after).slice(b.frontmatter.length)) > fenceLines(String(before).slice(a.frontmatter.length))) errors.push(`${file}: no --- block in the body (a second frontmatter); its frontmatter is the one at the top`);
  if (added.length) errors.push(`${file}: names skill(s) the role doesn't load (${added.join(', ')}): its skills are its frontmatter's lists, the owner's to change`);
  return errors;
}

module.exports = { EDITABLE_ROLES, REPORT_WORDS, CODED_WORDS, AGENT_FILE, roleOfFile, protectedParts, agentEditErrors };
