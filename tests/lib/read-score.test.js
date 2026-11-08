'use strict';

// The read scorer (scripts/lib/eval/read-score.js): closed regex families classify a model answer for a named read
// (namesConflict, calledLabelStale, echoesState) and its decision word. Real-looking answers, most from recorded
// cycles' own sentences; negated facts ("no 1h CHoCH up") never count.

const test = require('node:test');
const assert = require('node:assert');
const R = require('../../scripts/lib/eval/read-score');

const DOWN_1H = { labels: { '4h': 'range', '1h': 'down', '15m': 'range' } };
const UP_1H = { labels: { '4h': 'up', '1h': 'up', '15m': 'range' } };

test('namesConflict: the opposing fact against a frame\'s label, direction-aware', () => {
  const yes = [
    [DOWN_1H, 'CYCLE RESULT: no-trade - the 3m bar rejected the prior high, but 3m and 15m trend up and 1h bullish engulfing sit against it'],
    [DOWN_1H, 'The 1h CHoCH up at 13069.25 is a 1h reversal against the short.'],
    [DOWN_1H, 'The 1h last break is a CHoCH up, known 09:45.'],
    [DOWN_1H, 'The 1h candle closed above its high on 3.55 ATR.'],
    [UP_1H, 'The 1h printed a displacement down through the low.'],
    [UP_1H, '1h outside bar closed below its low.'],
    [UP_1H, 'The 1h bearish engulfing at 10:00 argues against the long.'],
  ];
  for (const [ctx, text] of yes) assert.strictEqual(R.namesConflict(text, ctx), true, text);
});

test('namesConflict: a needed, absent or same-side fact is not a conflict', () => {
  const no = [
    [DOWN_1H, 'the long is a reversal with no 1h CHoCH up.'],
    [DOWN_1H, 'No long setup: a long is a reversal, and there is no 1h CHoCH up.'],
    [DOWN_1H, 'A long would need a 1h CHoCH up first.'],
    [DOWN_1H, 'the long is a reversal without a 1h CHoCH up or 4h rejection up'],
    [DOWN_1H, 'Wait for a 1h CHoCH up before any long.'],
    [UP_1H, 'The short side is only a reversal and the 1h has no CHoCH down, so there is no valid short either.'],
    [DOWN_1H, 'The 1h CHoCH down keeps the short side.'],
    [DOWN_1H, 'The 1h bearish engulfing confirms the trend.'],
    [UP_1H, 'a short is only a reversal, and no 1h CHoCH down is present.'],
    [DOWN_1H, 'The 1h CHoCH up is absent, so the label stands.'],
    [DOWN_1H, 'The 11h mark: CHoCH up on the 3m only.'],
    [DOWN_1H, '1 HTF: 4h range, 1h down, 15m up (CHoCH up at 13189.25), bias short.'],
    [DOWN_1H, 'the 1h is down and the 15m closed above its high'],
    [UP_1H, 'HTF: 1h up, 15m up, 3m CHoCH down at 13140.'],
  ];
  for (const [ctx, text] of no) assert.strictEqual(R.namesConflict(text, ctx), false, text);
});

test('namesConflict: a range frame has no side to oppose; the frames are read only from the labels given', () => {
  assert.strictEqual(R.namesConflict('The 15m CHoCH up and the 15m closed above its high.', DOWN_1H), false);
  assert.strictEqual(R.namesConflict('The 15m CHoCH down and the 15m closed below its low.', DOWN_1H), false);
  assert.strictEqual(R.namesConflict('The 1h CHoCH up.', {}), false);
});

test('namesConflict: transition and disagreement words, never the regime\'s own label or a candle reaction', () => {
  for (const text of ['The 1h is in transition: label down, price up.', 'State: a transition on the 1h.', 'The 1h label and price disagree.',
    'The frames disagree: 4h range, 1h down, 15m up.', 'The 1h structure contradicts its down label.', 'The 1h trend and its last candle are at odds.'])
    assert.strictEqual(R.namesConflict(text, DOWN_1H), true, text);
  for (const text of ['Regime: transition, high volatility.', 'regime transition/normal, flat', 'The regime is transition.',
    'The 15m rejected opening range low (closed back above; conflicting).', 'All three frames agree; no conflict between them.',
    "I disagree with the risk manager's veto.",
    'Nothing contradicts the 1h down trend.', 'The 1h label does not disagree with price.', 'There is no transition here: the 1h is down and price confirms it.'])
    assert.strictEqual(R.namesConflict(text, DOWN_1H), false, text);
});

test('calledLabelStale: the label is said to lag or not to have flipped yet', () => {
  for (const text of ['The 1h trend label lags price after the engulfing.', 'The 1h label is stale.', 'The 1h trend has not flipped yet.',
    "The 1h label hasn't caught up with the move.", 'the 15m trend is lagging the reversal', 'The 1h is still down but has yet to turn.'])
    assert.strictEqual(R.calledLabelStale(text), true, text);
  for (const text of ['The 1h label is not stale.', 'The 1h trend is down and confirmed.', 'The label is no longer lagging.', 'A lagging indicator, the EMA, is flat.',
    'The 1h trend has not flipped, so the short stands.', 'The 1h trend has not changed.'])
    assert.strictEqual(R.calledLabelStale(text), false, text);
});

const LINE = '- State (each frame\'s label vs its own last break and last candle; a read, not a rule): 4h range | 1h down: DISAGREE - last candle bullish engulfing closed above its high (closed 10:00, range 3.55 ATR) -> label and price disagree: transition | 15m range.';

test('echoesState: the answer copies the State line\'s fixed phrase or a named fact verbatim', () => {
  assert.strictEqual(R.echoesState('1h: label and price disagree: transition, so I weigh both.', LINE), true);
  assert.strictEqual(R.echoesState('The line says last candle bullish engulfing closed above its high (closed 10:00, range 3.55 ATR).', LINE), true);
  assert.strictEqual(R.echoesState('The 1h bullish engulfing closed above its high: a transition.', LINE), false, 'its own words');
  assert.strictEqual(R.echoesState('label and price disagree', null), false, 'no line: nothing to echo');
  assert.strictEqual(R.echoesState('anything', '- State (x): 4h range | 1h down: agree | 15m range.'), false, 'an agree line has no fact to echo');
});

test('readOf: every read and the decision word of one answer', () => {
  const text = 'PLAN: 1h down label but the 1h bullish engulfing closed above its high: a transition.\nCYCLE RESULT: no-trade - the 1h is unresolved';
  assert.deepStrictEqual(R.readOf(text, { ...DOWN_1H, line: LINE }), { namesConflict: true, calledLabelStale: false, echoesState: false, decision: 'no-trade' });
  assert.strictEqual(R.readOf('CYCLE RESULT: executed - short', DOWN_1H).decision, 'planned', 'executed is an entry: planned');
  assert.strictEqual(R.readOf('no result line', DOWN_1H).decision, null);
  assert.deepStrictEqual(R.readOf(null, DOWN_1H), { namesConflict: false, calledLabelStale: false, echoesState: false, decision: null });
});

