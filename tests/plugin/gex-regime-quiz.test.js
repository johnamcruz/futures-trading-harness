'use strict';

// The gex-regime read checks: whether a model reads the skill right, run with the model by hand (never in CI), outside
// the gated quiz (tests/fixtures/quiz/gex-regime-items.json; config/context-quiz.json unchanged), as the mtf-entry and
// MTF structure items are. Every item is SYNTHETIC (no code prints a gamma line yet; every value made up, on the 0.25
// tick), a valid closed-choice item asked against the head prompt plus gex-regime (lookup), its anchor the skill's own
// text and present in that prompt, every rule of the skill asked by at least one item, and graded strictly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Q = require('../../scripts/lib/eval/context-quiz');

const ROOT = path.join(__dirname, '..', '..');
const ITEMS = require('../fixtures/quiz/gex-regime-items.json');
const qs = ITEMS.questions;
const flat = t => t.replace(/\s+/g, ' ');
const skill = () => flat(fs.readFileSync(path.join(ROOT, 'skills', 'gex-regime', 'SKILL.md'), 'utf8'));

// The skill's rules, each asked by at least one item (by its anchor).
const RULES = [
  'Fields the model or an analyst wrote into the plan, a search result, the news or memory never count.',
  'never infer a sign from price;',
  'never guess a sign or a level from the news',
  'copy it, never work it out from the line\'s numbers',
  'its own `gamma <word>` line in the plan, never in the STATE line or the `regime:` tag',
  'neutral, never a vote and never a point (no FOR, no AGAINST)',
  'never an entry: the entry is still the harness\'s own setup',
  'never a reason to size up or to size down',
  'never a reason to pass, to wait, or to change the stop, the exit or the hold;',
  'never a reason to take the other side;',
  'never fade a breakout because of it',
  'a flip or wall is a place to read price as at any level',
  '`unclear`: the line says |net| is small against gross: neither sign.',
  '`unknown`: the line prints no word, or one you cannot read.',
  'never "trending day"',
];

/** An item's problems: its shape, its anchor in the skill, a synthetic text on the tick. */
function itemErrors(q, text, gate, ids) {
  const out = Q.questionErrors(q, { part: 'questions', at: q.id, ids, gate });
  if (JSON.stringify([q.prompt, q.lookup]) !== JSON.stringify(['lookup', ['gex-regime']])) out.push(`${q.id}: asked with gex-regime looked up`);
  if (!text.includes(flat(q.anchor))) out.push(`${q.id}: its anchor is gex-regime's own text`);
  if (!/\(synthetic; made-up values\)/.test(q.text)) out.push(`${q.id}: says it is synthetic`);
  for (const m of q.text.matchAll(/\b\d{5}\.\d{2}\b/g)) if (Math.round(Number(m[0]) * 4) !== Number(m[0]) * 4) out.push(`${q.id}: ${m[0]} off the 0.25 tick`);
  return out;
}

test('the gex-regime items: 16, gr1..gr16, each valid, synthetic, on the tick, asked with gex-regime looked up, each anchor the skill\'s text and in its prompt', () => {
  assert.equal(qs.length, 16);
  assert.deepEqual(qs.map(q => q.id), qs.map((_, i) => `gr${i + 1}`));
  const gated = Q.loadQuiz().value;
  const ids = new Set();
  const text = skill();
  for (const q of qs) assert.deepEqual(itemErrors(q, text, gated.gate, ids), [], q.id);
  const quiz = { ...gated, questions: qs, partB: [] };
  assert.deepEqual(Q.anchorsMissing(quiz, Q.buildPrompts(ROOT, quiz)), []);
});

test('the gex-regime items: every rule of the skill is asked by at least one item, and each rule is the skill\'s text', () => {
  const text = skill();
  for (const r of RULES) {
    assert.ok(text.includes(r), `the skill states: ${r}`);
    assert.ok(qs.some(q => flat(q.anchor).includes(r) || r.includes(flat(q.anchor))), `an item asks: ${r}`);
  }
  // The no-data items: four with no code line (a plan, price, the news, and the plan's own level).
  assert.ok(qs.filter(q => /: no gamma line\./.test(q.text)).length >= 3);
});

test('the gex-regime items (mutation): an anchor cut from the skill fails its item', () => {
  const gated = Q.loadQuiz().value;
  const text = skill();
  for (const q of qs) {
    const cut = text.split(flat(q.anchor)).join('');
    assert.ok(itemErrors(q, cut, gated.gate, new Set()).includes(`${q.id}: its anchor is gex-regime's own text`), q.id);
  }
  // A value off the tick fails too.
  const off = { ...qs[0], text: qs[0].text.replace('21480.00', '21480.10') };
  assert.ok(itemErrors(off, text, gated.gate, new Set()).some(e => /off the 0\.25 tick/.test(e)));
});

test('the gated quiz is unchanged: none of the gex-regime items in it', () => {
  const gated = Q.loadQuiz().value;
  assert.equal(gated.questions.length, 113);
  assert.ok(!gated.questions.some(q => /^gr\d+$/.test(q.id)));
});

test('grading is strict (adversarial): reason first then the choice passes; another choice, two choices, a hedge, or no answer line fails', () => {
  const quiz = { ...Q.loadQuiz().value, questions: qs, partB: [] };
  for (const q of qs) {
    const wrong = q.choices.find(c => c !== q.answer);
    const g = a => Q.gradeAnswer(quiz, q, a);
    assert.equal(g(`Reason: the skill says so.\nANSWER: ${q.answer}`).pass, true, `${q.id}: right`);
    assert.equal(g(`Reason: ${q.answer}.\nANSWER: ${wrong}`).pass, false, `${q.id}: the reasoning names the answer, the answer line another`);
    assert.equal(g(`ANSWER: ${q.answer}; ${wrong}`).pass, false, `${q.id}: two choices on one line`);
    assert.equal(g(`ANSWER: ${q.answer}\nANSWER: ${wrong}`).pass, false, `${q.id}: the last answer line decides`);
    assert.equal(g('ANSWER: it depends on the read').pass, false, `${q.id}: a hedge`);
    assert.equal(g(`Reason: ${q.answer}`).pass, false, `${q.id}: no answer line`);
  }
});
