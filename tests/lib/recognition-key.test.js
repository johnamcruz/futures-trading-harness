'use strict';

// The recognition test's present key (scripts/lib/learning/recognition/key.js): the facts of one candle's briefing, the
// chop-class signals per side, the evidence word (the reference for guess and lag) and the coded read (the briefing's
// labels restated). Pure, on synthetic facts and a synthetic briefing; the real briefing is in recognition-trace.test.js.
const test = require('node:test');
const assert = require('node:assert');
const K = require('../../scripts/lib/learning/recognition/key');

const TH = { crossesChop: 5, crossesTrendMax: 3 };
const f = o => ({
  frames: { '4h': 'up', '1h': 'up', '15m': 'up' }, regime: 'trend-up', sessionCrosses: 1, vwapSide: 'above', dayType: null, openVs: null,
  windowEntries: 'allowed', bias: 'Bias: long only (4h up, 1h up; short refused).', biasSides: { long: true, short: false },
  declared: { long: true, short: false }, day: { word: 'directional', dir: 'up' }, ...o,
});
const ids = s => [s.c, s.t];

test('classOf: A none, C trend only, B chop outnumbers trend, D both with trend >= chop', () => {
  assert.strictEqual(K.classOf({ c: [], t: [] }), 'A');
  assert.strictEqual(K.classOf({ c: [], t: ['T2'] }), 'C');
  assert.strictEqual(K.classOf({ c: ['C1', 'C2'], t: ['T2'] }), 'B');
  assert.strictEqual(K.classOf({ c: ['C1'], t: ['T2'] }), 'D');
  assert.strictEqual(K.classOf({ c: ['C1'], t: [] }), 'B');
});

test('signals: trend with the side, chop against it; each met signal names the briefing field it reads', () => {
  const s = K.signals(f({}), 'long', TH);
  assert.deepStrictEqual(ids(s), [[], ['T1', 'T2', 'T3', 'T6', 'T5']]);
  assert.deepStrictEqual(s.met.map(m => m.field), ['day-so-far', '15m', 'regime', 'vwap', 'declared']);
  const chop = K.signals(f({ frames: { '4h': 'up', '1h': 'up', '15m': 'range' }, regime: 'range', sessionCrosses: 6, bias: 'Bias: no side yet (15m range)', day: { word: 'rotational', dir: null } }), 'long', TH);
  assert.deepStrictEqual(chop.c, ['C1', 'C2', 'C3', 'C4', 'C7']);
  assert.strictEqual(K.classOf(chop), 'B');
  assert.deepStrictEqual(chop.t, ['T5'], 'declared long still holds');
  assert.deepStrictEqual(chop.met.map(m => m.field), ['day-so-far', '15m', 'regime', 'bias', 'vwap', 'declared']);
});

test('signals: the frozen edges (crosses thresholds, transition, C9 once, the bias line, the IB day)', () => {
  assert.ok(!K.signals(f({ regime: 'transition' }), 'long', TH).c.includes('C3'), 'transition is no chop signal');
  assert.ok(K.signals(f({ sessionCrosses: 5 }), 'long', TH).c.includes('C7'), 'at the chop threshold');
  assert.ok(!K.signals(f({ sessionCrosses: 4 }), 'long', TH).c.includes('C7'));
  assert.ok(!K.signals(f({ sessionCrosses: 4 }), 'long', TH).t.includes('T6'), 'between the thresholds: neither');
  assert.ok(K.signals(f({ sessionCrosses: 3 }), 'long', TH).t.includes('T6'));
  assert.ok(!K.signals(f({ sessionCrosses: 1, vwapSide: 'below' }), 'long', TH).t.includes('T6'), 'T6 needs price on the side\'s side of VWAP');
  const c9 = K.signals(f({ frames: { '4h': 'up', '1h': 'up', '15m': 'down' }, regime: 'trend-down' }), 'long', TH);
  assert.deepStrictEqual(c9.c, ['C9'], 'C9 once: the 15m against, the regime against adds none');
  assert.deepStrictEqual(c9.met.filter(m => m.id === 'C9').map(m => m.field), ['15m']);
  assert.deepStrictEqual(K.signals(f({ regime: 'trend-down', frames: { '4h': 'up', '1h': 'up', '15m': 'up' } }), 'long', TH).met.filter(m => m.id === 'C9').map(m => m.field), ['regime']);
  assert.ok(!K.signals(f({ bias: 'Bias: neutral → 15m up + declared long → long only' }), 'long', TH).c.includes('C4'), 'the side the neutral path allows');
  assert.ok(K.signals(f({ bias: 'Bias: neutral → 15m up + declared long → long only' }), 'short', TH).c.includes('C4'));
  assert.ok(!K.signals(f({ bias: null }), 'long', TH).c.includes('C4'));
  assert.ok(K.signals(f({ dayType: 'inside the initial balance', openVs: 'inside the prior value area' }), 'long', TH).c.includes('C8'));
  assert.ok(K.signals(f({ dayType: 'trend up' }), 'long', TH).t.includes('T7'));
  assert.ok(!K.signals(f({ declared: { long: null, short: false } }), 'long', TH).t.includes('T5'), 'declared unknown is no signal');
});

const key = o => ({ biasSide: 'long', cls: { long: 'C', short: 'B', none: 'A' }, facts: f({ day: { word: 'mixed', dir: null } }), ...o });
test('evidenceWord: the bias side\'s class C trend, B chop, A or D unclear; no bias side: the side-free signals B chop, else unclear', () => {
  assert.strictEqual(K.evidenceWord(key({})), 'trend-up');
  assert.strictEqual(K.evidenceWord(key({ biasSide: 'short', cls: { long: 'C', short: 'C', none: 'A' } })), 'trend-down');
  assert.strictEqual(K.evidenceWord(key({ biasSide: 'short' })), 'chop');
  assert.strictEqual(K.evidenceWord(key({ cls: { long: 'D', short: 'B', none: 'A' } })), 'unclear');
  assert.strictEqual(K.evidenceWord(key({ cls: { long: 'A', short: 'B', none: 'A' } })), 'unclear');
  assert.strictEqual(K.evidenceWord(key({ biasSide: null, cls: { long: 'C', short: 'C', none: 'B' } })), 'chop');
  assert.strictEqual(K.evidenceWord(key({ biasSide: null, cls: { long: 'C', short: 'C', none: 'A' } })), 'unclear');
});

test('codedWord: rotational chop; 4h and 1h agreeing trend; 15m and 3m both range chop; else unclear', () => {
  const k = (frames, regime, word = 'mixed') => key({ facts: f({ frames, regime, day: { word, dir: null } }) });
  assert.strictEqual(K.codedWord(k({ '4h': 'up', '1h': 'up', '15m': 'up' }, 'trend-up')), 'trend-up');
  assert.strictEqual(K.codedWord(k({ '4h': 'up', '1h': 'up', '15m': 'up' }, 'trend-up', 'rotational')), 'chop', 'rotational first');
  assert.strictEqual(K.codedWord(k({ '4h': 'down', '1h': 'down', '15m': 'up' }, 'x')), 'trend-down');
  assert.strictEqual(K.codedWord(k({ '4h': 'range', '1h': 'up', '15m': 'range' }, 'range')), 'chop');
  assert.strictEqual(K.codedWord(k({ '4h': 'range', '1h': 'up', '15m': 'up' }, 'x')), 'unclear');
  assert.strictEqual(K.codedWord(k({ '4h': 'range', '1h': 'range', '15m': 'up' }, 'x')), 'unclear', 'agreeing range is no trend');
});

test('metFields: the fields of the signals met for a side; the side-free ones with no side', () => {
  const pk = { signals: { long: K.signals(f({}), 'long', TH), short: K.signals(f({}), 'short', TH), none: { c: [], t: [], met: [{ id: 'C7', field: 'vwap' }] } } };
  assert.deepStrictEqual(K.metFields(pk, 'long'), ['day-so-far', '15m', 'regime', 'vwap', 'declared']);
  assert.deepStrictEqual(K.metFields(pk, null), ['vwap']);
});

test('facts read the briefing\'s own fields (a synthetic briefing): frames, regime, VWAP, day so far, IB day, entries window', () => {
  const b = { minutes: 3, sections: {
    h1: { data: { h4: { trend: 'down' }, h1: { trend: 'down' } } }, m15: { data: { frame: { trend: 'range' } } },
    m3: { data: { regime: { primary: 'range' }, vwap: { sessionCrossesLast30: 7, side: 'below' }, today: { dayType: 'trend down', openVs: 'below the prior value area', soFar: { status: 'read', read: 'rotational', direction: 'down' } }, windowEntries: 'allowed' } },
  } };
  const x = K.facts(b);
  assert.deepStrictEqual(x.frames, { '4h': 'down', '1h': 'down', '15m': 'range' });
  assert.strictEqual(x.regime, 'range');
  assert.strictEqual(x.sessionCrosses, 7);
  assert.strictEqual(x.vwapSide, 'below');
  assert.strictEqual(x.dayType, 'trend down');
  assert.deepStrictEqual(x.day, { word: 'rotational', dir: 'down' });
  assert.strictEqual(K.facts({ sections: { m3: { data: { today: { soFar: { status: 'too early' } } } } } }).day.word, 'too early');
  assert.strictEqual(K.facts({ sections: {} }).day.word, 'unknown');
});
