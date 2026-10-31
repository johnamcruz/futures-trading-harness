'use strict';

// The context quiz offline (no model call): every question's anchor, the phrase of the skills that states its rule, is
// in the prompt it is asked against, built as the runner builds it; deleting a rule's text fails here. Every layer is
// asked, the ids are unique, and the pass bar is the whole quiz.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Q = require('../../scripts/lib/eval/context-quiz');

const ROOT = path.resolve(__dirname, '..', '..');
const QUIZ = Q.loadQuiz().value;

test('context quiz: every anchor is in the built head (or head+risk, or situational) prompt', () => {
  const prompts = Q.buildPrompts(ROOT, QUIZ);
  assert.deepStrictEqual(Q.anchorsMissing(QUIZ, prompts), []);
  // A rule's text deleted from the prompt: its question's anchor goes missing.
  const cut = { ...prompts, head: prompts.head.replace(/A 3m swing is not a level and\s+not\s+a target\./, '') };
  assert.ok(Q.anchorsMissing(QUIZ, cut).includes('q6'));
});

test('context quiz: a situational question is asked against the head prompt plus the skills its state delivers (q21, a fill reported late: leftover-orders)', () => {
  const prompts = Q.buildPrompts(ROOT, QUIZ);
  const q = QUIZ.questions.find(x => x.id === 'q21');
  assert.strictEqual(Q.promptKey(q), 'situational:q21');
  const p = prompts['situational:q21'];
  assert.ok(p.startsWith(prompts.head) && p.includes('<skill name="leftover-orders">'), 'the head prompt and leftover-orders');
  assert.ok(!prompts.head.includes('<skill name="leftover-orders">'), 'not in the head prompt alone');
  // Without its state the anchor is in no prompt: the question needs its situational prompt.
  assert.ok(Q.anchorsMissing(QUIZ, { head: prompts.head, 'head+risk': prompts['head+risk'] }).includes('q21'));
  assert.ok(Q.quizErrors({ ...QUIZ, questions: [{ ...q, state: undefined }] }).some(e => /state/.test(e)));
});

test('context quiz: every layer asked, ids unique, the bar the whole quiz at K 5', () => {
  const all = [...QUIZ.questions, ...QUIZ.partB];
  assert.deepStrictEqual([...new Set(QUIZ.questions.map(x => x.layer))].sort(), [...Q.LAYERS].sort());
  assert.strictEqual(new Set(all.map(x => x.id)).size, all.length);
  assert.strictEqual(QUIZ.k, 5);
  assert.deepStrictEqual(QUIZ.passBar, { partA: { allCorrect: QUIZ.questions.length, bothWays: 0 }, partB: { allCorrect: QUIZ.partB.length, bothWays: 0 } });
  assert.strictEqual(QUIZ.questions.length, 30);
  assert.strictEqual(QUIZ.partB.length, 5);
});
