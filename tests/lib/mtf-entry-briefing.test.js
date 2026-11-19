'use strict';

// P1 (feat/p1-mtf-entries): the MTF entry arm in the REAL runner briefing (briefing.js buildBriefing / renderBriefing)
// on the CI goal fixture's real 3m bars. Arm D (today, the default) is byte-identical to the briefing before P1 (the
// record and every line). An MTF arm's record carries its mode and the 1h-structure side; its lines add the mode's
// clauses and one candidate line per ready candidate, under the MTF lines; nothing else changes. Outside a replay an MTF
// arm prints one `unavailable` line (no record to enter on). Arm B's 1m execution record comes from the 1m data lane's
// bars (fineBars): none, or bars ending before the close, print its reason (fails closed).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const GF = require('../../scripts/lib/eval/goal-fixture');
const B = require('../../scripts/lib/trading/briefing');
const ME = require('../../scripts/lib/trading/mtf-entry');

const REPO = path.join(__dirname, '..', '..');
const DOC = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'goal', 'bars.json.gz'))));
const etHm = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const barsOf = day => GF.decodeBars(DOC.blocks.find(x => x.sessions.includes(day)).bars);
const REPLAY = { isReplay: () => true };
const LIVE = { isReplay: () => false };
const cfg = (arm, over = {}) => ({ arm, exitMode: 'trail', minStage: 'established', ...over });

/** The 3m bars of the 514 h window closing at `hm` ET, and 1m bars made from them (each 3m bar's o, h, l, c in thirds). */
function windowAt(day, hm) {
  const BARS = barsOf(day);
  const j = BARS.findIndex(x => x.t.startsWith(day) && etHm(Date.parse(x.t) + 180000) === hm);
  assert.ok(j > 0);
  const t = Date.parse(BARS[j].t);
  const w = BARS.filter((x, k) => k <= j && Date.parse(x.t) >= t - DOC.historyHours * 3600000);
  const fine = w.slice(-700).flatMap(b => {
    const s = Date.parse(b.t);
    const up = b.c >= b.o;
    const mid = up ? b.l : b.h;
    return [
      { t: new Date(s).toISOString(), o: b.o, h: Math.max(b.o, mid), l: Math.min(b.o, mid), c: mid, v: Math.round(b.v / 3) },
      { t: new Date(s + 60000).toISOString(), o: mid, h: up ? b.h : Math.max(mid, b.c), l: up ? Math.min(mid, b.c) : b.l, c: up ? b.h : b.l, v: Math.round(b.v / 3) },
      { t: new Date(s + 120000).toISOString(), o: up ? b.h : b.l, h: Math.max(up ? b.h : b.l, b.c), l: Math.min(up ? b.h : b.l, b.c), c: b.c, v: b.v - 2 * Math.round(b.v / 3) },
    ];
  });
  return { w, fine, now: new Date(t + 180000) };
}
const build = (x, o = {}) => B.buildBriefing({ symbol: 'NQ', bars: x.w, minutes: 3, now: x.now, ...o });
const IS_MTF = l => /^- MTF (structure|candidate|1m execution)/.test(l);
const X = windowAt('2022-08-16', '10:15');

test('arm D (today, the default): the briefing is byte-identical with the mode passed and without (the record and the text)', () => {
  const d0 = build(X);
  const d1 = build(X, { mtfMode: ME.modeOf(cfg('D'), {}, LIVE) });
  assert.deepEqual(d1, d0);
  assert.equal(B.renderBriefing(d1, { now: X.now }), B.renderBriefing(d0, { now: X.now }));
  assert.equal(d0.sections.m3.data.mtfStructure.mode, undefined);
  assert.equal(d0.sections.m3.data.mtfStructure.sideMode, 'rule');
});

test('arm A (replay): the record carries the mode and the 1h-structure side; the MTF lines carry the clauses and the candidate lines follow; every other line unchanged', () => {
  const d = build(X);
  const a = build(X, { mtfMode: ME.modeOf(cfg('A'), {}, REPLAY) });
  const rec = a.sections.m3.data.mtfStructure;
  assert.deepEqual(rec.mode, ME.recordMode(ME.modeOf(cfg('A'), {}, REPLAY)));
  assert.equal(rec.sideMode, 'parent');
  assert.equal(rec.side, rec.sides.parent);
  assert.ok(rec.sizing && rec.sizing.tick === 0.25 && rec.sizing.tickValue === 5, 'NQ: $5 a tick');
  const ta = B.renderBriefing(a, { now: X.now }).split('\n');
  const td = B.renderBriefing(d, { now: X.now }).split('\n');
  // Only the MTF lines differ, and today's setup lines, which an mtf_only arm prints as context (tests/lib/mtf-only-offers.test.js).
  const SETUPS = l => /^- (Setups to check|Standard plan|Rules setups|Setups)\b/.test(l);
  assert.deepEqual(ta.filter(l => !IS_MTF(l) && !SETUPS(l)), td.filter(l => !IS_MTF(l) && !SETUPS(l)), 'only the MTF lines (and the setups as context) differ');
  assert.ok(ta.filter(SETUPS).every(l => /Context only: MTF entry arm A enters only on an MTF candidate line\.$/.test(l) || /^- Setups: /.test(l)), ta.filter(SETUPS).join('\n'));
  const i = ta.findIndex(l => l.startsWith('- MTF structure '));
  assert.ok(i > 0);
  assert.match(ta[i + 2], /^- MTF (candidate|waiting)/, 'the candidate lines follow the two MTF lines');
  assert.match(ta[i], / Entry: on the MTF candidate lines\.$/);
  assert.match(ta[i + 1], /^- MTF structure below \(early read; 3m, noisy: the 15m line decides the pullback, the 3m only times it\): 15m > 3m/);
});

test('an MTF arm outside a replay: one unavailable line saying why (no record to enter on); arm B without 1m bars, or with 1m bars ending before the close: its reason', () => {
  const live = build(X, { mtfMode: ME.modeOf(cfg('A'), {}, LIVE) });
  assert.match(live.sections.m3.data.mtfStructure.unavailable, /arm A runs only in a replay until the owner opts in/);
  const lines = B.renderBriefing(live, { now: X.now }).split('\n').filter(IS_MTF);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^- MTF structure: unavailable \(MTF entry arm A runs only in a replay/);
  const mb = ME.modeOf(cfg('B'), {}, REPLAY);
  const noFine = build(X, { mtfMode: mb });
  assert.match(noFine.sections.m3.data.mtfStructure.execution.unavailable, /no 1m bars: arm B needs the runner's 1m data lane/);
  assert.ok(B.renderBriefing(noFine, { now: X.now }).split('\n').includes(`- MTF 1m execution: unavailable (${noFine.sections.m3.data.mtfStructure.execution.unavailable}).`));
  const stale = build(X, { mtfMode: mb, fineBars: X.fine.slice(0, -3) });
  assert.match(stale.sections.m3.data.mtfStructure.execution.unavailable, /the 1m bars end at .* before this bar's close/);
});

test('arm B with the 1m bars: the execution record (15m > 3m, 1m timing), its side the 1h structure\'s, `since` the previous close; arm AB carries both', () => {
  const mb = ME.modeOf(cfg('B', { minStage: 'potential' }), {}, REPLAY);
  const b = build(X, { mtfMode: mb, fineBars: X.fine });
  const rec = b.sections.m3.data.mtfStructure;
  assert.ok(rec.execution.record, JSON.stringify(rec.execution));
  const ex = rec.execution.record;
  assert.deepEqual(ex.levels.map(l => l.name), ['15m>3m', '3m>1m']);
  assert.equal(ex.sideMode, 'rule');
  assert.equal(ex.side, rec.sides.parent);
  assert.equal(rec.execution.since, new Date(X.now.getTime() - 180000).toISOString());
  assert.deepEqual(Object.keys(ex.mode).sort(), ['arm', 'entryMode', 'exitMode', 'hierarchies', 'minStage'], 'the record\'s mode: no first-pullback key (REVIEW-3 O1)');
  const ab = build(X, { mtfMode: ME.modeOf(cfg('AB', { minStage: 'potential' }), {}, REPLAY), fineBars: X.fine });
  assert.ok(ab.sections.m3.data.mtfStructure.execution.record);
  assert.ok(ab.sections.m3.data.mtfStructure.levels.length === 3);
});

test('a position open (the runner\'s held trade): an MTF arm\'s record carries it (its candidate lines then say "position open: not a pick"); arm D\'s briefing is byte-identical with it and without', () => {
  const d0 = build(X);
  const d1 = build(X, { positionOpen: true });
  assert.deepEqual(d1, d0);
  assert.equal(B.renderBriefing(d1, { now: X.now }), B.renderBriefing(d0, { now: X.now }));
  const mp = ME.modeOf(cfg('A', { minStage: 'potential' }), {}, REPLAY);
  const a = build(X, { mtfMode: mp, positionOpen: true });
  assert.equal(a.sections.m3.data.mtfStructure.positionOpen, true);
  assert.equal(build(X, { mtfMode: mp }).sections.m3.data.mtfStructure.positionOpen, undefined);
  const lines = B.renderBriefing(a, { now: X.now }).split('\n').filter(l => l.startsWith('- MTF candidate '));
  assert.ok(lines.every(l => !/\(chosen\)/.test(l)), 'no candidate is a pick while a position is open');
  for (const l of lines.filter(x => /^- MTF candidate (LONG|SHORT)/.test(x))) assert.match(l, /^- MTF candidate (LONG|SHORT) \(position open: not a pick\): /);
});
