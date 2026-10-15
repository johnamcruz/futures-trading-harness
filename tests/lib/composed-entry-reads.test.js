'use strict';

// The entry-confirmation reads of the trade-lifecycle reads checker (scripts/lib/trading/composed-reads.js): a fair
// value gap's edges as key levels (a bounce is a rejection, a failure a break, as the gap stood at the candle's open),
// at a gap zone, the entry's confirming candle pattern, high volume and participation, and absorption at a level. Each
// read true, false, against the other side, and unchecked; the owner's entry (a 15m rejection of a key level, then a 3m
// confirming candle on volume) end to end; and the gap edges on briefings built from bars.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const CR = require('../../scripts/lib/trading/composed-reads');
const CF = require('../../scripts/lib/trading/candle-facts');
const F = require('../../scripts/lib/trading/fvg-frames');
const { buildBriefing } = require('../../scripts/lib/trading/briefing');
const { loadBars } = require('../../scripts/lib/backtest/data');
const { scenario1, SCENARIO_1 } = require('../fixtures/trade-lifecycle-scenario');

const clone = x => JSON.parse(JSON.stringify(x));
const one = (read, b) => CR.checkRead(CR.parseRead(read), b);

const MIN = 60000;
const T0 = Date.parse('2026-06-15T13:30:00Z'); // 09:30 ET

/** 3m bars making the given 15m candles (5 bars each): open on the first, high on the second, low on the third, close on the last. */
function barsOf(candles, per = 5, step = 3) {
  const out = [];
  candles.forEach(([o, h, l, c], k) => {
    for (let i = 0; i < per; i += 1) {
      const t = new Date(T0 + (k * per + i) * step * MIN).toISOString();
      const open = i === 0 ? o : (o + c) / 2;
      const close = i === per - 1 ? c : (o + c) / 2;
      out.push({ t, o: open, h: i === 1 ? h : Math.max(open, close), l: i === 2 ? l : Math.min(open, close), c: close, v: 100 });
    }
  });
  return out;
}

const FLAT = Array.from({ length: 20 }, () => [100, 101, 99, 100.5]);
// A bullish 15m gap 101-103 (fvg-frames.test.js): known when its third candle completes.
const GAP = [[100, 101, 99, 100.5], [100.5, 106.25, 100.25, 106], [106, 107, 103, 106.5]];

/** The 15m candle `last` after the gap, as the briefing reads it (the gaps' edges as of its open), in a minimal briefing. */
function afterGap(last) {
  const bars = barsOf([...FLAT, ...GAP, last]);
  const candles = CF.briefingCandles({ bars, base: 3, timeframes: [15], zonesAt: k => F.fvgEdgesAt({ bars, base: 3, frames: [15], at: k }) });
  return { bars, candle: candles['15m'], briefing: { minutes: 3, sections: { m3: { data: { price: last[3], candles: candles } } } } };
}

test('fvgEdges: an open gap\'s low and high, a partly filled one\'s unfilled part; nothing else', () => {
  const fvgs = {
    '5m': 'unavailable (not whole 3m bars; no 1m bars configured)',
    '15m': [{ side: 'bullish', low: 101, high: 103, state: 'open' }, { side: 'bearish', low: 110, high: 114, state: 'partly', unfilled: [111.5, 114] }],
    '1h': [{ side: 'bullish', low: 90, high: 92 }, { side: 'bullish', low: 90, high: 92, state: 'partly' }, null],
  };
  assert.deepStrictEqual(F.fvgEdges(fvgs), [
    ['15m fvg low', 101, 'bullish'], ['15m fvg high', 103, 'bullish'], ['15m fvg low', 111.5, 'bearish'], ['15m fvg high', 114, 'bearish'],
  ]);
  assert.deepStrictEqual(F.fvgEdges(null), []);
  assert.deepStrictEqual(F.fvgEdgesAt({ bars: [], base: 3, at: 0 }), []);
});

test('a bounce off a gap is a rejection of its edge, read on the completed candle against the gap as it stood at its open', () => {
  // Down into the gap to 100.75 (under its low 101) and closed back above at 104: rejected its low and its high, up.
  const { candle, briefing } = afterGap([106.5, 107, 100.75, 104]);
  assert.deepStrictEqual(candle.fvgRelations, [
    { name: '15m fvg low', price: 101, side: 'bullish', rel: 'rejected', dir: 'up' },
    { name: '15m fvg high', price: 103, side: 'bullish', rel: 'rejected', dir: 'up' },
  ]);
  // The gap edges are not key levels: the capped text and the relations are unchanged by them.
  assert.ok(!candle.relations.some(r => /fvg/.test(r.name)));
  assert.ok(!Object.keys(candle.levels).some(k => /fvg/.test(k)));
  const r = one('15m rejected 15m fvg low up', briefing);
  assert.deepStrictEqual([r.check, r.dir, r.field], [true, 'long', 'm3.candles.15m.fvgRelations']);
  assert.match(r.fact, /rejected up 15m fvg low 101/);
  assert.strictEqual(one('15m rejected 15m fvg high up', briefing).check, true);
  assert.strictEqual(one('15 min rejected 15m FVG low up', briefing).check, true, 'spelling is one form');
  // False: the other direction, a break, an edge of another timeframe's gaps (none met).
  assert.strictEqual(one('15m rejected 15m fvg low down', briefing).check, false);
  assert.strictEqual(one('15m broke 15m fvg low down', briefing).check, false);
  assert.strictEqual(one('15m rejected 1h fvg low up', briefing).check, false);
  // Unchecked: a briefing without the gap relations (an older file, or no gaps given), a candle not in it.
  const older = clone(briefing);
  delete older.sections.m3.data.candles['15m'].fvgRelations;
  assert.strictEqual(one('15m rejected 15m fvg low up', older).check, 'unchecked');
  assert.match(one('15m rejected 15m fvg low up', older).fact, /gap relations are not in the briefing/);
  assert.strictEqual(one('1h rejected 15m fvg low up', briefing).check, 'unchecked');
  // A non-gap level is still read from the key levels' relations, never from the gap ones.
  assert.strictEqual(CR.parseRead('15m rejected 15m fvg low up').level, '15m fvg low');
});

test('a failed gap is a break of its edge, never a bounce: the gap the candle fills is read as it stood at its open', () => {
  // Through the whole gap, closed at 97.5 with most of the body below it: broke its low (the far edge), down. The gap
  // is filled (gone from the gaps now), but the candle is read against the gap at its open. Through the near edge (the
  // high) is no failure: touched.
  const { bars, candle, briefing } = afterGap([104, 104.5, 97, 97.5]);
  assert.deepStrictEqual(F.fvgFrames({ bars, base: 3, frames: [15] })['15m'], []);
  assert.deepStrictEqual(candle.fvgRelations.map(r => [r.name, r.rel, r.dir]), [['15m fvg low', 'broke', 'down'], ['15m fvg high', 'touched', null]]);
  assert.strictEqual(one('15m rejected 15m fvg low up', briefing).check, false);
  assert.strictEqual(one('15m rejected 15m fvg high up', briefing).check, false);
  assert.strictEqual(one('15m broke 15m fvg high down', briefing).check, false);
  const broke = one('15m broke 15m fvg low down', briefing);
  assert.deepStrictEqual([broke.check, broke.dir], [true, 'short']);
  // As a long's setup it is refused: the bounce is false, the break is against the long.
  const reads = SCENARIO_1.map(x => (x.step === 'setup' ? { ...x, skill: 'fair-value-gaps', read: '15m rejected 15m fvg low up' } : x));
  const b = scenario1();
  b.sections.m3.data.candles['15m'].fvgRelations = candle.fvgRelations;
  const bounce = CR.checkReads({ reads, side: 'long', briefing: b });
  assert.strictEqual(bounce.ok, false);
  assert.strictEqual(bounce.reads.find(x => x.step === 'setup').check, false);
  const failed = CR.checkReads({ reads: reads.map(x => (x.step === 'setup' ? { ...x, read: '15m broke 15m fvg low down' } : x)), side: 'long', briefing: b });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.reads.find(x => x.step === 'setup').agrees, false);
});

test('a gap edge reads by the gap\'s side: a close inside a bullish gap is no break; only a close beyond its far edge is', () => {
  // Opened 104.5 above the bullish gap 101-103, closed 101.25 inside it (most of the body under its high): the gap
  // held so far, so it neither broke nor bounced; both edges are touched.
  const { candle, briefing } = afterGap([104.5, 105, 101, 101.25]);
  assert.deepStrictEqual(candle.fvgRelations.map(r => [r.name, r.rel, r.dir]), [['15m fvg low', 'touched', null], ['15m fvg high', 'touched', null]]);
  assert.strictEqual(one('15m broke 15m fvg high down', briefing).check, false);
  assert.strictEqual(one('15m touched 15m fvg high', briefing).check, true);
  // The rule itself, by side and edge.
  const R = (relation, dir) => ({ relation, dir });
  const g = CF.gapRelation;
  assert.deepStrictEqual(g(R('rejected', 'up'), '15m fvg low', 'bullish'), R('rejected', 'up'));
  assert.deepStrictEqual(g(R('rejected', 'up'), '15m fvg high', 'bullish'), R('rejected', 'up'));
  assert.deepStrictEqual(g(R('rejected', 'down'), '15m fvg high', 'bullish'), R('touched', null));
  assert.deepStrictEqual(g(R('broke', 'down'), '15m fvg low', 'bullish'), R('broke', 'down'));
  assert.deepStrictEqual(g(R('broke', 'down'), '15m fvg high', 'bullish'), R('touched', null), 'a close inside the gap');
  assert.deepStrictEqual(g(R('broke', 'up'), '15m fvg high', 'bullish'), R('touched', null));
  assert.deepStrictEqual(g(R('rejected', 'down'), '1h fvg high', 'bearish'), R('rejected', 'down'));
  assert.deepStrictEqual(g(R('rejected', 'up'), '1h fvg low', 'bearish'), R('touched', null));
  assert.deepStrictEqual(g(R('broke', 'up'), '1h fvg high', 'bearish'), R('broke', 'up'));
  assert.deepStrictEqual(g(R('broke', 'up'), '1h fvg low', 'bearish'), R('touched', null), 'a close inside the gap');
  assert.deepStrictEqual(g(R('broke', 'down'), '1h fvg low', 'bearish'), R('touched', null));
  assert.deepStrictEqual(g(R('rejected', 'up'), '15m fvg low', null), R('touched', null), 'a gap of unknown side');
  assert.deepStrictEqual(g(R('touched', null), '15m fvg low', 'bullish'), R('touched', null));
  assert.deepStrictEqual(g(R('none', null), '15m fvg low', 'bullish'), R('none', null));
  assert.strictEqual(g(null, '15m fvg low', 'bullish'), null);
});

test('a bearish gap mirrors it: rejected down is the hold, broke up through its high the failure', () => {
  // A bearish 15m gap 97-99 (fvg-frames.test.js), then up into it.
  const bear = [[100, 101, 99, 99.5], [99.5, 99.75, 93.75, 94], [94, 97, 93, 93.5]];
  const at = last => {
    const bars = barsOf([...FLAT, ...bear, last]);
    return CF.briefingCandles({ bars, base: 3, timeframes: [15], zonesAt: k => F.fvgEdgesAt({ bars, base: 3, frames: [15], at: k }) })['15m'].fvgRelations.map(r => [r.name, r.rel, r.dir]);
  };
  assert.deepStrictEqual(at([93.5, 99.25, 93, 96]), [['15m fvg low', 'rejected', 'down'], ['15m fvg high', 'rejected', 'down']]);
  assert.deepStrictEqual(at([96, 103, 95.5, 102.5]), [['15m fvg low', 'touched', null], ['15m fvg high', 'broke', 'up']]);
});

test('a gap is only a level for candles that opened after it was known: the candle that makes it has none', () => {
  // The gap's own third candle: the gap is known only at its close.
  const bars = barsOf([...FLAT, ...GAP]);
  const c = CF.briefingCandles({ bars, base: 3, timeframes: [15], zonesAt: k => F.fvgEdgesAt({ bars, base: 3, frames: [15], at: k }) })['15m'];
  assert.deepStrictEqual(c.fvgRelations, []);
  // Without zonesAt (the rules language, an older caller) there is no fvgRelations field at all.
  assert.ok(!('fvgRelations' in CF.briefingCandles({ bars, base: 3, timeframes: [15] })['15m']));
});

test('at <tf> fvg: the trigger bar overlaps an unfilled gap, or the base or next candle met it within one ATR(14) of price', () => {
  const b = scenario1();
  const m3 = b.sections.m3.data;
  // The trigger bar 21529.75-21541; a bullish 15m gap 21525-21531 (partly filled to 21527) overlaps it.
  m3.fvgs = { '5m': 'unavailable (not whole 3m bars; no 1m bars configured)', '15m': [{ side: 'bullish', low: 21520, high: 21531, state: 'partly', unfilled: [21520, 21527] }], '1h': [] };
  m3.atr14 = 10;
  assert.strictEqual(one('at 15m fvg', b).check, false, 'the unfilled part 21520-21527 is under the bar\'s low 21529.75 and 13.25 from price');
  m3.atr14 = 15;
  const near = one('at 15m fvg', b);
  assert.deepStrictEqual([near.check, near.dir], [true, null], 'the 15m candle (low 21512.75) met it, 13.25 from price, within one ATR(14) 15');
  assert.match(near.fact, /15m gap 21520-21527 was met by the 3m or 15m candle/);
  m3.fvgs['15m'][0].unfilled = [21520, 21530];
  assert.strictEqual(one('at 15m fvg', b).check, true, 'inside the trigger bar\'s range');
  assert.match(one('at 15m fvg', b).fact, /inside the bar's range/);
  // A gap far away, none left, unavailable, not in the briefing.
  m3.fvgs['15m'] = [{ side: 'bearish', low: 21600, high: 21610, state: 'open' }];
  assert.strictEqual(one('at 15m fvg', b).check, false);
  assert.strictEqual(one('at 1h fvg', b).check, false);
  assert.match(one('at 1h fvg', b).fact, /no unfilled 1h gap/);
  assert.strictEqual(one('at 5m fvg', b).check, 'unchecked');
  assert.strictEqual(one('at 4h fvg', b).check, 'unchecked');
  assert.strictEqual(one('at 15m fvg', scenario1()).check, 'unchecked', 'a briefing without the gaps');
  // A location read: the location step only, either side.
  for (const side of ['long', 'short']) {
    m3.fvgs['15m'] = [{ side: 'bullish', low: 21530, high: 21535, state: 'open' }];
    const r = CR.checkReads({ reads: SCENARIO_1.map(x => (x.step === 'location' ? { ...x, skill: 'fair-value-gaps', read: 'at 15m fvg' } : x)), side, briefing: b });
    assert.strictEqual(r.reads.find(x => x.step === 'location').agrees, true);
  }
  const misplaced = CR.checkReads({ reads: SCENARIO_1.concat({ step: 'setup', skill: 'fair-value-gaps', read: 'at 15m fvg' }), side: 'long', briefing: b });
  assert.ok(misplaced.problems.some(p => /at read belongs to the location step, not setup/.test(p)), misplaced.problems.join('; '));
});

test('the entry\'s confirming candle: hammer, shooting star, bullish or bearish engulfing, on its side, stated once', () => {
  const b = scenario1();
  b.sections.m3.data.candles['3m'].patterns = ['bullish engulfing', 'displacement'];
  const withEntry = (read, extra = []) => SCENARIO_1.filter(x => x.read !== '3m momentum up').concat({ step: 'entry', skill: 'candle-reading', read }, ...extra);
  const long = CR.checkReads({ reads: withEntry('3m pattern bullish engulfing'), side: 'long', briefing: b });
  assert.strictEqual(long.ok, true, CR.renderCheck(long));
  assert.strictEqual(long.reads.at(-1).dir, 'long');
  assert.match(long.signature, /entry:3m-pattern-bullish-engulfing/);
  // The other side: true, against the short.
  const short = CR.checkReads({ reads: withEntry('3m pattern bullish engulfing'), side: 'short', briefing: b });
  assert.strictEqual(short.reads.at(-1).check, true);
  assert.strictEqual(short.reads.at(-1).agrees, false);
  // False: the candle isn't one.
  assert.strictEqual(CR.checkReads({ reads: withEntry('3m pattern bearish engulfing'), side: 'long', briefing: b }).reads.at(-1).check, false);
  // A hammer confirms a long, a shooting star a short (in the entry step; the 15m candle is a hammer).
  const hammer = CR.checkReads({ reads: withEntry('15m pattern hammer'), side: 'long', briefing: b });
  assert.strictEqual(hammer.ok, true, CR.renderCheck(hammer));
  const hammerShort = CR.checkReads({ reads: withEntry('15m pattern hammer'), side: 'short', briefing: b });
  assert.strictEqual(hammerShort.reads.at(-1).agrees, false, 'a hammer is no short\'s confirmation');
  b.sections.m3.data.candles['15m'].pattern = 'shooting star';
  const star = CR.checkReads({ reads: withEntry('15m pattern shooting star'), side: 'long', briefing: b });
  assert.deepStrictEqual([star.reads.at(-1).check, star.reads.at(-1).dir, star.reads.at(-1).agrees], [true, 'short', false]);
  // Other patterns are setup reads only.
  const doji = CR.checkReads({ reads: withEntry('3m pattern displacement'), side: 'long', briefing: b });
  assert.ok(doji.problems.some(p => /an entry pattern is one of hammer, bullish engulfing, shooting star, bearish engulfing/.test(p)), doji.problems.join('; '));
  // The same pattern read in setup and entry counts once.
  const twice = CR.checkReads({ reads: withEntry('3m pattern bullish engulfing', [{ step: 'setup', skill: 'candle-reading', read: '3m pattern bullish engulfing' }]), side: 'long', briefing: b });
  assert.ok(twice.problems.some(p => /the same read twice/.test(p)), twice.problems.join('; '));
  // Unchecked: the candle's pattern unknown, the candle unavailable.
  delete b.sections.m3.data.candles['3m'].patterns;
  delete b.sections.m3.data.candles['3m'].pattern;
  assert.strictEqual(CR.checkReads({ reads: withEntry('3m pattern bullish engulfing'), side: 'long', briefing: b }).reads.at(-1).check, 'unchecked');
  assert.strictEqual(CR.checkReads({ reads: withEntry('5m pattern hammer'), side: 'long', briefing: b }).reads.at(-1).check, 'unchecked');
  // In the setup step a pattern still reads as before.
  assert.strictEqual(CR.STEP_KINDS.pattern.join(','), 'setup,entry');
});

test('volume high: the candle\'s volume at least 1.5 times its average; participation high: the last 3 bars against the 20 before', () => {
  const b = scenario1();
  const c3 = b.sections.m3.data.candles['3m'];
  assert.strictEqual(CR.VOLUME_HIGH, 1.5);
  const v = one('3m volume high', b);
  assert.deepStrictEqual([v.check, v.dir, v.field, v.value], [true, null, 'm3.candles.3m.volRatio', 1.6]);
  c3.volRatio = 1.5;
  assert.strictEqual(one('3m volume high', b).check, true, 'the threshold itself');
  c3.volRatio = 1.49;
  assert.strictEqual(one('3m volume high', b).check, false);
  assert.match(one('3m volume high', b).fact, /1\.49x its average \(high: >= 1\.5x\)/);
  c3.volRatio = null;
  assert.strictEqual(one('3m volume high', b).check, 'unchecked');
  assert.strictEqual(one('5m volume high', b).check, 'unchecked', 'the 5m candle is unavailable');
  assert.strictEqual(one('3m volume low', b).check, 'unchecked', 'not a form');
  // Participation.
  assert.strictEqual(one('participation high', b).check, 'unchecked', 'not in the briefing');
  b.sections.m3.data.participation = { relVolLast3VsPrior20: 1.7, relVolLastVsOpeningRange: 0.4 };
  assert.deepStrictEqual([one('participation high', b).check, one('participation high', b).dir], [true, null]);
  b.sections.m3.data.participation.relVolLast3VsPrior20 = 1.2;
  assert.strictEqual(one('participation high', b).check, false);
  b.sections.m3.data.participation.relVolLast3VsPrior20 = null;
  assert.strictEqual(one('participation high', b).check, 'unchecked');
  // Entry-step reads with no side: they agree with either; in another step they are refused.
  const b2 = scenario1();
  for (const side of ['long', 'short']) {
    const r = CR.checkReads({ reads: SCENARIO_1.concat({ step: 'entry', skill: 'momentum-and-volume', read: '3m volume high' }), side, briefing: b2 });
    assert.strictEqual(r.reads.at(-1).agrees, true);
  }
  const misplaced = CR.checkReads({ reads: SCENARIO_1.concat({ step: 'setup', skill: 'momentum-and-volume', read: '3m volume high' }), side: 'long', briefing: b2 });
  assert.ok(misplaced.problems.some(p => /a volume read belongs to the entry step, not setup/.test(p)), misplaced.problems.join('; '));
});

test('absorption at a level: met it without closing beyond, on high volume, with little net progress', () => {
  const b = scenario1();
  const c15 = b.sections.m3.data.candles['15m'];
  // The 15m candle 21536 / 21545 / 21512.75 / 21541 rejected the prior VAH up: net move 5 points, ATR(14) 32.25 / 1.1.
  c15.volRatio = 1.8;
  const a = one('15m absorption at prior VAH up', b);
  assert.deepStrictEqual([a.check, a.dir], [true, 'long']);
  assert.match(a.fact, /rejected up prior VAH, volume 1\.8x, net move 0\.17 ATR/);
  assert.strictEqual(CR.parseRead('15m absorption at prior VAH up').level, 'prior vah');
  // The other direction: false (a rejection up is no push up held at resistance), and against a short when true.
  assert.strictEqual(one('15m absorption at prior VAH down', b).check, false);
  const short = CR.checkReads({ reads: SCENARIO_1.concat({ step: 'entry', skill: 'absorption', read: '15m absorption at prior VAH up' }), side: 'short', briefing: b });
  assert.strictEqual(short.reads.at(-1).agrees, false);
  // Volume under 1.5x: no absorption.
  c15.volRatio = 1.2;
  assert.strictEqual(one('15m absorption at prior VAH up', b).check, false);
  c15.volRatio = 1.8;
  // Large progress (momentum, not absorption): the close far from the open.
  c15.o = 21514;
  assert.strictEqual(one('15m absorption at prior VAH up', b).check, false);
  assert.match(one('15m absorption at prior VAH up', b).fact, /net move 0\.92 ATR/);
  c15.o = 21536;
  // A level it broke (closed beyond): no absorption; a level it didn't meet: none.
  assert.strictEqual(one('15m absorption at VWAP rth up', b).check, false);
  assert.strictEqual(one('15m absorption at prior VAL up', b).check, false);
  // Touched and held: the open and close on the read's side of the level (the prior RTH high 21520 under both).
  assert.strictEqual(one('15m absorption at prior RTH high up', b).check, true);
  assert.strictEqual(one('15m absorption at prior RTH high down', b).check, false);
  // A gap edge: from the candle's gap relations.
  c15.fvgRelations = [{ name: '15m fvg low', price: 21515, side: 'bullish', rel: 'rejected', dir: 'up' }];
  assert.strictEqual(one('15m absorption at 15m fvg low up', b).check, true);
  // Unchecked: the volume or range unknown, the relations missing, the candle unavailable.
  c15.volRatio = null;
  assert.strictEqual(one('15m absorption at prior VAH up', b).check, 'unchecked');
  c15.volRatio = 1.8;
  delete c15.relations;
  assert.strictEqual(one('15m absorption at prior VAH up', b).check, 'unchecked');
  assert.strictEqual(one('5m absorption at prior VAH up', b).check, 'unchecked');
  // An entry (confirmation) read only.
  const misplaced = CR.checkReads({ reads: SCENARIO_1.concat({ step: 'setup', skill: 'absorption', read: '15m absorption at prior VAH up' }), side: 'long', briefing: scenario1() });
  assert.ok(misplaced.problems.some(p => /absorption read belongs to the entry step, not setup/.test(p)), misplaced.problems.join('; '));
});

test('the owner\'s entry: a 15m rejection of the prior VAH, then a 3m bullish engulfing on high volume, verifies', () => {
  const b = scenario1();
  Object.assign(b.sections.m3.data.candles['3m'], { pattern: 'bullish engulfing', patterns: ['bullish engulfing', 'displacement'], volRatio: 1.6 });
  const reads = [
    { step: 'bias', skill: 'bos-vs-choch', read: '1h bos up' },
    { step: 'location', skill: 'vwap-volume-profile', read: 'at prior VAH' },
    { step: 'setup', skill: 'rejection', read: '15m rejected prior VAH up' },
    { step: 'entry', skill: 'candle-reading', read: '3m pattern bullish engulfing' },
    { step: 'entry', skill: 'momentum-and-volume', read: '3m volume high' },
    { step: 'stop', skill: 'invalidation', read: 'stop 15m low 21512.75' },
    { step: 'target', skill: 'top-down-entry', read: 'target 1h swing 21598' },
  ];
  const r = CR.checkReads({ reads, side: 'long', briefing: b });
  assert.strictEqual(r.ok, true, CR.renderCheck(r));
  assert.strictEqual(r.signature, 'bias:1h-bos-up+location:at-prior-vah+setup:15m-rejected-prior-vah-up+entry:3m-pattern-bullish-engulfing+entry:3m-volume-high+stop:15m-low+target:1h-swing-1.5-2.5r');
  // Without the volume (under 1.5x) or with a bearish candle it does not stand.
  b.sections.m3.data.candles['3m'].volRatio = 1.1;
  assert.strictEqual(CR.checkReads({ reads, side: 'long', briefing: b }).ok, false);
  assert.strictEqual(CR.checkReads({ reads, side: 'short', briefing: scenario1() }).ok, false);
});

test('regime names with a hyphen read as the briefing writes them; negations are still refused', () => {
  const b = scenario1();
  b.sections.m3.data.regime.primary = 'trend-up';
  assert.strictEqual(CR.parseRead('regime trend-up').kind, 'regime');
  assert.strictEqual(CR.parseRead('regime trend-up').form, 'regime trend up');
  assert.strictEqual(one('regime trend-up', b).check, true);
  assert.strictEqual(one('regime trend up', b).check, true, 'one form');
  assert.strictEqual(one('regime trend-down', b).check, false);
  assert.strictEqual(one('regime range', b).check, false);
  b.sections.m3.data.regime.primary = 'range';
  assert.strictEqual(one('regime range', b).check, true);
  assert.strictEqual(one('regime not trend-up', b).check, false, 'a negation is refused');
  assert.strictEqual(CR.parseRead('regime is a strong trend-up').kind, 'unknown');
});

const fixtureBars = () => loadBars(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv')).map(({ ms, ...b }) => b); // eslint-disable-line no-unused-vars
const briefingAt = (bars, i) => clone(buildBriefing({ symbol: 'MNQ', bars: bars.slice(0, i + 1), minutes: 3, scan: [], now: new Date(Date.parse(bars[i].t) + 180000) }));

test('on briefings built from the fixture bars: every gap-edge relation verifies, its mirror is refused, the rendered text is unchanged', () => {
  const bars = fixtureBars();
  let checked = 0;
  for (const i of [600, 773, 900, 1200, bars.length - 1]) {
    const b = briefingAt(bars, i);
    for (const [tf, c] of Object.entries(b.sections.m3.data.candles)) {
      if (c.unavailable) continue;
      assert.ok(Array.isArray(c.fvgRelations), `${i} ${tf}: the gap relations are in the briefing`);
      for (const r of c.fvgRelations) {
        assert.match(r.name, /^(5m|15m|1h) fvg (low|high)$/);
        const read = r.rel === 'touched' ? `${tf} touched ${r.name}` : `${tf} ${r.rel} ${r.name} ${r.dir}`;
        assert.strictEqual(one(read, b).check, true, `${i} ${read}`);
        if (r.dir) {
          const named = c.fvgRelations.filter(x => x.name === r.name);
          const mirror = `${tf} ${r.rel} ${r.name} ${r.dir === 'up' ? 'down' : 'up'}`;
          // Refused unless another gap of that name met the candle the mirror way.
          if (!named.some(x => x.rel === r.rel && x.dir !== r.dir)) assert.strictEqual(one(mirror, b).check, false, `${i} ${mirror}`);
        }
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 20, `checked ${checked} gap relations`);
  // Bar 773: the 15m candle bounced off the 15m gap below (rejected its low 27140.75 up); the 1h rejected a 15m gap
  // above from below (its low 27260, down).
  const b = briefingAt(bars, 773);
  assert.strictEqual(one('15m rejected 15m fvg low up', b).check, true);
  assert.strictEqual(one('15m broke 15m fvg low down', b).check, false);
  assert.strictEqual(one('1h rejected 15m fvg low down', b).check, true);
  // Never rendered: the briefing's text names no gap relation.
  assert.ok(!/fvgRelations/.test(require('../../scripts/lib/trading/briefing').renderBriefing(b)));
});
