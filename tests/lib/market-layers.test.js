'use strict';

// The Market state's layers at a bar (scripts/lib/trading/market-layers.js, round 20): the chop rule (structural AND
// behavioral evidence; the owner: a CHoCH pair is neither sufficient nor necessary), the RTH open on EST and EDT dates,
// the required thresholds, and the day scan's causality on real bars (the goal fixture): the chop memory at a bar, inside
// a longer run, equals the layers computed on the bars up to that bar.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ML = require('../../scripts/lib/trading/market-layers');
const GF = require('../../scripts/lib/eval/goal-fixture');
const { analysis } = require('../../scripts/lib/tunables');

const AN = analysis();
const P = AN.marketState;
const FLOOR = AN.daySoFar.minBars;
const IB = AN.dayContext.ibMinutes / 3;

const facts = { overlap: 0.8, eff: 0.1, disp: 0, bars: 10 };
const none = { overlap: 0.4, eff: 0.6, disp: 2, bars: 10 };
const noLeg = { side: 'up', status: 'intact', legOK: false, flip: null };
const brk = (direction, barsAgo, o = {}) => ({ direction, barsAgo, strong: false, failed: false, ...o });
const chop = (o = {}) => ML.chopAt({ snap: noLeg, breaks: [], beh: facts, edges: { atTop: 0, atBot: 0 }, rthBars: 20, sinceEnd: Infinity, ...o }, P, FLOOR);

test('chopAt (addendum 27 pin): a CHoCH pair with every behavioral fact false is not chop; a single failed break with the facts is', () => {
  const pair = [brk('down', 8), brk('up', 3)];
  assert.strictEqual(chop({ breaks: pair, beh: none }).now, false, 'the pair alone');
  assert.strictEqual(chop({ breaks: pair, beh: none }).S, true, 'structural evidence, no behavioral');
  const one = [brk('up', 6, { failed: true })];
  const c = chop({ breaks: one });
  assert.deepStrictEqual([c.now, c.S, c.B, c.evidence.failed, c.evidence.bothWays], [true, true, true, true, false], 'one failed break with overlap, low efficiency, no displacement');
});

test('chopAt: S needs no leg holding; B needs chopMinFacts facts, no clean displaced break and the floor of RTH bars', () => {
  const pair = [brk('down', 8), brk('up', 3)];
  assert.strictEqual(chop({ breaks: pair }).now, true);
  assert.strictEqual(chop({ breaks: pair, snap: { ...noLeg, legOK: true } }).now, false, 'a held leg: never chop (HH/HL continue)');
  assert.strictEqual(chop({ breaks: pair, snap: null }).now, false, 'no structure yet');
  assert.strictEqual(chop({ breaks: [brk('down', 8), brk('up', 0, { strong: true })] }).B, false, 'a clean displaced break vetoes');
  assert.strictEqual(chop({ breaks: [brk('down', 8), brk('up', 0, { strong: true, failed: true })] }).facts.nd, false, 'a displaced last break is displacement');
  assert.strictEqual(chop({ breaks: pair, rthBars: FLOOR - 1 }).B, false, 'under the floor: too early');
  assert.strictEqual(chop({ breaks: pair, rthBars: FLOOR }).B, true);
  assert.strictEqual(chop({ breaks: pair, beh: { ...facts, overlap: 0.5 } }).count, 2, 'overlap and the failed facts gone: efficiency and no displacement left');
  assert.strictEqual(chop({ breaks: pair, beh: { ...facts, overlap: 0.5 } }).B, false, 'two of four: no');
  assert.strictEqual(chop({ breaks: pair, beh: { ...facts, overlap: 0.5 }, edges: { atTop: 2, atBot: 0 } }).B, true, 'two rejections at one edge: failed continuation');
  assert.strictEqual(chop({ breaks: [brk('down', P.structBars), brk('up', P.structBars)] }).S, false, 'older than structBars');
  assert.strictEqual(chop({ breaks: pair, sinceEnd: 3 }).evidence.bothWays, false, 'breaks before the last end event do not count');
  assert.strictEqual(chop({ breaks: [brk('up', 5, { failed: true })], sinceEnd: 3 }).S, true, 'a failed break is dated at its failure (5 - followBars < 3)');
  assert.strictEqual(chop({ breaks: [brk('up', 6, { failed: true })], sinceEnd: 3 }).S, false, 'failed at the end event: older');
  const flip = { ...noLeg, status: 'broken', flip: { barsAgo: 2, disp: true, held: true } };
  assert.deepStrictEqual([chop({ breaks: pair, snap: flip }).trans, chop({ breaks: pair, snap: flip }).now], [true, false], 'a transition is no chop');
  assert.strictEqual(chop({ snap: { ...flip, flip: { barsAgo: 2, disp: false, held: true } } }).evidence.flip, true, 'an undisplaced protected break is structural evidence');
});

test('marketLayers: every threshold required; no bars or clock: null; before 09:30 ET: no RTH structure', () => {
  const bars = Array.from({ length: 40 }, (_, i) => ({ t: new Date(Date.UTC(2026, 0, 6, 12, 0) + i * 180000).toISOString(), o: 100, h: 101, l: 99, c: 100, v: 1 }));
  const args = { bars, minutes: 3, setupMinutes: 15, closedAt: new Date(Date.UTC(2026, 0, 6, 14, 0)).toISOString(), p: P, floor: FLOOR, ibBars: IB };
  for (const k of ML.KEYS) { const p = { ...P }; delete p[k]; assert.throws(() => ML.marketLayers({ ...args, p }), new RegExp(k)); }
  assert.throws(() => ML.marketLayers({ ...args, floor: undefined }), /floor/);
  assert.throws(() => ML.marketLayers({ ...args, setupMinutes: undefined }), /setupMinutes/);
  assert.strictEqual(ML.marketLayers({ ...args, closedAt: 'x' }), null);
  assert.deepStrictEqual(ML.marketLayers(args), { rthBars: 0, structure: null }, '09:00 ET');
});

test('rthFrom: the bar closing at 09:30 ET of the trading day, on an EST and an EDT date', () => {
  const day = (date, h) => Array.from({ length: 80 }, (_, i) => ({ t: new Date(Date.parse(`${date}T${h}:00:00.000Z`) + i * 180000).toISOString() }));
  const est = day('2026-01-06', '12'); // 07:00 EST
  assert.strictEqual(est[ML.rthFrom(est, 3, Date.parse('2026-01-06T15:00:00.000Z')).from].t, '2026-01-06T14:27:00.000Z', 'EST: 09:27 = 14:27Z');
  const edt = day('2026-07-07', '11'); // 07:00 EDT
  assert.strictEqual(edt[ML.rthFrom(edt, 3, Date.parse('2026-07-07T14:00:00.000Z')).from].t, '2026-07-07T13:27:00.000Z', 'EDT: 09:27 = 13:27Z');
  assert.strictEqual(ML.rthFrom(edt, 3, Date.parse('2026-07-07T13:00:00.000Z')), null, 'before the open');
});

test('crossings: the running midpoint of the phase after the extreme, crossed by the closes', () => {
  const b = (h, l, c) => ({ h, l, c });
  assert.strictEqual(ML.crossings([b(110, 100, 109), b(108, 104, 107), b(107, 100, 101), b(106, 101, 105), b(105, 101, 102)], 0), 3);
  assert.strictEqual(ML.crossings([b(110, 100, 109)], 0), 0);
});

// Real bars: the goal fixture's 2023-09-25 morning (the definition's must-pass failed opening rally).
const DOC = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'goal', 'bars.json.gz'))));
const barsOf = date => GF.decodeBars(DOC.blocks.find(x => x.sessions.includes(date)).bars);

test('the day scan is causal (real 2023-09-25): the chop memory at each bar inside the run equals the layers on the bars up to it', () => {
  const all = barsOf('2023-09-25');
  const open = all.findIndex(x => x.t === '2023-09-25T13:30:00.000Z'); // 09:30 EDT
  const win = j => all.slice(0, j + 1).filter(x => Date.parse(x.t) >= Date.parse(all[j].t) - DOC.historyHours * 3600000);
  const at = j => ({ bars: win(j), minutes: 3, setupMinutes: 15, closedAt: new Date(Date.parse(all[j].t) + 180000).toISOString(), p: P, floor: FLOOR, ibBars: IB });
  const end = open + 49;
  const long = ML.marketLayers({ ...at(end), trace: true });
  const byT = new Map(long.trace.map(r => [win(end)[r.k].t, r]));
  let chops = 0;
  for (let j = open; j <= end; j += 3) {
    const l = ML.marketLayers(at(j));
    const r = byT.get(all[j].t);
    assert.deepStrictEqual([r.inChop, r.now, r.ended], [l.chop.inChop, l.chop.now, l.chop.ended], all[j].t);
    if (l.chop.inChop) chops += 1;
  }
  assert.ok(long.trace.some(r => r.inChop), 'the morning has chop to check');
  assert.ok(chops > 0 || long.trace.filter(r => r.inChop).length > 0);
});
