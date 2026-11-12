'use strict';

// The recognition test's scorer (scripts/lib/learning/recognition/scorer.js; docs/TRAINING.md "The recognition test",
// frozen definitions 2, 3, 4, 8, 10, 11). Pure: no model, no file, no gate. Synthetic candles only.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../../scripts/lib/learning/recognition/scorer');

// candle: { rel (candles from the setup start), evidence, coded, model (a closed word | null = no naming) }
const cs = rows => rows.map(([rel, evidence, coded, model]) => ({ rel, evidence, coded, model }));
const KNOWN = 'trend-up';
const MARGIN = 3;

test('the closed vocabulary: four class words', () => {
  assert.deepStrictEqual(S.WORDS, ['trend-up', 'trend-down', 'chop', 'unclear']);
});

test('the class word is read from the STATE record by equality: absent, unstated, invalid and stated apart; prose never read', () => {
  assert.deepStrictEqual(S.wordOf(null), { status: 'absent', word: null }, 'no record: the run predates the field');
  assert.deepStrictEqual(S.wordOf({ status: 'read', line: 'STATE: 4h up | class trend-up' }), { status: 'absent', word: null }, 'a class word in the line text is never parsed');
  assert.deepStrictEqual(S.wordOf({ classWord: null }), { status: 'unstated', word: null });
  assert.deepStrictEqual(S.wordOf({ classWord: 'trend-up' }), { status: 'stated', word: 'trend-up' });
  assert.deepStrictEqual(S.wordOf({ classWord: 'chop' }), { status: 'stated', word: 'chop' });
  assert.deepStrictEqual(S.wordOf({ classWord: 'Trend-Up' }), { status: 'invalid', word: null }, 'equality: no case folding');
  assert.deepStrictEqual(S.wordOf({ classWord: 'sideways' }), { status: 'invalid', word: null });
  assert.deepStrictEqual(S.wordOf({ classWord: ['chop'] }), { status: 'invalid', word: null });
});

test('cites: the closed field list by equality; an off-list name is counted apart, never matched loosely', () => {
  assert.deepStrictEqual(S.citesOf(null), { status: 'absent', cited: [], offList: [] });
  assert.deepStrictEqual(S.citesOf({ classWord: 'chop' }), { status: 'absent', cited: [], offList: [] });
  assert.deepStrictEqual(S.citesOf({ cites: null }), { status: 'unstated', cited: [], offList: [] });
  assert.deepStrictEqual(S.citesOf({ cites: ['regime', 'vwap', 'regime', 'VWAP', 'the vwap', 7] }), { status: 'stated', cited: ['regime', 'vwap'], offList: ['VWAP', 'the vwap', '7'] });
  assert.deepStrictEqual(S.citesOf({ cites: ['VWAP', 'the regime', ' bias'] }), { status: 'stated', cited: [], offList: ['VWAP', 'the regime', ' bias'] }, 'no case folding, no trimming, no article stripping');
  assert.deepStrictEqual(S.citesOf({ cites: 'regime' }), { status: 'invalid', cited: [], offList: [] });
  assert.ok(S.CITE_FIELDS.includes('day-so-far') && S.CITE_FIELDS.includes('declared'));
});

test('cited vs ignored: ignored = fields with a met signal not cited; cited without a met signal listed apart', () => {
  const r = S.citedVsIgnored({ status: 'stated', cited: ['regime', '4h'], offList: [] }, ['regime', 'vwap', 'day-so-far']);
  assert.deepStrictEqual(r, { status: 'stated', cited: ['regime', '4h'], ignored: ['vwap', 'day-so-far'], citedWithoutSignal: ['4h'], offList: [] });
  assert.strictEqual(S.citedVsIgnored({ status: 'absent', cited: [], offList: [] }, ['regime']).ignored, null, 'no cites in the run: nothing is ignored, it is unknown');
});

test('first candle each reader names the known class; guess before the evidence candle, on it, or lag after', () => {
  const c = cs([[0, 'unclear', 'unclear', null], [1, 'unclear', 'trend-up', 'trend-up'], [2, 'trend-up', 'trend-up', 'trend-up'], [3, 'trend-up', 'trend-up', 'trend-up']]);
  const r = S.recognise(c, KNOWN, MARGIN);
  assert.strictEqual(r.evidenceFirst, 2);
  assert.strictEqual(r.model.first, 1);
  assert.strictEqual(r.model.timing, 'guess');
  assert.strictEqual(r.model.delay, -1);
  assert.strictEqual(r.model.counts, false, 'a guess is not a recognition');
  assert.strictEqual(r.coded.first, 1);
  assert.strictEqual(r.coded.timing, 'guess');
  const on = S.recognise(cs([[0, 'trend-up', 'x', 'trend-up']]), KNOWN, MARGIN);
  assert.strictEqual(on.model.timing, 'on');
  assert.strictEqual(on.model.counts, true);
  const late = S.recognise(cs([[0, 'trend-up', 'trend-up', 'unclear'], [1, 'trend-up', 'trend-up', 'unclear'], [2, 'trend-up', 'trend-up', 'trend-up']]), KNOWN, MARGIN);
  assert.strictEqual(late.model.timing, 'lag');
  assert.strictEqual(late.model.delay, 2);
  assert.strictEqual(late.model.counts, true, 'within the margin');
  const edge = S.recognise(cs([[0, 'trend-up', 'x', 'unclear'], [3, 'trend-up', 'x', 'trend-up']]), KNOWN, MARGIN);
  assert.strictEqual(edge.model.counts, true, 'a delay equal to the margin counts');
  const miss = S.recognise(cs([[0, 'trend-up', 'trend-up', 'unclear'], [4, 'trend-up', 'trend-up', 'trend-up']]), KNOWN, MARGIN);
  assert.strictEqual(miss.model.counts, false, 'later than the margin = a miss');
});

test('a candle with no naming is never filled in from the coded read', () => {
  const r = S.recognise(cs([[0, 'trend-up', 'trend-up', null], [1, 'trend-up', 'trend-up', null]]), KNOWN, MARGIN);
  assert.strictEqual(r.model.first, null);
  assert.strictEqual(r.model.timing, 'never');
  assert.strictEqual(r.model.named, 0);
  assert.strictEqual(r.coded.first, 0);
});

test('no evidence candle in the case: naming the class is a guess with no reference', () => {
  const r = S.recognise(cs([[0, 'unclear', 'unclear', 'trend-up']]), KNOWN, MARGIN);
  assert.strictEqual(r.evidenceFirst, null);
  assert.strictEqual(r.model.timing, 'guess');
  assert.strictEqual(r.model.counts, false);
});

test('confusion both ways and the always-trend / always-chop baselines (against the evidence class per candle)', () => {
  const A = S.accuracy(cs([[0, 'trend-up', 'x', 'chop'], [1, 'trend-up', 'x', 'trend-up'], [2, 'chop', 'x', 'trend-up'], [3, 'unclear', 'x', null]]));
  assert.deepStrictEqual(A.confusion['trend-up'], { chop: 1, 'trend-up': 1 });
  assert.deepStrictEqual(A.confusion.chop, { 'trend-up': 1 });
  assert.strictEqual(A.named, 3);
  assert.strictEqual(A.right, 1);
  assert.strictEqual(A.accuracy, 1 / 3);
  assert.strictEqual(A.alwaysTrend, 2 / 4);
  assert.strictEqual(A.alwaysChop, 1 / 4);
  assert.strictEqual(S.accuracy([]).accuracy, null);
});

test('false alarms (spec D): candles naming the OPPOSITE kind over candles naming a trend or chop word; a wrong-way trend apart', () => {
  assert.deepStrictEqual(S.falseAlarms(cs([[0, 'chop', 'x', 'trend-up'], [1, 'chop', 'x', 'chop'], [2, 'chop', 'x', 'trend-down'], [3, 'chop', 'x', 'unclear']]), 'chop'),
    { named: 3, opposite: 2, rate: 2 / 3, wrongWay: 0 });
  assert.deepStrictEqual(S.falseAlarms(cs([[0, 'x', 'x', 'chop'], [1, 'x', 'x', 'trend-down'], [2, 'x', 'x', 'trend-up'], [3, 'x', 'x', null]]), 'trend-up'),
    { named: 3, opposite: 1, rate: 1 / 3, wrongWay: 1 }, 'trend-down on a trend-up leg is the same kind: a wrong way, not a false alarm');
  assert.strictEqual(S.falseAlarms(cs([[0, 'x', 'x', 'unclear']]), 'chop').rate, null);
});

test('summary: trend vs chop only; recall, precision, false-alarm rate, the coded read beside, delay vs accuracy', () => {
  const cases = [
    { id: 'a', known: 'trend-up', margin: 3, pace: 'slow', candles: cs([[0, 'trend-up', 'trend-up', 'trend-up'], [1, 'trend-up', 'trend-up', 'trend-up']]) },
    { id: 'b', known: 'chop', margin: 3, pace: null, candles: cs([[0, 'chop', 'chop', 'trend-up'], [1, 'chop', 'unclear', 'chop'], [2, 'chop', 'x', null]]) },
    { id: 'c', known: 'trend-down', margin: 3, pace: 'sharp', candles: cs([[0, 'trend-down', 'unclear', 'chop'], [9, 'trend-down', 'trend-down', 'trend-down']]) },
  ];
  const s = S.summary(cases);
  assert.strictEqual(s.trend.n, 2);
  assert.strictEqual(s.chop.n, 1);
  assert.deepStrictEqual(s.trend.cases, ['a', 'c']);
  assert.strictEqual(s.trend.recalled, 1, 'case c named 9 candles after the evidence: a miss');
  assert.strictEqual(s.trend.recall, 1 / 2);
  assert.strictEqual(s.chop.recall, 1, 'chop named one candle after the evidence, within the margin');
  assert.strictEqual(s.trend.precision, 3 / 4, 'trend words naming the known class / every trend word on any case');
  assert.strictEqual(s.chop.precision, 1 / 2);
  assert.strictEqual(s.trend.falseAlarmRate, 1 / 4);
  assert.strictEqual(s.chop.falseAlarmRate, 1 / 2);
  assert.strictEqual(s.trend.codedRecalled, 1, 'the coded read beside the model, same rule');
  assert.strictEqual(s.chop.codedRecalled, 1);
  assert.deepStrictEqual(s.delayVsAccuracy.map(r => [r.id, r.delay]), [['a', 0], ['b', 1], ['c', 9]]);
  assert.strictEqual(s.delayVsAccuracy[0].accuracy, 1);
  assert.deepStrictEqual(s.byPace, { sharp: { cases: ['c'], recalled: 0 }, slow: { cases: ['a'], recalled: 1 } }, 'item 12: listed, not averaged');
});

test('entry vs confirmation: before / on / after in candles; in-trade cycles are labelled, never a sit-out', () => {
  const c = [{ rel: 0, confirmed: false, flat: true, action: 'sit' }, { rel: 1, confirmed: true, flat: true, action: 'sit' }, { rel: 2, confirmed: true, flat: true, action: 'enter' }, { rel: 3, confirmed: true, flat: false, action: 'manage' }];
  const r = S.entryVsConfirmed(c);
  assert.strictEqual(r.firstConfirmed, 1);
  assert.strictEqual(r.entry, 2);
  assert.strictEqual(r.timing, 'after');
  assert.strictEqual(r.delta, 1);
  assert.strictEqual(r.sitOutsWhileConfirmed, 1);
  assert.strictEqual(r.inTrade, 1);
  assert.strictEqual(S.entryVsConfirmed([{ rel: 0, confirmed: false, flat: true, action: 'enter' }]).timing, 'never-confirmed');
  assert.strictEqual(S.entryVsConfirmed([{ rel: 0, confirmed: true, flat: true, action: 'enter' }]).timing, 'on');
  assert.strictEqual(S.entryVsConfirmed([{ rel: 0, confirmed: false, flat: true, action: 'enter' }, { rel: 1, confirmed: true, flat: true, action: 'sit' }]).timing, 'before');
  assert.strictEqual(S.entryVsConfirmed([{ rel: 0, confirmed: true, flat: true, action: 'sit' }]).timing, 'no-entry');
  assert.strictEqual(S.entryVsConfirmed([{ rel: 0, confirmed: true, flat: false, action: 'enter' }]).entry, null, 'an in-trade cycle is never an entry decision');
});

test('memorization control (item 11), pure part: which recorded cycles changed their word when dates are masked', () => {
  assert.deepStrictEqual(S.maskedChanged([{ id: 'a', word: 'chop' }, { id: 'b', word: 'trend-up' }, { id: 'c', word: 'chop' }], [{ id: 'a', word: 'chop' }, { id: 'b', word: 'chop' }]), { compared: 2, changed: ['b'] });
});
