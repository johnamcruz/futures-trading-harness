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
 *   gate.maxPatternChars, in the pattern grammar: pattern-grammar.js) since they run on every answer.
 *
 * Then the quiz phase runs it red/green: the champion must fail it, the edit pass it (the quiz file's gate). A
 * consolidation (isConsolidation: a pure deletion, near no negation, restriction or polar word change) has no
 * question of its own.
 *
 *   KEYS
 *   questionErrors(raw, gate)               [error] for the question as the proposer wrote it (missing: named); gate:
 *                                           the run's quiz file's limits
 *   isConsolidation(e, root, { negations, restrictions, polar })   [bool] the edit teaches nothing new: its question optional, never asked
 *   literalRun(src, n)                      [bool] a regex source that requires a run of n letters or digits
 *   questionOf(raw, proposalId)             the question with its code-given id
 *   anchorErrors(q, { editPrompts, championPrompts, maxLineChars })   [error]: prompts as eval/context-quiz.js buildPrompts
 *                                           gives them; each required pattern tested line by line, each cut at maxLineChars
 *   miniQuiz(quiz, q)                       the quiz's settings with the question alone (its runs apart from the quiz's)
 */

const Q = require('../eval/context-quiz');
const { numbers } = require('./probe-edit');
const { grammarErrors } = require('./pattern-grammar');

const KEYS = Object.freeze(['layer', 'prompt', 'text', 'rule', 'anchor', 'required', 'forbidden', 'state', 'lookup']);
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const flat = t => String(t).replace(/\s+/g, ' ');

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
 * The proposer's regexes, bounded (they run on every answer): at most maxPatternChars each, written in the pattern
 * grammar (pattern-grammar.js: a whitelist, no form that backtracks without end), each required one a literal word
 * (literalRun: a "." or "\\bno\\b" passes any answer). The limits are the run's quiz file's gate.
 */
function patternErrors(raw, g) {
  const errors = [];
  for (const k of ['required', 'forbidden']) {
    if (!Array.isArray(raw[k])) continue;
    raw[k].forEach((src, i) => {
      if (typeof src !== 'string') return;
      if (src.length > g.maxPatternChars) errors.push(`question.${k}[${i}]: at most ${g.maxPatternChars} characters (the quiz file's gate.maxPatternChars)`);
      for (const why of grammarErrors(src, g)) errors.push(`question.${k}[${i}]: ${why}; write plain phrases`);
      if (k === 'required' && !literalRun(src, g.minLiteralRun)) errors.push(`question.${k}[${i}]: no literal run of ${g.minLiteralRun} letters or digits (the quiz file's gate.minLiteralRun): write the answer's own word, not "." or a short common word`);
    });
  }
  return errors;
}

/** The question's errors; `limits`: the run's quiz file's gate (each key not given: the repo file's). */
function questionErrors(raw, limits = {}) {
  const g = { ...Q.loadQuiz().value.gate, ...limits };
  if (!isObj(raw)) return ['question: the quiz question the edit teaches, written first ({ layer, prompt, text, rule, anchor, required, forbidden }): one you would answer wrongly before the edit and rightly after it'];
  const errors = [];
  if ('id' in raw) errors.push('question.id: assigned by code (e-<proposal id>), never written by the proposer');
  const extra = Object.keys(raw).filter(k => k !== 'id' && !KEYS.includes(k));
  if (extra.length) errors.push(`question: unknown keys: ${extra.join(', ')}`);
  const { id: _id, ...rest } = raw;
  // The quiz file's checks on a Part A question, under a stand-in id (the real one is code's).
  errors.push(...Q.questionErrors({ ...rest, id: 'e-check' }, { part: 'questions', at: 'question' }));
  errors.push(...patternErrors(raw, g));
  return errors;
}

const tokens = t => String(t).toLowerCase().replace(/[\u2018\u2019]/g, "'").match(/[a-z0-9']+/g) || [];
const words = t => new Set(tokens(t));
/** Whether a text holds a negation: one of the quiz file's negation words, or any word ending in n't. */
const negated = (t, list) => tokens(t).some(w => list.includes(w) || w.endsWith("n't"));
/** The restriction words a text holds, counted per word ("only", "must", "unless": the quiz file's restrictions). */
const restrictionsIn = (t, list) => tokens(t).filter(w => list.includes(w)).sort().join(' ');
/** Whether b's words are a's in order, some left out: a pure deletion. */
function subsequence(a, b) {
  let j = 0;
  for (const w of a) if (j < b.length && w === b[j]) j += 1;
  return j === b.length;
}
/** The polar words a text holds, each with its neighbours on its own line ("buy low", "above the zone"). */
const polarSig = (t, list) => String(t).split('\n').flatMap(line => {
  const ws = tokens(line);
  return ws.map((w, i) => (list.includes(w) ? `${ws[i - 1] || ''}|${w}|${ws[i + 1] || ''}` : null)).filter(Boolean);
}).sort().join(' ');

/**
 * A consolidation: a pure in-order deletion (each edit's replace its find's words in order, some left out: a removal or
 * a trim; never a word added, even the document's own, never words reordered). It teaches nothing new, so it has no question of its own (optional, never asked): it must
 * pass the whole quiz under the quiz's own gate (quiz-phase.js). A document that can't be read: never one (fails closed).
 * Never one, a removal too (it needs a question), when an edit's find or replace holds a negation (the quiz file's
 * negations, or a word ending in n't: one added, dropped or moved flips or shifts a rule in the document's own words),
 * when it adds or removes a restriction word (the quiz file's restrictions: "only", "must", "unless"), or when it adds,
 * removes or moves a polar word (the quiz file's polar: above/below, long/short, premium/discount, ...: each with its
 * neighbours on its line the same before and after; a deletion of a line holding one is then never one: strict).
 */
function isConsolidation(e, root, { negations = Q.loadQuiz().value.negations, restrictions = Q.loadQuiz().value.restrictions, polar = Q.loadQuiz().value.polar } = {}) {
  if (!e || !isObj(e.proposal) || !Array.isArray(e.proposal.edits) || !e.proposal.edits.length) return false;
  const shifts = x => !isObj(x) || typeof x.find !== 'string' || typeof x.replace !== 'string' || negated(x.find, negations) || negated(x.replace, negations)
    || restrictionsIn(x.find, restrictions) !== restrictionsIn(x.replace, restrictions);
  if (e.proposal.edits.some(shifts)) return false;
  if (!e.proposal.edits.every(x => subsequence(tokens(x.find), tokens(x.replace)) && polarSig(x.find, polar) === polarSig(x.replace, polar))) return false;
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

function anchorErrors(q, { editPrompts, championPrompts, maxLineChars = Q.loadQuiz().value.gate.maxGradedLineChars }) {
  const key = Q.promptKey(q);
  const edited = editPrompts && editPrompts[key];
  const before = championPrompts && championPrompts[key];
  if (typeof edited !== 'string' || typeof before !== 'string') return [`question.prompt: no ${key} prompt for the trees (it is asked of a prompt the quiz builds: the head trader's, with the risk manager's, a situational or a lookup one)`];
  const errors = [];
  if (!flat(edited).includes(flat(q.anchor))) errors.push(`question.anchor: not in the edited tree's ${key} prompt: copy the phrase from the edit's new text`);
  if (flat(before).includes(flat(q.anchor))) errors.push(`question.anchor: the champion's ${key} prompt already states it: the champion can read the answer off, so no edit is needed`);
  // The answer's words already in the champion's prompt: its failure is then a misreading, never a missing token (a
  // phrase the edit coins makes red trivially true and green a quote).
  // Line by line, each line cut at maxLineChars (the grader's gate.maxGradedLineChars): no pattern runs on the whole
  // prompt at once, and none matches across a line break.
  const lines = before.split('\n').map(l => flat(l).slice(0, maxLineChars));
  (q.required || []).forEach((src, i) => {
    let hit;
    try { const re = new RegExp(src, 'i'); hit = lines.some(l => re.test(l)); } catch (_err) { hit = false; }
    if (!hit) errors.push(`question.required[${i}]: matches nothing in the champion's ${key} prompt: the answer's words must already be there (a phrase the edit coins is no test)`);
  });
  const had = numbers(before);
  // A gap's bounds (.{0,60}) are the pattern's syntax, never a number it adds.
  const asked = [q.text, q.rule, q.anchor, ...[...(q.required || []), ...(q.forbidden || [])].map(p => String(p).replace(/\{\d+,\d+\}/g, ' '))].join('\n');
  const added = [...numbers(asked)].filter(x => !had.has(x));
  if (added.length) errors.push(`question: no numbers: it adds ${added.join(', ')}`);
  return errors;
}

const miniQuiz = (quiz, q) => ({ ...quiz, questions: [q], partB: [] });

module.exports = { KEYS, questionErrors, questionOf, anchorErrors, miniQuiz, isConsolidation, literalRun };
