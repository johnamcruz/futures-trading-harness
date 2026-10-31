'use strict';

// The context quiz's pure logic (scripts/lib/eval/context-quiz.js): the quiz file's check, the answer grading with
// negation-aware forbidden terms, the summary against the pass bar, the comparison, and the headless argv from the
// user's runner config (no model named in the repo). The model calls are the CLI's, never a test's.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Q = require('../../scripts/lib/eval/context-quiz');
const { tmpDir } = require('../helpers');

const QUIZ = Q.loadQuiz().value;
const q = id => [...QUIZ.questions, ...QUIZ.partB].find(x => x.id === id);
const pass = (id, answer) => Q.gradeAnswer(QUIZ, q(id), answer).pass;

test('the quiz file loads and checks: a broken question is refused, every problem named', () => {
  assert.deepStrictEqual(Q.quizErrors(QUIZ), []);
  const bad = { ...QUIZ, k: 0, questions: [{ ...QUIZ.questions[0], layer: 'vibes', anchor: '', required: ['('] }, QUIZ.questions[0]] };
  const errs = Q.quizErrors(bad).join('\n');
  for (const want of [/^k: /m, /layer: one of/, /anchor: the phrase/, /required\[0\]: not a regex/, /\[1\]\.id: unique/]) assert.match(errs, want);
});

test('grading: the ANSWER line, the required terms, and a forbidden term only when not negated', () => {
  assert.deepStrictEqual(Q.answerLine('blah\n**ANSWER:** No, never counter.\nwhy'), { line: 'No, never counter.', fmt: true });
  assert.deepStrictEqual(Q.answerLine('No side.\nmore'), { line: 'No side.', fmt: false });
  // Q9: the 3m named only to refuse it is no forbidden mention ("not from the 3m", "never the 3m").
  assert.ok(pass('q9', 'ANSWER: The 1h and up, the session and day, the VWAP and the 15m swings, not from the 3m.'));
  assert.ok(pass('q9', 'ANSWER: 1h+, session levels, VWAP, 15m swings; never the 3m.'));
  assert.ok(!pass('q9', 'ANSWER: 1h, session, VWAP and the 3m swings.'));
  // Q17/Q18: "never half" is full; "half" alone is not.
  assert.ok(pass('q18', 'ANSWER: Full verdict size, never half: nothing halves in an attempt.'));
  assert.ok(!pass('q18', 'ANSWER: Half size, floor(size/2).'));
  // Q19 (the corrected key): a bare approval is restated, never a trade or a veto.
  assert.ok(pass('q19', 'ANSWER: Not yet: no readable size on the VERDICT line, so one restate of the Size and VERDICT lines.'));
  assert.ok(!pass('q19', 'ANSWER: Yes, it is a trade at 3 contracts.'));
  assert.strictEqual(Q.negated('it is not from the 3m', 'it is not from the '.length, QUIZ.negations, QUIZ.negationWindow), true);
  assert.strictEqual(Q.negated('take it; the 3m swing', 'take it; the '.length, QUIZ.negations, QUIZ.negationWindow), false);
  assert.strictEqual(Q.negated('not one two three four five the 3m', 'not one two three four five the '.length, QUIZ.negations, QUIZ.negationWindow), false, 'past the window');
  assert.ok(Q.gradeAnswer(QUIZ, q('q1'), 'ANSWER: it depends').unsure);
});

test('the reaction questions (q23-q29, feat/sweep-candle-control): answer-first keys pass the right answer, refuse the wrong ones', () => {
  const cases = {
    // A reaction alone takes no trade: it needs other confirmation.
    q23: [['No: a reaction is context, it needs other confirmation (bias, level, the count).', 'Pass: nothing else lines up.'],
      ['Yes, the long wick is enough.', 'Take it: sellers rejected the high.', 'Enter short on the rejection.']],
    // The close decides: a close above is acceptance.
    q24: [['Acceptance: the close decides, never the wick.', 'Accepted, not a rejection: it closed above the high.'],
      ['Rejection: the long wick.', 'A long-wick rejection.', 'Rejected, the wick failed above.', "It's a rejection of the high."]],
    // A long-wick rejection after a high: sellers.
    q25: [['Sellers: they rejected higher prices.', 'The sellers took control.'],
      ['Buyers, they pushed above the high.', 'Neither, but buyers took control of the wick.']],
    // A strong close beyond: a breakout attempt, not a sweep.
    q26: [['Breakout: closed beyond with a 0.8 body, not a sweep.', 'A breakout attempt, buyers in control.'],
      ['Sweep of the high.', "It's a sweep, the wick traded above.", 'A sweep.']],
    q27: [['Confirmed rejection: sellers took over and confirmed it.', 'A confirmed rejection on the second candle.'],
      ['Breakout down.', 'Stall: the next candle decides.', 'Conflicting.']],
    // Conflicting: mixed, wait.
    q28: [['No: mixed evidence, wait for confirmation.', 'Wait for the next candle.', 'Not yet: conflicting.'],
      ['Yes, it closed back below.', 'Sellers are in control.']],
    // A stall: the next candle decides.
    q29: [['The next candle decides.', 'Next 15m candle.'],
      ['The doji itself.', 'This candle decides.', 'Sellers.', 'Buyers decide.']],
  };
  for (const [id, [right, wrong]] of Object.entries(cases)) {
    for (const a of right) assert.ok(pass(id, `ANSWER: ${a}`), `${id} right: ${a}`);
    for (const a of wrong) assert.ok(!pass(id, `ANSWER: ${a}`), `${id} wrong: ${a}`);
  }
});

test('summary: correct on all K, answered both ways, the totals, the bar; compare names each change', () => {
  const rows = [];
  for (const x of QUIZ.questions) for (let k = 1; k <= 5; k += 1) rows.push({ id: x.id, k, pass: true });
  for (const x of QUIZ.partB) for (let k = 1; k <= 5; k += 1) rows.push({ id: x.id, k, pass: true });
  const all = Q.summarize(QUIZ, rows, 5);
  assert.deepStrictEqual([all.partA.allCorrect, all.partA.bothWays, all.partB.allCorrect, all.meetsBar], [29, 0, 5, true]);
  const one = rows.map(r => (r.id === 'q6' && r.k === 2 ? { ...r, pass: false } : r));
  const s = Q.summarize(QUIZ, one, 5);
  assert.deepStrictEqual([s.partA.allCorrect, s.partA.bothWays, s.partA.total, s.meetsBar], [28, 1, 144, false]);
  // Too few runs is never correct on all K.
  assert.strictEqual(Q.summarize(QUIZ, rows.filter(r => r.k <= 3), 5).partA.allCorrect, 0);
  const d = Q.compare(all, s).find(x => x.id === 'q6');
  assert.deepStrictEqual(d, { id: 'q6', from: '5/5', to: '4/5', delta: -0.2 });
});

test('the headless argv comes from the user\'s runner config: its model, its extra arguments, no tools, no settings', () => {
  const argv = Q.quizCommand({ harness: 'claude', model: 'm-from-config', extraArgs: ['--x'] }, 'Q?', '/p/head.md');
  assert.deepStrictEqual(argv.slice(0, 5), ['claude', '-p', 'Q?', '--append-system-prompt-file', '/p/head.md']);
  for (const a of ['--tools', '--setting-sources', '--no-session-persistence', '--strict-mcp-config']) assert.ok(argv.includes(a), a);
  assert.deepStrictEqual(argv.slice(-3), ['--model', 'm-from-config', '--x']);
  assert.ok(!Q.quizCommand({ harness: 'claude' }, 'Q?', '/f').includes('--model'), 'no model unless the config names one');
  assert.deepStrictEqual(Q.quizCommand({ harness: 'custom', command: ['ask', '--sys', '{system}', '{prompt}'] }, 'Q?', '/f'), ['ask', '--sys', '/f', 'Q?']);
  assert.throws(() => Q.quizCommand({ harness: 'codex' }, 'Q', '/f'), /takes no system-prompt file/);
  assert.deepStrictEqual(Q.replyOf({ harness: 'claude' }, JSON.stringify({ result: 'ANSWER: no', is_error: false })), { answer: 'ANSWER: no', error: false });
  assert.strictEqual(Q.replyOf({ harness: 'claude' }, 'not json').error, true);
  assert.deepStrictEqual(Q.replyOf({ harness: 'custom' }, ' ANSWER: no \n'), { answer: 'ANSWER: no', error: false });
});

test('Part B\'s excerpts are the lines the code writes (bias-line.js, prop/size-line.js), asked with the question', () => {
  assert.deepStrictEqual(Q.excerptOf({ bias: { h4: -1, h1: -1, t15: 1 } }), ['Bias: short only (4h down, 1h down; long refused).']);
  assert.deepStrictEqual(Q.excerptOf({ bias: { h4: 0, h1: 0, t15: 1, declared: true } }), ['Bias: neutral → 15m up + declared long → long only.']);
  const size = q('b4').excerpt.size;
  assert.match(Q.excerptOf({ size })[0], /^Size \(prop attempt\): the full verdict size; a serious factor against never cuts it\./);
  assert.match(Q.excerptOf({ size: { ...size, facts: { ...size.facts, balance: 99000, lossesToday: 1, lossStreak: 1 } } })[0], /^Size \(prop attempt\): phase 2 may cut \(pacing: after-loss, streak, drawdown\)/);
  assert.throws(() => Q.excerptOf({}), /excerpt/);
  const t = Q.questionText(QUIZ, q('b1'));
  assert.match(t, /^Briefing excerpt:\nBias: short only[^\n]*\n\nA 15m bullish CHoCH/);
  assert.ok(t.endsWith(QUIZ.answerFormat));
});

test('the CLI builds and grades into a directory of the user\'s, never the repository, and calls no model to grade', () => {
  const cli = path.join(__dirname, '..', '..', 'scripts', 'context-quiz.js');
  const dir = tmpDir();
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.strictEqual(run(['build', '--out', dir]).status, 0);
  for (const f of ['head.md', 'head+risk.md', 'questions.json']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  fs.writeFileSync(path.join(dir, 'answers.jsonl'), `${JSON.stringify({ id: 'q6', k: 1, answer: 'ANSWER: No: only where the stop goes.' })}\n`);
  const g = run(['grade', dir]);
  assert.strictEqual(g.status, 0, g.stderr);
  assert.match(g.stdout, /^q6\tlevels\t1\/1$/m);
  assert.match(run(['build', '--out', path.join(__dirname, 'x')]).stderr, /inside the repository/);
});
