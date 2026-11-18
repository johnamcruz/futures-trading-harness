'use strict';

// Gate 3 of feat/mtf-structure (SPEC v2; SPEC v3: 31 items; SPEC v4: 28, ms15, ms26 and ms27 retired with the `Above:`
// clause they tested): the MTF structure items live outside the gated quiz (tests/fixtures/quiz/mtf-structure-items.json):
// exactly ms1..ms31 less the three, each a valid closed-choice item asked against the head prompt plus bos-vs-choch
// (lookup), each anchor in that prompt. The gated quiz stays at 113 with maxSlips unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Q = require('../../scripts/lib/eval/context-quiz');

const ROOT = path.join(__dirname, '..', '..');
const ITEMS = require('../fixtures/quiz/mtf-structure-items.json');

const RETIRED = ['ms15', 'ms26', 'ms27'];

test('gate 3: exactly 28 items (ms1..ms31 less ms15, ms26, ms27), each valid, asked with bos-vs-choch looked up, each anchor in its prompt', () => {
  const qs = ITEMS.questions;
  assert.deepEqual(qs.map(q => q.id), Array.from({ length: 31 }, (_, i) => `ms${i + 1}`).filter(id => !RETIRED.includes(id)));
  const gated = Q.loadQuiz().value;
  const ids = new Set();
  for (const q of qs) {
    assert.deepEqual(Q.questionErrors(q, { part: 'questions', at: q.id, ids, gate: gated.gate }), [], q.id);
    assert.deepEqual([q.prompt, q.lookup], ['lookup', ['bos-vs-choch']], q.id);
    assert.ok(q.text.includes('- MTF structure 1h > 15m (primary): stage ') || q.text.includes('- MTF structure below: 15m > 3m'), `${q.id}: prints the lines`);
  }
  // SPEC v3: each item's printed lines use the v3 phrase, and every answer is one of its choices with no two-part answer
  for (const q of qs) {
    if (/MTF structure/.test(q.text)) assert.match(q.text, /pullback against the (1h|15m): (UP|DOWN|NONE)/, `${q.id}: the v3 phrase`);
    // SPEC v4: no `Above:` clause, and every below-line phrase names its frame
    assert.doesNotMatch(q.text, /Above:|pullback against the 4h/, `${q.id}: no Above clause`);
    const bare = (q.text.match(/3m pullback against the 15m/g) || []).length;
    assert.equal((q.text.match(/below 15m > 3m: 3m pullback against the 15m/g) || []).length, bare, `${q.id}: the below phrase names its frame`);
    assert.doesNotMatch(q.text, /No 15m pullback open|No 3m pullback open|the 1h is (not )?pulling back|\b(15m|3m) pullback (UP|DOWN)[:;]|ready (LONG|SHORT) [^,]*, structural stop \d+(\.\d+)?(?![\d.]| \(a structure level)/, `${q.id}: no v2 wording`);
  }
  for (const id of ['ms9', 'ms11', 'ms14', 'ms21', 'ms22']) assert.ok(!qs.find(q => q.id === id).answer.includes(';'), `${id}: one answer`);
  const quiz = { ...gated, questions: qs, partB: [] };
  assert.deepEqual(Q.anchorsMissing(quiz, Q.buildPrompts(ROOT, quiz)), []);
});

test('the gated quiz is unchanged in size: 113 items, maxSlips 11, none of the MTF items in it', () => {
  const gated = Q.loadQuiz().value;
  assert.equal(gated.questions.length, 113);
  assert.equal(gated.gate.maxSlips, 11);
  assert.ok(!gated.questions.some(q => /^ms\d+$/.test(q.id)));
});
