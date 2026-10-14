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
const { scenario1, SCENARIO_1, SKILLS } = require('../fixtures/trade-lifecycle-scenario');

const clone = x => JSON.parse(JSON.stringify(x));

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

test('a true read the other way refuses the combination; a 15m or 1h CHoCH the order\'s way excuses trend and break reads at or below its timeframe (D2)', () => {
  const b = scenario1();
  b.sections.m15.data.frame.trend = 'down';
  b.sections.h1.data.h4.trend = 'down';
  const counter = SCENARIO_1.concat({ step: 'bias', skill: 'multi-timeframe-analysis', read: '15m down' });
  const r = CR.checkReads({ reads: counter, side: 'long', briefing: b });
  assert.strictEqual(r.reads.at(-1).check, true);
  assert.strictEqual(r.reads.at(-1).agrees, false);
  assert.strictEqual(r.ok, false);
  // A 1h CHoCH up excuses the 15m trend down.
  b.sections.h1.data.lastBreak.last = { kind: 'CHoCH', direction: 'up', level: 21500 };
  const withChoch = counter.map(x => (x.read === '1h bos up' ? { ...x, read: '1h choch up' } : x));
  const r2 = CR.checkReads({ reads: withChoch, side: 'long', briefing: b });
  assert.strictEqual(r2.ok, true, CR.renderCheck(r2));
  assert.strictEqual(r2.reads.find(x => x.read === '15m down').reversal, true);
  // Never a trend above the CHoCH's timeframe: the 4h down stays against the long.
  const r4h = CR.checkReads({ reads: withChoch.concat({ step: 'bias', skill: 'multi-timeframe-analysis', read: '4h down' }), side: 'long', briefing: b });
  assert.strictEqual(r4h.reads.at(-1).agrees, false);
  assert.strictEqual(r4h.ok, false);
  // A 15m CHoCH excuses the 15m trend, never the 1h's.
  b.sections.h1.data.lastBreak.last = { kind: 'BOS', direction: 'up', level: 21500 };
  b.sections.m15.data.lastBreak.last = { kind: 'CHoCH', direction: 'up', level: 21530 };
  b.sections.h1.data.h1.trend = 'down';
  const m15 = counter.concat({ step: 'bias', skill: 'bos-vs-choch', read: '15m choch up' });
  assert.strictEqual(CR.checkReads({ reads: m15, side: 'long', briefing: b }).ok, true);
  const r1h = CR.checkReads({ reads: m15.concat({ step: 'bias', skill: 'multi-timeframe-analysis', read: '1h down' }), side: 'long', briefing: b });
  assert.strictEqual(r1h.reads.at(-1).agrees, false);
  assert.strictEqual(r1h.ok, false);
  // A 3m CHoCH excuses nothing.
  b.sections.m15.data.lastBreak.last = { kind: 'BOS', direction: 'down', level: 21530 };
  b.sections.m3.data.lastBreak.last = { kind: 'CHoCH', direction: 'up', level: 21535 };
  const m3 = counter.concat({ step: 'bias', skill: 'bos-vs-choch', read: '3m choch up' });
  const r3m = CR.checkReads({ reads: m3, side: 'long', briefing: b });
  assert.strictEqual(r3m.reads.find(x => x.read === '3m choch up').check, true);
  assert.strictEqual(r3m.reads.find(x => x.read === '15m down').agrees, false);
  assert.strictEqual(r3m.ok, false);
  // The reversal never excuses a setup, an entry, a stop or a target the other way.
  b.sections.h1.data.lastBreak.last = { kind: 'CHoCH', direction: 'up', level: 21500 };
  b.sections.h1.data.h1.trend = 'up';
  b.sections.m3.data.candles['3m'].closeLocation = 'bottom';
  b.sections.m3.data.candles['3m'].volRatio = 0.5;
  const bad = withChoch.filter(x => x.read !== '3m momentum up').map(x => (x.read === '3m close top' ? { ...x, read: '3m close bottom' } : x));
  const r5 = CR.checkReads({ reads: bad, side: 'long', briefing: b });
  assert.strictEqual(r5.ok, false);
  assert.strictEqual(r5.reads.find(x => x.read === '3m close bottom').agrees, false);
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

test('at <level>: the trigger bar, or the base or next candle within one ATR(14) of price; never a stale or distant level', () => {
  const b = scenario1();
  const m3 = b.sections.m3.data;
  const at = read => CR.checkRead(CR.parseRead(read), b);
  m3.bar.l = 21535; // the IB high 21533 is now outside the trigger bar; the 15m candle met it, 7.25 from price
  m3.atr14 = 10;
  assert.strictEqual(at('at IB high').check, true);
  m3.atr14 = 5;
  assert.strictEqual(at('at IB high').check, false, 'more than one ATR(14) from price');
  delete m3.atr14;
  assert.strictEqual(at('at IB high').check, false, 'ATR(14) unknown: only the trigger bar counts');
  // A level only a 1h candle met (not the base candle or the next one up), 90 points away: false.
  m3.atr14 = 200;
  b.keyLevels.push(['prior VAL', 21450]);
  m3.candles['1h'].relations = [{ name: 'prior VAL', price: 21450, rel: 'touched', dir: null }];
  assert.strictEqual(at('at prior VAL').check, false);
  assert.match(at('at prior VAL').fact, /the 3m, 15m candle didn't meet it/);
});

test('CISD and OTE: a dead CISD is no read; an OTE zone points the CISD\'s way', () => {
  const b = scenario1();
  const one = read => CR.checkRead(CR.parseRead(read), b);
  for (const status of ['void', 'expired', 'weak']) {
    b.sections.m3.data.cisd['15m'].status = status;
    assert.strictEqual(one('15m cisd up').check, false, status);
    assert.match(one('15m cisd up').fact, new RegExp(`status ${status} \\(dead`));
  }
  b.sections.m3.data.cisd['15m'] = { dir: 'bearish', level: 21550, status: 'touched', priceInOte: true };
  assert.deepStrictEqual([one('in ote').check, one('in ote').dir], [true, 'short']);
  assert.deepStrictEqual([one('15m in ote').check, one('15m in ote').dir], [true, 'short']);
  // A long located in a bearish OTE disagrees.
  const reads = SCENARIO_1.concat({ step: 'setup', skill: 'fib-retracement', read: '15m in ote' });
  const r = CR.checkReads({ reads, side: 'long', briefing: b });
  assert.strictEqual(r.reads.at(-1).agrees, false);
  assert.strictEqual(r.ok, false);
  // Zones both ways: name the timeframe.
  b.sections.m3.data.cisd['1h'] = { dir: 'bullish', level: 21500, status: 'waiting', priceInOte: true };
  assert.strictEqual(one('in ote').check, false);
  assert.strictEqual(one('1h in ote').dir, 'long');
  b.sections.m3.data.cisd['1h'].status = 'void';
  assert.strictEqual(one('1h in ote').check, false, 'a dead CISD has no zone');
});

test('each step takes its own kinds of read, and no read is stated twice', () => {
  const b = scenario1();
  const misplaced = SCENARIO_1.map(x => (x.step === 'location' ? { ...x, read: '1h bos up' } : x));
  const r = CR.checkReads({ reads: misplaced, side: 'long', briefing: b });
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some(p => /a break read belongs to the bias step, not location/.test(p)), r.problems.join('; '));
  const twice = SCENARIO_1.concat({ step: 'bias', skill: 'multi-timeframe-analysis', read: '1h BOS up' });
  const r2 = CR.checkReads({ reads: twice, side: 'long', briefing: b });
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.problems.some(p => /the same read twice/.test(p)));
  // Another skill and another form within a step is the model's choice.
  const free = SCENARIO_1.map(x => (x.step === 'location' ? { ...x, skill: 'levels-and-reactions', read: 'vwap above' } : x));
  assert.strictEqual(CR.checkReads({ reads: free, side: 'long', briefing: b }).ok, true);
});

test('edges: one tick, the momentum thresholds, pattern none, taken pools, an unavailable candle, stored lengths', () => {
  const b = scenario1();
  const one = read => CR.checkRead(CR.parseRead(read), b);
  assert.strictEqual(one('stop 15m low 21513').check, true, 'exactly one tick');
  assert.strictEqual(one('stop 15m low 21513.01').check, false, 'past one tick');
  Object.assign(b.sections.m3.data.candles['3m'], { rangeAtr: 1, volRatio: 1 });
  assert.strictEqual(one('3m momentum up').check, true, 'at the thresholds');
  Object.assign(b.sections.m3.data.candles['3m'], { rangeAtr: 0.99 });
  assert.strictEqual(one('3m momentum up').check, false);
  b.sections.m3.data.candles['1h'].pattern = 'none';
  assert.strictEqual(one('1h pattern none').check, false);
  b.sections.m3.data.liquidity.equalHighs = [{ name: 'equal highs', price: 21541, taken: true }];
  assert.strictEqual(one('at equal highs').check, 'unchecked', 'a taken pool is no level');
  b.sections.m3.data.liquidity.equalHighs = [{ name: 'equal highs', price: 21541, taken: false }];
  assert.strictEqual(one('at equal highs').check, true);
  assert.strictEqual(one('stop 5m low 21500').check, 'unchecked', 'the 5m candle is unavailable');
  const long = CR.checkReads({ reads: [{ step: 'bias', skill: `a${'b'.repeat(200)}`, read: `1h bos up ${'x'.repeat(500)}`, why: 'y' }], side: 'long', briefing: b });
  assert.ok(long.reads[0].read.length <= 120 && long.reads[0].skill.length <= 64);
});
