'use strict';

// The gex-regime read checks: whether a model reads the skill right, run with the model by hand (never in CI), outside
// the gated quiz (tests/fixtures/quiz/gex-regime-items.json; config/context-quiz.json unchanged), as the mtf-entry and
// MTF structure items are. Every item is SYNTHETIC (no code prints a gamma line yet; every value made up, on the 0.25
// tick), a valid closed-choice item asked against the head prompt plus gex-regime (lookup), its anchor the skill's own
// text and present in that prompt, each listed rule of the skill asked by at least one item, every key pinned (KEYS),
// every item's full text and every choice pinned too (KEYS, by sha256), the key letters spread (no letter holds more
// than a third; "always A", "always B" and "always no" score far below perfect), no length tell (the key is rarely the
// longest or the shortest option), no polarity tell (the key is never the lone yes or no), and graded strictly. The owner's focus is negative gamma (trend-following): no item adds positive-gamma content beyond
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
  gr1: {
    letter: "B", answer: "nothing: the plan's flip is not a line from the code",
    rule: "fields the model or an analyst wrote into the plan never count; with no code line, nothing about gamma",
    question: "What do you write about gamma in your PLAN?",
    text: "d5ae352cf51ad9dc", choices: ["faa34781898e61e6", "4cb9af8ee3f8eb77", "77ce5aa13b7f5606", "de5fc21c9c90954e"],
  },
  gr2: {
    letter: "D", answer: "no: never infer a sign from price, however steady the grind",
    rule: "with no code line, never infer a sign from price",
    question: "May you write \"positive gamma day\" in your PLAN?",
    text: "313cc1665ed14dba", choices: ["7a2c6254fea0408a", "19155e8182f30cfe", "61bb61244fdf7e1b", "3bff0ae5aec2b6a6"],
  },
  gr3: {
    letter: "A", answer: "nothing: a search result never counts as the gamma word",
    rule: "a search result or the news never counts; never guess a sign from the news",
    question: "What do you write about gamma?",
    text: "9ae636cdfc507685", choices: ["f0d5cb08797aa26e", "70d08cf646fd7cff", "f73f1b16a9ab92c6", "25b26960f2e61cb8"],
  },
  gr4: {
    letter: "C", answer: "on its own `gamma negative (soft)` line in the plan",
    rule: "its own gamma <word> line in the plan, never the STATE line or the regime: tag",
    question: "Where do you write the word?",
    text: "688585063f0f70b2", choices: ["67c1d132b718e0d5", "93ddc0081f2712d3", "a9c575a6554f5fa5", "46d67c4de26e43a9"],
  },
  gr5: {
    letter: "C", answer: "it does not: neutral, never a vote and never a point",
    rule: "neutral, never a vote and never a point (no FOR, no AGAINST)",
    question: "How does the word enter the confluence count?",
    text: "4774c47de85c5efb", choices: ["078927605033dd79", "a655b34213b123ff", "06acbc1dddad9c7c", "4be342863eb1e8fe"],
  },
  gr6: {
    letter: "A", answer: "the verdict size 3: the word never changes the size",
    rule: "never a reason to size up or to size down",
    question: "What size do you trade?",
    text: "696f3f56f616e702", choices: ["e7c2a28a17bd8cba", "a71227974239cc85", "f3a6fccd10c022b4", "f43c7b302f2bbe89"],
  },
  gr7: {
    letter: "D", answer: "no: the entry is still the harness's own setup on its bar",
    rule: "never an entry: the entry is still the harness's own setup",
    question: "Is the negative word a reason to enter long now?",
    text: "f04a5e8e744acd53", choices: ["06865bf22f954a3d", "71333302acb41880", "82cb685883affa95", "76cc8fb4798d393c"],
  },
  gr8: {
    letter: "B", answer: "nothing: never fade a breakout because of it",
    rule: "never fade a breakout because of it",
    question: "What does the positive word change about the breakout?",
    text: "634134a107f03439", choices: ["257b96e7d57099e4", "fe1ced27d31541b3", "e9b8b6988c0733b5", "89aad2687d798a66"],
  },
  gr9: {
    letter: "A", answer: "no: never a reason to size down, to pass or to wait",
    rule: "never a reason to pass, to wait, or to size down",
    question: "Is the positive word a reason to size down, to pass or to wait?",
    text: "e28c848c7ea22a1a", choices: ["71a6bccd1da0c3ef", "1603d6a9f7ebafa8", "143946c5894d98e6", "3253a41675e0590f"],
  },
  gr10: {
    letter: "C", answer: "nothing: the stop, the exit and the hold stay as set",
    rule: "never a reason to change the stop, the exit or the hold",
    question: "What do you change because the word is negative?",
    text: "4aeeae39f12a23c6", choices: ["230d9f7a566b8a66", "dc665e4933fbde6e", "7e81c1f6a024333c", "df7a3e8b10106fb2"],
  },
  gr11: {
    letter: "B", answer: "`gamma unclear`; it is neutral and counts for nothing",
    rule: "unclear: neither sign, written gamma unclear; neutral, it counts for nothing",
    question: "What do you write, and does it count?",
    text: "171ac9d7d4e450ce", choices: ["6475d76141634a77", "6b9a3f1207047245", "c00a8a84e799e691", "822f4b5a2ebf33cf"],
  },
  gr12: {
    letter: "D", answer: "yes: the line is there but its word cannot be read",
    rule: "unknown: the line is there but prints no word, or a word you cannot read",
    question: "Do you write `gamma unknown`?",
    text: "136ed69241532e2e", choices: ["61d8403b90e7ee40", "4f934c46bbce9f6d", "fa82cfac3901030d", "d15e91ca235f4cd2"],
  },
  gr13: {
    letter: "D", answer: "no: copy only, never derive the word from the numbers",
    rule: "copy the printed word, never work it out from the line's numbers",
    question: "The line prints no word. May you work the word out from its numbers?",
    text: "80081ca9d19948b3", choices: ["4521222238174eb7", "026135016b9c992e", "7072affe75ed82c8", "4fa7621de8ff4b54"],
  },
  gr14: {
    letter: "B", answer: "a place to read the candle there, never a trigger",
    rule: "a flip or wall is a place to read price as at any level, never a trigger",
    question: "What is the touch of the call wall?",
    text: "6becc1941c34e365", choices: ["43ff8f1c89a81d16", "6fc26b2ff6271143", "a3041d454fc120ad", "ce38799db6b0ce69"],
  },
  gr15: {
    letter: "C", answer: "no: the long stays out; the side rule's side only",
    rule: "never a reason to take the other side; the entry stays on the side rule's side",
    question: "May the negative word let the long through?",
    text: "a4bf9f7538406cb0", choices: ["952db63074beef17", "ef0be836e9650677", "79e9a43071fd2ad5", "eeda24d818491612"],
  },
  gr16: {
    letter: "A", answer: "`gamma negative (soft)`, never \"trending day\"",
    rule: "written gamma negative (soft), never trending day",
    question: "What do you write in your PLAN?",
    text: "6fd87cac9d228027", choices: ["dc2b42e19ef1bc7d", "8e76c6f2ab027601", "7fc2da4bbb26d89f", "f59857f9187672b8"],
  },
  gr17: {
    letter: "C", answer: "yes: the word never turns a read against into neutral",
    rule: "it never turns a read against into neutral",
    question: "Does the context category stay AGAINST?",
    text: "5bf65a176300fbf9", choices: ["b3bec5933060fb1b", "e3ff6137dc490e5d", "1ff36bdddb6137d8", "d0260a41540e0169"],
  },
  gr18: {
    letter: "A", answer: "no: the book is never a forecast of a run",
    rule: "the book is never a forecast",
    question: "May you write \"price will run to the call wall 21600.00 today\"?",
    text: "44696c1547542e39", choices: ["4e4ee9ae64469227", "f488a0c61871dd7d", "d831f4f3488807b3", "b87883ef5c83b3b1"],
  },
  gr19: {
    letter: "B", answer: "normal variation up: the gamma word is not the day type",
    rule: "the gamma word is not the computed regime of the bars and not the day type",
    question: "What is the day type?",
    text: "d97d185423d27753", choices: ["822a06b9d845cbfd", "66472d11cb67363f", "a35746d33c2bd2a3", "2fbbed0625058411"],
  },
  gr20: {
    letter: "D", answer: "yes: it holds as of the prior close, all day long",
    rule: "the line holds as its as-of says: no update through the day; the day's own-expiry positions are not in it",
    question: "Does the line still hold as its as-of says?",
    text: "4276d678c00cf3c9", choices: ["6da5c24e8e4f21a5", "317faff215374715", "d09a31feb9248d3f", "3b2759ea34cc6a8c"],
  },
};
const sha = s => require('crypto').createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const keysOf = items => Object.fromEntries(items.map(q => [q.id, { letter: LETTERS[q.choices.indexOf(q.answer)], answer: q.answer, rule: q.rule, question: q.text.split('\n').pop(), text: sha(q.text), choices: q.choices.map(sha) }]));

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
const polarity = c => (/^yes\b/i.test(c) ? 'yes' : /^no\b/i.test(c) ? 'no' : 'other');
/** The tells: how often the key is the longest or the shortest option, or the lone yes or no among its options. */
function tells(items) {
  const n = items.length;
  const len = q => q.choices.map(c => c.length);
  const longest = items.filter(q => q.answer.length >= Math.max(...len(q))).length;
  const shortest = items.filter(q => q.answer.length <= Math.min(...len(q))).length;
  const odd = items.filter(q => { const p = polarity(q.answer); return p !== 'other' && q.choices.filter(c => polarity(c) === p).length === 1; }).length;
  return { n, longest: longest / n, shorterThanLongest: (n - longest) / n, shortest: shortest / n, odd };
}
const tellsOk = t => t.longest <= 0.4 && t.shorterThanLongest >= 0.4 && t.shortest <= 0.4 && t.odd <= 3;
function spread(items) {
  const n = items.length;
  const letters = Object.fromEntries([...LETTERS].map(l => [l, items.filter(q => LETTERS[q.choices.indexOf(q.answer)] === l).length]));
  const isNo = c => /^no\b/i.test(c);
  const alwaysNo = items.filter(q => { const c = q.choices.find(isNo); return c !== undefined && c === q.answer; }).length;
  return { n, letters, maxShare: Math.max(...Object.values(letters)) / n, noShare: items.filter(q => isNo(q.answer)).length / n, alwaysA: letters.A / n, alwaysB: letters.B / n, alwaysNo: alwaysNo / n };
}
const spreadOk = s => s.maxShare <= 1 / 3 && s.noShare <= 0.35 && s.alwaysA <= 1 / 3 && s.alwaysB <= 1 / 3 && s.alwaysNo <= 0.4;

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

test('the gex-regime items (mutation): a changed scenario or a reworded distractor fails the pin', () => {
  const at = id => qs.findIndex(q => q.id === id);
  const q17 = qs[at('gr17')];
  const flipped = { ...q17, text: q17.text.replace('AGAINST the long', 'FOR the long') };
  assert.notEqual(flipped.text, q17.text);
  assert.notDeepEqual(keysOf(qs.map(q => (q.id === 'gr17' ? flipped : q))), KEYS, 'gr17: its scenario flipped');
  const q6 = qs[at('gr6')];
  const reworded = { ...q6, choices: q6.choices.map(c => (c === q6.answer ? c : `${c} today`)) };
  assert.notDeepEqual(keysOf(qs.map(q => (q.id === 'gr6' ? reworded : q))), KEYS, 'gr6: a distractor reworded');
});

test('the gex-regime items: no length tell and no polarity tell', () => {
  const t = tells(qs);
  assert.ok(tellsOk(t), JSON.stringify(t));
  // The check bites: every key padded to the longest option, or every key the lone "no" among "yes" options, fails it.
  const padded = qs.map(q => { const pad = `${q.answer} ${'x'.repeat(Math.max(...q.choices.map(c => c.length)))}`; return { ...q, answer: pad, choices: q.choices.map(c => (c === q.answer ? pad : c)) }; });
  assert.ok(!tellsOk(tells(padded)), 'every key the longest');
  const lone = qs.map(q => ({ ...q, answer: `no: ${q.answer}`, choices: q.choices.map(c => (c === q.answer ? `no: ${c}` : `yes: ${c.replace(/^(?:yes|no)\b[,:]?\s*/i, '')}`)) }));
  assert.ok(!tellsOk(tells(lone)), 'every key the lone no');
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
  // The check bites: every key on A, every key on B, or every key a "no" answer, fails it.
  const allB = qs.map(q => { const rest = q.choices.filter(c => c !== q.answer); return { ...q, choices: [rest[0], q.answer, ...rest.slice(1)] }; });
  assert.ok(!spreadOk(spread(allB)), 'every key on B');
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
