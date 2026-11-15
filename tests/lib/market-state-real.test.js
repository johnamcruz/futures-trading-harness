'use strict';

// The Market state on REAL briefings (round 15, PREREG addendum 15): buildBriefing on the CI goal fixture's real 3m bars
// (tests/fixtures/goal/bars.json.gz, the runner's 514 h window), at the moments the round's fixes change, so each rule is
// checked on the fields the live briefing really carries (knownAt, closedAt, the CISD's confirmedClose, the Pullback
// read's swings, the breaks' protected swings), never on hand-made objects that may lack them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const GF = require('../../scripts/lib/eval/goal-fixture');
const B = require('../../scripts/lib/trading/briefing');
const M = require('../../scripts/lib/trading/market-state');
const PR = require('../../scripts/lib/trading/pullback-read');
const { protectedOf, lastBreaks } = require('../../scripts/lib/trading/structure-events');
const { analysis } = require('../../scripts/lib/tunables');

const AN = analysis();
const TH = { crossesChop: AN.regime.rangeCrosses, maxPullbackDepth: AN.pullbackRead.maxStateDepth };
const DOC = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'goal', 'bars.json.gz'))));
const HOURS = DOC.historyHours * 3600000;
const barsCache = new Map();
const barsOf = date => {
  const i = DOC.blocks.findIndex(x => x.sessions.includes(date));
  if (!barsCache.has(i)) barsCache.set(i, GF.decodeBars(DOC.blocks[i].bars));
  return barsCache.get(i);
};
// The bar opening at `hm` ET on `date` (EDT dates here: UTC-4; EST dates: UTC-5), on the runner's window.
const utcOf = (date, hm) => {
  const [h, m] = hm.split(':').map(Number);
  for (const off of [4, 5]) {
    const t = new Date(`${date}T00:00:00.000Z`).getTime() + ((h + off) * 60 + m) * 60000;
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
    if (fmt === hm) return t;
  }
  throw new Error(`no ET time ${hm}`);
};
const window = (date, hm) => {
  const bars = barsOf(date);
  const t = utcOf(date, hm);
  const j = bars.findIndex(x => Date.parse(x.t) === t);
  assert.ok(j >= 0, `a bar at ${date} ${hm} ET`);
  return bars.filter((x, k) => k <= j && Date.parse(x.t) >= t - HOURS);
};
const briefAt = (date, hm) => {
  const w = window(date, hm);
  return B.buildBriefing({ symbol: 'NQ', bars: w, minutes: 3, now: new Date(Date.parse(w[w.length - 1].t) + 180000) });
};
const stateAt = (date, hm) => {
  const b = briefAt(date, hm);
  const s = M.stateOf(b, TH);
  return { b, s, line: M.marketStateLine(s), cls: M.classWordOf(s), m3: b.sections.m3.data };
};

test('fix 1 (real): a deep pullback (75% of its leg) no longer guards the 3m CHoCH pair from chop (2022-08-11 10:57)', () => {
  const { s, line, m3 } = stateAt('2022-08-11', '10:57');
  assert.ok(m3.pullback && m3.pullback.depth > TH.maxPullbackDepth && PR.isOpen(m3.pullback), `an open, deep Pullback line: ${JSON.stringify(m3.pullback && m3.pullback.depth)}`);
  assert.strictEqual(s.pair, true, 'the 3m CHoCH pair');
  assert.strictEqual(s.pullback, null, 'too deep to count for the state');
  assert.strictEqual(s.state, 'chop', line);
});

test('fix 1 (real): the leg-defining 15m swing broken by a close kills the pullback read: the pair is chop (2023-09-25 10:24)', () => {
  const { s, line, m3 } = stateAt('2023-09-25', '10:24');
  assert.strictEqual(m3.pullback.swing['15m'].holds, false, 'its 15m swing broken');
  assert.ok(m3.pullback.depth <= TH.maxPullbackDepth, 'not too deep: the swing decides');
  assert.strictEqual(PR.lineOpen(m3.pullback), true, 'the printed line still reads open');
  assert.strictEqual(PR.isOpen(m3.pullback), false);
  assert.deepStrictEqual([s.pair, s.state], [true, 'chop'], line);
});

test('fix 1 (real): a leg given back past its origin and crossed back stays dead (2021-05-25 09:54)', () => {
  const { m3 } = stateAt('2021-05-25', '09:54');
  assert.strictEqual(m3.pullback.pastOrigin, false, 'the close is back inside the leg');
  assert.strictEqual(m3.pullback.givenBackSince, true, 'a close since the extreme went past the origin');
  assert.strictEqual(PR.isOpen(m3.pullback), false);
  assert.strictEqual(PR.lineOpen(m3.pullback), true);
});

test('fix 2 (real): a premarket 15m BOS does not make the 3m pair the 15m continuation (2021-05-25 09:36)', () => {
  const { b, s, line } = stateAt('2021-05-25', '09:36');
  const lb15 = b.sections.m15.data.lastBreak.last;
  assert.strictEqual(lb15.kind, 'BOS');
  assert.ok(Date.parse(lb15.knownAt) < Date.parse('2021-05-25T13:30:00.000Z'), `known before 09:30 ET: ${lb15.knownAt}`);
  assert.strictEqual(s.confirm15, null, line);
  assert.doesNotMatch(line, /= the 15m/);
});

test('fix 2 (real): the 15m frame trend no longer confirms a 3m pair (2021-05-28 10:42)', () => {
  const { s, line } = stateAt('2021-05-28', '10:42');
  assert.strictEqual(s.pair, true);
  assert.strictEqual(s.confirm15, null, line);
  assert.doesNotMatch(line, /= the 15m trend/);
});

test('fix 3 (real): a 3m CHoCH against the aligned 15m is no early pullback read (2021-05-27 10:57)', () => {
  const { s, line } = stateAt('2021-05-27', '10:57');
  assert.strictEqual(s.last.kind, 'CHoCH');
  assert.ok(s.align && s.m15 === s.align && s.last.direction !== s.align, line);
  assert.strictEqual(s.early, false, line);
  assert.doesNotMatch(line, /a pullback in the 15m trend/);
});

test('fix 4 (real): no RTH break yet: forming, the class from the 4h + 1h (2021-05-26 09:30); one RTH BOS: a trend (09:45)', () => {
  const z = stateAt('2021-05-26', '09:30');
  assert.deepStrictEqual([z.s.state, z.cls], ['forming', z.s.align ? `trend-${z.s.align}` : 'unclear'], z.line);
  assert.match(z.line, /^Market state \(3m\): forming \(no RTH structure yet\)/);
  const one = stateAt('2021-05-26', '09:45');
  assert.strictEqual(one.s.last.kind, 'BOS');
  assert.strictEqual(one.s.previous, null, 'the only RTH break');
  assert.deepStrictEqual([one.s.state, one.s.way], ['trend', one.s.last.direction], one.line);
});

// The owner's invalidation rule on the real briefing: every printed 3m break carries the protected swing the code
// computes from these bars (structure-events.js protectedOf), causal (the same from the bars cut at the break).
test('protected swings (real): each printed 3m break carries protectedOf on the briefing\'s own bars, causal', () => {
  for (const [date, hm] of [['2021-05-26', '10:30'], ['2022-08-11', '10:57'], ['2023-09-25', '10:24'], ['2021-05-27', '10:57']]) {
    const w = window(date, hm);
    const b = B.buildBriefing({ symbol: 'NQ', bars: w, minutes: 3, now: new Date(Date.parse(w[w.length - 1].t) + 180000) });
    const lb = b.sections.m3.data.lastBreak;
    const plain = lastBreaks(w);
    for (const k of ['last', 'previous']) {
      if (!plain[k]) continue;
      assert.deepStrictEqual(lb[k].protected, protectedOf(w, plain[k]), `${date} ${hm} ${k}`);
      const cut = w.filter(x => Date.parse(x.t) <= Date.parse(plain[k].at));
      assert.strictEqual(protectedOf(cut, plain[k]).level, lb[k].protected.level, 'causal: known at the break');
      const p = lb[k].protected;
      const span = w.filter(x => Date.parse(x.t) >= Date.parse(plain[k].swingAt) && Date.parse(x.t) <= Date.parse(plain[k].at));
      assert.strictEqual(p.level, plain[k].direction === 'up' ? Math.min(...span.map(x => x.l)) : Math.max(...span.map(x => x.h)));
    }
  }
});

// The owner's BOS/CHoCH invalidation cases, each on a real briefing (the CI goal fixture's bars): the protected level is
// the one the code computes from the briefing's own bars; a close through it invalidates, a wick does not.
const closesThrough = (w, brk) => {
  const p = brk.protected;
  return w.filter(x => Date.parse(x.t) > Date.parse(brk.at) && (brk.direction === 'up' ? x.c < p.level : x.c > p.level));
};
const caseAt = (date, hm) => {
  const w = window(date, hm);
  const b = B.buildBriefing({ symbol: 'NQ', bars: w, minutes: 3, now: new Date(Date.parse(w[w.length - 1].t) + 180000) });
  const s = M.stateOf(b, TH);
  return { w, b, s, line: M.marketStateLine(s), last: b.sections.m3.data.lastBreak.last };
};

test('BOS (real): a bullish BOS holds while its protected HL holds (2021-05-26 10:51); a bearish one too (2021-05-25 09:51)', () => {
  for (const [date, hm, dir, word] of [['2021-05-26', '10:51', 'up', 'HL'], ['2021-05-25', '09:51', 'down', 'LH']]) {
    const { w, s, line, last } = caseAt(date, hm);
    assert.deepStrictEqual([last.kind, last.direction, last.protected.brokenAt], ['BOS', dir, null], `${date} ${hm}`);
    assert.strictEqual(closesThrough(w, last).length, 0, 'no close through it');
    assert.deepStrictEqual([s.state, s.way], ['trend', dir], line);
    assert.match(line, new RegExp(`; protected ${word} ${last.protected.level} holding;`));
  }
});

test('BOS (real): a bearish BOS is invalidated by a close above its protected LH: the trend ended (2022-09-01 10:27, 2023-09-21 11:48); a bullish one\'s close below is recorded (2022-09-02 09:30)', () => {
  for (const [date, hm] of [['2022-09-01', '10:27'], ['2023-09-21', '11:48']]) {
    const { w, s, line, last } = caseAt(date, hm);
    assert.deepStrictEqual([last.kind, last.direction], ['BOS', 'down'], `${date} ${hm}`);
    const through = closesThrough(w, last);
    assert.ok(through.length > 0 && last.protected.brokenAt === through[0].t, 'brokenAt: the first close above it');
    assert.strictEqual(s.state, 'ranging', line);
    assert.match(line, new RegExp(`; protected LH ${last.protected.level} broken by a close \\(the trend ended\\);`));
  }
  const up = caseAt('2022-09-02', '09:30');
  assert.deepStrictEqual([up.last.kind, up.last.direction], ['BOS', 'up']);
  assert.strictEqual(up.last.protected.brokenAt, closesThrough(up.w, up.last)[0].t, 'the first close below the protected HL');
});

test('CHoCH (real): a bullish CHoCH holds above its origin (2021-05-25 10:54) and fails on a close below it (2023-05-01 10:39); the bearish mirror (2021-05-25 09:39, 2021-05-28 11:18)', () => {
  for (const [date, hm, dir, broken] of [['2021-05-25', '10:54', 'up', false], ['2023-05-01', '10:39', 'up', true], ['2021-05-25', '09:39', 'down', false], ['2021-05-28', '11:18', 'down', true]]) {
    const { w, line, last } = caseAt(date, hm);
    assert.deepStrictEqual([last.kind, last.direction], ['CHoCH', dir], `${date} ${hm}`);
    const through = closesThrough(w, last);
    assert.strictEqual(Boolean(last.protected.brokenAt), broken, `${date} ${hm}`);
    assert.strictEqual(through.length > 0, broken);
    const side = dir === 'up' ? ['above', 'below'] : ['below', 'above'];
    if (broken) assert.match(line, new RegExp(`; failed: a close ${side[1]} its origin ${last.protected.level};`), line);
    else if (!/^Market state \(3m\): chop/.test(line)) assert.match(line, new RegExp(`; holds ${side[0]} ${last.protected.level} \\(origin\\);`), line);
  }
});

test('a wick through the protected level that closes back is no invalidation (real: 2021-05-25 10:48, a high above the LH, the close back below)', () => {
  const { w, s, line, last } = caseAt('2021-05-25', '10:48');
  const bar = w[w.length - 1];
  assert.ok(bar.h > last.protected.level && bar.c <= last.protected.level, `a wick: h ${bar.h}, c ${bar.c}, LH ${last.protected.level}`);
  assert.strictEqual(last.protected.brokenAt, null);
  assert.deepStrictEqual([s.state, s.way], ['trend', 'down'], line);
});

test('sequences (real): CHoCH then BOS the same way a confirmed transition (2021-05-25 09:51); BOS then BOS a continuation (10:33); CHoCH then CHoCH chop (2023-09-25 10:24)', () => {
  const t = caseAt('2021-05-25', '09:51');
  assert.match(t.line, /: trend down: 3m CHoCH down then BOS down \(confirmed transition down\)/);
  const c = caseAt('2021-05-25', '10:33');
  assert.deepStrictEqual([c.b.sections.m3.data.lastBreak.previous.kind, c.last.kind], ['BOS', 'BOS']);
  assert.match(c.line, /: trend \w+: 3m BOS \w+ \(continuation\)/);
  const p = caseAt('2023-09-25', '10:24');
  assert.match(p.line, /: chop: 3m CHoCH \w+ then CHoCH \w+ \(failed reversal\)/);
});
