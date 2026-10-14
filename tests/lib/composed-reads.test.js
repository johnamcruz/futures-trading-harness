'use strict';

// The trade-lifecycle reads checker (scripts/lib/trading/composed-reads.js): the model's reads parsed into closed forms
// and checked against the bar briefing, side agreement, the uncapped candle relations, and the canonical signatures.
// The owner's scenario 1 (the trade-lifecycle design) on a briefing shaped as buildBriefing writes it, then on
// briefings built from the parity fixture bars.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const CR = require('../../scripts/lib/trading/composed-reads');
const { buildBriefing } = require('../../scripts/lib/trading/briefing');
const { loadBars } = require('../../scripts/lib/backtest/data');

const clone = x => JSON.parse(JSON.stringify(x));

/**
 * Scenario 1 (MNQ, 3m bars): the 60m broke up (BOS) and price holds above the prior RTH high; the 15m candle traded
 * below the prior VAH 21530.13 and closed back above it; the 3m candle closed at its high with momentum; the 15m low
 * 21512.75 is the invalidation; the next 60m swing above is 21598.00. Entry reference 21540.25.
 */
function scenario1() {
  const relations15 = [
    { name: 'prior VAH', price: 21530.13, rel: 'rejected', dir: 'up' },
    { name: 'prior RTH high', price: 21520, rel: 'touched', dir: null },
    { name: 'VWAP (rth)', price: 21525.4, rel: 'broke', dir: 'up' },
    { name: 'previous 15m low', price: 21515, rel: 'touched', dir: null },
    { name: 'IB high', price: 21533, rel: 'touched', dir: null },
    // Past the four the text keeps: still verifiable.
    { name: '1h swing low 21514.5', price: 21514.5, rel: 'rejected', dir: 'up' },
  ];
  return {
    symbol: 'MNQ', minutes: 3, asOf: '2026-04-23T14:57:00.000Z', closedAt: '2026-04-23T15:00:00.000Z', price: 21540.25,
    keyLevels: [['prior VAH', 21530.13, 21530.25], ['prior RTH high', 21520], ['VWAP (rth)', 21525.4], ['IB high', 21533]],
    sections: {
      m3: {
        validUntil: '2026-04-23T15:03:00.000Z',
        data: {
          price: 21540.25,
          bar: { t: '2026-04-23T14:57:00.000Z', o: 21530.5, h: 21541, l: 21529.75, c: 21540.25, v: 900, rangeAtr: 1.3 },
          window: 'opening drive',
          regime: { primary: 'trend', volatility: 'normal' },
          vwap: { applies: 'rth', side: 'above' },
          location: { priorValue: 'above', priorRthRange: 'above', initialBalance: 'above' },
          trendRule: 'Trend rule: prevailing trend 1h up; trend strategies may not go short.',
          today: { dayType: 'trend day' },
          swings: { high: 21545, low: 21512.75 },
          liquidity: { swingHighs: [{ price: 21545, t: 'x' }], swingLows: [{ price: 21512.75, t: 'y' }], equalHighs: [], equalLows: [] },
          htfLevels: [{ name: '15m swing low', type: 'low', price: 21512.75, brokenAt: null }],
          lastBreak: { last: { kind: 'BOS', direction: 'up', level: 21535 }, previous: null },
          sweeps: [{ name: 'prior RTH high', price: 21520, side: 'high', key: true }],
          cisd: { '3m': 'none in these bars', '15m': { dir: 'bullish', level: 21520, status: 'touched', priceInOte: false }, '5m': 'unavailable (not whole 3m bars; no 1m bars configured)' },
          candles: {
            '3m': { t: '2026-04-23T14:57:00.000Z', o: 21530.5, h: 21541, l: 21529.75, c: 21540.25, closeLocation: 'top', rangeAtr: 1.3, volRatio: 1.6, pattern: 'displacement', dir: 'up', levels: {}, relations: [{ name: 'prior VAH', price: 21530.13, rel: 'broke', dir: 'up' }] },
            '5m': { unavailable: 'not whole 3m bars; no 1m bars configured' },
            '15m': { t: '2026-04-23T14:45:00.000Z', o: 21536, h: 21545, l: 21512.75, c: 21541, closeLocation: 'top', rangeAtr: 1.1, volRatio: 1.2, pattern: 'hammer',
              levels: { 'prior VAH': 'rejected: closed back above', 'VWAP (rth)': 'broke above', 'prior RTH high': 'touched', 'IB high': 'touched' }, moreLevels: 2, relations: relations15 },
            '1h': { t: '2026-04-23T14:00:00.000Z', o: 21500, h: 21545, l: 21490, c: 21541, closeLocation: 'top', rangeAtr: 1.4, volRatio: 1.1, pattern: 'none', levels: {}, relations: [] },
          },
          swingTargets: { above: [{ frame: '15m', price: 21560, R: 0.7 }, { frame: '1h', price: 21598, R: 2.1 }], below: [{ frame: '1h', price: 21480 }] },
        },
      },
      m15: { data: { frame: { trend: 'up' }, alignment: { long: 'aligned', short: 'counter' }, lastBreak: { last: { kind: 'BOS', direction: 'up', level: 21530 } } } },
      h1: { data: { h1: { trend: 'up' }, h4: { trend: 'range' }, lastBreak: { last: { kind: 'BOS', direction: 'up', level: 21500 }, previous: null } } },
      day: { data: { priorRth: { high: 21520, low: 21400 }, priorProfile: { vah: 21530.25, val: 21450, poc: 21480 } } },
    },
  };
}

const SCENARIO_1 = [
  { step: 'bias', skill: 'bos-vs-choch', read: '1h bos up', why: '60m broke the last swing high: buyers in control' },
  { step: 'bias', skill: 'daily-bias', read: 'above prior RTH range', why: 'holding above the prior day high' },
  { step: 'location', skill: 'vwap-volume-profile', read: 'at prior VAH', why: 'back at the prior value high' },
  { step: 'setup', skill: 'rejection', read: '15m rejected prior VAH up', why: 'the 15m dipped under it and closed back above' },
  { step: 'entry', skill: 'candle-reading', read: '3m close top', why: 'closed at its high' },
  { step: 'entry', skill: 'momentum-and-volume', read: '3m momentum up', why: 'a full-range bar on volume' },
  { step: 'stop', skill: 'invalidation', read: 'stop 15m low 21512.75', why: 'below the rejection low it is wrong' },
  { step: 'target', skill: 'top-down-entry', read: 'target 60m swing 21598.00', why: 'the next 60m swing high' },
];
const SKILLS = ['bos-vs-choch', 'daily-bias', 'vwap-volume-profile', 'rejection', 'candle-reading', 'momentum-and-volume', 'invalidation', 'top-down-entry', 'cisd'];

test('scenario 1: every read verifies and agrees with the long; the signatures are canonical', () => {
  const r = CR.checkReads({ reads: SCENARIO_1, side: 'long', briefing: scenario1(), skills: SKILLS });
  assert.deepStrictEqual(r.problems, []);
  for (const x of r.reads) assert.strictEqual(x.check, true, `${x.read}: ${x.fact}`);
  assert.ok(r.reads.every(x => x.agrees));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reference, 21540.25);
  assert.deepStrictEqual(r.stop, { source: '15m-low', level: 21512.75 });
  assert.deepStrictEqual(r.target, { source: '1h-swing', level: 21598 });
  // 27.50 points of risk, 57.75 of reward: 2.1R, the 1.5-2.5R bucket.
  assert.strictEqual(CR.targetROf(21540.25, 21512.75, 21598), 2.1);
  assert.strictEqual(r.signature, 'bias:1h-bos-up+bias:above-prior-rth-range+location:at-prior-vah+setup:15m-rejected-prior-vah-up+entry:3m-close-top+entry:3m-momentum-up+stop:15m-low+target:1h-swing-1.5-2.5r');
  assert.strictEqual(r.skillSignature, 'bias:bos-vs-choch,daily-bias+location:vwap-volume-profile+setup:rejection+entry:candle-reading,momentum-and-volume+stop:invalidation+target:top-down-entry');
  assert.deepStrictEqual(r.context, { regime: 'trend', volatility: 'normal', window: 'opening drive', trendSide: 'with', alignment: 'aligned', dayType: 'trend day' });
  // Each read keeps the model's why and the field it was checked against.
  assert.strictEqual(r.reads[0].why, '60m broke the last swing high: buyers in control');
  assert.strictEqual(r.reads[0].field, 'h1.lastBreak.last');
  assert.match(CR.renderCheck(r), /Every read is true and agrees with the long/);
});

test('the signature is the same whatever order the reads come in', () => {
  const a = CR.checkReads({ reads: SCENARIO_1, side: 'long', briefing: scenario1() });
  const b = CR.checkReads({ reads: [...SCENARIO_1].reverse(), side: 'long', briefing: scenario1() });
  assert.strictEqual(a.signature, b.signature);
  assert.strictEqual(a.skillSignature, b.skillSignature);
  // Spelling differences are one form: "60 min" is 1h, 21598.00 is 21598.
  assert.strictEqual(CR.parseRead('target 60 min swing 21598.00').form, 'target 1h swing 21598');
});

test('the same reads for a short are refused: every directional read and the stop and target are against it', () => {
  const r = CR.checkReads({ reads: SCENARIO_1, side: 'short', briefing: scenario1() });
  assert.strictEqual(r.ok, false);
  const against = r.reads.filter(x => x.check === true && !x.agrees).map(x => x.read);
  assert.deepStrictEqual(against, ['1h bos up', 'above prior RTH range', '15m rejected prior VAH up', '3m close top', '3m momentum up', 'stop 15m low 21512.75', 'target 60m swing 21598.00']);
  assert.match(CR.renderCheck(r), /AGAINST the short/);
});

test('false reads are refused, naming what the briefing says', () => {
  const b = scenario1();
  const one = read => CR.checkRead(CR.parseRead(read), b);
  assert.strictEqual(one('1h bos down').check, false);
  assert.strictEqual(one('1h choch up').check, false, 'a BOS is not a CHoCH');
  assert.strictEqual(one('15m rejected prior VAH down').check, false);
  assert.strictEqual(one('15m broke prior VAH up').check, false);
  assert.strictEqual(one('15m rejected prior VAL up').check, false, 'the candle did not meet the VAL');
  assert.strictEqual(one('below prior RTH range').check, false);
  assert.strictEqual(one('3m close middle').check, false);
  assert.strictEqual(one('vwap below').check, false);
  assert.strictEqual(one('swept overnight high').check, false);
  assert.strictEqual(one('15m cisd down').check, false);
  assert.strictEqual(one('3m cisd up').check, false, 'no 3m CISD in these bars');
  assert.strictEqual(one('in ote').check, false);
  assert.strictEqual(one('stop 15m low 21510.00').check, false, 'more than a tick from the 15m low');
  assert.strictEqual(one('stop 15m low 21513.00').check, true, 'within one tick: the briefing\'s price stands');
  assert.strictEqual(one('stop 15m low 21513.00').price, 21512.75);
  assert.strictEqual(one('target 1h swing 21560').check, false, 'the 15m swing, not the 1h');
  assert.match(one('1h bos down').fact, /BOS up through 21500/);
  // A false read refuses the combination.
  const reads = SCENARIO_1.map(x => (x.step === 'setup' ? { ...x, read: '15m rejected prior VAH down' } : x));
  const r = CR.checkReads({ reads, side: 'long', briefing: b });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reads.find(x => x.step === 'setup').check, false);
});

test('momentum is D4\'s bar read: range at least 1 ATR, volume at least its average, the close in the far third', () => {
  const b = scenario1();
  const m = () => CR.checkRead(CR.parseRead('3m momentum up'), b);
  assert.strictEqual(m().check, true);
  b.sections.m3.data.candles['3m'].rangeAtr = 0.9;
  assert.strictEqual(m().check, false);
  b.sections.m3.data.candles['3m'].rangeAtr = 1.3;
  b.sections.m3.data.candles['3m'].volRatio = 0.8;
  assert.strictEqual(m().check, false);
  b.sections.m3.data.candles['3m'].volRatio = null;
  assert.strictEqual(m().check, 'unchecked');
  assert.strictEqual(CR.checkRead(CR.parseRead('3m momentum down'), scenario1()).check, false);
});

test('a true read the other way refuses the combination; a higher-timeframe CHoCH the order\'s way allows a counter-trend read (D2)', () => {
  const b = scenario1();
  b.sections.h1.data.h4.trend = 'down';
  const counter = SCENARIO_1.concat({ step: 'bias', skill: 'multi-timeframe-analysis', read: '4h down' });
  const r = CR.checkReads({ reads: counter, side: 'long', briefing: b });
  assert.strictEqual(r.reads.at(-1).check, true);
  assert.strictEqual(r.reads.at(-1).agrees, false);
  assert.strictEqual(r.ok, false);
  b.sections.m15.data.lastBreak.last = { kind: 'CHoCH', direction: 'up', level: 21530 };
  const withChoch = counter.concat({ step: 'bias', skill: 'bos-vs-choch', read: '15m choch up' });
  const r2 = CR.checkReads({ reads: withChoch, side: 'long', briefing: b });
  assert.strictEqual(r2.ok, true, CR.renderCheck(r2));
  assert.strictEqual(r2.reads.find(x => x.read === '4h down').reversal, true);
  // A break against the side on the CHoCH's own timeframe or above is not excused.
  b.sections.h1.data.lastBreak.last = { kind: 'BOS', direction: 'down', level: 21500 };
  const r4 = CR.checkReads({ reads: withChoch.map(x => (x.read === '1h bos up' ? { ...x, read: '1h bos down' } : x)), side: 'long', briefing: b });
  assert.strictEqual(r4.reads.find(x => x.read === '1h bos down').check, true);
  assert.strictEqual(r4.ok, false);
  b.sections.h1.data.lastBreak.last = { kind: 'BOS', direction: 'up', level: 21500 };
  // The reversal never excuses a setup, an entry, a stop or a target the other way.
  const bad = withChoch.map(x => (x.step === 'entry' && x.skill === 'candle-reading' ? { ...x, read: '3m close bottom' } : x));
  b.sections.m3.data.candles['3m'].closeLocation = 'bottom';
  b.sections.m3.data.candles['3m'].volRatio = 0.5;
  const r3 = CR.checkReads({ reads: bad.filter(x => x.read !== '3m momentum up'), side: 'long', briefing: b });
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(r3.reads.find(x => x.read === '3m close bottom').agrees, false);
});

test('every candle relation is checked, past the four the briefing text shows', () => {
  const b = scenario1();
  assert.strictEqual(Object.keys(b.sections.m3.data.candles['15m'].levels).length, 4);
  const p = CR.parseRead('15m rejected 1h swing low 21514.50 up');
  assert.strictEqual(p.level, '1h swing low 21514.5');
  assert.strictEqual(CR.checkRead(p, b).check, true);
  // Matched by exact name, never against the text: "1h swing low" alone names no level.
  assert.strictEqual(CR.checkRead(CR.parseRead('15m rejected 1h swing low up'), b).check, false);
  // A briefing without the structured relations (an older file) can't verify one.
  delete b.sections.m3.data.candles['15m'].relations;
  assert.strictEqual(CR.checkRead(CR.parseRead('15m rejected prior VAH up'), b).check, 'unchecked');
});

test('unknown, ambiguous and not-yet-supported forms are never verified', () => {
  const b = scenario1();
  const one = read => CR.checkRead(CR.parseRead(read), b).check;
  assert.strictEqual(one('looks bullish'), 'unchecked');
  assert.strictEqual(one('not below prior RTH range'), false);
  assert.strictEqual(one('at prior VAH (21530)'), false);
  assert.strictEqual(one('at prior VAH​'), false);
  // Facts not in the briefing yet (4h candles, per-timeframe FVGs, 5m structure): unchecked.
  assert.strictEqual(one('4h rejected prior 4h low up'), 'unchecked');
  assert.strictEqual(one('5m fvg retest up'), 'unchecked');
  assert.strictEqual(one('5m bos up'), 'unchecked');
  assert.strictEqual(one('5m close top'), 'unchecked', 'the 5m candle is unavailable');
  assert.strictEqual(one('at prior 4h high'), 'unchecked', 'a level the briefing does not name');
  assert.strictEqual(one('stop somewhere 21500'), 'unchecked');
  // No briefing: nothing verifies.
  for (const x of SCENARIO_1) assert.strictEqual(CR.checkRead(CR.parseRead(x.read), null).check, 'unchecked');
  const r = CR.checkReads({ reads: SCENARIO_1.concat({ step: 'setup', skill: 'cisd', read: '5m fvg retest up' }), side: 'long', briefing: b });
  assert.strictEqual(r.ok, false);
});

test('the combination needs every step, one stop and one target, known skills and forms in their steps', () => {
  const b = scenario1();
  const without = CR.checkReads({ reads: SCENARIO_1.filter(x => x.step !== 'location'), side: 'long', briefing: b });
  assert.strictEqual(without.ok, false);
  assert.deepStrictEqual(without.missingSteps, ['location']);
  const two = CR.checkReads({ reads: SCENARIO_1.concat({ step: 'stop', skill: 'invalidation', read: 'stop swing low 21512.75' }), side: 'long', briefing: b });
  assert.strictEqual(two.ok, false);
  assert.ok(two.problems.some(p => /2 stop reads/.test(p)));
  const unknownSkill = CR.checkReads({ reads: SCENARIO_1.map((x, i) => (i === 0 ? { ...x, skill: 'astrology' } : x)), side: 'long', briefing: b, skills: SKILLS });
  assert.strictEqual(unknownSkill.ok, false);
  assert.ok(unknownSkill.problems.some(p => /no skill named astrology/.test(p)));
  const misplaced = CR.checkReads({ reads: SCENARIO_1.map(x => (x.step === 'bias' && x.skill === 'daily-bias' ? { ...x, read: 'stop 15m low 21512.75' } : x)), side: 'long', briefing: b });
  assert.strictEqual(misplaced.ok, false);
  assert.strictEqual(CR.checkReads({ reads: SCENARIO_1, side: 'flat', briefing: b }).ok, false);
  assert.strictEqual(CR.checkReads({ reads: [], side: 'long', briefing: b }).ok, false);
  assert.strictEqual(CR.checkReads({ reads: 'all good', side: 'long', briefing: b }).ok, false);
  assert.strictEqual(CR.checkReads({ reads: Array(CR.MAX_READS + 1).fill(SCENARIO_1[0]).concat(SCENARIO_1), side: 'long', briefing: b }).ok, false);
  // A why longer than the cap is cut, never refused (code never checks it).
  const long = CR.checkReads({ reads: SCENARIO_1.map((x, i) => (i === 0 ? { ...x, why: 'x'.repeat(400) } : x)), side: 'long', briefing: b });
  assert.strictEqual(long.ok, true);
  assert.strictEqual(long.reads[0].why.length, CR.WHY_MAX);
});

test('stops and targets: the source\'s level within one tick, on the side\'s losing and winning sides', () => {
  const b = scenario1();
  const one = read => CR.checkRead(CR.parseRead(read), b, { tick: 0.25 });
  assert.deepStrictEqual([one('stop swing low 21512.75').check, one('stop swing low 21512.75').dir], [true, 'long']);
  assert.strictEqual(one('stop 15m swing low 21512.75').check, true);
  assert.strictEqual(one('stop prior RTH high 21520').check, true);
  assert.strictEqual(one('stop 15m high 21545').dir, 'short');
  assert.strictEqual(one('target 1h swing high 21598').check, true);
  assert.strictEqual(one('target 1h swing 21480').dir, 'short');
  // A long with its stop above price disagrees.
  const reads = SCENARIO_1.map(x => (x.step === 'stop' ? { ...x, read: 'stop 15m high 21545' } : x));
  const r = CR.checkReads({ reads, side: 'long', briefing: b });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reads.find(x => x.step === 'stop').agrees, false);
});

test('rBucket and readSignature with a stated R', () => {
  assert.strictEqual(CR.rBucket(1.49), 'under-1.5r');
  assert.strictEqual(CR.rBucket(2.5), '1.5-2.5r');
  assert.strictEqual(CR.rBucket(2.51), 'over-2.5r');
  assert.strictEqual(CR.rBucket(null), 'r-unknown');
  const r = CR.checkReads({ reads: SCENARIO_1, side: 'long', briefing: scenario1() });
  assert.match(CR.readSignature(r.reads, { targetR: 3 }), /target:1h-swing-over-2\.5r$/);
});

const fixtureBars = () => loadBars(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv')).map(({ ms, ...b }) => b); // eslint-disable-line no-unused-vars
const briefingAt = (bars, i) => clone(buildBriefing({ symbol: 'MNQ', bars: bars.slice(0, i + 1), minutes: 3, scan: [], now: new Date(Date.parse(bars[i].t) + 180000) }));

test('scenario 1 on the fixture bars: the 3m bar of 2026-04-24 09:57 ET (bar 773) as the owner\'s ideal long', () => {
  // The 1h changed character up and price holds above the prior RTH high 27155.75; the 15m traded under it and closed
  // back above; the 3m closed at its high on 1.5x volume and 1.43 ATR of range; wrong under the 15m low 27130.25;
  // target the next 1h swing high 27363.75 (170 points over 63.50 of risk: 2.68R).
  const b = briefingAt(fixtureBars(), 773);
  const reads = [
    { step: 'bias', skill: 'bos-vs-choch', read: '1h choch up' },
    { step: 'bias', skill: 'daily-bias', read: 'above prior RTH range' },
    { step: 'location', skill: 'levels-and-reactions', read: 'at prior RTH high' },
    { step: 'setup', skill: 'rejection', read: '15m rejected prior RTH high up' },
    { step: 'entry', skill: 'candle-reading', read: '3m close top' },
    { step: 'entry', skill: 'momentum-and-volume', read: '3m momentum up' },
    { step: 'stop', skill: 'invalidation', read: 'stop 15m low 27130.25' },
    { step: 'target', skill: 'top-down-entry', read: 'target 1h swing 27363.75' },
  ];
  const r = CR.checkReads({ reads, side: 'long', briefing: b });
  assert.strictEqual(r.ok, true, CR.renderCheck(r));
  assert.strictEqual(r.reference, 27193.75);
  assert.strictEqual(r.signature, 'bias:1h-choch-up+bias:above-prior-rth-range+location:at-prior-rth-high+setup:15m-rejected-prior-rth-high-up+entry:3m-close-top+entry:3m-momentum-up+stop:15m-low+target:1h-swing-over-2.5r');
  // A relation past the four the text shows (the 15m met seven levels) verifies.
  assert.ok(!('previous 15m low' in b.sections.m3.data.candles['15m'].levels));
  assert.strictEqual(CR.checkRead(CR.parseRead('15m rejected previous 15m low up'), b).check, true);
  // The 15m's own last break is a CHoCH down, against the long: under the verified 1h CHoCH up it is a pullback (D2);
  // without the 1h CHoCH read it refuses the combination.
  const pullback = reads.concat({ step: 'bias', skill: 'bos-vs-choch', read: '15m choch down' });
  const withChoch = CR.checkReads({ reads: pullback, side: 'long', briefing: b });
  assert.strictEqual(withChoch.ok, true, CR.renderCheck(withChoch));
  assert.strictEqual(withChoch.reads.at(-1).reversal, true);
  const noChoch = CR.checkReads({ reads: pullback.map(x => (x.read === '1h choch up' ? { ...x, read: '1h up' } : x)), side: 'long', briefing: b });
  assert.strictEqual(noChoch.reads.at(-1).check, true);
  assert.strictEqual(noChoch.ok, false);
  // A read for the other side is never excused: the short read is mixed, true, and against the long.
  const other = CR.checkReads({ reads: reads.concat({ step: 'bias', skill: 'multi-timeframe-analysis', read: 'read short mixed' }), side: 'long', briefing: b });
  assert.strictEqual(other.reads.at(-1).check, true);
  assert.strictEqual(other.ok, false);
  // The mirror for a short is refused.
  assert.strictEqual(CR.checkReads({ reads, side: 'short', briefing: b }).ok, false);
  // False reads on these bars.
  for (const read of ['1h bos up', '15m rejected prior RTH high down', '3m close bottom', 'below prior RTH range', 'stop 15m low 27140']) {
    assert.strictEqual(CR.checkRead(CR.parseRead(read), b).check, false, read);
  }
});

test('on briefings built from the fixture bars: each true read verifies, its mirror is refused', () => {
  const bars = fixtureBars();
  let checked = 0;
  for (const i of [600, 900, 1200, bars.length - 1]) {
    const b = briefingAt(bars, i);
    const m3 = b.sections.m3.data;
    for (const [tf, c] of Object.entries(m3.candles)) {
      if (c.unavailable) continue;
      assert.ok(Array.isArray(c.relations), `${tf}: the structured relations are in the briefing`);
      assert.strictEqual(c.relations.length, Object.keys(c.levels).length + (c.moreLevels || 0), `${tf}: every relation, the capped text's and the ones it counts`);
      assert.strictEqual(CR.checkRead(CR.parseRead(`${tf} close ${c.closeLocation}`), b).check, c.closeLocation ? true : 'unchecked');
      for (const r of c.relations) {
        const read = r.rel === 'touched' ? `${tf} touched ${CR.levelName(r.name)}` : `${tf} ${r.rel} ${CR.levelName(r.name)} ${r.dir}`;
        assert.strictEqual(CR.checkRead(CR.parseRead(read), b).check, true, read);
        if (r.dir) assert.strictEqual(CR.checkRead(CR.parseRead(`${tf} ${r.rel} ${CR.levelName(r.name)} ${r.dir === 'up' ? 'down' : 'up'}`), b).check, false);
        checked += 1;
      }
    }
    for (const [sec, tf] of [['h1', '1h'], ['m15', '15m'], ['m3', '3m']]) {
      const lb = b.sections[sec].data.lastBreak.last;
      if (!lb) continue;
      assert.strictEqual(CR.checkRead(CR.parseRead(`${tf} ${lb.kind.toLowerCase()} ${lb.direction}`), b).check, true);
      assert.strictEqual(CR.checkRead(CR.parseRead(`${tf} ${lb.kind.toLowerCase()} ${lb.direction === 'up' ? 'down' : 'up'}`), b).check, false);
    }
    for (const t of m3.swingTargets.above) assert.strictEqual(CR.checkRead(CR.parseRead(`target ${t.frame} swing ${t.price}`), b).dir, 'long');
    for (const t of m3.swingTargets.below) assert.strictEqual(CR.checkRead(CR.parseRead(`target ${t.frame} swing ${t.price}`), b).dir, 'short');
    const c3 = m3.candles['3m'];
    assert.strictEqual(CR.checkRead(CR.parseRead(`stop 3m low ${c3.l}`), b).check, true);
  }
  assert.ok(checked > 10, `checked ${checked} relations`);
});
