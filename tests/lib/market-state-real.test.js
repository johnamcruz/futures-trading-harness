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
const { assertGolden } = require('../golden');

const AN = analysis();
const TH = { crossesChop: AN.regime.rangeCrosses, maxPullbackDepth: AN.pullbackRead.maxStateDepth, lineBytes: AN.marketState.lineBytes }; // the briefing's
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
  const line = M.marketStateLine(s);
  assert.ok(Buffer.byteLength(line) <= TH.lineBytes, `${date} ${hm}: ${Buffer.byteLength(line)} bytes`);
  return { b, s, line, cls: M.classWordOf(s), m3: b.sections.m3.data };
};

// 2022-04-11, the morning of the failed protected break (swing-holds): 61 real 3m bars, 07:30-10:33 ET
// (tests/fixtures/market-state/2022-04-11-open.json, t o h l c v only; on this slice the structure snapshots equal the full
// history's on every close 09:33-10:33). The 4h + 1h lie outside the slice: stated as the recorded prompt's (down, down).
// No pullback read was open on those closes in the recorded prompts, so none is passed: the layers decide, as they did.
const { marketLayers } = require('../../scripts/lib/trading/market-layers');
const { qualityOf } = require('../../scripts/lib/trading/displacement');
const SE = require('../../scripts/lib/trading/structure-events');
const BARS_0411 = require('../fixtures/market-state/2022-04-11-open.json');
const etHm = t => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
const recordOf = bars => {
  const atr = ind.atr(bars);
  const lb = SE.lastBreaks(bars);
  const w = Object.fromEntries(Object.entries(lb).map(([k, x]) => [k, x ? { ...x, protected: SE.protectedOf(bars, x, { atr, equalAtr: AN.marketState.equalAtr }) } : x]));
  return qualityOf(bars, w, { minutes: 3, levels: [] });
};
const open0411 = () => {
  const open = BARS_0411.findIndex(b => b.t === '2022-04-11T13:30:00.000Z');
  const rows = [];
  for (let z = open; z < BARS_0411.length; z += 1) {
    const bars = BARS_0411.slice(0, z + 1);
    const closedAt = new Date(Date.parse(bars[z].t) + 180000).toISOString();
    const layers = marketLayers({ bars, minutes: 3, setupMinutes: 15, closedAt, pullback: null, p: AN.marketState, floor: AN.daySoFar.minBars, ibBars: AN.dayContext.ibMinutes / 3 });
    const b = { minutes: 3, closedAt, sections: { h1: { data: { h4: { trend: 'down' }, h1: { trend: 'down' } } }, m3: { data: { layers, price: bars[z].c, lastBreak: recordOf(bars) } } } };
    const s = M.readState(b, TH);
    rows.push({ hm: etHm(closedAt), P: layers.structure, s, cls: M.classWordOf(s), line: M.marketStateLine(s), record: b.sections.m3.data.lastBreak });
  }
  return rows;
};
const ROWS_0411 = open0411();

test('2022-04-11 (real): state parity: the machine\'s fields, the state and the class on every close 09:33-10:33, pinned (Build 1 changes no transition)', () => {
  const row = r => `${r.hm} ${[r.P.side, r.P.status, r.P.level, r.P.legOK, r.P.resumed, r.P.flip ? r.P.flip.held : '-', r.P.flipsIn].join(' ')} | ${r.s.state} ${r.cls}`;
  assertGolden('market-state-parity-0411.txt', `${ROWS_0411.map(row).join('\n')}\n`);
});

test('2022-04-11 (real): a close through LH 14178 at 09:48 and back within 3 bars: the machine hands the down leg back, and no line says 14178 holds (swing-holds)', () => {
  const at = hm => ROWS_0411.find(r => r.hm === hm);
  const b = at('09:48');
  assert.deepStrictEqual([b.P.side, b.P.status, b.P.flip.oldLevel], ['up', 'broken', 14178]);
  for (const r of ROWS_0411.filter(x => x.hm >= '09:54' && x.hm <= '10:18')) {
    assert.deepStrictEqual([r.P.status, r.P.level, r.P.levelBroken, r.P.flip.extreme], ['intact', 14178, true, 14197], r.hm);
    assert.doesNotMatch(r.line, /14178 holds/, `${r.hm} ${r.line}`);
    assert.match(r.line, /LH 14178 broken by a close \d+ min ago, closed back below, the break's high 14197/, r.hm);
  }
  const n = at('10:21');
  assert.deepStrictEqual([n.P.status, n.P.level, n.P.levelBroken], ['intact', 14181, false]);
  assert.match(n.line, /LH 14181 holds/);
  for (const r of ROWS_0411) if (r.P.levelBroken || r.P.status === 'broken') assert.doesNotMatch(r.line, new RegExp(`${r.P.level} holds`), `${r.hm} ${r.line}`);
});

test('2022-04-11 (real): the five lines of the design, exact', () => {
  const want = {
    '09:45': 'Market state (3m): in the down leg: LH 14178 holds; displacement up this bar; overlap 0.55, efficiency 0.01, 15m early; 4h+1h down; class trend-down',
    '09:48': 'Market state (3m): range: no leg holds, LH 14178 broken by a close this bar, new protected low 14099, edges 14099-14189.25 (travel edge to edge); overlap 0.56, efficiency 0.08, 15m early; 4h+1h down; class trend-down',
    '09:54': 'Market state (3m): weakening down: LH 14178 broken by a close 6 min ago, closed back below, the break\'s high 14197; displacement up 2 bars ago; behavior rotating (overlap 0.57, efficiency 0.01), 15m early; 4h+1h down; class unclear',
    '10:06': 'Market state (3m): in the down leg: LH 14178 broken by a close 18 min ago, closed back below, the break\'s high 14197; overlap 0.67, efficiency 0.01, 15m overlapping; 4h+1h down; class trend-down',
    '10:21': 'Market state (3m): trend down: LH 14181 holds, CHoCH down this bar; overlap 0.75, efficiency 0.16, 15m overlapping; 4h+1h down; class trend-down',
  };
  for (const [hm, line] of Object.entries(want)) assert.strictEqual(ROWS_0411.find(r => r.hm === hm).line, line, hm);
});

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
      const band = { atr: ind.atr(w), equalAtr: AN.marketState.equalAtr };
      const { side, level, at, brokenAt } = lb[k].protected;
      assert.deepStrictEqual({ side, level, at, brokenAt }, protectedOf(w, plain[k], band), `${date} ${hm} ${k}: last and previous both banded (swing-holds)`);
      const cut = w.filter(x => Date.parse(x.t) <= Date.parse(plain[k].at));
      assert.strictEqual(protectedOf(cut, plain[k], { atr: ind.atr(cut), equalAtr: AN.marketState.equalAtr }).level, lb[k].protected.level, 'causal: known at the break');
      const p = lb[k].protected;
      const span = w.filter(x => Date.parse(x.t) > Date.parse(plain[k].swingAt) && Date.parse(x.t) <= Date.parse(plain[k].at));
      assert.strictEqual(p.level, plain[k].direction === 'up' ? Math.min(...span.map(x => x.l)) : Math.max(...span.map(x => x.h)));
    }
  }
});

// swing-holds: the previous break's protected swing follows the tie too (one predicate for last and previous). 2022-08-11
// 11:33: the previous break, a BOS down, has its protected high 16756.75; this bar closes past it inside the tie (a tie:
// holds, brokenAt null), where the unbanded record said broken.
test('previous.protected (real): brokenAt follows the tie, as last.protected does (2022-08-11 11:33)', () => {
  const w = window('2022-08-11', '11:33');
  const b = B.buildBriefing({ symbol: 'NQ', bars: w, minutes: 3, now: new Date(Date.parse(w[w.length - 1].t) + 180000) });
  const prev = b.sections.m3.data.lastBreak.previous;
  assert.deepStrictEqual([prev.kind, prev.direction, prev.protected.level], ['BOS', 'down', 16756.75]);
  const atr = ind.atr(w);
  const z = w.length - 1;
  assert.ok(w[z].c > 16756.75 && w[z].c - 16756.75 <= AN.marketState.equalAtr * atr[z], `11:33 closes ${w[z].c}: past the level, inside the tie`);
  assert.ok(w.every((x, k) => Date.parse(x.t) <= Date.parse(prev.at) || k === z || x.c <= 16756.75), 'no other close past it since the break');
  assert.strictEqual(prev.protected.brokenAt, null, 'a tie holds');
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
  // The raw first close through the level (feat/displacement: the briefing's brokenAt follows the tie, null here, and the
  // Break quality line says `holds (tested, a tie)`, as this line says holds).
  const raw = closesThrough(t.w, t.last)[0].t;
  assert.deepStrictEqual([t.last.protected.brokenAt, t.last.protected.quality], [null, { tie: true }], 'brokenAt follows the tie');
  const close = t.w.find(x => x.t === raw).c;
  const atr = ind.atr(t.w);
  const k = t.w.findIndex(x => x.t === raw);
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
  assert.match(line, /range: no leg holds, HL [\d.]+ broken by a close \d+ min ago, closed back above, edges [\d.]+-[\d.]+ \(travel edge to edge\)/, 'the undisplaced protected break printed (review finding 2); the close back above it after followBars restores nothing (swing-holds: flip.inside)');
  assert.deepStrictEqual([m3.layers.structure.status, m3.layers.structure.flip.held, m3.layers.structure.flip.inside], ['broken', false, true]);
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

// Round 20c (the final review, findings 1, 2 and 4), pinned on real bars.
test('round 20c (real, item 1): the chop memory ends when the leg re-establishes and makes a fresh extreme its way (2021-10-04: chop 10:09-10:15, the BOS down 10:18 and its new lows end it)', () => {
  const c = stateAt('2021-10-04', '10:09');
  assert.deepStrictEqual([c.s.state, c.cls], ['chop', 'chop'], c.line);
  for (const hm of ['10:18', '10:21', '10:24', '10:27']) {
    const r = stateAt('2021-10-04', hm);
    assert.notStrictEqual(r.s.state, 'chop', `${hm} ${r.line}`);
    assert.strictEqual(r.cls, 'trend-down', `${hm} ${r.line}`);
    assert.ok(r.m3.layers.structure.legOK && r.m3.layers.chop.inChop === false, hm);
  }
});

test('round 20c (real, item 2): chop never prints "no leg holds" while the protected level holds; it names the leg\'s failed break and the level (2021-10-04 10:09)', () => {
  const c = stateAt('2021-10-04', '10:09');
  assert.match(c.line, /^Market state \(3m\): chop: the down leg's last break failed, LH 17965 holds \(a failed break\); /, c.line);
  assert.doesNotMatch(c.line, /no leg holds/);
});

test('round 20c (real, item 4): a CHoCH then BOS with the old protected level unbroken prints "transition confirmed", never "reversal confirmed" (2023-04-28 11:45)', () => {
  const r = stateAt('2023-04-28', '11:45');
  const P = r.m3.layers.structure;
  assert.deepStrictEqual([P.flip.byRule, P.flip.oldBroken], ['choch-bos', false], r.line);
  assert.match(r.line, /CHoCH then BOS: transition confirmed/, r.line);
  assert.doesNotMatch(r.line, /reversal confirmed/);
});

test('round 20c (real, item 6): the layers are computed on the chain\'s entry frame of the runner\'s briefing only: not on another lane, not on a lane\'s own briefing', () => {
  const w = window('2021-10-04', '10:09');
  const now = new Date(Date.parse(w[w.length - 1].t) + 180000);
  assert.ok(B.buildBriefing({ symbol: 'NQ', bars: w, minutes: 3, now }).sections.m3.data.layers, 'the 3m (entry) briefing: layers');
  assert.strictEqual(B.buildBriefing({ symbol: 'NQ', bars: w, minutes: 3, own: true, now }).sections.m3.data.layers, undefined, 'a lane\'s own briefing: none');
  const m15 = [];
  for (let i = w.length % 5; i + 5 <= w.length; i += 5) {
    const g = w.slice(i, i + 5);
    m15.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g[4].c, v: g.reduce((a, x) => a + x.v, 0) });
  }
  const b15 = B.buildBriefing({ symbol: 'NQ', bars: m15, minutes: 15, now: new Date(Date.parse(m15[m15.length - 1].t) + 900000) });
  assert.strictEqual(b15.sections.m3.data.layers, undefined, 'a 15m lane: none (the state prints on the entry frame)');
});
