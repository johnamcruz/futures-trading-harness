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

test('anchorErrors: each required pattern is tested line by line on the champion\'s prompt, each line cut at gate.maxGradedLineChars', { timeout: 10000 }, () => {
  const cap = Q.loadQuiz().value.gate.maxGradedLineChars;
  const q = PQ.questionOf({ ...QUESTION, text: 'Does the sweep wait?', anchor: 'NEW → wait', required: ['wait.{0,60}retest.{0,60}close'] }, 'x');
  // A gap's bounds are no numbers the question adds.
  // A long prompt (as the head's, about 85k characters flattened), its words on one line: matched, and fast.
  const lines = Array.from({ length: 1700 }, (_, i) => `- line ${'abcd '.repeat(9)}${i % 2 ? 'wait' : 'retest'}`);
  const champion = { head: [...lines, '- wait for the retest at the close'].join('\n') };
  assert.ok(champion.head.length > 80000);
  const edited = { head: `${champion.head}\n- NEW → wait` };
  let t = Date.now();
  assert.deepStrictEqual(PQ.anchorErrors(q, { editPrompts: edited, championPrompts: champion, maxLineChars: cap }), []);
  assert.ok(Date.now() - t < 200, String(Date.now() - t));
  // The words split over two lines: no line holds the answer (no match across a line break).
  const split = { head: [...lines, '- wait for the', 'retest at the close'].join('\n') };
  assert.match(PQ.anchorErrors(q, { editPrompts: { head: `${split.head}\n- NEW → wait` }, championPrompts: split, maxLineChars: cap }).join(), /question\.required\[0\]: matches nothing/);
  // A line past the cap is tested on its first maxLineChars characters only (a hostile long line stays fast).
  const longLine = { head: `${'wait '.repeat(cap)}retest at the close` };
  t = Date.now();
  assert.match(PQ.anchorErrors(q, { editPrompts: { head: `${longLine.head}\n- NEW → wait` }, championPrompts: longLine, maxLineChars: cap }).join(), /matches nothing/);
  assert.ok(Date.now() - t < 200);
  // The cap read from the quiz file when not given.
  assert.deepStrictEqual(PQ.anchorErrors(q, { editPrompts: edited, championPrompts: champion }), []);
});

test('questionErrors: the proposer\'s patterns are bounded: compiled, at most gate.maxPatternChars, in the pattern grammar', () => {
  const gate = Q.loadQuiz().value.gate;
  const max = gate.maxPatternChars;
  assert.strictEqual(max, 120);
  assert.deepStrictEqual(PQ.questionErrors(QUESTION, gate), []);
  assert.match(PQ.questionErrors({ ...QUESTION, required: ['x'.repeat(max + 1)] }, gate).join(), new RegExp(`question\\.required\\[0\\]: at most ${max} characters`));
  assert.deepStrictEqual(PQ.questionErrors({ ...QUESTION, required: ['x'.repeat(max)] }, gate), []);
  assert.match(PQ.questionErrors({ ...QUESTION, forbidden: ['x'.repeat(max + 1)] }, gate).join(), /question\.forbidden\[0\]: at most/);
  // Every form outside the grammar (scripts/lib/train/pattern-grammar.js), required or forbidden, named by its rule.
  for (const bad of ['(a+)+', '(.*)*', '(\\w+\\s?)*', '(?:x*)+y', '(a{1,3})+', '((ab)+)*', 'abcd(\\w|\\d)*!', '.{0,60}.{0,60}.{0,60}.{0,60}!', '\\w*\\w{0,999}\\w*!', '.*.*zzzz', 'a+b*']) {
    for (const k of ['required', 'forbidden']) assert.match(PQ.questionErrors({ ...QUESTION, [k]: [bad] }, gate).join(), new RegExp(`question\\.${k}\\[0\\]: (?!at most ${max})`), `${k} ${bad}`);
  }
  for (const ok of ['\\bwait\\b', '(enter|take) now', 'retest (a|the)', '(no)?\\s+wait', 'wait(s|ed)?', 'three\\s+pushes', 'long.{0,40}okay']) {
    for (const k of ['required', 'forbidden']) assert.deepStrictEqual(PQ.questionErrors({ ...QUESTION, [k]: [ok] }, gate), [], ok);
  }
  assert.match(PQ.questionErrors({ ...QUESTION, required: ['('] }, gate).join(), /not a regex/);
  // The limits are the caller's (the run's quiz file): none given, the repo's.
  assert.match(PQ.questionErrors({ ...QUESTION, required: ['long.{0,40}okay'] }, { ...gate, maxGaps: 0 }).join(), /question\.required\[0\]: at most 0 wildcard gaps/);
  assert.match(PQ.questionErrors({ ...QUESTION, required: ['x'.repeat(max + 1)] }).join(), /at most/);
});

test('gradeAnswer: an answer line longer than gate.maxGradedLineChars fails closed, never graded on a cut line', { timeout: 10000 }, () => {
  const quiz = Q.loadQuiz().value;
  const cap = quiz.gate.maxGradedLineChars;
  assert.strictEqual(cap, 1000);
  const q = { id: 'x', layer: 'entry', prompt: 'head', text: 't', rule: 'r', anchor: 'a', required: ['\\bwait\\b'], forbidden: ['\\benter now\\b'] };
  // 1110 characters: the answer's words up front, a forbidden phrase past the cap.
  const long = `wait for the retest, ${'and so on '.repeat(108)}enter now`;
  assert.ok(long.length > cap && long.length < 1200, String(long.length));
  const g = Q.gradeAnswer(quiz, q, `ANSWER: ${long}`);
  assert.strictEqual(g.pass, false);
  assert.match(g.why, new RegExp(`longer than gate\\.maxGradedLineChars \\(${cap}\\)`));
  assert.strictEqual(g.line, long, 'the whole line, never a silently cut one');
  // At the cap: graded as before.
  const ok = `wait for the retest${' '.repeat(cap - 19)}`.slice(0, cap);
  assert.strictEqual(Q.gradeAnswer(quiz, q, `ANSWER: ${ok}`).pass, true);
  // A pattern that would backtrack on a long line is never run on one.
  const slow = { ...q, required: ['\\w*\\w*\\w*!'] };
  const t = Date.now();
  assert.strictEqual(Q.gradeAnswer(quiz, slow, `ANSWER: ${'a'.repeat(cap * 20)}`).pass, false);
  assert.ok(Date.now() - t < 200);
  for (const key of ['maxGradedLineChars', 'maxGaps', 'maxGapChars', 'maxOptionals']) {
    const { [key]: _x, ...rest } = quiz.gate;
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
  const opts = gate;
  // In the grammar, yet no literal word: refused by the literal-run rule itself.
  for (const bad of ['\\bno\\b', '\\bthe\\b', 'abc', '(wait)?', 'wai?t', 'w-a-i-t', '(a|wait) x', 'the.{0,9}end']) {
    assert.match(PQ.questionErrors({ ...QUESTION, required: [bad] }, opts).join(), new RegExp(`question\\.required\\[0\\]: no literal run of ${n} letters or digits`), bad);
  }
  // Outside the grammar: refused whatever their words.
  for (const bad of ['.', '.*', '\\w+', '[a-z]{4,}', '\\w\\w\\w\\w', '(.|wait)', 'wait|.', '(?!wait).', '.{0,1000}', '\\w{1,1000}', '\\S{1,9999}', '((wait))?', '(?:(?:wait))?', '(?<word>.)', '(?<word>.)\\k<word>', '(?<!wait).', '(?:wait|.)+', 'wait{0}', '(wait){0,3}', '(?<verb>wait)', '((wait))', 'wait{2}', '(?=wait)wait']) {
    assert.ok(PQ.questionErrors({ ...QUESTION, required: [bad] }, opts).length > 0, bad);
  }
  for (const ok of ['\\bwait\\b', 'wait', '(enter|take) now', '(no)?\\s+wait', 'retest', 'wait(s|ed)?', '\\bclose[sd]?\\b', '2021', 'retest (a|the)', '(a|the) retest', '(?:wait|hold) (on|for)']) {
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
  assert.strictEqual(PQ.isConsolidation(e('- only longs, and you must hold unless the close breaks', '- only longs, and you must hold unless close breaks'), root), true);
  assert.strictEqual(PQ.isConsolidation(e('- line two, the close\n', '', 'removal'), root), true);
  // The lists are the quiz file's (or given): a word of one's own counts.
  assert.ok(['only', 'must', 'unless'].every(w => quiz.restrictions.includes(w)), JSON.stringify(quiz.restrictions));
  assert.strictEqual(PQ.isConsolidation(e('- line two, the close', '- line two'), root, { restrictions: ['close'] }), false);
  assert.strictEqual(PQ.isConsolidation(e('- line two, the close', '- line two'), root, { negations: ['close'] }), false);
  assert.match(Q.quizErrors({ ...quiz, restrictions: [] }).join(), /restrictions: /);
  assert.match(Q.quizErrors({ ...quiz, restrictions: ['Only'] }).join(), /restrictions: /);
});

test('isConsolidation: a polar word (above/below, long/short, premium/discount, ...) added, removed or moved: never one', () => {
  const root = require('../helpers').tmpDir();
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.join(root, 'skills', 'a'), { recursive: true });
  // The fib-retracement and VWAP skills' own lines.
  fs.writeFileSync(path.join(root, 'skills/a/SKILL.md'), '---\nname: a\ndescription: d\n---\n\n# A\n\n**Premium and discount.** Above the leg\'s 0.5\nlevel is premium, below it discount: a long from a bullish leg\'s discount,\na short from a bearish leg\'s premium (hypothesis).\n\nback in the leg\'s direction: for a bullish leg, above the zone\'s top, or\n\n- Price above a rising RTH VWAP, with pullbacks holding it → buyers in\n\n- buy low and then sell high\n\n- line two\n');
  const e = (find, replace, kind = 'rule') => ({ tag: { skill: 'a', kind }, proposal: { ...PROPOSAL, edits: [{ file: 'skills/a/SKILL.md', find, replace }] } });
  const quiz = Q.loadQuiz().value;
  assert.strictEqual(PQ.isConsolidation(e('level is premium, below it discount', 'level is discount, below it premium'), root), false, 'premium/discount swapped');
  assert.strictEqual(PQ.isConsolidation(e('above the zone\'s top', 'below the zone\'s top'), root), false, 'above the zone -> below');
  assert.strictEqual(PQ.isConsolidation(e('- Price above a rising RTH VWAP', '- Price below a rising RTH VWAP'), root), false, 'vwap above -> below');
  assert.strictEqual(PQ.isConsolidation(e('a long from a bullish', 'a short from a bullish'), root), false, 'a long from -> a short from');
  // A deletion that leaves "a long from a bullish leg's premium": polar words gone, the rule flipped.
  assert.strictEqual(PQ.isConsolidation(e('a long from a bullish leg\'s discount,\na short from a bearish leg\'s premium', 'a long from a bullish leg\'s premium', 'removal'), root), false, 'a removal that flips the rule');
  // Every polar word kept, but a neighbour changed: never one either.
  assert.strictEqual(PQ.isConsolidation(e('- buy low and then sell high', '- buy low sell high'), root), false, 'a polar word moved beside another');
  // A deletion of a whole line holding a polar word blocks too (strict, failing closed); one beside it does not.
  assert.strictEqual(PQ.isConsolidation(e('- buy low and then sell high\n\n', '', 'removal'), root), false);
  assert.strictEqual(PQ.isConsolidation(e('- buy low and then sell high\n\n- line two', '- buy low and then sell high'), root), true, 'the next line deleted');
  assert.ok(['above', 'below', 'long', 'short', 'premium', 'discount', 'buy', 'sell', 'high', 'low'].every(w => quiz.polar.includes(w)), JSON.stringify(quiz.polar));
  assert.strictEqual(PQ.isConsolidation(e('- line two\n', '', 'removal'), root, { polar: ['two'] }), false, 'the list given');
  assert.match(Q.quizErrors({ ...quiz, polar: [] }).join(), /polar: /);
});

test('isConsolidation: a pure in-order deletion only (a removal, or a trim); its question is optional', () => {
  const root = require('../helpers').tmpDir();
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.join(root, 'skills', 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills/a/SKILL.md'), '---\nname: a\ndescription: d\n---\n\n# A\n\n- line one\n\n- line two\n\n- wait for the close\n');
  const e = (replace, kind = 'rule', find = '- line one') => ({ tag: { skill: 'a', kind }, proposal: { ...PROPOSAL, edits: [{ file: 'skills/a/SKILL.md', find, replace }] } });
  assert.strictEqual(PQ.isConsolidation(e('', 'removal', '- line two\n'), root), true, 'a removal');
  assert.strictEqual(PQ.isConsolidation(e('- line two', 'rule', '- line one\n\n- line two'), root), true, 'a trim: a line deleted');
  assert.strictEqual(PQ.isConsolidation(e('- LINE ONE.', 'rule', '- line one'), root), true, 'case and punctuation are no words');
  // Not a deletion: the document's own words added, or the same words reordered.
  assert.strictEqual(PQ.isConsolidation(e('- line one; the close'), root), false, 'words the find lacks, even the document\'s own');
  assert.strictEqual(PQ.isConsolidation(e('- line two, line one', 'rule', '- line one, line two'), root), false, 'reordered');
  assert.strictEqual(PQ.isConsolidation(e('- line one\n- a stall-break → enter'), root), false, 'a new word');
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
