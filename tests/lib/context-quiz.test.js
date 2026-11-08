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

test('summary: correct on all K, answered both ways, the totals, the bar; compare names each change', () => {
  const rows = [];
  for (const x of QUIZ.questions) for (let k = 1; k <= 5; k += 1) rows.push({ id: x.id, k, pass: true });
  for (const x of QUIZ.partB) for (let k = 1; k <= 5; k += 1) rows.push({ id: x.id, k, pass: true });
  const all = Q.summarize(QUIZ, rows, 5);
  // 46 since q70 (a lesson is no phase-1 stand-down): 46 x 5 runs, one missed = 229.
  assert.deepStrictEqual([all.partA.allCorrect, all.partA.bothWays, all.partB.allCorrect, all.meetsBar], [46, 0, 8, true]);
  const one = rows.map(r => (r.id === 'q6' && r.k === 2 ? { ...r, pass: false } : r));
  const s = Q.summarize(QUIZ, one, 5);
  assert.deepStrictEqual([s.partA.allCorrect, s.partA.bothWays, s.partA.total, s.meetsBar], [45, 1, 229, false]);
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
