'use strict';

// The context quiz offline (no model call): every question's anchor, the phrase of the skills that states its rule, is
// in the prompt it is asked against, built as the runner builds it; deleting a rule's text fails here. Every layer is
// asked, the ids are unique, and the pass bar is the whole quiz.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
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

test('context quiz: a lookup question is asked against the head prompt plus the skills it looks up (q31, q32: candle-reading\'s stack line)', () => {
  const prompts = Q.buildPrompts(ROOT, QUIZ);
  for (const id of ['q31', 'q32']) {
    const q = QUIZ.questions.find(x => x.id === id);
    assert.deepStrictEqual([q.prompt, q.lookup, Q.promptKey(q)], ['lookup', ['candle-reading'], `lookup:${id}`]);
    const p = prompts[`lookup:${id}`];
    assert.ok(p.startsWith(prompts.head) && p.includes('<skill name="candle-reading">'), id);
  }
  assert.ok(!prompts.head.includes('<skill name="candle-reading">'), 'not embedded in the head prompt alone');
  // The owner's stack line deleted from candle-reading: both anchors go missing.
  const flat = t => t.replace(/\s+/g, ' ');
  const cut = Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, flat(v).replace(/The reaction rules \(below\) hold on every timeframe;[^.]*\. The 3m only times the entry; alone it can be noise\./, '')]));
  assert.deepStrictEqual(Q.anchorsMissing(QUIZ, cut).filter(x => x === 'q31' || x === 'q32'), ['q31', 'q32']);
  assert.ok(Q.quizErrors({ ...QUIZ, questions: [{ ...QUIZ.questions.find(x => x.id === 'q31'), lookup: undefined }] }).some(e => /lookup/.test(e)));
});

test('context quiz: the prepare-ahead questions (q40-q44, b8) are asked against the head prompt plus the prepare-ahead skill, looked up', () => {
  const prompts = Q.buildPrompts(ROOT, QUIZ);
  const ids = ['q40', 'q41', 'q42', 'q43', 'q44', 'b8'];
  for (const id of ids) {
    const q = [...QUIZ.questions, ...QUIZ.partB].find(x => x.id === id);
    assert.deepStrictEqual([q.prompt, q.lookup, Q.promptKey(q)], ['lookup', ['prepare-ahead'], `lookup:${id}`]);
    const p = prompts[`lookup:${id}`];
    assert.ok(p.startsWith(prompts.head) && p.includes('<skill name="prepare-ahead">'), id);
  }
  // The skill is delivered by lookup only: it is in no other prompt, so the head prompt (the prompt of every cycle, prepare ahead off) is unchanged.
  assert.ok(!prompts.head.includes('<skill name="prepare-ahead">') && !prompts['head+risk'].includes('<skill name="prepare-ahead">'));
  // b8 is Part B: the Bias line (long refused) with the plan listing the long.
  assert.deepStrictEqual(QUIZ.partB.find(x => x.id === 'b8').excerpt, { bias: { h4: -1, h1: -1, t15: 1 } });
  // The confirm rule deleted from the skill, or the trap sentences: their anchors go missing.
  const flat = t => t.replace(/\s+/g, ' ');
  const cut = (re) => Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, flat(v).replace(re, '')]));
  for (const [id, re] of [['q40', /A met TAKE is a confirm:/], ['q41', /A pass is the CYCLE RESULT, with why\./], ['q42', /a plan that said take is no reason to take/], ['q43', /a plan that said pass is no reason to pass\./], ['q44', /with the reads as the at-close facts give them \(not as the plan wrote them\)/]]) {
    assert.deepStrictEqual(Q.anchorsMissing(QUIZ, cut(re)).filter(x => x === id), [id], id);
  }
  // The standing-scenario questions (q47-q49; q46 removed: the standing line prints the computed trigger, PR C3; q45 removed:
  // 7/10 in the live run, kept for the paired test): prepare-ahead and candle-reading looked up (the confirm reads the closing
  // candle as candle-reading does; a cycle that composes a rejection or a break looks it up: trade-lifecycle); each one's
  // sentence deleted, its anchor goes missing.
  for (const [id, re] of [['q47', /compose_check refusing is the pass/], ['q48', /PASS if compose_check refuses it\./], ['q49', /read that candle as candle-reading does/]]) {
    const q = QUIZ.questions.find(x => x.id === id);
    assert.deepStrictEqual([q.prompt, q.lookup, Q.promptKey(q)], ['lookup', ['prepare-ahead', 'candle-reading'], `lookup:${id}`], id);
    assert.ok(prompts[`lookup:${id}`].includes('<skill name="prepare-ahead">') && prompts[`lookup:${id}`].includes('<skill name="candle-reading">'), id);
    assert.deepStrictEqual(Q.anchorsMissing(QUIZ, cut(re)).filter(x => x === id), [id], id);
  }
  // The rule first and bold: the skill's first rule line.
  const body = fs.readFileSync(path.join(ROOT, 'skills', 'prepare-ahead', 'SKILL.md'), 'utf8');
  assert.ok(/## How It Works\s+\*\*The candle decides: confirm a scenario only if the closed candle meets its TAKE conditions; else pass\.\*\*/.test(body));
});

test('context quiz: every layer asked, ids unique, the bar the whole quiz at K 5', () => {
  const all = [...QUIZ.questions, ...QUIZ.partB];
  assert.deepStrictEqual([...new Set(QUIZ.questions.map(x => x.layer))].sort(), [...Q.LAYERS].sort());
  assert.strictEqual(new Set(all.map(x => x.id)).size, all.length);
  assert.strictEqual(QUIZ.k, 5);
  assert.deepStrictEqual(QUIZ.passBar, { partA: { allCorrect: QUIZ.questions.length, bothWays: 0 }, partB: { allCorrect: QUIZ.partB.length, bothWays: 0 } });
  // 37 since q38-q39 (a cited setup in an attempt; a missing track record is no reason to pass); 42 and 8 since q40-q44 and
  // b8 (prepare-ahead's confirm rule: PR C); 45 since q47-q49 (a standing scenario: compose_check decides; the closing
  // candle read as candle-reading does). q46 went with PR C3's computed trigger; q45 (the 3m doji, a yes/no) measured 7/10
  // live and is out of the bar, noted for the paired test. 58 since q50-q63 less q53 (a 3m swing is stop structure, not a level: measured 6/10, out of the bar; market context: levels and reactions, structure breaks, trend vs range, pullback vs reversal; each anchored in the skill that states it). The pass bar rises with them.
  assert.strictEqual(QUIZ.questions.length, 58);
  assert.strictEqual(QUIZ.partB.length, 8);
});

test('context quiz: q45 and q46 are out of the bar (q46: the standing line prints the computed trigger, PR C3; q45: 7/10 live)', () => {
  for (const id of ['q45', 'q46']) assert.ok(!QUIZ.questions.some(x => x.id === id), id);
});
