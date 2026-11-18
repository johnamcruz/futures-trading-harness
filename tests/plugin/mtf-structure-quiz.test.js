'use strict';

// Gate 3 of feat/mtf-structure (SPEC v2): the 25 MTF structure items live outside the gated quiz
// (tests/fixtures/quiz/mtf-structure-items.json): exactly ms1..ms25, each a valid closed-choice item asked against the head
// prompt plus bos-vs-choch (lookup), each anchor in that prompt. The gated quiz stays at 113 with maxSlips unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Q = require('../../scripts/lib/eval/context-quiz');

const ROOT = path.join(__dirname, '..', '..');
const ITEMS = require('../fixtures/quiz/mtf-structure-items.json');

test('gate 3: exactly 25 items ms1..ms25, each valid, asked with bos-vs-choch looked up, each anchor in its prompt', () => {
  const qs = ITEMS.questions;
  assert.deepEqual(qs.map(q => q.id), Array.from({ length: 25 }, (_, i) => `ms${i + 1}`));
  const gated = Q.loadQuiz().value;
  const ids = new Set();
  for (const q of qs) {
    assert.deepEqual(Q.questionErrors(q, { part: 'questions', at: q.id, ids, gate: gated.gate }), [], q.id);
    assert.deepEqual([q.prompt, q.lookup], ['lookup', ['bos-vs-choch']], q.id);
    assert.ok(q.text.includes('- MTF structure 1h > 15m (primary): stage ') || q.text.includes('- MTF structure below: 15m > 3m'), `${q.id}: prints the lines`);
  }
  const quiz = { ...gated, questions: qs, partB: [] };
  assert.deepEqual(Q.anchorsMissing(quiz, Q.buildPrompts(ROOT, quiz)), []);
});

test('the gated quiz is unchanged in size: 113 items, maxSlips 11, none of the MTF items in it', () => {
  const gated = Q.loadQuiz().value;
  assert.equal(gated.questions.length, 113);
  assert.equal(gated.gate.maxSlips, 11);
  assert.ok(!gated.questions.some(q => /^ms\d+$/.test(q.id)));
});
