'use strict';

// The recognition test's per-case analysis (scripts/lib/learning/recognition/analyse.js): the five measures for one case
// over its candles, and the summary over cases. Pure, on synthetic candles; a candle's trace is the shape trace.js gives.
const test = require('node:test');
const assert = require('node:assert');
const A = require('../../scripts/lib/learning/recognition/analyse');

const TF = 3 * 60000;
const S0 = Date.parse('2021-06-11T13:33:00.000Z');
const met = ids => ids.map(([id, field]) => ({ id, field }));
const key = (o = {}) => ({
  biasSide: 'long', cls: { long: 'C', short: 'B', none: 'A' },
  facts: { frames: { '4h': 'up', '1h': 'up', '15m': 'up' }, regime: 'trend-up', day: { word: 'mixed', dir: null }, declared: { long: true, short: false } },
  signals: { long: { c: [], t: ['T2', 'T3'], met: met([['T2', '15m'], ['T3', 'regime']]) }, short: { c: ['C9'], t: [], met: met([['C9', '15m']]) }, none: { c: [], t: [], met: [] } },
  ...o,
});
const sides = conf => ({
  long: { met: conf ? ['bias', 'location', 'setup', 'stop', 'target'] : ['bias'], reqMet: conf ? 5 : 1, reqTotal: 5, confirmed: conf, why: conf ? 'the standard plan passes' : 'blocked', declared: true },
  short: { met: [], reqMet: 0, reqTotal: 5, confirmed: false, why: 'the trend rule', declared: false },
});
const word = w => (w === undefined ? { status: 'absent', word: null } : w === null ? { status: 'unstated', word: null } : { status: 'stated', word: w });
const mk = (i, conf, o = {}) => ({
  ms: S0 + i * TF, trace: o.noBars ? null : { key: key(o.key), sides: sides(conf) },
  read: { kind: 'pass', side: null, word: word(o.word), basis: o.basis || { status: 'absent', cited: [], offList: [], dropped: 0 }, ...o.read },
});
const TREND = { id: '2021-06-11 trend long', kind: 'trend', side: 'long', pace: 'slow', margin: 5, startClose: S0 + TF, endClose: S0 + 4 * TF };
const CHOP = { id: '2021-08-03 chop', kind: 'chop', side: null, pace: null, margin: 10, startClose: S0, endClose: null };

test('trend leg, a run without the class word: rel from the setup start, the evidence and coded first candles, entry vs confirmed, in-trade apart; the model\'s measures need the class word', () => {
  const cs = [mk(0, false), mk(1, false), mk(2, true), mk(3, true, { read: { kind: 'entry', side: 'long' } }), mk(4, true, { read: { kind: 'in-trade' } }), mk(5, true, { noBars: true })];
  const r = A.analyse(TREND, cs, { minutes: 3 });
  assert.strictEqual(r.candles, 5);
  assert.strictEqual(r.noBars, 1);
  assert.strictEqual(r.firstEvidenceRel, -1);
  assert.strictEqual(r.firstCodedRel, -1);
  assert.strictEqual(r.entryVsConfirmed.firstConfirmed, 1);
  assert.strictEqual(r.entryVsConfirmed.entry, 2);
  assert.strictEqual(r.entryVsConfirmed.timing, 'after');
  assert.strictEqual(r.inTrade, 1);
  assert.strictEqual(r.entryConfluence.confirmed, true);
  assert.strictEqual(r.entryConfluence.declared, true);
  assert.strictEqual(r.entryConfluence.inLeg, true);
  assert.deepStrictEqual(r.wordCoverage, { stated: 0, unstated: 0, invalid: 0, absent: 5, of: 5, needsClassWord: true });
  assert.strictEqual(r.model, null, 'never filled in from the coded read');
  assert.strictEqual(r.miss, null);
  assert.strictEqual(r.evidenceThen.model, null);
  assert.strictEqual(r.evidenceThen.coded.rel, -1);
  assert.deepStrictEqual(r.evidenceThen.coded.signals, ['T2', 'T3']);
  assert.strictEqual(r.evidenceThen.coded.confluence.reqMet, 1);
  assert.strictEqual(r.evidenceInLeg.candles, 4, 'rel 0 to the leg end close');
  assert.strictEqual(r.evidenceInLeg.confirmedCandles, 3);
});

test('trend leg with class words: guess vs lag, evidence then at the model\'s first candle with its cites, a miss with what the evidence showed', () => {
  const early = { key: { cls: { long: 'B', short: 'B', none: 'A' } } };
  const basis = { status: 'stated', cited: ['regime', '4h-trend'], offList: ['the tape'], dropped: 0 };
  const r = A.analyse(TREND, [mk(0, false, { ...early, word: 'trend-up', basis }), mk(1, false, { word: 'unclear' }), mk(2, false, { word: null })], { minutes: 3 });
  assert.strictEqual(r.model.timing, 'guess');
  assert.strictEqual(r.firstEvidenceRel, 0, 'the evidence first supports the leg at rel 0');
  assert.strictEqual(r.evidenceThen.model.rel, -1);
  assert.deepStrictEqual(r.evidenceThen.model.basis, { status: 'stated', cited: ['regime', '4h-trend'], ignored: ['15m-trend'], citedWithoutSignal: ['4h-trend'], uncitable: [], offList: ['the tape'], dropped: 0 });
  assert.deepStrictEqual(r.wordCoverage, { stated: 2, unstated: 1, invalid: 0, absent: 0, of: 3, needsClassWord: false });
  assert.ok(r.miss, 'a guess never counts: the leg is a miss');
  assert.strictEqual(r.miss.evidence.candles, 2, 'rel 0 to the leg end');
  const named = A.analyse(TREND, [mk(0, false, { word: 'unclear' }), mk(1, false, { word: 'trend-up' })], { minutes: 3 });
  assert.strictEqual(named.model.timing, 'lag');
  assert.strictEqual(named.model.counts, true);
  assert.strictEqual(named.miss, null);
});

test('chop day: names chop? which candle; entries before the naming listed with their confluence; sit rate over flat cycles', () => {
  const chopKey = { biasSide: null, cls: { long: 'B', short: 'B', none: 'B' }, signals: { long: { c: ['C3'], t: [], met: met([['C3', 'regime']]) }, short: { c: ['C3'], t: [], met: met([['C3', 'regime']]) }, none: { c: ['C3'], t: [], met: met([['C3', 'regime']]) } } };
  const cs = [
    mk(0, true, { key: { ...chopKey, cls: { long: 'C', short: 'B', none: 'A' } }, word: 'trend-up', read: { kind: 'entry', side: 'short' } }),
    mk(1, false, { key: chopKey, word: 'chop' }),
    mk(2, false, { key: chopKey, word: 'chop', read: { kind: 'in-trade' } }),
    mk(3, false, { key: chopKey, word: 'chop', read: { kind: 'entry', side: null } }),
  ];
  const r = A.analyse(CHOP, cs, { minutes: 3 });
  assert.strictEqual(r.known, 'chop');
  assert.strictEqual(r.namesChop, true);
  assert.strictEqual(r.firstChopRel, 1);
  assert.strictEqual(r.entries.length, 2);
  assert.deepStrictEqual(r.entries.map(e => [e.rel, e.side, e.beforeNaming]), [[0, 'short', true], [3, null, false]]);
  assert.strictEqual(r.entries[0].presentClass, 'B');
  assert.strictEqual(r.entries[0].confluence.reqMet, 0);
  assert.strictEqual(r.entries[1].confluence, null, 'no side named and no bias side: no side to count confluence for');
  assert.strictEqual(r.entriesBeforeNaming, 1);
  assert.strictEqual(r.sitRate, 1 / 3);
  assert.strictEqual(r.falseAlarms.opposite, 1);
  assert.strictEqual(A.analyse(CHOP, [mk(0, false, { key: chopKey })], { minutes: 3 }).namesChop, null, 'no class word: unknown, never no');
  const onNaming = A.analyse(CHOP, [mk(0, false, { key: chopKey, word: 'unclear' }), mk(1, false, { key: chopKey, word: 'chop', read: { kind: 'entry', side: 'long' } })], { minutes: 3 });
  assert.deepStrictEqual(onNaming.entries.map(e => [e.rel, e.beforeNaming]), [[1, false]], 'an entry on the naming candle is not before it');
});

test('unstated candles stay unstated: the coded read never stands in for the model', () => {
  const r = A.analyse(TREND, [mk(0, false, { word: 'unclear' }), mk(1, false, { word: null }), mk(2, false, { word: null })], { minutes: 3 });
  assert.strictEqual(r.coded.first, -1, 'the coded read names the leg');
  assert.strictEqual(r.model.first, null);
  assert.strictEqual(r.model.timing, 'never');
  assert.strictEqual(r.accuracy.named, 1, 'only the stated word is a naming');
  assert.strictEqual(r.falseAlarms.named, 0);
});

test('summary: over the cases whose run carries the class word only; the others listed as needing it', () => {
  const withWord = A.analyse(TREND, [mk(0, true, { word: 'trend-up' })], { minutes: 3 });
  const without = A.analyse({ ...TREND, id: 'b' }, [mk(0, true)], { minutes: 3 });
  const s = A.summarize([withWord, without]);
  assert.strictEqual(s.scored.trend.n, 1);
  assert.deepStrictEqual(s.needsClassWord, ['b']);
  assert.strictEqual(A.summarize([without]).scored, null);
  assert.deepStrictEqual(s.entryVsConfirmed, { on: 0, before: 0, after: 0, 'no-entry': 2, 'never-confirmed': 0 });
});
