'use strict';

/**
 * A probe edit's own quiz question (Propose-Probe-Compose, docs/TRAINING.md): test-driven skill editing. The proposer
 * writes the question its edit teaches first, as the edit's `question` (probe-edit.js splitTagged: metadata, never part
 * of the proposal or its id), in the quiz file's shape (config/context-quiz.json, a Part A question): { layer, prompt,
 * text, rule, anchor, required, forbidden } (and `state` or `lookup` as its prompt needs). Code checks it before any
 * model call:
 *
 * - its shape is the quiz file's (eval/context-quiz.js questionErrors), no other key; its id is code's, e-<proposal id>,
 *   never written by the proposer (questionErrors, questionOf), in the probe-proposals phase;
 * - against the two trees' prompts, built for it (the quiz phase, train/quiz-phase.js, before any quiz call): its anchor
 *   is in the edited tree's prompt and NOT in the champion's (an anchor the champion already holds is a question it can
 *   read the answer off: no edit is needed), and it adds no number the champion's prompt does not hold (the edit adds
 *   none, probe-edit.js styleErrors) (anchorErrors).
 *
 * - every `required` pattern matches text the champion's prompt already holds (the answer's words exist, so a champion
 *   failure is a real misreading: a phrase the edit coins is no test) and holds a literal word: a run of the quiz file's
 *   gate.minLiteralRun letters or digits in every alternative, outside escapes, classes, optional parts and negative
 *   lookarounds (a "." or a short common word matches any answer); its patterns are bounded (at most the quiz file's
 *   gate.maxPatternChars, no nested quantifier) since they run on every answer.
 *
 * Then the quiz phase runs it red/green: the champion must fail it, the edit pass it (the quiz file's gate). A
 * consolidation (isConsolidation: a removal, or new text in the document's own words, near no negation or restriction change) has no
 * question of its own.
 *
 *   KEYS
 *   questionErrors(raw, { maxPatternChars, minLiteralRun, maxUnbounded })   [error] for the question as the proposer wrote it (missing:
 *                                           named)
 *   isConsolidation(e, root, { negations, restrictions })   [bool] the edit teaches nothing new: its question optional, never asked
 *   literalRun(src, n)                      [bool] a regex source that requires a run of n letters or digits
 *   nestedQuantifier(src)                   [bool] a regex source with a quantified group inside a quantified group
 *   questionOf(raw, proposalId)             the question with its code-given id
 *   anchorErrors(q, { editPrompts, championPrompts })   [error]: prompts as eval/context-quiz.js buildPrompts gives them
 *   miniQuiz(quiz, q)                       the quiz's settings with the question alone (its runs apart from the quiz's)
 */

const Q = require('../eval/context-quiz');
const { numbers } = require('./probe-edit');

const KEYS = Object.freeze(['layer', 'prompt', 'text', 'rule', 'anchor', 'required', 'forbidden', 'state', 'lookup']);
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const flat = t => String(t).replace(/\s+/g, ' ');

/**
 * Whether a regex source nests a quantifier inside a quantified group ((a+)+, (.*)*, ((ab)+)*): catastrophic
 * backtracking on a long answer. Escapes and character classes are skipped; a `?` is no repeat.
 */
function nestedQuantifier(src) {
  const s = String(src);
  const stack = [];
  let lastGroup = null;
  const repeatAt = i => s[i] === '*' || s[i] === '+' || (s[i] === '{' && /\d/.test(s[i + 1] || ''));
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\') { i += 1; lastGroup = null; continue; }
    if (c === '[') {
      for (i += 1; i < s.length && s[i] !== ']'; i += 1) if (s[i] === '\\') i += 1;
      lastGroup = null;
      continue;
    }
    if (c === '(') { stack.push(false); lastGroup = null; continue; }
    if (c === ')') { lastGroup = stack.length ? stack.pop() : false; continue; }
    if (repeatAt(i)) {
      if (lastGroup === true) return true;
      if (stack.length) stack[stack.length - 1] = true;
      // A quantified group counts as a repeat inside the group around it.
      lastGroup = null;
      continue;
    }
    lastGroup = null;
  }
  return false;
}

/**
 * A regex source's quantifiers outside escapes and character classes: each { group, max } (group: it follows a ")";
 * max: the repeat count's upper bound, Infinity when unbounded). A "?" is no repeat (max 1).
 */
function quantifiers(src) {
  const s = String(src);
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\') { i += 1; continue; }
    if (s[i] === '[') { for (i += 1; i < s.length && s[i] !== ']'; i += 1) if (s[i] === '\\') i += 1; continue; }
    const m = /^(?:([*+])|\{(\d+)(?:(,)(\d*))?\})/.exec(s.slice(i));
    if (!m) continue;
    const max = m[1] ? Infinity : m[3] ? (m[4] === '' ? Infinity : Number(m[4])) : Number(m[2]);
    out.push({ group: s[i - 1] === ')' && s[i - 2] !== '\\', max });
    i += m[0].length - 1;
  }
  return out;
}

/**
 * Whether every string a regex source matches holds a run of n letters or digits, read conservatively: escapes (\b, \w,
 * \., \k<name>), character classes and quantifier braces count for nothing; an optional part (x?, x*, x{0,m}, (...)?,
 * (...)*) and a negative lookaround too; a group name is no text; a group with a | holds a run only when each of its
 * branches does, and so does each top-level alternative ("(.|wait)" and "wait|." do not; "(enter|take) now" does).
 */
function literalRun(src, n) {
  const run = new RegExp(`[A-Za-z0-9]{${n},}`);
  const every = t => t.split('|').every(p => run.test(p));
  let s = String(src).replace(/\\k<[^>]*>/g, ' ').replace(/\\./g, ' ').replace(/\[[^\]]*\]/g, ' ');
  // x{0}, x{0,m}, x{0,}: optional; any other brace a repeat of at least one (its digits never text).
  s = s.replace(/\{0+(?:,\d*)?\}/g, '?').replace(/\{\d+(?:,\d*)?\}/g, '');
  s = s.replace(/[A-Za-z0-9][?*]/g, ' ');
  // Innermost groups first: an optional group or a negative lookaround is nothing, an alternation a run only when every
  // branch has one, any other group its own content.
  for (let prev = null; prev !== s;) {
    prev = s;
    s = s.replace(/\((\?(?:[:=!]|<[=!]|<[A-Za-z_$][\w$]*>))?([^()]*)\)([?*]?)/g, (_m, pre, body, q) => {
      if (q || pre === '?!' || pre === '?<!') return ' ';
      if (body.includes('|')) return every(body) ? ` ${'a'.repeat(n)} ` : ' ';
      return body;
    });
  }
  return every(s);
}

/**
 * The proposer's regexes, bounded: at most maxPatternChars each, no nested quantifier (they run on every answer); each
 * required one a literal word (literalRun: a "." or "\\bno\\b" passes any answer).
 */
function patternErrors(raw, maxPatternChars, minLiteralRun, maxUnbounded) {
  const errors = [];
  for (const k of ['required', 'forbidden']) {
    if (!Array.isArray(raw[k])) continue;
    raw[k].forEach((src, i) => {
      if (typeof src !== 'string') return;
      if (src.length > maxPatternChars) errors.push(`question.${k}[${i}]: at most ${maxPatternChars} characters (the quiz file's gate.maxPatternChars)`);
      if (nestedQuantifier(src)) errors.push(`question.${k}[${i}]: a nested quantifier (such as (a+)+): it can backtrack without end; write plain phrases`);
      const qs = quantifiers(src);
      // A group repeated (its branches or body overlapping) backtracks exponentially on a long answer: plain phrases.
      if (qs.some(x => x.group && x.max > 1)) errors.push(`question.${k}[${i}]: a repeated group (such as (a|b)*, (ab)+ or (ab){2}): it can backtrack without end; write plain phrases (an optional group (ab)? is fine)`);
      if (qs.filter(x => x.max === Infinity).length > maxUnbounded) errors.push(`question.${k}[${i}]: at most ${maxUnbounded} unbounded repeats (*, +, {n,}; the quiz file's gate.maxUnboundedQuantifiers): more backtrack without end`);
      if (k === 'required' && !literalRun(src, minLiteralRun)) errors.push(`question.${k}[${i}]: no literal run of ${minLiteralRun} letters or digits (the quiz file's gate.minLiteralRun): write the answer's own word, not "." or a short common word`);
    });
  }
  return errors;
}

function questionErrors(raw, { maxPatternChars = Q.loadQuiz().value.gate.maxPatternChars, minLiteralRun = Q.loadQuiz().value.gate.minLiteralRun, maxUnbounded = Q.loadQuiz().value.gate.maxUnboundedQuantifiers } = {}) {
  if (!isObj(raw)) return ['question: the quiz question the edit teaches, written first ({ layer, prompt, text, rule, anchor, required, forbidden }): one you would answer wrongly before the edit and rightly after it'];
  const errors = [];
  if ('id' in raw) errors.push('question.id: assigned by code (e-<proposal id>), never written by the proposer');
  const extra = Object.keys(raw).filter(k => k !== 'id' && !KEYS.includes(k));
  if (extra.length) errors.push(`question: unknown keys: ${extra.join(', ')}`);
  const { id: _id, ...rest } = raw;
  // The quiz file's checks on a Part A question, under a stand-in id (the real one is code's).
  errors.push(...Q.questionErrors({ ...rest, id: 'e-check' }, { part: 'questions', at: 'question' }));
  errors.push(...patternErrors(raw, maxPatternChars, minLiteralRun, maxUnbounded));
  return errors;
}

const tokens = t => String(t).toLowerCase().replace(/[\u2018\u2019]/g, "'").match(/[a-z0-9']+/g) || [];
const words = t => new Set(tokens(t));
/** Whether a text holds a negation: one of the quiz file's negation words, or any word ending in n't. */
const negated = (t, list) => tokens(t).some(w => list.includes(w) || w.endsWith("n't"));
/** The restriction words a text holds, counted per word ("only", "must", "unless": the quiz file's restrictions). */
const restrictionsIn = (t, list) => tokens(t).filter(w => list.includes(w)).sort().join(' ');

/**
 * A consolidation: an edit of kind removal, or one whose new text adds no word the champion's document lacks (a merge or
 * a trim in its own words). It teaches nothing new, so it has no question of its own (optional, never asked): it must
 * pass the whole quiz under the quiz's own gate (quiz-phase.js). A document that can't be read: never one (fails closed).
 * Never one, a removal too (it needs a question), when an edit's find or replace holds a negation (the quiz file's
 * negations, or a word ending in n't: one added, dropped or moved flips or shifts a rule in the document's own words),
 * or when it adds or removes a restriction word (the quiz file's restrictions: "only", "must", "unless").
 */
function isConsolidation(e, root, { negations = Q.loadQuiz().value.negations, restrictions = Q.loadQuiz().value.restrictions } = {}) {
  if (!e || !isObj(e.proposal) || !Array.isArray(e.proposal.edits) || !e.proposal.edits.length) return false;
  const shifts = x => !isObj(x) || typeof x.find !== 'string' || typeof x.replace !== 'string' || negated(x.find, negations) || negated(x.replace, negations)
    || restrictionsIn(x.find, restrictions) !== restrictionsIn(x.replace, restrictions);
  if (e.proposal.edits.some(shifts)) return false;
  if (e.tag && e.tag.kind === 'removal') return true;
  const fs = require('fs');
  const path = require('path');
  return e.proposal.edits.every(x => {
    if (!isObj(x) || typeof x.replace !== 'string' || typeof x.file !== 'string') return false;
    let had;
    try { had = words(fs.readFileSync(path.join(root, x.file), 'utf8')); } catch (_err) { return false; }
    return [...words(x.replace)].every(w => had.has(w));
  });
}

function questionOf(raw, proposalId) {
  if (typeof proposalId !== 'string' || !proposalId) throw new Error('questionOf: the proposal id its question is named by');
  const { id: _id, ...rest } = raw;
  return { ...rest, id: `e-${proposalId}` };
}

function anchorErrors(q, { editPrompts, championPrompts }) {
  const key = Q.promptKey(q);
  const edited = editPrompts && editPrompts[key];
  const before = championPrompts && championPrompts[key];
  if (typeof edited !== 'string' || typeof before !== 'string') return [`question.prompt: no ${key} prompt for the trees (it is asked of a prompt the quiz builds: the head trader's, with the risk manager's, a situational or a lookup one)`];
  const errors = [];
  if (!flat(edited).includes(flat(q.anchor))) errors.push(`question.anchor: not in the edited tree's ${key} prompt: copy the phrase from the edit's new text`);
  if (flat(before).includes(flat(q.anchor))) errors.push(`question.anchor: the champion's ${key} prompt already states it: the champion can read the answer off, so no edit is needed`);
  // The answer's words already in the champion's prompt: its failure is then a misreading, never a missing token (a
  // phrase the edit coins makes red trivially true and green a quote).
  (q.required || []).forEach((src, i) => {
    let hit;
    try { hit = new RegExp(src, 'i').test(flat(before)); } catch (_err) { hit = false; }
    if (!hit) errors.push(`question.required[${i}]: matches nothing in the champion's ${key} prompt: the answer's words must already be there (a phrase the edit coins is no test)`);
  });
  const had = numbers(before);
  const asked = [q.text, q.rule, q.anchor, ...(q.required || []), ...(q.forbidden || [])].join('\n');
  const added = [...numbers(asked)].filter(x => !had.has(x));
  if (added.length) errors.push(`question: no numbers: it adds ${added.join(', ')}`);
  return errors;
}

const miniQuiz = (quiz, q) => ({ ...quiz, questions: [q], partB: [] });

module.exports = { KEYS, questionErrors, questionOf, anchorErrors, miniQuiz, isConsolidation, nestedQuantifier, literalRun };
