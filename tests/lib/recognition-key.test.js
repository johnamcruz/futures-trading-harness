'use strict';

// The recognition test's present key (scripts/lib/learning/recognition/key.js): the facts of one candle's briefing, the
// chop-class signals per side, the evidence word (the reference for guess and lag) and the coded read (the briefing's
// labels restated). Pure, on synthetic facts and a synthetic briefing; the real briefing is in recognition-trace.test.js.
const test = require('node:test');
const assert = require('node:assert');
const K = require('../../scripts/lib/learning/recognition/key');

const TH = { crossesChop: 5, crossesTrendMax: 3, maxPullbackDepth: 0.62 };
const f = o => ({
  frames: { '4h': 'up', '1h': 'up', '15m': 'up' }, regime: 'trend-up', sessionCrosses: 1, vwapSide: 'above', dayType: null, openVs: null,
  windowEntries: 'allowed', bias: 'Bias: long only (4h up, 1h up; short refused).', biasSides: { long: true, short: false },
  declared: { long: true, short: false }, day: { word: 'directional', dir: 'up' }, bothWays: { '15m': false, '3m': false }, pullback: false, rthCrosses: null, ...o,
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
  const chop = K.signals(f({ frames: { '4h': 'up', '1h': 'up', '15m': 'range' }, regime: 'range', sessionCrosses: 6, bias: 'Bias: no side yet (15m range)', day: { word: 'rotational', dir: null }, bothWays: { '15m': true, '3m': true } }), 'long', TH);
  assert.deepStrictEqual(chop.c, ['C1', 'C2', 'C3', 'C4', 'C7']);
  assert.strictEqual(K.classOf(chop), 'B');
  assert.deepStrictEqual(chop.t, ['T5'], 'declared long still holds');
  assert.deepStrictEqual(chop.met.map(m => m.field), ['day-so-far', '15m-break', '3m-break', 'bias', 'vwap', 'declared']);
});

test('signals: chop is the quality of movement, range its geometry: a 15m range or a 3m range regime alone is no chop signal; C2 and C3 are the breaks both ways (last and previous both CHoCH)', () => {
  const geometry = K.signals(f({ frames: { '4h': 'up', '1h': 'up', '15m': 'range' }, regime: 'range' }), 'long', TH);
  assert.deepStrictEqual(geometry.c, [], 'a range rotating cleanly is not chop');
  assert.ok(!geometry.t.includes('T2') && !geometry.t.includes('T3'), 'nor a trend signal');
  const choppy = K.signals(f({ bothWays: { '15m': true, '3m': false } }), 'long', TH);
  assert.deepStrictEqual(choppy.met.filter(m => m.id === 'C2').map(m => m.field), ['15m-break'], 'C2: the 15m breaks both ways, with no range needed');
  assert.ok(!choppy.c.includes('C3'));
  const choppy3 = K.signals(f({ bothWays: { '15m': false, '3m': true } }), 'short', TH);
  assert.deepStrictEqual(choppy3.met.filter(m => m.id === 'C3').map(m => m.field), ['3m-break']);
  assert.ok(!K.signals(f({ bothWays: { '15m': null, '3m': null } }), 'long', TH).c.length, 'unknown breaks are no signal');
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

// The coded read and choppy come from the briefing's Market state (market-state.js readState, one definition; its own
// unit tests cover every precedence case): here, on briefings, the key carries it.
const kb = ({ h4 = 'up', h1 = 'up', lastBreak, soFar, pullback, layers } = {}) => K.presentKey({ sections: {
  h1: { data: { h4: { trend: h4 }, h1: { trend: h1 } } },
  m3: { data: { ...(lastBreak ? { lastBreak } : {}), ...(pullback ? { pullback } : {}), ...(layers ? { layers } : {}), vwap: { sessionCrossesLast30: 9, side: 'above' }, ...(soFar ? { today: { soFar } } : {}) } },
} }, TH);
// Round 20: chop is the briefing's layers' (m3.layers, market-layers.js: structural AND behavioral evidence); a record
// without them (every record before round 20) reads the printed breaks alone and is never choppy.
const CHOP_LAYERS = { rthBars: 20, structure: { side: 'up', level: 21480, status: 'intact', legOK: false, sinceProgress: 12, lastWay: null, lastInternal: null, flip: null },
  momentum: { trigger: false }, behavior: { word: 'failing', word15: 'overlapping', overlap: 0.74, eff: 0.09 },
  chop: { now: true, inChop: true, S: true, B: true, facts: { ov: true, ef: true, fl: true, nd: false }, count: 3, evidence: { bothWays: true, flip: false, failed: true } }, transition: false, stale: false, pbRotation: false };
const PAIR = { last: { kind: 'CHoCH', direction: 'up' }, previous: { kind: 'CHoCH', direction: 'down' } };
const rot = n => ({ status: 'read', read: 'rotational', vwapCrosses: n });
const mix = n => ({ status: 'read', read: 'mixed', vwapCrosses: n });
// Round 20 (the owner: "Don't classify a market as chop simply because you see two opposing CHoCHs"): choppy is the
// layers' chop; the CHoCH pair alone, rotational or not, is never chop; inside an open Pullback never chop.
test('choppy: the layers\' chop, never the CHoCH pair alone; rotational and the crosses never conditions; never inside an open Pullback', () => {
  assert.strictEqual(kb({ lastBreak: PAIR, soFar: rot(1) }).choppy, false, 'the pair alone, no layers');
  assert.strictEqual(kb({ lastBreak: PAIR, soFar: mix(4) }).choppy, false);
  assert.strictEqual(kb({ layers: CHOP_LAYERS }).choppy, true, 'the layers\' chop');
  assert.strictEqual(kb({ soFar: rot(9) }).choppy, false, 'rotational and crosses without the breaks');
  const PB = { frame: '15m', side: 'long', leg: { origin: 21462.5, extreme: 21538.75 }, depth: 0.38, pastOrigin: false, counter: { bars: 10 }, swing: {}, against: {} };
  assert.strictEqual(kb({ layers: CHOP_LAYERS, soFar: rot(9), pullback: PB }).choppy, false, 'inside an open Pullback: never chop');
});

test('codedWord: the Market state\'s class word: choppy -> chop (aligned too); else the 4h and 1h side (both one way, or one trending and the other ranging) -> trend; else unclear; a range alone never chop', () => {
  assert.strictEqual(K.codedWord(kb({})), 'trend-up');
  assert.strictEqual(K.codedWord(kb({ layers: CHOP_LAYERS, soFar: rot(1) })), 'chop', 'aligned but choppy: chop');
  assert.strictEqual(K.codedWord(kb({ lastBreak: PAIR, soFar: rot(1) })), 'trend-up', 'the pair alone (no layers): no chop');
  assert.strictEqual(K.codedWord(kb({ soFar: rot(1) })), 'trend-up', 'rotational alone is one fact');
  assert.strictEqual(K.codedWord(kb({ h4: 'down', h1: 'down' })), 'trend-down');
  assert.strictEqual(K.codedWord(kb({ h4: 'range' })), 'trend-up', 'range is geometry, not chop; the 1h up sets the side (the entry rule\'s, read audit F1)');
  assert.strictEqual(K.codedWord(kb({ h4: 'down' })), 'unclear', 'the 4h against the 1h: no side');
  assert.strictEqual(K.codedWord(kb({ h4: 'range', layers: CHOP_LAYERS, soFar: rot(1) })), 'chop');
  assert.strictEqual(K.codedWord(kb({ h4: 'range', h1: 'range' })), 'unclear', 'agreeing range is no trend');
});

test('presentKey carries choppy from the Market state (the crosses threshold only a printed context)', () => {
  const b = { sections: { h1: { data: { h4: { trend: 'up' }, h1: { trend: 'up' } } }, m3: { data: { lastBreak: { last: { kind: 'CHoCH', direction: 'up' }, previous: { kind: 'CHoCH', direction: 'down' } }, vwap: { sessionCrossesLast30: 1, side: 'above' }, today: { soFar: { status: 'read', read: 'mixed', direction: 'up', vwapCrosses: 6 } } } } } };
  assert.strictEqual(K.presentKey(b, TH).choppy, false, 'a record without layers: the pair alone is no chop (round 20)');
  b.sections.m3.data.layers = CHOP_LAYERS;
  assert.strictEqual(K.presentKey(b, TH).choppy, true);
  assert.strictEqual(K.codedWord(K.presentKey(b, TH)), 'chop');
  assert.strictEqual(K.presentKey(b, { ...TH, crossesChop: 7 }).choppy, true, 'the threshold decides nothing');
});

// Fable round 1's reproduction: an aligned pullback whose 3m CHoCH down then CHoCH up (the watch) prints on a rotational
// day must not read chop in any of the three words: C3, choppy (the coded read) and the evidence word.
test('the taught guardrail: an open Pullback line\'s 3m CHoCH pair is neither C3 nor choppy; the coded read and the evidence word do not call chop there', () => {
  const PB = { frame: '15m', side: 'long', leg: { origin: 21462.5, extreme: 21538.75 }, depth: 0.38, pastOrigin: false, counter: { bars: 10, volRatio: 0.6, volume: 'falling', rangeRatio: 0.5 }, swing: { '15m': { price: 21462.5, holds: true }, '1h': { price: 21390.25, holds: true } }, against: { '15m': null, '1h': null } };
  const brief = pullback => ({ sections: {
    h1: { data: { h4: { trend: 'up' }, h1: { trend: 'up' } } }, m15: { data: { frame: { trend: 'range' } } },
    m3: { data: { pullback, lastBreak: { last: { kind: 'CHoCH', direction: 'up' }, previous: { kind: 'CHoCH', direction: 'down' } }, regime: { primary: 'transition' }, vwap: { sessionCrossesLast30: 2, side: 'above' }, today: { soFar: { status: 'read', read: 'rotational', direction: 'up', vwapCrosses: 2 } } } },
  } });
  const k = K.presentKey(brief(PB), TH);
  assert.strictEqual(k.facts.pullback, true);
  assert.strictEqual(k.choppy, false);
  assert.strictEqual(K.codedWord(k), 'trend-up');
  for (const s of ['long', 'short', 'none']) assert.ok(!k.signals[s].c.includes('C3'), s);
  assert.notStrictEqual(K.evidenceWord(k), 'chop');
  // The same candle with no Pullback line printed: C3 (the frozen evidence signal) met; choppy only with the layers'
  // chop (round 20: the pair alone is no chop), and then chop.
  const n = K.presentKey(brief(null), TH);
  assert.strictEqual(n.facts.pullback, false);
  assert.strictEqual(n.choppy, false);
  assert.ok(n.signals.long.c.includes('C3'));
  const withLayers = pullback => { const x = brief(pullback); x.sections.m3.data.layers = CHOP_LAYERS; return K.presentKey(x, TH); };
  assert.deepStrictEqual([withLayers(null).choppy, K.codedWord(withLayers(null))], [true, 'chop']);
  assert.deepStrictEqual([withLayers(PB).choppy, K.codedWord(withLayers(PB))], [false, 'trend-up'], 'the guardrail holds with the layers too');
  // A pullback object the briefing does not print (no leg) is no open Pullback line.
  assert.strictEqual(K.presentKey(brief({ frame: '15m' }), TH).facts.pullback, false);
  // Given back past its printed origin (step 8: no with-side read on that leg): not open; the pair counts again.
  const back = K.presentKey(brief({ ...PB, depth: 1.1, pastOrigin: true }), TH);
  assert.strictEqual(back.facts.pullback, false);
  // An older record without pastOrigin: its depth decides (pullback-read.js givenBack).
  assert.strictEqual(K.presentKey(brief({ ...PB, depth: 1.1, pastOrigin: undefined }), TH).facts.pullback, false);
  assert.strictEqual(K.presentKey(brief({ ...PB, depth: 0.5, pastOrigin: undefined }), TH).facts.pullback, true);
  assert.strictEqual(back.choppy, false, 'no layers: no chop');
  assert.ok(back.signals.long.c.includes('C3'));
});

// Fable round 2's shape, pinned as documented (coordinator, as a quant): the evidence word stays an independent bars-only
// read, never the lesson, so inside an open Pullback C1 (rotational) and C7 (session crosses 6) still read chop there,
// while the coded read (the rules restated) follows the taught guardrail: trend-up. The limit stays visible.
test('evidenceWord stays independent of the taught guardrail: inside an open Pullback C1 + C7 read chop; the coded read reads the trend', () => {
  const PB = { frame: '15m', side: 'long', leg: { origin: 21462.5, extreme: 21538.75 }, depth: 0.38, pastOrigin: false, counter: { bars: 10, volRatio: 0.6, volume: 'falling', rangeRatio: 0.5 }, swing: { '15m': { price: 21462.5, holds: true }, '1h': { price: 21390.25, holds: true } }, against: { '15m': null, '1h': null } };
  const brief = pullback => ({ sections: {
    h1: { data: { h4: { trend: 'up' }, h1: { trend: 'up' } } }, m15: { data: { frame: { trend: 'down' } } },
    m3: { data: { pullback, lastBreak: { last: { kind: 'CHoCH', direction: 'down' }, previous: { kind: 'BOS', direction: 'up' } }, regime: { primary: 'trend-down' }, vwap: { sessionCrossesLast30: 6, side: 'below' }, today: { soFar: { status: 'read', read: 'rotational', direction: 'up', vwapCrosses: 6 } } } },
  } });
  const open = K.presentKey(brief(PB), TH);
  assert.deepStrictEqual(open.signals.long.c.filter(x => ['C1', 'C7'].includes(x)), ['C1', 'C7'], 'the frozen signals still met');
  assert.strictEqual(open.cls[open.biasSide || 'none'] === 'B' || open.cls.none === 'B', true, 'a chop class');
  assert.strictEqual(open.facts.pullback, true);
  assert.strictEqual(K.evidenceWord(open), 'chop', 'the evidence word is not the lesson');
  assert.strictEqual(K.codedWord(open), 'trend-up', 'the coded read follows the rules: not choppy (no CHoCH pair), aligned');
  assert.strictEqual(K.evidenceWord(K.presentKey(brief(null), TH)), 'chop', 'the same with no Pullback line');
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
  assert.deepStrictEqual(x.bothWays, { '15m': null, '3m': null }, 'no lastBreak printed: unknown');
  assert.strictEqual(x.pullback, false);
  assert.strictEqual(x.rthCrosses, null, 'no RTH count printed');
  assert.strictEqual(K.facts({ sections: { m3: { data: { today: { soFar: { status: 'too early', vwapCrosses: 3 } } } } } }).rthCrosses, 3, 'the Day so far line prints its RTH crosses early too');
  const br = (k1, d1, k2, d2) => ({ last: { kind: k1, direction: d1 }, previous: k2 ? { kind: k2, direction: d2 } : null });
  const y = K.facts({ sections: { m15: { data: { lastBreak: br('CHoCH', 'up', 'CHoCH', 'down') } }, m3: { data: { lastBreak: br('CHoCH', 'down', 'BOS', 'up') } } } });
  assert.deepStrictEqual(y.bothWays, { '15m': true, '3m': false }, 'one CHoCH (last and previous opposite) is not both ways; two CHoCHs are');
  assert.strictEqual(K.facts({ sections: { m3: { data: { lastBreak: br('CHoCH', 'down', null) } } } }).bothWays['3m'], false, 'no previous: not both ways');
  assert.strictEqual(K.facts({ sections: { m3: { data: { lastBreak: { last: null, previous: null } } } } }).bothWays['3m'], false, 'no break yet: not both ways');
  assert.strictEqual(K.facts({ sections: { m3: { data: { today: { soFar: { status: 'too early' } } } } } }).day.word, 'too early');
  assert.strictEqual(K.facts({ sections: {} }).day.word, 'unknown');
});

// The Market state redesign (MARKET-STATE-SPEC, PREREG addendum 14): the coded read IS the briefing's Market state
// (market-state.js), one definition: on every briefing of a grid, codedWord equals classWordOf(stateOf) and the key's
// choppy equals the state chop.
const MS = require('../../scripts/lib/trading/market-state');
const GRID = (() => {
  const out = [];
  const PBL = { frame: '15m', side: 'long', leg: { origin: 21462.5, extreme: 21538.75 }, depth: 0.38, pastOrigin: false, counter: { bars: 10 }, swing: {}, against: {} };
  const pbs = [undefined, null, PBL, { ...PBL, pastOrigin: true }, { ...PBL, side: 'short', leg: { origin: 21538.75, extreme: 21462.5 } }];
  const lbs = [undefined, { last: { kind: 'CHoCH', direction: 'up' }, previous: { kind: 'CHoCH', direction: 'down' } }, { last: { kind: 'CHoCH', direction: 'up' }, previous: { kind: 'BOS', direction: 'down' } }, { last: { kind: 'BOS', direction: 'up' }, previous: { kind: 'BOS', direction: 'up' } }, { last: { kind: 'BOS', direction: 'down' }, previous: { kind: 'CHoCH', direction: 'down' } }];
  const days = [undefined, { status: 'read', read: 'rotational', vwapCrosses: 2 }, { status: 'read', read: 'mixed', vwapCrosses: 5 }, { status: 'read', read: 'mixed', vwapCrosses: 4 }, { status: 'too early', vwapCrosses: 6 }];
  for (const h4 of ['up', 'down', 'range', undefined]) for (const h1 of ['up', 'down', 'range']) for (const pullback of pbs) for (const lastBreak of lbs) for (const soFar of days) {
    out.push({ minutes: 3, sections: { h1: { data: { ...(h4 ? { h4: { trend: h4 } } : {}), h1: { trend: h1 } } }, m3: { data: { ...(pullback === undefined ? {} : { pullback }), ...(lastBreak ? { lastBreak } : {}), ...(soFar ? { today: { soFar } } : {}), vwap: { sessionCrossesLast30: 1, side: 'above' } } } } });
  }
  return out;
})();

test('the coded read is the Market state: codedWord = classWordOf(stateOf) and choppy = the chop state, on every briefing of the grid', () => {
  assert.ok(GRID.length >= 1500, `${GRID.length} briefings`);
  for (const b of GRID) {
    const k = K.presentKey(b, TH);
    const s = MS.stateOf(b, TH);
    assert.strictEqual(K.codedWord(k), MS.classWordOf(s), JSON.stringify(b));
    assert.strictEqual(k.choppy, s.state === 'chop', JSON.stringify(b));
  }
});

// What the redesigns change in the coded read on records without layers (the grid: no 15m trend, no close time): the old
// read (chop = the CHoCH pair with the day so far rotational or the RTH crosses at crossesChop and no open Pullback line;
// else the 4h and 1h agreeing -> the trend; else unclear) and round 20's differ exactly in: (a) the old read's chop (the
// pair alone is no chop now, the owner); (b) the 4h and 1h agreeing, the 3m's last break a BOS against them (a 3m leg
// against), no pullback their way: old trend, new unclear; (c) an open pullback against the 4h + 1h with the 3m's last
// break a BOS their way: old trend (the 3m BOS decided), new unclear (the pullback's leg is against them).
test('the old and the new coded read differ only on (a) the old chop (no chop without layers), (b) a 3m BOS against an aligned 4h + 1h, (c) a pullback against them, (d) one of the 4h and 1h ranging, the other trending (read audit F1)', () => {
  const old = b => {
    const f = K.facts(b);
    const ch = f.bothWays['3m'] === true && !f.pullback && (f.day.word === 'rotational' || (Number.isFinite(f.rthCrosses) && f.rthCrosses >= TH.crossesChop));
    const fr = f.frames;
    return ch ? 'chop' : fr['4h'] === fr['1h'] && (fr['4h'] === 'up' || fr['4h'] === 'down') ? `trend-${fr['4h']}` : 'unclear';
  };
  const diff = GRID.filter(b => old(b) !== K.codedWord(K.presentKey(b, TH)));
  const n = { a: 0, b: 0, c: 0, d: 0 };
  for (const b of diff) {
    const d = b.sections.h1.data;
    const way = d.h4 && d.h4.trend;
    const lb = b.sections.m3.data.lastBreak;
    const p = b.sections.m3.data.pullback;
    const pbWay = p && p.pastOrigin === false ? { long: 'up', short: 'down' }[p.side] : null;
    const now = K.codedWord(K.presentKey(b, TH));
    assert.notStrictEqual(now, 'chop', 'never chop without layers');
    if (old(b) === 'chop') { n.a += 1; continue; }
    // (d): the old read unclear (not both one way), the new the side of the one trending, the other ranging.
    const t = [way, d.h1 && d.h1.trend];
    const half = t.includes('range') && t.some(x => x === 'up' || x === 'down') && t.every(x => ['up', 'down', 'range'].includes(x));
    if (half && old(b) === 'unclear' && now === `trend-${t.find(x => x !== 'range')}`) { n.d += 1; continue; }
    assert.strictEqual(now, 'unclear', JSON.stringify(b));
    if (pbWay && pbWay !== way) { n.c += 1; continue; }
    assert.ok(way === d.h1.trend && lb && lb.last.kind === 'BOS' && lb.last.direction !== way && pbWay !== way, JSON.stringify(b));
    n.b += 1;
  }
  assert.ok(n.a > 0 && n.b > 0 && n.c > 0 && n.d > 0, JSON.stringify(n));
});
