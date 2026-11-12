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

// The class-word record as feat/class-word's state-read.js parseStateLine writes it (its output copied, not rebuilt):
// cites is always a list; citesStated says whether the model wrote cites at all (absent), only `none`, or names.
const REC = {
  noCites: { classWord: 'trend-down', classStatus: 'stated', cites: [], citesStated: 'absent', citesDropped: 0 }, // STATE: 4h up | 1h up | 15m up | class trend-down
  none: { classWord: 'chop', classStatus: 'stated', cites: [], citesStated: 'none', citesDropped: 0 }, // ... | class chop | cites none
  names: { classWord: 'chop', classStatus: 'stated', cites: ['regime'], citesStated: 'names', citesDropped: 1 }, // ... | class chop | cites regime, vwap
};

test('cites from the real record: citesStated by equality (absent -> unstated, none -> stated empty, names -> the list); never "every met field ignored" when none were written', () => {
  assert.deepStrictEqual(S.citesOf(REC.noCites), { status: 'unstated', cited: [], offList: [], dropped: 0 });
  assert.strictEqual(S.citedVsIgnored(S.citesOf(REC.noCites), ['regime', '15m']).ignored, null, 'no cites written: nothing ignored, unknown');
  assert.deepStrictEqual(S.citesOf(REC.none), { status: 'stated', cited: [], offList: [], dropped: 0 });
  assert.deepStrictEqual(S.citedVsIgnored(S.citesOf(REC.none), ['regime', '15m']).ignored, ['regime', '15m-trend'], '`cites none` is a statement: the met fields were ignored');
  assert.deepStrictEqual(S.citesOf(REC.names), { status: 'stated', cited: ['regime'], offList: [], dropped: 1 });
});

test('cites: absent and invalid records; the closed list by equality, an off-list name counted apart, never matched loosely', () => {
  assert.deepStrictEqual(S.citesOf(null), { status: 'absent', cited: [], offList: [], dropped: 0 });
  assert.deepStrictEqual(S.citesOf({ classWord: 'chop' }), { status: 'absent', cited: [], offList: [], dropped: 0 }, 'a record without citesStated predates the field');
  assert.deepStrictEqual(S.citesOf({ cites: ['regime'] }), { status: 'absent', cited: [], offList: [], dropped: 0 }, 'cites without citesStated: not read');
  assert.deepStrictEqual(S.citesOf({ cites: [], citesStated: 'nothing' }), { status: 'invalid', cited: [], offList: [], dropped: 0 });
  assert.deepStrictEqual(S.citesOf({ cites: 'regime', citesStated: 'names' }), { status: 'invalid', cited: [], offList: [], dropped: 0 });
  assert.deepStrictEqual(S.citesOf({ cites: ['regime', '15m-trend', 'regime', 'Regime', 'the regime', 7], citesStated: 'names' }), { status: 'stated', cited: ['regime', '15m-trend'], offList: ['Regime', 'the regime', '7'], dropped: 0 });
  assert.deepStrictEqual(S.citesOf({ cites: ['REGIME', ' regime', '15m trend'], citesStated: 'names' }), { status: 'stated', cited: [], offList: ['REGIME', ' regime', '15m trend'], dropped: 0 }, 'no case folding, no trimming, no respelling');
});

test('the cite names are the STATE record\'s closed list (state-read.js CITES once the class word is on the record)', () => {
  assert.deepStrictEqual([...S.CITE_FIELDS], ['4h-trend', '1h-trend', '15m-trend', 'trend-rule', 'regime', 'day-type', 'day-so-far', 'pullback', '1h-break', '15m-break', '3m-break']);
  const SR = require('../../scripts/lib/trading/state-read');
  if (SR.CITES) assert.deepStrictEqual(Object.keys(SR.CITES), [...S.CITE_FIELDS], 'the record and the scorer name the same cites');
  for (const v of Object.values(S.CITE_OF)) assert.ok(v === null || S.CITE_FIELDS.includes(v), v);
});

test('cited vs ignored: ignored = citable fields with a met signal not cited; uncitable met fields and cites without a signal apart', () => {
  const r = S.citedVsIgnored({ status: 'stated', cited: ['regime', '4h-trend'], offList: [], dropped: 1 }, ['regime', 'vwap', 'day-so-far', '15m', 'bias', 'declared']);
  assert.deepStrictEqual(r, { status: 'stated', cited: ['regime', '4h-trend'], ignored: ['day-so-far', '15m-trend', 'trend-rule'], citedWithoutSignal: ['4h-trend'], uncitable: ['vwap', 'declared'], offList: [], dropped: 1 });
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

test('SUPPLEMENTARY: the first naming at or after the evidence candle (a word named early and held is a guess, yet named from the evidence candle on)', () => {
  const held = S.recognise(cs([[0, 'unclear', 'x', 'trend-up'], [1, 'unclear', 'x', 'trend-up'], [2, 'trend-up', 'x', 'trend-up'], [3, 'trend-up', 'x', 'trend-up']]), KNOWN, MARGIN);
  assert.strictEqual(held.model.timing, 'guess', 'the frozen measure is unchanged');
  assert.strictEqual(held.model.counts, false);
  assert.deepStrictEqual(held.model.fromEvidence, { first: 2, delay: 0, counts: true });
  const late = S.recognise(cs([[0, 'trend-up', 'x', 'unclear'], [5, 'trend-up', 'x', 'trend-up']]), KNOWN, MARGIN);
  assert.deepStrictEqual(late.model.fromEvidence, { first: 5, delay: 5, counts: false });
  assert.deepStrictEqual(S.recognise(cs([[0, 'unclear', 'x', 'trend-up']]), KNOWN, MARGIN).model.fromEvidence, { first: null, delay: null, counts: false }, 'no evidence candle: none');
  assert.deepStrictEqual(S.recognise(cs([[0, 'trend-up', 'trend-up', null]]), KNOWN, MARGIN).coded.fromEvidence, { first: 0, delay: 0, counts: true }, 'the coded read by the same rule');
});

test('Wilson intervals (spec item 7) at the frozen level: the prop stats\' own', () => {
  assert.deepStrictEqual(S.interval(3, 5, 0.95), require('../../scripts/lib/prop/stats').wilson(3, 5, 0.95));
  assert.strictEqual(S.interval(0, 0, 0.95).lo, null, 'no denominator: no interval');
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
  cases[2].inLeg = cases[2].candles.slice(1); // the leg window: the chop named at rel 0 sits before it
  cases[0].inLeg = cases[0].candles;
  const s = S.summary(cases, { level: 0.95 });
  const W = require('../../scripts/lib/prop/stats').wilson;
  assert.deepStrictEqual(s.trend.recallInterval, W(1, 2, 0.95));
  assert.deepStrictEqual(s.trend.precisionInterval, W(3, 4, 0.95));
  assert.deepStrictEqual(s.trend.falseAlarmInterval, W(1, 4, 0.95));
  assert.deepStrictEqual(s.chop.recallInterval, W(1, 1, 0.95));
  assert.strictEqual(s.trend.supplementary.recalledFromEvidence, 1, 'supplementary: named from the evidence candle within the margin');
  assert.strictEqual(s.trend.supplementary.falseAlarmRateInLeg, 0, 'supplementary: inside the leg windows, the chop before the late leg is not counted');
  assert.deepStrictEqual(s.trend.supplementary.falseAlarmInLegInterval, W(0, 3, 0.95));
  assert.strictEqual(s.chop.supplementary.falseAlarmRateInLeg, null, 'no leg window on a chop day');
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
