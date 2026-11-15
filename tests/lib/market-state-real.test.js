'use strict';

// The Market state on REAL briefings (round 15, PREREG addendum 15; round 20: the three layers, m3.layers): buildBriefing on the CI goal fixture's real 3m bars
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
const ind = require('../../scripts/lib/trading/indicators');
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

// Round 20: the two pinned real tests the design review names, rewritten with the reason. Before, the 3m CHoCH pair was
// chop there; the owner's refinement ("Don't classify a market as chop simply because you see two opposing CHoCHs") makes
// the layers decide: structural AND behavioral evidence.
test('round 20 (real): a deep pullback (past maxStateDepth) loses its guard and the layers decide: the up leg holds, an internal break against it (2022-08-11 10:57)', () => {
  const { s, line, cls, m3 } = stateAt('2022-08-11', '10:57');
  assert.ok(m3.pullback && m3.pullback.depth > TH.maxPullbackDepth && PR.isOpen(m3.pullback), `an open, deep Pullback line: ${JSON.stringify(m3.pullback && m3.pullback.depth)}`);
  assert.strictEqual(s.pullback, null, 'too deep to count for the state');
  const P = m3.layers.structure;
  assert.deepStrictEqual([P.side, P.status, P.legOK], ['up', 'intact', true], 'the leg\'s protected HL holds');
  assert.ok(P.lastInternal && P.lastInternal.direction === 'down', 'an internal break against: a pullback\'s evidence, never a trend change');
  assert.deepStrictEqual([s.state, cls], ['leg', 'trend-up'], line);
  assert.match(line, /^Market state \(3m\): in the up leg: HL [\d.]+ holds, internal low [\d.]+ broken;/);
});

test('round 20 (real): the failed opening rally (2023-09-25): chop 09:57-10:21 on structural and behavioral evidence, ended at 10:24 by displacement (range, class trend-down)', () => {
  for (const hm of ['09:57', '10:09', '10:21']) {
    const { s, line, m3 } = stateAt('2023-09-25', hm);
    assert.strictEqual(s.state, 'chop', `${hm} ${line}`);
    assert.ok(m3.layers.chop.inChop && !m3.layers.structure.legOK, hm);
  }
  assert.strictEqual(stateAt('2023-09-25', '09:54').s.state, 'range', 'the chop starts at 09:57, not before');
  const end = stateAt('2023-09-25', '10:24');
  assert.strictEqual(end.m3.pullback.swing['15m'].holds, false, 'its 15m swing broken: the pullback read dead (round 15), no guard');
  assert.strictEqual(PR.isOpen(end.m3.pullback), false);
  assert.strictEqual(end.m3.layers.chop.ended, true, 'an end event at 10:24 (a displaced break)');
  assert.deepStrictEqual([end.s.state, end.cls], ['range', 'trend-down'], end.line);
});

test('fix 1 (real): a leg given back past its origin and crossed back stays dead (2021-05-25 09:54)', () => {
  const { m3 } = stateAt('2021-05-25', '09:54');
  assert.strictEqual(m3.pullback.pastOrigin, false, 'the close is back inside the leg');
  assert.strictEqual(m3.pullback.givenBackSince, true, 'a close since the extreme went past the origin');
  assert.strictEqual(PR.isOpen(m3.pullback), false);
  assert.strictEqual(PR.lineOpen(m3.pullback), true);
});

test('the first RTH minutes (real): no RTH break yet: forming, the class from the 4h + 1h (2021-05-26 09:30); then the layers\' leg (09:45)', () => {
  const z = stateAt('2021-05-26', '09:30');
  assert.deepStrictEqual([z.s.state, z.cls], ['forming', z.s.align ? `trend-${z.s.align}` : 'unclear'], z.line);
  assert.match(z.line, /^Market state \(3m\): forming \(no RTH structure yet\)/);
  const one = stateAt('2021-05-26', '09:45');
  assert.deepStrictEqual([one.s.state, one.s.way], ['leg', one.m3.layers.structure.side], one.line);
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
      const span = w.filter(x => Date.parse(x.t) > Date.parse(plain[k].swingAt) && Date.parse(x.t) <= Date.parse(plain[k].at));
      assert.strictEqual(p.level, plain[k].direction === 'up' ? Math.min(...span.map(x => x.l)) : Math.max(...span.map(x => x.h)));
    }
  }
});

// The owner's BOS/CHoCH invalidation cases, each on a real briefing (the CI goal fixture's bars): the per-break protected
// level the briefing prints (structure-events.js) and the layers' one leg level (round 20: a close through it past the tie
// tolerance, decision 8, is the only invalidation).
const closesThrough = (w, brk) => {
  const p = brk.protected;
  return w.filter(x => Date.parse(x.t) > Date.parse(brk.at) && (brk.direction === 'up' ? x.c < p.level : x.c > p.level));
};
const caseAt = (date, hm) => {
  const w = window(date, hm);
  const b = B.buildBriefing({ symbol: 'NQ', bars: w, minutes: 3, now: new Date(Date.parse(w[w.length - 1].t) + 180000) });
  const s = M.stateOf(b, TH);
  return { w, b, s, line: M.marketStateLine(s), last: b.sections.m3.data.lastBreak.last, L: b.sections.m3.data.layers };
};

test('BOS (real): a bullish BOS holds while its protected HL holds (2021-05-26 10:51); a bearish one too (2021-05-25 09:51)', () => {
  for (const [date, hm, dir, word] of [['2021-05-26', '10:51', 'up', 'HL'], ['2021-05-25', '09:51', 'down', 'LH']]) {
    const { w, s, line, last, L } = caseAt(date, hm);
    assert.deepStrictEqual([last.kind, last.direction, last.protected.brokenAt], ['BOS', dir, null], `${date} ${hm}`);
    assert.strictEqual(closesThrough(w, last).length, 0, 'no close through it');
    assert.deepStrictEqual([L.structure.side, L.structure.status, L.structure.level], [dir, 'intact', last.protected.level], 'the leg\'s level is the last break\'s protected swing (decision 2)');
    assert.deepStrictEqual([s.state, s.way], ['trend', dir], line);
    assert.match(line, new RegExp(`: ${word} ${last.protected.level} holds`));
  }
});

test('BOS (real): a close through the protected level past the tie tolerance flips the leg (2022-09-01 10:27); a close within it is a tie (2023-09-21 11:48, decision 8)', () => {
  const a = caseAt('2022-09-01', '10:27');
  assert.deepStrictEqual([a.last.kind, a.last.direction], ['BOS', 'down']);
  assert.ok(a.last.protected.brokenAt === closesThrough(a.w, a.last)[0].t, 'brokenAt: the first close above it');
  assert.notStrictEqual(a.L.structure.side === 'down' && a.L.structure.status === 'intact', true, 'the down leg ended');
  assert.notStrictEqual(a.s.state, 'trend', a.line);
  const t = caseAt('2023-09-21', '11:48');
  const close = t.w.find(x => x.t === t.last.protected.brokenAt).c;
  const atr = ind.atr(t.w);
  const k = t.w.findIndex(x => x.t === t.last.protected.brokenAt);
  assert.ok(close > t.last.protected.level && close - t.last.protected.level <= AN.marketState.equalAtr * atr[k], `a close ${close} within the tie of ${t.last.protected.level}`);
  assert.deepStrictEqual([t.L.structure.side, t.L.structure.status, t.L.structure.level], ['down', 'intact', t.last.protected.level], 'a tie is not a break');
  assert.match(t.line, new RegExp(`LH ${t.last.protected.level} holds`));
  const up = caseAt('2022-09-02', '09:30');
  assert.deepStrictEqual([up.last.kind, up.last.direction], ['BOS', 'up']);
  assert.strictEqual(up.last.protected.brokenAt, closesThrough(up.w, up.last)[0].t, 'the first close below the protected HL');
});

test('CHoCH (real): the briefing\'s per-break protected swing: a bullish CHoCH holds above its origin (2021-05-25 10:54) and fails on a close below it (2023-05-01 10:39); the bearish mirror (2021-05-25 09:39, 2021-05-28 11:18)', () => {
  for (const [date, hm, dir, broken] of [['2021-05-25', '10:54', 'up', false], ['2023-05-01', '10:39', 'up', true], ['2021-05-25', '09:39', 'down', false], ['2021-05-28', '11:18', 'down', true]]) {
    const { w, last } = caseAt(date, hm);
    assert.deepStrictEqual([last.kind, last.direction], ['CHoCH', dir], `${date} ${hm}`);
    assert.strictEqual(Boolean(last.protected.brokenAt), broken, `${date} ${hm}`);
    assert.strictEqual(closesThrough(w, last).length > 0, broken);
  }
});

test('a wick through the protected level that closes back is no invalidation (real: 2021-05-25 10:48, a high above the LH, the close back below): no flip at that bar', () => {
  const { w, last, L } = caseAt('2021-05-25', '10:48');
  const bar = w[w.length - 1];
  assert.ok(bar.h > last.protected.level && bar.c <= last.protected.level, `a wick: h ${bar.h}, c ${bar.c}, LH ${last.protected.level}`);
  assert.strictEqual(last.protected.brokenAt, null);
  assert.ok(!L.structure.flip || L.structure.flip.barsAgo !== 0, 'the machine does not flip on a wick');
});

// PREREG addendum 16: the sticky depth on a real briefing (2021-06-11, the flicker: 10:33 63%, 10:36 back to 61%). Past
// the bound once, the pullback no longer guards; round 20: the layers decide (never the pullback state).
test('sticky depth (real): 2021-06-11 10:36, the pullback bounced back to 61% after 63%: no guard, the layers decide', () => {
  const bars = require('../fixtures/pullback/depth-flicker-2021-06-11.json').map(([t, o, h, l, c, v]) => ({ t: `${t}:00.000Z`, o, h, l, c, v }));
  const w = bars.slice(0, bars.findIndex(b => b.t === '2021-06-11T14:36:00.000Z') + 1);
  const b = B.buildBriefing({ symbol: 'NQ', bars: w, minutes: 3, now: new Date(Date.parse(w[w.length - 1].t) + 180000) });
  const s = M.stateOf(b, TH);
  assert.strictEqual(b.sections.m3.data.pullback.depth, 0.61);
  assert.ok(b.sections.m3.data.pullback.maxDepth > TH.maxPullbackDepth);
  assert.strictEqual(s.pullback, null);
  assert.ok(!['pullback', 'rotation'].includes(s.state) || s.of !== 'pullback', M.marketStateLine(s));
});

// The owner's must-pass pictures and the guard rows on real briefings.
test('real: a healthy pullback with small overlapping candles stays the trend class (2023-12-11 11:39, overlap 0.73, the q118 picture)', () => {
  const { s, cls, line, m3 } = stateAt('2023-12-11', '11:39');
  assert.ok(m3.layers.behavior.overlap >= AN.marketState.overlapHigh, 'overlapping candles');
  assert.deepStrictEqual([s.state, cls], ['pullback', 'trend-up'], line);
});

test('real: the guard never prints chop, aligned or not (2021-05-28 10:12, 4h range: an open long pullback, class unclear)', () => {
  const { s, cls, line } = stateAt('2021-05-28', '10:12');
  assert.strictEqual(s.align, null, 'not aligned');
  assert.deepStrictEqual([s.state, cls], ['pullback', 'unclear'], line);
});

test('real: a clean range reads range, not chop: edge to edge (2022-09-01 10:27)', () => {
  const { s, line, m3 } = stateAt('2022-09-01', '10:27');
  assert.strictEqual(s.state, 'range', line);
  assert.strictEqual(m3.layers.edges.interior, 0);
  assert.match(line, /range: no leg holds, HL [\d.]+ broken by a close \d+ min ago, the new leg unconfirmed, edges [\d.]+-[\d.]+ \(travel edge to edge\)/, 'the undisplaced protected break printed (review finding 2)');
});

// The owner's five-case test on real fixture days (cases chosen by the review's section-4 rules, tools/chop-read r20-build).
test('five cases (real): a fast countertrend drop warns before the protected break (2022-08-11: extreme 10:18, weakening 10:39, CHoCH then BOS down 11:03)', () => {
  assert.strictEqual(stateAt('2022-08-11', '10:36').s.state, 'leg');
  const w = stateAt('2022-08-11', '10:39');
  assert.deepStrictEqual([w.s.state, w.cls], ['weakening', 'unclear'], w.line);
  assert.match(w.line, /weakening up: HL [\d.]+ holds; displacement down this bar broke internal low [\d.]+;/);
  const f = stateAt('2022-08-11', '11:03').m3.layers.structure;
  assert.deepStrictEqual([f.side, f.flip.barsAgo, f.flip.byRule], ['down', 0, 'choch-bos'], 'the transition confirmed 8 bars after the warning');
});

test('five cases (real): a failed opening drive prints its fact before the structural break (2021-06-15: ODF 09:39, break 09:51); a successful one prints none (2021-06-24)', () => {
  const o = stateAt('2021-06-15', '09:39');
  assert.strictEqual(o.m3.layers.momentum.odf, true);
  assert.match(o.line, /potential failed opening drive/);
  assert.strictEqual(o.m3.layers.structure.status, 'intact', 'not yet broken: a fact, never an invalidation');
  for (let m = 33; m <= 51; m += 3) {
    const hm = `09:${String(m).padStart(2, '0')}`;
    const g = stateAt('2021-06-24', hm);
    assert.ok(!g.m3.layers.momentum.odf && g.s.state !== 'weakening', `${hm} ${g.line}`);
  }
});

test('five cases (real): a normal deep pullback flips nothing (2022-08-16, the down leg from 09:51 resolves without a flip)', () => {
  for (const hm of ['09:51', '09:54', '09:57', '10:00']) {
    const { m3, line } = stateAt('2022-08-16', hm);
    assert.ok(m3.layers.structure.side === 'down' && m3.layers.structure.status === 'intact', `${hm} ${line}`);
  }
});
