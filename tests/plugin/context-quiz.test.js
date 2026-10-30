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

test('context quiz: every anchor is in the built head (or head+risk) prompt', () => {
  const prompts = Q.buildPrompts(ROOT);
  assert.deepStrictEqual(Q.anchorsMissing(QUIZ, prompts), []);
  // A rule's text deleted from the prompt: its question's anchor goes missing.
  const cut = { ...prompts, head: prompts.head.replace(/A 3m swing is not a level and\s+not\s+a target\./, '') };
  assert.ok(Q.anchorsMissing(QUIZ, cut).includes('q6'));
});

test('context quiz: every layer asked, ids unique, the bar the whole quiz at K 5', () => {
  const all = [...QUIZ.questions, ...QUIZ.partB];
  assert.deepStrictEqual([...new Set(QUIZ.questions.map(x => x.layer))].sort(), [...Q.LAYERS].sort());
  assert.strictEqual(new Set(all.map(x => x.id)).size, all.length);
  assert.strictEqual(QUIZ.k, 5);
  assert.deepStrictEqual(QUIZ.passBar, { partA: { allCorrect: QUIZ.questions.length, bothWays: 0 }, partB: { allCorrect: QUIZ.partB.length, bothWays: 0 } });
  assert.strictEqual(QUIZ.questions.length, 20);
  assert.strictEqual(QUIZ.partB.length, 5);
});
