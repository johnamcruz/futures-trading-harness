'use strict';

// A probe edit's own quiz question (scripts/lib/train/probe-question.js; docs/TRAINING.md, the probe round): the
// proposer writes the question its edit teaches first; code checks it before any model call. Its shape is the quiz
// file's (eval/context-quiz.js questionErrors), its id is code's (e-<proposal id>), its anchor is in the edited tree's
// prompt and not in the champion's, and it adds no numbers. The proposal's id never reads it.

const test = require('node:test');
const assert = require('node:assert');
const PQ = require('../../scripts/lib/train/probe-question');
const PE = require('../../scripts/lib/train/probe-edit');
const P = require('../../scripts/lib/train/proposal');
const Q = require('../../scripts/lib/eval/context-quiz');

const QUESTION = { layer: 'entry', prompt: 'head', text: 'The 15m sweep closed back inside. Enter now?', rule: 'a sweep that closes back inside waits for the retest', anchor: 'closes back inside → wait for the retest', required: ['\\bwait\\b'], forbidden: ['\\benter now\\b'] };
const PROPOSAL = { targets: ['wrong stated reason'], expects: 'fewer early entries', edits: [{ file: 'skills/a/SKILL.md', find: '- line one', replace: '- line one\n- a sweep closes back inside → wait for the retest' }] };

test('splitTagged: the question is metadata beside the tag; the proposal (and so its id) never holds it', () => {
  const raw = { tag: { skill: 'a', finding: 'F1', kind: 'rule' }, question: QUESTION, ...PROPOSAL };
  const s = PE.splitTagged(raw);
  assert.deepStrictEqual(s.question, QUESTION);
  assert.deepStrictEqual(s.proposal, PROPOSAL);
  assert.strictEqual(P.proposalId(s.proposal), P.proposalId(PROPOSAL), 'the id is the edit\'s alone: duplicates found as before');
  assert.strictEqual(P.proposalId(PE.splitTagged({ ...raw, question: { ...QUESTION, text: 'another' } }).proposal), P.proposalId(PROPOSAL));
  // No question written: none (the round's check names it missing); a null one is kept as written.
  assert.ok(!('question' in PE.splitTagged({ tag: {}, ...PROPOSAL })));
  assert.strictEqual(PE.splitTagged({ tag: {}, question: null, ...PROPOSAL }).question, null);
});

test('questionOf: the id is code\'s, e-<proposal id>; questionErrors: the quiz file\'s checks on it, before any model call', () => {
  const id = P.proposalId(PROPOSAL);
  const q = PQ.questionOf(QUESTION, id);
  assert.strictEqual(q.id, `e-${id}`);
  assert.deepStrictEqual(Q.questionErrors(q, { part: 'questions', at: 'question' }), []);
  assert.deepStrictEqual(PQ.questionErrors(QUESTION), []);
  // Missing, or not an object: the edit is invalid, the reason named.
  for (const bad of [undefined, null, 'a question', []]) assert.match(PQ.questionErrors(bad).join(), /^question: the quiz question the edit teaches/, JSON.stringify(bad));
  // The quiz file's own checks, under the name "question".
  assert.match(PQ.questionErrors({ ...QUESTION, layer: 'vibes' }).join(), /question\.layer: one of/);
  assert.match(PQ.questionErrors({ ...QUESTION, anchor: '' }).join(), /question\.anchor: the phrase/);
  assert.match(PQ.questionErrors({ ...QUESTION, required: [] }).join(), /question\.required: at least one/);
  assert.match(PQ.questionErrors({ ...QUESTION, required: ['('] }).join(), /question\.required\[0\]: not a regex/);
  assert.match(PQ.questionErrors({ ...QUESTION, prompt: 'lookup' }).join(), /question\.lookup/);
  assert.deepStrictEqual(PQ.questionErrors({ ...QUESTION, prompt: 'lookup', lookup: ['a'] }), []);
  // The id is never the proposer's; no other key (a Part B excerpt, an unknown one).
  assert.match(PQ.questionErrors({ ...QUESTION, id: 'q1' }).join(), /question\.id: assigned by code \(e-<proposal id>\), never written/);
  assert.match(PQ.questionErrors({ ...QUESTION, excerpt: { bias: {} }, extra: 1 }).join(), /question: unknown keys: excerpt, extra/);
  assert.throws(() => PQ.questionOf(QUESTION, ''), /proposal id/);
});

test('anchorErrors: the anchor in the edited tree\'s prompt and not the champion\'s; no number the champion\'s prompt lacks', () => {
  const q = PQ.questionOf(QUESTION, 'abc123');
  const champion = { head: '# A\n\n- line one\n\n- a 15m sweep is a level taken; wait for its close' };
  const edited = { head: '# A\n\n- line one\n- a sweep closes back inside →   wait for the retest\n\n- a 15m sweep is a level taken; wait for its close' };
  assert.deepStrictEqual(PQ.anchorErrors(q, { editPrompts: { head: edited.head.replace('closes back inside →   wait', 'closes back inside → wait') }, championPrompts: champion }), []);
  // Whitespace collapsed, as the quiz's own anchor check reads it (eval/context-quiz.js anchorsMissing).
  assert.deepStrictEqual(PQ.anchorErrors(q, { editPrompts: edited, championPrompts: champion }), []);
  assert.match(PQ.anchorErrors(q, { editPrompts: champion, championPrompts: champion }).join(), /question\.anchor: not in the edited tree's head prompt/);
  assert.match(PQ.anchorErrors(q, { editPrompts: edited, championPrompts: edited }).join(), /question\.anchor: the champion's head prompt already states it: the champion can read the answer off, so no edit is needed/);
  // A question asked against a prompt the trees don't build (an analyst's skill): blocked, never asked.
  assert.match(PQ.anchorErrors(PQ.questionOf({ ...QUESTION, prompt: 'head+risk' }, 'abc'), { editPrompts: edited, championPrompts: champion }).join(), /no head\+risk prompt/);
  // No number the champion's prompt does not hold (the edit adds none, so its question asks for none): 15 is there, 3 is not.
  assert.deepStrictEqual(PQ.anchorErrors(PQ.questionOf({ ...QUESTION, text: 'The 15m sweep closed back inside. Enter?' }, 'x'), { editPrompts: edited, championPrompts: champion }), []);
  assert.match(PQ.anchorErrors(PQ.questionOf({ ...QUESTION, text: 'The 3m sweep closed back inside. Enter?' }, 'x'), { editPrompts: edited, championPrompts: champion }).join(), /question: no numbers: it adds 3/);
  assert.match(PQ.anchorErrors(PQ.questionOf({ ...QUESTION, required: ['\\bwait two bars\\b'] }, 'x'), { editPrompts: edited, championPrompts: champion }).join(), /question: no numbers: it adds two/);
});

test('the probe prompt asks for the question first, and its PROPOSAL example is what the parser and the checks read', () => {
  const path = require('path');
  const proposer = require('../../scripts/lib/train/proposer');
  const ROOT = path.resolve(__dirname, '..', '..');
  const t = proposer.readProbeTemplate(ROOT);
  assert.ok(t.includes('- Write the quiz question that your edit teaches first, as the edit\'s "question": it must be a question you would answer wrongly now and rightly after the edit; write its answer as required and forbidden phrases'));
  assert.match(t, /"anchor" is a phrase copied exactly from your new text/);
  const prompt = proposer.probePrompt({ template: t, findings: [{ id: 'F1', skill: 'a', kind: 'misread', count: 1, of: 1, detail: '' }], lessons: null, files: ['skills/a/SKILL.md'], k: 2 });
  assert.match(prompt, new RegExp(`"layer" is one of: ${Q.LAYERS.join(', ')}\\.`));
  assert.doesNotMatch(prompt, /\{\{/);
  // The example line: the parser reads it, splitTagged takes the question apart, and with its placeholders filled the
  // question passes the checks (only the quiz file's keys; no id, which is code's).
  const lines = P.parseProposals(t);
  assert.strictEqual(lines.length, 1);
  const s = PE.splitTagged(lines[0].proposal);
  assert.deepStrictEqual(Object.keys(s.tag).sort(), ['finding', 'kind', 'skill']);
  assert.ok(Object.keys(s.question).every(k => PQ.KEYS.includes(k)), Object.keys(s.question).join());
  assert.ok(!('question' in s.proposal) && !('tag' in s.proposal));
  assert.deepStrictEqual(PQ.questionErrors({ ...s.question, layer: 'entry', lookup: ['a'] }), []);
  assert.deepStrictEqual(Object.keys(s.proposal).sort(), ['edits', 'expects', 'targets', 'why']);
  // The risk manager's question, as the prompt says it: head+risk, no lookup.
  const { lookup: _l, ...rest } = s.question;
  assert.deepStrictEqual(PQ.questionErrors({ ...rest, layer: 'approval', prompt: 'head+risk' }), []);
});

test('anchorErrors: every required pattern matches text the champion\'s prompt already holds (a coined phrase is no question)', () => {
  const champion = { head: '- a sweep is a level taken; wait for its close' };
  // The edit coins "stall-break" and the question asks for it: red is trivially true, green a quote. Refused.
  const coined = PQ.questionOf({ ...QUESTION, anchor: 'a stall-break → enter', required: ['stall-break'] }, 'x');
  const edited = { head: `${champion.head}\n- a stall-break → enter` };
  assert.match(PQ.anchorErrors(coined, { editPrompts: edited, championPrompts: champion }).join(), /question\.required\[0\]: matches nothing in the champion's head prompt: the answer's words must already be there/);
  // The same rule asked in the champion's own words: the answer exists, so a champion failure is a real misreading.
  const fair = PQ.questionOf({ ...QUESTION, text: 'Does the sweep wait?', anchor: 'a stall-break → enter', required: ['\\bwait\\b'] }, 'x');
  assert.deepStrictEqual(PQ.anchorErrors(fair, { editPrompts: edited, championPrompts: champion }), []);
  // Each pattern: one coined beside a known one is still refused.
  const mixed = PQ.questionOf({ ...QUESTION, anchor: 'a stall-break → enter', required: ['\\bwait\\b', 'stall-break'] }, 'x');
  assert.match(PQ.anchorErrors(mixed, { editPrompts: edited, championPrompts: champion }).join(), /question\.required\[1\]: matches nothing/);
});

test('questionErrors: the proposer\'s patterns are bounded: compiled, at most gate.maxPatternChars, no nested quantifier', () => {
  const max = Q.loadQuiz().value.gate.maxPatternChars;
  assert.strictEqual(max, 120);
  assert.deepStrictEqual(PQ.questionErrors(QUESTION, { maxPatternChars: max }), []);
  assert.match(PQ.questionErrors({ ...QUESTION, required: ['x'.repeat(max + 1)] }, { maxPatternChars: max }).join(), new RegExp(`question\\.required\\[0\\]: at most ${max} characters`));
  assert.deepStrictEqual(PQ.questionErrors({ ...QUESTION, required: ['x'.repeat(max)] }, { maxPatternChars: max }), []);
  assert.match(PQ.questionErrors({ ...QUESTION, forbidden: ['x'.repeat(max + 1)] }, { maxPatternChars: max }).join(), /question\.forbidden\[0\]: at most/);
  for (const bad of ['(a+)+', '(.*)*', '(\\w+\\s?)*', '(?:x*)+y', '(a{1,3})+', '((ab)+)*']) {
    assert.match(PQ.questionErrors({ ...QUESTION, required: [bad] }, { maxPatternChars: max }).join(), /question\.required\[0\]: a nested quantifier/, bad);
  }
  for (const ok of ['\\bwait\\b', '(enter|take) now', 'a+b*', '(no)?\\s+wait', '\\(a+\\)+']) {
    assert.deepStrictEqual(PQ.questionErrors({ ...QUESTION, forbidden: [ok] }, { maxPatternChars: max }), [], ok);
  }
  assert.match(PQ.questionErrors({ ...QUESTION, required: ['('] }, { maxPatternChars: max }).join(), /not a regex/);
  // The bound read from the quiz file when not given.
  assert.match(PQ.questionErrors({ ...QUESTION, required: ['x'.repeat(max + 1)] }).join(), /at most/);
});

test('questionErrors: no repeated group and at most gate.maxUnboundedQuantifiers unbounded repeats (they backtrack without end); the grader caps the line', () => {
  const quiz = Q.loadQuiz().value;
  const gate = quiz.gate;
  const opts = { maxPatternChars: gate.maxPatternChars, minLiteralRun: gate.minLiteralRun, maxUnbounded: gate.maxUnboundedQuantifiers };
  // The adversarial one: a group of overlapping branches, repeated. Unrefused it takes seconds on a short line.
  const bad = 'abcd(\\w|\\d)*!';
  const t = Date.now();
  assert.match(PQ.questionErrors({ ...QUESTION, required: [bad] }, opts).join(), /question\.required\[0\]: a repeated group/);
  assert.ok(Date.now() - t < 500);
  for (const g of ['(a|b)+wait', '(wait)*', '(wait){2}', '(wait){1,}', '(wait){2,5}', '(?:wait\\s)+', '(wait){0,2}']) {
    for (const k of ['required', 'forbidden']) assert.match(PQ.questionErrors({ ...QUESTION, [k]: [g] }, opts).join(), new RegExp(`question\\.${k}\\[0\\]: a repeated group`), `${k} ${g}`);
  }
  for (const ok of ['(enter|take) now', 'retest (a|the)', '(no)?\\s+wait', 'wait(s|ed)?', '(wait){1}', 'wait (now){0,1}', '\\(wait\\)+', 'wait[(]+']) {
    assert.deepStrictEqual(PQ.questionErrors({ ...QUESTION, required: [ok] }, opts), [], ok);
  }
  // Unbounded repeats: up to the gate's count.
  const n = gate.maxUnboundedQuantifiers;
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(PQ.questionErrors({ ...QUESTION, required: ['wait\\s+for\\s*it'] }, opts), []);
  assert.match(PQ.questionErrors({ ...QUESTION, required: ['\\w*\\w*\\w*wait'] }, opts).join(), new RegExp(`at most ${n} unbounded repeats`));
  assert.match(PQ.questionErrors({ ...QUESTION, forbidden: ['a.*b.+c{2,}wait'] }, opts).join(), /question\.forbidden\[0\]: at most/);
  // The grader tests a pattern on the answer's line cut at gate.maxGradedLineChars, whatever the model wrote.
  const cap = gate.maxGradedLineChars;
  assert.ok(Number.isInteger(cap) && cap > 0);
  const q = { id: 'x', layer: 'entry', prompt: 'head', text: 't', rule: 'r', anchor: 'a', required: ['\\w*\\w*!'], forbidden: [] };
  const t2 = Date.now();
  const g = Q.gradeAnswer(quiz, q, `ANSWER: ${'a'.repeat(cap * 20)}`);
  assert.strictEqual(g.line.length, cap);
  assert.ok(Date.now() - t2 < 5000, String(Date.now() - t2));
  for (const key of ['maxGradedLineChars', 'maxUnboundedQuantifiers']) {
    const { [key]: _x, ...rest } = gate;
    assert.match(Q.quizErrors({ ...quiz, gate: rest }).join(), new RegExp(key));
  }
});

test('literalRun: a zero count written with leading zeros ({00}, {00,3}) is optional too', () => {
  assert.strictEqual(PQ.literalRun('wait{00}', 4), false);
  assert.strictEqual(PQ.literalRun('wait{00,3}', 4), false);
  assert.strictEqual(PQ.literalRun('(wait){000,1}', 4), false);
  assert.strictEqual(PQ.literalRun('wait{01}', 4), true);
});

test('questionErrors: each required pattern holds a literal run of gate.minLiteralRun letters or digits (no "." or short word)', () => {
  const gate = Q.loadQuiz().value.gate;
  const n = gate.minLiteralRun;
  assert.strictEqual(n, 4, 'the quiz file\'s gate');
  const opts = { maxPatternChars: gate.maxPatternChars, minLiteralRun: n };
  for (const bad of ['.', '.*', '\\w+', '\\bno\\b', '\\bthe\\b', '[a-z]{4,}', '\\w\\w\\w\\w', 'abc', '(.|wait)', 'wait|.', '(wait)?', 'wai?t', '(?!wait).', 'w-a-i-t', '.{0,1000}', '\\w{1,1000}', '\\S{1,9999}', '((wait))?', '(?:(?:wait))?', '(?<word>.)', '(?<word>.)\\k<word>', '(?<!wait).', '(?:wait|.)+', 'wait{0}', '(wait){0,3}']) {
    assert.match(PQ.questionErrors({ ...QUESTION, required: [bad] }, opts).join(), new RegExp(`question\\.required\\[0\\]: no literal run of ${n} letters or digits`), bad);
  }
  for (const ok of ['\\bwait\\b', 'wait', '(enter|take) now', '(no)?\\s+wait', 'retest', 'wait(s|ed)?', '\\bclose[sd]?\\b', '2021', 'retest (a|the)', '(a|the) retest', '(?:wait|hold) (on|for)', '(?<verb>wait)', '((wait))', 'wait{2}', '(?=wait)wait']) {
    assert.deepStrictEqual(PQ.questionErrors({ ...QUESTION, required: [ok] }, opts), [], ok);
  }
  // Forbidden patterns are never required to match anything: a short one stays fine.
  assert.deepStrictEqual(PQ.questionErrors({ ...QUESTION, forbidden: ['\\bno\\b'] }, opts), []);
  // Read from the quiz file when not given; the file's gate refuses a missing or broken key.
  assert.match(PQ.questionErrors({ ...QUESTION, required: ['.'] }).join(), /no literal run/);
  const quiz = Q.loadQuiz().value;
  const { minLiteralRun: _m, ...noKey } = quiz.gate;
  assert.match(Q.quizErrors({ ...quiz, gate: noKey }).join(), /minLiteralRun: a whole number, 1 or more/);
  assert.match(Q.quizErrors({ ...quiz, gate: { ...quiz.gate, minLiteralRun: 0 } }).join(), /minLiteralRun/);
});

test('isConsolidation: a rule inversion (a negation dropped: not, never, no, n\'t, cannot, must not) is never one: it needs a question', () => {
  const root = require('../helpers').tmpDir();
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.join(root, 'skills', 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills/a/SKILL.md'), '---\nname: a\ndescription: d\n---\n\n# A\n\n- never enter before the close\n\n- you must not chase; wait\n\n- do not add, don\'t fade, you cannot trail\n\n- no entry on a wick\n\n- line two\n');
  const e = (find, replace, kind = 'rule') => ({ tag: { skill: 'a', kind }, proposal: { ...PROPOSAL, edits: [{ file: 'skills/a/SKILL.md', find, replace }] } });
  // Each in the document's own words, yet the rule flipped.
  assert.strictEqual(PQ.isConsolidation(e('- never enter before the close', '- enter before the close'), root), false, 'never');
  assert.strictEqual(PQ.isConsolidation(e('- you must not chase; wait', '- you must chase; wait'), root), false, 'must not');
  assert.strictEqual(PQ.isConsolidation(e('don\'t fade', 'fade'), root), false, "n't");
  assert.strictEqual(PQ.isConsolidation(e('fade', 'don’t fade'), root), false, 'a curly apostrophe is the same negation');
  assert.strictEqual(PQ.isConsolidation(e('you cannot trail', 'you trail'), root), false, 'cannot');
  assert.strictEqual(PQ.isConsolidation(e('- no entry on a wick', '- entry on a wick'), root), false, 'no');
  assert.strictEqual(PQ.isConsolidation(e('do not add, don\'t fade', 'do not add, fade'), root), false, 'one of two negations dropped');
  // A removal tag is no exemption: a deleted negated rule needs a question too; a deleted plain line does not.
  assert.strictEqual(PQ.isConsolidation(e('- never enter before the close\n\n', '', 'removal'), root), false, 'a removal of a never rule');
  assert.strictEqual(PQ.isConsolidation(e('- line two\n', '', 'removal'), root), true);
  // A negation kept, moved or added: never one either (a negation's reach changes with its words around it).
  assert.strictEqual(PQ.isConsolidation(e('- never enter before the close', '- never enter before the close, the close'), root), false, 'kept');
  assert.strictEqual(PQ.isConsolidation(e('do not add, don\'t fade', 'don\'t add, do not fade'), root), false, 'moved');
});

test('isConsolidation: a negation added, a word ending in n\'t, or a restriction word added or removed: never one', () => {
  const root = require('../helpers').tmpDir();
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.join(root, 'skills', 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills/a/SKILL.md'), '---\nname: a\ndescription: d\n---\n\n# A\n\n- entries are allowed; not before the open\n\n- only longs, and you must hold unless the close breaks\n\n- you shouldn\'t chase\n\n- line two, the close\n');
  const e = (find, replace, kind = 'rule') => ({ tag: { skill: 'a', kind }, proposal: { ...PROPOSAL, edits: [{ file: 'skills/a/SKILL.md', find, replace }] } });
  const quiz = Q.loadQuiz().value;
  assert.ok(!quiz.negations.includes("shouldn't"), "shouldn't is caught by its n't ending alone");
  assert.strictEqual(PQ.isConsolidation(e('- entries are allowed', '- entries are not allowed'), root), false, 'not added');
  assert.strictEqual(PQ.isConsolidation(e('- you shouldn\'t chase', '- you chase'), root), false, "shouldn't removed");
  assert.strictEqual(PQ.isConsolidation(e('- you chase', '- you shouldn\'t chase'), root), false, "shouldn't added");
  assert.strictEqual(PQ.isConsolidation(e('- only longs', '- longs'), root), false, 'only removed');
  assert.strictEqual(PQ.isConsolidation(e('you must hold', 'you hold'), root), false, 'must removed');
  assert.strictEqual(PQ.isConsolidation(e(' unless the close breaks', ''), root), false, 'unless removed');
  assert.strictEqual(PQ.isConsolidation(e('- line two, the close', '- line two, only the close'), root), false, 'only added');
  assert.strictEqual(PQ.isConsolidation(e('- only longs, and you must hold unless the close breaks\n\n', '', 'removal'), root), false, 'a removal of a restricted rule');
  // A restriction kept as it is, word for word: a trim around it stays one.
  assert.strictEqual(PQ.isConsolidation(e('- only longs, and you must hold unless the close breaks', '- only longs: you must hold unless the close breaks'), root), true);
  assert.strictEqual(PQ.isConsolidation(e('- line two, the close\n', '', 'removal'), root), true);
  // The lists are the quiz file's (or given): a word of one's own counts.
  assert.ok(['only', 'must', 'unless'].every(w => quiz.restrictions.includes(w)), JSON.stringify(quiz.restrictions));
  assert.strictEqual(PQ.isConsolidation(e('- line two, the close', '- line two'), root, { restrictions: ['close'] }), false);
  assert.strictEqual(PQ.isConsolidation(e('- line two, the close', '- line two'), root, { negations: ['close'] }), false);
  assert.match(Q.quizErrors({ ...quiz, restrictions: [] }).join(), /restrictions: /);
  assert.match(Q.quizErrors({ ...quiz, restrictions: ['Only'] }).join(), /restrictions: /);
});

test('isConsolidation: a removal, or an edit whose new text adds no word the champion\'s document lacks; its question is optional', () => {
  const root = require('../helpers').tmpDir();
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.join(root, 'skills', 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills/a/SKILL.md'), '---\nname: a\ndescription: d\n---\n\n# A\n\n- line one\n\n- line two\n\n- wait for the close\n');
  const e = (replace, kind = 'rule', find = '- line one') => ({ tag: { skill: 'a', kind }, proposal: { ...PROPOSAL, edits: [{ file: 'skills/a/SKILL.md', find, replace }] } });
  assert.strictEqual(PQ.isConsolidation(e('', 'removal', '- line two\n'), root), true, 'a removal');
  assert.strictEqual(PQ.isConsolidation(e('- line one; the close'), root), true, 'a merge in the document\'s own words');
  assert.strictEqual(PQ.isConsolidation(e('- line one\n- a stall-break → enter'), root), false, 'a new word');
  assert.strictEqual(PQ.isConsolidation(e('- LINE ONE, two'), root), true, 'case and punctuation are no words');
  assert.strictEqual(PQ.isConsolidation({ tag: null, proposal: null }, root), false);
  assert.strictEqual(PQ.isConsolidation(e('- line one, three'), path.join(root, 'none')), false, 'no document: never a consolidation (fails closed)');
});

test('miniQuiz: the quiz\'s settings with the edit\'s question alone (its runs never mix into the quiz\'s summary)', () => {
  const quiz = Q.loadQuiz().value;
  const q = PQ.questionOf(QUESTION, 'abc');
  const m = PQ.miniQuiz(quiz, q);
  assert.deepStrictEqual([m.questions, m.partB, m.k, m.gate, m.answerFormat], [[q], [], quiz.k, quiz.gate, quiz.answerFormat]);
  assert.strictEqual(quiz.questions.length > 1, true, 'the quiz itself is untouched');
});
