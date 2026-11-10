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

test('one question checks alone as the quiz file checks it (questionErrors: a probe edit\'s question reuses it)', () => {
  const ok = QUIZ.questions[0];
  assert.deepStrictEqual(Q.questionErrors(ok, { part: 'questions', at: 'question' }), []);
  // The same messages as the file's check, under the given name.
  const errs = Q.questionErrors({ ...ok, layer: 'vibes', anchor: '', required: ['('], id: '' }, { part: 'questions', at: 'question' }).join('\n');
  for (const want of [/^question\.id: unique, given$/m, /^question\.layer: one of/m, /^question\.anchor: the phrase/m, /^question\.required\[0\]: not a regex/m]) assert.match(errs, want);
  assert.match(Q.questionErrors({ ...ok, id: 'q1' }, { part: 'questions', at: 'question', ids: new Set(['q1']) }).join(), /question\.id: unique/);
  assert.match(Q.questionErrors(null, { part: 'questions', at: 'question' }).join(), /question: an object/);
  assert.match(Q.questionErrors({ ...ok, prompt: 'lookup' }, { part: 'questions', at: 'question' }).join(), /question\.lookup/);
  assert.deepStrictEqual(Q.questionErrors({ ...ok, required: [] }, { part: 'questions', at: 'question' }), ['question.required: at least one']);
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
  // "No readable size" said another way: without a readable size, not a readable approval or approved size.
  for (const a of ['No. Without a readable size on the VERDICT line, it\'s not a trade yet, and it isn\'t a veto either.', 'No. "VERDICT: approve" is not a readable approval, so this is not a trade yet.',
    'No. Under the harness rules that line is not a readable approved size, so it is not a trade yet.']) assert.ok(pass('q19', `ANSWER: ${a}`), a);
  // A negation in the "no readable size" substance never excuses a veto, a trade or an entry said elsewhere on the line.
  for (const a of ['Yes: without a readable size the Size line gives 3.', 'Not a readable approval, but it is a trade at 3.', 'It is a trade: the Size line is a readable size.', 'No, it is a readable size: go with 3.',
    'Veto: not a readable approval.', 'No readable size, so it is vetoed.',
    // A negation that governs something else in the clause never excuses the veto: only "never/not/no/only (a) veto",
    // "never treats it as a veto" and "a veto is never / would be wrong / never ..." do.
    'Veto it — not a readable approval.', 'Veto it since it is not a readable approval.', 'A veto would be right: not a readable approval.', 'No. Not a readable approval so veto it.',
    'Not a readable approval and the harness vetoes it.', 'No; it is vetoed as not a readable approval.', 'No readable size so it is vetoed.', 'Trade it at 3. Not a readable approval but the Size line counts.',
    'It\'s a trade; without a readable size on the VERDICT line the prose Size line gives 3.']) assert.ok(!pass('q19', `ANSWER: ${a}`), a);
  // ...while a veto it rules out in its own clause stays right (the negation before or after it there).
  for (const a of ['No. That line is not a valid approval, so it is not a trade yet: one restate of the Size and VERDICT lines is owed, and a veto is never retried.', 'No: unreadable, one restate, never a veto.',
    'No. Unreadable, so the harness asks for one restate and never treats it as a veto.', 'No. Unreadable: the harness asks for one restate and does not treat it as a veto.',
    'No: unreadable, so one restate rather than a veto.', 'No: unreadable, so a restate instead of a veto.', 'No: unreadable; one restate, and a veto would be wrong here.',
    'No: unreadable, one restate; only a real veto ends it.', 'No: unreadable, one restate; a veto never applies here.', 'No: unreadable, one restate; a veto is never retried.']) assert.ok(pass('q19', `ANSWER: ${a}`), a);
  assert.strictEqual(Q.negated('it is not from the 3m', 'it is not from the '.length, QUIZ.negations, QUIZ.negationWindow), true);
  assert.strictEqual(Q.negated('take it; the 3m swing', 'take it; the '.length, QUIZ.negations, QUIZ.negationWindow), false);
  assert.strictEqual(Q.negated('not one two three four five the 3m', 'not one two three four five the '.length, QUIZ.negations, QUIZ.negationWindow), false, 'past the window');
  assert.ok(Q.gradeAnswer(QUIZ, q('q1'), 'ANSWER: it depends').unsure);
});

test('grading: a line-leading verdict ("No," "No -" "Not yet:" "Yes.") answers the question; it never negates its own explanation', () => {
  const W = QUIZ.negationWindow;
  const N = QUIZ.negations;
  // The verdict is stripped before the negation check: what follows it is the answer's own claim.
  assert.strictEqual(Q.negated('No, go short now.', 'No, go '.length, N, W), false);
  assert.strictEqual(Q.negated('Not yet - short it now.', 'Not yet - '.length, N, W), false);
  assert.strictEqual(Q.negated('No: enter short.', 'No: enter '.length, N, W), false);
  assert.strictEqual(Q.negated('Nope, short now.', 'Nope, '.length, N, W), false);
  // A negation after the verdict still negates; one with no punctuation after it is a negation, not a verdict.
  assert.strictEqual(Q.negated("No, don't short it now.", "No, don't ".length, N, W), true);
  assert.strictEqual(Q.negated('No - not the same thing.', 'No - not the '.length, N, W), true);
  assert.strictEqual(Q.negated('Not the same read.', 'Not the '.length, N, W), true);
  assert.ok(Q.VERDICT.test('No, x') && Q.VERDICT.test('Not yet: x') && Q.VERDICT.test('Yes. x') && !Q.VERDICT.test('Not the same') && !Q.VERDICT.test('Nothing here'));
  // Markdown bold and "Not now," are verdicts too.
  assert.strictEqual(Q.negated('**No**, short it now.', '**No**, '.length, N, W), false);
  assert.strictEqual(Q.negated('Not now, short it.', 'Not now, '.length, N, W), false);
  assert.ok(Q.VERDICT.test('**No**, x') && Q.VERDICT.test('Not now, x') && Q.VERDICT.test('No!! x'));
  assert.ok(!pass('q23', 'ANSWER: **No**, short it now.'));
  assert.ok(!pass('q23', 'ANSWER: Not now, short it.'));
});

test('grading: a correct "No, <term> ..." answer passes every question whose forbidden term it names (the verdict no longer negates it)', () => {
  const right = {
    q1: ['No, long is not ok and short is not ok: stand aside.', 'No: neither; a long allowed? no.'],
    q3: ['No, rejection or CHoCH alone is not a long.', 'No, a rejection at a level is not enough.', 'No: never against the 4h and 1h.'],
    q6: ['No, as a level it is useless; only the stop.', 'No. Only where the stop goes.'],
    q12: ['No, tighten it? Never: skip or stretch.', 'No, never move the stop closer: skip.'],
    q15: ['No, exit at 2R is not the rule: trail.', 'No, take profit there is wrong; lock and trail.', 'No, never close at 2R: it arms the trail.'],
    q19: ['No, restate: a readable Size line is needed.', 'No, it is a trade only after a restate of the Size line.'],
    q20: ['No, take 2? Never: skip, the floor is 3.'],
    q21: ['No, cancel the stop? Never: keep it.'],
    q28: ['No, sellers in control needs a bearish close: mixed, wait.', 'No, short it only once the next candle closes lower.', 'No, sellers in control is not the read; wait.', 'No - take it now is wrong; wait.',
      'No. The briefing\'s "conflicting" reaction reads as mixed control, so sellers in control isn\'t established from this candle alone.'],
    b5: ['No, take it with 2? Never: floor or skip.'],
  };
  for (const [id, list] of Object.entries(right)) for (const a of list) assert.ok(pass(id, `ANSWER: ${a}`), `${id}: ${a}`);
  // ...and the wrong ones still fail.
  // Round 5: an excuse applies only to the term's immediate predicate, never later in the clause.
  for (const [id, a] of [['q1', 'No short; long is ok? Yes, the 4h is up.'], ['q12', 'Tighten it? Yes, otherwise no size fits.'], ['q20', 'Take with 2? Yes; the floor is 2.'], ['b5', 'Take 2? Yes, no need to skip.'],
    ['q15', 'Exit at 2R, not trail.'], ['q15', 'Close at 2R, never trail.'], ['q6', 'Use it as a level, not as a target.'], ['q19', 'It is a trade, if the size is readable; restate otherwise.'],
    ['q28', 'No. Sellers in control. Short.'], ['q28', 'No: sellers in control, go short.'], ['q28', 'No, the close back below shows sellers in control: go short.'], ['q28', 'No: sellers in control; I sell.'],
    ['q28', 'Mixed, but sellers in control, so I\'d sell.'], ['q28', 'No; short it after all.'], ['q23', 'No: sellers in control. Short.'], ['q23', 'No - sellers are in control, so I\'d short.'],
    ['q3', 'No, not now: it is a long only with a confirmed 1h reversal.'], ['q3', 'No: not on the CHoCH; go long when the 1h reversal tier prints.'],
    ['q31', 'The 4h; yes, trade it: the context is there.'], ['q31', 'The 4h; tradeable on its own given the context.'], ['q31', 'The 4h, go short: context.'], ['q31', 'The 4h; take it after all, context.']]) {
    assert.ok(!pass(id, `ANSWER: ${a}`), `${id} wrong: ${a}`);
  }
  for (const [id, a] of [['q15', 'No. The exit at 2R is cancelled: lock and trail.'], ['q27', 'The engulfing confirms the breakout failed: a confirmed rejection.'],
    ['q30', 'No: the second is a short as well? No: never counter the 4h and 1h; only the first can be taken.'], ['q19', 'No: it is a trade only after a restate of the Size line.']]) {
    assert.ok(pass(id, `ANSWER: ${a}`), `${id} right: ${a}`);
  }
  // A 3m short negated right after it is no forbidden term (e269-part q32 k2); with no reason given it still misses the substance.
  const k2 = Q.gradeAnswer(QUIZ, q('q32'), 'ANSWER: No. A short on the 3m rejection is not a trade here.');
  assert.deepStrictEqual([k2.forb, k2.miss.length], [[], 1]);
  for (const [id, a] of [['q3', 'No, unless a reversal tier confirms.'], ['q15', 'No: exit at 2R.'], ['q12', 'No, tighten it to fit.'], ['q28', 'No. Sellers in control: short it now.'], ['q28', 'No, but sellers are in control: short it.']]) {
    assert.ok(!pass(id, `ANSWER: ${a}`), `${id}: ${a}`);
  }
});

test('the reaction questions (q23-q35, feat/sweep-candle-control): answer-first keys pass the right answer, refuse the wrong ones', () => {
  const cases = {
    // A reaction alone takes no trade: it needs other confirmation.
    q23: [['No: a reaction is context, it needs other confirmation (bias, level, the count).', 'Pass: nothing else lines up.', 'Not on the reaction alone.', 'Not by itself: it needs the count.',
      'No: a long-wick rejection reads sellers in control, but on its own it is context; it needs the count.',
      'No: the wick alone never shows sellers in control; it needs the count.', 'No, not now: short it only with the 15m confirmation.', 'Not yet: sell now only if the count confirms.',
      "No, don't short it now; wait for the count.", 'No: sellers in control needs the count and the level, not one wick.', 'No: wait for the next candle, then sell.',
      'No, sellers in control? not yet: the count decides.', 'No: a sweep of the high; the wick suggests sellers in control, yet it needs the count.'],
      ['Yes, the long wick is enough.', 'Take it: sellers rejected the high.', 'Enter short on the rejection.', 'No, but short it now.', 'Not yet, sellers are in control.', 'No: sell now, sellers in control.',
        'No, go short now.', 'No, sell it now.', 'Not yet - short it now.', 'No: enter short.', 'No: short it.', 'No, take the short.', 'Nope, short now.',
        'No - sellers are in control, short it.', 'No. Sellers in control: short.', 'No: but sellers are in control so short.', 'Never wait: sellers in control.',
        'No, sellers in control, and short.', 'No; sellers in control - short.', 'No: with the wick sellers are in control so sell.', 'No. Sell it now, only a wick is needed.', 'Pass? No: short now, sellers rejected it.', 'No: enter the short.']],
    // The close decides: a close above is acceptance.
    q24: [['Acceptance: the close decides, never the wick.', 'Accepted, not a rejection: it closed above the high.', 'Not a rejection: acceptance.', 'Not rejection, acceptance: it closed above.'],
      ['Rejection: the long wick.', 'A long-wick rejection.', 'Rejected, the wick failed above.', "It's a rejection of the high.", 'Not acceptance: a rejection.']],
    // A long-wick rejection after a high: sellers.
    q25: [['Sellers: they rejected higher prices.', 'The sellers took control.', 'Sellers took control, not buyers.'],
      ['Buyers, they pushed above the high.', 'Neither, but buyers took control of the wick.', 'Sellers? No, buyers took control.', 'Sellers? Buyers held it.', 'Sellers, no: buyers.']],
    // A strong close beyond: a breakout attempt, not a sweep.
    q26: [['Breakout: closed beyond with a 0.8 body, not a sweep.', 'A breakout attempt, buyers in control.'],
      ['Sweep of the high.', "It's a sweep, the wick traded above.", 'A sweep.']],
    // The second candle: a confirmed rejection, said anywhere in the line; never a failed one.
    // Real answers (two quiz runs): confirm and rejection in either order within a clause; the wick's "failed attempt" is
    // no failed rejection.
    q27: [['Confirmed. The rejection holds: sellers took control.', 'Confirmed rejection: sellers took over and confirmed it.', 'A confirmed rejection on the second candle.', 'The second candle is a bearish engulfing closing lower: a confirmed rejection, short side.',
      'It confirms the rejection: sellers took control of the prior RTH high, so the short-side 15m setup is confirmed.',
      'The second candle is a bearish confirmation of the rejection: it is a read that sellers took control after the long-wick rejection, supporting the short side, not an entry by itself.',
      'A bearish engulfing closing lower on the 15m is a confirmed-type short-side read: sellers took control after the long-wick rejection, so it is a rejection-confirmation context read against the long.',
      'A bearish engulfing closing lower is a read of sellers in control on the 15m, which confirms the rejection\'s failed attempt; it is context, not a setup by itself.'],
      ['Breakout down.', 'A breakout.', 'Stall: the next candle decides.', 'Conflicting.', 'The rejection failed: not a confirmed rejection.', 'It undoes the confirmed rejection.', 'The engulfing cancels the confirmed rejection.',
        'The second candle reads the rejection as failed: sellers took control, so the long-wick read is undone and there is no long setup from it.',
        'The rejection failed and is undone: buyers are back.', 'No confirmation, buyers back.',
        'It is not a confirmation of the rejection.', 'No confirmation of the rejection.', 'Not a confirmed rejection.', 'The rejection is negated; a breakout confirmation.',
        'The rejection, then the engulfing confirms a breakout.', 'The rejection: the engulfing confirms nothing.']],
    // Conflicting: mixed, it needs other confirmation (or the next candle).
    q28: [['No, not before the next candle closes lower: only then sellers in control.', 'Not on this alone; it needs confirmation before you can read sellers in control.', 'Not by itself: the conflicting label means mixed, so it needs other confirmation before you read sellers in control.', 'Not on this read alone; the conflicting label means mixed, so it needs other confirmation before you call sellers in control.',
      'Not on this read alone: the candle is conflicting, so it needs other confirmation before it counts as sellers in control.', 'No, sellers in control needs a bearish close: mixed, wait.', 'No, short it only once the next candle closes lower.', 'No: mixed evidence, wait for confirmation.', 'Wait for the next candle.', 'Not yet: conflicting.', 'Not on this read alone; mixed, not sellers in control.', 'Mixed: it needs other confirmation, the count or the next candle.'],
      ['Yes, it closed back below.', 'Sellers are in control.', 'Take it now: the close is back below.', 'Short it: sellers in control.', 'Yes: sellers in control.', 'No, but sellers are in control: short it.', 'Not yet, sellers are in control.', 'No. Sellers in control: short it now.',
        'Yes, read it as sellers in control, but only as a conflicting read that needs other confirmation.', 'No. Until the next close: sellers in control']],
    // A stall: the next candle decides, said anywhere in the line.
    q29: [['The next candle decides.', 'Next 15m candle.', 'The 15m candle after the doji decides it.', 'Whoever wins the next 15m close.'],
      ['The doji itself.', 'This candle decides.', 'Sellers.', 'Buyers decide.', 'The doji decides: it is a stall.']],
    // The same reaction in another context: the context decides (with the bias a short; against the 4h + 1h no trade).
    // The same reaction in another context: the context decides, and the answer says how: with the bias a short, against the
    // 4h + 1h refused (the trend rule). Real answers stating the wrong sides fail.
    q30: [['Both are the short side (a rejection of a high); only the first, with the 4h and 1h down, can be taken; the trend rule refuses the second (never counter).',
      'Short side both times: the pullback one is a continuation short to take, the one against the 4h + 1h is refused.', 'Same candle read (short side), different trade: the 4h and 1h down one can be a setup, the 4h and 1h up one is refused.',
      'Both short; the first can be taken, the second is counter to the 4h and 1h: no trade.', 'Both are shorts (the candle\'s side). Only the first can be taken; the second is refused by the trend rule.',
      'Both are shorts, but only the one with the 4h and 1h down can be taken.', 'Shorts, both. The first may be taken; the second may not.'],
      ['Both are shorts to take.', 'The first is a short, the second a long setup.', 'Short both: take them both.', 'The first a short; the second is a counter-trend short I\'d take small.',
        'Both short: the first can be taken, and take the second anyway.', 'The pullback one is a long, the other a short.', 'Short side; the second is a counter-trend short but still a short to take.',
        'No, they differ: the down-trend one is a short only if it sits against the trend, and the up-trend one is a long pullback.', 'Both short and both can be taken.',
        'The pullback one is a continuation; the other one is refused.', 'Both short; neither is refused.', 'Both shorts, nothing refused: counter or not.',
        'The one with the 4h up is a high rejection on the long side; only the first is short.', 'Both shorts. Only the second cannot be taken at full size.', 'Both short; none refused.',
        'Both short: the second too.', 'Both short; the second is counter but allowed.', 'The first is a short, takeable; the one with the 4h and 1h up is LONG-side only as a counter, refused.']],
    // The reaction rules hold on every timeframe and a higher frame's is stronger confirmation (the owner, 2026-10-31); still
    // context. Asked with candle-reading looked up (its stack line).
    q31: [['The 4h: it outweighs the 15m, but it still needs other confirmation.', 'The 4h rejection; not a trade on its own, it needs the count.', '4h. Context only: it needs more confirmation.', 'The higher frame, the 4h; it still needs confirmation.',
      'The 4h; yes it is the stronger read, but not a trade on its own.', 'The 4-hour rejection is stronger; it still needs confirmation.', 'The four hour one: stronger, but context only.',
      'The 4h rejection is the stronger; no, not on its own: it needs the count.', 'The 4h is stronger, but neither is a trade on its own; it needs the count.', '**The 4h**: stronger; context, it needs the count.',
      'The 4h long-wick rejection is the stronger reaction, but neither one is a trade on its own.', 'The 4h long-wick rejection is the stronger reaction, but it is not a trade on its own.'],
      ['The 15m: it is the setup candle.', 'Yes, the 4h alone takes it.', 'No - the 15m is stronger.', 'The 4h, take it now.', 'The 4h: short it.', 'The 4h; the 15m one is stronger for the setup, take it.',
        'The 4h is stronger: take it with full size, the context supports it.', 'The 4h: short it with 3 contracts, the context is enough.', 'The 4h, it is a trade on its own with that context.', 'The 4h is stronger and a trade on its own.',
        'The 4h; it is enough on its own: context.', 'The 4h is the stronger, it is a trade by itself: confirmation enough.', 'The 4h; take it: the rejection is the confirmation.']],
    // The higher frame's read is the stronger: the 1h close beyond outweighs a 3m rejection, which alone can be noise.
    q32: [['No: the 3m alone can be noise; the 1h closed beyond, the stronger read. Wait.', 'Not on the 3m: the 1h breakout outweighs it.', 'Wait: mixed, the 3m only times an entry.',
      'No: the 1h closed beyond, which outweighs it; the 3m only times the entry.', 'Pass: the 3m cannot override a 1h close beyond.', 'No: a 3m wick against a 1h breakout is noise; no short.',
      'No short on that 3m rejection; the 1h break above the prior RTH high makes it a counter-trend short.', 'No, short on the 3m? Never alone: the 1h outweighs it, wait.'],
      ['Yes, the 3m rejection confirms the short.', 'No, the 3m rejection confirms the short.', 'No - short it now.', 'Short: the wick rejected the high.', 'No: take the short on the 3m.', 'No, sell now.',
        'Not yet: wait, then short on the 3m once it confirms.', 'No - the 1h broke out, so the 3m times a short now.', 'No; short the 3m rejection with a tight stop, the 1h is stronger but late.',
        'No: the 1h is stronger, but the 3m rejection is a short with the count.', 'Wait: the 1h is stronger; take the short with the next 3m close.', 'Short, the 3m is a rejection; the 1h is noise.', 'No: short on the 3m with the 1h breakout as context.',
        'No short; the trend rule refuses it.']],
    // The mirror of q30 (a rejection of a low): the side is the candle's (the long side), never the bias's.
    q33: [['Both are the long side (a rejection of a low); only the first, with the 4h and 1h up, can be taken; the trend rule refuses the second (never counter).',
      'Long side both times: the pullback one is a continuation long, the one against the 4h + 1h is refused.', 'Both long; the first can be taken, the second is counter to the 4h and 1h: no trade.',
      'Both are longs (the candle\'s side). Only the first can be taken; the second is refused by the trend rule.', 'Both are longs, but only the one with the 4h and 1h up can be taken.'],
      ['Both are longs to take.', 'The first is a long, the second a short setup.', 'Long both: take them both.', 'The first a long; the second is a counter-trend long I\'d take small.',
        'Both long: the first can be taken, and take the second anyway.', 'The pullback one is a short, the other a long.', 'Both long and both can be taken.', 'The pullback one is a continuation; the other one is refused.',
        'Both long; neither is refused.', 'Pullback case is LONG (takeable); the case with 4h and 1h down is SHORT-side only as a counter, so it cannot be taken.',
        'Long (the pullback one) can be taken; the short-side one is not a long setup, so it is refused.', 'The first is a long; the other is a short-only entry, refused.']],
    // No bare rejection: a `rejected` relation with a plain reaction is no rejection read by itself.
    q34: [['No: no one took control; plain is not a rejection, weak context only.', 'Not a rejection: the relation is only the fact, and plain means no one took control.', 'No - the reaction decides, and plain is weak context only.',
      'No. A rejection needs a long-wick, engulfing or confirmed reaction; plain is weak context only.', 'No: it is a rejection only with a long wick, an engulfing or a confirmation; plain is weak context.'],
      ['Yes, a rejection read, but plain means no rejection read.', 'Yes: it traded above and closed back below.', 'No: a rejection, context only.', 'No, but it is a rejection: short it.', 'No: sellers took control.', 'Not confirmed, but it is still a rejection.']],
    // The index reference: candle-reading, read with skill_lookup (or the cycle's embedded copy), never rejection alone.
    q35: [['candle-reading, read with skill_lookup (or the cycle\'s embedded copy).', '`candle-reading`: look it up with skill_lookup before the entry.', 'The candle-reading skill, its reaction read: skill_lookup, unless the cycle embedded it.',
      'Read the `candle-reading` skill; it defines what a conflicting reaction means.', 'Read `candle-reading` (the reaction read), then `rejection` for the setup.', 'Read `rejection` for the setup, and `candle-reading` for what the conflicting reaction means; look it up with skill_lookup first.'],
      ['rejection: it is the setup skill.', 'The rejection skill, already in my prompt.', 'candle-reading, with the skill tool.', 'breakout-vs-fakeout.', 'candle-reading: it is embedded in my head prompt.']],
    // The live lines (Part B): each case's Bias line and compose_check's REACTION line, built by the code.
    // The "only" sense of a bias, hyphenated or not ("a long-only bias", as "a long only bias"), names the bias, not
    // the case's side; a case called a long ("Case 2 is a long", "a long-side read") still fails.
    q36: [['Both are shorts (the REACTION line: short side); only case 1 can be taken, case 2 is refused by the trend rule.', 'Short side both; only the first can be taken; the second counters the 4h + 1h.',
      'Both are shorts; case 1 can be taken, case 2 is a short against a long-only bias, so it is refused.', 'Both short; case 1 can be taken, case 2 sits under a long only bias, refused by the trend rule.'],
      ['Case 1 short, case 2 long.', 'Both shorts to take.', 'Both short; neither is refused.', 'Case 1 is a short that can be taken; Case 2 is a long, refused by the trend rule.',
        'Case 1 is a short; case 2 is a long-side read against nothing, refused.', 'Case 1 short; case 2 is a long-side read under a long-only bias, refused.',
        'Both short; case 2 is a long-only setup, refused.']],
    q37: [['Case 1 is a long, and it can be taken; Case 2 is a long against a short bias, and it cannot be taken.', 'Both are longs (the REACTION line: long side); only case 1 can be taken, case 2 is refused by the trend rule.', 'Long side both; only the first can be taken; the second counters the 4h + 1h.',
      'Both are longs; case 1 can be taken, case 2 is a long against a short-only bias, so it is refused.'],
      ['Case 1 long, case 2 short.', 'Both longs to take.', 'Both long; neither is refused.', 'Case 1 is a long that can be taken; Case 2 is a short, refused by the trend rule.',
        'Case 1 long; case 2 is a short-side read under a short-only bias, refused.']],
  };
  // The aligned case must be said takeable: an answer refusing both (neither, both refused, no trade in either) is wrong,
  // whatever it says of the side (qf-final-k20 q30 k7-k11: "Neither can be taken" passed).
  const both = {
    q30: [['Pullback-level rejection (4h and 1h down) is a short that may be taken; the rejection with 4h and 1h up is a short that is refused.',
      'Pullback-level case (4h and 1h down): short side, may be taken. Uptrend case (4h and 1h up): short side, refused.', 'Upper-wick rejection at a high = short side for both; the 4h/1h down one can be taken, the 4h/1h up one is refused.',
      'The 4h-and-1h-down one is a short with the trend; the 4h-and-1h-up one is a counter-trend short the trend rule refuses.'],
    ['Both are shorts; neither can be taken.', 'Pullback-level rejection is a short, refused; the 4h+1h-up one is a short, refused too, and neither can be taken.',
      'Both are the short side, and both are refused.', 'Both short: no trade in either case.', 'Pullback rejection is the short side and can\'t be taken; the rejection with the 4h and 1h up is also the short side and is refused too.']],
    q33: [['Pullback-level low rejection (4h and 1h up) is a long and can be taken; the one with 4h and 1h down is a long and is refused.', 'Pullback-level low rejection is a long; the low rejection with 4h and 1h down is a long that may not be taken.',
      'Both are long-side reads; take the 4h/1h-up pullback long if the rest of the setup checks, and refuse the 4h/1h-down long.'],
    ['Both are longs; neither can be taken.', 'Both are the long side, and both are refused.', 'Both long: no trade in either case.']],
    q36: [['Case 1 is a short and can be taken; Case 2 is a short and is refused.', 'Case 1: short, allowed. Case 2: short, refused (counter-trend); no long exists in either case.'],
    ['Case 1 is a short, refused; Case 2 is a short, refused: neither can be taken.', 'Both are shorts and both are refused.', 'Both short: no trade in either case.']],
    q37: [['Case 1 is a long, and it can be taken; Case 2 is a long, and it is refused.'], ['Both are longs; neither can be taken.', 'Both are longs and both are refused.', 'Both long: no trade in either case.']],
  };
  for (const [id, [right, wrong]] of Object.entries(both)) {
    for (const a of right) assert.ok(pass(id, `ANSWER: ${a}`), `${id} takes the aligned case: ${a}`);
    for (const a of wrong) assert.ok(!pass(id, `ANSWER: ${a}`), `${id} refuses both: ${a}`);
  }
  for (const [id, [right, wrong]] of Object.entries(cases)) {
    for (const a of right) assert.ok(pass(id, `ANSWER: ${a}`), `${id} right: ${a}`);
    for (const a of wrong) assert.ok(!pass(id, `ANSWER: ${a}`), `${id} wrong: ${a}`);
  }
});

test('grading: the prepare-ahead questions (q40-q44, b8) grade the right answers and the trap answers, in the skill\'s own words and negated', () => {
  // [answer, shouldPass]: the review's probe (every misgrade it found) and the negated nuances.
  const cases = {
    q40: [['Do not take it; pass.', false], ['I would not confirm: pass.', false], ['Skip it, don\'t compose.', false], ['Pass.', false], ['No, pass.', false],
      ['Confirmed: the candle met TAKE.', true], ['Yes, go long: TAKE met.', true], ['Composing now with the at-close reads.', true], ['Enter the long.', true],
      ['Confirm: compose_check with the at-close reads.', true], ['Confirm; do not pass.', true]],
    q41: [['Don\'t pass; confirm it.', false], ['I would not pass: take it.', false], ['Confirm.', false], ['Take it.', false], ['Yes, confirm.', false],
      ['No trade: TAKE not met.', true], ['TAKE not met, so pass.', true], ['Passing: closed below VWAP.', true], ['Skip: closed below VWAP.', true],
      ['Pass: TAKE is not met, the close is below VWAP.', true], ['Pass; do not confirm.', true]],
    q42: [['Absolutely, take it as planned; no need to recheck.', false], ['I\'d take it as planned, the wick does not matter.', false], ['Sure, take it; the plan is not wrong.', false],
      ['Yes, take it as planned.', false], ['Confirm it.', false],
      ['TAKE not met: pass.', true], ['Pass.', true], ['Confirm nothing: TAKE not met.', true], ['Skip it: below VWAP, no wick.', true],
      ['No. Pass: the candle did not meet TAKE and the plan is not evidence.', true], ['Do not take it; pass.', true]],
    q43: [['Off the table: the plan said pass, no trade.', false], ['Scenario 3 is not tradeable since scenario 1 passed.', false], ['It is off the table; I will not take it.', false],
      ['Yes, scenario 3 is off the table.', false], ['Yes, pass.', false],
      ['Judge scenario 3 from the facts: its TAKE is met, take it.', true], ['Scenario 3 stands on its own facts; it may be taken.', true], ['No.', true],
      ['No. Judge scenario 3 from the facts; its TAKE is met, so take it.', true], ['Not off the table: the candle meets scenario 3.', true]],
    q44: [['Compose with the plan\'s read (4 pt wick); the facts are noisy.', false], ['Use the 4 pt wick from the plan, not the at-close 1 pt.', false], ['The plan.', false], ['The plan\'s read.', false],
      ['The plan is never evidence: compose with the at-close facts.', true], ['Plan reads are not evidence: use the at-close facts.', true], ['The at-close facts.', true], ['The 1 pt wick read at the close.', true],
      ['The at-close facts: compose with the 1 pt wick, not the plan\'s 4 pt.', true]],
    b8: [['I\'d confirm it: the plan listed it, no conflict.', false], ['Go long: TAKE met, not refused.', false], ['Yes, confirm the long.', false], ['Confirm.', false], ['Take it.', false],
      ['Confirm nothing: the Bias line refuses longs.', true], ['Take no trade: the long is refused.', true], ['No trade.', true], ['Refused: 4h and 1h are down, so no long.', true],
      ['No trade: the Bias line refuses the long.', true], ['Do not confirm; the Bias line refuses it.', true], ['Pass; the Bias line says no long.', true]],
  };
  for (const [id, list] of Object.entries(cases)) {
    for (const [a, want] of list) assert.strictEqual(pass(id, `ANSWER: ${a}`), want, `${id} ${want ? 'right' : 'wrong'}: ${a}`);
  }
});

test('grading: the prepare-ahead questions grade the LEADING verdict: a held-out set of fresh right and wrong variants (written apart from the regexes)', () => {
  // [answer, shouldPass]. The verdict leads (the answer format asks for it); a verdict-less or reversed lead fails.
  const cases = {
    q40: [['Confirm: the candle closed above VWAP with a lower wick, TAKE met.', true], ['Take it: TAKE met.', true], ['Compose the long now.', true], ['Enter long; TAKE is met.', true],
      ['Yes, confirm.', true], ['Confirm; PASS not triggered.', true], ['Confirm; the PASS condition is not met.', true],
      ['Do not confirm.', false], ['Don\'t take it yet.', false], ['Pass: TAKE not met.', false], ['Wait for the next close before confirming.', false], ['Skip.', false], ['No, hold off.', false]],
    q41: [['Pass.', true], ['Pass, wait to confirm on the next bar.', true], ['Pass: I\'d only confirm on a close back above.', true], ['No trade: the close is below VWAP.', true],
      ['Skip: TAKE is not met.', true], ['Decline; the candle failed TAKE.', true], ['Stand down.', true], ['TAKE not met: pass.', true],
      ['Confirm.', false], ['Take the long.', false], ['Yes, confirm it.', false], ['Enter long.', false], ['Not a pass: take the long.', false], ['Don\'t pass; go long.', false],
      ['Do not confirm; pass.', true], ['Confirm nothing: pass.', true]],
    q42: [['Pass.', true], ['No: TAKE not met.', true], ['Skip it.', true], ['Do not take it; pass.', true], ['Pass. The plan said take, but the candle failed TAKE.', true], ['Pass: taking it as planned would be anchoring.', true],
      ['Trust the plan: no recheck needed.', false], ['Yes, take it.', false], ['Proceed as planned.', false], ['Take it anyway.', false], ['Stick to the plan.', false], ['Confirm scenario 1 as planned.', false], ['Go ahead, the plan was sure.', false],
      ['No hesitation: take it.', false], ['Don\'t overthink it: take it as planned.', false], ['Not as planned: pass.', true], ['No. Take it as planned would be anchoring; pass.', true]],
    q43: [['No. Scenario 3 is judged on its own facts.', true], ['Judge scenario 3 from the facts; its TAKE is met.', true], ['Scenario 3 can be taken: its conditions hold.', true], ['Nope, scenario 3 still stands.', true],
      ['Not off the table: take scenario 3.', true], ['Yes, it is off the table.', false], ['Off the table, pass.', false], ['Pass: scenario 1 said pass.', false], ['Scenario 3 is not tradeable.', false], ['Yes.', false]],
    q44: [['The at-close facts: compose with the 1 pt wick.', true], ['At-close facts (1 pt wick); the plan\'s read is not evidence.', true], ['The plan\'s read is never evidence: use the at-close 1 pt.', true],
      ['The plan is not evidence; the facts at the close.', true], ['The 1 pt wick, read at the close.', true], ['Compose with the at-close facts, never the plan\'s.', true],
      ['The plan\'s read.', false], ['Use the plan\'s 4 pt wick.', false], ['The plan\'s wick, 4 pts, over the at-close 1 pt.', false], ['Compose with the plan\'s read.', false], ['The plan\'s version; the at-close facts lag.', false],
      ['The at-close facts lag; go with the plan\'s 4 pt wick.', false],
      ['The at-close facts; the plan\'s read is stale.', true], ['The at-close facts; the plan\'s read lags the close.', true],
      ['The at-close facts not the plan\'s stale read.', true], ['The at-close facts over the plan\'s read.', true]],
    b8: [['No trade: the Bias line refuses the long.', true], ['Pass; the long is refused.', true], ['Do not confirm; the trend rule refuses it.', true], ['Skip: Bias says no longs.', true], ['Confirm nothing.', true],
      ['Confirm the long, TAKE met.', false], ['Yes, take it.', false], ['Take the long; the plan listed it.', false], ['Go long.', false], ['Confirm: nothing refuses it.', false], ['Yes, confirm the long only if compose_check passes.', false],
      ['No issues: TAKE met, confirm.', false], ['Not blocked: confirm.', false], ['No issues: TAKE met, confirm it.', false],
      ['No. Confirm only the short side; the long is refused by the briefing\'s bias, so the plan\'s long is not a trade.', true],
      ['No. The plan\'s long is refused; to confirm it would counter the HTF.', true], ['No: the long is refused; I\'d confirm a short only if one is planned.', true]],
  };
  for (const [id, list] of Object.entries(cases)) {
    for (const [a, want] of list) assert.strictEqual(pass(id, `ANSWER: ${a}`), want, `${id} ${want ? 'right' : 'wrong'}: ${a}`);
  }
});

test('grading: the standing-scenario questions (q47, q48) grade the LEADING verdict: a held-out set (written before the regexes)', () => {
  // [answer, shouldPass]. q47/q48: compose_check refused, so pass (the plan's TAKE, its limit, a wider stop are the traps).
  const cases = {
    q47: [['Pass: compose_check refused it.', true], ['Pass.', true], ['No trade: the refusal is the pass.', true], ['Skip: the stop is not on the losing side.', true], ['Pass; never enter past the stop.', true],
      ['Do not confirm; compose_check refused.', true], ['Stand down: compose refused.', true],
      ['Confirm: a standing setup meets its TAKE with any close.', false], ['Confirm.', false], ['Take it anyway: the setup stands.', false], ['Confirm; place it at the plan\'s limit.', false],
      ['Yes, confirm.', false], ['Go long anyway.', false], ['Not a pass: confirm.', false]],
    q48: [['Pass: compose_check refused (R:R).', true], ['Pass; the plan\'s TAKE is no reason to take.', true], ['No trade: the entry ran away.', true], ['Skip it: refused.', true],
      ['Do not confirm: R:R under the minimum.', true], ['Pass, never late.', true], ['Pass. The plan said take, but the refusal is the pass.', true],
      ['Confirm: the plan said TAKE.', false], ['Take it at the plan\'s limit.', false], ['Confirm at the planned entry.', false], ['Yes, take it as planned.', false], ['Chase it: the setup stands.', false],
      ['Confirm; the R:R is close enough.', false], ['Not a pass: take it at the plan\'s price.', false], ['Place a limit at the plan\'s level and take it.', false]],
  };
  for (const [id, list] of Object.entries(cases)) {
    for (const [a, want] of list) assert.strictEqual(pass(id, `ANSWER: ${a}`), want, `${id} ${want ? 'right' : 'wrong'}: ${a}`);
  }
});

test('grading: every forbidden pattern of q41-q44 and b8 does work (its removal lets a wrong answer through)', () => {
  // [id, forbidden index, a wrong answer that leads with a right-looking verdict, so only that pattern fails it]
  const work = [
    ['q41', 0, 'No, go long.'], ['q41', 1, 'No, take it.'],
    ['q42', 0, 'No, still take it.'], ['q42', 1, 'Pass, take it anyway.'], ['q42', 2, 'No recheck needed: the plan said so.'], ['q42', 3, 'No hesitation: take it.'], ['q42', 4, 'Pass, then take it as planned.'],
    ['q43', 0, 'Yes, judge scenario 3 from the facts.'], ['q43', 1, 'No, it is off the table.'], ['q43', 2, 'No, scenario 3 is not tradeable.'], ['q43', 3, 'No, you must pass.'], ['q43', 4, 'No. Pass anyway.'],
    ['q44', 0, 'The plan\'s read, not the at-close facts.'], ['q44', 1, 'At-close facts exist, but use the plan\'s read.'], ['q44', 2, 'At-close 1 pt, but the plan\'s wick sits over the at-close.'],
    ['q44', 3, 'At-close facts, but 4 pts from the plan.'], ['q44', 4, 'The at-close facts lag.'], ['q44', 5, 'At-close facts or the plan, whichever.'],
    ['b8', 0, 'No issues: go long.'], ['b8', 1, 'Not refused: take it.'], ['b8', 2, 'No conflict, TAKE met: take it.'], ['b8', 3, 'No, take the long only if compose_check passes.'], ['b8', 4, 'No issues: TAKE met, confirm.'],
  ];
  for (const id of ['q41', 'q42', 'q43', 'q44', 'b8']) assert.strictEqual(q(id).forbidden.length, work.filter(w => w[0] === id).length, `${id}: a case for each forbidden pattern`);
  for (const [id, i, answer] of work) {
    assert.strictEqual(pass(id, `ANSWER: ${answer}`), false, `${id} fails: ${answer}`);
    const without = { ...q(id), forbidden: q(id).forbidden.filter((_, j) => j !== i) };
    assert.strictEqual(Q.gradeAnswer(QUIZ, without, `ANSWER: ${answer}`).pass, true, `${id} forbidden[${i}] matters: ${answer}`);
  }
});

test('grading: q49 (a standing scenario, the closing 3m back through the level, still inside the setup candle): no pass by itself, and never ignored: a held-out set (written before the regexes)', () => {
  // candle-reading: a read, never a veto (the count decides); the 3m only times the entry; alone it can be noise.
  const cases = [
    ['No: it is context to weigh; compose_check decides.', true], ['No. The 3m only times the entry; weigh it in the count.', true], ['No, not by itself: weigh it, then compose_check.', true],
    ['Not by itself; it counts against, maybe half size.', true], ['No — a read against, never a veto; the 15m setup still stands.', true],
    ['Nope: compose_check with the at-close reads; the close is a read against.', true], ['No; alone the 3m can be noise.', true],
    ['Yes, pass.', false], ['Yes: the rejection failed.', false], ['Pass: it closed through the level.', false], ['No, ignore it.', false], ['No: the 3m close does not matter.', false],
    ['No, it is irrelevant: take it at full size.', false], ['Yes, the level broke.', false], ['It invalidates the setup: pass.', false], ['No, pass.', false],
  ];
  for (const [a, want] of cases) assert.strictEqual(pass('q49', `ANSWER: ${a}`), want, `q49 ${want ? 'right' : 'wrong'}: ${a}`);
  // The live run (k 10, this skill text): two right answers the grader failed, "the pass condition is" and a compose_check
  // result named "passing"; a pass verdict in -ing form still fails.
  for (const [a, want] of [
    ['No. The 3m close below the prior POC is not by itself a reason to pass; the scenario\'s TAKE condition is "its reads compose at the close," and the pass condition is "compose_check refuses it."', true],
    ['No. The 3m close alone is not a reason to pass; the TAKE is met by compose_check passing, not by the closing 3m candle.', true],
    ['No, but I am passing it anyway.', false],
  ]) assert.strictEqual(pass('q49', `ANSWER: ${a}`), want, `q49 ${want ? 'right' : 'wrong'}: ${a}`);
  // Added after the regexes: a negated ignore is no fail.
  for (const [id, a, want] of [['q49', 'No; don\'t ignore it, weigh it.', true], ['q49', 'Never by itself: weigh it in the count.', true],
    ]) assert.strictEqual(pass(id, `ANSWER: ${a}`), want, `${id} ${want ? 'right' : 'wrong'}: ${a}`);
});

test('grading: every forbidden pattern of q47-q49 does work (its removal lets a wrong answer through), and negated or right-looking variants grade right', () => {
  // [id, forbidden index, a wrong answer that leads with a right-looking verdict, so only that pattern fails it]
  const work = [
    ['q49', 0, 'No, ignore it.'], ['q49', 1, 'No, irrelevant.'], ['q49', 2, 'No: it does not matter.'], ['q49', 3, 'No, it has no effect.'], ['q49', 4, 'No, I\'d pass.'], ['q49', 5, 'No; take the short instead.'],
    ['q47', 0, 'Not a pass: confirm.'], ['q47', 1, 'No, take it.'], ['q47', 2, 'Pass on the plan\'s stop; recompose with a wider stop.'], ['q47', 3, 'Pass; go short, the rejection failed.'],
    ['q48', 0, 'Not a pass: confirm at the planned entry.'], ['q48', 1, 'Not a pass: take it at the plan\'s price.'], ['q48', 2, 'No, chase it.'], ['q48', 3, 'Pass at this price; recompose with a closer target.'],
  ];
  for (const id of ['q47', 'q48', 'q49']) assert.strictEqual(q(id).forbidden.length, work.filter(w => w[0] === id).length, `${id}: a case for each forbidden pattern`);
  for (const [id, i, answer] of work) {
    assert.strictEqual(pass(id, `ANSWER: ${answer}`), false, `${id} fails: ${answer}`);
    const without = { ...q(id), forbidden: q(id).forbidden.filter((_, j) => j !== i) };
    assert.strictEqual(Q.gradeAnswer(QUIZ, without, `ANSWER: ${answer}`).pass, true, `${id} forbidden[${i}] matters: ${answer}`);
  }
  // A forbidden word negated, or a compose-bound condition, is no fail; a confirm of nothing is no confirm.
  for (const [id, a, want] of [
    ['q47', 'Pass; do not confirm.', true], ['q47', 'Pass: never take it past the stop.', true], ['q47', 'Confirm nothing: pass.', true],
    ['q48', 'Pass; never chase.', true], ['q48', 'Pass: don\'t take it at the plan\'s limit.', true], ['q48', 'Confirm nothing: refused.', true],
    // A lead that is no pass (and names no confirm): the required verdict alone fails it (mutation check: required made '.').
    // Review round (pc2-opus): a wait on the noun "close" (F1); a re-compose or a moved stop (F2), negated forms still right;
    // a confirm after a full stop, a "Yes, I'd pass" (low items).
    ['q47', 'Pass, then recompose with a new stop below the close.', false], ['q47', 'Pass the first compose, re-run compose_check with a stop below the 3m low and take it if OK.', false],
    ['q47', 'Not as planned: recompose below the new low and go long.', false], ['q47', 'Pass; move the stop under the 3m low and enter.', false],
    ['q48', 'Pass; redo compose_check with a different stop.', false],
    ['q47', 'Pass: I won\'t recompose with a different stop.', true], ['q47', 'Pass; never widen the stop.', true], ['q47', 'Pass: no recompose.', true],
    ['q47', 'Pass. Don\'t move the stop.', true], ['q48', 'Pass; nothing to recompose.', true],
    ['q47', 'Pass. Confirm it with a stop under the 3m low.', false], ['q48', 'Pass. Take it at the plan\'s limit.', false], ['q47', 'Pass. The refusal is the pass; never confirm it.', true],
    // The reviewer's post-read probes (pc2-opus post.json): a confirm deferred to a later candle, a bare "Long" lead, a pass
    // after a compose lead.
    ['q47', 'Wait for the next close.', false], ['q47', 'Yes.', false], ['q47', 'Buy at the plan\'s limit.', false], ['q47', 'Keep the plan\'s limit working.', false],
    ['q48', 'Wait for a pullback to the plan\'s limit.', false], ['q48', 'Yes.', false], ['q48', 'Rest the limit at the planned entry.', false],
  ]) assert.strictEqual(pass(id, `ANSWER: ${a}`), want, `${id} ${want ? 'right' : 'wrong'}: ${a}`);
});

test('grading: q47, q48, answers that echo the skill\'s own sentences (added after the regexes, a second probe): no misgrade', () => {
  // A conditional pass ("pass only if it refuses"), a confirm named but not the verdict ("I would confirm, but compose_check
  // refused it"): right. A confirm or take as the verdict after a lead or a "but"/"then": wrong.
  const cases = {
    q47: [
      ['Pass — I would confirm, but compose_check refused it.', true], ['Pass: compose_check refusing it is the pass.', true],
      ['Pass: any close meets its TAKE, but compose_check refused it.', true], ['Pass; a standing setup is confirmed only through compose_check, and it refused.', true],
      ['Pass: it would be a confirm as for a met candle, but the refusal is the pass.', true], ['Pass; refused, so no confirm.', true],
      ['Pass: the close is past the stop; the setup is invalidated.', true], ['Pass, with why: compose_check refused (stop not on the losing side).', true],
      ['Not a pass: confirm.', false], ['No, take it.', false], ['Pass? No: confirm it.', false],
    ],
    q48: [
      ['Pass: the entry ran away; I\'d only take it at the plan\'s limit if compose_check agreed.', true], ['Pass: compose_check refusing it is the pass.', true],
      ['Pass; a plan that said take is no reason to take.', true], ['Pass — I planned to confirm it, but compose_check refused (R:R).', true],
      ['Pass: the plan said TAKE, but the at-close facts decide.', true], ['Pass; never chase the plan\'s limit.', true],
      ['Pass, with why: R:R under the minimum.', true], ['Pass: refused; confirming would be anchoring on the plan.', true],
      ['Not a pass: confirm at the planned entry.', false], ['Not a pass: take it at the plan\'s price.', false], ['No, chase it.', false],
    ],
  };
  cases.q47.push(['Pass, but confirm it.', false]);
  cases.q48.push(['Pass, then take it at the plan\'s limit.', false]);
  for (const [id, list] of Object.entries(cases)) {
    for (const [a, want] of list) assert.strictEqual(pass(id, `ANSWER: ${a}`), want, `${id} ${want ? 'right' : 'wrong'}: ${a}`);
  }
});

test('grading: q47-q49, the round-2 review\'s answers (its q45/q46 ones left out: q45 is now a yes/no, q46 is gone): a blind set (written before reading the regexes), its post-read probes (3 contrived ones left out, LOW) and echoes of the owning skills', () => {
  // [id, answer, shouldPass], as the reviewer graded them (scratchpad tools, copied here so the set is held in the repo).
  const cases = [
    ["q47", "ANSWER: Pass: compose_check refused it (the stop is not on the losing side).", true],
    ["q47", "ANSWER: Pass. compose_check refusing is the pass.", true],
    ["q47", "ANSWER: Pass - the refusal decides; CYCLE RESULT: refused, stop not on losing side.", true],
    ["q47", "ANSWER: Pass, no trade; I won't move the stop to make it compose.", true],
    ["q47", "ANSWER: Pass; never widen the stop.", true],
    ["q47", "ANSWER: Do not confirm: pass, compose_check refused.", true],
    ["q47", "ANSWER: Confirm: the standing setup needs nothing of the closing candle.", false],
    ["q47", "ANSWER: Confirm and recompose with the stop below the 3m low.", false],
    ["q47", "ANSWER: Pass on this compose, then re-run compose_check with a wider stop and go long.", false],
    ["q47", "ANSWER: Move the stop below the new low and take it.", false],
    ["q47", "ANSWER: Take it - the plan said take.", false],
    ["q47", "ANSWER: Go long at market with a new stop under the 3m close.", false],
    ["q47", "ANSWER: Confirm; the 3m only times the entry, so it's noise.", false],
    ["q47", "ANSWER: Enter short: the rejection failed.", false],
    ["q48", "ANSWER: Pass: compose_check refused it, R:R under the minimum.", true],
    ["q48", "ANSWER: Pass. The plan's take and its limit are no reason to take; the refusal is the pass.", true],
    ["q48", "ANSWER: Pass, the entry ran away; don't chase.", true],
    ["q48", "ANSWER: Pass - refused for R:R; no recompose.", true],
    ["q48", "ANSWER: Pass; CYCLE RESULT: R:R refused.", true],
    ["q48", "ANSWER: Confirm: I was sure and the plan said take.", false],
    ["q48", "ANSWER: Take it at market, the trend is running.", false],
    ["q48", "ANSWER: Chase it with a smaller size.", false],
    ["q48", "ANSWER: Recompose with a further target so the R:R clears, then take it.", false],
    ["q48", "ANSWER: Place the plan's limit 30 points below and wait for a fill.", false],
    ["q48", "ANSWER: Confirm with a tighter stop to fix the R:R.", false],
    ["q48", "ANSWER: Go long; the plan is the plan.", false],
    ["q48", "ANSWER: Pass the compose, then move the stop closer and take it.", false],
    ["q49", "ANSWER: No: a 3m close is a read, never a veto; weigh it with the count.", true],
    ["q49", "ANSWER: No - the 3m only times the entry; it is context to weigh, not a pass by itself.", true],
    ["q49", "ANSWER: No. Not by itself; read it as candle-reading does and let compose_check and the count decide.", true],
    ["q49", "ANSWER: No, it's a read against to weigh; compose_check still decides.", true],
    ["q49", "ANSWER: No; it's weak context, the setup still stands above the setup candle's low.", true],
    ["q49", "ANSWER: Not by itself: context to weigh.", true],
    ["q49", "ANSWER: Yes: the 3m closed back through the level, the rejection failed: pass.", false],
    ["q49", "ANSWER: Yes, pass - a close back below the level is invalidation.", false],
    ["q49", "ANSWER: Yes. The level is lost.", false],
    ["q49", "ANSWER: No, ignore it: the standing setup needs nothing of the closing candle.", false],
    ["q49", "ANSWER: No, it doesn't matter at all; confirm.", false],
    ["q49", "ANSWER: No, it's irrelevant for a standing setup.", false],
    ["q49", "ANSWER: Pass.", false],
    ["q49", "ANSWER: No, pass: wait for the next 3m to reclaim the POC.", false],
    ["q49", "ANSWER: It is a reason to pass: the failed rejection is a short setup.", false],
    ["q49", "ANSWER: No - it has no effect on a standing scenario.", false],
    ["q40", "ANSWER: Confirm: compose_check with the at-close reads.", true],
    ["q40", "ANSWER: Pass, the plan is never evidence.", false],
    ["q40", "ANSWER: Wait for the 3m to confirm before composing.", false],
    ["q41", "ANSWER: Pass: TAKE not met, it closed below the prior VAH.", true],
    ["q41", "ANSWER: Confirm, the plan said take.", false],
    ["q41", "ANSWER: Confirm; the closing candle is just noise.", false],
    ["q42", "ANSWER: No: pass; the plan is not evidence and TAKE was not met.", true],
    ["q42", "ANSWER: Yes, take it as planned.", false],
    ["q42", "ANSWER: Yes - I was sure.", false],
    ["q43", "ANSWER: No: judge scenario 3 from the at-close facts; it may be taken.", true],
    ["q43", "ANSWER: Yes, scenario 1 said pass so no trade.", false],
    ["q44", "ANSWER: The at-close facts: the 1 pt wick.", true],
    ["q44", "ANSWER: The plan's read, 4 pts.", false],
    ["b8", "ANSWER: No: the Bias line refuses the long, no trade.", true],
    ["b8", "ANSWER: Yes, confirm the long; the candle met TAKE.", false],
    ["b8", "ANSWER: Confirm: the plan listed it and TAKE is met.", false],
    ["q47", "ANSWER: Pass on the long; go short, the rejection failed.", false],
    ["q47", "ANSWER: Pass; flip short below the setup candle's low.", false],
    ["q49", "ANSWER: No, but I'd pass anyway.", false],
    ["q49", "ANSWER: No — skip it though, the POC is lost.", false],
    ["q49", "ANSWER: No, I'd pass.", false],
    ["q49", "ANSWER: No; take the short instead.", false],
    ["q49", "ANSWER: Not by itself, but with the level lost I pass.", false],
    ["q49", "ANSWER: No, it's noise: confirm.", true],
    ["q49", "ANSWER: No. The 3m only times the entry; alone it can be noise.", true],
    ["q49", "ANSWER: No: a read, never a veto; the count decides.", true],
    ["q49", "ANSWER: Never by itself; weigh it.", true],
    ["q47", "ANSWER: Pass. compose_check refusing is the pass.", true],
    ["q47", "ANSWER: No trade: compose_check refused.", true],
    ["q48", "ANSWER: No trade; I would not chase.", true],
    ["q48", "ANSWER: Pass: refused (R:R). Do not chase.", true],
    ["q49", "ANSWER: No, the 3m close is not by itself a reason to pass.", true],
    ["q49", "ANSWER: No: a read, never a veto; only a compose_check refusal is a pass.", true],
    ["q49", "ANSWER: No; context to weigh, pass only if compose_check refuses.", true],
    ["q49", "ANSWER: No: read that candle as candle-reading does; it is context, compose_check decides.", true],
    ["q47", "ANSWER: Pass: compose_check refusing is the pass; never short against the trend.", true],
    ["q47", "ANSWER: Pass; don't flip short.", true],
    // N1: a confirm deferred to a later candle (no "only"); the trade-lifecycle echo "the entry, on the next 3m bar" stays right.
    // N2: the skill's own examples, verbatim, and a pass after a refusal in its clause: right; ", so pass" still wrong.
    // N3: q49, a pass after a leading "No"/"Not by itself"; the negated or conditional forms stay right.
    ['q49', 'ANSWER: No, I\'d pass.', false], ['q49', 'ANSWER: No, but I\'d pass anyway.', false], ['q49', 'ANSWER: No — skip it though, the POC is lost.', false],
    ['q49', 'ANSWER: Not by itself, but with the level lost I pass.', false],
    ['q49', 'ANSWER: No, the 3m close is not by itself a reason to pass.', true], ['q49', 'ANSWER: No: a read, never a veto; only a compose_check refusal is a pass.', true],
    ['q49', 'ANSWER: No; context to weigh, pass only if compose_check refuses.', true], ['q49', 'ANSWER: No: never a pass by itself', true],
    // Low: a counter-trend short (the trend rule allows a long) on q47 and q49.
    ['q47', 'ANSWER: Pass on the long; go short, the rejection failed.', false], ['q47', 'ANSWER: Pass; flip short here.', false], ['q49', 'ANSWER: No; take the short instead.', false],
  ];
  for (const [id, a, want] of cases) assert.strictEqual(Q.gradeAnswer(QUIZ, q(id), a).pass, want, `${id} ${want ? 'right' : 'wrong'}: ${a.split('\n')[0]}`);
});

test('grading: q50-q63, the market-context questions: right and wrong answers per question', () => {
  const q = id => QUIZ.questions.find(x => x.id === id);
  const cases = [
    ['q50', 'ANSWER: A rejection: it traded through the low and closed back.', true], ['q50', 'ANSWER: Acceptance: it broke the low.', false],
    ['q51', 'ANSWER: No: no reaction is not a rejection.', true], ['q51', 'ANSWER: Yes, the level rejected price.', false],
    ['q52', 'ANSWER: Acceptance, not rejection: the closes beyond the level hold.', true], ['q52', 'ANSWER: Rejection of the high.', false],
    ['q54', 'ANSWER: No: a sweep, not a break.', true], ['q54', 'ANSWER: Yes, a BOS down.', false],
    ['q55', 'ANSWER: CHoCH: an early warning, not a reversal by itself.', true], ['q55', 'ANSWER: Reversal: the trend has turned.', false],
    ['q56', 'ANSWER: Not declared: the close is under the RTH VWAP.', true], ['q56', 'ANSWER: Yes, declared: the overnight range broke out.', false],
    ['q57', 'ANSWER: Transition: regime and structure disagree.', true], ['q57', 'ANSWER: Trend up.', false],
    ['q58', 'ANSWER: Range: a chop day.', true], ['q58', 'ANSWER: Trend up.', false],
    ['q59', 'ANSWER: No: a pause inside the trend.', true], ['q59', 'ANSWER: Yes, the market is ranging.', false],
    ['q60', 'ANSWER: A pullback: the CHoCH is inside an intact higher structure.', true], ['q60', 'ANSWER: Reversal.', false],
    ['q61', 'ANSWER: A reversal developing; the 1h CHoCH against is decisive: pass on the long.', true], ['q61', 'ANSWER: Pullback; take the long.', false],
    ['q55', 'ANSWER: CHoCH: the trend has reversed.', false], ['q56', 'ANSWER: A trend up but not yet declared.', true], ['q56', 'ANSWER: Uptrend, declared.', false], ['q56', 'ANSWER: No: all four must be above 0.', true],
    ['q56', 'ANSWER: Declared long.', false], ['q56', 'ANSWER: It has declared long.', false],
    // A right answer that names "declared" again after the no passes; an affirmative at the start still fails.
    ['q56', 'ANSWER: Not declared: the overnight breakout doesn\'t make it declared', true], ['q56', 'ANSWER: No. Uptrend declared needs all four', true],
    ['q56', 'ANSWER: Not yet: the trend has not declared itself long.', true], ['q56', 'ANSWER: A declared trend up.', false],
    ['q56', 'ANSWER: The trend is declared long.', false], ['q56', 'ANSWER: Trend up, declared; not a range.', false],
    // An affirmative start with a "not yet" later: the start decides (each forbidden pattern catches one).
    ['q56', 'ANSWER: The trend is declared, not yet extended.', false], ['q56', 'ANSWER: Uptrend declared, not yet at a level.', false],
    ['q56', 'ANSWER: Yes, not yet extended though.', false],
    // A "not yet" about something else never makes an affirmative right: the no must start the answer, or say not declared.
    ...["It's declared long, not yet extended.", 'Trend has declared, not yet at a level.', 'Uptrend is declared, not yet extended.',
      'Long: declared, not yet extended.', 'Bullish, declared; not yet a pullback.', 'Mostly declared, not yet fully.', 'Effectively declared; not yet ideal.',
      'The 15m trend is declared long; not yet at a level.', 'It has, not yet extended though.', 'The trend has already declared long; not yet at target.',
      'Declared? Yes, not yet extended.', 'It is declared; not yet confirmed by volume.', 'Trending up, declared, not yet overextended.',
      'Already declared, not yet extended.', 'Uptrend declared; not yet at a level.', 'Yes.', 'Yes, declared long.',
      // A "not declared" about the other side never rescues an affirmative start: each forbidden pattern catches one.
      'Yes: long; the short is not declared.', 'It has declared long; the short has not declared.', 'Trend up, declared; not declared short.'].map(a => ['q56', `ANSWER: ${a}`, false]),
    ...['No: the close is under the RTH VWAP, so not all four are your way.', 'Not yet: RTH VWAP is below 0.', 'Not declared; the overnight breakout is not part of it.',
      'No. Declared needs RTH VWAP above 0 too.', 'No — VWAP under 0, so not declared long.', '**No**, not declared: RTH VWAP -0.4.',
      'Not yet declared: wait for the close above the RTH VWAP.', 'No, it has not declared: one of the four is under 0.',
      'No; declared long needs all four above 0, and the RTH VWAP is under.', 'Not declared long (RTH VWAP under 0); the 15m is up but it is a false-start sign.',
      'No: the trend is not declared because RTH VWAP is negative.', 'Not yet. Declared would need VWAP, EMA20 and day move above 0.',
      'It has not declared: the RTH VWAP is under 0.', 'The trend is not declared: VWAP under 0.', 'Trend up but not declared: RTH VWAP under 0.'].map(a => ['q56', `ANSWER: ${a}`, true]),
    ['q57', 'ANSWER: Still an uptrend on the 15m, with the regime in transition.', false], ['q57', 'ANSWER: Transitional: the CHoCH disagrees with the trend read.', true],
    ['q61', 'ANSWER: Reversal; the long is still valid against the 1h.', false], ['q63', 'ANSWER: It is reversing; the weakening signs confirm it: exit.', false],
    ['q50', 'ANSWER: Not a rejection: a sweep.', false], ['q60', 'ANSWER: The start of a reversal, not a pullback.', false],
    ['q51', 'ANSWER: Nothing has happened: no rejection yet.', true], ['q52', 'ANSWER: Yes, acceptance: both closes hold above.', true], ['q59', 'ANSWER: Not really; it is a breather inside the trend.', true],
    ['q61', 'ANSWER: Pullback is ruled out; a reversal is developing, so no long.', true],
    ['q62', 'ANSWER: No: depth alone is no edge.', true], ['q62', 'ANSWER: Yes, a 50% retrace is the entry.', false],
    ['q63', 'ANSWER: Weakening, not a reversal without a 15m break.', true], ['q63', 'ANSWER: Yes, a reversal: exit.', false],
  ];
  for (const [id, a, want] of cases) assert.strictEqual(Q.gradeAnswer(QUIZ, q(id), a).pass, want, `${id} ${want ? 'right' : 'wrong'}: ${a.split('\n')[0]}`);
});

test('summary: correct on all K, answered both ways, the totals, the bar; compare names each change', () => {
  const rows = [];
  for (const x of QUIZ.questions) for (let k = 1; k <= 5; k += 1) rows.push({ id: x.id, k, pass: true });
  for (const x of QUIZ.partB) for (let k = 1; k <= 5; k += 1) rows.push({ id: x.id, k, pass: true });
  const all = Q.summarize(QUIZ, rows, 5);
  // 66 questions, the bar every one (q72, q74, q75, q79-q82 measured 5/5 at k=5; q71 and q73 removed at 4/5):
  // 66 x 5 runs, one missed = 329.
  assert.deepStrictEqual([all.partA.allCorrect, all.partA.bothWays, all.partB.allCorrect, all.meetsBar], [66, 0, 8, true]);
  const one = rows.map(r => (r.id === 'q6' && r.k === 2 ? { ...r, pass: false } : r));
  const s = Q.summarize(QUIZ, one, 5);
  assert.deepStrictEqual([s.partA.allCorrect, s.partA.bothWays, s.partA.total, s.meetsBar], [65, 1, 329, false]);
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
  // An empty answer is no answer: an error (asked again), never graded as a wrong one (it would poison a cached run).
  for (const result of ['', '   \n', undefined]) assert.strictEqual(Q.replyOf({ harness: 'claude' }, JSON.stringify({ result, is_error: false })).error, true, JSON.stringify(result));
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

test('quizErrors: each of the gate\'s whole-number limits absent, negative or fractional is refused, and so at load', () => {
  const keys = { maxGroups: 0, maxGaps: 0, maxGapChars: 0, maxOptionals: 0, minLiteralRun: 1, maxGradedLineChars: 1, maxPatternChars: 1, questionRuns: 1 };
  for (const [key, least] of Object.entries(keys)) {
    const { [key]: _x, ...rest } = QUIZ.gate;
    for (const gate of [rest, { ...QUIZ.gate, [key]: least - 1 }, { ...QUIZ.gate, [key]: least + 0.5 }, { ...QUIZ.gate, [key]: String(least) }]) {
      assert.match(Q.quizErrors({ ...QUIZ, gate }).join('\n'), /^gate: /m, `${key}: ${JSON.stringify(gate[key])}`);
    }
    assert.deepStrictEqual(Q.quizErrors({ ...QUIZ, gate: { ...QUIZ.gate, [key]: least } }), [], `${key} at its least`);
  }
  // A quiz file with one refused is never loaded.
  const dir = tmpDir();
  const file = path.join(dir, 'context-quiz.json');
  fs.writeFileSync(file, JSON.stringify({ ...QUIZ, gate: { ...QUIZ.gate, maxGroups: -1 } }));
  assert.throws(() => Q.loadQuiz({ file }), /gate/);
});

test('grading: q70 (a three-week-old lesson read as a stand-down): no, and why: a stand-down rests on the account\'s facts and the stops on them, a lesson is advice: a held-out set (written before the regexes)', () => {
  // strategy-library's priority order, step 1 (a replay vetoed 42 times on a lesson read as a phase-1 stand-down). Both
  // halves graded: the verdict (a leading no) and its basis (the account's facts, the stops, advice, the count); a no
  // that still bars the entries, waits for a lift or ignores the lesson is wrong.
  const cases = [
    ['No: a stand-down rests only on the account\'s facts and the stops on them; a lesson is advice to weigh in the count.', true],
    ['No. A lesson is advice, never a rule or a block; weigh it in the count.', true],
    ['No: only account facts and hard stops make phase 1 stand down; a lesson is advice.', true],
    ['Never: the lesson is advice shown with its record; defying one is no mistake.', true],
    ['No, it\'s advice: a read in the count, never the reason to pass.', true],
    ['No; a lesson never bars entries: weigh it as a read.', true],
    ['Not on a lesson: only the account\'s facts and the gate\'s and rulebook\'s stops.', true],
    ['No. Don\'t ignore it: weigh the lesson as a read against.', true],
    ['No — none of the hard stops applies (daily limit, cooldown, floor, blackout, entry block); the lesson is advice.', true],
    ['Yes: stand down until the cause is journaled.', false], ['Yes, the lesson bars entries.', false], ['No.', false],
    ['No, but stand aside until it is journaled.', false], ['No stand-down, but veto every entry until the lift.', false],
    ['Not a stand-down, but the lesson still blocks entries.', false], ['No, unless the lesson is still open.', false],
    ['No, ignore the lesson.', false], ['It bars today\'s entries: no lift is journaled.', false],
    ['No; it\'s advice, but entries stay restricted until the lift is journaled.', false],
  ];
  for (const [a, want] of cases) assert.strictEqual(pass('q70', `ANSWER: ${a}`), want, `q70 ${want ? 'right' : 'wrong'}: ${a}`);
  // Probes added after the regexes: a veto on it past a possessive ("today's entries"), a stand-down said anyway, a
  // pass on it; a bold lead and a hyphenated "No stand-down" right.
  for (const [a, want] of [
    ['No; it is advice, but veto today\'s entries on it.', false], ['No, a lesson is advice; but I would stand down anyway.', false],
    ['No, not by itself; but with the account facts clean, still pass on it.', false],
    ['No stand-down; the lesson is advice.', true], ['**No** — a lesson is advice, never a block.', true],
    ['No: phase 1 lists a stand-down only on an account fact or a hard stop (a gate refusal, the daily limit); a lesson is advice to weigh, never a reason to pass.', true],
    // Review round: a stand-aside after the question's own account facts, a veto or skip as the verdict after a right
    // lead (the stand-aside and the verdict now fail wherever they stand, unless negated or "only ... make phase 1 stand down").
    ['No, the account is tradable, but stand aside on the lesson.', false], ['No: weigh the lesson, then veto.', false],
    ['No, it\'s advice — but I\'d still skip today\'s entries.', false], ['No, it\'s advice; still pass today.', false],
    ['No: account facts are clean, so I would veto anyway.', false],
    ['No; a lesson is advice, never a reason to veto or pass.', true],
    ['No: the account is tradable and no hard stop applies, so no stand-down; the lesson is advice.', true],
  ]) assert.strictEqual(pass('q70', `ANSWER: ${a}`), want, `q70 ${want ? 'right' : 'wrong'}: ${a}`);
});

test('grading: every pattern of q70 does work (its removal lets a wrong answer through)', () => {
  // [forbidden index, a wrong answer with both required halves, so only that pattern fails it]
  const work = [
    [0, 'No: a lesson is advice, but stand aside today.'], [1, 'No: it\'s advice, but the lesson still bars entries.'],
    [2, 'No stand-down: it\'s advice, but veto on it.'], [3, 'No: it is advice; hold entries until the cause is journaled.'],
    [4, 'No, only account facts count: ignore the lesson.'], [5, 'No, account facts decide, unless the lesson is still open.'],
  ];
  assert.strictEqual(q('q70').forbidden.length, work.length, 'a case for each forbidden pattern');
  for (const [i, answer] of work) {
    assert.strictEqual(pass('q70', `ANSWER: ${answer}`), false, `q70 fails: ${answer}`);
    const without = { ...q('q70'), forbidden: q('q70').forbidden.filter((_, j) => j !== i) };
    assert.strictEqual(Q.gradeAnswer(QUIZ, without, `ANSWER: ${answer}`).pass, true, `q70 forbidden[${i}] matters: ${answer}`);
  }
  // Each required half matters: a yes with the basis, a no without it.
  for (const [i, answer] of [[0, 'Yes: account facts decide, a lesson is advice.'], [1, 'No, phase 1 may not.']]) {
    assert.strictEqual(pass('q70', `ANSWER: ${answer}`), false, `q70 fails: ${answer}`);
    const without = { ...q('q70'), required: q('q70').required.filter((_, j) => j !== i) };
    assert.strictEqual(Q.gradeAnswer(QUIZ, without, `ANSWER: ${answer}`).pass, true, `q70 required[${i}] matters: ${answer}`);
  }
});


// The chop questions (q72, q74, q75, q79-q82): chop DETECTION, the owner's classes of what the briefing showed at an
// entry: A no chop or trend sign yet (q79, q80), B chop evidence outweighs (q72), C trend evidence only (q74, q75: the
// guard, a chop fix must not make a trend read chop); and two that ask which one fact is chop (or trend) evidence among
// both kinds (q81, q82). No question asks for class D (conflicting): q76-q78 were dropped in review (each rested on
// weighing, not on a skill sentence naming the conflict), and q81/q82 ask for one fact, never a conflict call. q71 (B)
// and q73 (C) were removed after measuring 4/5 at k=5 (real model misses: "conflicting" on a clean rotational and on a
// directional morning), as q45 and q53 were. Each scenario's lines are the code's writers on synthetic values
// (tests/plugin/context-quiz.test.js checks they still are). In the bar: each measured 5/5 at k=5 on its current text.
// Each class answer is graded from the line's START (the class label first, as each question asks): a class named later
// ("Balance - that is not chop evidence") never passes. A wrong class or direction is read in the label: the line's
// first two clauses (to the second ; or .), where each question asks its class and its one more fact; past them the
// line is free for the briefing's and the skills' words (broke out, failed break, range, the initial balance, a read
// against, trend, breakout). The asked fact itself is read on the whole line: q74's fade and long, q75's "not trend
// evidence", q72's balance taken back. A wrong answer that contradicts itself after the label passes (LIMITS).
const CHOP = { B: ['q72'], C: ['q74', 'q75'], A: ['q79', 'q80'], which: ['q81', 'q82'] };
// Wrong answers the graders pass, accepted (round 4): the label clause (to the first ; or .) is the right class, and a
// later clause contradicts it. A pattern grader reads the label and the asked fact; it does not chase every phrasing.
const LIMITS = [
  'q72 Chop evidence; the day is a balance... no, a trend.', 'q72 Chop evidence; day-context: balance ended, a double distribution day.',
  'q72 Chop evidence; day-context calls it a double distribution, a balance inside it.', 'q72 Chop evidence; balance, so buy the middle of the IB.',
  'q74 Trend evidence, traded with it; balance though.', 'q74 Trend evidence; with it until it turns, then counter it.',
  'q74 Trend evidence; traded with it, then counter it at the low.', 'q74 Trend evidence: traded with it, but stalling into the 2 IB extension.',
  'q74 Trend evidence; traded with it, never faded, and a long here is fine.', 'q79 No read yet; trend.', 'q82 F4 - no, F2',
];

test('grading: the chop questions: right answers pass, the other classes fail (a trend read called chop, a chop read called trend, a read where there is none)', () => {
  const cases = {
    q72: [
      ['Chop evidence: balance (inside the IB, the middle is a read against).', true], ['Chop evidence: a balance day.', true],
      ['Chop evidence: balance, not a trend day.', true],
      ['Trend evidence: a normal variation day.', false], ['Conflicting: balance.', false], ['No read yet: balance.', false],
      ['Chop evidence: a neutral day.', false], ['Balance.', false], ['Not chop: balance edges are levels.', false],
      ['Chop evidence: balance, or a normal variation day.', false], ['Chop evidence: balance, a neutral day.', false],
    ],
    q74: [
      ['Trend evidence: a trend day down, traded with it (never faded).', true], ['Trend evidence: traded with it, never counter.', true],
      ['Trend evidence; a trend day, so never fade it.', true], ['Trend evidence: with the trend, don\'t fade it.', true],
      ['Trend evidence: a trend day down; never counter.', true], ['Trend evidence: traded with it; chop signs: none.', true],
      ['Trend evidence: faded.', false], ['Chop evidence: fade the extension.', false], ['Trend evidence: buy the dip.', false],
      ['Conflicting: trend day traded with it.', false], ['Trend evidence, traded with it, chop later.', false],
      ['Trend evidence; with it, but fade the extension.', false], ['Trend evidence: a trend day down.', false], ['Traded with it.', false],
      ['Trend evidence: traded with it; chop signs: two.', false], ['Trend evidence: traded with it; take a long at the low.', false],
    ],
    q75: [
      ['No: an unfinished pullback is no chop sign; trend evidence.', true], ['No, not a chop sign: trend evidence.', true],
      ['No — a pause in the trend: trend evidence.', true], ['Not a chop sign; trend evidence (declared long).', true],
      ['No: a pullback, not a reversal; trend evidence.', true], ['No: trend evidence; chop signs: none.', true],
      ['Yes: chop evidence.', false], ['Chop evidence: the pullback.', false], ['Conflicting: the pullback against the trend.', false],
      ['No, but a chop sign: trend evidence fading.', false], ['Mixed: no chop sign, trend evidence weak.', false],
      ['No chop sign: trend evidence, conflicting with the pullback.', false], ['No chop sign; trend evidence, but a reversal is developing.', false],
      ['Trend evidence; the pullback counts as chop.', false], ['No: an unfinished pullback is no chop sign.', false],
      ['No chop sign; trend evidence, but it is reversing.', false],
    ],
    q79: [
      ['No read yet: too early (a read from 10 bars).', true], ['No read yet; no chop or trend evidence.', true],
      ['No read yet: neither chop evidence nor trend evidence.', true], ['Too early: no read.', true], ['Too early (a read from 10 bars).', true],
      ['No read yet: too early; chop evidence: none.', true], ['No read yet; trend evidence absent.', true],
      ['Trend evidence: 0 crosses.', false], ['Chop evidence.', false], ['Conflicting.', false], ['Rotating so far.', false],
      ['No read yet; the 0 crosses are trend evidence.', false], ['Too early, but trending up so far.', false],
      ['Trend: no read yet on the day.', false], ['Nothing yet.', false], ['No read yet; trend evidence: 0 crosses.', false],
    ],
    q80: [
      ['No read yet: unknown is neutral, neither.', true], ['No read yet; unknown counts as neutral, no chop or trend evidence.', true],
      ['Neutral: no read yet.', true], ['Neither: all unknown.', true], ['No read yet: chop evidence none, trend evidence none.', true],
      ['Chop evidence: the unknowns.', false], ['Trend evidence.', false], ['Conflicting.', false], ['Unknown.', false],
      ['No read yet; unknown counts against.', false], ['No read yet, but chop evidence.', false], ['Mixed: neutral.', false],
    ],
    q81: [
      ['F4', true], ['F4.', true], ['F4 (Day so far rotational).', true], ['F4, not F3: an unfinished pullback is no chop sign.', true],
      ['F4; F3 is only a pullback.', true], ['F4: rotational (back and forth so far)', true], ['F4 — F3 is only a pullback.', true],
      ['F4; F1 is trend evidence.', true],
      ['F3', false], ['F3 and F4', false], ['F1', false], ['F2, F4', false], ['None.', false], ['F4 and F3.', false], ['F3 — and F4.', false],
      ['F4; F3 is chop too.', false], ['F4; F3 is also a chop sign.', false],
    ],
    q82: [
      ['F4', true], ['F4 (declared long: all four above 0).', true], ['F4, not F1 or F3.', true], ['F4; F2 is balance.', true], ['F4 – F2 is balance.', true],
      ['F4; F1 is chop evidence.', true],
      ['F1', false], ['F2', false], ['F3', false], ['F1 and F4', false], ['F3, F4', false], ['None: all chop.', false], ['F4; F1 is trend evidence too.', false],
    ],
  };
  // The independent review's answers (written blind against the first patterns; the class-D ones left out with q76-q78).
  const review = [
    ['q72', '**Chop evidence** — balance: an open inside the prior value area that stays inside the IB; the middle is a read against.', true],
    ['q72', 'Chop evidence: a balance day (inside the IB), not a trend day.', true],
    ['q72', 'Chop evidence — balance day; price at the IB midpoint, edges are the levels.', true],
    ['q72', 'Chop evidence: balanced, inside the IB.', true],
    ['q72', 'Chop evidence; day-context calls it balance, and the middle is a read against.', true],
    ['q72', 'Possibly trend evidence later; for now chop, balance.', false], ['q72', 'Both chop and balance: conflicting.', false],
    ['q74', '**Trend evidence** — a trend day down after an open-drive below the prior range: traded with it, never faded.', true],
    ['q74', 'Trend evidence: trade with it, not fade it.', true], ['q74', 'Trend evidence: traded with it rather than faded.', true],
    ['q74', 'Trend evidence — traded with it (never faded: never counter); short only.', true],
    ['q74', 'Trend evidence: a trend day down is traded with it; fading is never allowed.', true],
    ['q74', 'Trend evidence: with the trend; no longs, no fades.', true], ['q74', 'Trend evidence: traded with it, sell rallies, don\'t buy.', true],
    ['q74', 'Trend evidence: traded with it, but 75% ADR used so a fade is possible.', false],
    ['q74', 'Trend evidence; traded with it, though choppy near the lows.', false], ['q74', 'Trend evidence, traded with it, until it rotates.', false],
    ['q75', 'No — an unfinished pullback is no chop sign; trend evidence (declared long, directional up so far).', true],
    ['q75', 'No. Trend evidence.', true], ['q75', '**No** — a pullback in an uptrend, not chop: trend evidence.', true],
    ['q75', 'No, the pullback is not a chop sign; trend evidence — swings hold, volume falling.', true],
    ['q75', 'No: it is a normal pullback (no reversal signs); trend evidence.', true],
    ['q75', 'No — not trend evidence; rotating so far, ranging.', false], ['q75', 'No, but the day chops: chop evidence outweighs trend.', false],
    ['q75', 'No, not trend evidence: it chops.', false], ['q75', 'No read yet on the pullback; trend unclear.', false],
    ['q75', 'Not a chop sign, though the trend may be ending: mixed.', false],
    ['q79', '**No read yet** — too early (a read from 10 bars); 6 bars only.', true], ['q79', 'No read yet: too early, no chop or trend evidence.', true],
    ['q79', 'No read yet.', true], ['q79', 'No read yet, but leaning trend with 0 crosses.', false],
    ['q79', 'Too early, though 0 VWAP crosses lean directional.', false],
    ['q80', '**No read yet** — everything is unknown, and unknown is neutral.', true], ['q80', 'No read yet: unknown counts neither for nor against.', true],
    ['q80', 'No read yet: unknown is neutral, never a read for or against.', true], ['q80', 'No read yet — unknown is not a reason for or against.', true],
    ['q80', 'No read yet; unknown is no evidence either way.', true], ['q80', 'No read yet, leaning chop since nothing is moving.', false],
    ['q81', 'F4', true], ['q81', '**F4**', true], ['q81', 'F4 - Day so far rotational', true],
    ['q81', 'F4 because F3 is only a pullback', true], ['q81', 'F4 - F3 is only a pullback', true],
    ['q81', 'F4 (and F3)', false], ['q81', 'F4; also F3', false], ['q81', 'F4 and arguably F3', false],
    ['q82', 'F4', true], ['q82', 'F4 (Trend declared? long: all four your way)', true], ['q82', 'F4, since F1 is rotational', true],
    ['q82', 'F4 (plus F1)', false], ['q82', 'F4; F2 also', false],
  ];
  for (const [id, a, want] of review) cases[id].push([a, want]);
  // The adversarial review's answers (round 2, written against the patterns): a class named after a day-context phrase,
  // the briefing's own "inside the initial balance" read as the day type, a trend read hedged with range, balance, a
  // reversal or a counter, a lean on a no-read answer, an explained label that names the other class; and the right
  // answers it found failing (a fade said as counter or never right).
  const review2 = [
    ['q72', 'Chop evidence: balance (inside the IB, open inside the prior value area); the middle is a read against.', true],
    ['q72', 'Chop evidence; day-context calls it balance.', true],
    ['q72', 'Chop evidence; day-context calls it a normal variation day.', false],
    ['q72', 'Chop evidence; it\'s a neutral day (two-sided), not balance.', false],
    ['q72', 'Chop evidence; balance would need an outside open, so a trend day.', false],
    ['q72', 'Chop evidence; not balance, it\'s an inside day.', false],
    ['q72', 'Chop evidence; day-context calls it an inside day, not a balance day.', false],
    ['q72', 'Chop evidence: rotational; day type inside the initial balance (not balanced yet).', false],
    ['q72', 'Chop evidence; a trend day building, imbalance.', false],
    ['q72', 'Chop evidence; an imbalanced day.', false],
    ['q72', 'Chop evidence; the day is unbalanced.', false],
    ['q74', 'Trend evidence: a trend day down, traded with it, never faded.', true],
    ['q74', 'Trend evidence — trend down day; trade with the trend, don\'t fade.', true],
    ['q74', 'Trend evidence: trend down day, but it\'s faded at the 2 IB extension.', false],
    ['q74', 'Trend evidence; trade with it and fade the extremes.', false],
    ['q74', 'Trend evidence; a trend day: sell rallies? no, buy the dip with it.', false],
    ['q74', 'Trend evidence; with the trend down, short only; fading is the play at 80% ADR.', false],
    ['q74', 'Trend evidence; traded with it, yet 75% ADR used so fade the move.', false],
    ['q74', 'Trend evidence, traded with it; balance though.', false],
    ['q74', 'Trend evidence; with it until it turns, then counter it.', false],
    ['q75', 'No, the pullback is no chop sign; trend evidence.', true],
    ['q75', 'No — an unfinished pullback is no chop sign: trend evidence.', true],
    ['q75', 'No, it\'s a reversal, so trend evidence is gone: no read yet.', false],
    ['q75', 'No; trend evidence lost, mixed.', false],
    ['q75', 'No, but trend evidence is weak: it\'s chop.', false],
    ['q75', 'No, the trend is over: the pullback is a range.', false],
    ['q75', 'No; no trend evidence: no read yet.', false],
    ['q75', 'No chop sign; trend? no, no read yet.', false],
    ['q75', 'No chop; trend evidence absent, conflicting.', false],
    ['q79', 'No read yet: too early (6 bars, a read from 10).', true],
    ['q79', 'No read yet, but chop: 0 crosses means trending so far.', false],
    ['q79', 'No read yet, leaning trend up.', false],
    ['q79', 'Too early, but trend evidence on 0 crosses.', false],
    ['q79', 'No read yet; trend.', false],
    ['q79', 'No read yet; it\'s a trend morning with 0 VWAP crosses.', false],
    ['q79', 'No read yet, though it looks like a trend day.', false],
    ['q79', 'No read yet; one-way so far.', false],
    ['q80', 'No read yet: unknown is neutral.', true],
    ['q80', 'Neither yet, but it leans chop.', false],
    ['q80', 'No read yet; a trend morning by its open.', false],
    ['q80', 'Neutral, but chop by default.', false],
    ['q80', 'No read yet: the unknowns count as chop.', false],
    ['q80', 'Neither: it\'s conflicting.', false],
    ['q80', 'No read yet, rotating so far.', false],
    ['q81', 'F4', true],
    ['q81', 'F3', false],
    ['q81', 'F3 and F4', false],
    ['q81', 'F4, and F3 is also chop', false],
    ['q81', 'F4 (F3 is chop too)', false],
    ['q81', 'F3, F4', false],
    ['q81', 'F3 is chop evidence (F4 is trend).', false],
    ['q81', 'F3 is the chop (not F4).', false],
    ['q81', 'F3 is, F4 is not', false],
    ['q82', 'F4', true],
    ['q82', 'F1', false],
    ['q82', 'F1 is trend evidence; F4 is not', false],
    ['q82', 'F4 is not; F1 is', false],
    ['q82', 'F2 is trend evidence, not F4', false],
    ['q82', 'F4 or F2', false],
    ['q82', 'F3 is, F4 is', false],
    ['q72', 'Chop evidence: day type inside the initial balance.', false],
    ['q72', 'Chop evidence; day-context calls it inside the initial balance.', false],
    ['q72', 'Chop evidence: an inside day (inside the initial balance), not a balance day.', false],
    ['q81', 'F3 is the chop evidence; F4 is the day so far.', false],
    ['q81', 'F3 is chop evidence; F4 is rotational but only cumulative.', false],
    ['q82', 'F1 is the trend evidence; F4 is not declared.', false],
    ['q82', 'F2 is the trend evidence (F4 is weak).', false],
    ['q75', 'No, the trend has ended; the pullback is a reversal.', false],
    ['q75', 'No, the trend is turning: range now.', false],
    ['q80', 'Neither chop nor trend evidence: conflicting.', false],
    ['q80', 'Neither: conflicting signals, mixed.', false],
    ['q80', 'Neither; unknown reads as chop.', false],
    ['q79', 'No read yet; but 0 crosses is a trend sign.', false],
    ['q79', 'No read yet, though one-way so far.', false],
    ['q74', 'Trend evidence: a trend day down after an open-drive below the prior range; traded with it, never faded (never counter).', true],
    ['q74', 'Trend evidence: trend day down; traded with it, short only; fading it would be counter.', true],
    ['q74', 'Trend evidence; trade with it — fading a trend day is never right.', true],
    ['q75', 'No: trend evidence; the pullback holds its swings, not a reversal and not chop.', true],
    ['q75', 'No. Trend evidence: declared long, a 38% pullback on falling volume is a pause, not a reversal.', true],
    ['q79', 'No read yet: too early (6 bars; a read from 10), neither chop nor trend.', true],
    ['q80', 'No read yet: everything unknown is neutral, neither chop nor trend evidence.', true],
    ['q72', 'Chop evidence: balance — an open inside the prior value area that stays inside the IB; the middle is a read against, no trend.', true],
    // The coordinator's: a hypothetical or never-said fade is right on q74; the day type and the label must be affirmative.
    ['q74', 'Trend evidence: traded with it; never fading it.', true], ['q74', 'Trend evidence; traded with it, fading it would be counter.', true],
    ['q74', 'Trend evidence; traded with it, then counter it at the low.', false],
    ['q72', 'Chop evidence; an inside day.', false], ['q72', 'Chop evidence: not balanced, rotational.', false],
    ['q75', 'No; the trend is turning, a range.', false], ['q75', 'No, the trend is over.', false], ['q75', 'No; trend evidence is weak.', false],
    ['q81', 'F4 is not; F3 is the chop', false], ['q82', 'F4 is weak; F1 is the trend evidence', false],
  ];
  for (const [id, a, want] of review2) cases[id].push([a, want]);
  // The adversarial review's round 3 (probes against the round-2 patterns): right answers the anchoring broke (a range
  // of the day or leg, out of balance, a refused counter-trend long, too early to call trend or chop, "Only F4") and
  // wrong ones that open with the right label and take it back. q71's and q73's left with those questions.
  const review3 = [
    ['q72', 'Chop evidence: none — balance, but the open was outside value: trend.', false],
    ['q72', 'Chop evidence; balance, but trending.', false],
    ['q72', 'Chop evidence; balance, though a trend morning.', false],
    ['q72', 'Chop evidence: no, not balance-ish; directional.', false],
    ['q72', 'Chop evidence; the day is a balance... no, a trend.', false],
    ['q72', 'Chop evidence: no, balanced? no.', false],
    ['q72', 'Chop evidence: no — not balanced.', false],
    ['q72', 'Chop evidence; balance is wrong, it is a breakout day.', false],
    ['q72', 'Chop evidence; out of balance.', false],
    ['q72', 'Chop evidence; a breakout from balance, trending.', false],
    ['q72', 'Chop evidence; balance broke, now directional.', false],
    ['q72', 'Chop evidence; day-context says open-drive, not balance... rather a drive day.', false],
    ['q72', 'Chop evidence; balance? no.', false],
    ['q72', 'Chop evidence; never balanced.', false],
    ['q72', 'Chop evidence; day type: initial balance, trend.', false],
    ['q72', 'Chop evidence; day-context: balance ended, a double distribution day.', false],
    ['q72', 'Chop evidence: day-context calls it balance (open inside the prior value area, still inside the IB).', true],
    ['q72', 'Chop evidence — a balance day; the middle of the IB is a read against.', true],
    ['q72', 'Chop evidence; balance: the open inside prior value and price inside the initial balance, no trend.', true],
    ['q72', 'Chop evidence; balance (not a trend day).', true],
    ['q72', 'Chop evidence: balance; rotational, not directional, no imbalance.', true],
    ['q72', 'Chop evidence: balance — the last close sits mid-IB, not at an extreme, so no edge.', true],
    ['q72', 'Chop evidence; balance, and the middle of the IB is no place to trade.', true],
    ['q72', 'Chop evidence — day-context: "balance" (inside prior value, inside the IB); no trend evidence.', true],
    ['q72', 'Chop evidence: balance, not a trend day; the middle is a read against.', true],
    ['q72', 'Chop evidence: balance — inside the initial balance, inside value; the middle is a read against.', true],
    ['q72', 'Chop evidence; day-context does not call it balance.', false],
    ['q72', 'Chop evidence, but neither balanced nor two-sided.', false],
    ['q72', 'Chop evidence; it is hardly balanced.', false],
    ['q72', 'Chop evidence; the day is not yet balance.', false],
    ['q74', 'Trend evidence: trend day down (IB extended 150 down, 2 IBs), traded with it, never faded.', true],
    ['q74', 'Trend evidence — a trend day down after an open-drive below the prior range: trade with it; fading it is a mistake.', true],
    ['q74', 'Trend evidence: trend down day, out of balance; traded with it, never faded.', true],
    ['q74', 'Trend evidence: a trend day down; traded with it — the range extended 2 IBs down.', true],
    ['q74', 'Trend evidence: trend day down; traded with it (range so far 225 of 300, 75% used).', true],
    ['q74', 'Trend evidence: trend day; traded with it, not faded, even at 75% of the ADR range.', true],
    ['q74', 'Trend evidence: trend day down, traded with it; a counter-trend long is refused.', true],
    ['q74', 'Trend evidence: trend day down, traded with it; never go counter.', true],
    ['q74', 'Trend evidence: trend day down; traded with it, short only — no counter-trend longs.', true],
    ['q74', 'Trend evidence: trend day down; traded with it; buying here would be counter.', true],
    ['q74', 'Trend evidence: a trend day down; traded with it; fade? never.', true],
    ['q74', 'Trend evidence; with it. Faded? No.', true],
    ['q74', 'Trend evidence: trend day down; traded with it, not faded; a long would be counter-trend.', true],
    ['q74', 'Trend evidence: trend day down; traded with it, never faded — fading would be counter.', true],
    ['q74', 'Trend evidence: trend day; traded with it until the 2 IB target, then fade it.', false],
    ['q74', 'Trend evidence: traded with it, then fading would be fine.', false],
    ['q74', 'Trend evidence: traded with it; fading is not wrong at 75% ADR.', false],
    ['q74', 'Trend evidence: traded with it; fades are not off the table.', false],
    ['q74', 'Trend evidence: traded with it; go short then flip long.', false],
    ['q74', 'Trend evidence: traded with it; look to reverse long at the low.', false],
    ['q74', 'Trend evidence: traded with it, but 75% used, so it may reverse.', false],
    ['q74', 'Trend evidence: traded with it, but stalling into the 2 IB extension.', false],
    ['q74', 'Trend evidence: traded with it; long the bounce.', false],
    ['q74', 'Trend evidence: traded with it; I would buy here.', false],
    ['q74', 'Trend evidence: with it, but faded near the lows is fine too.', false],
    ['q74', 'Trend evidence: traded with it — or faded.', false],
    ['q74', 'Trend evidence: traded with it, the trend is up.', false],
    ['q74', 'Trend evidence: traded with it, a trend day up.', false],
    ['q75', 'No: an unfinished pullback is no chop sign; trend evidence (declared long, holding swings).', true],
    ['q75', 'No — the pullback is a pause in the trend, not chop; trend evidence.', true],
    ['q75', 'No. Trend evidence: 38% depth on falling volume, swings hold, no break against; the trend is not over.', true],
    ['q75', 'No: trend evidence; the pullback has not ended the leg, 15m 20000 holds.', true],
    ['q75', 'No: trend evidence; the pullback is still forming, not turning.', true],
    ['q75', 'No: trend evidence; the day ranged 9 ATR, net up 6.6.', true],
    ['q75', 'No: trend evidence — day\'s range 9 x ATR, net up 6.6, directional up.', true],
    ['q75', 'No, trend evidence: a healthy pullback within the trend, not a reversal.', true],
    ['q75', 'No: trend evidence; a 38% pullback is within range for a trend leg.', true],
    ['q75', 'No: trend evidence; the pullback is a pause, the leg is not ending.', true],
    ['q75', 'No — trend evidence; the pullback is in the leg\'s range, 15m 20000 holds.', true],
    ['q75', 'No: trend evidence; trending up so far, declared long; the pullback is a pause.', true],
    ['q75', 'No: trend evidence; the pullback will likely end and the trend resume.', true],
    ['q75', 'No: trend evidence; only a 15m break against would end it.', true],
    ['q75', 'No: the pullback is not chop, but trend evidence is fading.', false],
    ['q75', 'No; trend evidence faded, no read now.', false],
    ['q75', 'No, trend evidence? Barely.', false],
    ['q75', 'No; trend evidence: none.', false],
    ['q75', 'No; trend evidence lacking.', false],
    ['q75', 'No; it is the end of the trend.', false],
    ['q75', 'No; the trend is done.', false],
    ['q75', 'No; the trend is finished, short it.', false],
    ['q75', 'No, the trend broke.', false],
    ['q75', 'No; trend evidence would need a new high.', false],
    ['q75', 'No, not a chop sign, but trend evidence is not there either.', false],
    ['q75', 'No; trend down now.', false],
    ['q75', 'No, it is a trend reversal.', false],
    ['q75', 'No: the trend has stalled, sideways now.', false],
    ['q75', 'No — the trend failed; stand aside.', false],
    ['q79', 'No read yet: too early (6 bars of the 10 a read needs); 0 crosses is not a read.', true],
    ['q79', 'No read yet — "too early (a read from 10 bars)"; nothing reads trend or chop.', true],
    ['q79', 'No read yet: too early; the 0 VWAP crosses say nothing yet.', true],
    ['q79', 'No read yet (too early: 6 of 10 bars); IB day type unknown.', true],
    ['q79', 'Too early — no read yet; 6 bars, a read from 10.', true],
    ['q79', 'No read yet: too early, the bias is long but that is not day evidence.', true],
    ['q79', 'No read yet: too early; 4h and 1h up is the bias, not today\'s evidence.', true],
    ['q79', 'No read yet, too early; the Bias is long only (4h up, 1h up), which is not a read on the day.', true],
    ['q80', 'No read yet: every line is unknown, and unknown is neutral.', true],
    ['q80', 'No read yet — unknown is neutral, neither chop nor trend evidence.', true],
    ['q80', 'No read yet: all unknown (no 09:30 ET bar), so neutral.', true],
    ['q80', 'No read yet: the bias is long, but the day lines are all unknown: neutral.', true],
    ['q80', 'No read yet: unknown counts neither for nor against.', true],
    ['q79', 'No read yet, but a trend is likely.', false],
    ['q79', 'No read yet; long bias.', false],
    ['q79', 'No read yet, though up so far.', false],
    ['q80', 'No read yet, though the open looks up.', false],
    ['q80', 'Neutral, lean long.', false],
    ['q79', 'No read yet: too early to call chop or trend.', true],
    ['q79', 'No read yet — too early to tell trend from chop (6 bars, a read from 10).', true],
    ['q79', 'No read yet: 6 bars can\'t show trend or chop.', true],
    ['q79', 'No read yet: too early; 0 crosses in 6 bars cannot be called trending.', true],
    ['q79', 'No read yet: too early for chop or trend evidence.', true],
    ['q79', 'No read yet: too early (6 of 10 bars) to read trend or rotation.', true],
    ['q79', 'No read yet: too early; whether it trends or chops is open.', true],
    ['q79', 'No read yet: too early; 0 crosses is too few bars to mean trend.', true],
    ['q80', 'No read yet: with everything unknown we cannot call chop or trend.', true],
    ['q80', 'No read yet: unknown is neutral, so it counts as neither chop nor trend.', true],
    ['q80', 'No read yet — all unknown; that is neutral, not chop and not trend.', true],
    ['q80', 'No read yet: unknown is neutral, it says nothing about trend or chop.', true],
    ['q80', 'No read yet: unknown is neutral — not evidence of chop or a trend.', true],
    ['q80', 'No read yet: unknown counts as neutral, not as chop or trend.', true],
    ['q80', 'No read yet: the unknowns are neutral, not against the trade.', true],
    ['q80', 'No read yet: unknown is neutral, neither for nor against.', true],
    ['q80', 'No read yet: unknown values are neutral and can\'t be read as trend or chop.', true],
    ['q80', 'No read yet; unknown is neutral, so we can\'t lean either way.', true],
    ['q79', 'No read yet: too early; nothing leans either way.', true],
    ['q79', 'No read yet: too early, it could go either way: trend or chop.', true],
    ['q81', 'F4 (not F1, F2 or F3)', true],
    ['q81', 'Only F4.', true],
    ['q81', 'The answer is F4.', true],
    ['q81', 'Label: F4', true],
    ['q81', 'F4 — rotational (F1-F3 are not chop).', true],
    ['q81', 'F4, the Day so far line (rotational).', true],
    ['q81', 'F4 is the chop evidence.', true],
    ['q81', 'F4 is chop evidence; F3 is a pullback.', true],
    ['q81', 'F4 is it; F3 is a pause, not chop.', true],
    ['q81', 'F4? No, F3.', false],
    ['q81', 'F4 is the one... actually F3.', false],
    ['q81', 'F4, or arguably F3.', false],
    ['q81', 'F4 is chop and F3 is chop too.', false],
    ['q81', 'F4 is not chop; F3 is.', false],
    ['q81', 'F4 is no chop sign, F3 is', false],
    ['q81', 'F4 is never chop; F3 is', false],
    ['q81', 'F4 is wrong; F3 is right.', false],
    ['q81', 'F4 doesn\'t count; F3.', false],
    ['q82', 'F4 is trend evidence for a long; F1 is rotational.', true],
    ['q82', 'F4 — declared long, all four above 0.', true],
    ['q82', 'F4 is the only one: F1 is rotational, F2 a balance, F3 an inside candle.', true],
    ['q82', 'F4 is the only one; F1, F2 and F3 are not trend evidence.', true],
    ['q82', 'F4? Not really; F1.', false],
    ['q82', 'F4 is not declared, F1 is', false],
    ['q82', 'F4 is too weak; F1 is the trend.', false],
    ['q82', 'F4 not; F1 is.', false],
    ['q82', 'F4 - no, F2', false],
    // The coordinator's round-3 list, where the review's files did not already hold it.
    ['q72', 'Chop evidence: no - not balanced.', false], ['q72', 'Chop evidence: absent; balance.', false], ['q72', 'Chop evidence - none; balance.', false],
    ['q72', 'Chop evidence (weak): balance.', false], ['q74', 'Trend evidence: none; traded with it.', false],
    ['q74', 'Trend evidence: trend day down; fading it is wrong, traded with it.', true],
    ['q75', 'No — trend evidence; the pullback is in the leg\'s range.', true], ['q75', 'No; trend evidence lacking.', false],
    ['q75', 'No; trend evidence fading.', false], ['q75', 'No; trend evidence: none.', false],
    ['q79', 'No read yet: too early to tell trend from chop.', true], ['q80', 'No read yet: unknown can\'t be read as trend or chop.', true],
    ['q82', 'Only F4.', true], ['q82', 'The answer is F4.', true],
  ];
  for (const [id, a, want] of review3) cases[id].push([a, want]);
  // The adversarial review's round 4: right answers that quote the briefing or the skill after the label (the
  // initial balance, a break out of the IB, failed break no, hasn't failed, a read against a trend entry, no other
  // line is chop) and the wrong direction or the other class said in the label clause.
  const review4 = [
    ['q75', 'No: trend evidence; the long is declared (overnight range broke out its way, VWAP, EMA20 and day\'s move above 0).', true],
    ['q75', 'No - trend evidence: overnight broke out its way, both swings hold, and an unfinished pullback is no chop sign.', true],
    ['q75', 'No: the pullback hasn\'t finished, and an unfinished pullback is no chop sign; trend evidence.', true],
    ['q75', 'No, the leg hasn\'t failed: trend evidence.', true],
    ['q75', 'No, trend evidence: the swings hold and the up leg hasn\'t stalled.', true],
    ['q75', 'No: trend evidence (IB trend up, failed break no on 3m and 15m).', true],
    ['q75', 'No. Trend evidence: an unfinished pullback in an uptrend, not chop.', true],
    ['q75', 'No, trend evidence: the pullback is unfinished and the 15m and 1h swings hold.', true],
    ['q75', 'No — it\'s an unfinished pullback; these lines show trend evidence.', true],
    ['q75', 'No: trend evidence; the pullback isn\'t done and nothing broke against it.', true],
    ['q75', 'No: trend evidence; a 38% pullback on falling volume, the 15m and 1h swings unbroken.', true],
    ['q72', 'Chop evidence; balance day: the open stayed inside the prior value area and has not left the initial balance.', true],
    ['q72', 'Chop evidence; day type balance: price has not broken the initial balance either way.', true],
    ['q72', 'Chop evidence; balance: the open is inside value and price never left the initial balance.', true],
    ['q72', 'Chop evidence; balance - fade the edges, a trend starts only on a break out of the IB.', true],
    ['q72', 'Chop evidence; balance: the IB edges are its levels and the middle is a read against a trend entry.', true],
    ['q72', 'Chop evidence; balance (inside the IB; the middle is a read against any trend trade).', true],
    ['q72', 'Chop evidence; balance day: trade the IB edges until a breakout.', true],
    ['q72', 'Chop evidence; balance day, 0 extension either side of the IB, no directional push.', true],
    ['q72', 'Chop evidence; day-context calls this balance (open inside value, inside the IB, no extension).', true],
    ['q72', 'Chop evidence; balance: an open-auction open inside value that stays inside the initial balance.', true],
    ['q72', 'Chop evidence: balance day (inside the initial balance, 0 up and 0 down).', true],
    ['q72', 'Chop evidence — balance, with only 31% of the ADR used and 5 VWAP crosses.', true],
    ['q74', 'Trend evidence: open-drive down and the IB extended two initial balances down; traded with, never faded.', true],
    ['q74', 'Trend evidence; a trend day down (range extension two IBs), traded with it, never faded.', true],
    ['q74', 'Trend evidence: opened below the prior range, open-drive down, IB extended 150 down; traded with it, never faded.', true],
    ['q74', 'Trend evidence; traded with it (short only), never faded: a long is counter and refused.', true],
    ['q74', 'Trend evidence; traded with the trend, never faded, and the 3m entry candle shows no stall.', true],
    ['q74', 'Trend evidence; a trend day down, traded with it, not faded, with no reversal sign.', true],
    ['q74', 'Trend evidence; trend down, traded with it, never faded; long refused.', true],
    ['q74', 'Trend evidence; traded with it, never faded (the initial balance extended 150 points down).', true],
    ['q74', 'Trend evidence: a trend day down, traded with, never faded; the IB range is 75 points and it extended two IBs down.', true],
    ['q79', 'No read yet: too early (6 bars of 10) for day-context\'s directional or rotational read.', true],
    ['q79', 'No read yet: day so far is too early, so its directional or rotational read doesn\'t apply.', true],
    ['q79', 'No read yet (too early): 6 bars, under the 10 the trend read needs.', true],
    ['q79', 'No read yet: too early; 0 VWAP crosses are not chop evidence.', true],
    ['q79', 'No read yet: too early to call trend or chop.', true],
    ['q80', 'No read yet: every field is unknown, and unknown is neutral, neither chop nor trend.', true],
    ['q80', 'No read yet: day so far is unknown (no 09:30 ET bar), so nothing points to trend or chop.', true],
    ['q80', 'No read yet; all unknown, which counts as neither chop nor trend evidence.', true],
    ['q80', 'No read yet: unknown values are neutral; they count for and against neither side.', true],
    ['q81', 'F4 - Day so far, rotational; F1-F3 are bias, trend and pullback.', true],
    ['q81', 'F4, no other line is chop.', true],
    ['q81', 'The label is F4.', true],
    ['q81', 'F4 — Day so far (rotational).', true],
    ['q81', '**F4**', true],
    ['q81', 'F4 (Day so far: rotational, efficiency 0.03, 10 VWAP crosses)', true],
    ['q82', 'F4 - Trend declared? (long: +0.7, +0.4, +0.9, regime with)', true],
    ['q82', 'F4 — no other line is trend evidence for a long.', true],
    ['q82', '`F4`', true],
    ['q82', 'F4: Trend declared?', true],
    ['q75', 'No: chop evidence is absent; trend evidence.', true],
    ['q75', 'No - chop evidence: none; trend evidence.', true],
    ['q75', 'No: trend evidence, a downtrend.', false],
    ['q75', 'No: trend evidence, but for the short side.', false],
    ['q74', 'Trend evidence: trend up, traded with it, never faded.', false],
    ['q74', 'Trend evidence; an uptrend day, traded with it, never faded.', false],
    ['q74', 'Trend evidence: directional up, traded with it, never faded.', false],
    ['q74', 'Trend evidence; traded with it, never faded, and a long here is fine.', false],
    ['q74', 'Trend evidence; traded with it, never faded, by buying the dips.', false],
    ['q72', 'Chop evidence; balance day, but the last close says a trend up is starting.', false],
    ['q72', 'Chop evidence; day-context calls it a double distribution, a balance inside it.', false],
    ['q72', 'Chop evidence; balance, so buy the middle of the IB.', false],
    ['q79', 'No read yet, but bullish so far.', false],
    ['q79', 'No read yet, but it\'s going up.', false],
    ['q80', 'No read yet, but chop is likely.', false],
    ['q80', 'No read yet; looks bullish.', false],
    ['q81', 'F4 (F3 is likewise chop).', false],
    ['q81', 'F4 (F3 is also rotational).', false],
    ['q82', 'F4 (F2 is also trending).', false],
    ['q82', 'F4 (F1 is also directional).', false],
    ['q81', 'F4 (F3 is choppy too).', false],
    ['q72', 'Chop evidence; balance: price has not left the IB, the initial balance holds.', true],
    ['q75', 'No: trend evidence; the swings didn\'t break and the leg hasn\'t ended.', true],
    ['q75', 'No: trend evidence; the 15m and 1h swings hold, so the trend hasn\'t failed.', true],
    ['q75', 'No, the trend hasn\'t failed: trend evidence.', true],
    ['q75', 'No: the pullback hasn\'t finished; trend evidence.', true],
    ['q75', 'No, the leg hasn\'t stalled: trend evidence.', true],
    ['q72', 'Chop evidence; balance day: the open stayed inside value and has not left the initial balance.', true],
    ['q72', 'Chop evidence; balance: the middle is a read against a trend entry.', true],
    ['q74', 'Trend evidence: the IB extended two initial balances down; traded with it, never faded.', true],
    ['q79', 'No read yet: too early, so its directional or rotational read doesn\'t apply.', true],
  ];
  for (const [id, a, want] of review4) cases[id].push([a, want]);
  assert.deepStrictEqual(Object.keys(cases).sort(), Object.values(CHOP).flat().sort(), 'cases for each chop question');
  // The known limit of a pattern grader (round 4): a wrong answer whose label clause is right and whose later clause
  // contradicts it passes; the rest of the line is free for the briefing's and the skills' words. Listed here, graded
  // as they are graded, so a change that closes one shows up.
  const limits = new Set(LIMITS);
  const bad = [];
  for (const [id, list] of Object.entries(cases)) {
    assert.ok(list.some(([, w]) => w) && list.some(([, w]) => !w), `${id}: right and wrong`);
    for (const [a, want] of list) {
      const expect = want || limits.has(`${id} ${a}`);
      if (pass(id, `ANSWER: ${a}`) !== expect) bad.push(`${id} ${want ? 'right' : limits.has(`${id} ${a}`) ? 'limit' : 'wrong'}: ${a}`);
    }
  }
  assert.deepStrictEqual(bad, []);
  for (const l of limits) assert.ok(Object.entries(cases).some(([id, list]) => list.some(([a, w]) => !w && `${id} ${a}` === l)), `a listed limit is a wrong case: ${l}`);
});

test('grading: every pattern of the chop questions does work (its removal lets a wrong answer through)', () => {
  // Per question, per pattern, a wrong answer only that pattern fails: [id, 'required' | 'forbidden', index, answer].
  const work = [
    ['q72', 'required', 0, 'Balance.'], ['q72', 'required', 1, 'Chop evidence: a range.'],
    ['q72', 'forbidden', 0, 'Chop evidence is weak: balance.'], ['q72', 'forbidden', 1, 'Chop evidence: balance, a neutral day.'],
    ['q72', 'forbidden', 2, 'Chop evidence: not balanced, rotational.'],
    ['q74', 'required', 0, 'Traded with it.'], ['q74', 'required', 1, 'Trend evidence: a trend day down.'],
    ['q74', 'forbidden', 0, 'Trend evidence? Traded with it.'], ['q74', 'forbidden', 1, 'Trend evidence, traded with it, chop later.'],
    ['q74', 'forbidden', 2, 'Trend evidence; with it, but fade the extension.'], ['q74', 'forbidden', 3, 'Trend evidence: traded with it; take a long at the low.'],
    ['q75', 'required', 0, 'Trend evidence; the pullback counts as a pause.'], ['q75', 'required', 1, 'No: an unfinished pullback is no chop sign.'],
    ['q75', 'forbidden', 0, 'Balance: no chop sign, trend evidence.'], ['q75', 'forbidden', 1, 'No chop sign; trend evidence, but it is reversing.'],
    ['q75', 'forbidden', 2, 'No, not trend evidence.'],
    ['q79', 'required', 0, 'Nothing yet.'], ['q79', 'forbidden', 0, 'No read yet; the 0 crosses are trend evidence.'],
    ['q80', 'required', 0, 'Unknown.'], ['q80', 'forbidden', 0, 'No read yet; unknown counts against.'],
    ['q81', 'required', 0, 'None.'], ['q81', 'forbidden', 0, 'F4 and F3'],
    ['q82', 'required', 0, 'None: all chop.'], ['q82', 'forbidden', 0, 'F4 and F1'],
  ];
  for (const id of Object.values(CHOP).flat()) {
    for (const kind of ['required', 'forbidden']) {
      assert.deepStrictEqual(work.filter(w => w[0] === id && w[1] === kind).map(w => w[2]), q(id)[kind].map((_, i) => i), `${id}: a case for each ${kind} pattern`);
    }
  }
  for (const [id, kind, i, answer] of work) {
    assert.strictEqual(pass(id, `ANSWER: ${answer}`), false, `${id} fails: ${answer}`);
    const without = { ...q(id), [kind]: q(id)[kind].filter((_, j) => j !== i) };
    assert.strictEqual(Q.gradeAnswer(QUIZ, without, `ANSWER: ${answer}`).pass, true, `${id} ${kind}[${i}] matters: ${answer}`);
  }
});

test('grading: the chop questions\' exemptions, anchors and closes each do work: without it a right answer fails, or a wrong one passes', () => {
  // [id, kind, index, the text in the pattern, what it becomes, the answer, its grade with the pattern as it is]
  const NONE = '(?!(\\s+(signs?|signals?|evidence))?\\s*[:=]?\\s*(?:(?:is|are|was)\\s+)?(none|0|absent)\\b(?!\\s*\\w))';
  const LABEL = kind => `(?!(?:\\s*(?:,|and|or|-)\\s*F\\d)*\\s+(?:(?:is|are|was)\\s+|(?=(?:a|an)\\s))(?!(?:(?:also|too|likewise|another|the|a|an|really|actually|clearly)\\s+)*(?:${kind})\\b)\\w)`;
  const FADE_OK = '(?:never|not(?!\\s+(?:wrong|off)\\b)|wrong|counter|a mistake|refused)';
  const LIST2 = 'weak|lost|gone|absent|none|lacking|fading|faded|barely|would|not';
  const rows = [
    // The label: the first two clauses; past them the line is free for the briefing's and the skills' words.
    ['q72', 'forbidden', 1, '(?:[^;.]*[;.])?', '', 'Chop evidence; balance, a neutral day.', false],
    ['q72', 'forbidden', 1, '^(?=(?:[^;.]*[;.])?[^;.]*?', '^(?=(?:[^;.]*[;.])?.*?', 'Chop evidence; balance; a trend day needs a break out of the IB.', true],
    ['q75', 'forbidden', 1, '^(?=(?:[^;.]*[;.])?[^;.]*?', '^(?=(?:[^;.]*[;.])?.*?', 'No: trend evidence; declared long. The opening range broke higher.', true],
    ['q74', 'forbidden', 1, NONE, '', 'Trend evidence: traded with it; chop signs: none.', true],
    ['q75', 'forbidden', 1, NONE, '', 'No: trend evidence; chop signs: none.', true],
    ['q75', 'forbidden', 1, '(?:(?:is|are|was)\\s+)?', '', 'No: chop evidence is absent; trend evidence.', true],
    ['q75', 'forbidden', 1, '(?:is|are|was)\\s+)?(none', '(?:are|was)\\s+)?(none', 'No: chop evidence is absent; trend evidence.', true],
    ['q75', 'forbidden', 1, '(?:is|are|was)\\s+)?(none', '(?:is|was)\\s+)?(none', 'No: chop signs are absent; trend evidence.', true],
    ['q75', 'forbidden', 1, '(?:is|are|was)\\s+)?(none', '(?:is|are)\\s+)?(none', 'No: chop evidence was absent; trend evidence.', true],
    ['q79', 'forbidden', 0, NONE, '', 'No read yet; trend evidence absent.', true],
    ['q80', 'forbidden', 0, NONE, '', 'No read yet: chop evidence none, trend evidence none.', true],
    // q75: the briefing's own words in the label pass: "failed break no", "broke out its way".
    ['q75', 'forbidden', 1, 'failed(?! break)', 'failed', 'No: trend evidence (IB trend up, failed break no on 3m and 15m).', true],
    ['q75', 'forbidden', 1, 'broke(?! out)', 'broke', 'No - trend evidence: overnight broke out its way, both swings hold.', true],
    // A fade said refused, wrong, a mistake, counter or never; asked and answered never (q74). "Not wrong" is no refusal.
    ['q74', 'forbidden', 2, '(?!\\?\\s*(?:never|no)\\b)', '', 'Trend evidence: a trend day down; traded with it; fade? never.', true],
    ...[['never', 'Trend evidence: a trend day down is traded with it; fading is never allowed.'], ['wrong', 'Trend evidence: trend day down; fading it is wrong, traded with it.'],
      ['counter', 'Trend evidence: trend day down; traded with it, short only; fading it would be counter.'],
      ['a mistake', 'Trend evidence: traded with it; fading it is a mistake.'], ['refused', 'Trend evidence: traded with it; fading is refused.']]
      .map(([w, a]) => ['q74', 'forbidden', 2, FADE_OK, `(?:${FADE_OK.slice(3, -1).split('|').filter(x => x !== w).join('|')})`, a, true]),
    ['q74', 'forbidden', 2, 'not(?!\\s+(?:wrong|off)\\b)', 'not', 'Trend evidence: traded with it; fading is not wrong at 75% ADR.', false],
    ['q74', 'forbidden', 2, '(?:is|are|was|would be)', '(?:is|was|would be)', 'Trend evidence: traded with it; fades are never right.', true],
    ['q74', 'forbidden', 2, '(?:is|are|was|would be)', '(?:is|are|would be)', 'Trend evidence: traded with it; fading was never allowed.', true],
    ['q74', 'forbidden', 3, 'take (?:a |the )?long', 'take (?:a )?long', 'Trend evidence: traded with it; take the long here.', false],
    ['q74', 'forbidden', 3, 'buying (?:the )?dips?', 'buying dips?', 'Trend evidence: traded with it, by buying the dips.', false],
    ['q74', 'forbidden', 3, 'buying (?:the )?dips?', 'buying (?:the )?dip', 'Trend evidence: traded with it, buying dips.', false],
    ['q74', 'forbidden', 1, 'trend (?:is )?up', 'trend up', 'Trend evidence: traded with it, the trend is up.', false],
    ['q74', 'forbidden', 1, 'up ?trend day', 'uptrend day', 'Trend evidence: traded with it, an up trend day.', false],
    // q75: the trend said over or gone; trend evidence said weak, lost, gone, absent, none, lacking, fading, barely, would, not.
    ['q75', 'forbidden', 1, '(?:is|has|was) over', '(?:is|was) over', 'No: trend evidence, but the move has over.', false],
    ['q75', 'forbidden', 1, '(?:is|has|was) over', '(?:is|has) over', 'No: trend evidence, but the trend was over.', false],
    ...LIST2.split('|').map(w => ['q75', 'forbidden', 2, LIST2, LIST2.split('|').filter(x => x !== w).join('|'), `No; trend evidence ${w}.`, false]),
    ['q75', 'forbidden', 2, "|\\btrend evidence isn't\\b", '', "No; trend evidence isn't there.", false],
    ['q75', 'forbidden', 2, '|\\bnot trending\\b', '', 'No, a trend but not trending.', false],
    ['q75', 'forbidden', 2, '(?:not|no) (?:a )?trend', '(?:not) (?:a )?trend', 'No; no trend evidence.', false],
    // The class said, then hedged or taken back at once (q72, q74's first forbid), read at the line's start only.
    ...[['q72', 'Chop evidence', 'balance'], ['q74', 'Trend evidence', 'traded with it']].flatMap(([id, cls, rest]) => [
      [id, '\\?|', `${cls}? ${rest}.`], [id, 'absent|', `${cls}: absent; ${rest}.`], [id, 'none|', `${cls} - none; ${rest}.`], [id, 'weak|', `${cls} (weak): ${rest}.`],
      [id, 'missing|', `${cls}: missing; ${rest}.`], [id, 'lost|', `${cls} is lost; ${rest}.`], [id, 'gone|', `${cls} is gone; ${rest}.`], [id, '|lacking', `${cls}: lacking; ${rest}.`],
      [id, 'is\\s+not\\b|', `${cls} is not shown; ${rest}.`], [id, "isn't\\b|", `${cls} isn't clear; ${rest}.`], [id, 'would\\b|', `${cls} would need more; ${rest}.`],
      [id, '|could\\b', `${cls} could be argued; ${rest}.`],
    ].map(([i, from, a]) => [i, 'forbidden', 0, from, '', a, false])),
    ['q72', 'forbidden', 0, '^[\\W_]*', '[\\W_]*', 'Chop evidence: balance; more chop evidence would only confirm it.', true],
    ['q74', 'forbidden', 0, '^[\\W_]*', '[\\W_]*', 'Trend evidence: traded with it; more trend evidence would only confirm it.', true],
    // q72: the balance taken back by a word before it, or questioned or called wrong after it; never the briefing's
    // own "initial balance".
    ...['not', "isn't", 'no', 'never', 'hardly', 'neither'].map(w => {
      const list = "not|isn't|no|never|hardly|neither";
      return ['q72', 'forbidden', 2, list, list.split('|').filter(x => x !== w).join('|'), `Chop evidence: ${w} balanced.`, false];
    }),
    ['q72', 'forbidden', 2, '(?:\\?|is (?:wrong|not)\\b|isn\'t\\b)', '(?:is (?:wrong|not)\\b|isn\'t\\b)', 'Chop evidence; balance? no.', false],
    ['q72', 'forbidden', 2, '(?:\\?|is (?:wrong|not)\\b|isn\'t\\b)', '(?:\\?|is (?:not)\\b|isn\'t\\b)', 'Chop evidence; balance is wrong here.', false],
    ['q72', 'forbidden', 2, '(?:\\?|is (?:wrong|not)\\b|isn\'t\\b)', '(?:\\?|is (?:wrong)\\b|isn\'t\\b)', 'Chop evidence; balance is not right.', false],
    ['q72', 'forbidden', 2, '(?:\\?|is (?:wrong|not)\\b|isn\'t\\b)', '(?:\\?|is (?:wrong|not)\\b)', "Chop evidence; balance isn't it.", false],
    ...['but', 'though', 'and'].map(b => ['q72', 'forbidden', 2, '(?:but|though|and)', `(?:${['but', 'though', 'and'].filter(x => x !== b).join('|')})`, `Chop evidence: no trend ${b} balanced.`, true]),
    ['q72', 'forbidden', 2, '{0,20}(?<!\\binitial )', '{0,20}', 'Chop evidence; balance day: the open has not left the initial balance.', true],
    ['q72', 'forbidden', 2, '.*?(?<!\\binitial )\\bbalanced?\\s*', '.*?\\bbalanced?\\s*', 'Chop evidence: balance (the initial balance? not broken).', true],
    ['q72', 'required', 1, '(?<!initial )', '', 'Chop evidence: day type inside the initial balance.', false],
    // The labels: F4 first, said as the answer, never questioned or taken back; another label only explained, never as
    // the asked class.
    ['q81', 'forbidden', 0, LABEL('chop\\w*|rotat\\w*'), '', 'F4 because F3 is only a pullback', true],
    ['q82', 'forbidden', 0, LABEL('trend\\w*|directional'), '', 'F4, since F1 is rotational', true],
    ['q81', 'forbidden', 0, '(?:\\s*(?:,|and|or|-)\\s*F\\d)*', '', 'F4 — rotational (F1-F3 are not chop).', true],
    ['q82', 'forbidden', 0, '(?:\\s*(?:,|and|or|-)\\s*F\\d)*', '', 'F4 is the only one; F1, F2 and F3 are not trend evidence.', true],
    ['q82', 'forbidden', 0, '|(?=(?:a|an)\\s)', '', 'F4 is the only one: F1 is rotational, F2 a balance, F3 an inside candle.', true],
    ['q81', 'forbidden', 0, '(?:chop\\w*|rotat\\w*)', '(?:chop\\w*)', 'F4 (F3 is also rotational).', false],
    ['q81', 'forbidden', 0, 'likewise|', '', 'F4 (F3 is likewise chop).', false],
    ['q82', 'forbidden', 0, '(?:trend\\w*|directional)', '(?:trend\\w*)', 'F4 (F1 is also directional).', false],
    ['q81', 'required', 0, '(?:(?:only|the answer is|the label is|answer|label)\\s*:?\\s*)?', '', 'Only F4.', true],
    ['q82', 'required', 0, '(?:(?:only|the answer is|the label is|answer|label)\\s*:?\\s*)?', '', 'The answer is F4.', true],
    ['q81', 'required', 0, 'the label is|', '', 'The label is F4.', true],
    ['q81', 'required', 0, '(?!\\s*\\?)', '', 'F4? No, F3.', false],
    ['q82', 'required', 0, '(?!\\s*\\?)', '', 'F4? No, F1.', false],
    ...['q81', 'q82'].flatMap(id => [...['not', 'weak', 'no', 'wrong'].map(w => [id, 'required', 0, 'not|weak|no|wrong', 'not|weak|no|wrong'.split('|').filter(x => x !== w).join('|'), `F4 is ${w === 'no' ? 'no good' : `${w} here`}.`, false]),
      [id, 'required', 0, "|isn't\\b", '', "F4 isn't it.", false]]),
    // The label's inner words (round-4 mutation survivors), and the label read from the line's start only.
    ['q72', 'forbidden', 1, 'trend (?:day|morning|up|down)', 'trend (?:day|morning|up)', 'Chop evidence: balance, but a trend down.', false],
    ...['q79', 'q80'].flatMap(id => [
      [id, 'forbidden', 0, '(?:chop|trend) is likely', '(?:trend) is likely', 'No read yet, but chop is likely.', false],
      [id, 'forbidden', 0, '(?:chop|trend) is likely', '(?:chop) is likely', 'No read yet, but a trend is likely.', false],
      [id, 'forbidden', 0, 'trend (?:day|morning|sign)', 'trend (?:day|morning)', 'No read yet, but a trend sign.', false],
      [id, 'forbidden', 0, 'trend (?:day|morning|sign)', 'trend (?:day|sign)', 'No read yet, but a trend morning.', false],
      [id, 'forbidden', 0, '(?:up|down) so far', '(?:up) so far', 'No read yet, but down so far.', false],
      [id, 'forbidden', 0, 'looks? (?:up|down)', 'looks? (?:up)', 'No read yet, but it looks down.', false],
      [id, 'forbidden', 0, 'going (?:up|down)', 'going (?:up)', 'No read yet, but going down.', false],
    ]),
    ...['chop', 'trend'].flatMap(w => [
      ['q80', 'forbidden', 0, 'counts? (?:as (?:chop|trend)|against)', `counts? (?:as (?:${w === 'chop' ? 'trend' : 'chop'})|against)`, `No read yet, but it counts as ${w}.`, false],
      ['q80', 'forbidden', 0, 'reads? as (?:chop|trend)', `reads? as (?:${w === 'chop' ? 'trend' : 'chop'})`, `No read yet, but it reads as ${w}.`, false],
      ['q80', 'forbidden', 0, '(?:chop|trend) by default', `(?:${w === 'chop' ? 'trend' : 'chop'}) by default`, `No read yet, but ${w} by default.`, false],
    ]),
    ['q74', 'forbidden', 1, '^(?=', '(?=', 'Trend evidence: traded with it; never faded. Chop near the lows is noise.', true],
    ['q79', 'forbidden', 0, '^(?=', '(?=', 'No read yet; too early. Trending or not, 6 bars decide nothing.', true],
    ['q80', 'forbidden', 0, '^(?=', '(?=', 'No read yet; all unknown. Leaning on it is no read.', true],
    // The class first: each question's required pattern is anchored at the line's start.
    ...[['q74', 'Traded with it: trend evidence.'], ['q79', 'It is too early: no read yet.'], ['q80', 'It is neutral.'], ['q81', 'Not F3: F4.'], ['q82', 'Not F1: F4.']]
      .map(([id, a]) => [id, 'required', 0, '^', '', a, false]),
  ];
  for (const [id, kind, i, from, to, answer, right] of rows) {
    assert.strictEqual(pass(id, `ANSWER: ${answer}`), right, `${id} ${right ? 'right' : 'wrong'}: ${answer}`);
    const src = q(id)[kind][i];
    assert.ok(src.includes(from), `${id} ${kind}[${i}] holds ${from}`);
    const without = { ...q(id), [kind]: q(id)[kind].map((s, j) => (j === i ? s.replace(from, to) : s)) };
    assert.strictEqual(Q.gradeAnswer(QUIZ, without, `ANSWER: ${answer}`).pass, !right, `${id} ${kind}[${i}] without ${from}: ${answer}`);
  }
});

test('grading: the chop questions\' clause rule does work: each negation and hedge excuses a word in its clause, each break ends the clause, each "none" count excuses its word', () => {
  // The shared clause-scoped forbid: a word passes when a negation or hedge stands within 25 characters before it in the
  // same clause; but, though, yet, and (and , ; . : ! ? and a dash) end the clause; "<word> signals: none" is a count said none.
  const NEG = "no|not|never|nor|neither|without|zero|nothing|none|isn't|aren't|don't|doesn't|can't|cannot|won't|hasn't|haven't|hadn't|didn't|wasn't|weren't";
  const HEDGE = 'rather than|instead of|opposite of|turn into|turns into|could become|too early|too few|whether|to call|to tell|to read|to say';
  // [id, forbidden index, a right answer, a word that forbid catches]
  const sets = [
    ['q72', 1, 'Chop evidence: balance,', 'trending'], ['q74', 1, 'Trend evidence: traded with it,', 'chop'],
    ['q74', 2, 'Trend evidence: traded with it,', 'fade'], ['q74', 3, 'Trend evidence: traded with it,', 'buy'],
    ['q75', 1, 'No: trend evidence,', 'chop'], ['q79', 0, 'No read yet,', 'trending'], ['q80', 0, 'No read yet,', 'trending'],
  ];
  const lb = `(?:\\b(?:${NEG}|${HEDGE})\\b|\\beither way:?)`;
  const cut = (list, w) => list.split('|').filter(x => x !== w).join('|');
  for (const [id, i, base, word] of sets) {
    const src = q(id).forbidden[i];
    assert.ok(src.includes(lb), `${id} forbidden[${i}]: the clause rule`);
    const graded = (s, a) => Q.gradeAnswer(QUIZ, { ...q(id), forbidden: q(id).forbidden.map((x, j) => (j === i ? s : x)) }, `ANSWER: ${a}`).pass;
    assert.strictEqual(pass(id, `ANSWER: ${base} ${word}.`), false, `${id} fails: ${base} ${word}`);
    for (const w of [...NEG.split('|'), ...HEDGE.split('|')]) {
      const a = `${base} ${w} ${word}.`;
      const s = NEG.split('|').includes(w) ? src.replace(lb, lb.replace(NEG, cut(NEG, w))) : src.replace(lb, lb.replace(HEDGE, cut(HEDGE, w)));
      assert.strictEqual(pass(id, `ANSWER: ${a}`), true, `${id} right: ${a}`);
      assert.strictEqual(graded(s, a), false, `${id} forbidden[${i}] without ${w}: ${a}`);
    }
    const either = `${base} either way: ${word}.`;
    assert.strictEqual(pass(id, `ANSWER: ${either}`), true, `${id} right: ${either}`);
    assert.strictEqual(graded(src.replace('|\\beither way:?)', ')'), either), false, `${id} without either way: ${either}`);
    for (const b of ['but', 'though', 'yet', 'and']) {
      const a = `${base} no doubt ${b} ${word}.`;
      assert.strictEqual(pass(id, `ANSWER: ${a}`), false, `${id} wrong: ${a}`);
      assert.strictEqual(graded(src.replace('(?:but|though|yet|and)', `(?:${cut('but|though|yet|and', b)})`), a), true, `${id} forbidden[${i}] without the break ${b}: ${a}`);
    }
    // A dash ends the clause too ("No — the trend failed": the verdict's no never excuses what follows the dash).
    for (const d of ['—', '–']) {
      const a = `${base} no doubt ${d} ${word}.`;
      assert.strictEqual(pass(id, `ANSWER: ${a}`), false, `${id} wrong: ${a}`);
      assert.strictEqual(graded(src.replace('[^,;.:!?—–]){0,25}', `[^,;.:!?${d === '—' ? '–' : '—'}]){0,25}`), a), true, `${id} forbidden[${i}] without the break ${d}: ${a}`);
    }
    if (id !== 'q74' || i === 1) {
      assert.ok(src.includes('(none|0|absent)'), `${id} forbidden[${i}]: the "none" count`);
      for (const [from, to, a] of [['signs?|', '', `${base} ${word} signs: none.`], ['signals?|', '', `${base} ${word} signals: none.`], ['|evidence))', '))', `${base} ${word} evidence: none.`],
        ['(none|0|absent)', '(0|absent)', `${base} ${word}: none.`], ['(none|0|absent)', '(none|absent)', `${base} ${word}: 0.`], ['(none|0|absent)', '(none|0)', `${base} ${word}: absent.`],
        ['(?:is|are|was)\\s+)?(none', '(?:are|was)\\s+)?(none', `${base} ${word} is absent.`], ['(?:is|are|was)\\s+)?(none', '(?:is|was)\\s+)?(none', `${base} ${word} signs are absent.`],
        ['(?:is|are|was)\\s+)?(none', '(?:is|are)\\s+)?(none', `${base} ${word} was absent.`]]) {
        assert.strictEqual(pass(id, `ANSWER: ${a}`), true, `${id} right: ${a}`);
        assert.strictEqual(graded(src.replace(from, to), a), false, `${id} forbidden[${i}] without ${from}: ${a}`);
      }
      // ...only when the count ends the clause: "<word>: 0 crosses" is a claim, not a count said none.
      const claim = `${base} ${word}: 0 crosses.`;
      assert.strictEqual(pass(id, `ANSWER: ${claim}`), false, `${id} wrong: ${claim}`);
      assert.strictEqual(graded(src.replace('(none|0|absent)\\b(?!\\s*\\w)', '(none|0|absent)\\b'), claim), true, `${id} forbidden[${i}] without the clause end: ${claim}`);
    }
  }
});

test('grading: the chop questions\' patterns stay fast on long hostile lines (no catastrophic backtracking)', () => {
  const cap = QUIZ.gate.maxGradedLineChars;
  const lines = ['a', ' ', 'no ', 'not chop ', 'F1 ', 'F1, ', 'chop evidence ', 'trending up so far ', 'x;', '(', 'nonono', 'F', 'chop signs ', 'chop evidence none x ', 'rather than ', 'fading is ', 'either way: ', 'a; ', 'not balance '].map(s => s.repeat(Math.ceil(cap / s.length)).slice(0, cap));
  for (const id of Object.values(CHOP).flat()) {
    for (const src of [...q(id).required, ...q(id).forbidden]) {
      for (const line of lines) {
        const t = process.hrtime.bigint();
        Q.gradeAnswer(QUIZ, { ...q(id), required: [src], forbidden: [src] }, `ANSWER: ${line}`);
        const ms = Number(process.hrtime.bigint() - t) / 1e6;
        assert.ok(ms < 250, `${id} ${src} on ${JSON.stringify(line.slice(0, 12))}...: ${ms.toFixed(1)} ms`);
      }
    }
  }
});

test('grading: every word of the chop questions\' clause-scoped forbids does work (its removal lets a wrong answer through)', () => {
  // The forbids that read the label or the whole line ("^(?=...<no negation in the clause>\b(?:a|b|c)\b...)"): per
  // word, a right answer with that word added after it, which only that word fails. Every word of each list has a case.
  const words = src => {
    const at = src.indexOf('{0,25})\\b(?:');
    if (at < 0) return null;
    const from = at + '{0,25})\\b(?:'.length;
    let depth = 1;
    let to = from;
    for (; to < src.length && depth; to += 1) depth += src[to] === '(' ? 1 : src[to] === ')' ? -1 : 0;
    const alts = [];
    let cur = '';
    depth = 0;
    for (const ch of src.slice(from, to - 1)) {
      depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
      if (ch === '|' && !depth) { alts.push(cur); cur = ''; } else cur += ch;
    }
    alts.push(cur);
    return { alts, cut: k => src.slice(0, from) + alts.filter((_, n) => n !== k).join('|') + src.slice(to - 1) };
  };
  const READ = ['trend evidence', 'chop evidence', 'a trend day', 'a trend is likely', 'trending', 'rotating', 'one-way', 'conflicting', 'mixed', 'leaning', 'up so far',
    'long bias', 'short bias', 'bullish', 'bearish', 'it looks up', 'going up'];
  // [id, forbidden index, the right answer, per word in order the words added after it]
  const sets = [
    ['q72', 1, 'Chop evidence: balance, but', ['trend evidence', 'trending', 'directional', 'conflicting', 'a trend day', 'normal variation', 'a neutral day', 'an inside day', 'imbalance', 'unbalanced', 'out of balance']],
    ['q74', 1, 'Trend evidence: traded with it, but', ['chop', 'rotating', 'conflicting', 'mixed', 'ranging', 'range-bound', 'a range day', 'a balance day', 'reversing', 'the trend is up',
      'trending up', 'an uptrend', 'an up trend day', 'a trend day up', 'directional up', 'bullish']],
    ['q74', 3, 'Trend evidence: traded with it;', ['buy the low', 'buying the dips', 'go long here', 'take a long here', 'flip long', 'long the bounce']],
    ['q75', 1, 'No: trend evidence, but', ['chop', 'rotating', 'conflicting', 'mixed', 'ranging', 'range-bound', 'reversing', 'no read', 'it is over', 'it ended', 'turning', 'it failed',
      'it is done', 'it is finished', 'it stalled', 'sideways', 'it broke', 'the end of the trend', 'trend down', 'a downtrend', 'the short side']],
    ['q79', 0, 'No read yet, but', READ],
    ['q80', 0, 'No read yet, but', [...READ, 'it counts against', 'it reads as chop', 'chop by default']],
  ];
  for (const id of Object.values(CHOP).flat()) {
    // A one-word list (q74's fade) is the pattern itself: the per-pattern test covers it.
    q(id).forbidden.forEach((src, i) => { if (words(src) && words(src).alts.length > 1) assert.ok(sets.some(s => s[0] === id && s[1] === i), `${id} forbidden[${i}]: a word set`); });
  }
  for (const [id, i, base, added] of sets) {
    const w = words(q(id).forbidden[i]);
    assert.strictEqual(added.length, w.alts.length, `${id} forbidden[${i}]: a case per word (${w.alts.join(' | ')})`);
    assert.strictEqual(pass(id, `ANSWER: ${base.replace(/[,;]?\s*(but|then)?$/, '')}.`), true, `${id} right: ${base}`);
    added.forEach((x, k) => {
      const answer = `ANSWER: ${base} ${x}.`;
      assert.strictEqual(pass(id, answer), false, `${id} fails: ${answer}`);
      const without = { ...q(id), forbidden: q(id).forbidden.map((s, j) => (j === i ? w.cut(k) : s)) };
      assert.strictEqual(Q.gradeAnswer(QUIZ, without, answer).pass, true, `${id} forbidden[${i}] word ${w.alts[k]} matters: ${answer}`);
    });
  }
});
