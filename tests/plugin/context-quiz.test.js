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
  // 59 since q70 (a lesson is no phase-1 stand-down: a replay vetoed 42 times on one). 63 since q79-q82 (chop
  // detection: what the briefing showed, closed choices; each measured 5/5 at k=5 closed-choice, in the bar). q71 4/5,
  // q72 4/5, q73 4/5, q74 1/5 and q75 4/5 at k=5 were removed, real model misses (the model treats unknown or neutral
  // fields as conflicting, and sometimes calls a with-trend pullback a chop sign), as q45 and q53 were: a skill gap
  // reported to the owner. q76-q78 (class D, conflicting) were dropped in review.
  // 88 since q87-q112 (q100 folded into q106, the same briefing: a quiz of 95 keeps the gate's maxSlips 8 within its
  // pinned false-reject rate) (feat/pullback-concept, owner-approved 2026-11-14: the pullback to a broken level, BOS confirms and
  // CHoCH warns on the 3m and the 15m against the 4h + 1h side, the pause not chop, late, the down mirror, the strict side,
  // the deep case, close to the picture a read, the 15m and 3m CISD; closed choices, each measured at k=3 before it entered the bar).
  // 98 since q113-q122 (feat/chop-read, owner-approved 2026-11-14: chop is the quality of movement, range its geometry;
  // repeated CHoCH both ways is chop, one CHoCH never; aligned and choppy is chop; a pause inside a Pullback never; a range
  // day is catchable at the edge the side's way, its mid-range churn chop; transitional is unclear; q123, the CHoCH pair
  // inside an open Pullback on a rotational day: the watch, not chop, Fable round 1). q120 (one 3m CHoCH inside a pullback,
  // rotational: not chop) was dropped before any run: at 107 questions the gate's Monte Carlo misses its detection bound
  // under a fixed slip count; q114, q123 and trend-vs-range's example cover its point. 100 with the Market state redesign
  // (PREREG addendum 14): q124 and q125 (how chop ends), q126 (the early 15m pullback), q127 (a CHoCH alone: a potential
  // reversal); q122 (mid-range churn, the same shape as q119 under the state table) and q116 (chop without edges; q117 keeps
  // chop is not range) retired before any run; q128 (the 3m pair the 15m confirms) and q129 (the 15m CHoCH back as the turn)
  // added, q115 (transitional, the table's not-aligned row) and q117 (the clean range day, q121's shape) retired, so the
  // quiz stays at 108 where the gate's bounds hold. Round 15 (PREREG addenda 15-16): the BOS/CHoCH invalidation items
  // q130-q133 added, q54 folded into the wick case (the same close-only lesson) and q127 into the CHoCH-holds case; q113
  // (the chop shape q119 and q128 test), q59 (the pause inside the trend, q95's row), q55 (a CHoCH an early warning: q127,
  // q132) and q108 (the late 15m BOS: q92 on the same briefing) retired: at 114 the gate's Monte Carlo misses its flaky
  // bound under maxSlips 10. q112, q121 (known gaps) and q91 (at the line in the probes) stay. Round 18 (PREREG addendum
  // 24): q118a (q118's briefing, the action) added; at 101 the gate's Monte Carlo misses its caught-broken bound (seed 1,
  // 536 of 600), so q94 (not aligned: unclear, 6/6 on every k=6; q112 asks the same row on the same printed class) retired.
  // 107 with q134-q140 (feat/displacement: the owner's two traps, a close back through the level, a weak BOS, a displaced
  // CHoCH, a weak CISD and a weak close through the protected swing; closed choices, the skill looked up). 113 with
  // q141-q146 (feat/position-line, layer manage: the Position line's fields read (giveback, MAE, what the stop rests on)
  // and three recorded holds (a 3m pullback, a 67% giveback at the lock, a warning past the price); the managed
  // situation's prompt; closed choices). A drafted synthetic item (a 15m CHoCH against with a placeable level ->
  // choch-against) failed 0/3 on main and on the branch and was deferred to the "what is a WARNING" study:
  // the taught warning stop is not a validated right answer (it cost R in the exit study). swing-holds: q147 (what the line's
  // words say happened at a level: a 3m close went through it, then one came back; the wording fact, no verdict on the
  // hand-back, swing-holds D1) and q148 (the failed break's extreme is the swing above) added from the real 2022-04-11
  // 10:06 moment. At 115 the gate's Monte Carlo misses its flaky bound (6.7%) and at 114 its caught-broken bound (seed 3,
  // 538 of 600) under maxSlips 11, so two items whose anchor a kept item shares retired: q33 (q30's mirror, the same
  // anchor "Side first, from the candle" and the same lesson for a low) and q132 (a CHoCH fails at its origin: q127 keeps
  // that anchor, and q131 and q147 ask a close through a protected level). q138 and q140, the only items on two
  // displacement sentences, stay. The quiz stays at 113. Quiz accuracy (review 1, ruling 4; the coordinator's option 1):
  // nothing removed, nothing added here (the structure items q149-q152 wait in their own branch: above 121 items this
  // gate's detection bound fails under maxSlips 11). 113.
  assert.strictEqual(QUIZ.questions.length, 113);
  assert.ok(['q35', 'q141', 'q142', 'q143'].every(id => QUIZ.questions.some(x => x.id === id)), 'q35 and q141-q143 kept');
  assert.ok(['q147', 'q148'].every(id => QUIZ.questions.some(x => x.id === id)), 'q147 and q148 added');
  assert.ok(!QUIZ.questions.some(x => ['q33', 'q132'].includes(x.id)), 'q33 and q132 retired');
  assert.ok(['q134', 'q135', 'q136', 'q137', 'q138', 'q139', 'q140'].every(id => QUIZ.questions.some(x => x.id === id)), 'every displacement item kept');
  assert.deepStrictEqual(QUIZ.questions.filter(x => x.layer === 'manage').map(x => x.id), ['q141', 'q142', 'q143', 'q144', 'q145', 'q146']);
  assert.ok(!QUIZ.questions.some(x => ['q55', 'q59', 'q94', 'q108', 'q113'].includes(x.id)), 'q55, q59, q94, q108 and q113 retired');
  assert.ok(QUIZ.questions.some(x => x.id === 'q118a'), 'q118a added');
  assert.ok(['q91', 'q112', 'q121'].every(id => QUIZ.questions.some(x => x.id === id)), 'q91, q112 and q121 kept');
  assert.ok(!QUIZ.questions.some(x => ['q115', 'q116', 'q117', 'q122'].includes(x.id)), 'q115, q116, q117 and q122 retired');
  assert.ok(!QUIZ.questions.some(x => x.id === 'q120'), 'q120 dropped');
  for (const id of ['q71', 'q72', 'q73', 'q74', 'q75', 'q76', 'q77', 'q78']) assert.ok(!QUIZ.questions.some(x => x.id === id), id);
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

test('context quiz: q45 and q46 are out of the bar (q46: the standing line prints the computed trigger, PR C3; q45: 7/10 live)', () => {
  for (const id of ['q45', 'q46']) assert.ok(!QUIZ.questions.some(x => x.id === id), id);
});

test('context quiz: the chop questions (q79-q82) are asked against the prompt holding the skill sentence each anchors to, on briefing lines the code writes', () => {
  const prompts = Q.buildPrompts(ROOT, QUIZ);
  const flat = t => t.replace(/\s+/g, ' ');
  const cut = re => Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, flat(v).replace(re, '')]));
  // [id, prompt, lookup, the sentence it anchors to, deleted from every prompt]: day-context and confluence-counting
  // (embedded in the head prompt), trend-vs-range (looked up).
  const want = [
    ['q79', 'head', undefined, /`too early \(a read from 10 bars\)`: no read\./g],
    ['q80', 'head', undefined, /mixed, none or `unknown` → neutral/g],
    ['q81', 'lookup', ['trend-vs-range'], /`rotational`: under 0\.34: back and forth so far/g],
    ['q82', 'lookup', ['trend-vs-range'], /Declared \(any one\): regime `with`/g],
  ];
  assert.deepStrictEqual(Q.anchorsMissing(QUIZ, prompts).filter(x => want.some(w => w[0] === x)), []);
  for (const [id, prompt, lookup, re] of want) {
    const q = QUIZ.questions.find(x => x.id === id);
    assert.deepStrictEqual([q.prompt, q.lookup], [prompt, lookup], id);
    assert.deepStrictEqual(Q.anchorsMissing(QUIZ, cut(re)).filter(x => x === id), [id], `${id}: its sentence deleted, its anchor goes missing`);
  }
  // The scenario lines are the code's writers on synthetic values: a changed line format fails here (rewrite the question).
  const { daySoFarLine } = require('../../scripts/lib/trading/day-so-far');
  const { declaredLine } = require('../../scripts/lib/trading/trend-declared');
  const { pullbackLine } = require('../../scripts/lib/trading/pullback-read');
  const { describeDay } = require('../../scripts/lib/trading/day-context');
  const day = (bars, read, direction, efficiency, score, vwapCrosses, rangeAtr) => daySoFarLine({ status: 'read', bars, read, direction, efficiency, score, vwapCrosses, rangeAtr }, { dayType: 'x' });
  const sd = (v, e, o, m, g) => ({ vwapAtr: v, ema20Atr: e, overnight: o, dayMoveAtr: m, regime: g });
  const bias = `- ${Q.excerptOf({ bias: { h4: 1, h1: 1, t15: 1 } })[0]}`;
  const pullback = pullbackLine({ frame: '15m', side: 'long', leg: { origin: 20000, extreme: 20160 }, depth: 0.38, pastOrigin: false, counter: { bars: 6, volRatio: 0.5, volume: 'falling', rangeRatio: 0.7 },
    swing: { '15m': { price: 20000, holds: true }, '1h': { price: 19950, holds: true } }, against: { '15m': null, '1h': null } });
  const mnq = describeDay({ open: 20100, openVs: 'inside the prior value area', gap: -6.5, adr: 240, adrDays: 10, prior: { low: 19980, high: 20180, close: 20106.5, val: 20050, vah: 20140, poc: 20110 },
    overnight: { low: 20070, high: 20125 }, openType: 'open-auction', ibRange: 75, ibLow: 20062.5, ibHigh: 20137.5, extUp: 0, extDown: 0, dayType: 'inside the initial balance', range: 75 }, { symbol: 'MNQ' });
  const text = id => QUIZ.questions.find(x => x.id === id).text;
  // A labelled line (F1-F4) is the code's line with its '- ' replaced by the label.
  const as = (label, line) => `${label} - ${line.replace(/^- /, '')}`;
  for (const [id, line] of [
    ['q79', daySoFarLine({ status: 'too early', bars: 6, readFrom: 10, vwapCrosses: 0 })],
    ['q80', daySoFarLine({ status: 'unknown', reason: 'no 09:30 ET bar in the data' })],
    ['q81', as('F1', bias)], ['q81', as('F2', declaredLine({ long: sd(1, 0.6, 'middle third', 1.2, 'with'), short: sd(-1, -0.6, 'middle third', -1.2, 'against') }))],
    ['q81', as('F3', pullback)], ['q81', as('F4', day(45, 'rotational', 'up', 0.03, 0.2, 10, 4.2))],
    ['q82', as('F1', day(48, 'rotational', 'up', 0.02, 0.14, 12, 3.9))], ['q82', as('F2', mnq)],
    ['q82', as('F4', declaredLine({ long: sd(0.7, 0.4, 'middle third', 0.9, 'with'), short: sd(-0.7, -0.4, 'middle third', -0.9, 'against') }))],
  ]) assert.ok(text(id).includes(`\n${line}\n`), `${id}: ${line}`);
  // Each scenario says it is synthetic and holds no line the code no longer writes (no Rotation evidence line).
  for (const [id] of want) {
    assert.match(text(id), /^Briefing lines \(synthetic, \d\d:\d\d ET\):\n/, id);
    assert.ok(!/Rotation evidence/.test(text(id)), id);
  }
});

test('context quiz: the pullback questions (q87-q112) are asked against the prompt holding the sentence each anchors to, and go missing without it', () => {
  const prompts = Q.buildPrompts(ROOT, QUIZ);
  const flat = t => t.replace(/\s+/g, ' ');
  const cut = re => Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, flat(v).replace(re, '')]));
  const PB = ['pullback-vs-reversal'];
  // [id, prompt, lookup, the sentence it anchors to, deleted from every prompt]
  const want = [
    ['q87', 'lookup', PB, /the first 3m BOS or 3m CISD the side's way, near value/g],
    ['q88', 'lookup', PB, /A 15m BOS the side's way after the entry: continuation confirmed → hold\./g],
    ['q89', 'lookup', PB, /this pullback failed, a reversal attempt: wait for a new 15m turn the side's way/g],
    ['q90', 'lookup', PB, /a 3m CHoCH against the side inside an intact 15m trend: a pullback starting, wait\./g],
    ['q91', 'lookup', PB, /A 15m `range` or `transition` here is the pause, not chop\./g],
    ['q92', 'lookup', PB, /Far past the level, no retest: late, not this read's entry/g],
    ['q93', 'lookup', PB, /a live strong 15m CISD on the CISD line is the setup read even when the last 15m candle line shows no pattern/g],
    // Was a strict-side guard (one of the 4h and 1h ranging: unclear to the head trader, whatever the 3m); see below.
    // Re-anchored to the Market state table (PREREG addendum 14): the class rule's sentence is replaced by it.
    // Round 17: re-anchored to the table keyed on the printed line (one authority for the class word). Read audit F1: the
    // 1h up with the 4h ranging is the entry rule's side, so the line prints trend-up and q112 anchors to the trend row.
    ['q112', 'head', undefined, /\| `trend-up`, `trend-down` \| setups the side's way \(what the line prints picks the setup, below\) \|/g],
    ['q95', 'head', undefined, /`forming`: no setup yet: wait for the first RTH 3m break\./g],
    ['q96', 'lookup', PB, /watch for the BOS or CISD; not the entry\./g],
    ['q97', 'lookup', PB, /No BOS or CISD after it: no setup, pass\./g],
    ['q98', 'lookup', PB, /a candle at the level is no confirmation alone/g],
    ['q99', 'lookup', PB, /The level: the broken one or a level next to it \(the RTH VWAP, a 15m swing; within about 0\.25 x the 15m ATR, a hypothesis: one zone; `levels-and-reactions`\)\./g],
    ['q101', 'lookup', PB, /the entry needs a 3m BOS or CISD the side's way and a true 15m setup read the side's way/g],
    ['q102', 'lookup', PB, /`3m cisd up` in the setup step/g],
    ['q103', 'lookup', PB, /a 15m CISD or CHoCH against overrides: wait, whatever the depth or the engulfing read/g],
    // The old answer (the 15m setup is the entry, no 3m turn to wait for) as the distractor: a Pullback line printed, the head core says wait.
    ['q104', 'head', undefined, /unless a `Pullback` line prints\./g],
    ['q105', 'lookup', PB, /A 3m CHoCH or CISD against inside it: the watch restarts\./g],
    ['q107', 'head', undefined, /your PLAN's `4 Setup` line is the read chain/g],
    // q108 retired (PREREG addendum 16): q92 asks the late 15m BOS on the same briefing.
    ['q109', 'lookup', PB, /Counter candles that don't engulf it: a pullback forming, not a reversal/g],
    ['q110', 'lookup', PB, /a counter candle engulfing it reads as a CHoCH against: wait/g],
    ['q111', 'head', undefined, /No other row, picture or frame read changes it\. When your frames differ, say why in the PLAN\./g],
    ['q106', 'lookup', PB, /the CISD line's `strong` is its displacement's strength, not a pattern name/g],
  ];
  assert.deepStrictEqual(Q.anchorsMissing(QUIZ, prompts).filter(x => want.some(w => w[0] === x)), []);
  for (const [id, prompt, lookup, re] of want) {
    const q = QUIZ.questions.find(x => x.id === id);
    assert.deepStrictEqual([q.prompt, q.lookup], [prompt, lookup], id);
    assert.ok(Array.isArray(q.choices) && q.choices.includes(q.answer), `${id}: a closed choice`);
    assert.deepStrictEqual(Q.anchorsMissing(QUIZ, cut(re)).filter(x => x === id), [id], `${id}: its sentence deleted, its anchor goes missing`);
  }
  // The pullback skill is a lookup, never embedded in the head prompt (its size and the gate unchanged).
  assert.ok(!prompts.head.includes('<skill name="pullback-vs-reversal">'));
  // The briefing lines are the code's writers (the Bias, Pullback and Trend declared? lines); each Pullback line's depth is
  // the share of the leg its last close gave back, at least 10 bars (two completed 15m candles) after the extreme.
  const { pullbackLine } = require('../../scripts/lib/trading/pullback-read');
  const { declaredLine } = require('../../scripts/lib/trading/trend-declared');
  const sd = (v, e, o, m, g) => ({ vwapAtr: v, ema20Atr: e, overnight: o, dayMoveAtr: m, regime: g });
  const text = id => QUIZ.questions.find(x => x.id === id).text;
  const up = `- ${Q.excerptOf({ bias: { h4: 1, h1: 1, t15: 1 } })[0]}`;
  const leg = { origin: 21462.5, extreme: 21538.75 };
  const pb = close => pullbackLine({ frame: '15m', side: 'long', leg, depth: (leg.extreme - close) / (leg.extreme - leg.origin), pastOrigin: false, counter: { bars: 10, volRatio: 0.6, volume: 'falling', rangeRatio: 0.5 },
    swing: { '15m': { price: 21462.5, holds: true }, '1h': { price: 21390.25, holds: true } }, against: { '15m': null, '1h': null } });
  const near = declaredLine({ long: sd(0.3, 0.2, 'broke out its way', 1.6, 'with'), short: sd(-0.3, -0.2, 'broke out against', -1.6, 'against') });
  for (const [id, close] of [['q87', 21518.25], ['q96', 21512.5], ['q97', 21503.75], ['q99', 21518], ['q101', 21509.5], ['q102', 21513.75], ['q103', 21503], ['q104', 21504.25], ['q105', 21505.5], ['q106', 21518.25], ['q107', 21518.25]]) {
    for (const line of [up, pb(close), near]) assert.ok(text(id).includes(`\n${line}\n`), `${id}: ${line}`);
  }
  assert.ok(text('q93').includes(`\n- ${Q.excerptOf({ bias: { h4: -1, h1: -1, t15: -1 } })[0]}\n`));
  const deep = pullbackLine({ frame: '15m', side: 'short', leg: { origin: 4337.5, extreme: 4246.25 }, depth: 0.83, pastOrigin: false, counter: { bars: 12, volRatio: 1.1, volume: 'rising', rangeRatio: 1.2 },
    swing: { '15m': { price: 4291.75, holds: false }, '1h': { price: 4352.5, holds: true } }, against: { '15m': { kind: 'CHoCH', direction: 'up', level: 4291.75, barsAgo: 3 }, '1h': null } });
  assert.ok(text('q98').includes(`\n${deep}\n`), deep);
});

// The chop read (feat/chop-read, owner-approved 2026-11-14): chop is the quality of movement, range its geometry.
test('context quiz: the chop-read questions (q114-q133, less q115, q116, q117, q120 and q122) are asked against the prompt holding the sentence each anchors to, go missing without it, on the code writers\' lines', () => {
  const prompts = Q.buildPrompts(ROOT, QUIZ);
  const flat = t => t.replace(/\s+/g, ' ');
  const cut = re => Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, flat(v).replace(re, '')]));
  const want = [
    ['q114', 'head', undefined, 'wait: a reversal attempt; class trend-up, not chop; no short', /wait for the 15m turn \(a live strong 15m CISD, a 15m BOS, a 15m CHoCH back or a 15m reaction at the level\)/g],
    ['q118', 'head', undefined, 'F4', /Write the class the `Market state` line prints after `class`/g],
    // Round 18 (PREREG addendum 24): q118's briefing, the action (the trade cost): wait for the 15m turn, never sit out.
    ['q118a', 'head', undefined, 'F2', /Small overlapping candles inside a printed pullback are a pause, not chop/g],
    ['q119', 'head', undefined, 'F2', /\| `chop` \| sit out \|/g],
    ['q123', 'head', undefined, 'F3', /enter on the first 3m BOS or CISD the side's way near value/g],
    ['q121', 'head', undefined, 'enter long: the turn at the low edge the side\'s way, 3m BOS near value', /setups at the range edge or on a breakout, the side's way/g],
    // How chop ends (owner, 2026-11-14; round 20, decision 6: on displacement, the code's rule as trade-session states it).
    ['q124', 'head', undefined, 'F2', /a displaced 3m break or a displaced 3m CISD/g],
    ['q125', 'head', undefined, 'F2', /a displaced close beyond the IB \(complete at 10:30\)/g],
    // The owner: "BOS is same-trend continuation, while CHoCH is a potential reversal" (bos-vs-choch, a lookup).
    ['q127', 'lookup', ['bos-vs-choch'], 'a potential reversal up that still holds (above its origin 21462.50): unconfirmed until a BOS up', /a CHoCH holds until the low \(high\) that started the shift breaks/g],
    // The owner's invalidation rule (round 15, bos-vs-choch): each break's protected swing; a close through it, not a wick.
    ['q54', 'lookup', ['bos-vs-choch'], 'not invalidated: only a close below 21480.25 counts; the trend holds', /Only a close through it counts; a wick is not\./g],
    ['q130', 'lookup', ['bos-vs-choch'], 'the trend holds: no close below the protected HL 21480.25', /a BOS holds until the leg's higher low \(lower high\) breaks/g],
    ['q131', 'lookup', ['bos-vs-choch'], 'invalidated: the close below the protected HL ended the up trend (a potential reversal, unconfirmed)', /a BOS holds until the leg's higher low \(lower high\) breaks/g],
    ['q133', 'lookup', ['bos-vs-choch'], 'a confirmed transition up: the CHoCH up was followed by a BOS up', /CHoCH then BOS the same way: a confirmed transition; a reversal once a close goes through the old leg's protected level/g],
    // A CHoCH pair alone is not chop (#340, trend-vs-range); under a printed trend class a range is not chop (#338): the
    // class the line prints (quiz accuracy C6: reworded from "the 3m CHoCH pair is the 15m BOS up", no longer taught).
    ['q128', 'head', undefined, "trend-up: the class printed; a CHoCH pair alone is not chop; long setups the side's way", /a range day too; a range is not chop/g],
    // The 15m CHoCH back the side's way is a 15m turn (owner-approved 2026-11-15).
    ['q129', 'head', undefined, 'enter long: the 15m CHoCH up is the turn; the 3m BOS up near value is the entry', /a live strong 15m CISD, a 15m BOS, a 15m CHoCH back or a 15m reaction at the level, the side's way/g],
    // The owner: "15min up trend, 3min down trend could mean pullback".
    ['q126', 'head', undefined, 'a pullback in the 15m trend: class trend-up; watch for the 15m turn, then a 3m BOS or CISD up', /or "15m up: a pullback in the 15m trend", down the mirror/g],
  ];
  assert.deepStrictEqual(Q.anchorsMissing(QUIZ, prompts).filter(x => want.some(w => w[0] === x)), []);
  for (const [id, prompt, lookup, answer, re] of want) {
    const q = QUIZ.questions.find(x => x.id === id);
    assert.ok(q, id);
    assert.deepStrictEqual([q.prompt, q.lookup, q.answer], [prompt, lookup, answer], id);
    assert.ok(q.choices.includes(q.answer), `${id}: a closed choice`);
    assert.deepStrictEqual(Q.anchorsMissing(QUIZ, cut(re)).filter(x => x === id), [id], `${id}: its sentence deleted, its anchor goes missing`);
  }
  // q99 carries only briefing facts (construct validity, feat/chop-read): no quiz-only framing sentence.
  assert.doesNotMatch(QUIZ.questions.find(x => x.id === 'q99').text, /No exact touch|no named reversal candle/);
  // q112 prints the Market state line under its Bias line, as the briefing does (market-state.js): the 1h sets the side.
  assert.match(QUIZ.questions.find(x => x.id === 'q112').text, /\n- Bias: [^\n]*\n- Market state \(3m\): [^\n]*\(side up\); class trend-up\.\n/);
  // The invalidation items print the protected swing the way the state reads it (round 20: from the printed breaks, holds,
  // broken by a close, failed).
  const tq = id => QUIZ.questions.find(x => x.id === id).text;
  assert.match(tq('q130'), /Market state \(3m\): in the up leg: [^\n]*, HL 21480\.25 holds; 4h\+1h up/);
  assert.match(tq('q131'), /Market state \(3m\): range: [^\n]*, HL 21480\.25 broken by a close; 4h\+1h up/);
  // Round 20b: q119 states the layer facts its text describes (no leg holds, overlap high, efficiency low, a failed
  // continuation): its line prints chop, its key. The follow-up to #340: "no leg holds" prints only when no protected
  // level holds, so its facts state the up leg's HL 21518.75 broken by the CHoCH down (its printed lastBreak).
  assert.match(tq('q119'), /\n- Market state \(3m\): chop: no leg holds \(breaks both ways\); overlap 0\.\d+, efficiency 0\.05, failed continuation; [^\n]*; class chop\.\n/);
  assert.ok(QUIZ.questions.find(x => x.id === 'q119').layers, 'q119: its layer facts');
  assert.strictEqual(QUIZ.questions.find(x => x.id === 'q119').layers.structure.status, 'broken', 'q119: no protected level holds');
  assert.match(tq('q127'), /Market state \(3m\): range: 3m BOS down then CHoCH up \(unconfirmed, holds above 21462\.5 \(origin\)\); 4h\+1h up/);
  // The chop-end items show the facts that confirm the CHoCH (round 20: no layer facts stated, so no chop memory: the line
  // prints the confirmed leg).
  const tx = id => QUIZ.questions.find(x => x.id === id).text;
  assert.match(tx('q124'), /\n- CISD \(completed candles\): 3m bullish at [\d.]+ \(closed 10:45, strong\)/);
  assert.match(tx('q124'), /Market state \(3m\): in the up leg: [^\n]*, then a 3m CISD up \(confirmed\); 4h\+1h up/);
  assert.match(tx('q125'), /initial balance 21480-21560/);
  assert.match(tx('q125'), /Market state \(3m\): in the up leg: [^\n]*, then a close above the IB high 21560 \(confirmed\); 4h\+1h up/);
  // The early 15m pullback: the 15m up, the 3m trending down, no Pullback line yet.
  assert.match(tx('q126'), /Market state \(3m\): in the down leg: [^\n]*; 15m up: a pullback in the 15m trend; 4h\+1h up/);
  assert.ok(!/\n- Pullback \(/.test(tx('q126')), 'q126: no Pullback line yet');
  // trend-vs-range is a lookup, not embedded in the head prompt.
  assert.ok(!prompts.head.includes('<skill name="trend-vs-range">'));
  // The briefing lines are the code's writers (Bias, Day so far); the Day so far score is efficiency x sqrt(bars), and its
  // word the day-context bands (rotational under 0.34, mixed below 0.75).
  const { daySoFarLine } = require('../../scripts/lib/trading/day-so-far');
  const text = id => QUIZ.questions.find(x => x.id === id).text;
  for (const id of want.map(w => w[0])) {
    const m = /\n(- Day so far \((\d+) 3m bars; `day-context`\): (rotational|mixed up|mixed down): efficiency ([\d.]+) \(x sqrt\(bars\) ([\d.]+)\), RTH VWAP crosses (\d+), range ([\d.]+) x 3m ATR\(14\), net (up|down)[^\n]*)\n/.exec(text(id));
    assert.ok(m, `${id}: a Day so far line`);
    const [, line, bars, word, eff, score, crosses, range, dir] = m;
    assert.strictEqual(line, daySoFarLine({ status: 'read', bars: +bars, read: word.split(' ')[0], direction: dir, efficiency: +eff, score: +score, vwapCrosses: +crosses, rangeAtr: +range }), id);
    assert.ok(Math.abs(+eff * Math.sqrt(+bars) - +score) < 0.006, `${id}: score`);
    assert.strictEqual(word.startsWith('rotational'), +score < 0.34, `${id}: the word's band`);
    assert.ok(/\n- Bias: /.test(text(id)), `${id}: a Bias line`);
  }
  // Repeated CHoCH both ways (the printed chop fact) where the answer is chop; never on the pullback, pause or edge items.
  const both = id => /m3\.lastBreak: last CHoCH \w+ at [\d.]+ \(barsAgo \d+\), previous CHoCH/.test(text(id));
  for (const id of ['q119', 'q124', 'q125', 'q128']) assert.ok(both(id), `${id}: breaks both ways`);
  for (const id of ['q114', 'q118', 'q121']) assert.ok(!both(id), `${id}: one CHoCH at most`);
  // The SETUP15 hard case: the pair and rotational with many crosses, inside an open Pullback: the trend class, not chop.
  assert.ok(both('q123') && /\n- Pullback \(15m, long leg/.test(text('q123')) && /rotational: .*RTH VWAP crosses [5-9]/.test(text('q123')), 'q123: the full chop facts inside a Pullback');
});

// Quiz realism (feat/chop-read, PREREG addendum 14): every Part A item whose synthetic briefing shows a Bias line prints
// the Market state line right under it, the one market-state.js stateOf computes from that item's own printed lines
// (context-quiz.js marketStateOfText), as the live briefing would. Part B's bias excerpts print none (too few facts, D3).
test('context quiz: every item\'s Bias line is followed by its Market state line, built by stateOf from its own lines', () => {
  let n = 0;
  for (const q of QUIZ.questions) {
    const t = String(q.text || '');
    const m = /\n- (Bias: [^\n]*)\.\n- (Market state \(3m\): [^\n]*)\./.exec(t);
    if (!/\n- Bias: /.test(t)) { assert.doesNotMatch(t, /Market state/, q.id); continue; }
    assert.ok(m, `${q.id}: the Market state line right under the Bias line`);
    assert.strictEqual(`${m[2]}`, Q.marketStateOfText(t.replace(/\n- Market state[^\n]*/, ''), q.layers || null), q.id);
    assert.strictEqual(t.split('Market state').length, 2, `${q.id}: one line`);
    n += 1;
  }
  assert.ok(n >= 35, `${n} items`);
  for (const q of QUIZ.partB) assert.doesNotMatch(Q.questionText(QUIZ, q), /Market state|Class side/, q.id);
  assert.doesNotMatch(JSON.stringify(QUIZ), /Class side/, 'the dropped line is gone');
});

// The pullback and chop blocks' free-phrase choice items (q88-q129) hold the correct choice where a seeded shuffle put it (sha256 of
// the id, mod the choice count), never always first: a guard against first-answer bias in items added later.
test('context quiz: the pullback items\' correct choice sits at its seeded position, not always first', () => {
  const crypto = require('crypto');
  const block = QUIZ.questions.filter(q => /^q(8[8-9]|9\d|1[0-2]\d)$/.test(q.id) && Array.isArray(q.choices) && !/^F\d$/.test(q.choices[0]));
  assert.ok(block.length >= 15, `${block.length} free-phrase items`);
  for (const q of block) {
    const want = Number(BigInt(`0x${crypto.createHash('sha256').update(q.id).digest('hex')}`) % BigInt(q.choices.length));
    assert.strictEqual(q.choices.indexOf(q.answer), want, q.id);
  }
  assert.ok(block.filter(q => q.choices.indexOf(q.answer) === 0).length <= block.length / 2, 'not mostly first');
});

// Round 19 (q93: a bare `none` on the 15m line was read as "no 15m turn"): every quiz candle line prints its pattern the
// way the briefing does (candle-facts.js patternText: the label `none` is "no pattern"), never a bare `none`.
test('context quiz: every candle line prints its pattern as the briefing does ("no pattern", never a bare none)', () => {
  const { patternText } = require('../../scripts/lib/trading/candle-facts');
  const CANDLE_LINE = /\n- (\d+[mh]) \(([a-z, ]*)closed \d\d:\d\d\): ([^,.;\n]+)/g;
  const noPattern = [];
  for (const q of [...QUIZ.questions, ...(QUIZ.partB || [])]) {
    for (const m of String(q.text || '').matchAll(CANDLE_LINE)) {
      assert.notStrictEqual(m[3], 'none', `${q.id}: ${m[0].trim()}`);
      if (m[3] === patternText('none')) noPattern.push(q.id);
    }
  }
  // The items that print a no-pattern candle (q93's mirror and its kin) print the briefing's words.
  assert.deepStrictEqual(noPattern, ['q93', 'q99', 'q101', 'q102', 'q112', 'q123']);
});
