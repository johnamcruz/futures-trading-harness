'use strict';

// The gex-regime read checks: whether a model reads the skill right, run with the model by hand (never in CI), outside
// the gated quiz (tests/fixtures/quiz/gex-regime-items.json; config/context-quiz.json unchanged), as the mtf-entry and
// MTF structure items are. Every item is SYNTHETIC (no code prints a gamma line yet; every value made up, on the 0.25
// tick), a valid closed-choice item asked against the head prompt plus gex-regime (lookup), its anchor the skill's own
// text and present in that prompt, each listed rule of the skill asked by at least one item, every key pinned (KEYS),
// the key letters spread (no letter holds more than a third; "always A" and "always no" score far below perfect), and
// graded strictly. The owner's focus is negative gamma (trend-following): no item adds positive-gamma content beyond
// the two that check it stays neutral (gr8, gr9).

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
const LETTERS = 'ABCD';

// Every key, pinned: its letter, its answer, its rule and its question (the text's last line).
const KEYS = {
  gr1: { letter: "B", answer: "nothing about gamma: the plan's level is no line from the code", rule: "fields the model or an analyst wrote into the plan never count; with no code line, nothing about gamma", question: "What do you write about gamma in your PLAN?" },
  gr2: { letter: "D", answer: "no: never infer a sign from price", rule: "with no code line, never infer a sign from price", question: "May you write \"positive gamma day\" in your PLAN?" },
  gr3: { letter: "A", answer: "nothing: the news never gives the sign", rule: "a search result or the news never counts; never guess a sign from the news", question: "What do you write about gamma?" },
  gr4: { letter: "C", answer: "on its own `gamma negative (soft)` line in the plan", rule: "its own gamma <word> line in the plan, never the STATE line or the regime: tag", question: "Where do you write the word?" },
  gr5: { letter: "C", answer: "it does not: neutral, never a vote", rule: "neutral, never a vote and never a point (no FOR, no AGAINST)", question: "How does the word enter the confluence count?" },
  gr6: { letter: "A", answer: "the verdict size 3: the word never sizes up", rule: "never a reason to size up or to size down", question: "What size do you trade?" },
  gr7: { letter: "D", answer: "no: never an entry; the entry is still the harness's own setup", rule: "never an entry: the entry is still the harness's own setup", question: "Is the negative word a reason to enter long now?" },
  gr8: { letter: "B", answer: "nothing: never fade a breakout because of it", rule: "never fade a breakout because of it", question: "What does the positive word change about the breakout?" },
  gr9: { letter: "A", answer: "no: never a reason to size down, to pass or to wait", rule: "never a reason to pass, to wait, or to size down", question: "Is the positive word a reason to size down, to pass or to wait?" },
  gr10: { letter: "C", answer: "nothing: the stop, the exit and the hold stay", rule: "never a reason to change the stop, the exit or the hold", question: "What do you change because the word is negative?" },
  gr11: { letter: "B", answer: "`gamma unclear`; it counts for nothing", rule: "unclear: neither sign, written gamma unclear; neutral, it counts for nothing", question: "What do you write, and does it count?" },
  gr12: { letter: "D", answer: "yes: the line is there but prints no word you can read", rule: "unknown: the line is there but prints no word, or a word you cannot read", question: "Do you write `gamma unknown`?" },
  gr13: { letter: "D", answer: "no: copy only, never derive it from the numbers", rule: "copy the printed word, never work it out from the line's numbers", question: "The line prints no word. May you work the word out from its numbers?" },
  gr14: { letter: "B", answer: "a place to read the candle, never a trigger", rule: "a flip or wall is a place to read price as at any level, never a trigger", question: "What is the touch of the call wall?" },
  gr15: { letter: "C", answer: "no: the entry stays on the side rule's side", rule: "never a reason to take the other side; the entry stays on the side rule's side", question: "May the negative word let the long through?" },
  gr16: { letter: "A", answer: "`gamma negative (soft)`, never \"trending day\"", rule: "written gamma negative (soft), never trending day", question: "What do you write in your PLAN?" },
  gr17: { letter: "C", answer: "yes: the word never turns a read against into neutral", rule: "it never turns a read against into neutral", question: "Does the context category stay AGAINST?" },
  gr18: { letter: "A", answer: "no: the book is never a forecast", rule: "the book is never a forecast", question: "May you write \"price will run to the call wall 21600.00 today\"?" },
  gr19: { letter: "B", answer: "normal variation: the gamma word is not the day type", rule: "the gamma word is not the computed regime of the bars and not the day type", question: "What is the day type?" },
  gr20: { letter: "D", answer: "yes: it does not update through the day", rule: "the line holds as its as-of says: no update through the day; the day's own-expiry positions are not in it", question: "Does the line still hold as its as-of says?" },
};
const keysOf = items => Object.fromEntries(items.map(q => [q.id, { letter: LETTERS[q.choices.indexOf(q.answer)], answer: q.answer, rule: q.rule, question: q.text.split('\n').pop() }]));

// The skill's listed rules, each asked by at least one item (by its anchor).
const RULES = [
  'Fields the model or an analyst wrote into the plan, a search result, the news or memory never count.',
  'never infer a sign from price;',
  'never guess a sign or a level from the news',
  'copy it, never work it out from the line\'s numbers',
  'its own `gamma <word>` line in the plan, never in the STATE line or the `regime:` tag',
  'neutral, never a vote and never a point (no FOR, no AGAINST)',
  'It never turns a read against into neutral.',
  'It is not the computed regime of the bars (`trend-vs-range`) and not the day type (`day-context`).',
  'it does not update through the day, and positions opened for the day\'s own expiry are not in it.',
  'never an entry: the entry is still the harness\'s own setup',
  'never a reason to size up or to size down',
  'never a reason to pass, to wait, or to change the stop, the exit or the hold;',
  'never a reason to take the other side;',
  'never fade a breakout because of it',
  'the book is never a forecast',
  'a flip or wall is a place to read price as at any level',
  '`unclear`: the line says |net| is small against gross: neither sign.',
  '`unknown`: the line is there but prints no word, or a word you cannot read.',
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

/** The key spread: each letter's share, the share of keys starting "no", and what "always A" and "always no" score. */
function spread(items) {
  const n = items.length;
  const letters = Object.fromEntries([...LETTERS].map(l => [l, items.filter(q => LETTERS[q.choices.indexOf(q.answer)] === l).length]));
  const isNo = c => /^no\b/i.test(c);
  const alwaysNo = items.filter(q => { const c = q.choices.find(isNo); return c !== undefined && c === q.answer; }).length;
  return { n, letters, maxShare: Math.max(...Object.values(letters)) / n, noShare: items.filter(q => isNo(q.answer)).length / n, alwaysA: letters.A / n, alwaysNo: alwaysNo / n };
}
const spreadOk = s => s.maxShare <= 1 / 3 && s.noShare <= 0.35 && s.alwaysA <= 1 / 3 && s.alwaysNo <= 0.4;

test('the gex-regime items: 20, gr1..gr20, each valid, synthetic, on the tick, asked with gex-regime looked up, each anchor the skill\'s text and in its prompt', () => {
  assert.equal(qs.length, 20);
  assert.deepEqual(qs.map(q => q.id), qs.map((_, i) => `gr${i + 1}`));
  const gated = Q.loadQuiz().value;
  const ids = new Set();
  const text = skill();
  for (const q of qs) assert.deepEqual(itemErrors(q, text, gated.gate, ids), [], q.id);
  const quiz = { ...gated, questions: qs, partB: [] };
  assert.deepEqual(Q.anchorsMissing(quiz, Q.buildPrompts(ROOT, quiz)), []);
  // The owner's focus: no more than the two positive-word items (they check it stays neutral).
  assert.deepEqual(qs.filter(q => /source\): positive;/.test(q.text)).map(q => q.id), ['gr8', 'gr9']);
});

test('the gex-regime items: every key pinned (letter, answer, rule, question)', () => {
  assert.deepEqual(keysOf(qs), KEYS);
});

test('the gex-regime items (mutation): a flipped key, every key moved, a changed rule or a reversed question fails', () => {
  const swap = (q, c) => ({ ...q, answer: c });
  const at = id => qs.findIndex(q => q.id === id);
  const with1 = (i, q) => qs.map((x, k) => (k === i ? q : x));
  for (const id of ['gr5', 'gr12']) {
    const q = qs[at(id)];
    assert.notDeepEqual(keysOf(with1(at(id), swap(q, q.choices.find(c => c !== q.answer)))), KEYS, `${id}: its key flipped`);
  }
  assert.notDeepEqual(keysOf(qs.map(q => swap(q, q.choices[1]))), KEYS, 'every key moved to the second choice');
  assert.notDeepEqual(keysOf(with1(0, { ...qs[0], rule: `${qs[0].rule}.` })), KEYS, 'a changed rule');
  const q9 = qs[at('gr9')];
  const reversed = { ...q9, text: q9.text.replace(/Is the positive word a reason to size down, to pass or to wait\?$/, 'Must you size down, pass or wait because the word is positive?') };
  assert.notEqual(reversed.text, q9.text);
  assert.notDeepEqual(keysOf(with1(at('gr9'), reversed)), KEYS, 'a reversed question');
});

test('the gex-regime items: the key letters spread; "always A" and "always no" score far below perfect', () => {
  const s = spread(qs);
  assert.ok(spreadOk(s), JSON.stringify(s));
  // The check bites: every key on A, or every key a "no" answer, fails it.
  const allA = qs.map(q => ({ ...q, choices: [q.answer, ...q.choices.filter(c => c !== q.answer)] }));
  assert.ok(!spreadOk(spread(allA)), 'every key on A');
  const allNo = qs.map(q => ({ ...q, answer: `no: ${q.answer}`, choices: q.choices.map(c => (c === q.answer ? `no: ${c}` : c)) }));
  assert.ok(!spreadOk(spread(allNo)), 'every key a "no"');
});

test('the gex-regime items: each listed rule of the skill is asked by at least one item, and each rule is the skill\'s text', () => {
  const text = skill();
  for (const r of RULES) {
    assert.ok(text.includes(r), `the skill states: ${r}`);
    assert.ok(qs.some(q => flat(q.anchor).includes(r) || r.includes(flat(q.anchor))), `an item asks: ${r}`);
  }
  assert.ok(qs.filter(q => /: no gamma line\./.test(q.text)).length >= 3, 'the no-data items');
});

test('the gex-regime items (mutation): an anchor cut from the skill fails its item; a value off the tick fails', () => {
  const gated = Q.loadQuiz().value;
  const text = skill();
  for (const q of qs) {
    const cut = text.split(flat(q.anchor)).join('');
    assert.ok(itemErrors(q, cut, gated.gate, new Set()).includes(`${q.id}: its anchor is gex-regime's own text`), q.id);
  }
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
    assert.equal(g(`Reason: the skill says so.\nANSWER: ${KEYS[q.id].letter}`).pass, true, `${q.id}: right by its letter`);
    assert.equal(g(`Reason: ${q.answer}.\nANSWER: ${wrong}`).pass, false, `${q.id}: the reasoning names the answer, the answer line another`);
    assert.equal(g(`ANSWER: ${q.answer}; ${wrong}`).pass, false, `${q.id}: two choices on one line`);
    assert.equal(g(`ANSWER: ${q.answer}\nANSWER: ${wrong}`).pass, false, `${q.id}: the last answer line decides`);
    assert.equal(g('ANSWER: it depends on the read').pass, false, `${q.id}: a hedge`);
    assert.equal(g(`Reason: ${q.answer}`).pass, false, `${q.id}: no answer line`);
  }
});
