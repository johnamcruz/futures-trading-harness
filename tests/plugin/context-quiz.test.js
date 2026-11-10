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
  // The Part A bar stays 59, the questions measured live before q71; q71-q75 and q79-q82 are not yet measured and the
  // bar is not raised for them (the owner's k=5 run decides).
  assert.deepStrictEqual(QUIZ.passBar, { partA: { allCorrect: 59, bothWays: 0 }, partB: { allCorrect: QUIZ.partB.length, bothWays: 0 } });
  // 37 since q38-q39 (a cited setup in an attempt; a missing track record is no reason to pass); 42 and 8 since q40-q44 and
  // b8 (prepare-ahead's confirm rule: PR C); 45 since q47-q49 (a standing scenario: compose_check decides; the closing
  // candle read as candle-reading does). q46 went with PR C3's computed trigger; q45 (the 3m doji, a yes/no) measured 7/10
  // live and is out of the bar, noted for the paired test. 58 since q50-q63 less q53 (a 3m swing is stop structure, not a level: measured 6/10, out of the bar; market context: levels and reactions, structure breaks, trend vs range, pullback vs reversal; each anchored in the skill that states it). The pass bar rises with them.
  // 59 since q70 (a lesson is no phase-1 stand-down: a replay vetoed 42 times on one). q56 rewritten in place
  // (feat/chop-evidence: declared is all four above 0, never the overnight range; not yet measured live): still 59.
  // 68 since q71-q82 less q76-q78 (chop detection: what the briefing showed, in the owner's classes A, B, C and the
  // which-fact questions; pending, out of the bar until measured). q76-q78 (class D, conflicting) were dropped in review:
  // each rested on weighing, not on a skill sentence naming the conflict; q81 and q82 (one fact among both kinds) cover D.
  assert.strictEqual(QUIZ.questions.length, 68);
  assert.strictEqual(QUIZ.partB.length, 8);
});

test('context quiz: q70 (a lesson read as a phase-1 stand-down) is asked against head+risk, where strategy-library\'s step 1 says what a stand-down rests on', () => {
  const prompts = Q.buildPrompts(ROOT, QUIZ);
  const q = QUIZ.questions.find(x => x.id === 'q70');
  assert.deepStrictEqual([q.prompt, q.layer, Q.promptKey(q)], ['head+risk', 'approval', 'head+risk']);
  // The sentence deleted from strategy-library: q70's anchor goes missing.
  const flat = t => t.replace(/\s+/g, ' ');
  const cut = Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, flat(v).replace(/Never on a lesson, a review's notes or earlier reasoning: a lesson is advice, a read in the count \(`confluence-counting`\), never the reason to pass\./g, '')]));
  assert.deepStrictEqual(Q.anchorsMissing(QUIZ, prompts).filter(x => x === 'q70'), []);
  assert.deepStrictEqual(Q.anchorsMissing(QUIZ, cut).filter(x => x === 'q70'), ['q70']);
});

test('context quiz: q71-q82 (chop detection) are asked against the prompt holding the skill sentence each anchors to, on briefing lines the code writes', () => {
  const prompts = Q.buildPrompts(ROOT, QUIZ);
  const flat = t => t.replace(/\s+/g, ' ');
  const cut = re => Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, flat(v).replace(re, '')]));
  // [id, prompt, lookup, the sentence it anchors to, deleted from every prompt]: day-context, bar-briefing's neighbour
  // confluence-counting (embedded in the head prompt), trend-vs-range (looked up).
  const want = [
    ['q71', 'head', undefined, /say it in your read \("trending down so far", "rotating so far", "mixed so far"\)/g],
    ['q72', 'head', undefined, /an open inside the prior value area that stays inside the IB is balance/g],
    ['q73', 'head', undefined, /`directional up\|down`: 0\.75\+: one-way so far\./g],
    ['q74', 'head', undefined, /is traded with it \(never faded: never counter\)/g],
    ['q75', 'lookup', ['trend-vs-range'], /An unfinished pullback is no chop sign\./g],
    ['q79', 'head', undefined, /`too early \(a read from 10 bars\)`: no read\./g],
    ['q80', 'head', undefined, /mixed, none or `unknown` → neutral/g],
    ['q81', 'lookup', ['trend-vs-range'], /`rotational`: under 0\.34: back and forth so far/g],
    ['q82', 'lookup', ['trend-vs-range'], /all four your way: regime `with`, and RTH VWAP, EMA20 and day's move each above 0/g],
  ];
  assert.deepStrictEqual(Q.anchorsMissing(QUIZ, prompts).filter(x => want.some(w => w[0] === x)), []);
  for (const [id, prompt, lookup, re] of want) {
    const q = QUIZ.questions.find(x => x.id === id);
    assert.deepStrictEqual([q.prompt, q.lookup], [prompt, lookup], id);
    assert.deepStrictEqual(Q.anchorsMissing(QUIZ, cut(re)).filter(x => x === id), [id], `${id}: its sentence deleted, its anchor goes missing`);
  }
  // The scenario lines are the code's writers on synthetic values: a changed line format fails here (rewrite the question).
  const fr = { setup: '15m', entry: '3m' };
  const { rotationLine } = require('../../scripts/lib/trading/rotation-evidence');
  const { daySoFarLine } = require('../../scripts/lib/trading/day-so-far');
  const { declaredLine } = require('../../scripts/lib/trading/trend-declared');
  const rot = (vwapCrosses, dayType) => rotationLine({ vwapCrosses, dayType, setupCandle: 'neither', entryCandle: 'neither', failedBreak: { '3m': 'no', '5m': 'unknown', '15m': 'no' } }, fr);
  const day = (bars, read, direction, efficiency, score, vwapCrosses, rangeAtr) => daySoFarLine({ status: 'read', bars, read, direction, efficiency, score, vwapCrosses, rangeAtr }, { dayType: 'x' });
  const sd = (v, e, o, m, g) => ({ vwapAtr: v, ema20Atr: e, overnight: o, dayMoveAtr: m, regime: g });
  const text = id => QUIZ.questions.find(x => x.id === id).text;
  for (const [id, line] of [
    ['q71', day(42, 'rotational', 'up', 0.03, 0.19, 11, 4.1)], ['q71', rot(7, 'inside the initial balance')], ['q72', rot(5, 'inside the initial balance')],
    ['q73', day(40, 'directional', 'up', 0.3, 1.9, 1, 8.6)], ['q73', rot(0, 'trend up')], ['q74', rot(0, 'trend down')],
    ['q81', day(45, 'rotational', 'up', 0.03, 0.2, 10, 4.2)], ['q82', day(48, 'rotational', 'up', 0.02, 0.14, 12, 3.9)],
    ['q79', daySoFarLine({ status: 'too early', bars: 6, readFrom: 10, vwapCrosses: 0 })], ['q79', rot(0, null)],
    ['q80', daySoFarLine({ status: 'unknown', reason: 'no 09:30 ET bar in the data' })],
    ['q80', rotationLine({ vwapCrosses: null, dayType: null, setupCandle: null, entryCandle: null, failedBreak: { '3m': null, '5m': null, '15m': null } }, fr)],
    ['q73', declaredLine({ long: sd(1.8, 1.2, 'broke out its way', 4.9, 'with'), short: sd(-1.8, -1.2, 'broke out against', -4.9, 'against') })],
    ['q82', declaredLine({ long: sd(0.7, 0.4, 'middle third', 0.9, 'with'), short: sd(-0.7, -0.4, 'middle third', -0.9, 'against') })],
  ]) assert.ok(text(id).includes(line), `${id}: ${line}`);
  // The dropped class-D questions stay out (their ids are not reused).
  for (const id of ['q76', 'q77', 'q78']) assert.ok(!QUIZ.questions.some(x => x.id === id), id);
  // Each scenario says it is synthetic; none holds a machine path.
  for (const [id] of want) assert.match(text(id), /^Briefing lines \(synthetic, \d\d:\d\d ET\):\n/, id);
});

test('context quiz: q45 and q46 are out of the bar (q46: the standing line prints the computed trigger, PR C3; q45: 7/10 live)', () => {
  for (const id of ['q45', 'q46']) assert.ok(!QUIZ.questions.some(x => x.id === id), id);
});
